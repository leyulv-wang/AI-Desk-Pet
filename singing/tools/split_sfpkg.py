# -*- coding: utf-8 -*-
"""
把 `.sf_pkg` 拆成 DDSP-SVC 官方能直接读的两个文件。

`.sf_pkg` 里其实已经把两样东西都打包好了：

    {
      "model_dict":  { "cascade": { "global_step": 2400, "model": <state_dict> } },
      "config_dict": { "cascade": <完整配置> },
      "model_type_index": 4
    }

而 DDSP-SVC 的 `load_model_vocoder(model_path)` 只做两件事：
    ① 读**同目录**下的 `config.yaml`
    ② `torch.load(model_path)['model']` 当作 state_dict

所以拆开就完了 —— 不需要重新训练，也不需要改任何权重。

产物：
    <outdir>/model.pt      给 load_model_vocoder 读
    <outdir>/config.yaml   同目录配置

用法：
    python split_sfpkg.py --sfpkg "D:\\下载\\...\\芙宁娜 - 副本.sf_pkg" --outdir "D:\\models\\DDSP-SVC\\voices\\芙宁娜"
"""
import argparse
import os
import shutil
import sys
import zipfile

import torch
import yaml


def repack(sfpkg_dir, workdir):
    """
    把解压开的 .sf_pkg 重新封成 torch 能读的 zip。

    torch 的 save 格式是 zip，内部固定用 `archive/` 前缀。`.sf_pkg` 已经被解开成
    普通文件夹了，torch.load 不认文件夹，所以得按原样封回去。
    """
    dst = os.path.join(workdir, "_repacked.pt")
    n = 0
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:
        for root, _dirs, files in os.walk(sfpkg_dir):
            for f in files:
                full = os.path.join(root, f)
                rel = os.path.relpath(full, sfpkg_dir).replace("\\", "/")
                # 固定时间戳：里面有文件的 mtime 早于 1980，zipfile 会直接报错
                zi = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
                zi.compress_type = zipfile.ZIP_STORED
                with open(full, "rb") as fh:
                    z.writestr(zi, fh.read())
                n += 1
    print(f"  重新打包 {n} 个条目 → {dst}")
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sfpkg", required=True, help=".sf_pkg 目录（里面应该有 archive/）")
    ap.add_argument("--outdir", required=True, help="产物目录（DDSP-SVC 的 voices/<名字>/）")
    ap.add_argument("--stage", default="cascade", help="多阶段模型的阶段名，默认 cascade")
    ap.add_argument("--workdir", default=None)
    args = ap.parse_args()

    sfpkg = os.path.abspath(args.sfpkg)
    outdir = os.path.abspath(args.outdir)
    work = args.workdir or os.path.join(outdir, ".work")

    # .sf_pkg 可能直接是 archive，也可能里面还有一层
    src = sfpkg
    if not os.path.exists(os.path.join(src, "archive", "data.pkl")):
        if os.path.exists(os.path.join(src, "data.pkl")):
            src = os.path.dirname(src)  # 传进来的就是 archive 本身
        else:
            cand = os.path.join(sfpkg, "archive")
            if os.path.exists(os.path.join(cand, "data.pkl")):
                src = sfpkg
            else:
                raise SystemExit(f"看不懂的 .sf_pkg 结构：{sfpkg}（找不到 archive/data.pkl）")

    os.makedirs(work, exist_ok=True)
    os.makedirs(outdir, exist_ok=True)

    print(f"源    {src}")
    print(f"产物  {outdir}")
    print("① 重新打包…")
    pt = repack(src, work)

    print("② 读取…")
    ck = torch.load(pt, map_location="cpu", weights_only=False)
    stages = list(ck["model_dict"].keys())
    print(f"   stages = {stages}   model_type_index = {ck.get('model_type_index')}")
    if args.stage not in ck["model_dict"]:
        raise SystemExit(f"没有阶段 '{args.stage}'，可选：{stages}")

    blob = ck["model_dict"][args.stage]
    cfg = ck["config_dict"][args.stage]

    # ---- model.pt：DDSP-SVC 只认 {'global_step', 'model'} ----
    model_pt = os.path.join(outdir, "model.pt")
    torch.save({"global_step": blob.get("global_step", 0), "model": blob["model"]}, model_pt)
    print(f"③ 写 {model_pt}（{os.path.getsize(model_pt) / 1e6:.0f} MB，"
          f"{len(blob['model'])} 个张量，global_step={blob.get('global_step')}）")

    # ---- config.yaml：DDSP-SVC 会 yaml.safe_load 它 ----
    cfg_path = os.path.join(outdir, "config.yaml")
    with open(cfg_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(_plain(cfg), f, allow_unicode=True, sort_keys=False)
    print(f"④ 写 {cfg_path}")

    # ---- 顺手报告：这个配置会让 DDSP-SVC 去哪些路径找依赖 ----
    print("\n⑤ 这个配置引用的依赖权重（DDSP-SVC 会按这些相对路径去找）：")
    print(f"   data.encoder      = {cfg['data'].get('encoder')}")
    print(f"   data.encoder_ckpt = {cfg['data'].get('encoder_ckpt')}")
    print(f"   data.f0_extractor = {cfg['data'].get('f0_extractor')}")
    print(f"   vocoder.type      = {cfg['vocoder'].get('type')}")
    print(f"   vocoder.ckpt      = {cfg['vocoder'].get('ckpt')}")
    print(f"   model.n_spk       = {cfg['model'].get('n_spk')}")
    print(f"   spks              = {cfg.get('spks')}")

    shutil.rmtree(work, ignore_errors=True)
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    print("\n✅ 完成。DDSP-SVC 用 load_model_vocoder('" + model_pt.replace("\\", "/") + "') 就能直接加载。")


def _plain(o):
    """把点号访问的 DotDict / OrderedDict 变成普通 dict/list，yaml 才能 dump"""
    if isinstance(o, dict):
        return {k: _plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_plain(v) for v in o]
    if hasattr(o, "item") and not isinstance(o, (str, bytes)):
        try:
            return o.item()
        except Exception:
            return o
    return o


if __name__ == "__main__":
    main()
