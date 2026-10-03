#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RVC 翻唱管线（**带分块加速**）

    ┌─ ① 分离 ──── 原曲 → 人声 + 伴奏（demucs）
    ├─ ② 转换 ──── RVC v2（分块 + 交叉淡化）
    └─ ③ 混音 ──── 转换后的人声 + 伴奏 → 成品

## 为什么必须分块

实测（RTX 5060 8GB，RVC v2 40kHz 模型）：

    输入 20 秒   → 合成 1.55 秒
    输入 211 秒  → 合成 729 秒

长度涨 10.5 倍，时间涨 **470 倍**。这不是计算量增长，是
**Windows 的 WDDM 显存超额订阅**：显存不够时驱动不报 OOM，而是把显存
页到系统内存，速度暴跌几十倍。

同一个机制也是之前那次事故的温床 —— 一次 CUDA device-side assert
+ 显存压力，把显卡驱动搞成了 TDR，Windows 写出 12.9 GB 内核转储。

**分块把每块的显存占用压回安全范围**，一举解决速度和崩溃风险。

## 分块怎么做才不出接缝

    ① **全局归一化**：vc_single 内部会按每段自身的峰值重新缩放
       （audio_max = max|x| / 0.95），逐块调用就会导致**块间音量跳变**。
       先把整条音频归一化到峰值 0.9，各块就不再触发它的重缩放。

    ② **每块多带 context 秒上下文**：模型需要前后文才能把韵律接顺，
       但只保留中间 [s, e] 那一段的输出。

    ③ **相邻块重叠 overlap 秒，交叠相加**：用线性淡入淡出加权求和，
       最后除以权重累计，得到无缝拼接。

## 为什么不用 RVC 自带的 pipeline()

那个是**实时变声**用的流式接口（固定 block_time + SOLA 拼接），
离线整曲走的 `vc_single` 是一次吃整段的。我们自己分块更可控。

用法：
    python rvc_cover.py --song "D:\\Kugou\\某首中文歌.mp3"
    python rvc_cover.py --song xxx.mp3 --chunk 20 --no-separate   # 复用已分离的人声
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RVC_ROOT = os.path.join(HERE, "repos", "RVC")
VOICE_DIR = r"D:\models\RVC\funingna"


def log(m):
    print(f"[rvc] {m}", flush=True)


