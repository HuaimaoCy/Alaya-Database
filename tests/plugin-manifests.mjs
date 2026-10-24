/**
 * 插件清单守卫：ZCode / Codex 两个市场共用一份技能与 MCP，版本必须跟 package.json。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = file => JSON.parse(readFileSync(file, 'utf8'))
const pkg = read('package.json')
const codex = read('.codex-plugin/plugin.json')
const zcode = read('.zcode-plugin/plugin.json')
const market = read('marketplace.json')
const codexMarket = read('.agents/plugins/marketplace.json')
const mcp = read('.mcp.json')

const NAME = 'alaya-database'
const SKILL = join('skills', NAME, 'SKILL.md')

assert.equal(codex.name, NAME)
assert.equal(zcode.name, NAME)
assert.equal(codex.version, pkg.version, 'Codex 插件版本必须跟随 package.json')
assert.equal(zcode.version, pkg.version, 'ZCode 插件版本必须跟随 package.json')
assert.ok(existsSync(SKILL), `技能文件缺失：${SKILL}`)
assert.equal(zcode.skills, './skills/')
assert.equal(zcode.mcpServers, './.mcp.json')
assert.equal(codex.mcpServers, './.mcp.json', '两个市场必须指向同一份 MCP 清单')

const skill = readFileSync(SKILL, 'utf8')
assert.match(skill, new RegExp(`^---\\nname: ${NAME}\\n`), 'SKILL.md frontmatter 的 name 必须与目录一致')

const entry = market.plugins.find(plugin => plugin.name === NAME)
assert.ok(entry, 'ZCode 市场必须列出本插件')
assert.equal(entry.source, './')
assert.equal(entry.version, pkg.version, 'ZCode 市场条目版本必须跟随 package.json')
assert.ok(codexMarket.plugins.some(plugin => plugin.name === NAME), 'Codex 市场必须列出本插件')

assert.ok(mcp.mcpServers?.['memory-vault'], 'MCP 清单必须声明 memory-vault 服务')
assert.equal(mcp.mcpServers['memory-vault'].command, 'node')
assert.ok(existsSync(mcp.mcpServers['memory-vault'].args[0]), 'MCP 入口脚本必须存在')

console.log('Plugin manifests: ZCode + Codex 版本、技能与 MCP 声明一致')
