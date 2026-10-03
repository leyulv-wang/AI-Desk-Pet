# -*- coding: utf-8 -*-
"""
频谱配比对比：转换后的长期平均频谱（LTAS）到底跟谁像 —— 原唱，还是目标音色？

为什么需要这个：
    差异图显示转换把能量从 1~3 kHz 搬到了 4~5 kHz。这可能是
      (a) 芙宁娜音色本身的特征  → 正常，不用动
      (b) 声码器/模型的伪影      → 该用 EQ 修掉
    区分办法就是**同时看三条曲线**：
        原唱人声 LTAS  /  转换后 LTAS  /  芙宁娜参考音频 LTAS
    如果转换后明显超出了参考音频的范围，那就是伪影。

注意：参考音频是**游戏对白**，转换对象是**歌声**。两者 LTAS 天然有差异
（歌唱的持续元音和高频泛音更多），所以只做**相对**判断，不做绝对匹配。

用法：
    python tools/ltas.py --source 原唱.wav --converted 转换.wav --ref-dir <参考目录>
"""
import argparse
import glob
import os
import warnings

import numpy as np

warnings.filterwarnings("ignore")

SING = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJ = os.path.dirname(SING)
DEFAULT_REF = os.path.join(PROJ, "assets", "voice", "clips")

# 1/3 倍频程中心频率（人声关心的范围）
BANDS = [125, 250, 500, 1000, 2000, 3000, 4000, 5000, 6300, 8000]


def ltas(path, sr=44100, offset=0.0, seconds=0.0):
    import librosa
    y, sr = librosa.load(os.path.abspath(path), sr=sr, mono=True)
    if offset or seconds:
        a = int(offset * sr)
        b = a + int(seconds * sr) if seconds else len(y)
        y = y[a:b]

    # 只统计有声帧，避免静音把曲线拉平
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    # S 的形状是 (频率, 时间)。要按**帧**判有无声，所以沿频率轴 sum(0)，得到每条时间帧的能量。
    energy = (S ** 2).sum(0)          # shape = (时间帧数,)
    voiced = energy > energy.max() * 1e-5
    if voiced.sum() > 4:
        S = S[:, voiced]
    spec = (S ** 2).mean(1)
    return freqs, spec


def band_db(freqs, spec, bands=BANDS):
    out = {}
    prev = 0
    for c in bands:
        lo = prev if prev else c * 0.7
        hi = c * 1.4
        m = (freqs >= lo) & (freqs < hi)
        if m.sum():
            out[c] = 10 * np.log10(max(spec[m].mean(), 1e-12))
        prev = c
    # 归一化到 1kHz（只比较配比，不比较绝对响度）
    ref = out.get(1000, 0.0)
    return {k: v - ref for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--converted", required=True)
    ap.add_argument("--ref-dir", default=DEFAULT_REF)
    ap.add_argument("--offset-src", type=float, default=45)
    ap.add_argument("--offset-conv", type=float, default=0)
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--ref-max", type=int, default=25, help="最多用多少条参考音频")
    args = ap.parse_args()

    fs, ss = ltas(args.source, offset=args.offset_src, seconds=args.seconds)
    fc, sc = ltas(args.converted, offset=args.offset_conv, seconds=args.seconds)
    src = band_db(fs, ss)
    conv = band_db(fc, sc)

    # 参考音频：逐条算再取中位数（避免被某一条拉偏）
    ref_files = sorted(glob.glob(os.path.join(args.ref_dir, "*.wav")))[:args.ref_max]
    per_band = {c: [] for c in BANDS}
    for f in ref_files:
        try:
            fq, sp = ltas(f)
            bd = band_db(fq, sp)
            for c, v in bd.items():
                per_band[c].append(v)
        except Exception:
            pass
    ref = {c: float(np.median(v)) if v else None for c, v in per_band.items()}

    print(f"参考音频 {len([v for v in per_band[BANDS[0]]])} 条")
    print()
    print(f"{'Hz':>7}{'原唱':>10}{'参考(芙宁娜)':>14}{'转换后':>10}"
          f"{'转换-原唱':>11}{'转换-参考':>11}   判读")
    print("-" * 78)
    for c in BANDS:
        s, r, v = src.get(c), ref.get(c), conv.get(c)
        if s is None or v is None:
            continue
        d_src = v - s
        d_ref = (v - r) if r is not None else None
        # 判读：转换后相对参考是否偏高
        if d_ref is None:
            tag = ""
        elif d_ref > 4:
            tag = "★ 高出参考 4dB 以上"
        elif d_ref > 2:
            tag = "略高于参考"
        elif d_ref < -4:
            tag = "低于参考"
        else:
            tag = "接近参考"
        print(f"{c:>7}{s:>10.1f}{(r if r is not None else float('nan')):>14.1f}"
              f"{v:>10.1f}{d_src:>11.1f}{d_ref if d_ref is not None else float('nan'):>11.1f}   {tag}")

    print()
    print("读法：三条曲线都归一化到各自的 1kHz 处，比较的是**频谱配比**而不是响度。")
    print("      『转换-参考』那一列如果明显为正，说明转换后比芙宁娜本人多出这段能量 → 是伪影。")
    print("      注意参考音频是游戏对白、转换对象是歌声，两者天然有差异，只看**大偏差**。")


if __name__ == "__main__":
    main()
