# -*- coding: utf-8 -*-
"""
验一下一个音频文件是**真无损/真高码率**，还是**低码率二次转码的假货**。

为什么需要：网上标着 "320kbps" 甚至 "FLAC" 的文件，很多其实是低码率 mp3
（甚至 YouTube 转的 AAC）**重新编码**出来的。重新编码**不能恢复**已经被砍掉的
高频 —— 所以这类"高码率"文件听起来和 128k 一样闷。

识别方法：**看频谱截止频率**。
    · 无损 / 真高码率  → 内容一直延伸到 20 kHz 以上
    · 128 kbps mp3     → 硬性低通在 15~16.5 kHz
    · 96 kbps          → 约 15 kHz
    · 64 kbps          → 约 11 kHz
    · 走 YouTube 的 AAC 128k → 约 15~16 kHz
真假判断的关键：**如果码率写着 320k/无损，但截止频率还在 16 kHz，那就是假的。**

用法：
    python tools/check_audio_quality.py <音频文件> [更多文件...]
"""
import os
import subprocess
import sys
import warnings

warnings.filterwarnings("ignore")

import librosa
import numpy as np

# 按截止频率给的粗略判断（仅对有音乐的素材有效）
BANDS = [
    (20500, "✅ 有 20kHz 以上内容 —— 无损或非常高的码率"),
    (19000, "🟢 接近全带宽 —— 很可能是真无损/极高码率"),
    (17000, "🟡 约 17-19kHz —— 256~320kbps 有损，或本身编曲偏暗"),
    (15500, "🟠 约 15.5-17kHz —— 典型 128kbps mp3"),
    (13500, "🟠 约 13.5-15.5kHz —— 约 96kbps"),
    (10500, "🔴 约 10.5-13.5kHz —— 约 64kbps，明显受损"),
    (0,     "🔴 10.5kHz 以下 —— 严重受损（<64kbps）"),
]


def probe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=format_name,bit_rate,duration:stream=codec_name,sample_rate,channels,bit_rate",
         "-of", "default=noprint_wrappers=1", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout.strip().replace("\n", "  ")


def analyze(path):
    y, sr = librosa.load(path, sr=None, mono=True)
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=1024))
    fr = librosa.fft_frequencies(sr=sr, n_fft=4096)
    pw = (S ** 2).mean(1)

    if pw.max() <= 0:
        return None

    # 截止频率：能量从峰值往下掉 -80dB 视为无内容
    peak = pw.max()
    thr = peak * 1e-8            # -80 dB
    above = np.where(pw > thr)[0]
    cutoff = fr[above[-1]] if len(above) else 0.0

    # 更严格的判据：-60dB 处的最高频率（对"还有没有真实内容"更敏感）
    thr6 = peak * 1e-6           # -60 dB
    ab6 = np.where(pw > thr6)[0]
    cutoff6 = fr[ab6[-1]] if len(ab6) else 0.0

    return dict(sr=sr, dur=len(y) / sr, cutoff=cutoff, cutoff6=cutoff6,
                centroid=float(np.sum(fr * pw) / pw.sum()))


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)

    print(f"{'文件':<34}{'采样率':>8}{'时长s':>8}{'-60dB截止':>11}{'-80dB截止':>11}   判读")
    print("-" * 108)
    for path in sys.argv[1:]:
        if not os.path.exists(path):
            print(f"{os.path.basename(path):<34}  找不到文件")
            continue
        a = analyze(path)
        if not a:
            print(f"{os.path.basename(path):<34}  静音/无法分析")
            continue
        band = next(t for c, t in BANDS if a["cutoff6"] >= c)
        name = os.path.basename(path)
        print(f"{name[:33]:<34}{a['sr']:>8}{a['dur']:>8.1f}"
              f"{a['cutoff6']:>10.0f}Hz{a['cutoff']:>10.0f}Hz   {band}")

    print()
    print("=== 编码参数 ===")
    for path in sys.argv[1:]:
        if os.path.exists(path):
            print(f"\n{os.path.basename(path)}")
            print(f"  {probe(path)}")

    print("""
怎么用这个结果：
  ① 看「-60dB截止」那一列 —— 这是**真实内容**延伸到哪里。
  ② 对照容器里写的码率：
       · 码率写 320k/1411k(无损)，但截止只有 ~16kHz  → **假货**，是低码率转码来的
       · 码率写 320k，截止 ~19-20kHz                → 真的
       · 码率写 128k，截止 ~16kHz                   → 正常，符合预期
  ③ 注意例外：有些编曲本身就很暗（比如纯低音/慢歌），截止低不代表文件有问题。
     对同一个曲子的**不同版本**做横向比较最准 —— 截止明显更高的那个就是更好的源。
""")


if __name__ == "__main__":
    main()
