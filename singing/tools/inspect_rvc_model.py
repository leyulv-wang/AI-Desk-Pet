# -*- coding: utf-8 -*-
"""
RVC / SVC 模型文件的安全检查 + 结构识别。

**为什么要这个**：`.pth` / `.pt` 是 Python pickle 格式。`torch.load()` 默认会
**执行文件里的任意代码** —— 从网盘下载别人的模型，等于运行陌生人的程序。

两道防线：

  防线一：**静态扫描**（本脚本的第一步，不加载）
      把 pickle 反汇编，列出所有被引用的模块和可调用对象。
      正常的状态字典**只需要 torch 自己的类**。一旦出现 os / subprocess /
      builtins / eval / exec / socket / ctypes 之类，就是危险信号。

  防线二：**weights_only=True 加载**
      torch >= 1.13 提供的安全模式：只允许反序列化张量和基础类型，
      任何可执行对象都会直接报错。这是**机制上的保证**，不是靠名单猜。

静态扫描可能漏（攻击者可以构造间接引用），但 `weights_only=True` 是硬约束。
两道都过，才可以认为文件是安全的。

用法：
    python tools/inspect_rvc_model.py <模型文件> [...]
"""
import io
import os
import pickletools
import sys
import zipfile

# 正常权重里绝不该出现的模块
DANGEROUS = {
    "os", "posix", "nt", "subprocess", "builtins", "sys", "shutil", "socket",
    "urllib", "urllib2", "requests", "http", "httplib", "ftplib", "telnetlib",
    "importlib", "ctypes", "pickle", "cPickle", "runpy", "pty", "commands",
    "platform", "tempfile", "glob", "pathlib", "webbrowser", "multiprocessing",
    "signal", "atexit", "code", "codeop", "compileall", "exec", "eval",
}
# 正常出现是合理的（torch 自己的序列化机制）
ALLOWED_PREFIX = ("torch", "collections", "numpy", "typing", "builtins.slice",
                  "builtins.set", "builtins.frozenset", "copy_reg", "_codecs")


def pickle_bytes(path):
    """取出 pickle 字节流。新版 torch 用 zip 包着 archive/data.pkl，老版直接就是 pickle。"""
    with open(path, "rb") as f:
        head = f.read(4)
    if head[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.endswith("data.pkl")]
            if not names:
                return None, f"zip 里没有 data.pkl（条目：{z.namelist()[:8]}）"
            return z.read(names[0]), "zip(data.pkl)"
    return open(path, "rb").read(), "raw pickle"


def scan_pickle(data):
    """反汇编 pickle，收集 GLOBAL / STACK_GLOBAL 引用和 REDUCE 调用"""
    globals_found = []
    opcount = {}
    stack = []
    try:
        for op, arg, _pos in pickletools.genops(io.BytesIO(data)):
            opcount[op.name] = opcount.get(op.name, 0) + 1
            if op.name == "GLOBAL":
                globals_found.append(arg)
            elif op.name in ("SHORT_BINUNICODE", "BINUNICODE", "UNICODE", "BINUNICODE8"):
                stack.append(arg)
            elif op.name == "STACK_GLOBAL":
                if len(stack) >= 2:
                    globals_found.append(f"{stack[-2]} {stack[-1]}")
                stack = stack[:-2] if len(stack) >= 2 else []
    except Exception as e:
        return globals_found, opcount, f"反汇编中断：{type(e).__name__}: {e}"
    return globals_found, opcount, None


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)

    for path in sys.argv[1:]:
        print("=" * 78)
        print(f"文件  {os.path.abspath(path)}")
        if not os.path.exists(path):
            print("  ❌ 不存在")
            continue
        print(f"大小  {os.path.getsize(path) / 1e6:.2f} MB")

        data, how = pickle_bytes(path)
        if data is None:
            print(f"  ⚠️ 无法取到 pickle：{how}")
            print("     （如果这是 faiss .index 或 .npy，那是二进制格式，不是 pickle，正常）")
            continue
        print(f"格式  {how}，pickle 长度 {len(data)} B")

        globals_found, opcount, err = scan_pickle(data)
        if err:
            print(f"  ⚠️ {err}")

        print(f"\n  ── 防线一：静态扫描 ──")
        uniq = []
        for g in globals_found:
            g = str(g)
            if g not in uniq:
                uniq.append(g)
        print(f"  引用到的模块/对象共 {len(uniq)} 个")

        bad = []
        for g in uniq:
            mod = g.split(" ")[0] if " " in g else g.split(".")[0]
            if any(mod == d or mod.startswith(d + ".") for d in DANGEROUS):
                bad.append(g)
        if bad:
            print(f"  🚨 **发现可疑引用 {len(bad)} 个**：")
            for g in bad:
                print(f"       {g}")
            print("     → 这个文件会执行代码，**不要加载**")
        else:
            print("  ✅ 没有危险模块引用")
            show = [g for g in uniq if not any(g.startswith(p) for p in ALLOWED_PREFIX)]
            if show:
                print(f"  非 torch/标准库的引用（{len(show)} 个，看一下是否都认识）：")
                for g in show[:25]:
                    print(f"       {g}")
            else:
                print("  所有引用都是 torch / 标准库 —— 正常")

        print(f"\n  出现最多的操作码: " +
              ", ".join(f"{k}×{v}" for k, v in
                        sorted(opcount.items(), key=lambda x: -x[1])[:6]))

        # ── 防线二：weights_only 加载 ──
        print(f"\n  ── 防线二：torch.load(weights_only=True) ──")
        try:
            import torch
            ck = torch.load(path, map_location="cpu", weights_only=True)
            print("  ✅ 通过（只含张量/基础类型，没有可执行对象）")
            if isinstance(ck, dict):
                print(f"  顶层键: {list(ck.keys())}")
                # 把所有非张量字段全部打印出来 —— RVC 会把训练信息写在这里
                print("  ── 元数据（非张量字段）──")
                for k, v in ck.items():
                    if hasattr(v, "shape"):
                        continue
                    s = str(v)
                    if len(s) > 400:
                        s = s[:400] + f" …(共 {len(s)} 字符)"
                    print(f"    {k} = {s}")
                for k in ("weight", "model"):
                    if k in ck and isinstance(ck[k], dict):
                        sd = ck[k]
                        n = sum(v.numel() for v in sd.values() if hasattr(v, "numel"))
                        print(f"    {k}: {len(sd)} 个张量, 总参数 {n / 1e6:.2f} M")
                        print(f"    前 6 个键: {list(sd.keys())[:6]}")
                        if "model.emb_g.weight" in sd:
                            print(f"    ★ RVC 特征键 model.emb_g.weight {tuple(sd['model.emb_g.weight'].shape)}")
        except Exception as e:
            print(f"  ❌ 失败：{type(e).__name__}: {str(e)[:300]}")
            print("     → 文件里含 weights_only 不允许的对象。**先别加载**，需要人工审查。")
        print()


if __name__ == "__main__":
    main()
