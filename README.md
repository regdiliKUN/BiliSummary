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
| **批量导入** | 一次粘贴多行链接 / 分享文案 / BV 号，自动识别去重，最多 100 条一批 |
| **合集识别** | 视频属于「合集」时自动识别，列出全集供勾选，只处理你选中的那几集 |
| **两种合集提取方式** | 每集各生成一份摘要，或把多集字幕拼成一条时间轴、产出一份跨集总结 |
| **多视频并发** | 任务队列 + 视频级并发（1-6 可调），每个视频独立进度、可单独取消/重试 |
| **历史记录** | 生成结果自动落盘，可搜索、收藏、回看、合并导出或按文件导出 |
| **三种摘要来源** | 官方字幕 → 语音识别（ASR）→ B 站官方 AI 总结，按优先级自动回退 |
| **四种模型来源** | OpenAI 兼容接口 / DeepSeek 官方 API / Ollama 本地模型 / B 站官方 AI 总结，随时切换 |
| **结构化输出** | TL;DR、关键要点、章节索引、分段带时间戳的摘要、关键洞察 |
| **分P 支持** | 多 P 视频可选择任意一集单独总结，队列里可直接切 P |
| **弹幕抓取** | 可选抓取弹幕并附在摘要末尾 |
| **桌面快捷方式** | 一键在桌面创建快捷方式（Windows / macOS / Linux 各自适配） |
| **导出** | 一键复制 Markdown、保存为 `.md`、导出 `.srt` 字幕、批量合并导出 |
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

## 三步就能跑起来

本工具可以**完全离线**使用，不需要任何云端账号。

### 1. 摘要模型：接本机 Ollama

