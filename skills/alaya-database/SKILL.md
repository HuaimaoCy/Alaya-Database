---
name: alaya-database
description: 在 Codex 中使用 Alaya 记忆与知识库（memory-vault MCP）。开始任务前检索既有约定与结论，把已确认的结论固化成长期记忆，跨会话积累项目知识与用户偏好。当会话中存在 memory_recall / memory_write 等 memory_* 工具，或用户提到「记忆库」「知识库」「Alaya」「记住这个」「之前说过什么」时使用。
---

# Alaya 数据库（memory-vault）

本地优先的记忆与知识库：一个 SQLite 文件承载全部数据，DSH 插件、Codex MCP、CLI 与桌面应用共用同一数据库——你现在读到的记忆，是其他会话沉淀的；你现在写入的结论，之后的会话都能检索到。

MCP 与 DSH 插件的关键差异：**这里不会自动向系统提示注入任何记忆**。需要什么知识，由你显式调用工具获取。

## 会话工作流

1. **开始任务时**：先 `memory_context`（带 sessionId）拿到记忆组索引、底层约定与本任务已应用的知识正文；不确定有没有既有结论时，再用 `memory_recall` 按关键词检索。
2. **过程中**：需要某个领域的既有约定（项目规则、用户偏好、踩过的坑）就 `memory_recall`；要用一整组知识就 `memory_apply` action=set groups=["组名"]，然后 `memory_context` 读正文。
3. **任务结束或得出已确认结论时**：`memory_write` 写入（一次可多条），或 `memory_summarize` 带 content 固化一段总结。上下文快满时先固化，比事后回忆可靠。

## 快捷添加

用户可直接输入 `$alaya-database 记住：正文`，或「把这个结论存入 Alaya 的某某组」。这是通过 MCP + 技能工作的入口，不是 Codex 界面按钮。

- 用户已经明确要求保存时，按其指定的正文、组与归属写入，不必再问是否保存；没有指定组时复用合适的已有项目组，否则使用知识库。不要自动把普通聊天全部存入库。
- 用少量关键词检索潜在重复；已存在同一内容就返回原条目的 id，不重复写入。检索失败不等于没有重复。
- 调用 `memory_write` 时传 `group`、`scope`、`sessionId`，正文放进 `entries: [{ title, content }]`。不同归属不混写，只有当前任务有效的进度用 conversation。
- 只有收到工具成功响应才报告「已保存」，简短给出标题、组和返回的完整 id。不要把敏感凭据写入普通记忆。

## sessionId 约定

每个工具调用都带 `sessionId` 参数：一个任务的稳定唯一标识（如 `alaya-2026-10-01-fix-login`）。同一任务全程用同一个；不同任务用不同的，否则知识选择和总结目标会串到一起。省略时使用本 MCP 进程的临时会话——只在单任务进程里可接受。

## 工具速查

| 工具 | 用途 |
| --- | --- |
| `memory_context` | 记忆索引 + 底层约定 + 本任务已应用的知识正文（MCP 下获取上下文的正道） |
| `memory_recall` | 按关键词（空格分隔、全部命中）、组、标签、归属或 id 检索 |
| `memory_write` | 写入新记忆（一次最多 50 条） |
| `memory_assign` | 就地调整已有条目的归属、组、优先级、标签、底层标记、可见性 |
| `memory_group` | 记忆组的增删改、移动、绑定总结目标 |
| `memory_apply` | 选择本任务应用哪些记忆组（配合 memory_context 读正文） |
| `memory_summarize` | 固化总结——MCP 下**必须带 content**（自己写正文） |
| `memory_updates` | 查询版本状态 |
| `memory_image` | 记忆的图片附件（PNG/JPEG/WebP/GIF，≤10 MB） |
| `memory_curate` | AI 整理知识库——**MCP 下不可用**（此宿主无模型服务），请在 DSH 里执行 |

## 硬规则

**只写新内容。** 要改一条已有记忆的标签、优先级、归属、底层标记或可见性，用 `memory_assign` 改它本身；不要把同一条内容重写一遍再隐藏旧的——那会留下两条正文相同的记忆。写入前不确定是否已有，先 `memory_recall` 查一下。

