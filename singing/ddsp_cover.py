#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一首歌 → DDSP-SVC → 用芙宁娜的音色唱出来

    ┌─ ① 分离 ──── 原曲 → 人声 + 伴奏（demucs htdemucs）
    ├─ ② 转换 ──── DDSP-SVC（RectifiedFlow）+ 芙宁娜音色模型
    └─ ③ 混音 ──── 转换后的人声 + 伴奏 → 成品

**这个脚本跑的是本机已有的音色模型**（`D:\\models\\DDSP-SVC\\voices\\芙宁娜`），
不是零样本方案 —— 那个模型是从你的 `.sf_pkg` 里拆出来的（见 tools/split_sfpkg.py），
所以不需要训练，也不需要联网推理。

为什么不用官方的 `gui_reflow.py`：
  那个文件是给图形界面用的，import 了 FreeSimpleGUI / sounddevice，还带着实时变声
  那一整套（SOLA 拼接、分块流式）。我们只要「整首歌离线转一遍」，所以直接复刻
  `SvcDDSP.infer()` 的那 20 行核心逻辑就够了。

注意：必须在 DDSP-SVC 仓库根目录下运行（`pretrain/rmvpe/model.pt` 是硬编码的相对路径）。

用法：
    python ddsp_cover.py --song ../songs/某首歌.mp3 --voice 芙宁娜
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "repos", "DDSP-SVC")
VOICES = r"D:\models\DDSP-SVC\voices"


def log(m):
    print(f"[cover] {m}", flush=True)


# --------------------------------------------------------------------------- 桌宠对接
# `--emit-progress` 打开时，往 stdout 多打两种前缀行，给桌宠的 src/singing.js 解析：
#     @@PROGRESS {"stage":"转换","pct":72}
#     @@RESULT   {"ok":true,"mixed":"...","vocal":"...", ...}
#
# 为什么走 stdout 前缀而不是写进度文件：singing.js 已经把子进程 stdout 接成管道了
# （要实时刷新进度条），前缀行是最省事的接法。日志行照常打，JS 只挑带前缀的。
EMIT = False


def emit_progress(stage, pct):
    if EMIT:
        print("@@PROGRESS " + json.dumps({"stage": stage, "pct": int(pct)},
                                         ensure_ascii=False), flush=True)


