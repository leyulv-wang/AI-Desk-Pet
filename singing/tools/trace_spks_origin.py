# -*- coding: utf-8 -*-
"""
追溯：config 里的 `spks: ['芙宁娜']` 到底来自哪个文件的哪个键。

结论先写在这儿 —— 它**不在 DDSP-SVC 的代码或模板里**（官方 configs/reflow.yaml 没有
这个键，官方 .py 代码里也一次都没出现过），而是**打包 .sf_pkg 的那个工具**写进
内嵌配置的。这个脚本负责把证据打出来。

用法：
    python tools/trace_spks_origin.py <sf_pkg目录> [拆出来的config.yaml]

    sf_pkg 目录例："<语音包目录>\\芙宁娜 - 副本.sf_pkg"
"""
import os
import shutil
import sys
import tempfile
import zipfile

import torch

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(2)

SFPKG = sys.argv[1]
REPO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "repos", "DDSP-SVC")
# 第二个参数可选：拆出来的 config.yaml（默认按 README 的约定放 D:\models 下）
MADE = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    "D:\\models\\DDSP-SVC", "voices", "芙宁娜", "config.yaml")


def repack(src, dst):
    """把解压开的 .sf_pkg 封回 torch 能读的 zip（时间戳要固定，见 split_sfpkg.py）"""
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:
        for root, _d, files in os.walk(src):
            for f in files:
                full = os.path.join(root, f)
                rel = os.path.relpath(full, src).replace("\\", "/")
                zi = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
                zi.compress_type = zipfile.ZIP_STORED
                z.writestr(zi, open(full, "rb").read())


def main():
    print("=" * 70)
    print("【1】原始来源：.sf_pkg 内嵌的 data.pkl")
    print("=" * 70)
    print(f"  {SFPKG}\\archive\\data.pkl  ({os.path.getsize(os.path.join(SFPKG, 'archive', 'data.pkl'))} B)")

    tmp = tempfile.mkdtemp()
    pt = os.path.join(tmp, "r.pt")
    repack(SFPKG, pt)
    ck = torch.load(pt, map_location="cpu", weights_only=False)

    print()
    print("  顶层键           :", list(ck.keys()))
    print("  config_dict 的键 :", list(ck["config_dict"].keys()))
    print()
    print("  >>> config_dict['cascade']['spks'] =", ck["config_dict"]["cascade"]["spks"])
    print("  >>> 类型 =", type(ck["config_dict"]["cascade"]["spks"]).__name__)
    print()
    print("  cascade 配置里的全部键（注意 n_spk 和 spks 并存）：")
    for k, v in ck["config_dict"]["cascade"].items():
        if isinstance(v, dict):
            print(f"     {k:18s} <dict, {len(v)} 项>")
        else:
            print(f"     {k:18s} = {v}")
    print()
    print("  同一份配置里相关的一项：")
    print(f"     model.n_spk = {ck['config_dict']['cascade']['model']['n_spk']}")
    print(f"     spks        = {ck['config_dict']['cascade']['spks']}")
    print(f"     → n_spk({ck['config_dict']['cascade']['model']['n_spk']}) "
          f"≠ len(spks)({len(ck['config_dict']['cascade']['spks'])})，这是矛盾的")
    shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("=" * 70)
    print("【2】我把它写到了哪里")
    print("=" * 70)
    if os.path.exists(MADE):
        with open(MADE, encoding="utf-8") as f:
            lines = f.readlines()
        for i, ln in enumerate(lines, 1):
            if "spks" in ln or "n_spk" in ln:
                print(f"  {MADE}:{i}: {ln.rstrip()}")
        print("  ← 这两行是 tools/split_sfpkg.py 从上面那份 data.pkl 抄过来的")

    print()
    print("=" * 70)
    print("【3】DDSP-SVC 官方代码/模板里有没有 spks")
    print("=" * 70)
    hits = []
    for root, _d, files in os.walk(REPO):
        if ".git" in root:
            continue
        for fn in files:
            if not fn.endswith((".py", ".yaml")):
                continue
            p = os.path.join(root, fn)
            try:
                for i, ln in enumerate(open(p, encoding="utf-8", errors="replace"), 1):
                    if "spks" in ln:
                        hits.append((os.path.relpath(p, REPO), i, ln.strip()))
            except Exception:
                pass
    if hits:
        for f, i, ln in hits:
            print(f"  {f}:{i}: {ln}")
    else:
        print("  0 次 —— 官方代码和 configs/reflow.yaml 里从来没有 spks 这个字段")

    print()
    print("=" * 70)
    print("【4】官方模板 configs/reflow.yaml 的顶层键（对比用）")
    print("=" * 70)
    import yaml

    with open(os.path.join(REPO, "configs", "reflow.yaml"), encoding="utf-8") as f:
        tpl = yaml.safe_load(f)
    print("  官方模板顶层键 :", sorted(tpl.keys()))
    print("  我们的配置文件 :", sorted(ck["config_dict"]["cascade"].keys()))
    extra = sorted(set(ck["config_dict"]["cascade"].keys()) - set(tpl.keys()))
    print(f"  → 多出来的键   : {extra}   ← 这两个不是 DDSP-SVC 的东西")
    print()
    print("  另外注意键的顺序：我们的配置文件是字母序")
    print("  （data→device→env→infer→model→model_type_index→spks→train→vocoder），")
    print("  说明打包工具用 sort_keys 重新序列化过。")


if __name__ == "__main__":
    main()
