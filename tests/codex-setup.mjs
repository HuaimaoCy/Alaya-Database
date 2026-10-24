import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync, readdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parse, stringify } from 'smol-toml'
import { setupCodex, inspectCodexSetup } from '../src/codex.js'
import { runCli } from '../bin/memory-vault.mjs'

const root = mkdtempSync(join(tmpdir(), 'alaya-codex-'))
const previous = { CODEX_HOME: process.env.CODEX_HOME, MEMORY_VAULT_DB: process.env.MEMORY_VAULT_DB }
const cli = async args => {
  let out = '', err = ''
  const code = await runCli(args, { stdout: text => { out += text }, stderr: text => { err += text } })
  return { code, out, err }
}
try {
  const home = join(root, 'Codex space 中文'), databasePath = join(root, 'vault space 中文.sqlite')
  process.env.CODEX_HOME = home
  process.env.MEMORY_VAULT_DB = databasePath
  const preview = setupCodex({ dryRun: true })
  assert.equal(preview.home, home)
  assert.equal(preview.changes.length, 2)
  assert.ok(!existsSync(home)); assert.ok(!existsSync(databasePath))
  assert.equal(inspectCodexSetup().ready, false)
  assert.ok(!existsSync(home), 'status must not create directories')
  const badFlags = await cli(['codex', 'setup', '--home'])
  assert.equal(badFlags.code, 1)
  assert.equal((await cli(['codex', 'setup', '--home', ''])).code, 1)
  assert.equal((await cli(['codex', 'setup', '--db', ':memory:'])).code, 1)
  assert.equal((await cli(['codex', 'setup', '--force'])).code, 1)
  assert.equal((await cli(['codex', 'setup', 'unexpected'])).code, 1)
  assert.equal((await cli(['codex', 'setup', '--dry-run=typo'])).code, 1)
  assert.ok(!existsSync(home), 'invalid flags must not silently install')

  // The plugin report is read-only: it works with no Codex home at all and must
  // not create one, so it is safe to run before every other check.
  const pluginReport = await cli(['codex', 'plugin'])
  assert.equal(pluginReport.code, 0)
  const plugin = JSON.parse(pluginReport.out)
  assert.equal(plugin.ready, true)
  assert.deepEqual(plugin.problems, [])
  assert.equal(plugin.commands.install, 'codex plugin add alaya-database@alaya')
  assert.equal((await cli(['codex', 'plugin', '--db', 'x'])).code, 1)
  assert.ok(!existsSync(home), 'the plugin report must not create a Codex home')

  mkdirSync(home, { recursive: true })
  const original = '# keep comments and unrelated settings\nmodel = "example"\n[mcp_servers.other]\ncommand = "some-other-server"\n'
  writeFileSync(join(home, 'config.toml'), original)
  const installed = JSON.parse((await cli(['codex', 'setup'])).out)
  assert.equal(installed.installed, true)
  assert.equal(installed.backups.length, 1)
  assert.equal(readFileSync(installed.backups[0], 'utf8'), original)
  const configuration = readFileSync(installed.configPath, 'utf8')
  assert.ok(configuration.startsWith(original))
  const server = parse(configuration).mcp_servers['memory-vault']
  assert.ok(isAbsolute(server.command)); assert.ok(isAbsolute(server.args[0]))
  assert.equal(server.args.at(-1), databasePath)
  assert.equal(parse(configuration).mcp_servers.other.command, 'some-other-server')
  assert.ok(!existsSync(databasePath), 'setup never opens database')
  assert.equal(inspectCodexSetup().ready, true)
  assert.deepEqual(setupCodex().changed, [], 'repeat setup is a no-op')
  assert.equal(readFileSync(installed.configPath, 'utf8'), configuration)

  writeFileSync(installed.skillPath, 'my edited skill')
  assert.throws(() => setupCodex(), /--update-skill/)
  assert.equal(readFileSync(installed.skillPath, 'utf8'), 'my edited skill')
  const updated = setupCodex({ updateSkill: true })
  assert.equal(updated.backups.length, 1)
  assert.equal(readFileSync(updated.backups[0], 'utf8'), 'my edited skill')
  assert.equal(inspectCodexSetup().ready, true)

  // Test the actual launch descriptor from a different working directory.
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'setup-test', version: '1' } } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'memory_write', arguments: { group: '知识库', scope: 'knowledge', sessionId: 'setup-test', entries: [{ title: 'setup round trip', content: 'codex quick capture verified' }] } } },
    { id: 4, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'quick capture', limit: 5, sessionId: 'setup-test' } } },
    { id: 5, method: 'tools/call', params: { name: 'memory_recall', arguments: { limit: 1.5 } } },
  ].map(item => JSON.stringify({ jsonrpc: '2.0', ...item })).join('\n') + '\n'
  const child = spawnSync(server.command, server.args, { cwd: root, input: requests, encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 0, child.stderr)
  const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(replies.length, 5)
  assert.ok(replies[1].result.tools.some(item => item.name === 'memory_write'))
  assert.equal(replies[2].result.isError, false)
  assert.equal(replies[3].result.structuredContent.entries[0].title, 'setup round trip')
  assert.equal(replies[4].error.code, -32602)

  // Quick capture, following what the skill tells Codex to do. The group has no
  // default, a brand new group is a knowledge group unless the caller says
  // otherwise, and a repeated paragraph is not deduplicated for you — the
  // recall-first rule is the real guard, so prove the recall sees the first
  // entry before the second write lands.
  const capture = items => {
    const input = items.map(item => JSON.stringify({ jsonrpc: '2.0', ...item })).join('\n') + '\n'
    const process_ = spawnSync(server.command, server.args, { cwd: root, input, encoding: 'utf8', timeout: 20000 })
    assert.equal(process_.status, 0, process_.stderr)
    return process_.stdout.trim().split('\n').map(line => JSON.parse(line))
  }
  const call = (id, name, arguments_) => ({ id, method: 'tools/call', params: { name, arguments: arguments_ } })
  const hello = { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capture', version: '1' } } }
  const captured = capture([
    hello,
    call(2, 'memory_write', { entries: [{ title: '没有组', content: '组是必填项' }], sessionId: 'capture' }),
    call(3, 'memory_write', { group: '快捷录入', entries: [{ title: '发布前先跑回归', content: '每次发布之前运行 npm test。' }], sessionId: 'capture' }),
    call(4, 'memory_recall', { query: '回归', sessionId: 'capture' }),
    call(5, 'memory_write', { group: '快捷录入', entries: [{ title: '发布前先跑回归', content: '每次发布之前运行 npm test。' }], sessionId: 'capture' }),
    call(6, 'memory_recall', { query: '回归', sessionId: 'capture' }),
    call(7, 'memory_write', { group: '本次进度', scope: 'conversation', entries: [{ title: '进度', content: '安装器测试写完。' }], sessionId: 'capture' }),
  ])
  assert.equal(captured[1].error.code, -32602, 'memory_write must require an explicit group')
  assert.equal(captured[2].result.isError, false)
  const capturedEntry = captured[2].result.structuredContent.entries[0]
  assert.equal(capturedEntry.source, 'model-write')
  assert.equal(captured[2].result.structuredContent.group.scope, 'knowledge', 'a new group defaults to knowledge')
  assert.equal(capturedEntry.scope, 'knowledge', 'the entry follows its group unless scope is given')
  assert.equal(captured[3].result.structuredContent.total, 1, 'the recall sees the first entry, so a duplicate can be avoided')
  assert.equal(captured[5].result.structuredContent.total, 2, 'writing the same text twice is not deduplicated')
  assert.equal(captured[6].result.structuredContent.group.scope, 'conversation')
  assert.equal(captured[6].result.structuredContent.entries[0].scope, 'conversation')
  // A fresh process reads the same temporary database: the capture survives.
  const reread = capture([hello, call(2, 'memory_recall', { id: capturedEntry.id }), call(3, 'memory_recall', { group: '快捷录入' })])
  assert.equal(reread[1].result.structuredContent.entries[0].content, '每次发布之前运行 npm test。')
  assert.equal(reread[2].result.structuredContent.total, 2)

  for (const text of ['not valid TOML =', '[mcp_servers.memory_vault]\ncommand="different"', '[mcp_servers."memory-vault"]\ncommand="different"', 'mcp_servers={other={command="other"}}']) {
    const isolated = join(root, `conflict-${Math.random()}`)
    mkdirSync(isolated); writeFileSync(join(isolated, 'config.toml'), text)
    assert.throws(() => setupCodex({ home: isolated }))
    assert.equal(readFileSync(join(isolated, 'config.toml'), 'utf8'), text)
    assert.ok(!existsSync(join(isolated, 'skills')))
  }
  // An entry registered under the underscore alias is the same server, so it is
  // equivalent and left exactly as it is; the skill is the only thing to add.
  const serverEntry = parse(configuration).mcp_servers['memory-vault']
  const underscore = join(root, 'underscore-alias')
  mkdirSync(underscore, { recursive: true })
  const underscoreConfig = stringify({ mcp_servers: { memory_vault: serverEntry } })
  writeFileSync(join(underscore, 'config.toml'), underscoreConfig)
  const skillFile = join(underscore, 'skills', 'alaya-database', 'SKILL.md')
  const underscoreInstall = setupCodex({ home: underscore })
  assert.equal(underscoreInstall.serverName, 'memory_vault')
  assert.deepEqual(underscoreInstall.changed, [skillFile])
  assert.equal(underscoreInstall.backups.length, 0, 'an untouched config needs no backup')
  const underscoreStatus = inspectCodexSetup({ home: underscore })
  assert.deepEqual(underscoreStatus.conflicts, [])
  assert.equal(underscoreStatus.ready, true)
  assert.equal(readFileSync(join(underscore, 'config.toml'), 'utf8'), underscoreConfig)
  assert.deepEqual(setupCodex({ home: underscore }).changed, [], 'a repeat setup is still a no-op')

  // Two aliases for one server would open the vault twice, so it is refused
  // even when both entries are exactly what the installer would write.
  const duplicate = join(root, 'duplicate-aliases')
  mkdirSync(duplicate, { recursive: true })
  const duplicateConfig = stringify({ mcp_servers: { 'memory-vault': serverEntry, memory_vault: serverEntry } })
  writeFileSync(join(duplicate, 'config.toml'), duplicateConfig)
  assert.throws(() => setupCodex({ home: duplicate }), /memory-vault/)
  assert.equal(readFileSync(join(duplicate, 'config.toml'), 'utf8'), duplicateConfig)
  assert.ok(!existsSync(join(duplicate, 'skills')))

  for (const [key, value] of Object.entries({ cwd: '/missing', env_vars: ['OTHER_KEY'], startup_timeout_sec: 0, enabled: false, env: { MEMORY_VAULT_DB: '/other' }, disabled_tools: ['memory_write'] })) {
    const isolated = join(root, `option-${key}`)
    mkdirSync(isolated)
    const text = stringify({ mcp_servers: { 'memory-vault': { ...serverEntry, [key]: value } } })
    writeFileSync(join(isolated, 'config.toml'), text)
    assert.equal(inspectCodexSetup({ home: isolated }).ready, false, `must not ignore ${key}`)
    assert.throws(() => setupCodex({ home: isolated }), /已有不同/)
    assert.equal(readFileSync(join(isolated, 'config.toml'), 'utf8'), text)
    assert.ok(!existsSync(join(isolated, 'skills')))
  }
  const bomHome = join(root, 'bom')
  mkdirSync(bomHome)
  writeFileSync(join(bomHome, 'config.toml'), `\uFEFF${original}`)
  const bomSetup = setupCodex({ home: bomHome })
  assert.ok(readFileSync(bomSetup.configPath, 'utf8').startsWith(`\uFEFF${original}`))
  assert.equal(inspectCodexSetup({ home: bomHome }).ready, true)
  const utf16Home = join(root, 'utf16')
  mkdirSync(utf16Home)
  const utf16 = Buffer.from(`\uFEFF${original}`, 'utf16le')
  writeFileSync(join(utf16Home, 'config.toml'), utf16)
  assert.throws(() => setupCodex({ home: utf16Home }), /UTF-8/)
  assert.deepEqual(readFileSync(join(utf16Home, 'config.toml')), utf16)
  assert.ok(!existsSync(join(utf16Home, 'skills')))

  // The rename of an already written file is the step that fails when a running
  // Codex holds config.toml open (Windows). The install must undo the skill it
  // already wrote, keep the config byte-identical, and leave no stale backup
  // that suggests a change the user is about to discover never happened.
  if (process.platform === 'win32') {
    const blocked = join(root, 'rollback')
    mkdirSync(blocked, { recursive: true })
    const blockedConfig = '# rollback check\nmodel = "example"\n'
    writeFileSync(join(blocked, 'config.toml'), blockedConfig)
    const blockedSkill = join(blocked, 'skills', 'alaya-database', 'SKILL.md')
    mkdirSync(join(blocked, 'skills', 'alaya-database'), { recursive: true })
    writeFileSync(blockedSkill, 'existing custom skill')
    process.env.CODEX_HOME = blocked
    const held = openSync(join(blocked, 'config.toml'), 'r+')
    try {
      assert.throws(() => setupCodex({ updateSkill: true }))
      assert.equal(readFileSync(join(blocked, 'config.toml'), 'utf8'), blockedConfig)
      assert.equal(readFileSync(blockedSkill, 'utf8'), 'existing custom skill', 'rollback must restore an edited skill')
      assert.deepEqual(readdirSync(blocked).filter(name => name.endsWith('.bak') || name.endsWith('.tmp')), [])
      assert.deepEqual(readdirSync(join(blocked, 'skills', 'alaya-database')), ['SKILL.md'])
      assert.equal(inspectCodexSetup().ready, false)
    } finally { closeSync(held) }
    // The lock is released, so the same install succeeds once the file is free.
    assert.equal(setupCodex({ updateSkill: true }).installed, true)
    assert.equal(inspectCodexSetup().ready, true)
    assert.deepEqual(setupCodex().changed, [])
    assert.equal(readFileSync(join(blocked, 'config.toml'), 'utf8').startsWith(`${blockedConfig}\n# Alaya local memory (MCP stdio)\n`), true)
    assert.ok(parse(readFileSync(join(blocked, 'config.toml'), 'utf8')).mcp_servers['memory-vault'])
  }
  process.env.CODEX_HOME = home

  const lock = join(home, '.alaya-setup.lock')
  writeFileSync(lock, '')
  assert.throws(() => setupCodex(), /正在进行/)
  assert.throws(() => setupCodex(), /锁文件：/)
  assert.throws(() => setupCodex(), /确认没有其他安装进程/)
  rmSync(lock)
  const onlySkillHome = join(root, 'only-skill')
  process.env.CODEX_HOME = onlySkillHome
  assert.equal((await cli(['skill', 'install'])).code, 0)
  assert.ok(existsSync(join(onlySkillHome, 'skills/alaya-database/SKILL.md')))
  assert.ok(!existsSync(join(onlySkillHome, 'config.toml')))
  process.env.CODEX_HOME = ''
  assert.equal((await cli(['codex', 'status'])).code, 1)
  console.log('Codex setup: dry run, home, paths, TOML preservation, backup, conflict, idempotency, skill update, quick capture defaults, real MCP write/recall and integer validation passed')
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
}
