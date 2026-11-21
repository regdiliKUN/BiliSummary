# BiliSummary 0.4.5 发布说明

## 该装哪个

- **推荐**：`BiliSummary-0.4.5-x64-setup.exe` —— 常规安装包，可自定义安装目录，自动创建桌面快捷方式。
- **免安装**：`BiliSummary-0.4.5-x64-portable.exe` —— 双击即用，不写入系统安装目录。

目录中的 `0.1.0` 文件是历史版本，仅为对照保留，**不要再使用**。
自动更新配置 `latest.yml` 只指向 0.4.5。

## 完整性校验

`latest.yml` 中记录了 setup 安装包的 `sha512` 与 `size`。在已安装 Node.js 的项目目录执行：

```bash
npm run verify:release
```

校验通过会输出：

```
发布物校验通过：BiliSummary-0.4.5-x64-setup.exe · v0.4.5 · 96145803 bytes · sha512 saVKNtb+efjqRE5l…
```

## 本次相对 0.1.0 的主要变化

0.1.0 之后源码持续迭代（至 0.4.3），0.4.4 在 0.4.3 基础上完成 20 轮质量改进，0.4.5 进一步优化体积与运行效率（安装包 98.8 MB → 91.7 MB，详见 CHANGELOG）：

- 摘要来源与供应商：OpenAI 兼容 / DeepSeek 官方 API / Ollama 本地 / B站官方 AI 总结。
- 本机优先的零配置流程：Ollama 自动选模型、whisper.cpp 一键安装且可取消。
- 批量导入、合集识别（单独生成 / 合并生成）、多视频并发、历史记录与导出。
- 可靠性：导出格式、任务状态流转、配置与历史落盘、IPC 边界均经修复并补充回归测试。

完整改动清单见 `CHANGELOG.md`，逐轮记录见 `ITERATION_LOG.md`。

## 注意事项

- 未做代码签名，Windows SmartScreen 可能提示「未知发布者」，确认来源后选择继续运行。
- Cookie 与 API Key 仅保存在本机 `%APPDATA%/BiliSummary/config.json`。
- `win-unpacked` 是指向 `E:/Apps/BiliSummary` 的软链接，不是普通文件夹。
