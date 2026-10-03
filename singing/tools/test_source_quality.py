# -*- coding: utf-8 -*-
"""
受控实验：**管线对「源音频码率」到底敏不敏感？**

这决定了两件事：
  · 如果敏感  → 你去找一份 320kbps/无损 是值得的，而且能预测大概能改善多少
  · 如果不敏感 → 换了也没用，别白费力气

做法是把**同一段人声**中转到不同码率的 mp3 再解码（模拟不同质量的源），
然后跑完全相同的转换流程，看指标怎么变：

    original   直接用分离出来的人声（即你现在的情况：源自 128kbps mp3）
    320k       重新编码到 320k  —— **对照组**，应该和 original 几乎一样
    128k       重新编码到 128k
    64k        重新编码到 64k
    32k        重新编码到 32k   —— 严重劣化，如果管线敏感，这组应该明显变差

注意 320k 那组是**第二代编码**，理论上不可能比 original 更好（有损不可逆），
所以它只能验证「实验本身没有引入额外变量」，不能证明 320k 的源会更好。
真正能给出结论的是 **32k/64k 那两组有没有明显变差**。

用法：
    python tools/test_source_quality.py --vocal 原唱人声.wav --seconds 20 --offset 45
"""
import argparse
import os
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SING = os.path.dirname(HERE)
REPO = os.path.join(SING, "repos", "DDSP-SVC")
VOICES = r"D:\models\DDSP-SVC\voices"

BITRATES = [None, 320, 128, 64, 32]   # None = 直接用原始 wav


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--voice", default="芙宁娜")
    ap.add_argument("--spk-id", type=int, default=1)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--offset", type=float, default=45)
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()

    vocal_path = os.path.abspath(args.vocal)
    outdir = os.path.abspath(args.outdir) if args.outdir else os.path.join(SING, "out", "src-quality")
    os.makedirs(outdir, exist_ok=True)

    os.chdir(REPO)
    sys.path.insert(0, REPO)

    import librosa
    import soundfile as sf
    import torch
    from ddsp.vocoder import F0_Extractor, Units_Encoder, Volume_Extractor, upsample
    from reflow.vocoder import load_model_vocoder

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model_pt = os.path.join(VOICES, args.voice, "model.pt")

    # ---- 取出源窗口，并生成各码率版本 ----
    y, sr = librosa.load(vocal_path, sr=None, mono=True)
    a, b = int(args.offset * sr), int((args.offset + args.seconds) * sr)
    seg = y[a:b]
    print(f"源窗口 {args.offset}s 起 {args.seconds}s  ({len(seg) / sr:.1f}s @ {sr}Hz)")

    variants = {}
    tmp = os.path.join(outdir, "_tmp"); os.makedirs(tmp, exist_ok=True)
    for br in BITRATES:
        label = "original" if br is None else f"{br}k"
        if br is None:
            p = os.path.join(tmp, "original.wav")
            sf.write(p, seg, sr)
        else:
            mid = os.path.join(tmp, f"s{br}.mp3")
            p = os.path.join(tmp, f"s{br}.wav")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-i", os.path.join(tmp, "original.wav"),
                            "-b:a", f"{br}k", mid], check=True)
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-i", mid, "-ar", str(sr), "-ac", "1", p], check=True)
        sz = os.path.getsize(p) if br is None else os.path.getsize(os.path.join(tmp, f"s{br}.mp3"))
        variants[label] = p
        print(f"  {label:>9}  {sz / 1024:7.0f} KB")
    print()

    # ---- 模型和编码器只加载一次 ----
    model, vocoder, margs = load_model_vocoder(model_pt, device=device)
    hop_size = margs.data.block_size * sr / margs.data.sampling_rate
    win_size = margs.data.volume_smooth_size * sr / margs.data.sampling_rate
    enc = Units_Encoder(margs.data.encoder, margs.data.encoder_ckpt,
                        margs.data.encoder_sample_rate, margs.data.encoder_hop_size, device=device)

    def convert(path):
        aud, _ = librosa.load(path, sr=sr, mono=True)
        f0 = F0_Extractor(margs.data.f0_extractor, sr, hop_size, 65.0, 800.0
                          ).extract(aud, uv_interp=True, device=device, silence_front=0)
        f0 = torch.from_numpy(f0).float().to(device).unsqueeze(-1).unsqueeze(0)
        vol = Volume_Extractor(hop_size, win_size).extract(aud)
        m = (vol > 10 ** (-45 / 20)).astype("float")
        m = torch.from_numpy(m).float().to(device).unsqueeze(-1).unsqueeze(0)
        m = upsample(m, margs.data.block_size).squeeze(-1)
        vol = torch.from_numpy(vol).float().to(device).unsqueeze(-1).unsqueeze(0)
        units = enc.encode(torch.from_numpy(aud).float().unsqueeze(0).to(device), sr, hop_size)
        if args.seed:
            torch.manual_seed(args.seed)
            torch.cuda.manual_seed_all(args.seed)
        with torch.no_grad():
            out = model(units, f0, vol,
                        spk_id=torch.LongTensor([[args.spk_id]]).to(device),
                        spk_mix_dict=None,
                        aug_shift=torch.from_numpy(np.array([[0.0]])).float().to(device),
                        vocoder=vocoder, infer=True, return_wav=True,
                        infer_step=int(margs.infer.infer_step), method=margs.infer.method,
                        t_start=float(margs.model.t_start), silence_front=0, use_tqdm=False)
            out = out * m[:, -out.shape[-1]:]
        return out.squeeze().float().cpu().numpy()

    print("转换中（固定种子，只改源码率）…")
    for label, p in variants.items():
        t0 = time.time()
        wav = convert(p)
        sf.write(os.path.join(outdir, f"{label}.wav"), wav, sr)
        print(f"  {label:>9}  {time.time() - t0:.1f}s")

    # 参照源用原始窗口，交给 evaluate.py 打分
    ref = os.path.join(outdir, "_ref.wav")
    sf.write(ref, seg, sr)
    print(f"\n产物 → {outdir}")
    print(f"参照源 → {ref}")
    print("\n下一步用评估器打分：")
    print(f'  python tools/evaluate.py --dir "{outdir}" --source "{ref}" --rank')


if __name__ == "__main__":
    main()
