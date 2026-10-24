/** Database-free Codex setup. Preserve unrelated TOML byte-for-byte. */
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'smol-toml'
import { defaultDatabasePath } from './core/vault.js'

export function codexHome(value = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Codex home 不能为空')
  return resolve(value)
}

function readOptional(path) {
  let info
  try { info = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`拒绝修改非普通文件：${path}`)
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)) }
  catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error
    throw new Error(`文件必须使用 UTF-8 编码；未修改：${path}`)
  }
}

/**
 * Read a file while rolling back, where the answer matters less than finishing.
 *
 * `readOptional` refuses non-regular files; a refusal here would otherwise
 * escape the rollback and replace the error the caller actually needs to see.
 * @param {string} path - File to read.
 * @returns {string|null|undefined} Contents, null when missing, undefined when unreadable.
 */
function currentContents(path) {
  try { return readOptional(path) } catch { return undefined }
}

/** Remove a file we no longer need, tolerating one that is already gone. */
function removeFile(path) {
  try { unlinkSync(path) } catch { /* already gone, or still held open */ }
}

function snapshot(options) {
  const home = codexHome(options.home)
  const db = options.databasePath ?? process.env.MEMORY_VAULT_DB ?? defaultDatabasePath()
  if (typeof db !== 'string' || !db.trim() || db === ':memory:') throw new Error('Codex 需要持久化数据库路径，不能使用空路径或 :memory:')
  const databasePath = resolve(db)
  const configPath = join(home, 'config.toml')
  const skillPath = join(home, 'skills', 'alaya-database', 'SKILL.md')
  const configBefore = readOptional(configPath)
  const skillBefore = readOptional(skillPath)
  const skill = readFileSync(new URL('../skills/alaya-database/SKILL.md', import.meta.url), 'utf8')
  let config
  try { config = parse((configBefore ?? '').replace(/^\uFEFF/, '')) } catch { throw new Error('Codex config.toml 不是有效 TOML；未修改任何文件') }
  const server = { command: process.execPath, args: [fileURLToPath(new URL('../bin/memory-vault.mjs', import.meta.url)), 'mcp', '--db', databasePath] }
  const aliases = ['memory-vault', 'memory_vault']
  const existing = aliases.filter(name => Object.hasOwn(config.mcp_servers ?? {}, name))
  if (config.mcp_servers !== undefined && (config.mcp_servers === null || Array.isArray(config.mcp_servers) || typeof config.mcp_servers !== 'object')) throw new Error('mcp_servers 必须是 TOML 表')
  const equivalent = existing.length === 1 && (() => {
    const value = config.mcp_servers[existing[0]]
    return value?.command === server.command && JSON.stringify(value.args) === JSON.stringify(server.args)
      && (value.enabled === undefined || value.enabled === true)
      // Unknown launch/policy options can change runtime behaviour. Preserve
      // them, but never claim the generated descriptor matches such a server.
      && Object.keys(value).every(key => ['command', 'args', 'enabled'].includes(key))
  })()
  const conflicts = []
  if (existing.length && !equivalent) conflicts.push('已有不同的 memory-vault / memory_vault MCP 配置；请先核对，安装器不会覆盖它')
  if (skillBefore !== null && skillBefore !== skill && !options.updateSkill) conflicts.push('已有修改过的 alaya-database 技能；确认更新时使用 --update-skill（自动备份）')
  const snippet = stringify({ mcp_servers: { 'memory-vault': server } })
  let configAfter = configBefore
  if (!existing.length) {
    configAfter = `${configBefore ?? ''}\n# Alaya local memory (MCP stdio)\n${snippet}`
    // Inline TOML tables cannot be extended by appending a child table.
    try { parse(configAfter.replace(/^\uFEFF/, '')) } catch { conflicts.push('现有 TOML 结构不能安全追加 MCP 表；请手动合并 snippet') }
  }
  const publicPlan = { home, configPath, skillPath, databasePath, serverName: existing[0] ?? 'memory-vault',
    ready: equivalent && skillBefore === skill, conflicts, snippet,
    changes: [configAfter !== configBefore ? configPath : null, skillBefore !== skill ? skillPath : null].filter(Boolean) }
  return { ...publicPlan, configBefore, configAfter, skillBefore, skill, publicPlan }
}

