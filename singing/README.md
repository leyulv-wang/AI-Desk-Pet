# 唱歌（DDSP-SVC 路线）

给桌宠一首歌，用**芙宁娜的音色**唱出来，产物存本地，之后随时点播。

**关键点：不需要训练，也不需要联网推理。** 用的是你已有的那个音色模型
（`<语音包目录>\芙宁娜 - 副本.sf_pkg`，拆出来放进 `D:\models`）。

---

## 一条命令

```bash
cd desktop-pet
npm run sing -- "songs\某首歌.mp3"          # 薄包装，会找对 Python 并透传参数
npm run sing -- "<音乐目录>\某首.mp3" --help  # 看 Python 侧全部参数
```

直接调 Python 也行：

```bash
cd desktop-pet/singing
.venv-ddsp\Scripts\python.exe ddsp_cover.py --song "..\songs\某首歌.mp3" --voice "芙宁娜"
```

实测（RTX 5060 8G）：**181 秒的歌，总耗时 30 秒，转换 10 秒，显存峰值 5.4 GB。**

产物落在歌曲旁边的 `<歌名>_ddsp/`：

| 文件 | 内容 |
|---|---|
| `mixed.wav` | ★ 成品（转换后的人声 + 伴奏，响度归一化到 −14 LUFS） |
| `vocal_converted.wav` | 只转换后的人声（听音色最清楚，**也是桌宠的口型轨**） |
| `vocal_raw.wav` | 分离出来的原始人声（转换的输入） |
| `accompaniment.wav` | 伴奏 |

### 在桌宠里用

**流程：点 🎤 → 选歌的「唱」→ 跑一遍管线（一首歌 30 秒~2 分钟）→ 跑完自动开唱。**

不是边跑边唱，也不是「跑完生成一个文件等你自己点 ▶」——跑完直接唱。
（早期版本只提示「点 ▶ 听」，实际用起来很像没成功，已改成自动播。）

产物落在**用户数据目录**（不是 songs/，避免和你的原曲混在一起）：

```
desktop-pet\.userdata\singing\<12位hash>\mixed.wav      ★ 成品
                                    ...\vocal_converted.wav   口型轨
                                    ...\vocal_raw.wav         分离出的原唱
                                    ...\accompaniment.wav     伴奏
                                    ...\meta.json             缓存标记
```

那串 hash 是「歌曲路径 + 大小 + 修改时间 + 音色参数」算出来的：

- **同一首歌第二次点是毫秒级** —— 命中缓存就不启 Python，直接播
- **换音色参数就是另一份产物**，不会互相覆盖

链路：`渲染层 🎤 面板 → preload → main.js IPC → src/singing.js → ddsp_cover.py`（走 `.venv-ddsp`）

### 排错三板斧

| 命令 | 用途 |
|---|---|
| `npm run sing:setup` | 环境体检：Python / torch / CUDA / 依赖 / 模型 / 权重，缺什么直接说 |
| `npm run test:singing` | 端到端真跑一遍：验 5 个产物 + 验缓存命中 |
| `npm run probe:sing` | **验能不能真播**：用 CDP 驱动运行中的桌宠播一次，读 `played/failed/ctxState` |

第三个是这次踩坑加的：播放链（protocol → fetch → decodeAudioData → Web Audio）全在渲染进程，
主进程日志看不到，出问题表现就是「点了没反应」。现在 `voice.js` 的失败会回调到面板日志，
同时 `npm run probe:sing` 可以无人值守地确认播放真的出了声（要先用 remote debugging 启动桌宠）。

其他要点：

- 唱歌时嘴型跟的是 `vocal_converted.wav` 而不是成品 —— 成品里鼓和贝斯会一起进包络，
  嘴会跟着鼓点乱动，一眼假。这条约束钉在 `petVoice.sing()` 的入参上（必须传 `mouthUrl`）
- 「添加歌曲」是把文件**复制**进 `songs/`，原文件不动

### 按钮语义（这几条都踩过坑，别再改回去）

