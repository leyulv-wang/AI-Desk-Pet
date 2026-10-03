# -*- coding: utf-8 -*-
"""
看一下 songs/测试曲-合成.wav 是什么，能不能当作「受控实验」的干净源。

目的：如果它是**合成的（未经过有损压缩的）歌声**，就可以做这个实验：
    同一个源 → 直接转换     （干净源基线）
    同一个源 → 转成 128kbps mp3 → 再转换   （模拟你现在的情况）
    对比两次的指标 → 直接量化「源码率」这个变量的贡献

用法：python tools/probe_test_song.py <音频>
"""
import sys
import warnings

warnings.filterwarnings("ignore")

import librosa
import numpy as np

p = sys.argv[1] if len(sys.argv) > 1 else r"..\songs\测试曲-合成.wav"
y, sr = librosa.load(p, sr=44100, mono=True)
print(f"文件     {p}")
print(f"时长     {len(y) / sr:.1f}s   采样率 {sr}   峰值 {np.abs(y).max():.3f}")

S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
f = librosa.fft_frequencies(sr=sr, n_fft=2048)
p2 = (S ** 2).sum(1)
print(f"谱质心   {np.sum(f * p2) / np.sum(p2):.0f} Hz")
print(f">2kHz占比 {(p2[f > 2000].sum() / p2.sum()):.3f}")
print(f">16kHz占比 {(p2[f > 16000].sum() / p2.sum()):.5f}   ← 128k mp3 通常在 16k 附近砍掉")

# 前 30 秒的 F0，判断有没有旋律/人声
seg = y[: sr * 30]
f0 = librosa.yin(seg, fmin=65, fmax=1000, sr=sr)
v = f0[(f0 > 65) & (f0 < 1000)]
if len(v):
    print(f"F0 中位  {np.median(v):.0f} Hz   有声帧占比 {len(v) / len(f0):.2f}")
    print(f"F0 范围  {np.percentile(v, 5):.0f} ~ {np.percentile(v, 95):.0f} Hz")
else:
    print("没检测到明显 F0 —— 可能是纯乐器/噪声")

# 左右声道是否相同（单声道化的合成曲）
y2, _ = librosa.load(p, sr=44100, mono=False)
if y2.ndim == 2:
    d = np.abs(y2[0] - y2[1]).max()
    print(f"立体声差异 max={d:.5f}  ({'基本是单声道' if d < 1e-4 else '有立体声内容'})")