export function inspectCodexSetup(options = {}) { return snapshot(options).publicPlan }

/**
 * Describe the bundled Codex plugin: manifest, marketplace entry and launch
 * descriptor. Read-only — no configuration is written, no database is opened.
 *
 * The client resolves a plugin MCP server by joining its `cwd` onto the
 * installed plugin root (codex-cli 0.163.0-alpha.11.1), so a placeholder in
 * `cwd` resolves to a directory that does not exist. That is why the checks here
 * reject absolute paths and `$` placeholders instead of trusting them.
 * @param {{pluginRoot?: string}} options - Repository root override, for tests.
 * @returns {object} Facts, printable commands and any drift found.
 */
export function inspectCodexPlugin(options = {}) {
  const pluginRoot = resolve(options.pluginRoot ?? fileURLToPath(new URL('..', import.meta.url)))
  const problems = []
  const read = (path, name) => {
    try { return JSON.parse(readFileSync(join(pluginRoot, path), 'utf8')) }
    catch (error) { problems.push(`${name} 无法读取或不是有效 JSON：${error instanceof Error ? error.message : error}`); return undefined }
  }
  const manifest = read('.codex-plugin/plugin.json', '.codex-plugin/plugin.json')
  const marketplace = read('.agents/plugins/marketplace.json', '.agents/plugins/marketplace.json')
  const descriptor = read('.mcp.json', '.mcp.json')
  let version
  try { version = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version }
  catch { problems.push('package.json 无法读取') }
  if (manifest) {
    if (manifest.name !== 'alaya-database') problems.push(`插件名应为 alaya-database，实际 ${manifest.name}`)
    if (version && manifest.version !== version) problems.push(`插件版本 ${manifest.version} 与 package.json ${version} 不一致`)
    if (manifest.skills !== './skills/') problems.push('插件未指向 ./skills/')
    if (manifest.mcpServers !== './.mcp.json') problems.push('插件未指向 ./.mcp.json')
    try { if (!lstatSync(join(pluginRoot, 'skills', 'alaya-database', 'SKILL.md')).isFile()) problems.push('技能文件缺失') }
    catch { problems.push('技能文件缺失：skills/alaya-database/SKILL.md') }
  }
  if (marketplace) {
    const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
    const entry = entries.find(item => item?.name === manifest?.name)
    if (!entry) problems.push('marketplace 未列出本插件')
    else {
      if (entry.source?.source !== 'local' || entry.source?.path !== '.') problems.push('marketplace 源应为 local 且 path 为 "."（仓库根即插件根）')
      if (entry.policy?.installation !== 'AVAILABLE') problems.push('marketplace 安装策略应为 AVAILABLE')
    }
  }
  const servers = descriptor?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) problems.push('.mcp.json 缺少 mcpServers')
  else {
    if (!Object.hasOwn(servers, 'memory-vault')) problems.push('.mcp.json 未声明 memory-vault')
    for (const [name, server] of Object.entries(servers)) {
      if (typeof server?.command !== 'string' || !server.command) problems.push(`${name}: command 缺失`)
      if (!Array.isArray(server?.args) || !server.args.length) problems.push(`${name}: args 缺失`)
      if (server?.cwd !== '.') problems.push(`${name}: cwd 必须为 "."，客户端会把它接到安装后的插件目录`)
      for (const value of [server?.command, server?.cwd, ...(Array.isArray(server?.args) ? server.args : [])]) {
        if (typeof value !== 'string') continue
        if (value.includes('$')) problems.push(`${name}: 启动配置含未展开占位符 ${value}`)
        if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\')) problems.push(`${name}: 启动配置含绝对路径 ${value}`)
      }
      if (server?.env && Object.keys(server.env).length) problems.push(`${name}: 不要把环境变量或密钥写进插件包`)
    }
  }
  const marketplaceName = marketplace?.name ?? 'alaya'
  const pluginName = manifest?.name ?? 'alaya-database'
  return {
    pluginRoot, marketplace: marketplaceName, plugin: pluginName, version: manifest?.version ?? null, ready: problems.length === 0, problems,
    commands: {
      addMarketplace: `codex plugin marketplace add "${pluginRoot}"`,
      install: `codex plugin add ${pluginName}@${marketplaceName}`,
      status: 'codex plugin list --json',
      remove: `codex plugin remove ${pluginName}@${marketplaceName}`,
    },
    note: '插件安装会把整个仓库复制到 Codex 的插件缓存；安装后重启 Codex 或新建会话。不要与 codex setup 同时启用。',
  }
}


