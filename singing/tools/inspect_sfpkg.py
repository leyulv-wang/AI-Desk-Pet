# -*- coding: utf-8 -*-
"""
把一个解压开的 `.sf_pkg/archive` 重新打包成 torch 能读的 .pt，并打印它的结构。

为什么需要这个：torch 的 save 格式是一个 zip，内部固定用 `archive/` 作前缀
（`archive/data.pkl`、`archive/data/0`…）。而这个 `.sf_pkg` 已经被解压成
一个普通文件夹了，torch.load 不认文件夹 —— 得先按原样重新封回去。

用法：python inspect_sfpkg.py <sf_pkg目录> [输出的.pt路径]
"""
import os
import sys
import zipfile

if len(sys.argv) < 2:
    print(__doc__)
    print("缺少参数：请给出 .sf_pkg 目录（例：\"<语音包目录>\\芙宁娜 - 副本.sf_pkg\"）")
    sys.exit(2)

src = sys.argv[1]
# 默认输出放在本脚本所在目录，不用绝对路径 —— 换机器/换目录都能跑
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "_sfpkg_repacked.pt")

if not os.path.isdir(src):
    print(f"不是目录：{src}")
    sys.exit(1)

# ---------- 1) 重新打包 ----------
print(f"重新打包：{src}")
print(f"     → {dst}")
n = 0
with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src).replace("\\", "/")
            # 固定时间戳：这个 archive 里有些文件的 mtime 早于 1980，
            # zipfile 会直接报 "ZIP does not support timestamps before 1980"。
            # 时间戳对 torch.load 毫无意义，写死一个就行。
            zi = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_STORED
            with open(full, "rb") as fh:
                z.writestr(zi, fh.read())
            n += 1
print(f"     写入 {n} 个条目，{os.path.getsize(dst) / 1e6:.0f} MB")

# ---------- 2) 读它 ----------
print("\n" + "=" * 60)
import torch

for weights_only in (False, True):
    try:
        ck = torch.load(dst, map_location="cpu", weights_only=weights_only)
        print(f"torch.load(weights_only={weights_only}) ✅")
        print(f"  顶层类型: {type(ck).__name__}")
        if isinstance(ck, dict):
            for k, v in ck.items():
                if hasattr(v, "keys"):
                    print(f"  {k}: dict（{len(v)} 个键）")
                elif isinstance(v, list):
                    print(f"  {k}: list（{len(v)} 项）")
                else:
                    print(f"  {k}: {type(v).__name__} = {str(v)[:100]}")
        break
    except Exception as e:
        print(f"torch.load(weights_only={weights_only}) ❌ {type(e).__name__}: {str(e)[:200]}")

# ---------- 3) 挖出结构信息 ----------
print("\n" + "=" * 60)
print("权重键名（前 60 个）：")
state = None
if isinstance(ck, dict):
    for key in ("model", "state_dict", "model_dict", "weight"):
        if key in ck and hasattr(ck[key], "keys"):
            state = ck[key]
            print(f"  （用的是 ck['{key}']）")
            break
if state is None and isinstance(ck, dict):
    state = ck
if state is not None:
    keys = list(state.keys())
    for k in keys[:60]:
        v = state[k]
        shape = tuple(v.shape) if hasattr(v, "shape") else ""
        print(f"    {k}  {shape}")
    print(f"  … 共 {len(keys)} 个参数")

    # 有多少参数、什么 dtype，能反推模型规模
    tot = sum(v.numel() for v in state.values() if hasattr(v, "numel"))
    print(f"\n总参数量: {tot / 1e6:.1f} M")
    dts = {}
    for v in state.values():
        if hasattr(v, "dtype"):
            dts[str(v.dtype)] = dts.get(str(v.dtype), 0) + 1
    print(f"dtype 分布: {dts}")

# ---------- 4) 非权重的元信息（config 之类）----------
print("\n" + "=" * 60)
print("非张量字段（可能是配置/元信息）：")
def walk(obj, prefix="", depth=0):
    if depth > 3:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, torch.Tensor):
                continue
            if isinstance(v, (dict, list, tuple)):
                if isinstance(v, list) and v and not isinstance(v[0], (dict, list)):
                    print(f"  {prefix}{k} = {v}")
                else:
                    print(f"  {prefix}{k}: {type(v).__name__}")
                    walk(v, prefix + k + ".", depth + 1)
            else:
                print(f"  {prefix}{k} = {v!r}")
walk(ck if isinstance(ck, dict) else {})
