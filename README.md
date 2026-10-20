# BiliSummary · B站视频总结工具

一个基于 Electron 的桌面应用：粘贴 B 站视频链接，自动获取字幕（没有则自动转写），
调用可切换的大模型，生成**带时间戳的结构化摘要**。

```
一句话总结  →  关键要点  →  章节速览  →  分段摘要（每段带起止时间）  →  关键洞察
```

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **三种摘要来源** | 官方字幕 → 语音识别（ASR）→ B 站官方 AI 总结，按优先级自动回退 |
| **三种模型来源** | OpenAI 兼容接口 / Ollama 本地模型 / B 站官方 AI 总结，随时切换 |
| **结构化输出** | TL;DR、关键要点、章节索引、分段带时间戳的摘要、关键洞察 |
| **分P 支持** | 多 P 视频可选择任意一集单独总结 |
| **弹幕抓取** | 可选抓取弹幕并附在摘要末尾 |
| **导出** | 一键复制 Markdown、保存为 `.md`、导出 `.srt` 字幕 |
| **内置登录** | 应用内弹出 B 站登录窗口，Cookie 存在本地，不经过第三方 |
| **无需后端** | 全部逻辑在本地，配置与密钥只存在你自己的电脑上 |

---

## 快速开始

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（改代码自动重启）
```

打包安装包：

```bash
npm run dist:win     # Windows (nsis 安装包 + 免安装版)
npm run dist:mac     # macOS
npm run dist:linux   # Linux AppImage
```

产物在 `release/` 目录。

---

## 配置

点击右上角 **设置** 打开配置面板。

### 1. 选择摘要模型（三选一）

#### OpenAI 兼容接口（推荐）

任何实现了 `/v1/chat/completions` 的服务都可以用，只要填对 `Base URL`：

| 服务 | Base URL | 模型示例 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Kimi / 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 豆包（火山） | `https://ark.cn-beijing.volces.com/api/v3` | `ep-xxxx` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` |
| LM Studio | `http://127.0.0.1:1234/v1` | 本地模型名 |
| vLLM | `http://127.0.0.1:8000/v1` | 本地模型名 |

面板里的 **测试连接** 会调用 `/models` 校验地址、Key 和模型名。

#### Ollama 本地模型

```bash
ollama pull qwen2.5:7b
```

Base URL 默认 `http://127.0.0.1:11434`，模型名填已拉取的模型。

#### B 站官方 AI 总结

不需要任何 API Key，直接用 B 站为该视频生成的结论。
**限制**：并非所有视频都有，且需要登录。

### 2. 字幕来源与登录

B 站大多数字幕需要登录态才能拿到，所以：

- **设置 → B 站登录 → 打开登录窗口**，在弹出的窗口里扫码登录；
  登录成功后 Cookie 会保存在本地（`%APPDATA%/BiliSummary/config.json`），主窗口右上角会显示用户名。
- 也可以手动粘贴 Cookie（浏览器 F12 → Network → 任意请求 → Request Headers → Cookie），
  至少需要 `SESSDATA`。

如果视频没有字幕，工具会自动走 ASR（见下节）。

### 3. 语音识别（ASR）备选方案

| 方案 | 说明 |
| --- | --- |
| **OpenAI 兼容接口** | 任何实现 `/audio/transcriptions` 且支持 `verbose_json` 的服务：OpenAI、SiliconFlow、Groq、阿里云 DashScope 等。模型填 `whisper-1` / `whisper-large-v3` 等。 |
| **whisper.cpp 本地** | 完全离线。填 `whisper-cli.exe` 路径与 `ggml-*.bin` 模型路径。 |

音频下载与转码由内置的 `ffmpeg-static` 完成，无需单独安装 ffmpeg
（也可以在设置里手动指定 ffmpeg 路径）。

---

## 工作原理

```
视频链接
   │
   ├─→ 解析 BV/av/短链 ─→ 视频信息 + 分P列表
   │
   ├─→ 字幕获取（WBI 签名 + buvid 指纹）
   │      ├─ 官方 CC / AI 字幕   ← 登录后可用，准确率最高
   │      ├─ 下载音频 → ffmpeg 转 16kHz wav → ASR 转写
   │      └─ B 站官方 AI 总结
   │
   ├─→ 按字符预算切块（保留真实时间戳）
   │      └─ 并发调用模型，每块产出结构化分段
   │
   └─→ 合并各块 → TL;DR / 要点 / 章节 / 洞察 → Markdown
```

