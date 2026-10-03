# -*- coding: utf-8 -*-
"""
音色稳定性：捕捉「抖 / 不稳 / 忽明忽暗」这类**聚合指标抓不到**的毛病。

为什么需要这个：
    我之前那套指标（整体音色相似度、HNR、高频占比）都是**全曲平均**。
    但一个声音可以"平均下来很像"，却听起来**一帧一个样** —— 抖、飘、
    忽厚忽薄。那种毛病在平均值里被抹平了，只有耳朵听得出来。

    这个脚本改成**逐窗测量**：
      ① 把音频切成 0.4 秒的小窗
      ② 每个窗算一个 ECAPA 说话人向量（代表"这一瞬间的音色"）
      ③ 看相邻窗之间有多像 —— 越像说明音色越稳
      ④ 也看所有窗之间的离散度

    用同一个人念一段正常的语音做参照，就能知道"稳"大概是什么水平。

用法：
    python tools/timbre_stability.py <音频> [更多音频...]
"""
import os
import sys
import warnings

import numpy as np

warnings.filterwarnings("ignore")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate as E   # 复用里面已经调好的 ECAPA

WIN = 0.4   # 窗长（秒）
HOP = 0.2   # 窗移（秒）


def stability(path, win=WIN, hop=HOP):
    import librosa
    y, _ = librosa.load(os.path.abspath(path), sr=E.SR_EMB, mono=True)
    n = int(win * E.SR_EMB)
    step = int(hop * E.SR_EMB)

    # 只在有能量的窗口上算，跳过静音
    segs = []
    for i in range(0, max(len(y) - n, 1), step):
        s = y[i:i + n]
        if len(s) < n // 2:
            continue
        if np.sqrt((s ** 2).mean()) < 0.005:      # 静音跳过
            continue
        segs.append((i, s))
    if len(segs) < 4:
        return None

    embs = np.stack([E.embed_seg(s) for _i, s in segs])
    # 相邻窗余弦相似度
    adj = np.sum(embs[:-1] * embs[1:], axis=1)
    # 全体两两离散度（用与均值的相似度衡量）
    mean = embs.mean(0)
    mean /= np.linalg.norm(mean) + 1e-9
    to_mean = embs @ mean

    return dict(
        file=os.path.basename(path),
        windows=len(segs),
        adj_mean=float(adj.mean()),        # 相邻窗平均相似度（越高越稳）
        adj_min=float(adj.min()),          # 最抖的那一处
        adj_std=float(adj.std()),
        tomean_min=float(to_mean.min()),   # 最偏离整体音色的那一窗
        tomean_std=float(to_mean.std()),
    )


def main():
    paths = sys.argv[1:]
    if not paths:
        raise SystemExit(__doc__)

    print(f"窗长 {WIN}s / 窗移 {HOP}s，只统计有能量的窗\n")
    print(f"{'文件':<26}{'窗数':>6}{'相邻窗相似度':>14}{'最低':>9}{'标准差':>9}{'偏离均值最低':>14}")
    print("-" * 80)
    rows = []
    for p in paths:
        r = stability(p)
        if not r:
            print(f"{os.path.basename(p):<26}  有效窗太少，跳过")
            continue
        rows.append((p, r))
        print(f"{r['file'][:25]:<26}{r['windows']:>6}{r['adj_mean']:>14.4f}"
              f"{r['adj_min']:>9.4f}{r['adj_std']:>9.4f}{r['tomean_min']:>14.4f}")

    print("""
读法：
  相邻窗相似度   越高越稳（1.0 = 音色完全不变）。**这个数字低 = 听起来抖/飘。**
  最低           最抖的那一处，能看出有没有偶发的"破音/飘掉"
  偏离均值最低   有没有某一段音色整体跑偏（比如高音区突然变另一个人）
  参照：同一人念正常语音，相邻窗相似度通常在 0.85~0.95 之间""")


if __name__ == "__main__":
    main()
