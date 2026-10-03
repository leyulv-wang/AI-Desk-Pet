# -*- coding: utf-8 -*-
"""
辅音补偿：用原唱的高频去修转换后的咬字。

## 原理

    音色（像不像目标角色）  ←  主要靠**低频共振峰**（F1/F2/F3，几百 Hz ~ 3 kHz）
    咬字（听不听得清在唱什么）←  主要靠**高频辅音**（齿音 s/sh 在 5~10 kHz，
                                 爆破音 t/k/p 是极短的宽带瞬态）

Voice conversion 模型对前者学得好（共振峰是稳态的），对后者学不好
（辅音是瞬态，重建时容易被"抹平"）。所以出现「音色很像，但个别字听不清」。

**做法就是把两者拼起来**：低频用转换后的（保住音色），高频换回原唱的（保住咬字）。

## 两种模式

    replace  低通(转换后) + 高通(原唱)
             最彻底。咬字最清楚，但高频泛音也变成原唱的 → 音色会往原唱偏一点。

    add      转换后 + mix × 高通(原唱)
             温和。保留转换后的高频，只叠一层原唱辅音。保留音色但改善有限。

交叉频率默认 5500 Hz —— 人声齿音主要在这个以上，而 F3 以下（约 3 kHz）
已经能决定大部分音色感知，所以从 5.5 kHz 切比较安全。

用法：
    python tools/restore_consonants.py --converted 转换后.wav --source 原唱.wav \
        --out 修好后.wav --mode replace --crossover 5500
"""
import argparse
import os
import subprocess
import sys


def build_filter(mode, xover, mix):
    if mode == "replace":
        # 转换后的低频 + 原唱的高频
        return (f"[0:a]lowpass=f={xover}:poles=2[cl];"
                f"[1:a]highpass=f={xover}:poles=2[sh];"
                f"[cl][sh]amix=inputs=2:duration=shortest:normalize=0[out]")
    if mode == "add":
        # 转换后（全带） + mix × 原唱高频
        return (f"[0:a]anull[c];"
                f"[1:a]highpass=f={xover}:poles=2,volume={mix}[sh];"
                f"[c][sh]amix=inputs=2:duration=shortest:normalize=0[out]")
    raise SystemExit(f"未知模式：{mode}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--converted", required=True)
    ap.add_argument("--source", required=True, help="原唱人声（同一段）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["replace", "add"], default="replace")
    ap.add_argument("--crossover", type=float, default=5500.0)
    ap.add_argument("--mix", type=float, default=0.5, help="add 模式下原唱高频的增益")
    ap.add_argument("--sr", type=int, default=44100)
    args = ap.parse_args()

    for p in (args.converted, args.source):
        if not os.path.exists(p):
            raise SystemExit(f"找不到：{p}")

    filt = build_filter(args.mode, args.crossover, args.mix)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-i", args.converted, "-i", args.source,
           "-filter_complex", filt, "-map", "[out]",
           "-c:a", "pcm_s16le", "-ar", str(args.sr), args.out]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit("ffmpeg 失败：\n" + (r.stderr or "")[-1500:])

    print(f"✅ {args.mode} 模式，交叉 {args.crossover:.0f} Hz"
          + (f"，mix={args.mix}" if args.mode == "add" else ""))
    print(f"   → {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main()
