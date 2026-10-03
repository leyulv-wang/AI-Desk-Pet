#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
音色转换诊断器 —— 三个数字，用来**给参数变体排序**，不是用来打一个总分。

设计原则（重要）：

  **相对排序 > 绝对分数。** 我们不需要知道"音质 83 分"，只需要知道
  `--formant=-2` 和 `--formant=+2` 哪个更像芙宁娜、哪个杂音更少。
  所以每个指标都设计成**可比较**的，而不是绝对的。

三个核心指标：

  ① 音色相似度  —— ECAPA-TDNN 的 cosine。
       同时给出 sim_src（**原始人声**与参考集）作为基线，
       关键看的是 **sim_gain = sim_conv - sim_src**：
       转换到底有没有把音色往目标方向推、推了多少。
       只看绝对值会被参考音频的领域差异污染（参考是游戏对白，输出是歌声）。

  ② 音高保持  —— 与原唱 F0 的对比，单位用**音分（cent）**而非 Hz，
       因为音高误差在感知上是对数的。
       给出 cents_rmse / GPE（粗错率，|误差|>50 音分）/ 相关系数。

  ③ 伪影程度  —— HNR（Praat 的谐噪比，越高越干净）、
       2kHz 以上能量占比、频谱平坦度（越高越"白"=噪声型失真）。

外加一个诊断项：

  ④ 共振峰偏移  —— 转换后 F1/F2/F3 相对原唱的比值。
       这是 `--formant` 旋钮的**直接读数**，用来确认参数真的起作用了。

用法：
    # 单个文件
    python tools/evaluate.py --converted a.wav --source original.wav

    # 整个扫描目录（这才是主要用法：给一批变体排序）
    python tools/evaluate.py --dir out/tune/timbre --source original.wav --rank
