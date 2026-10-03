# -*- coding: utf-8 -*-
"""
扫描 spk_id：同一个模型、同一段人声，只换说话人编号，看出来的音色到底有没有区别。

要回答的问题：这个模型 `spk_embed` 有 97 行，但 config 里 `spks` 只有「芙宁娜」一个。
**另外 96 行是训练过的真人音色，还是没用的残留/随机值？**

看权重矩阵证明不了 —— 训练过的表和随机初始化的表，都是「范数相近、互相近似正交」。
唯一办法是跑出来听。

效率考虑：模型只加载一次、源特征只提取一次，然后循环换 spk_id 推理。
比反复启动进程快得多。

    python tools/probe_spk_ids.py --vocal <人声.wav> --ids 1,2,3,4,5 --seconds 20
"""
import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SING = os.path.dirname(HERE)
REPO = os.path.join(SING, "repos", "DDSP-SVC")
VOICES = r"D:\models\DDSP-SVC\voices"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True, help="源人声（分离后的）")
    ap.add_argument("--voice", default="芙宁娜")
    ap.add_argument("--ids", default="1,2,3,4,5", help="要试的 spk_id，逗号分隔")
    ap.add_argument("--seconds", type=float, default=20, help="只取前 N 秒，跑得快")
    ap.add_argument("--offset", type=float, default=20, help="从第几秒开始取（避开前奏）")
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()

    # ⚠️ 必须在 chdir 之前把路径转成绝对路径。
    # 下面 os.chdir(REPO) 是为了让 DDSP-SVC 里硬编码的 'pretrain/...' 相对路径生效，
    # 但那之后所有相对路径都会以仓库为基准 —— 传进来的相对路径就找不到了。
    vocal_path = os.path.abspath(args.vocal)
    outdir = os.path.abspath(args.outdir) if args.outdir else os.path.join(SING, "out", "spk-sweep")

    os.chdir(REPO)
    sys.path.insert(0, REPO)

    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from ddsp.vocoder import F0_Extractor, Units_Encoder, Volume_Extractor, upsample
    from reflow.vocoder import load_model_vocoder

    ids = [int(x) for x in args.ids.split(",") if x.strip()]
    os.makedirs(outdir, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model_pt = os.path.join(VOICES, args.voice, "model.pt")
    print(f"设备={device}  模型={model_pt}")
    print(f"源人声={vocal_path}  取 {args.offset}s 起 {args.seconds}s")
    print(f"要试的 spk_id = {ids}\n")

    # ---- 读一段短音频 ----
    audio, sr = librosa.load(vocal_path, sr=None, mono=True)
    a, b = int(args.offset * sr), int((args.offset + args.seconds) * sr)
    audio = audio[a:b]
    print(f"片段 {len(audio) / sr:.1f}s @ {sr}Hz")

    # ---- 模型 + 特征只做一次 ----
    t0 = time.time()
    model, vocoder, margs = load_model_vocoder(model_pt, device=device)
    print(f"模型加载 {time.time() - t0:.1f}s（n_spk={margs.model.n_spk}）")

    hop_size = margs.data.block_size * sr / margs.data.sampling_rate
    win_size = margs.data.volume_smooth_size * sr / margs.data.sampling_rate

    t0 = time.time()
    f0 = F0_Extractor(margs.data.f0_extractor, sr, hop_size, 65.0, 800.0
                      ).extract(audio, uv_interp=True, device=device, silence_front=0)
    f0 = torch.from_numpy(f0).float().to(device).unsqueeze(-1).unsqueeze(0)

    vol_ex = Volume_Extractor(hop_size, win_size)
    volume = vol_ex.extract(audio)
    mask = (volume > 10 ** (-45 / 20)).astype("float")
    mask = torch.from_numpy(mask).float().to(device).unsqueeze(-1).unsqueeze(0)
    mask = upsample(mask, margs.data.block_size).squeeze(-1)
    volume = torch.from_numpy(volume).float().to(device).unsqueeze(-1).unsqueeze(0)

    enc = Units_Encoder(margs.data.encoder, margs.data.encoder_ckpt,
                        margs.data.encoder_sample_rate, margs.data.encoder_hop_size, device=device)
    units = enc.encode(torch.from_numpy(audio).float().unsqueeze(0).to(device), sr, hop_size)
    print(f"特征提取 {time.time() - t0:.1f}s  units={tuple(units.shape)}\n")

    # ---- 逐个 spk_id 推理 ----
    rows = []
    for sid in ids:
        if sid < 1 or sid > margs.model.n_spk:
            print(f"spk_id={sid} 超出范围（1~{margs.model.n_spk}），跳过")
            continue
        t0 = time.time()
        with torch.no_grad():
            out = model(units, f0, volume,
                        spk_id=torch.LongTensor([[sid]]).to(device),
                        spk_mix_dict=None,
                        aug_shift=torch.from_numpy(np.array([[0.0]])).float().to(device),
                        vocoder=vocoder, infer=True, return_wav=True,
                        infer_step=int(margs.infer.infer_step),
                        method=margs.infer.method,
                        t_start=float(margs.model.t_start),
                        silence_front=0, use_tqdm=False)
            out = out * mask[:, -out.shape[-1]:]
        wav = out.squeeze().float().cpu().numpy()

        path = os.path.join(outdir, f"spk_{sid:02d}.wav")
        sf.write(path, wav, sr)

        # 简单统计：如果那一行是没训过的，出来的东西往往能量/音高都不正常
        import numpy as np
        rms = float(np.sqrt(np.mean(wav ** 2)))
        peak = float(np.abs(wav).max())
        rows.append((sid, path, rms, peak, time.time() - t0))
        print(f"  spk_id={sid:2d}  →  spk_{sid:02d}.wav   "
              f"RMS={rms:.4f} 峰值={peak:.3f}  用时={time.time() - t0:.1f}s")

    print("\n" + "=" * 66)
    print(f"{'spk_id':>7} {'RMS':>9} {'峰值':>8}   相对 spk_1 的能量比")
    base = rows[0][2] if rows else 1
    for sid, _p, rms, peak, _t in rows:
        print(f"{sid:>7} {rms:>9.4f} {peak:>8.3f}   {rms / base:>6.2f}×")
    print(f"\n音频都在：{outdir}")
    print("请直接听 —— 如果 2~5 是训练过的音色，它们会是几个明显不同的嗓子；")
    print("如果是残留/随机值，通常会听到走调、沙哑、气声异常或根本不像人声的东西。")


if __name__ == "__main__":
    main()
