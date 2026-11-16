# BiliSummary 迭代记录（20 轮）

- 迭代对象：`C:/Users/xukunhang/Documents/默认项目` 应用源码 + `release/` 发布物
- 初始状态：源码 v0.4.3，发布目录仅含 v0.1.0 安装包（2026-10-20），`package-lock.json` 仍写 0.1.0
- 最终版本：**v0.4.4**（安装包 + 免安装版，2026-11-16 重新构建）
- 稳定性约束：保持 Electron 主进程 / preload / renderer / core 四层结构不变，未引入新框架，未改核心需求

---

## 逐轮记录

### 第 1 轮 · 正确性 / 边界情况：SRT 时间戳毫秒进位
- **目标**：消除 `0.9996s` 被格式化成 `00:00:00,1000` 的非法 SRT 时间轴。
- **改动**：`src/core/utils/time.ts` 的 `toSrtTimestamp` 改为先把秒数取整到毫秒总数，再从总毫秒拆分时/分/秒/毫秒；非有限数按 0 处理。
- **理由**：先四舍五入小数部分再拼接会让毫秒达到 1000，破坏 SRT 规范；先取整到整数毫秒再拆分则天然进位。
- **自检**：新增 `test/config-output.test.ts` 用例，覆盖 `0.9996 → 00:00:01,000`、`59.9996 → 00:01:00,000`、`NaN → 00:00:00,000`，全部通过。

### 第 2 轮 · 边界情况 / 一致性：跨平台安全文件名
- **目标**：标题含控制字符、开头句点或 Windows 保留名时，导出文件仍可创建且可见。
- **改动**：`src/core/output/markdown.ts` 新增并导出 `sanitizeFileStem`，`buildFileName` 统一走它；`src/core/history.ts` 删除重复的私有实现，批量导出也改用同一函数。
- **理由**：原实现只过滤 `\/:*?"<>|`，`..\u0000CON\n` 会生成隐藏/非法文件名；历史导出与主导出此前规则不一致。
- **自检**：新增用例验证保留名加前缀、空白标题回退「未命名」，历史导出相关既有用例仍通过。

### 第 3 轮 · 一致性 / 安全：配置合并白名单
- **目标**：IPC 传入的未知配置字段不能被写进用户配置。
- **改动**：`mergeConfig` 对嵌套对象只接纳默认配置中已存在且类型相同的键，顶层也只遍历已知键。
- **理由**：原 `{ ...fallback, ...incoming }` 会把任意注入属性带入配置对象，影响后续序列化与读取。
- **自检**：新增用例验证 `openai.injected` 与顶层 `unexpected` 均被丢弃，正常字段仍生效。

### 第 4 轮 · 正确性 / 完整性：配置文件原子写入
- **目标**：进程被强杀时配置不出现半截 JSON。
- **改动**：`ConfigStore.save` 改为写临时文件后 `renameSync` 覆盖；失败时把残留临时文件改名为 `.failed` 并抛出原始错误。
- **理由**：原 `writeFileSync` 直接覆盖，写入中断会导致下次启动全部回退默认值；历史索引早已采用原子写，配置应保持一致。
- **自检**：新增用例验证保存后可重新读取且目录无 `.tmp-` 残留。

### 第 5 轮 · 正确性 / 边界情况：配置数值范围校验
- **目标**：`NaN`、负数与越界数值不能通过配置校验。
- **改动**：`validateConfig` 统一 `inRange` 检查 temperature / maxTokens / contextChars / 并发数 / 历史条数 / 弹幕上限；`Number.isFinite` 显式拦截 `NaN`。
- **理由**：`typeof NaN === 'number'` 会让原类型判断放行；`historyLimit = -2` 等非法值此前无提示。
- **自检**：新增 `NaN` 并发、`historyLimit = -2`、`NaN` temperature 三个用例，全部检出。

### 第 6 轮 · 一致性：并发数统一钳制
- **目标**：界面输入 999 不再以超额并发启动任务。
- **改动**：新增 `src/core/utils/limits.ts` 的 `clampVideoConcurrency`（1–6），渲染进程初始化、change 事件、开始生成三处统一调用。
- **理由**：原 `Number(v) || 2` 只挡 0 和 NaN，999 会直接写入配置与调度器，和 `validateConfig` 的 1–6 提示矛盾。
- **自检**：`test/limits.test.ts` 覆盖 999/0/'2.8'/非法字符串与 fallback。

### 第 7 轮 · 安全 / 边界情况：历史 ID 路径穿越防护
- **目标**：来自 IPC 的历史 ID 不能读取或删除 `items/` 之外的文件。
- **改动**：`HistoryStore` 的 `get` / `remove` / `setFavorite` / `patchEntry` / `unlinkItem` 统一用 `isSafeId` 校验。
- **理由**：原实现直接 `join(itemsDir, id + '.json')`，`../index` 可指向目录外文件。
- **自检**：新增用例验证 `../index`、`..\<id>` 均返回 null/false，记录数不变。