**内容限制。** 单条正文 ≤ 20000 字符；标题 ≤ 200 字符；单个标签 ≤ 64 字符、每条最多 32 个标签；记忆组名 ≤ 120 字符。正文支持 Markdown 与 LaTeX（行内 `$...$`，独立成行 `$$...$$`）。写入时整批校验，一条不合法全部拒绝，不会写一半。

**两条轴。** 每条记忆有两个独立属性：*归属*（`conversation` 对话记忆=属于产生它的会话 / `knowledge` 知识库=跨会话复用）和*来源*（`人工输入` / `AI 生成`，由系统按出处自动打标，改不了）。跨会话要用的结论写进知识库；只对本任务有意义的进度留在对话记忆。

**标签。** `memory_assign` 的 tagsMode：add 追加、remove 移除、set 整体替换；清空全部用户标签用 `tagsMode=set` 且给空数组。改归属相关的字段时记得显式传 `scope` + `targetGroup`，避免归属意外漂移。

**优先级与预算。** 优先级 0–100，越高越先注入。单任务注入预算：12 条、2400 字符——超预算的组会被截断，完整内容用 `memory_recall` 检索。真正重要的长期约定可设 `base: true`（底层 prompt，每次注入且不占预算）。

**记忆组。** 最多 3 层嵌套；应用父组会连子组一起应用。改挂用 `memory_group` 的 parent 参数（传空字符串表示移到顶层）。

**隐藏可逆。** `memory_assign` hidden=true 只是下架（默认不再出现在检索与提示里），随时可恢复；不要用它代替删除判断。

## 检索技巧

`memory_recall` 的 query 是多关键词 AND（全部命中才返回），默认上限 20 条（可传 limit，最高 200）。只看标题做目录浏览时传 `withContent: false`。按组检索默认连带子组。系统标签「AI 生成」「人工输入」可用于按来源过滤。

## 无 MCP 时的逃生通道（CLI）

数据库是共享的，Codex 没配 MCP 也能直接用 CLI 操作同一文件（数据库路径默认 `$DSH_HOME/memory-vault/vault.sqlite`，未设时回退 `~/.dsh`；也可用 `$MEMORY_VAULT_DB` 指定）：

```bash
node bin/memory-vault.mjs recall --query "发布 流程"
node bin/memory-vault.mjs write --content "结论……" --group 知识库 --title "标题" --tags a,b --source codex
node bin/memory-vault.mjs show <id>
node bin/memory-vault.mjs help
```

## 安装与配置（供参考）

- 注册 MCP 服务器：`codex mcp add memory-vault -- node <仓库路径>/bin/memory-vault.mjs mcp`，或在 Codex `config.toml` 里写 `[mcp_servers.memory-vault]`，`command = "node"`，`args = ["<仓库路径>/bin/memory-vault.mjs", "mcp"]`。
- 一键接入：在仓库根目录运行 `node bin/memory-vault.mjs codex setup --dry-run` 预览，再运行 `node bin/memory-vault.mjs codex setup`。同时配置 MCP 和本 skill，支持 `--home` 与 `--db`；不打开数据库，不启动后台 stdio 进程。已有不同 MCP 配置会拒绝覆盖，技能更新需显式 `--update-skill` 并自动备份。
- 插件接入（支持 `codex plugin` 的客户端）：`node bin/memory-vault.mjs codex plugin` 查看清单状态与命令，再执行 `codex plugin marketplace add "<仓库绝对路径>"` 与 `codex plugin add alaya-database@alaya`。插件启动用相对路径（`cwd: "."` 落到安装副本），数据库默认与桌面/CLI 共用，可用 `MEMORY_VAULT_DB` 覆盖。与一键接入二选一。
- 判断当前会话是否真的接上了：`memory_updates action=status` 返回版本，或 `memory_recall` 能读到既有条目。没有这些工具说明 MCP 未加载，先重启 Codex 或新建会话。
- 仅安装本 skill：`node bin/memory-vault.mjs skill install`（复制到 `$CODEX_HOME/skills/alaya-database/`，未设置时使用 `~/.codex/skills/alaya-database/`）。安装后重启 Codex 或新建会话以重新发现工具与技能。