### 摘要是怎么分段的

1. 字幕按字符预算（设置里的「单块字符预算」）切成若干块，每块保留原始时间戳。
2. 每一块独立交给模型，要求输出 `{start, end, title, points, summary}` 的 JSON。
3. 所有块的结果再交给模型合并成全局摘要。
4. 模型返回非法 JSON 时会自动重试一次并要求修复；合并失败则降级为直接拼接各块结果，
   **不会中断整个流程**。

时间戳一律取自字幕里真实出现过的位置，不会编造。

### 风控处理

B 站接口有风控，本工具做了几件事：

- 请求前先通过 `x/frontend/finger/spi` 握手获取 `buvid3` 设备指纹；
- 对需要签名的接口（`player/wbi/v2`、`view/conclusion/get`）实现完整的 WBI 签名
  （参数排序、过滤 `!'()*`、拼接 mixinKey 后取 MD5）；
- 遇到 **HTTP 412**（风控）时自动切换 UA 并刷新指纹重试 —— 因为 B 站会校验
  UA 声明的浏览器与实际 TLS 指纹是否一致，Node 的 TLS 指纹配 Chrome UA 会被拦截；
- 音频 CDN 有多个节点，逐个尝试。

---

## 诊断脚本

排查问题时用：

```bash
npm run probe                  # 检查 B 站各接口是否可用
npm run check:audio            # 检查音频下载与 ffmpeg 转码
npm run check:e2e              # 用假模型跑完整流程，产出示例 Markdown
npm run check:e2e -- --synthetic   # 视频没字幕时用合成字幕继续验证链路
```

`npm run check:e2e` 不消耗任何模型额度，但会完整跑通
「取信息 → 取字幕 → 分块 → 摘要 → 渲染」，产出一份 `dist/e2e-sample.md`。

这些脚本会真实访问 B 站接口。

---

## 常见问题

**Q：提示「未登录，无法获取官方字幕」**
A：字幕需要登录态。在设置里点「打开登录窗口」扫码登录，或手动粘贴含 `SESSDATA` 的 Cookie。

**Q：提示「没有可用的字幕，且未配置语音识别」**
A：该视频确实没有字幕。在设置里配置一个 ASR 方案（OpenAI 兼容接口或 whisper.cpp）即可自动转写。

**Q：下载音频报 HTTP 403**
A：B 站媒体 CDN 有地区限制，当前网络所在区域可能无法访问。换个网络或挂代理再试。

**Q：模型返回的摘要时间戳不准**
A：换用支持长上下文的模型，或调大「单块字符预算」让每块内容更少、更聚焦。

**Q：想要英文摘要**
A：设置里把「摘要语言」改成 `en`。

---

## 项目结构

```
src/
├── core/                 # 与 Electron 无关的纯逻辑，可单独测试
│   ├── bilibili/         #   API 客户端、WBI 签名
│   ├── providers/        #   OpenAI 兼容 / Ollama / B站官方
│   ├── asr/              #   音频准备与两种转写后端
│   ├── pipeline/         #   分块、提示词、摘要编排、任务流程
│   ├── output/           #   Markdown / SRT 渲染
│   ├── config.ts         #   配置定义与持久化
│   └── utils/            #   时间、文本工具
├── main/                 # Electron 主进程（窗口、IPC、任务调度）
├── preload/              # contextBridge 安全桥
└── renderer/             # 界面（原生 TS + CSS，无框架依赖）
```

开发命令：

```bash
npm run dev         # 开发模式
npm run typecheck   # 类型检查
npm test            # 单元测试
npm run build       # 构建到 dist/
```

---

## 注意事项

- 请遵守 B 站的使用条款，工具仅用于个人学习与内容检索。
- 摘要由大模型生成，可能存在事实偏差，重要内容请对照原视频。
- API Key 与 Cookie 只保存在本机 `%APPDATA%/BiliSummary/config.json`，不会上传到任何服务器。

## License

MIT
