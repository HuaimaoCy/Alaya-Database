# Codex 记忆接入

Alaya 通过 **本地 MCP + Codex skill** 接入。它不是 Codex 侧边栏组件，也不会自动读取整段聊天或自动注入系统提示。

两条路，二选一，不要同时启用（否则两个 MCP 连接会同时打开一个库）：

| 方式 | 适用 | 入口 |
| --- | --- | --- |
| 一键配置 | 任何 Codex，含旧版本 | `node bin/memory-vault.mjs codex setup` |
| 本地插件 | 支持 `codex plugin` 的客户端（本机实测 0.163.0-alpha.11.1） | `codex plugin marketplace add` + `codex plugin add` |

## 配置（一键：MCP + 技能）

安装本包依赖后，在仓库根目录运行：

```sh
npm install
node bin/memory-vault.mjs codex setup --dry-run
node bin/memory-vault.mjs codex setup
node bin/memory-vault.mjs codex status
```

安装器把 MCP 启动配置加入 Codex 配置，并安装 `alaya-database` 技能。启动程序、脚本、数据库均使用绝对路径，不依赖 Codex 的工作目录。安装后请重启 Codex 或新建会话。

- Codex 目录：`--home` → `$CODEX_HOME` → `~/.codex`。DSH 托管的 Codex 可能使用独立的 `CODEX_HOME`，不一定是桌面 Codex 的目录；可显式指定 `--home`。
- 数据库：`--db` → `$MEMORY_VAULT_DB` → `$DSH_HOME/memory-vault/vault.sqlite`（DSH_HOME 未设时为 `~/.dsh`）。若 Alaya 桌面已切换数据库，请从桌面设置确认路径后显式传入 `--db`。
- `--dry-run` 和 `status` 不创建目录或打开数据库。`setup` 也不读取/写入记忆，不启动后台 stdio 进程；由 Codex 管理 MCP 进程。
- 原配置注释和其他服务器不改写。修改前生成唯一 `.bak` 备份；重复安装相同内容为无操作。
- 已有不同的 `memory-vault` / `memory_vault` 配置时拒绝覆盖，避免重复连接到不同数据库。可根据预览的 `snippet` 手动合并。
- 自定义技能默认保留。确认要更新时运行 `codex setup --update-skill`，旧技能先备份。
- `status.ready` 表示配置与技能匹配，不代表当前 Codex 会话已经加载或 MCP 健康检查通过。
- 已有服务器携带额外启动参数或工具策略时也会提示冲突，不忽略这些选项后误报就绪；请保留需要的自定义配置并手动核对。

不要移动安装源目录，否则绝对路径需要重新配置。切换源码版本后先检查预览；安装器不会擅自替换旧 MCP 路径。

## 本地插件包（`codex plugin`）

仓库同时是 Codex 本地插件仓库：`.codex-plugin/plugin.json`（清单）、`.mcp.json`（stdio MCP）、`skills/alaya-database/SKILL.md`，以及 `.agents/plugins/marketplace.json`（本地 marketplace 入口）。先看清要执行什么：

```sh
node bin/memory-vault.mjs codex plugin
```

输出插件根、版本、`ready`/`problems` 和四条可直接照抄的命令，不写任何配置、不打开数据库。然后：

```sh
codex plugin marketplace add "<仓库绝对路径>"
codex plugin add alaya-database@alaya
codex plugin list --json        # 确认已安装且 enabled=true
codex plugin remove alaya-database@alaya
```

安装做了什么（本机实测）：`config.toml` 追加两段而不改动其他内容 —

```toml
[marketplaces.alaya]
source_type = "local"
source = '<仓库绝对路径>'

[plugins."alaya-database@alaya"]
enabled = true
```

插件本体被**复制**到 `$CODEX_HOME/plugins/cache/alaya/alaya-database/<版本>`；MCP 从这份副本启动，因此改源码后要重新 `plugin add`。复制是整目录的（`.git`、`node_modules`、`tests` 一起进去），从干净的安装目录添加更省空间。

启动方式是相对路径 + `cwd: "."`：

```json
{ "memory-vault": { "command": "node", "args": ["bin/memory-vault.mjs", "mcp"], "cwd": "." } }
```

原因（实测，非推测）：客户端把插件 MCP 的 `cwd` 接到**安装后的插件目录**上，`cwd: "."` 即插件根；而 `${PLUGIN_ROOT}` 这类占位符不会被替换到 `cwd` 上（会解析成 `<插件根>/${PLUGIN_ROOT}`，目录不存在，服务起不来）。所以清单里不放占位符，也不放任何绝对路径。数据库仍走默认路径，或用环境变量 `MEMORY_VAULT_DB` 覆盖（`.mcp.json` 的 `env_vars` 已放行该变量与 `DSH_HOME`）；要固定数据库路径时优先用 `codex setup --db`。