# --------------------------------------------------------------------------- 分块转换
def convert_chunked(vc, audio, sr, *, sid, pitch, f0_method, index_path,
                    index_rate, resample_sr, rms_mix_rate, protect,
                    chunk_sec, context_sec, overlap_sec, tmpdir):
    """把整段音频切成块逐块转换，再交叠相加拼回完整长度。"""
    import soundfile as sf

    tgt_sr = int(vc.tgt_sr)
    dur = len(audio) / sr
    step = chunk_sec - overlap_sec
    if step <= 0:
        raise SystemExit("chunk 必须大于 overlap")

    # 计算每块的起点
    starts = []
    p = 0.0
    while True:
        starts.append(p)
        if p + chunk_sec >= dur:
            break
        p += step

    log(f"   分成 {len(starts)} 块（每块 {chunk_sec}s + 上下文 {context_sec}s，重叠 {overlap_sec}s）")

    total_len = int(dur * tgt_sr) + tgt_sr
    out = np.zeros(total_len, dtype=np.float64)
    wsum = np.zeros(total_len, dtype=np.float64)
    ov = int(overlap_sec * tgt_sr)

    for i, s in enumerate(starts):
        t0 = time.time()
        e = min(s + chunk_sec, dur)
        cs = max(0.0, s - context_sec)
        ce = min(dur, e + context_sec)

        seg = audio[int(cs * sr):int(ce * sr)]
        tmp_in = os.path.join(tmpdir, f"chunk_{i:03d}_in.wav")
        sf.write(tmp_in, seg, sr)

        status, result = vc.vc_single(
            sid, tmp_in, pitch, f0_method, index_path,
            index_rate, resample_sr, rms_mix_rate, protect)
        if not result or result[0] is None or result[1] is None:
            raise SystemExit(f"第 {i} 块转换失败：{status}")
        conv_sr, conv = result
        conv = np.asarray(conv).reshape(-1)

        # ⚠️ **vc_single 返回的是 int16**（值域 -32768~32767），不是浮点。
        #    直接交给 soundfile 写会被按 [-1,1] 的期望值**整体截断成方波**
        #    （实测：全曲 RMS 变成 1.0、峰值中位数 1.0、音色相似度从 0.68 掉到 0.14）。
        #    必须先归一化到 [-1,1]。
        if conv.dtype.kind in "iu":
            conv = conv.astype(np.float32) / 32768.0
        conv = conv.astype(np.float64)

        # 转换是保长的，但可能有微小比例差 → 按比例定位 [s, e] 对应的区间
        expect = (ce - cs) * conv_sr
        scale = (len(conv) / expect) if expect > 0 else 1.0
        off = int((s - cs) * conv_sr * scale)
        ln = int((e - s) * conv_sr * scale)
        piece = conv[off:off + ln]
        if len(piece) == 0:
            raise SystemExit(f"第 {i} 块取不到有效区间（len(conv)={len(conv)}）")

        # 淡入淡出权重：靠边界的部分渐隐，交给邻块补上
        w = np.ones(len(piece), dtype=np.float64)
        if s > 0:
            n = min(ov, len(w))
            w[:n] = np.linspace(0.0, 1.0, n, dtype=np.float64)
        if e < dur:
            n = min(ov, len(w))
            w[-n:] = np.linspace(1.0, 0.0, n, dtype=np.float64)

        pos = int(s * conv_sr)
        end = min(pos + len(piece), total_len)
        piece = piece[:end - pos]
        w = w[:end - pos]
        out[pos:end] += piece * w
        wsum[pos:end] += w

        log(f"   块 {i + 1}/{len(starts)} [{s:.1f}s~{e:.1f}s]  {time.time() - t0:.1f}s")

    mixed = out / np.maximum(wsum, 1e-6)
    mixed = mixed[:int(dur * tgt_sr)]
    return conv_sr, mixed.astype(np.float32)