如果你装了 [Ollama](https://ollama.com)，什么都不用配：

```bash
ollama serve                  # 启动服务
ollama pull qwen3:8b          # 拉一个对话模型
```

然后在「设置 → 摘要模型」里选 **Ollama 本地模型**，点「检测本机模型」，
下拉框会列出你装的模型。**留空即自动挑选**——应用会排除嵌入类模型
（`all-minilm`、`bge-*`），并在体积与效果之间取平衡。

> 装了 `qwen3` / `deepseek-r1` / `gpt-oss` 这类推理模型时，请勾选
> **关闭思维链**。否则模型会先输出大段 thinking，既慢又容易把输出预算耗光
> 导致正文为空。

### 2. 字幕：登录 B 站 或 一键装本地转写

B 站大部分视频**没有官方字幕**，所以通常需要语音识别。

- **有官方字幕**（少数）：在「设置 → B 站登录」登录即可自动获取。
- **没有字幕**：在「设置 → 语音识别」选 **whisper.cpp 本地**，点 **一键安装**。

  安装器会自己从 GitHub 拉 whisper.cpp 预编译程序、从 HuggingFace 拉模型，
  **不需要你手动找文件、也不需要任何账号**。装完路径自动填好。

  | 模型 | 体积 | 说明 |
  | --- | --- | --- |
  | tiny | 75 MB | 最快，质量最差 |
  | base | 141 MB | 偏快，中文勉强 |
  | small | 466 MB | **推荐**，中文可用 |
  | medium | 1.5 GB | 较慢，质量好 |
  | large-v3-turbo | 1.6 GB | 最慢，质量最好 |

### 3. 粘贴链接，生成摘要

把链接粘到「批量导入」框里 → 「解析并加入队列」（或 Ctrl+Enter）→ 「开始生成」。

**一次可以贴多条**，每行一条即可，也支持整段分享文案：

```
https://www.bilibili.com/video/BV1xx411c7mD
【3 小时搞懂 K8s 网络】 https://www.bilibili.com/video/BV1GJ411x7h7
https://b23.tv/abcdefg
BV1nN4y1Q7Yk
```

解析完会进队列，每个视频一行：封面、标题、分P、状态、独立进度条。
队列右上角能调 **并发数**（同时处理几个视频），行内可以单独取消 / 重试 / 移除，
多 P 视频还能直接在行里切分P。

**跳过历史里已有的视频** 默认勾选，避免重复花 token；想重新生成就取消勾选，
或对那一行点「重试」。

### 4. 合集：一次处理一整个系列

如果某个视频属于 B 站「合集」，队列那一行会出现一个蓝色的 **合集 · 共 N 集** 标记，
点它就会弹出选集面板：

1. 面板里列出合集全部集数（标题、时长、BV 号），默认勾选「还不在队列里」的那些
2. 用「全选 / 全不选 / 反选」快速调整，只有**勾选的集**才会去取字幕和摘要
3. 选一种提取方式：

   | 方式 | 结果 | 适合 |
   | --- | --- | --- |
   | 每个视频单独生成 | 勾了 N 集就产出 N 份独立摘要，各带各的时间戳 | 想逐集精读、单独导出 |
   | 合并成一个合集摘要 | 只产出 1 份，跨集统一总结 | 想快速抓住整个系列的主线，也更省调用 |

合并模式下，各集字幕会首尾相接拼成一条时间轴，摘要里的时间戳会还原成
「第 3 集 12:34」这种形式，Markdown 里还附一张收录视频清单。
某一集没有字幕不会让整个任务失败，会在「注意」里写明哪几集被跳过。

> 合并模式需要能处理长文本的模型，所以「B站官方 AI 总结」这个供应商不支持合并，
> 请改用 OpenAI 兼容接口或 Ollama；想用官方总结就选「每个视频单独生成」。

### 5. 回看与导出

顶部「历史记录」里存着所有生成成功的结果：

- 搜索框支持标题 / BV 号 / UP 主 / 一句话总结
- 「☆ 收藏」把重要的标星，筛选里可以只看收藏
- 「合并导出」把当前筛选结果拼成一个 Markdown（带目录）
- 「按文件导出」每个视频写一个 `.md` 到你选的文件夹
- 「打开目录」直接跳转到本机历史数据所在位置

### 也可以用云端模型

「设置 → 摘要模型」选 **OpenAI 兼容接口**，填 Base URL / API Key / 模型名即可，
支持 OpenAI、DeepSeek、Kimi、智谱、豆包、SiliconFlow、Groq、LM Studio、vLLM 等。
点「测试连接」会校验地址、Key 与模型名。

ASR 也支持 OpenAI 兼容接口（`/audio/transcriptions`），填同样的 Base URL 即可。

---

## 配置

点击右上角 **设置** 打开配置面板。

### 1. 选择摘要模型（四选一）

#### Ollama 本地模型（推荐，零配置）

Base URL 默认 `http://127.0.0.1:11434`。点「检测本机模型」会列出本机已装的模型，
留空则自动挑选。

#### DeepSeek 官方 API

选了这项就不用再自己拼 Base URL：

- **Base URL**：默认 `https://api.deepseek.com/v1`（带 `/v1`）
- **API Key**：在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 生成，`sk-` 开头
- **模型**：`deepseek-chat`（V3.x，快，长文摘要首选）或 `deepseek-reasoner`（R1，慢但更细）

上下文 64K，单块字符预算默认 16000。只支持官方 Key；
第三方中转站（各种 `sk-` 开头的代理 Key）请改用下面的「OpenAI 兼容接口」，Base URL 填中转站地址。

> DeepSeek 的 Key 只在 `api.deepseek.com` 有效，填到 OpenAI 的端点上一定 401 ——
> 反过来把 OpenAI 的 Key 填到 DeepSeek 也会 401。多个 `sk-` Key 混用时先确认它属于哪家。

#### OpenAI 兼容接口

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

#### B 站官方 AI 总结

不需要任何 API Key，直接用 B 站为该视频生成的结论。
**限制**：并非所有视频都有（实测很多视频返回空），且需要登录。

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
| **whisper.cpp 本地** | **推荐**。点「一键安装」即可，自动下载程序与模型，无需账号。 |
| **OpenAI 兼容接口** | 任何实现 `/audio/transcriptions` 且支持 `verbose_json` 的服务：OpenAI、SiliconFlow、Groq、阿里云 DashScope 等。模型填 `whisper-1` / `whisper-large-v3` 等。 |

音频下载与转码由内置的 `ffmpeg-static` 完成，无需单独安装 ffmpeg
（也可以在设置里手动指定 ffmpeg 路径）。

### 4. 其它可选项

- **摘要语言**：默认 `zh`，改成 `en` 可生成英文摘要。
- **并发请求数**：分块摘要的并发度，默认 3。模型有速率限制时可调低。
- **抓取弹幕**：默认开启。弹幕既用于识别名场面，也会附在摘要末尾。
- **附带字幕全文**：在导出的 Markdown 里附上完整字幕。

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

### 三个提高质量的信号

字幕只记录了「说了什么」，所以工具还会补充另外两个信号：

| 信号 | 来源 | 作用 |
| --- | --- | --- |
| **视频简介** | UP 主填写的简介 | 常常已包含要点列表/目录，作为背景信息喂给模型 |
| **弹幕热点** | 按 10 秒窗口统计弹幕密度 | 找出名场面与高潮，提示模型重点覆盖这些时间点 |
| **章节/分P 标题** | 视频分P 信息 | 帮助模型理解整体结构 |

弹幕热点的判定阈值取**整段视频的中位密度**（2 倍中位数，最低 3 条），
而不是最大值 —— 否则开头刷屏的弹幕会把真正的热点一起压掉。

### 失败了会告诉你

如果部分字幕分块分析失败，摘要里会出现「⚠️ 注意」区块明确说明缺了多少，
界面也会弹出提示。**不会**出现「内容缺失但假装成功」的情况。

### 风控处理

B 站接口有风控，本工具做了几件事：

- 请求前先通过 `x/frontend/finger/spi` 握手获取 `buvid3` 设备指纹；
- 客户端在整个应用生命周期内复用，**指纹与 WBI 密钥跨任务缓存**，
  省掉每次重新握手，也降低触发风控的概率；
- 对需要签名的接口（`player/wbi/v2`、`view/conclusion/get`）实现完整的 WBI 签名
  （参数排序、过滤 `!'()*`、拼接 mixinKey 后取 MD5）；
- 遇到 **HTTP 412**（风控）时自动切换 UA 并刷新指纹重试 —— 因为 B 站会校验
  UA 声明的浏览器与实际 TLS 指纹是否一致，Node 的 TLS 指纹配 Chrome UA 会被拦截；
  降级只针对当次风控，请求成功后即恢复首选 UA；
- 音频 CDN 有多个节点，逐个尝试。

### 取消是真的能取消

「取消」按钮会真正中断正在进行的工作，而不只是隐藏进度条：

取消信号会一路传到字幕获取、音频下载、ffmpeg 转码、以及 whisper 进程；
窗口关闭时所有任务自动取消，不会留下还在烧流量的后台任务。

---

## 诊断脚本

排查问题时用：

```bash
npm run probe                  # 检查 B 站各接口是否可用
npm run check:audio            # 检查音频下载与 ffmpeg 转码
npm run check:e2e              # 用假模型跑完整流程，产出示例 Markdown
npm run check:e2e -- --synthetic   # 视频没字幕时用合成字幕继续验证链路
npm run check:shortcut         # 在 Electron 里验证快捷方式创建/更新/删除
```

`npm run check:e2e` 不消耗任何模型额度，但会完整跑通
「取信息 → 取字幕 → 分块 → 摘要 → 渲染」，产出一份 `dist/e2e-sample.md`。

这些脚本会真实访问 B 站接口。

---

## 桌面快捷方式

在「设置 → 应用」里点 **创建桌面快捷方式** 即可在桌面生成快捷方式，无需任何手动操作。

- **Windows**：生成 `.lnk`，指向当前运行的 `BiliSummary.exe`，图标取自 exe 内嵌图标
  （即 `resources/icon.ico`），并设置 `AppUserModelID`，使任务栏分组与运行中的窗口一致。
- **macOS**：在桌面创建指向 `.app` 包体的符号链接（`BiliSummary.app`），双击即可启动，
  图标自动显示应用图标。
- **Linux**：生成标准的 `.desktop` 文件并赋予可执行权限，同时写入
  `~/.local/share/applications/`。

重复点击不会产生重复项：已存在时会**更新**原有快捷方式的指向（例如应用被移动过、
或重装到了新目录），而不是新建第二个。

失败时会明确区分原因：

| 情况 | 提示 |
| --- | --- |
| 桌面目录不可写 | 「没有写入桌面的权限…可尝试以管理员身份运行」 |
| 文件被占用 | 「文件可能正被占用…请稍后重试」（Windows 会自动重试 5 次） |
| macOS 非标准包体 | 「无法定位 .app 包体」 |

### 打包配置里需要改动的位置

全部集中在 `electron-builder.yml`：

| 位置 | 配置项 | 作用 |
| --- | --- | --- |
| 顶部 | `appId: com.bilisummary.app` | **必须**与 `src/main/shortcut.ts` 的 `APP_USER_MODEL_ID` 一致，否则 Windows 上快捷方式与窗口会分成两个任务栏分组 |
| 顶部 | `productName: BiliSummary` | 决定 `app.getName()`，即快捷方式的文件名 |
| `win` | `icon: resources/icon.ico` | 同时用于 exe 与桌面快捷方式的图标 |
| `nsis` | `createDesktopShortcut: true` | **安装时**自动在桌面创建快捷方式（与运行时的按钮互补） |
| `nsis` | `createStartMenuShortcut: true` | 开始菜单入口 |
| `nsis` | `shortcutName: BiliSummary` | 安装时创建的快捷方式名称 |
| `mac` | `icon: resources/icon.png` | macOS 图标 |
| `mac` | `target: dmg` | dmg 默认安装到 `/Applications`，运行时的符号链接才能指向正确位置 |
| `linux` | `desktop.entry` | 安装时创建的 `.desktop` 入口 |

> **macOS 沙箱限制**：若把 `mac.target` 改成 `mas`（Mac App Store），应用处于沙箱中，
> 无权写入桌面。此时需在 `entitlements.mac.plist` 中声明
> `com.apple.security.files.desktop` 权限，否则运行时的快捷方式创建会失败。

### 验证打包版的快捷方式功能

```bash
npm run dist:win                 # 先打包
npm run check:shortcut:packaged  # 在已打包的应用里自检（创建->校验->重复->删除）
npm run check:shortcut:ui        # 用 DevTools 协议真实点击界面按钮，验证整条链路
```

两个脚本都会在桌面创建并删除测试用快捷方式，不会留下残留。

---

## 常见问题

**Q：提示「ffmpeg 下载失败」**
A：`ffmpeg-static` 的二进制在网络异常时可能下载失败，表现为 ASR 用不了但没有别的提示。
`npm install` 的 postinstall 阶段会自动重试一次；仍失败可手动执行 `npm run postinstall`。
这只影响语音识别，不影响「官方字幕 + LLM 摘要」这条主路径。

**Q：提示「未登录，无法获取官方字幕」**
A：字幕需要登录态。在设置里点「打开登录窗口」扫码登录，或手动粘贴含 `SESSDATA` 的 Cookie。

**Q：提示「没有可用的字幕，且未配置语音识别」**
A：该视频确实没有字幕。在设置里配置一个 ASR 方案（OpenAI 兼容接口或 whisper.cpp）即可自动转写。

**Q：提示「whisper 退出码 3221225785」/「退出码 3221225477」**
A：这些不是 whisper 自己返回的错误，而是 Windows 在**进程启动阶段**就失败：
`3221225785` = `0xC0000139` 找不到 DLL 入口点，`3221225477` = `0xC0000005` 访问冲突。
典型原因是 whisper 目录里的 `ggml-base.dll` / `ggml-cpu-*.dll` 解压不完整（文件被写成大段 0），
所以 stderr 是空的、光看退出码永远查不到原因。
处理：删掉 `%APPDATA%\BiliSummary\asr\whisper` 后重新「一键安装」，
或手动解压 `whisper-bin-x64.zip` 覆盖到该目录。**和 API Key 无关**——
本地 whisper 不走网络，Key 填错只会报 `HTTP 401`。

**Q：下载音频报 HTTP 403**
A：B 站媒体 CDN 有地区限制，当前网络所在区域可能无法访问。换个网络或挂代理再试。

**Q：模型返回的摘要时间戳不准**
A：换用支持长上下文的模型，或调大「单块字符预算」让每块内容更少、更聚焦。

**Q：摘要里出现「⚠️ 注意」说有分块分析失败**
A：有部分字幕块没能分析成功，摘要可能不完整。通常是模型接口限流或中途报错，
可以点「重试」重新生成，或调低「并发请求数」再试。

**Q：想要英文摘要**
A：设置里把「摘要语言」改成 `en`。

---

## 项目结构

```
src/
├── core/                 # 与 Electron 无关的纯逻辑，可单独测试
│   ├── bilibili/         #   API 客户端、WBI 签名
│   ├── providers/        #   OpenAI 兼容 / DeepSeek / Ollama / B站官方
│   ├── asr/              #   音频准备与两种转写后端
│   ├── pipeline/         #   分块、提示词、摘要编排、任务流程、批量调度、合集合并
│   ├── output/           #   Markdown / SRT 渲染（含合集版）
│   ├── history.ts        #   本地历史记录（索引 + 单条内容文件）
│   ├── config.ts         #   配置定义与持久化
│   └── utils/            #   时间、文本、合集时间轴工具
├── main/                 # Electron 主进程（窗口、IPC、任务调度）
├── preload/              # contextBridge 安全桥
└── renderer/             # 界面（原生 TS + CSS，无框架依赖）
```

### 批量与历史的数据落在哪

```
%APPDATA%\BiliSummary\
├── config.json           # 配置（含 Cookie、API Key）
└── history\
    ├── index.json        # 轻量索引：标题、TL;DR、收藏、生成时间
    └── items\<id>.json   # 单条完整结果：结构化摘要 + Markdown + 字幕
```

索引与内容分开存，列表刷新不用把字幕全读进内存；写入用「临时文件 + rename」，
进程被强杀也不会留下半个 JSON。超过保留条数（默认 500）会自动淘汰最旧的记录及其文件。

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
