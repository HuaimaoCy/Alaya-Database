# Alaya

**本地优先的记忆与知识库核心。** 一个 SQLite 文件承载全部数据，Codex MCP、本地 RPC、CLI 与 DSH 插件共用同一套操作接口——任何宿主（DSH、Codex、桌面应用、脚本）看到的规则完全一致。

## 核心概念

- **记忆组**：条目的一级容器，最多三层（组 → 子组 → 孙组）；应用一个父组会连它的子组一起应用。
- **条目**：一条记忆的正文、标题、标签、优先级与归属。正文支持 Markdown 与 LaTeX。
- **两条轴**：
  - *来源*：`人工输入`（人写的）与 `AI 生成`（模型写的）——由系统按出处自动打标，调用方改不了。
  - *操作*：`对话记忆`（属于产生它的会话）与 `知识库`（跨会话复用）。把一条记忆提升为知识库，就是把它从会话记忆移到知识库。
- **底层 prompt**：长期有效的基础约定，每次对话都注入，且不占会话的知识配额。
- **知识索引**：会话开始前挑选要应用的知识组，开始后仍可随时调整；注入预算不够时按优先级取舍。
- **优先级**：0–100，决定记忆在索引里的排序与注入的取舍顺序。
- **标签**：跨组的横向检索轴；系统标签（来源）与用户标签分开维护。
- **隐藏**：可逆下架——条目、标签与组全部保留，默认不出现在检索与提示里，随时恢复。
- **自动总结**：按轮数与字数阈值把对话增量固化为记忆，水位线保证不重复总结。

## 操作接口

九个工具，全部经同一张操作表分发：

| 工具 | 用途 |
| --- | --- |
| `memory_recall` | 按关键词、组、标签、归属或 id 检索记忆 |
| `memory_write` | 写入新记忆（一次可多条） |
| `memory_assign` | 调整归属、组、优先级、标签、底层 prompt 标记与可见性 |
| `memory_group` | 记忆组的增删改与移动（含归属切换） |
| `memory_apply` | 把记忆组接进当前会话，或查看当前应用情况 |
| `memory_summarize` | 把会话固化为一记忆 |
| `memory_curate` | 用一次模型调用整理知识库（可先 review 再 apply） |
| `memory_updates` | 查询版本状态与发布源 |
| `memory_image` | 记忆附件的增删查 |

## 安装

三条入口，共用同一个数据库：

```bash
# 1) DSH 插件（在 DSH 源码 checkout 根目录执行，路径替换为本机实际位置）
pnpm dsh plugin --profile web add '<本机路径>\dsh-memory-vault'

# 2) Codex MCP
node bin/memory-vault.mjs mcp

# 3) CLI
node bin/memory-vault.mjs help
```

## 配置

DSH 插件配置写在 `cordis.patch.yml`：

| 键 | 含义 |
| --- | --- |
| `conversationGroupName` / `knowledgeGroupName` | 新库首次启动时种下的两个默认组名 |
| `autoSummary` / `autoSummaryTurns` / `autoSummaryChars` | 阈值驱动的增量总结开关与触发条件 |
| `injectIndex` / `injectMaxGroups` | 系统提示里的记忆组索引与上限 |
| `databasePath` | 数据库文件；默认 `$DSH_HOME/memory-vault/vault.sqlite`（回退 `~/.dsh`） |
| `summarizer` / `summarizerProvider` / `summarizerModel` / `summarizerMaxTokens` / `summarizerTimeoutMs` | 总结走哪条模型路由 |

## 数据与存储

- 单一 SQLite 文件（WAL 模式，`busy_timeout` 容忍多进程读写），可整体备份、搬迁或放进版本控制之外的目录。
- 图片等附件与条目同库保存，随备份一起走。
- 导出/导入为 JSON，格式带 schema 版本与迁移链。

## 扩展架构

核心对具体应用**零静态依赖**：任何扩充（如笔记本）都经注入的 `extensions` 表挂载——`{ ops, handlers, scope }` 三项，操作名与核心自身操作在同一条通道上分发。

由此得到三条约束：

1. **底层统一**：所有能力共用一张操作表、一个数据库、一套校验规则。
2. **界面分离**：扩充自带界面，核心不含它的任何页面。
3. **可移除**：移除全部扩充后，核心的全部能力不受影响——`main` 分支本身就是这个状态的证明，`npm test` 可复现。

## 已知限制

- Windows 上 SQLite 为实验特性（Node 的 `node:sqlite`），应用首次使用会提示。
- 记忆正文单条上限约 2400 字，超限不会被注入系统提示（仍可检索到）。