# --------------------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True)
    ap.add_argument("--voice-dir", default=VOICE_DIR,
                    help="含 .pth 和 .index 的目录")
    ap.add_argument("--pth", default=None, help="显式指定 .pth")
    ap.add_argument("--index", default=None, help="显式指定 .index")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--sid", type=int, default=0)
    ap.add_argument("--pitch", type=int, default=0)
    ap.add_argument("--f0-method", default="rmvpe", choices=["pm", "rmvpe", "harvest", "crepe", "fcpe"])
    ap.add_argument("--index-rate", type=float, default=0.75,
                    help="检索特征的使用比例。越高越像目标，但太高会削弱源的表现力")
    ap.add_argument("--rms-mix-rate", type=float, default=1.0,
                    help="1.0 = 完全用转换后的音量包络；0 = 用源的")
    ap.add_argument("--protect", type=float, default=0.33,
                    help="保护清辅音/气声不被过度转换，0.33 是常用值")
    ap.add_argument("--resample-sr", type=int, default=0, help="输出重采样到该采样率，0=模型原生")
    # 分块参数
    ap.add_argument("--chunk", type=float, default=30.0, help="每块多少秒")
    ap.add_argument("--context", type=float, default=1.0, help="每块两侧额外给模型的上下文秒数")
    ap.add_argument("--overlap", type=float, default=1.5, help="相邻块交叉淡化秒数")
    # 分离
    ap.add_argument("--no-separate", action="store_true", help="复用已有的 vocal_raw.wav / accompaniment.wav")
    ap.add_argument("--demucs-model", default="htdemucs")
    # 混音
    ap.add_argument("--vocal-gain", type=float, default=0.0)
    ap.add_argument("--inst-gain", type=float, default=-1.0)
    ap.add_argument("--loudness", type=float, default=-14.0)
    args = ap.parse_args()

    song = os.path.abspath(args.song)
    if not os.path.exists(song):
        raise SystemExit(f"找不到原曲：{song}")

    # 找模型文件
    pth = args.pth or next((os.path.join(args.voice_dir, f) for f in os.listdir(args.voice_dir)
                            if f.endswith(".pth")), None) if os.path.isdir(args.voice_dir) else None
    idx = args.index or next((os.path.join(args.voice_dir, f) for f in os.listdir(args.voice_dir)
                              if f.endswith(".index")), None) if os.path.isdir(args.voice_dir) else None
    if not pth or not os.path.exists(pth):
        raise SystemExit(f"找不到 .pth：{pth}")
    outdir = args.outdir or os.path.join(os.path.dirname(song),
                                         os.path.splitext(os.path.basename(song))[0] + "_rvc")
    # ⚠️ 必须在 chdir 到 RVC 仓库之前转成绝对路径。
    # 否则下面 os.chdir(RVC_ROOT) 之后，相对 outdir 会被解析到仓库里面去，
    # 导致「找不到已分离的人声」而重复跑一次 demucs，产物也落错地方。
    outdir = os.path.abspath(outdir)
    os.makedirs(outdir, exist_ok=True)
    tmpdir = os.path.join(outdir, "_chunks")
    os.makedirs(tmpdir, exist_ok=True)

    log(f"原曲 {os.path.basename(song)}")
    log(f"模型 {pth}")
    log(f"索引 {idx or '（不使用）'}")

    # RVC 要求工作在仓库根目录，且 infer 包要在 sys.path 里
    os.chdir(RVC_ROOT)
    sys.path.insert(0, RVC_ROOT)
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    # ⚠️ RVC 用**环境变量**来定位各种资源根目录（pipeline.py 直接读
    #    os.environ["rmvpe_root"]，缺了就是 KeyError）。
    #    CLI 里也是这么设的（cli.py:19-22）。assets 是指向
    #    D:\models\RVC\runtime 的 junction，所以权重不用拷进仓库。
    os.environ.setdefault("weight_root", os.path.join(RVC_ROOT, "assets", "weights"))
    os.environ.setdefault("index_root", os.path.join(RVC_ROOT, "logs"))
    os.environ.setdefault("outside_index_root", os.path.join(RVC_ROOT, "assets", "indices"))
    os.environ.setdefault("rmvpe_root", os.path.join(RVC_ROOT, "assets", "rmvpe"))

    import librosa
    import soundfile as sf
    import torch

    t_all = time.time()

    # ---------------------------------------------------------------- ① 分离
    vocal = os.path.join(outdir, "vocal_raw.wav")
    accomp = os.path.join(outdir, "accompaniment.wav")
    if args.no_separate and os.path.exists(vocal) and os.path.exists(accomp):
        log("① 跳过分离（复用已有产物）")
    else:
        log(f"① 人声分离（demucs {args.demucs_model}）…")
        t0 = time.time()
        sep_dir = os.path.join(outdir, "_sep")
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        p = subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals",
                            "-n", args.demucs_model, "-d", dev, "-o", sep_dir, song],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0:
            raise SystemExit("demucs 失败：\n" + "\n".join((p.stderr or "").splitlines()[-8:]))
        stem = os.path.splitext(os.path.basename(song))[0]
        base = os.path.join(sep_dir, args.demucs_model, stem)
        shutil.copy2(os.path.join(base, "vocals.wav"), vocal)
        shutil.copy2(os.path.join(base, "no_vocals.wav"), accomp)
        log(f"   {time.time() - t0:.1f}s")

    # ---------------------------------------------------------------- ② 转换
    log("② 读取人声…")
    audio, sr = librosa.load(vocal, sr=None, mono=True)
    log(f"   {len(audio) / sr:.1f}s @ {sr}Hz")

    # **全局归一化**：避免 vc_single 按每块的峰值重缩放，否则块间会有音量跳变
    peak = float(np.abs(audio).max())
    if peak > 0:
        audio = (audio / peak * 0.9).astype(np.float32)
    log(f"   已全局归一化（原峰值 {peak:.3f} → 0.900）")

    log("③ 加载 RVC 模型…")
    t0 = time.time()
    # ⚠️ RVC 的 Config.arg_parse() 是 @staticmethod，**由 Config() 构造时调用**，
    #    里面是 `parser.parse_args()` —— 直接读 sys.argv。
    #    所以光在 import 时保护没用，**必须把 Config() 的构造也圈进来**，
    #    否则它会把我们的 --song/--chunk 当成自己的参数然后报
    #    "unrecognized arguments" 退出。
    _saved_argv = list(sys.argv)
    sys.argv = [_saved_argv[0]]
    try:
        from configs.config import Config
        from infer.vc.modules import VC
        config = Config()          # ← arg_parse() 在这里执行
    finally:
        sys.argv = _saved_argv

    vc = VC(config)
    # ⚠️ get_vc() 接受的**不是路径，是模型名** —— 它内部做
    #    person = f'{os.getenv("weight_root")}/{sid}'
    #    所以必须先把 weight_root 指向模型目录，再传文件名。
    #    （CLI 里也是这么做的：cli.py:234 os.environ["weight_root"] = str(model_path.parent)）
    os.environ["weight_root"] = os.path.dirname(os.path.abspath(pth))
    vc.get_vc(os.path.basename(pth))
    log(f"   {time.time() - t0:.1f}s  设备={config.device} 精度={config.dtype} 目标采样率={vc.tgt_sr}")

    log("④ 分块转换…")
    t0 = time.time()
    conv_sr, converted = convert_chunked(
        vc, audio, sr,
        sid=args.sid, pitch=args.pitch, f0_method=args.f0_method,
        index_path=idx or "", index_rate=args.index_rate,
        resample_sr=args.resample_sr, rms_mix_rate=args.rms_mix_rate,
        protect=args.protect,
        chunk_sec=args.chunk, context_sec=args.context, overlap_sec=args.overlap,
        tmpdir=tmpdir)
    conv_path = os.path.join(outdir, "vocal_converted.wav")
    sf.write(conv_path, converted, conv_sr)
    log(f"   转换完成 {time.time() - t0:.1f}s → {len(converted) / conv_sr:.1f}s @ {conv_sr}Hz")
    if torch.cuda.is_available():
        log(f"   显存峰值 {torch.cuda.max_memory_allocated() / 1e9:.2f} GB")

    # ---------------------------------------------------------------- ③ 混音
    log("⑤ 混音…")
    mixed = os.path.join(outdir, "mixed.wav")
    filt = (f"[0:a]aresample=44100,volume={args.vocal_gain}dB[v];"
            f"[1:a]aresample=44100,volume={args.inst_gain}dB[i];"
            f"[v][i]amix=inputs=2:duration=shortest:normalize=0[m];"
            f"[m]loudnorm=I={args.loudness}:TP=-1.5:LRA=11,alimiter=limit=0.97[out]")
    p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", conv_path, "-i", accomp,
                        "-filter_complex", filt, "-map", "[out]",
                        "-c:a", "pcm_s16le", "-ar", "44100", mixed],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        log("   ⚠️ 混音失败：" + "\n".join((p.stderr or "").splitlines()[-5:]))
    else:
        log(f"   → {mixed}")

    shutil.rmtree(tmpdir, ignore_errors=True)
    log(f"✅ 完成，总耗时 {time.time() - t_all:.1f}s")
    log("")
    log("产物说明（全部在 " + outdir + "）：")
    log("  ① vocal_raw.wav        分离出来的原唱人声   ← 转换的「输入」")
    log("  ② vocal_converted.wav  转换后的人声         ← 这一版是 RVC 的音色")
    log("  ③ accompaniment.wav    分离出来的伴奏")
    log("  ④ mixed.wav            ★ 成品 = ②+③ 混音并做响度归一化（你要听的是这个）")
    log("")
    log("想和其他架构对比，就去找同名的 *_ddsp 目录，比 ② 和 ④。")


if __name__ == "__main__":
    main()