"""
import argparse
import glob
import json
import os
import sys
import warnings

import numpy as np

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
SING = os.path.dirname(HERE)
PROJ = os.path.dirname(SING)
DEFAULT_REF = os.path.join(PROJ, "assets", "voice", "clips")
EMB_DIR = r"D:\models\speaker-embedding\ecapa"
CACHE = os.path.join(SING, ".cache", "ref-embeddings.npz")

SR_EMB = 16000      # ECAPA 要求 16k
TARGET_SR = 44100


# --------------------------------------------------------------------------- 音频
def load(path, sr):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y.astype(np.float32)


# --------------------------------------------------------------------------- ① 音色
_ecapa = None


def get_ecapa():
    """加载 ECAPA-TDNN（约 85MB）。

    **为什么从本地目录加载，而不是 source="speechbrain/spkrec-ecapa-voxceleb"：**
      ① speechbrain 会在 savedir 里创建**符号链接**，Windows 默认没有 SE_CREATE_SYMBOLIC_LINK
         特权，直接报 `OSError [WinError 1314] 客户端没有所需的特权`；
      ② 实测它的 HF 下载在本机只拿到一个 0 字节的 hyperparams.yaml，blobs 是空的。
    所以权重用 curl 走代理预先下到 EMB_DIR（见 tools/README 或本文件顶部说明），
    这里直接从本地目录读，全程不联网。
    """
    global _ecapa
    if _ecapa is not None:
        return _ecapa

    import torch
    try:
        from speechbrain.inference.speaker import EncoderClassifier   # speechbrain >= 1.0
    except Exception:
        from speechbrain.pretrained import EncoderClassifier          # 旧版

    # ⚠️ label_encoder 的**期望文件名是 label_encoder.ckpt**，而 HF 仓库里只提供
    #    label_encoder.txt（正常流程是 speechbrain 下载后自己重命名）。少了这个副本，
    #    speechbrain 会绕过已存在的本地文件去联网下载，离线环境下直接报错。
    need = ["hyperparams.yaml", "embedding_model.ckpt", "classifier.ckpt",
            "mean_var_norm_emb.ckpt", "label_encoder.ckpt"]
    missing = [f for f in need
               if not os.path.exists(os.path.join(EMB_DIR, f))
               or os.path.getsize(os.path.join(EMB_DIR, f)) == 0]
    if missing:
        raise SystemExit(
            f"ECAPA 权重不全，缺：{missing}\n"
            f"目录：{EMB_DIR}\n"
            "下载（需要代理）：\n"
            "  $b='https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/main'\n"
            "  foreach($f in @('hyperparams.yaml','embedding_model.ckpt','classifier.ckpt',"
            "'mean_var_norm_emb.ckpt','label_encoder.txt')){\n"
            f"    curl.exe -L --proxy http://127.0.0.1:7890 -o \"{EMB_DIR}\\$f\" \"$b/$f\" }}\n"
            f"  Copy-Item \"{EMB_DIR}\\label_encoder.txt\" \"{EMB_DIR}\\label_encoder.ckpt\" -Force")

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    # 注意要用 "cuda:0" 而不是 "cuda"：speechbrain 解析设备串时会报
    # "Could not parse CUDA device string 'cuda'"，然后自己回退。
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    _ecapa = EncoderClassifier.from_hparams(
        source=EMB_DIR,
        savedir=EMB_DIR,
        run_opts={"device": device})
    return _ecapa


def embed_seg(y):
    """一段 raw 波形 → 192 维说话人向量（L2 归一化）。

    和 embed() 的区别是**直接吃数组而不是文件路径** ——
    逐窗音色稳定性分析（tools/timbre_stability.py）需要把音频切成一堆
    小段分别算向量，走文件路径会写几百个临时文件。
    """
    import torch
    y = np.asarray(y, dtype=np.float32).reshape(-1)
    if len(y) < 400:
        y = np.pad(y, (0, 400 - len(y)))
    clf = get_ecapa()
    with torch.no_grad():
        e = clf.encode_batch(torch.from_numpy(y).unsqueeze(0)).squeeze().cpu().numpy()
    n = np.linalg.norm(e)
    return e / (n + 1e-9)


def embed(path):
    """一条音频 → 192 维说话人向量（L2 归一化）"""
    return embed_seg(load(path, SR_EMB))


def ref_embedding(ref_dir):
    """参考集 → 平均说话人向量。缓存起来，避免每次都算 40 个文件。"""
    files = sorted(glob.glob(os.path.join(ref_dir, "*.wav")))
    if not files:
        raise SystemExit(f"参考音频目录里没有 wav：{ref_dir}")

    stamp = "%s|%d|%.0f" % (ref_dir, len(files),
                            sum(os.path.getmtime(f) for f in files))
    if os.path.exists(CACHE):
        try:
            z = np.load(CACHE, allow_pickle=True)
            if str(z["stamp"]) == stamp:
                return z["mean"], list(z["files"])
        except Exception:
            pass

    embs = []
    for i, f in enumerate(files, 1):
        embs.append(embed(f))
        if i % 10 == 0:
            print(f"    参考音频 {i}/{len(files)}")
    embs = np.stack(embs)
    mean = embs.mean(0)
    mean = mean / (np.linalg.norm(mean) + 1e-9)

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    np.savez(CACHE, stamp=stamp, mean=mean, files=np.array(files))
    return mean, files


# --------------------------------------------------------------------------- ② 音高
def f0_track(path):
    """用 Praat（parselmouth）提 F0。0 表示清音。"""
    import parselmouth
    y = load(path, TARGET_SR)
    snd = parselmouth.Sound(y, sampling_frequency=TARGET_SR)
    pitch = snd.to_pitch(time_step=0.01, pitch_floor=65, pitch_ceiling=1100)
    return pitch.selected_array["frequency"].astype(np.float64)


def pitch_metrics(src_wav, conv_wav):
    f0s, f0c = f0_track(src_wav), f0_track(conv_wav)
    n = min(len(f0s), len(f0c))
    f0s, f0c = f0s[:n], f0c[:n]

    vs, vc = f0s > 0, f0c > 0
    both = vs & vc
    if both.sum() < 20:
        return dict(cents_rmse=None, gpe=None, corr=None, voiced_frames=int(both.sum()))

    # 音高误差用音分：1200 * log2(conv/src)
    cents = 1200.0 * np.log2(f0c[both] / f0s[both])
    # 去掉极端离群（>1 个八度，基本是跟踪错误而非真实误差）
    keep = np.abs(cents) < 1200
    cents = cents[keep]

    return dict(
        cents_rmse=float(np.sqrt(np.mean(cents ** 2))) if len(cents) else None,
        cents_median=float(np.median(cents)) if len(cents) else None,
        gpe=float(np.mean(np.abs(cents) > 50)) if len(cents) else None,
        corr=float(np.corrcoef(1200 * np.log2(f0s[both]), 1200 * np.log2(f0c[both]))[0, 1]),
        vde=float(np.mean(vs != vc)),
        voiced_frames=int(both.sum()),
    )


# --------------------------------------------------------------------------- ③ 伪影
def artifact_metrics(path):
    import parselmouth
    y = load(path, TARGET_SR)

    # HNR：Praat 的谐噪比，越高越干净
    snd = parselmouth.Sound(y, sampling_frequency=TARGET_SR)
    hnr = snd.to_harmonicity_cc(time_step=0.01, minimum_pitch=65).values
    hnr = hnr[np.isfinite(hnr)]

    # 只统计有声段，否则静音会把指标稀释
    f0 = f0_track(path)
    voiced = f0 > 0
    if voiced.sum() > 10:
        y = y[:len(voiced) * int(TARGET_SR * 0.01)]
        voiced = voiced[:len(y) // int(TARGET_SR * 0.01)]
        if len(y) and voiced.sum() > 10:
            y = y[:len(voiced) * int(TARGET_SR * 0.01)]

    spec = np.abs(np.fft.rfft(y * np.hanning(len(y)))) if len(y) > 32 else np.zeros(2)
    freqs = np.fft.rfftfreq(len(y), 1 / TARGET_SR) if len(y) > 32 else np.zeros(2)
    tot = max(spec.sum(), 1e-9)
    p = (spec ** 2) + 1e-12

    return dict(
        hnr_median=float(np.median(hnr)) if len(hnr) else None,
        hf_ratio=float(spec[freqs > 2000].sum() / tot),
        flatness=float(np.exp(np.mean(np.log(p))) / np.mean(p)),
        peak=float(np.abs(y).max()) if len(y) else 0.0,
        rms=float(np.sqrt(np.mean(y ** 2))) if len(y) else 0.0,
    )


# --------------------------------------------------------------------------- ④ 共振峰
def formants(path):
    """F1/F2/F3 的中位数。用 Burg 法，和 Praat 一致。"""
    import parselmouth
    y = load(path, TARGET_SR)
    snd = parselmouth.Sound(y, sampling_frequency=TARGET_SR)
    fm = snd.to_formant_burg(time_step=0.01, max_number_of_formants=5, maximum_formant=5500)
    times = fm.ts()
    out = {1: [], 2: [], 3: []}
    for t in times:
        for k in (1, 2, 3):
            v = fm.get_value_at_time(k, t)
            if v is not None and np.isfinite(v) and v > 0:
                out[k].append(v)
    return {f"f{k}": (float(np.median(v)) if v else None) for k, v in out.items()}


# --------------------------------------------------------------------------- 主流程
def evaluate(conv_path, src_path, ref_mean, want_formants=True):
    r = {"file": os.path.basename(conv_path)}
    conv = os.path.abspath(conv_path)
    src = os.path.abspath(src_path)

    e_conv = embed(conv)
    e_src = embed(src)
    r["sim_conv"] = float(np.dot(e_conv, ref_mean))
    r["sim_src"] = float(np.dot(e_src, ref_mean))
    r["sim_gain"] = r["sim_conv"] - r["sim_src"]

    r.update({f"pitch_{k}": v for k, v in pitch_metrics(src, conv).items()})
    r.update({f"art_{k}": v for k, v in artifact_metrics(conv).items()})
    r.update({f"art_src_{k}": v for k, v in artifact_metrics(src).items()})

    if want_formants:
        fc, fs = formants(conv), formants(src)
        for k in ("f1", "f2", "f3"):
            r[f"fmt_{k}_conv"] = fc[k]
            r[f"fmt_{k}_src"] = fs[k]
            r[f"fmt_{k}_ratio"] = (fc[k] / fs[k]) if (fc[k] and fs[k]) else None
    return r


def fmt(v, nd=3):
    if v is None:
        return "  —  "
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--converted", help="单个转换后 wav")
    ap.add_argument("--dir", help="目录：批量评估里面所有 wav（主要用法）")
    ap.add_argument("--source", required=True, help="原唱人声 wav（转换的输入）")
    ap.add_argument("--offset", type=float, default=0.0,
                    help="源音频从第几秒开始截（变体是在短片段上生成的，必须对齐同一窗口）")
    ap.add_argument("--seconds", type=float, default=0.0, help="截多长，0=到结尾")
    ap.add_argument("--ref-dir", default=DEFAULT_REF, help="目标音色的参考音频目录")
    ap.add_argument("--out", help="结果 json 路径")
    ap.add_argument("--rank", action="store_true", help="按综合指标排序输出")
    ap.add_argument("--no-formants", action="store_true")
    args = ap.parse_args()

    if not args.converted and not args.dir:
        raise SystemExit("要指定 --converted 或 --dir")

    # 变体是在短片段上生成的，源必须截成同一个窗口，否则音高对比毫无意义
    src_path = os.path.abspath(args.source)
    if args.offset > 0 or args.seconds > 0:
        import soundfile as sf
        y = load(src_path, TARGET_SR)
        a = int(args.offset * TARGET_SR)
        b = int((args.offset + args.seconds) * TARGET_SR) if args.seconds > 0 else len(y)
        tmp = os.path.join(SING, ".cache", "src-window.wav")
        os.makedirs(os.path.dirname(tmp), exist_ok=True)
        sf.write(tmp, y[a:b], TARGET_SR)
        src_path = tmp
        print(f"源窗口 {args.offset}s 起 {args.seconds or '到结尾'}s  "
              f"({(b - a) / TARGET_SR:.1f}s) → {tmp}")

    print(f"原唱   {src_path}")
    print(f"参考集 {args.ref_dir}")
    print("计算参考集说话人嵌入…")
    ref_mean, ref_files = ref_embedding(args.ref_dir)
    print(f"  {len(ref_files)} 条参考音频，均值向量 {ref_mean.shape}")

    targets = []
    if args.converted:
        targets.append(args.converted)
    if args.dir:
        targets += sorted(glob.glob(os.path.join(args.dir, "*.wav")))
    targets = [t for t in targets if os.path.abspath(t) != src_path]
    if not targets:
        raise SystemExit("没找到要评估的 wav")

    print(f"\n评估 {len(targets)} 个文件\n")
    results = []
    for i, t in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] {os.path.basename(t)}")
        results.append(evaluate(t, src_path, ref_mean, not args.no_formants))

    # ------------------------------------------------------------ 排序
    # 综合分：音色增益越大越好、音高误差越小越好、HNR 越高越好、高频占比越低越好
    # 各维度先做 min-max 归一化再等权相加（**只用来看相对次序，不是绝对质量分**）
    def norm(vals, invert=False):
        arr = np.array([v if v is not None else np.nan for v in vals], dtype=float)
        lo, hi = np.nanmin(arr), np.nanmax(arr)
        if not np.isfinite(lo) or hi - lo < 1e-12:
            return np.zeros_like(arr)
        z = (arr - lo) / (hi - lo)
        return 1 - z if invert else z

    if len(results) > 1:
        s = (norm([r["sim_gain"] for r in results])
             + norm([r["pitch_gpe"] for r in results], invert=True)
             + norm([r["art_hnr_median"] for r in results])
             + norm([r["art_hf_ratio"] for r in results], invert=True)) / 4
        for r, v in zip(results, s):
            r["score"] = float(v)
        results.sort(key=lambda x: -x["score"])

    print("\n" + "=" * 108)
    print(f"{'文件':<20}{'音色增益':>9}{'相似(转)':>9}{'相似(原)':>9}"
          f"{'GPE':>7}{'音分RMSE':>9}{'HNR':>7}{'高频':>7}{'F2比':>7}{'综合':>7}")
    print("-" * 108)
    for r in results:
        print(f"{r['file']:<20}{fmt(r['sim_gain']):>9}{fmt(r['sim_conv']):>9}{fmt(r['sim_src']):>9}"
              f"{fmt(r['pitch_gpe'],3):>7}{fmt(r['pitch_cents_rmse'],1):>9}"
              f"{fmt(r['art_hnr_median'],1):>7}{fmt(r['art_hf_ratio']):>7}"
              f"{fmt(r.get('fmt_f2_ratio')):>7}{fmt(r.get('score')):>7}")
    print("=" * 108)
    print("""
读法：
  音色增益 = 转换后与参考集的相似度 − 原唱与参考集的相似度。**越大越说明转换把音色推过去了。**
             只看「相似(转)」的绝对值会被参考音频的领域差异污染（参考是游戏对白，输出是歌声）。
  GPE      = 粗错率，|音高误差| > 50 音分的帧占比。越小越好。
  HNR      = Praat 谐噪比 dB，越高越干净。
  高频     = 2kHz 以上能量占比，电音/沙哑感常常伴随它偏高。
  F2比     = 转换后 F2 / 原唱 F2。这是 --formant 旋钮的直接读数。
  综合     = 四个维度各自 min-max 归一化后等权平均。**只用于排序，不是绝对质量分。**
""")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"结果 → {args.out}")
    elif args.dir:
        p = os.path.join(args.dir, "_eval.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"结果 → {p}")


if __name__ == "__main__":
    main()
