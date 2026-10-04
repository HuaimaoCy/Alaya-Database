# Alaya Database

Alaya 的**独立数据库核心**：CLI、Codex MCP、本地 RPC 与 DSH 插件共用同一个 SQLite 库（记忆组、条目、图片、更新）。

## 分支

| 分支 | 内容 |
| --- | --- |
| `main`（默认） | 仅数据库核心。**不含笔记本**——笔记本是可选扩充。 |
| `Alaya-Notebook` | 完整桌面产品 = 本核心 + 笔记本扩充（独立 UI、独立数据域、经注入的扩展 op 表挂载）。 |
| | 架构约束：底层统一（同一 op 通道与数据层）、UI 分离（去除笔记本页面后数据库仍可用）、两边数据隔离（含备份/导出边界）。 |

## 验证独立性

```bash
npm test
```

七套 Node 套件（smoke / core / serve-real / mcp / standalone / updates / images）全绿即证明：**去除笔记本代码后，数据库核心的全部能力**（op 表、桥接、MCP、RPC、插件注册、图片、更新）**不受影响**。核心对笔记本零静态依赖——扩展经注入的 `extensions` 表挂载。

## 使用

```bash
npm run mcp                       # 作为 Codex MCP 服务启动
node bin/memory-vault.mjs help    # CLI：写入、检索、整理、备份
```

作为 DSH 插件安装见 [docs/standalone.zh.md](docs/standalone.zh.md)；更新源与数据路径见 [docs/updates.zh.md](docs/updates.zh.md)、[docs/images.zh.md](docs/images.zh.md)。
