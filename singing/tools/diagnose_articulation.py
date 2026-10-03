# -*- coding: utf-8 -*-
"""
诊断「咬字不清」：辅音（特别是清辅音 s/sh/t/k）到底是在哪一步丢的。

咬字的感知主要靠**辅音的瞬态**，而辅音的能量集中在高频：
    s / sh / z   → 5~10 kHz 的窄带噪声（齿音）
    t / k / p    → 极短的宽带爆破
    f            → 2~8 kHz 的弱摩擦

DDSP-SVC 管线里有三个地方可能把它们弄丢：

  ① **静音门限 mask**（ddsp_cover.py 的 --threshold）
     最后输出会乘上一个由源音量算出的 mask：
         mask = (volume > 10 ** (threshold/20))
         output = output * mask
     门限设得高（默认 -45 dB）时，**偏轻的辅音会被整段乘成 0**。

  ② **人声分离**（demucs）
     齿音是高频+瞬态，分离器最容易把它当成"伴奏里的镲片"而剥走。

  ③ **模型本身**
     辅音走 noise 支路，噪声滤波器预测不准就会糊。

用法：
    python tools/diagnose_articulation.py --source 源人声.wav --converted 转换后.wav
"""
import argparse
import os
import warnings

import numpy as np

warnings.filterwarnings("ignore")

BANDS = {
    "低(基频)": (80, 1000),
    "中(共振峰)": (1000, 3000),
    "齿音s/sh": (5000, 10000),
    "极高频": (10000, 16000),
}
THRESHOLDS = (35, 45, 55, 65, 75)


def measure(path, sr=44100):
    import librosa
    y, _ = librosa.load(os.path.abspath(path), sr=sr, mono=True)
    if len(y) == 0:
        return None

    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    pw = S ** 2
    total = max(pw.sum(), 1e-12)

    out = {"path": path, "dur": len(y) / sr, "rms": float(np.sqrt((y ** 2).mean()))}
    for name, (lo, hi) in BANDS.items():
        m = (freqs >= lo) & (freqs < hi)
        out[name] = float(pw[m].sum() / total)

    # 音量包络（和 DDSP 的 Volume_Extractor 同思路）
    frames = librosa.util.frame(y, frame_length=1024, hop_length=512)
    vol_db = 20 * np.log10(np.sqrt((frames ** 2).mean(0) + 1e-12) + 1e-9)
    out["vol_median_db"] = float(np.median(vol_db))
    out["mask"] = {t: float((vol_db <= -t).mean()) for t in THRESHOLDS}

    # 齿音带的帧间波动：辅音是瞬态，会表现为高频能量的快速起伏
    hi_m = (freqs >= 5000) & (freqs < 10000)
    hf_db = 10 * np.log10(pw[hi_m].sum(0) + 1e-12)
    out["sib_flux"] = float(np.mean(np.abs(np.diff(hf_db))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--converted", required=True)
    ap.add_argument("--orig", default=None, help="原始混音，用来看分离损失了多少")
    args = ap.parse_args()

    rows = [("源人声", measure(args.source)), ("转换后", measure(args.converted))]
    if args.orig:
        rows.append(("原始混音", measure(args.orig)))

    print("=" * 76)
    print(f"{'':<10}{'时长s':>7}{'RMS':>8}", end="")
    for b in BANDS:
        print(f"{b:>13}", end="")
    print(f"{'齿音波动':>10}")
    print("-" * 76)
    for lab, r in rows:
        if not r:
            continue
        print(f"{lab:<10}{r['dur']:>7.1f}{r['rms']:>8.4f}", end="")
        for b in BANDS:
            print(f"{r[b]:>13.4f}", end="")
        print(f"{r['sib_flux']:>10.2f}")

    print()
    print("静音门限会切掉多少帧（DDSP 输出会乘以这个 mask）：")
    print(f"{'':<10}" + "".join(f"{-t:>9}dB" for t in THRESHOLDS))
    for lab, r in rows:
        if not r:
            continue
        print(f"{lab:<10}" + "".join(f"{r['mask'][t]*100:>10.1f}%" for t in THRESHOLDS))

    print("""
怎么读：
  ① 『齿音s/sh』那一列，从 源人声 → 转换后 掉了多少？
       掉得多      → 转换把辅音弄丢了（可调门限/换参数）
       源本来就少  → 分离阶段就没了，得换分离器
  ② 门限表里 **-45dB 那列**就是默认会静音掉的比例。
       比例偏高（>15%）说明偏轻的辅音正在被切掉，可以试 -55 / -65。
  ③ 齿音波动越高 = 高频起伏越丰富 = 咬字越清楚。""")


if __name__ == "__main__":
    main()