重复执行：`marketplace add` 第二次返回 `alreadyAdded: true`；`plugin add` 第二次不改写 `config.toml`。`codex plugin` 同时校验清单与 `package.json` 的版本一致、技能文件存在、启动描述符没有占位符/绝对路径/内嵌密钥，任一不符会进 `problems`。

## 使用

在新 Codex 会话中输入：

```text
$alaya-database 查一下这个项目的发布约定
$alaya-database 记住：每次发布之前都要运行回归测试。存入「项目约定」组。
```

也可以直接调用 `memory_context`、`memory_recall`、`memory_write`。写入经原有核心接口完成，数据库来源标为 AI 生成；不经过笔记本的独立数据域。工具成功后返回条目 id，随后可在 Alaya 数据库视图检索。

写入语义（`npm test` 内有临时库用例覆盖）：`group` 是**必填**的，没有默认组；新组默认属于知识库；条目默认跟随组的归属，只有显式传 `scope: conversation` 才是对话记忆。同一段正文写两次会得到两条 —— 去重靠"先检索再写入"，不是靠服务端拦截，所以技能里要求先 `memory_recall`。仅修改已有条目的标签、归属或优先级时使用 `memory_assign`，不要重写一份。

## 验证

| 命令 | 验证内容 | 是否碰本机配置/真实库 |
| --- | --- | --- |
| `npm test` | 全套，含临时 Codex 目录的配置、回滚、幂等、快捷录入默认值与真实 stdio 写入/检索 | 否，全部用临时目录与临时数据库 |
| `npm run test:plugin` | 清单字段、相对路径可移植性、marketplace 入口、`codex plugin` 报告，以及在**含空格与中文的插件根**里真实启动 MCP 写入/检索 | 否 |
| `npm run test:codex-cli` | 用本机 `codex` 在临时 `CODEX_HOME` 里真跑 marketplace/plugin 安装与卸载、配置保留、解析出的启动描述符，并用它启动 MCP 写入/检索 | 否，`CODEX_HOME` 与数据库都在临时目录；找不到 `codex` 时跳过 |

## 已验证与未验证

已验证（本机 codex-cli 0.163.0-alpha.11.1，临时目录）：

- 本地 marketplace 添加、插件安装/卸载、配置原内容保留、重复执行幂等、未知插件被拒且不写配置。
- 客户端解析出的启动描述符（命令、相对参数、`cwd` 落在安装副本上）确实能启动 stdio MCP，并完成写入与检索。
- 清单字段与同机 19 个官方插件一致（`name`/`version`/`description`/`author`/`homepage`/`repository`/`keywords`/`skills`/`mcpServers`/`interface`）；未使用任何官方清单里不存在的字段。

未验证 / 未做：

- **没有在你的真实 `~/.codex` 上安装**本插件，也没有改你的 Codex 配置或真实记忆库；需要你自己执行上面的命令。
- 没有跑模型回合，所以"会话里真的弹出 `memory_*` 工具并响应 `$alaya-database`"未在真实会话中验证；验证到的是客户端解析 + 用该描述符真实启动服务。
- 没有上架任何公共插件目录，也没有插件商店 UI。
- 官方文档站点（`developers.openai.com/plugins/build/plugins`、`/codex/mcp`）在本机返回 HTTP 403，插件与 marketplace 格式以本机 codex-cli 的实测行为和官方插件清单为准；若你那边能打开官方文档，可再核对一次字段说明。

## 恢复

关闭 Codex 后：插件方式用 `codex plugin remove alaya-database@alaya`，需要时再 `codex plugin marketplace remove alaya`；一键方式移除安装器新增的 `mcp_servers.memory-vault` 表及所安装技能，或在确认没有后续配置修改时恢复对应 `.bak`。不要删除 Alaya 数据库。

安装器使用 `.alaya-setup.lock` 排除同时安装，锁内记录进程号和开始时间。若进程意外结束留下锁，先确认没有任何 Alaya 配置安装进程，再手动移除该锁并重试；不要仅凭锁的年龄判断。发生普通写入错误时会回滚已修改文件；无法安全回滚时错误会指出保留的备份，不覆盖并发修改。

备份包含原配置的完整内容，可能含其他 MCP 的密钥。请将 Codex 目录和备份保留在私人目录，确认安装正常且不再需要恢复后自行删除备份。Unix 新文件权限为 `0600`；Windows 权限继承目录 ACL，安装器不会改动 ACL。配置必须为 UTF-8（支持 BOM），其他编码会拒绝修改。

本实现是本地 MCP ＋ 技能接入，不代表已上架公共目录。
