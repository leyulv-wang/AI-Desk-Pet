# 桌宠项目内容与软件化审查

修复状态：六项问题和旧唱歌入口已处理，见 [修复记录](2026-10-11-api-fixes.md)。下面保留修复前的审查证据。

日期：2026-10-11。检查当前代码、配置脱敏摘要、前端入口与离线测试；没有调用收费 API、启动 GPU 推理或修改业务代码。

## 当前实际链路

| 功能 | 实际状态 |
| --- | --- |
| 聊天 | DeepSeek 兼容 chat/completions API，流式回复 |
| 语音 | 当前配置启用 MiniMax、speech-2.8-turbo、自动朗读；其他后端是可选／遗留实现 |
| 记忆 | 本地 JSON 保存，模型抽取与 SiliconFlow embedding 调用 API |
| 角色 | 当前 renderer=static，芙宁娜 PNG；Live2D 代码保留 |
| 桌宠唱歌面板 | 没有 singing 配置时合并默认 enabled=true/engine=ddsp；IPC 接旧本地 Python 管线 |
| 唱歌 API | 有 probe-minimax-music.mjs 与 probe-mimo-singing.mjs 探测脚本，未被唱歌 IPC 调用；用户实际使用的 API 入口还需定位 |

用户确认主要自己使用、慢慢迭代，目标是 API 驱动，并取消 brainstorming 确认流程。此前设计把本地语音／唱歌作为当前依赖，未核对实际配置，已撤回。

## 确认的问题

### 1. [P1] 资源协议允许读取配置和开发数据

src/main.js:101–114 允许 ROOT 下文件，仅对字面上的 .userdata 有额外限制。临时目录复现 pet://app/config.json 和 pet://app/.userdata-dev/facts.json 均返回 200。

影响：尽管 preload 不返回 Key，渲染器仍可同源 fetch 含 Key 的配置。需采用 UI、vendor、公开角色资源、必要音频的白名单路由，不提供配置和私有数据的原始文件访问。复现仅使用虚构文件，没有读取真实凭据。

### 2. [P2] 更换云端音色、模型和语速仍复用旧缓存

src/tts.js:654–674 的非 GPT-SoVITS 分支使用 siliconflow.model/voice 构造缓存身份，没有包含实际 MiniMax／MiMo 请求参数。

模拟 MiniMax 音频后，voice-A/model-A 改成 voice-B/model-B、speed=1.5；同一句第二次 cached=true、文件相同，两次只发出一次 API 请求。MiniMax 的音色、模型、语速、情绪等和 MiMo 的样本、指令等应进入各自缓存身份，后处理参数也应纳入。

### 3. [P2] 语音 API 超时不覆盖响应体读取

src/tts.js:898–907、989–994 在 fetch 返回后清掉 timer，之后才读取 json/text。服务器给出响应头但迟迟不完成响应体时，timeoutMs 不生效。

模拟 json 永不结束，timeoutMs=10；等待 40ms 后 speak 仍未完成。需让完整响应读取也处在超时与取消生命周期内。

另外 src/main.js 的 callOnce/callEmbed 没有 HTTP AbortSignal 超时；查询向量的上层等待超时不等于取消 HTTP。后台整理也存在一直 busy 的风险；这部分为代码分析，未制造真实网络故障。

### 4. [P2] 自动朗读关闭时也关闭了角色表情更新

src/main.js:1468、1493 将情绪识别放在 speech.enabled 内，而该开关包含 autoplay。src/renderer/chat.js:387 靠 tts:emotion 切图。

模拟回复 [开心]今天真开心。，enabled=true/autoplay=false；只有 chat:delta、chat:done、tts:done，没有 tts:emotion。应从文本识别角色状态，再独立决定是否合成语音，保留模型情绪判断。

### 5. [P2] 静态模式仍要求 Live2D 插件存在

src/renderer/pet.js:28–35 先检查 PIXI/PIXI.live2d 并创建 Pixi Application，423 才判断 static。PNG 模式缺 Cubism 插件也会报错，仍创建 WebGL 环境。

该执行顺序由代码确认。应先选渲染模式，再分别加载依赖，使图片桌宠能够独立启动。

### 6. [P2] 改到用户数据目录后音频地址会失效

src/tts.js:558–562 在 cacheDir 位于 ROOT 外时回落 file: URL；页面 connect-src 仅允许同源。src/singing.js:273 使用相对 ROOT 地址，含 .. 时会被 src/main.js:101–106 拒绝。

隔离复现确认外部缓存目录的 TTS url 为 file:。当前源码目录内 .userdata 可用，不代表改成 AppData 后仍能播放。应提供固定同源音频路由，映射到明确允许的缓存目录。

## 产品与测试缺口

- 云端唱歌尚未接入桌宠按钮：src/main.js:1704 调用 singing.start，src/singing.js:124 指向 ddsp_cover.py，361 spawn Python。按用户的 API 目标，应接真实 API 入口，并移除当前界面对安装本地环境的依赖。
- 设置仍通过 src/main.js:1794 打开 config.json，缺图形化设置与校验。
- package.json 无打包目标，配置与数据默认写到源码目录；不能只加一个构建命令。
- UI 测试的唱歌状态是 DDSP mock，不覆盖云端唱歌；静态测试硬编码本机 FurinaStatic 素材，干净检出需准备资源。测试的协议处理器也另有 mock，没有覆盖生产协议的配置访问问题。
- README 和模板仍有较多本地推理描述，需要把当前 API 用法与历史实验分开说明。

## 验证与边界

- npm test：10/10 套通过，逻辑回归 11/11，当前静态模式 UI 10/10。
- 额外离线探针确认：配置／开发数据访问、云端参数变化命中旧缓存、外部缓存 file: 地址、响应体超时失效、关闭朗读无情绪通知。
- 探针在 D:/project/Personal_assistant/.research/audit-2026-10-11.cjs，仅使用虚构凭据、临时目录与模拟响应。
- 未验证真实 API 余额、权限、延迟与生成质量，未构建安装包；没有证据确认用户目前唱歌 API 的具体入口。

## 推荐处理顺序

先收紧协议，修复 MiniMax 缓存、完整超时和表情联动；定位唱歌 API 并接通实际入口；理顺静态启动与用户数据／音频路由；之后做设置与 Windows 打包。保持已有记忆与聊天逻辑，小步迭代。

本次完成审查，尚未修改业务代码或开始打包。
