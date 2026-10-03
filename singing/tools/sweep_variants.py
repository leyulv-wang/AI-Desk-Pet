# -*- coding: utf-8 -*-
"""
变体扫描：同一段人声，一次加载模型/特征，批量生成多组参数对照。

要区分的两个症状，旋钮不重叠：

  **音色不够像** → `formant`（共振峰）。模型内部 aug_shift_embed(aug_shift/5)，
                   只改音色不改音高，是调"像不像"最直接的旋钮。
  **杂音/电音感** → 三个来源，分开测：
                   ① ODE 精度：infer_step / method（步数越多、euler→rk4 越干净）
                   ② **随机噪声激励**：`ddsp/vocoder.py:393` 是 torch.randn_like，
                      没有种子 → 每次纹理都不同 → 可以固种子挑好的
                   ③ 源的质量：128kbps 的 mp3 + 分离残留（换 demucs 模型 / 换源）

分离质量改变的是**输入**，所以在另一个脚本/命令里换源后重跑本脚本对比。

效率：模型和源特征只提取一次（formant/step/seed 都不影响特征），
每多一个变体只要约 1.5 秒。

    python tools/sweep_variants.py --vocal <人声.wav> --preset timbre
"""
import argparse
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SING = os.path.dirname(HERE)
REPO = os.path.join(SING, "repos", "DDSP-SVC")
VOICES = r"D:\models\DDSP-SVC\voices"

