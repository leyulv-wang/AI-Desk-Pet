# -*- coding: utf-8 -*-
"""
检查 RVC 的 faiss 检索索引（`.index`）。

这个文件就是 RVC 里「R」的载体 —— 它存着目标人物特征的聚类中心，
推理时按相似度检索出**真实存在的**特征向量，而不是全靠模型生成。
所以它的大小和质量直接决定"像不像"。

索引是 faiss 二进制格式（不是 pickle），不需要安全审查 —— 但**要用 faiss 读它**。

用法：python tools/probe_rvc_index.py <index 文件>
"""
import os
import sys

import faiss
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\models\RVC\funingna\added_funingna_v2.index"
print(f"文件  {os.path.abspath(path)}")
print(f"大小  {os.path.getsize(path) / 1e6:.2f} MB")

idx = faiss.read_index(path)
print(f"\n索引类型   {type(idx).__name__}")
print(f"向量维度   {idx.d}")
print(f"向量总数   {idx.ntotal:,}")
print(f"是否训练过 {idx.is_trained}")

if hasattr(idx, "nlist"):
    print(f"聚类数     {idx.nlist}")

# 抽查几个向量，确认是有效的归一化特征（RVC 训练时会 L2 归一化）
# 注意：IndexIVFFlat 默认没有 direct map，reconstruct(id) 会报
# "direct map not initialized" —— 这不是索引损坏，只是不能按 id 反查。
print(f"\n抽查向量（用 search 反查代替 reconstruct）：")
try:
    probe = np.zeros((1, idx.d), dtype="float32")
    probe[0, 0] = 1.0
    D, I = idx.search(probe, 5)
    print(f"  查询结果的距离: {[round(float(x), 3) for x in D[0]]}")
    print(f"  命中的向量 id: {[int(x) for x in I[0]]}")
    print("  （能正常返回结果 = 索引可用）")
except Exception as e:
    print(f"  search 失败：{type(e).__name__}: {e}")

try:
    v = idx.reconstruct(int(I[0][0]))
    print(f"  命中向量 norm={np.linalg.norm(v):.4f}  mean={v.mean():+.4f}  std={v.std():.4f}")
    if abs(np.linalg.norm(v) - 1.0) < 0.01:
        print("  ✅ 已 L2 归一化 —— 符合 RVC 特征的处理方式")
except Exception:
    print("  （该索引不支持按 id reconstruct，跳过向量统计）")

# RVC v2 的 hubert 特征是 768 维；如果是 256 维说明是 v1 的 hubertsoft
print()
if idx.d == 768:
    print("✅ 768 维 → 对应 hubert_base / contentvec（RVC v2 标准）")
elif idx.d == 256:
    print("⚠️ 256 维 → 对应 hubertsoft（RVC v1 时代），和 v2 的 pth 不匹配")
else:
    print(f"⚠️ {idx.d} 维 → 不常见，需要确认对应的特征编码器")

# 估算训练特征量：每 3 秒一段、hop 320 @16kHz → 大约每段特征帧数
print(f"\n参考：RVC 每个 3 秒切片约产生 ~150 个特征帧，")
print(f"      所以 {idx.ntotal:,} 个向量大致对应 ~{idx.ntotal / 150 * 3 / 60:.0f} 分钟素材的一部分")