| 按钮 | 什么时候可用 | 为什么 |
|---|---|---|
| 歌单里的 **▶** | **永远可用** | 播放走渲染层 Web Audio，转换走主进程 Python，**两条独立的路**。转换在跑时禁掉 ▶ 等于白白锁住唯一还能用的功能 |
| 正在播那首的 **■ 停** | 播放时出现 | 用户想停止时最自然的动作就是**再点一次那个按钮**。所以它必须变成「停」，而不是点了没反应 |
| 歌单里的 **唱 / 重唱** | 没有别的任务在跑时 | 一次只跑一个转换（GPU 只有一块）。别的在跑时点了会**说清楚为什么**，不是静默失效 |
| 正在跑那首的 **■ 停止** | 转换时出现 | 同上：想停止就会去点它 |
| 底部动作栏的 **停止** | 转换在跑 **或** 歌在播 | 文案会变：`停止转换` / `停止播放`。**这个按钮曾经只认转换**，所以放歌时它是灰的 —— 用户就以为「没有停止播放的手段」，只好去点 ▶ 试图停止，结果撞上下面那个锁死 bug |
| **🗑** | 不在跑这首时 | 删产物，跑的时候删会出乱子 |

**通用教训**：UI 状态要跟着**真实状态**走，不能跟着「点过一次」走。
这一批 bug（停止键灰着、再点不能停、别的歌点不动）根子是同一个：
按钮可用性是从一个**过期的** `status` 快照算出来的。

### ⚠️ `voice.js` 的 `stop()` 必须 resolve（曾经把播放器永久锁死）

`pump()` 是靠 `await playOne(item)` 串起来的。而 `stop()` 以前的写法是：

```js
current.source.onended = null   // ← 把唯一的 resolve 路径摘掉了
current.source.stop()
```

`onended` 被置空之后再 `stop()`，`playOne()` 的 Promise **永远不会 resolve** →
`pump()` 卡在 `await` 上 → `playing` 永远是 `true` →
之后**每一次** `enqueue()` 都在 `if (playing) return` 被挡掉。

**症状**：点一次「停止」（或者再点一次 ▶ 想停），播放功能**永久废掉**，点哪首歌都没反应。
**修法**：单独存一份 `currentResolve`，`stop()` 里先摘出 `src` 和 `done`、置空 `current`，
停掉 source 之后**显式调用 `done()`** 把 pump 解开。

`npm run probe:sing -- --flow` 里有这一段回归测试（**播 → 停 → 再播**，第三步必须还能出声）。

`npm run probe:sing -- --flow` 会把上面这张表逐条验一遍（真点一次「唱」，
然后在中途检查各按钮的 disabled 状态、掐掉后再检查有没有复位）。

---

## 这条路线是怎么定下来的

原始需求是「根据原音乐音频，生成新音色的音频」。调研（4 个方向并行）的结论：

1. **云端没有可用的方案。** MiniMax Music Cover 对这把 key 返回 `HTTP 410`（新用户关闭），
   且请求体里**没有任何音色参数**；小米 MiMo 的 `(唱歌)` 只是 TTS 拖长音念歌词，没有原曲旋律；
   国内其余平台都不提供托管的 SVC API。
2. **「保留原曲旋律」只有 voice conversion 能做到**，其他都是重新生成。
3. 候选是 **DDSP-SVC / RVC / SoulX-Singer / YingMusic-SVC**。
4. **然后在你的电脑上发现了一个已经训好的芙宁娜 DDSP-SVC 模型** —— 于是前面三条都不用比了。

选 DDSP-SVC 的额外好处：**官方 README 明写支持 `python 3.11 (windows)`**，
而且它是这几个里最轻的（54.97M 参数，8G 卡绰绰有余）。

---

## 为什么最后没用 RVC（重要，别再走一遍）

中途试过 RVC（检索式 VC，网上 AI 翻唱的主流方案）。**结论：这个具体模型不行，已弃用。**

用的是公开渠道能找到的中文芙宁娜 RVC v2 模型（`funingna_150e_2250s.pth` + 185MB faiss 索引）。
它的问题不在管线，在模型本身：

| 它的条件 | 说明 |
|---|---|
| 训练数据 **20.6 分钟** | 偏少（索引里 61,807 帧 ÷ 50fps = 1236s，与作者标注的 `dataset_lenght` 吻合） |
| **150 epochs** | 偏少（RVC 通常 200~400+；对照的日语版是 275 epochs） |
| 训练数据是**游戏对白** | 拿去唱歌是跨域 |
| **40 kHz** | RVC v2 里 40k 是最弱的一档（32k/40k/48k，48k 最好） |
| `author = None` | 来源是网盘 |

**用户盲听结论：「RVC 整体都不对」** —— 电音感、咬字乱、声音抖、不像芙宁娜、跑调、糊、杂音全中。

### 为了确认不是我们的问题，逐项排查过（全部否掉）