# 每组： (标签, 中文说明, 覆盖参数)
PRESETS = {
    # —— 音色 ——
    "timbre": [
        ("a0-base",  "共振峰 0（基准）",      {}),
        ("a1-fm2",   "共振峰 -2（更粗/更沉）", {"formant": -2.0}),
        ("a2-fm1",   "共振峰 -1",            {"formant": -1.0}),
        ("a3-fp1",   "共振峰 +1",            {"formant": +1.0}),
        ("a4-fp2",   "共振峰 +2（更细/更亮）", {"formant": +2.0}),
        ("a5-fp4",   "共振峰 +4（极限试探）",  {"formant": +4.0}),
    ],
    # —— 音质：ODE 精度 ——
    "quality": [
        ("a0-base",    "step=50 euler（基准）", {}),
        ("b1-step100", "step=100",              {"step": 100}),
        ("b2-step200", "step=200",              {"step": 200}),
        ("b3-step400", "step=400",              {"step": 400}),
        ("c1-rk4-50",  "rk4 step=50",           {"method": "rk4"}),
        ("c2-rk4-100", "rk4 step=100",          {"method": "rk4", "step": 100}),
    ],
    # —— 音质：随机种子（同一配置跑两遍，用来证明非确定性）——
    "seed": [
        ("s0-unseeded", "不设种子（第 1 次）", {}),
        ("s0b-unseeded", "不设种子（第 2 次，用来对比）", {}),
        ("s1-seed1",   "种子 1",  {"seed": 1}),
        ("s2-seed2",   "种子 2",  {"seed": 2}),
        ("s3-seed3",   "种子 3",  {"seed": 3}),
        ("s4-seed7",   "种子 7",  {"seed": 7}),
        ("s5-seed42",  "种子 42", {"seed": 42}),
    ],
    # —— 组合拳（音色 + 音质一起上）——
    "combo": [
        ("z0-base",      "基准",                      {}),
        ("z1-fm1",       "共振峰 -1",                 {"formant": -1.0}),
        ("z2-fm1-s200",  "共振峰 -1 + step 200",      {"formant": -1.0, "step": 200}),
        ("z3-fm1-rk4",   "共振峰 -1 + rk4",           {"formant": -1.0, "method": "rk4"}),
        ("z4-all",       "共振峰 -1 + step200 + rk4", {"formant": -1.0, "step": 200, "method": "rk4"}),
    ],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--voice", default="芙宁娜")
    ap.add_argument("--preset", default="timbre", choices=sorted(PRESETS.keys()))
    ap.add_argument("--spk-id", type=int, default=1)
    ap.add_argument("--pitch", type=int, default=0)
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--offset", type=float, default=45)
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--only", default=None, help="只跑这些标签，逗号分隔")
    args = ap.parse_args()

    # ⚠️ chdir 前先转绝对路径（chdir 是为了 DDSP-SVC 里硬编码的 pretrain/ 相对路径）
    vocal_path = os.path.abspath(args.vocal)
    base_out = os.path.abspath(args.outdir) if args.outdir else os.path.join(SING, "out", "tune")
    outdir = os.path.join(base_out, args.preset)

    os.chdir(REPO)
    sys.path.insert(0, REPO)

    import librosa
    import soundfile as sf
    import torch
    from ddsp.vocoder import F0_Extractor, Units_Encoder, Volume_Extractor, upsample
    from reflow.vocoder import load_model_vocoder

    device = "cuda" if torch.cuda.is_available() else "cpu"
    os.makedirs(outdir, exist_ok=True)
    model_pt = os.path.join(VOICES, args.voice, "model.pt")

    variants = PRESETS[args.preset]
    if args.only:
        want = {x.strip() for x in args.only.split(",")}
        variants = [v for v in variants if v[0] in want]

    print(f"设备={device}  preset={args.preset}  源={os.path.basename(vocal_path)}")
    print(f"窗口={args.offset}s 起 {args.seconds}s  spk_id={args.spk_id} pitch={args.pitch}")
    print(f"变体数={len(variants)}\n")

    audio, sr = librosa.load(vocal_path, sr=None, mono=True)
    a, b = int(args.offset * sr), int((args.offset + args.seconds) * sr)
    audio = audio[a:b]
    print(f"片段 {len(audio) / sr:.1f}s @ {sr}Hz")

    t0 = time.time()
    model, vocoder, margs = load_model_vocoder(model_pt, device=device)
    print(f"模型 {time.time() - t0:.1f}s")

    hop_size = margs.data.block_size * sr / margs.data.sampling_rate
    win_size = margs.data.volume_smooth_size * sr / margs.data.sampling_rate
    default_step = int(margs.infer.infer_step)
    default_method = margs.infer.method

    f0 = F0_Extractor(margs.data.f0_extractor, sr, hop_size, 65.0, 800.0
                      ).extract(audio, uv_interp=True, device=device, silence_front=0)
    f0 = torch.from_numpy(f0).float().to(device).unsqueeze(-1).unsqueeze(0)
    f0 = f0 * 2 ** (float(args.pitch) / 12)

    vol_ex = Volume_Extractor(hop_size, win_size)
    volume = vol_ex.extract(audio)
    mask = (volume > 10 ** (-45 / 20)).astype("float")
    mask = torch.from_numpy(mask).float().to(device).unsqueeze(-1).unsqueeze(0)
    mask = upsample(mask, margs.data.block_size).squeeze(-1)
    volume = torch.from_numpy(volume).float().to(device).unsqueeze(-1).unsqueeze(0)

    enc = Units_Encoder(margs.data.encoder, margs.data.encoder_ckpt,
                        margs.data.encoder_sample_rate, margs.data.encoder_hop_size, device=device)
    units = enc.encode(torch.from_numpy(audio).float().unsqueeze(0).to(device), sr, hop_size)
    print(f"特征提取完成  units={tuple(units.shape)}\n")

    index = []
    for label, desc, over in variants:
        formant = float(over.get("formant", 0.0))
        step = int(over.get("step", default_step))
        method = over.get("method", default_method)
        seed = over.get("seed", None)

        t0 = time.time()
        if seed is not None:
            torch.manual_seed(int(seed))
            torch.cuda.manual_seed_all(int(seed))
        with torch.no_grad():
            out = model(units, f0, volume,
                        spk_id=torch.LongTensor([[args.spk_id]]).to(device),
                        spk_mix_dict=None,
                        aug_shift=torch.from_numpy(np.array([[formant]])).float().to(device),
                        vocoder=vocoder, infer=True, return_wav=True,
                        infer_step=step, method=method,
                        t_start=float(margs.model.t_start),
                        silence_front=0, use_tqdm=False)
            out = out * mask[:, -out.shape[-1]:]
        wav = out.squeeze().float().cpu().numpy()
        path = os.path.join(outdir, f"{label}.wav")
        sf.write(path, wav, sr)

        rms = float(np.sqrt(np.mean(wav ** 2)))
        # 2kHz 以上能量占比 —— 电音/沙哑常常伴随异常高频能量
        spec = np.abs(np.fft.rfft(wav * np.hanning(len(wav))))
        freqs = np.fft.rfftfreq(len(wav), 1 / sr)
        hi = float(spec[freqs > 2000].sum() / max(spec.sum(), 1e-9))
        # 频谱平坦度：噪声型失真会让它变高（更"白"）
        p = (spec ** 2) + 1e-12
        flat = float(np.exp(np.mean(np.log(p))) / np.mean(p))
        index.append(dict(label=label, desc=desc, formant=formant, step=step,
                          method=method, seed=seed, rms=round(rms, 4),
                          highfreq=round(hi, 4), flatness=round(flat, 3),
                          file=os.path.basename(path), wav=wav))
        print(f"  {label:15s} fm={formant:+.1f} step={step:3d} {method:5s} "
              f"seed={str(seed):>4s}  RMS={rms:.4f} 高频={hi:.3f} 平坦={flat:.3f}  {time.time() - t0:.1f}s")

    # 非确定性验证：找出配置完全相同的一对，算波形差
    print()
    for i in range(len(index)):
        for j in range(i + 1, len(index)):
            x, y = index[i], index[j]
            if (x["formant"], x["step"], x["method"], x["seed"]) == \
               (y["formant"], y["step"], y["method"], y["seed"]):
                n = min(len(x["wav"]), len(y["wav"]))
                d = float(np.abs(x["wav"][:n] - y["wav"][:n]).max())
                print(f"  ⚠️ {x['label']} vs {y['label']} 配置相同，波形最大差 = {d:.4f}")
                print(f"     {'→ 非确定性已证实（噪声激励每次随机）' if d > 1e-4 else '→ 输出可复现'}")

    for r in index:
        r.pop("wav")
    with open(os.path.join(outdir, "_index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 82)
    print(f"{'文件':<17}{'formant':>8}{'step':>6}{'方法':>7}{'seed':>6}{'RMS':>9}{'高频':>8}{'平坦':>8}")
    for r in index:
        print(f"{r['label']:<17}{r['formant']:>8.1f}{r['step']:>6}{r['method']:>7}"
              f"{str(r['seed']):>6}{r['rms']:>9.4f}{r['highfreq']:>8.3f}{r['flatness']:>8.3f}")
    print(f"\n都在 {outdir}")
    print("高频占比 / 频谱平坦度只是参考指标 —— 是否真的有电音、沙哑，还是要耳朵定。")


if __name__ == "__main__":
    main()