def emit_result(**kw):
    if EMIT:
        print("@@RESULT " + json.dumps(kw, ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser(description="DDSP-SVC 翻唱")
    ap.add_argument("--song", "--input", required=True, dest="song",
                    help="原曲（--input 是桌宠 singing.js 调用时的别名）")
    ap.add_argument("--emit-progress", action="store_true",
                    help="往 stdout 打 @@PROGRESS / @@RESULT 行，供桌宠解析进度")
    ap.add_argument("--force", action="store_true",
                    help="占位参数（桌宠会传），当前无行为：产物本来就每次覆盖")
    ap.add_argument("--voice", default="芙宁娜", help="音色模型名（D:\\models\\DDSP-SVC\\voices\\<名字>）")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--spk-id", type=int, default=1,
                    help="说话人编号。**1-based** —— 代码里是 spk_embed(spk_id - 1)，"
                         "传 0 会索引越界报 CUDA device-side assert。"
                         "单位模型（spks 只有一个）用 1")
    ap.add_argument("--pitch", type=int, default=0, help="变调半音，改的是旋律音高")
    ap.add_argument("--formant", type=float, default=0.0,
                    help="共振峰偏移（音色粗细/年龄感）。**只改音色不改音高** —— "
                         "这是调嗓音的主力旋钮。模型内部是 aug_shift/5 送进 Linear，"
                         "训练时用 use_pitch_aug 做过增强，所以实用范围大致 -5~5，"
                         "先试 -2 / -1 / 0 / 1 / 2")
    ap.add_argument("--spk-mix", default=None,
                    help="说话人混合，形如 '1:0.7,5:0.3'（权重和≈1）。"
                         "把两个 spk_id 的音色按比例叠加，可以混出第三、第四种嗓音。"
                         "注意每个 id 都是 1-based")
    ap.add_argument("--method", default=None, choices=["euler", "rk4"],
                    help="ODE 求解器。rk4 更精确但慢约 2 倍；默认用模型配置里的")
    ap.add_argument("--f0-min", type=float, default=65)
    ap.add_argument("--f0-max", type=float, default=800)
    ap.add_argument("--threshold", type=float, default=-45, help="静音门限 dB")
    ap.add_argument("--infer-step", type=int, default=0, help="0 = 用模型配置里的值")
    ap.add_argument("--t-start", type=float, default=-1, help="-1 = 用模型配置里的值")
    ap.add_argument("--vocal-gain", type=float, default=0)
    ap.add_argument("--inst-gain", type=float, default=-1)
    ap.add_argument("--loudness", type=float, default=-14.0,
                    help="成品目标响度 LUFS。流媒体一般 -14，想更响可以 -12")
    ap.add_argument("--demucs-model", default="htdemucs",
                    choices=["htdemucs", "htdemucs_ft", "mdx_extra", "mdx_extra_q"],
                    help="人声分离用的模型。htdemucs_ft 是微调版，分离更干净但慢约 4 倍")
    ap.add_argument("--skip-separate", action="store_true", help="复用已有的 vocal_raw.wav / accompaniment.wav")
    ap.add_argument("--seed", type=int, default=0,
                    help="随机种子。**DDSP-SVC 的噪声激励是 torch.randn_like，没种子就每次输出都不同**"
                         "（实测同配置两次跑，波形最大差 0.46）。种子本身不改变质量，"
                         "但固定它能让同一首歌每次生成结果一致、可复现。0 = 不固定")
    args = ap.parse_args()

    global EMIT
    EMIT = args.emit_progress

    song = os.path.abspath(args.song)
    if not os.path.exists(song):
        raise SystemExit(f"找不到原曲：{song}")
    voice_dir = os.path.join(VOICES, args.voice)
    model_pt = os.path.join(voice_dir, "model.pt")
    if not os.path.exists(model_pt):
        raise SystemExit(f"找不到音色模型：{model_pt}")

    outdir = args.outdir or os.path.join(os.path.dirname(song),
                                         os.path.splitext(os.path.basename(song))[0] + "_ddsp")
    # ⚠️ 必须在 os.chdir(REPO) 之前转成绝对路径。
    # 否则后面切到 DDSP-SVC 仓库目录后，相对 outdir 会被解析到仓库里面
    # （产物落错地方，而且 --skip-separate 找不到 vocal_raw.wav，白跑一遍分离）。
    outdir = os.path.abspath(outdir)
    os.makedirs(outdir, exist_ok=True)

    # rmvpe 的路径是硬编码的相对路径，必须切到仓库根目录
    os.chdir(REPO)
    sys.path.insert(0, REPO)

    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from ddsp.vocoder import F0_Extractor, Units_Encoder, Volume_Extractor, upsample
    from reflow.vocoder import load_model_vocoder

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"设备 {device} | 音色 {args.voice} | 原曲 {os.path.basename(song)}")
    if device == "cuda":
        log(f"GPU {torch.cuda.get_device_name(0)}")
    t_all = time.time()
    emit_progress("准备中", 2)

    # ---------------------------------------------------------------- ① 分离
    vocal = os.path.join(outdir, "vocal_raw.wav")
    accomp = os.path.join(outdir, "accompaniment.wav")
    if args.skip_separate and os.path.exists(vocal) and os.path.exists(accomp):
        log("① 跳过分离（复用已有产物）")
        emit_progress("读取人声", 35)
    else:
        log(f"① 人声分离（demucs {args.demucs_model}）…")
        emit_progress("分离人声", 8)
        t0 = time.time()
        sep_dir = os.path.join(outdir, "_sep")
        cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals",
               "-n", args.demucs_model, "-d", device, "-o", sep_dir, song]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0:
            tail = (p.stderr or p.stdout or "").strip().splitlines()[-10:]
            raise SystemExit("demucs 失败：\n" + "\n".join(tail))
        # demucs 输出：<sep_dir>/<模型名>/<歌名>/vocals.wav 和 no_vocals.wav
        stem = os.path.splitext(os.path.basename(song))[0]
        base = os.path.join(sep_dir, args.demucs_model, stem)
        import shutil
        shutil.copy2(os.path.join(base, "vocals.wav"), vocal)
        shutil.copy2(os.path.join(base, "no_vocals.wav"), accomp)
        log(f"  分离完成 {time.time() - t0:.1f}s")

    # demucs 输出 44.1kHz；DDSP 模型也是 44.1k，直接用原采样率
    log("② 读取人声…")
    emit_progress("读取人声", 38)
    audio, sr = librosa.load(vocal, sr=None, mono=True)
    log(f"   {len(audio) / sr:.1f}s @ {sr}Hz")

    log("③ 加载音色模型…")
    emit_progress("加载模型", 45)
    t0 = time.time()
    model, vocoder, model_args = load_model_vocoder(model_pt, device=device)
    log(f"   {time.time() - t0:.1f}s  采样率={model_args.data.sampling_rate} "
        f"n_spk={model_args.model.n_spk} 编码器={model_args.data.encoder}")
    if torch.cuda.is_available():
        log(f"   显存 {torch.cuda.memory_allocated() / 1e9:.2f} GB")

    infer_step = args.infer_step or int(model_args.infer.infer_step)
    t_start = args.t_start if args.t_start >= 0 else float(model_args.model.t_start)
    method = args.method or model_args.infer.method

    # 说话人混合：'1:0.7,5:0.3' → {1: 0.7, 5: 0.3}
    spk_mix = None
    if args.spk_mix:
        spk_mix = {}
        for part in args.spk_mix.split(","):
            k, v = part.split(":")
            spk_mix[int(k)] = float(v)
        log(f"   说话人混合 {spk_mix}（和={sum(spk_mix.values()):.2f}）")

    log(f"   推理参数 step={infer_step} t_start={t_start} method={method} "
        f"spk_id={args.spk_id} pitch={args.pitch} formant={args.formant}")

    log("④ 提取特征（F0 / 音量 / ContentVec）…")
    emit_progress("提取特征", 55)
    hop_size = model_args.data.block_size * sr / model_args.data.sampling_rate
    win_size = model_args.data.volume_smooth_size * sr / model_args.data.sampling_rate

    f0 = F0_Extractor(model_args.data.f0_extractor, sr, hop_size,
                      float(args.f0_min), float(args.f0_max)
                      ).extract(audio, uv_interp=True, device=device, silence_front=0)
    f0 = torch.from_numpy(f0).float().to(device).unsqueeze(-1).unsqueeze(0)
    f0 = f0 * 2 ** (float(args.pitch) / 12)
    log(f"   F0：{f0.shape[1]} 帧，有声 {int((f0 > 0).sum())} 帧")

    volume_extractor = Volume_Extractor(hop_size, win_size)
    volume = volume_extractor.extract(audio)
    mask = (volume > 10 ** (float(args.threshold) / 20)).astype("float")
    mask = torch.from_numpy(mask).float().to(device).unsqueeze(-1).unsqueeze(0)
    mask = upsample(mask, model_args.data.block_size).squeeze(-1)
    volume = torch.from_numpy(volume).float().to(device).unsqueeze(-1).unsqueeze(0)

    units_encoder = Units_Encoder(
        model_args.data.encoder,
        model_args.data.encoder_ckpt,
        model_args.data.encoder_sample_rate,
        model_args.data.encoder_hop_size,
        device=device)
    audio_t = torch.from_numpy(audio).float().unsqueeze(0).to(device)
    units = units_encoder.encode(audio_t, sr, hop_size)
    log(f"   units：{tuple(units.shape)}")

    log("⑤ 转换…")
    emit_progress("转换中", 68)
    t0 = time.time()
    if args.seed:
        # 噪声激励（ddsp/vocoder.py:393 的 torch.randn_like）没种子时每次结果都不同。
        # 固定种子不改变质量，只是让同一首歌可复现。
        torch.manual_seed(args.seed)
        torch.cuda.manual_seed_all(args.seed)
        log(f"   随机种子 = {args.seed}")
    torch.cuda.reset_peak_memory_stats() if torch.cuda.is_available() else None
    with torch.no_grad():
        output = model(
            units, f0, volume,
            spk_id=torch.LongTensor(np.array([[args.spk_id]])).to(device),
            spk_mix_dict=spk_mix,
            # aug_shift 送进 aug_shift_embed(aug_shift / 5)：这是**共振峰**旋钮，
            # 只改音色（嗓音粗细/年龄感），不动音高。改音高要用 --pitch。
            aug_shift=torch.from_numpy(np.array([[float(args.formant)]])).float().to(device),
            vocoder=vocoder,
            infer=True,
            return_wav=True,
            infer_step=infer_step,
            method=method,
            t_start=t_start,
            silence_front=0,
            use_tqdm=False)
        output = output * mask[:, -output.shape[-1]:]
    out = output.squeeze().float().cpu().numpy()
    log(f"   转换完成 {time.time() - t0:.1f}s → {len(out) / sr:.1f}s")
    if torch.cuda.is_available():
        log(f"   显存峰值 {torch.cuda.max_memory_allocated() / 1e9:.2f} GB")

    converted = os.path.join(outdir, "vocal_converted.wav")
    sf.write(converted, out, sr)

    # ---------------------------------------------------------------- ③ 混音
    log("⑥ 混音…")
    emit_progress("混音", 90)
    mixed = os.path.join(outdir, "mixed.wav")
    filt = (
        f"[0:a]volume={args.vocal_gain}dB[v];"
        f"[1:a]volume={args.inst_gain}dB[i];"
        f"[v][i]amix=inputs=2:duration=shortest:normalize=0[m];"
        f"[m]loudnorm=I={args.loudness}:TP=-1.5:LRA=11,alimiter=limit=0.97[out]"
    )
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", converted, "-i", accomp,
         "-filter_complex", filt, "-map", "[out]",
         "-c:a", "pcm_s16le", "-ar", "44100", mixed],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        log("   ⚠️ 混音失败：" + "\n".join((p.stderr or "").strip().splitlines()[-5:]))
    else:
        log(f"   → {mixed}")

    log(f"✅ 完成，总耗时 {time.time() - t_all:.1f}s")
    log("")
    log("产物说明（全部在 " + outdir + "）：")
    log(f"  ① vocal_raw.wav        分离出来的原唱人声   ← 转换的「输入」")
    log(f"  ② vocal_converted.wav  转换后的人声         ← 这一版是 DDSP-SVC 的音色")
    log(f"  ③ accompaniment.wav    分离出来的伴奏")
    log(f"  ④ mixed.wav            ★ 成品 = ②+③ 混音并做响度归一化（你要听的是这个）")

    emit_progress("完成", 100)
    emit_result(
        ok=p.returncode == 0,
        engine="ddsp",
        voice=args.voice,
        song=os.path.basename(song),
        outDir=outdir,
        # 桌宠播放的是 mixed（成品）；mouth 用 vocal_converted（纯人声），
        # 这样口型跟的是人声包络而不是「人声+伴奏」，不会被鼓点带着乱动。
        mixed=mixed,
        mouth=converted,
        vocalRaw=vocal,
        accompaniment=accomp,
        sampleRate=sr,
        duration=round(len(out) / sr, 2),
        seconds=round(time.time() - t_all, 1),
    )


if __name__ == "__main__":
    main()