export function setupCodex(options = {}) {
  const initial = snapshot(options)
  if (options.dryRun) return { ...initial.publicPlan, dryRun: true, installed: false }
  if (initial.conflicts.length) throw new Error(initial.conflicts.join('\n'))
  mkdirSync(initial.home, { recursive: true })
  const lockPath = join(initial.home, '.alaya-setup.lock')
  let lock
  try { lock = openSync(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`另一项 Alaya 配置安装可能正在进行（锁文件：${lockPath}）。若此前进程已退出，请确认没有其他安装进程后手动移除该锁再重试；不要删除数据库。`)
    throw error
  }
  const changed = [], backups = [], taken = new Map()
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    const plan = snapshot(options)
    if (plan.conflicts.length) throw new Error(plan.conflicts.join('\n'))
    for (const [path, before, after] of [[plan.skillPath, plan.skillBefore, plan.skill], [plan.configPath, plan.configBefore, plan.configAfter]]) {
      if (before === after) continue
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.alaya-${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, after, { flag: 'wx', mode: 0o600 })
        if (readOptional(path) !== before) throw new Error(`文件已被其他程序修改，请重试：${path}`)
        if (before !== null) {
          const backup = `${path}.alaya-${randomUUID()}.bak`
          writeFileSync(backup, before, { flag: 'wx', mode: 0o600 }); backups.push(backup); taken.set(path, backup)
        }
        renameSync(temporary, path)
        changed.push({ path, before, after })
      } finally { removeFile(temporary) }
    }
    return { ...plan.publicPlan, ready: true, installed: true, changed: changed.map(item => item.path), backups,
      next: '重启 Codex 或新建会话以加载 MCP 与技能。使用 $alaya-database 记住：… 或调用 memory_recall。' }
  } catch (error) {
    const kept = new Set()
    for (const item of changed.reverse()) {
      // Never undo a concurrent edit made after our write.
      if (currentContents(item.path) !== item.after) { kept.add(item.path); continue }
      const temporary = `${item.path}.alaya-${randomUUID()}.tmp`
      try {
        if (item.before === null) unlinkSync(item.path)
        else {
          writeFileSync(temporary, item.before, { flag: 'wx', mode: 0o600 })
          if (currentContents(item.path) !== item.after) { kept.add(item.path); continue }
          renameSync(temporary, item.path)
        }
      } catch { kept.add(item.path) }
      finally { removeFile(temporary) }
    }
    // A backup is only worth keeping when something it holds was actually
    // replaced. When the rename failed the file still holds its original
    // bytes, and when a rolled-back write was undone every backup of it
    // duplicates those bytes — leaving either behind would advertise a change
    // the user never ends up with, so a failed install keeps none of them.
    for (const [path, file] of taken) if (!kept.has(path)) removeFile(file)
    if (kept.size) error.message += `\n部分文件未回滚（可能有并发修改或文件被占用），请核对：${[...kept].join('、')}；保留的备份：${[...taken].filter(([path]) => kept.has(path)).map(([, file]) => file).join('、') || '无'}`
    throw error
  } finally { closeSync(lock); removeFile(lockPath) }
}
