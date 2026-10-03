# -*- coding: utf-8 -*-
"""
把「原唱人声」和「转换后」的声谱图并排画出来，用来肉眼判断杂音的性质。

为什么要看图：HNR / 高频占比这类**幅度**指标抓不到"电音感"。
电音感往往来自**相位**和**谐波结构**：
  · 谐波之间有大量噪声（分离残留）→ 谐波间隙发白
  · 梳状/周期性条纹 → 声码器的 phase 伪影
  · 谐波被抹平、只剩基频和几个强谐波 → 声音发"金属"
  · 帧边界处的横向条纹 → 分块拼接痕迹
这些在声谱图上比在数字上更容易看出来。

输出 PNG，自己看图判断。用法：
    python tools/spectrogram.py --a 原唱.wav --b 转换后.wav --offset 45 --seconds 6 --out cmp.png
"""
import argparse
import os
import sys

import numpy as np

SING = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True, help="参考（原唱人声）")
    ap.add_argument("--b", required=True, help="被比较的（转换后）")
    ap.add_argument("--label-a", default="SOURCE (original vocal)")
    ap.add_argument("--label-b", default="CONVERTED")
    ap.add_argument("--offset", type=float, default=45)
    ap.add_argument("--seconds", type=float, default=6)
    ap.add_argument("--offset-a", type=float, default=None,
                    help="A 的起点。默认跟随 --offset")
    ap.add_argument("--offset-b", type=float, default=None,
                    help="B 的起点。**转换后的文件通常本身就是截好的片段，要传 0** —— "
                         "否则会像第一次那样取到文件外面，画出一张全白的空图")
    ap.add_argument("--sr", type=int, default=44100)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    off_a = args.offset if args.offset_a is None else args.offset_a
    off_b = args.offset if args.offset_b is None else args.offset_b

    import librosa
    import librosa.display
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    def cut(p, off):
        y, sr = librosa.load(os.path.abspath(p), sr=args.sr, mono=True)
        a = int(off * sr)
        b = a + int(args.seconds * sr)
        seg = y[a:b]
        if len(seg) < sr * 0.1:
            raise SystemExit(
                f"取到的片段太短（{len(seg)} 样本）：{p}\n"
                f"  offset={off}s 但文件只有 {len(y) / sr:.2f}s —— 检查 --offset-a/--offset-b")
        return seg, sr

    ya, sr = cut(args.a, off_a)
    yb, _ = cut(args.b, off_b)
    n = min(len(ya), len(yb))
    ya, yb = ya[:n], yb[:n]

    hop = 512
    Sa = librosa.amplitude_to_db(np.abs(librosa.stft(ya, n_fft=2048, hop_length=hop)), ref=np.max)
    Sb = librosa.amplitude_to_db(np.abs(librosa.stft(yb, n_fft=2048, hop_length=hop)), ref=np.max)

    fig, axes = plt.subplots(2, 1, figsize=(16, 10), sharex=True, sharey=True)
    for ax, S, lab in ((axes[0], Sa, args.label_a), (axes[1], Sb, args.label_b)):
        img = librosa.display.specshow(S, sr=sr, hop_length=hop, x_axis="time",
                                       y_axis="linear", ax=ax, cmap="magma",
                                       vmin=-70, vmax=0)
        ax.set_title(lab, fontsize=13)
        ax.set_ylim(0, 8000)
        fig.colorbar(img, ax=ax, format="%+2.0f dB")

    # 第三张：两者的差（转换相对原唱改变了什么）
    fig2, ax = plt.subplots(figsize=(16, 4.5))
    img = librosa.display.specshow(Sb - Sa, sr=sr, hop_length=hop, x_axis="time",
                                   y_axis="linear", ax=ax, cmap="coolwarm",
                                   vmin=-20, vmax=20)
    ax.set_title(f"DIFFERENCE  ({args.label_b} − {args.label_a})   red = added, blue = removed",
                 fontsize=12)
    ax.set_ylim(0, 8000)
    fig2.colorbar(img, ax=ax, format="%+2.0f dB")

    out = os.path.abspath(args.out) if args.out else os.path.join(SING, "out", "spectrogram.png")
    fig.tight_layout()
    fig.savefig(out, dpi=110, bbox_inches="tight")
    fig2.tight_layout()
    fig2.savefig(out.replace(".png", "-diff.png"), dpi=110, bbox_inches="tight")
    print(f"声谱图对比 → {out}")
    print(f"差异图     → {out.replace('.png', '-diff.png')}")


if __name__ == "__main__":
    main()
