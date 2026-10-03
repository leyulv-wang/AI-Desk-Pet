# -*- coding: utf-8 -*-
"""
第二层解剖：`.sf_pkg` 解出来的权重到底长什么样，和 DDSP-SVC 官方格式能不能对上。

第一层已经查明它是 DDSP-SVC 6.x 的 RectifiedFlow 模型（44.1k / contentvec768l12tta2x
/ rmvpe / nsf-hifigan），说话人写的是「芙宁娜」。现在要看的是**权重键名**，
因为这才是判断「能不能直接喂给 DDSP-SVC 官方推理代码」的依据 ——
配置对不对得上，键名对不对得上，是两件事。

用法：python probe_sfpkg_weights.py <repacked.pt>
"""
import sys

import torch

p = sys.argv[1] if len(sys.argv) > 1 else r"D:\project\Personal_assistant\desktop-pet\singing\_sfpkg_repacked.pt"
ck = torch.load(p, map_location="cpu", weights_only=False)

print(f"顶层键: {list(ck.keys())}")
print(f"model_type_index = {ck.get('model_type_index')}")
print()

# 一路下钻找到真正的 state_dict
md = ck["model_dict"]
print(f"model_dict 键: {list(md.keys())}")
for stage, blob in md.items():
    print(f"\n=== stage '{stage}' ===")
    print(f"  这个 stage 的键: {list(blob.keys())}")
    print(f"  global_step = {blob.get('global_step')}")
    sd = blob.get("model")
    if not isinstance(sd, dict):
        print("  model 不是 dict，跳过")
        continue

    keys = list(sd.keys())
    print(f"  权重张量数 = {len(keys)}")
    tot = sum(v.numel() for v in sd.values() if hasattr(v, "numel"))
    print(f"  总参数量 = {tot / 1e6:.2f} M")

    # 按模块前缀归类，看清网络结构
    from collections import Counter

    pref = Counter()
    for k in keys:
        parts = k.split(".")
        pref[".".join(parts[:2])] += 1
    print("  模块分布（前 25 个前缀）：")
    for k, v in pref.most_common(25):
        print(f"    {k:45s} {v}")

    print("\n  前 25 个键名 + 形状:")
    for k in keys[:25]:
        v = sd[k]
        print(f"    {k:55s} {tuple(v.shape) if hasattr(v,'shape') else ''}  {v.dtype if hasattr(v,'dtype') else ''}")

    # 判断关键结构：DDSP-SVC 的 RectifiedFlow 一定有这些
    probe = {
        "unit2ctrl（编码器输出→控制参数）": any("unit2ctrl" in k for k in keys),
        "velocity_fn / 速度场（RectifiedFlow 特有）": any("velocity" in k.lower() or "vf" in k for k in keys),
        "decoder（DDSP 谐波+噪声合成）": any("decoder" in k for k in keys),
        "aux_decoder（辅助解码器）": any("aux" in k for k in keys),
        "spk_embed（说话人嵌入，n_spk=97）": any("spk_embed" in k for k in keys),
    }
    print("\n  结构探针:")
    for k, v in probe.items():
        print(f"    {'✓' if v else '✗'} {k}")
    if "spk_embed" in " ".join(keys):
        for k in keys:
            if "spk_embed" in k:
                print(f"      {k} → {tuple(sd[k].shape)}")
                break

# config 也再确认一遍关键项
print("\n" + "=" * 60)
print("config 关键项：")
cfg = ck["config_dict"]
for stage, c in cfg.items():
    for section in ("data", "model", "vocoder", "infer"):
        for k, v in (c.get(section) or {}).items():
            if k in ("encoder", "encoder_ckpt", "f0_extractor", "sampling_rate", "block_size",
                     "win_length", "type", "n_chans", "n_layers", "n_spk", "use_pitch_aug",
                     "use_norm", "use_attention", "ckpt", "infer_step", "method", "t_start"):
                print(f"  {stage}.{section}.{k} = {v}")