| 候选原因 | 验证方式 | 结论 |
|---|---|---|
| 环境版本漂移（transformers 5.18 vs 要求 <4.50） | 建钉版本环境（4.49.0 + librosa 0.10.2 + numpy 1.26.4）对比 | ❌ 换环境差异 0.298 **<** 同环境重跑基线 0.317 |
| 索引用对白建的，拿去处理歌声 | `index_rate` 扫 0 / 0.33 / 0.75 | ❌ 三档都有电音 |
| 分块转换引入接缝 | 分块 vs 未分块 + 边界差异扫描 | ❌ 差异来自 RVC 自身的随机噪声（NSF 声码器） |
| 静音门限切掉辅音 | −45/−60/−75 三档 | ❌ 差异 0.004（噪声底线的 1/75） |
| 分离器损伤辅音 | htdemucs / htdemucs_ft / mdx_extra | ❌ 三者**相关系数 0.998+** |

### 顺带得到的两条通用结论

1. **`vc_single()` 返回的是 `int16`，不是浮点。** 当浮点直接写文件会被 `soundfile`
   按 [−1,1] 期望值**整体截断成方波**（症状：全曲 RMS 恰好 1.0、峰值中位数 1.0）。
   必须先 `/32768`。
2. **RVC 的分块加速非常有效**：211 秒的歌，合成从 **729 秒 → 14.6 秒**（56 倍），
   显存峰值 1.40 GB，指标不降反升。原因是未分块时会触发 **WDDM 显存超额订阅**
   （Windows 不报 OOM，而是把显存页到系统内存，速度暴跌）——
   同一个机制也正是「驱动 TDR + 12.9 GB 内核转储」的成因。

`rvc_cover.py` 保留在仓库里（代码是对的，只是没有好模型），如果以后自己训一个 48kHz
的 RVC 模型可以直接用。

---

## 那个 `.sf_pkg` 到底是什么

`芙宁娜 - 副本.sf_pkg/archive/` 是一个**解压开的 PyTorch zip**（`data.pkl` + `data/0..162`）。
封回去用 `torch.load` 读，结构是：

```python
{
  "model_dict":  { "cascade": { "global_step": 2400, "model": <state_dict> } },
  "config_dict": { "cascade": <完整训练配置> },
  "model_type_index": 4
}
```

`tools/inspect_sfpkg.py` 和 `tools/probe_sfpkg_weights.py` 就是干这个的。挖出来的结论：

- 权重键名 `ddsp_model.unit2ctrl.*` + `reflow_model.velocity_fn.*`
  → 正好等于 DDSP-SVC 的 `Unit2Wav`（`ddsp/vocoder.py`）的两个属性名
- `config_dict.cascade` 和官方 `configs/reflow.yaml` 同构
- `spks = ['芙宁娜']`、`model.type = RectifiedFlow`、44.1kHz、`contentvec768l12tta2x`、`rmvpe`

而 DDSP-SVC 的 `load_model_vocoder(model_path)` 只做两件事：
① 读**同目录**的 `config.yaml` ② `torch.load(model_path)['model']` 当 state_dict。

**所以拆成两个文件就能直接用，权重量化都没动。** 见 `tools/split_sfpkg.py`。

---

## 两个踩过的坑（很重要）

### ① `spk_id` 是 **1-based**（⚠️ 踩错会把显卡驱动搞挂）

`ddsp/unit2control.py:83` 写的是：

```python
x = x + self.spk_embed(spk_id - 1)
```

传 `spk_id=0` 会变成索引 `-1`，直接触发
`CUDA error: device-side assert triggered / srcIndex < srcSelectDimSize`。
**而且堆栈会指向完全无关的一行**（CUDA 错误异步上报），极难查。

→ 单说话人模型（`spks` 只有一个）用 **`spk_id=1`**。这也是 `gui_reflow.py` 里的默认值。

**⚠️ 更严重的后果（真实发生过）**：这个 CUDA assert 不只是报个错 ——
它会让 **NVIDIA 驱动超时（TDR）**，系统日志出现 `nvlddmkm Event 153`，
然后 **Windows 往 `C:\Windows\LiveKernelReports\` 写一个活动内核转储**。

实测：一次失败运行产生了 **`WATCHDOG-20261001-2133.dmp` = 12.9 GB**，
用户 C 盘直接少掉 13 GB，而且完全不知道是谁占的。

排查/清理：

```powershell
# 看有没有
Get-ChildItem C:\Windows\LiveKernelReports -Recurse -File | Sort-Object Length -Descending