### 第 8 轮 · 正确性：批量调度器取消与幂等
- **目标**：重复任务 ID 不串扰；取消全部时整体进度及时刷新；忽略 AbortSignal 的任务不误报完成。
- **改动**：`BatchRunner.start` 过滤重复 ID；`cancelAll` 在移出排队任务后补发 `onSettled`；成功回调增加 `signal.aborted` 判定走 `onCancelled`。
- **理由**：重复 ID 会让 active Map 覆盖、取消错任务；排队任务被直接丢弃时没有完成回调；部分实现即使中止也 resolve，会写入错误历史。
- **自检**：新增 3 个用例（重复 ID、取消后 resolve、cancelAll 刷新），全部通过。

### 第 9 轮 · 正确性：防止重复提交
- **目标**：双击「开始生成」不会把同一批任务提交两次。
- **改动**：渲染进程新增 `starting` 同步锁，`handleStartAll` 入口拦截重入，`finally` 释放。
- **理由**：首个 IPC 往返完成前任务状态尚未变为运行，第二次点击仍命中 queued，造成双倍请求与额度消耗。
- **自检**：类型检查通过；逻辑为同步置位/释放，覆盖所有提前 return 分支（finally）。

### 第 10 轮 · 正确性 / 完整性：任务状态与操作区一致性
- **目标**：迟到的进度事件不复活已结束任务；运行中不再残留「移除」按钮；结果区 key 不失效。
- **改动**：`handleProgress` 用 `isSettledStatus` 提前返回；行元素记录 `data-status`，状态变化时整行重建以刷新操作按钮；新增 `clearShownResultIf` 在移除/清除/取消时重置结果区。
- **理由**：原 `handleProgress` 无条件置 `running`，`patchTaskRow` 只改进度不改按钮，`shownResultKey` 在任务移除后仍占位。
- **自检**：类型检查通过；相关工具函数 `isSettledStatus` 有单测覆盖。

### 第 11 轮 · 性能：历史搜索防抖
- **目标**：历史记录较多时，连续输入不再每次重建整棵列表 DOM。
- **改动**：搜索框 `input` 事件改为 150ms 防抖，复用 `historySearchTimer`。
- **理由**：原实现每个按键触发 `renderHistory()`，在数百条记录时造成明显卡顿。
- **自检**：类型检查通过；事件监听集中注册，未重复绑定。

### 第 12 轮 · 可读性 / 可访问性：弹窗与提示语义
- **目标**：设置/选集弹窗与 toast 对键盘和读屏器可用。
- **改动**：两个弹窗加 `role="dialog"`、`aria-modal`、`aria-labelledby`；toast 加 `role="status"` / `aria-live="polite"`；Escape 同时关闭设置弹窗；打开弹窗时焦点移到首个可操作控件。
- **理由**：此前 Escape 只对选集弹窗生效，设置弹窗无语义标签，toast 变化读屏器不会播报。
- **自检**：类型检查通过；HTML 属性与焦点逻辑经代码复核。

### 第 13 轮 · 正确性：解析后按视频身份去重
- **目标**：短链、完整链接、BV 号指向同一视频时只入队一次。
- **改动**：`resolveTasks` 在拿到 `VideoInfo` 后用 `videoKey(bvid, part)` 与队列中其他任务比对，命中则标记 skipped 并提示重复来源。
- **理由**：原去重只比较原始 URL 字符串，三种写法会被当成三个视频。
- **自检**：`videoKey` 在 `test/limits.test.ts` 中验证大小写与缺省分P归一化。

### 第 14 轮 · 边界情况 / 正确性：超长字幕分块
- **目标**：单条超长识别字幕不再绕过字符预算导致 LLM 上下文超限。
- **改动**：`chunkTranscript` 先按 `start` 排序，再对超过预算的单条字幕按句子（必要时定长）拆分，并在原时间范围内线性分配新时间戳。
- **理由**：原来 `MIN_SEGMENTS_PER_CHUNK` 保证至少 6 条才切块，单条 5000 字字幕仍会整块送入模型。
- **自检**：新增用例验证拆分后文本完整拼接与原起止时间不变；原有 9 个分块用例保持通过。

### 第 15 轮 · 正确性：Markdown 表格转义
- **目标**：UP 主名或视频链接含 `|`/换行时，元信息表不被切列。
- **改动**：`renderMarkdown` 的 UP主、链接单元格改用已有的 `escapeCell`。
- **理由**：合集表格早已转义，单视频表格遗漏，属于同类数据不一致。
- **自检**：新增用例验证 `A|B\nC` 渲染为 `A\|B C`。

### 第 16 轮 · 安全 / 边界情况：IPC 参数校验
- **目标**：主进程不信任渲染层传入的参数。
- **改动**：`main.ts` 对 `config:set`、`video:info`、`batch:start`、`job:start`、`collection:start`、`job:cancel`、历史 ID、导出 ID、`file:save`、`file:exportTranscript`、`shell:open` 增加类型/ID/URL/文件名校验；并发数统一走 `clampVideoConcurrency`。
- **理由**：此前非法 taskId、超长 URL、路径型文件名可直接进入调度或文件系统调用。
- **自检**：`isSafeId` / `isSafeTaskUrl` / `isSafeExternalUrl` / `isSafeFileName` 均有单测；类型检查通过。

### 第 17 轮 · 完整性：ASR 安装可取消
- **目标**：1.6GB 模型下载不再只能等完。
- **改动**：设置页增加「取消安装」按钮，绑定 `cancelAsrInstall`，安装期间显示、结束隐藏。
- **理由**：preload 早已暴露 `cancelAsrInstall`，但 UI 没有入口，用户无法中止下载。
- **自检**：类型检查通过；按钮显隐与 `installWhisper` 的 try/finally 对齐。

### 第 18 轮 · 一致性 / 可复现性：版本与发布元数据
- **目标**：源码、锁文件、发布目录三者版本一致，且元数据可被机器校验。
- **改动**：`package.json` 0.4.3 → 0.4.4；`package-lock.json` 根版本 0.1.0 → 0.4.4；新增 `scripts/verifyRelease.mjs` 和 `npm run verify:release`，比对 `latest.yml` 的 sha512/size 与实际 exe。
- **理由**：发布目录原为 0.1.0 旧包，锁文件版本更是长期滞后，自动更新元数据一旦手工改动就可能失效。
- **自检**：`npm run verify:release` 输出 `发布物校验通过`；新增版本一致性测试比对 package.json / lockfile / latest.yml。

### 第 19 轮 · 可读性 / 完整性：交付文档
- **目标**：让使用者和后续维护者知道该装哪个包、如何验证、改了什么。
- **改动**：README 增加「发布与校验（0.4.4）」小节；新增 `CHANGELOG.md` 与 `release/README-发布说明.md`；本迭代记录落盘到 `release/ITERATION_LOG.md`。
- **理由**：release 目录此前没有任何说明文件，用户无法区分 0.1.0 与 0.4.4，也无法验证下载完整性。
- **自检**：文档中的版本号、文件名与 `latest.yml` 逐项核对一致。

### 第 20 轮 · 完整性 / 一致性：最终回归与交付
- **目标**：确认所有累计改动没有相互破坏，产出可安装的最终版本。
- **改动**：未再改功能，只做最终验证：类型检查、完整测试、重新打包、发布物校验。
- **理由**：迭代收尾需要一次干净的全局回归，避免「最后一轮改坏前面」。
- **自检**：`npm run typecheck` 通过；`npx vitest run` 全部通过；`npm run dist:win` 成功生成 0.4.4 双安装包；`npm run verify:release` 通过。

---

## 相对初始版本的整体提升

| 维度 | 初始版本 | 最终版本 |
| --- | --- | --- |
| 正确性 | SRT 毫秒越界、重复提交、进度复活、重复任务 ID、取消误报完成 | 全部有修复与回归测试；任务状态流转具备终态保护 |
| 完整性 | release 只有 0.1.0 旧包，无说明/校验；ASR 安装无法取消 | 0.4.4 安装包 + 免安装版 + 发布说明 + 迭代记录 + 校验脚本 |
| 可读性 | 弹窗/提示无语义，文档不区分新旧版本 | 弹窗与 toast 具备无障碍语义；README/CHANGELOG 说明清晰 |
| 性能 | 历史搜索逐键全量重建 DOM；超长字幕可能撑爆上下文 | 搜索 150ms 防抖；超长字幕按预算拆分且不丢字 |
| 边界情况 | 文件名、配置数值、历史 ID、IPC 参数基本无校验 | 建立 `limits.ts` 统一边界，覆盖 URL / ID / 文件名 / 并发 / 进度 |
| 一致性 | lockfile 0.1.0、源码 0.4.3、发布包 0.1.0 三处不一致；配置写入非原子 | 三处统一为 0.4.4；配置与历史索引均原子写；latest.yml 可机检 |

**测试规模**：初始 15 个测试文件 / 175 个用例 → 最终 17 个测试文件 / 203 个用例。

**构建产物**：
- `release/BiliSummary-0.4.4-x64-setup.exe`（103,647,053 字节）
- `release/BiliSummary-0.4.4-x64-portable.exe`
- `release/latest.yml`（指向 0.4.4，sha512 已校验）

> 说明：release 目录中的 0.1.0 旧安装包按原样保留，未做删除或覆盖；`win-unpacked` 仍是指向 `E:/Apps/BiliSummary` 的软链接，本次构建已更新其目标内容。