# 看当时驱动有没有超时
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddDays(-2)} |
  Where-Object { $_.ProviderName -eq 'nvlddmkm' }

# 删掉（会需要管理员权限）
Remove-Item C:\Windows\LiveKernelReports\WATCHDOG-*.dmp -Force
```

**教训**：在 8G 卡上跑 CUDA 之前，先把「可能触发 device-side assert」的地方
在 CPU 或小片段上验证一遍。一次 assert 的代价可能是 13 GB 磁盘 + 驱动重置。

### ② `pretrain/rmvpe/model.pt` 是硬编码的相对路径

`ddsp/vocoder.py:36`：`F0_KERNEL['rmvpe'] = RMVPE('pretrain/rmvpe/model.pt', ...)`。
所以**必须在 DDSP-SVC 仓库根目录下运行**（`ddsp_cover.py` 里已经 `os.chdir(REPO)` 处理了），
而且 rmvpe 权重必须叫 `model.pt`（不是 `rmvpe.pt`）。

---

## 目录结构

```
desktop-pet/singing/
├── ddsp_cover.py                  ★ 端到端管线（分离 → 转换 → 混音）
├── .venv-ddsp/                    Python 3.11 环境（uv 建的，不入库）
├── repos/DDSP-SVC/                第三方推理代码（不入库）
│   └── pretrain  →  junction  →  D:\models\DDSP-SVC\pretrain
└── tools/
    ├── split_sfpkg.py             .sf_pkg → model.pt + config.yaml
    ├── inspect_sfpkg.py           第一层解剖（结构 + 配置）
    ├── probe_sfpkg_weights.py     第二层解剖（权重键名 + 结构探针）
    └── download-ddsp-pretrain.ps1 下 3 个依赖权重

D:\models\DDSP-SVC/                权重统一放这儿，不在项目里
├── pretrain/
│   ├── contentvec/pytorch_model.bin          360.8 MB
│   ├── nsf_hifigan/{model, config.json}       54.0 MB
│   └── rmvpe/model.pt                        351.4 MB
└── voices/芙宁娜/{model.pt, config.yaml}      209.7 MB
```

**为什么权重放 `D:\models`**：它们是第三方权重、体积大、授权各自不同，
塞进项目目录会让「拷走一个文件夹就能用」这件事变得很重。
代码里用 junction 把 `pretrain/` 指过去，DDSP-SVC 的相对路径照常工作。

---

## 环境怎么建的

```powershell
# 1) 建环境（uv，秒级）
uv venv --python 3.11 .venv-ddsp

# 2) torch 直接用本机已有的 wheel（省 3.4GB 下载）
uv pip install --python .venv-ddsp\Scripts\python.exe "D:\python\torch\torch-2.8.0+cu129-cp311-cp311-win_amd64.whl"
uv pip install --python .venv-ddsp\Scripts\python.exe "torchaudio==2.8.0+cu129" --index-url https://download.pytorch.org/whl/cu129

# 3) 其余依赖
uv pip install --python .venv-ddsp\Scripts\python.exe -r repos\DDSP-SVC\requirements.txt
uv pip install --python .venv-ddsp\Scripts\python.exe demucs   # 人声分离
```

**为什么用 uv 而不是 conda**：uv 建环境 1~2 秒、依赖解析强、能直接吃本地 wheel。
（一开始我用 conda 建过一个 py3.10 环境，选好 DDSP 路线后已经删掉了 —— 那条路用不上。）

**网络**：这台机器直连不通，所有下载必须走代理 `http://127.0.0.1:7890`（FlClash）。

---

## 授权

| 组件 | 授权 |
|---|---|
| DDSP-SVC 代码 | MIT |
| demucs | MIT |
| ContentVec / RMVPE / NSF-HiFiGAN | 各自上游（见 `pretrain/*/NOTICE*.txt`） |
| **芙宁娜的声音** | 🔴 归米哈游。只在本机自用，**不二次配布、不商用** |
| **原曲** | 🔴 词曲 + 录音 + 表演三层权利。成品**不要对外发布** |

---

## 待办

- [ ] 接进桌宠：点「唱这首」→ 跑管线 → 存进曲库 → 点歌播放（口型跟人声轨）
- [ ] 现在 `ddsp/webui` 那套没用到；如果要调 spk_id / pitch / infer_step，命令行参数都留好了
- [ ] 8G 显存下峰值 6.07 GB，如果同时开 Live2D + GPT-SoVITS 会紧张 —— 考虑转换完就退进程
