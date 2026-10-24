/**
 * Install the plugin the way a user would, using the real Codex CLI.
 *
 * Everything runs against a throwaway CODEX_HOME and a throwaway database, so
 * the user's own Codex configuration and memory are never touched. The CLI is
 * optional for this repository: when no `codex` binary is available the test
 * reports that it skipped instead of failing. No model turn is executed — the
 * steps here are marketplace/plugin/config commands plus one stdio MCP call.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'
import { exerciseMcp } from './mcp-smoke.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pluginId = 'alaya-database@alaya'

function findCodex() {
  const candidates = [process.env.ALAYA_CODEX_BIN, join(homedir(), '.codex', 'plugins', '.plugin-appserver', process.platform === 'win32' ? 'codex.exe' : 'codex')].filter(Boolean)
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' })
  if (which.status === 0) candidates.push(...which.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 60000 })
    if (probe.status === 0 && /^codex-cli /m.test(probe.stdout)) return candidate
  }
  return null
}

const codex = findCodex()
if (!codex) {
  console.log('Codex CLI: skipped (no `codex` binary found; set ALAYA_CODEX_BIN to run the real-client install checks)')
  process.exit(0)
}

const home = join(mkdtempSync(join(tmpdir(), 'alaya-codex-cli-')), 'codex home')
const databasePath = join(mkdtempSync(join(tmpdir(), 'alaya-codex-cli-db-')), 'vault space 中文.sqlite')
const workspace = mkdtempSync(join(tmpdir(), 'alaya-codex-cli-ws-'))
const configPath = join(home, 'config.toml')
mkdirSync(home, { recursive: true })
const environment = { ...process.env, CODEX_HOME: home, MEMORY_VAULT_DB: databasePath }
// Strip a Windows extended-length prefix and trailing separators before comparing.
const same = (left, right) => resolve(left.replace(/^\\\\\?\\/, '')) === resolve(right.replace(/^\\\\\?\\/, ''))
const run = args => {
  const result = spawnSync(codex, args, { cwd: workspace, encoding: 'utf8', env: environment, timeout: 120000 })
  assert.equal(result.error, undefined, String(result.error))
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}
const ok = args => {
  const result = run(args)
  assert.equal(result.code, 0, `${codex} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`)
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}
const readConfig = () => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '')

try {
  // 1. A marketplace add must leave unrelated configuration untouched.
  const original = '# unrelated comment\nmodel = "example"\n'
  writeFileSync(configPath, original)
  const added = ok(['plugin', 'marketplace', 'add', root, '--json'])
  assert.equal(added.marketplaceName, 'alaya')
  assert.equal(added.alreadyAdded, false)
  assert.ok(same(added.installedRoot, root), `marketplace root: ${added.installedRoot}`)
  assert.ok(readConfig().startsWith(original), 'existing config must be preserved byte for byte')
  assert.equal(ok(['plugin', 'marketplace', 'add', root, '--json']).alreadyAdded, true, 'a repeat add must be a no-op')
  assert.ok(readConfig().startsWith(original))

  // 2. The plugin shows up in the marketplace with this package's version.
  const available = ok(['plugin', 'list', '--json', '--available'])
  const listed = available.available.find(item => item.pluginId === pluginId)
  assert.ok(listed, `marketplace must list ${pluginId}`)
  assert.equal(listed.version, pkg.version, 'manifest version must track package.json')
  assert.equal(listed.installPolicy, 'AVAILABLE')
  assert.equal(listed.installed, false)

  // 3. Install, then repeat: the second install changes nothing.
  const installed = ok(['plugin', 'add', pluginId, '--json'])
  assert.equal(installed.pluginId, pluginId)
  assert.equal(installed.version, pkg.version)
  assert.ok(existsSync(installed.installedPath), `installed copy missing: ${installed.installedPath}`)
  const afterInstall = readConfig()
  assert.ok(afterInstall.startsWith(original))
  const configuration = parse(afterInstall)
  assert.equal(configuration.marketplaces.alaya.source_type, 'local')
  assert.ok(same(configuration.marketplaces.alaya.source, root))
  assert.equal(configuration.plugins[pluginId].enabled, true)
  const reinstalled = ok(['plugin', 'add', pluginId, '--json'])
  assert.equal(reinstalled.installedPath, installed.installedPath)
  assert.equal(readConfig(), afterInstall, 'a repeat install must not rewrite the config')

  const enabled = ok(['plugin', 'list', '--json']).installed.find(item => item.pluginId === pluginId)
  assert.equal(enabled.installed, true)
  assert.equal(enabled.enabled, true)

  // 4. Codex resolves the plugin's MCP entry against the installed copy. This is
  // the check that catches a launch descriptor which only works in the source
  // checkout: cwd must be the cache path, and no placeholder may survive.
  const servers = ok(['mcp', 'list', '--json'])
  const server = servers.find(item => item.name === 'memory-vault')
  assert.ok(server, 'the plugin must contribute memory-vault')
  assert.equal(server.enabled, true)
  assert.equal(server.transport.type, 'stdio')
  assert.equal(server.transport.command, 'node')
  assert.deepEqual(server.transport.args, ['bin/memory-vault.mjs', 'mcp'])
  assert.ok(same(server.transport.cwd, installed.installedPath), `cwd must be the installed plugin root, got ${server.transport.cwd}`)
  assert.ok(!`${server.transport.cwd}${server.transport.args.join('')}`.includes('$'), 'unexpanded placeholder in the resolved launch descriptor')
  assert.ok(server.transport.env_vars.includes('MEMORY_VAULT_DB'))

  // 5. Launch that resolved descriptor against a temporary database: quick
  // capture and read back, exactly as Codex would start the server.
  await exerciseMcp(server.transport.command, server.transport.args, databasePath, {}, { cwd: installed.installedPath })

  // 6. Removal is clean, and an unknown plugin is refused without writing.
  const removed = ok(['plugin', 'remove', pluginId, '--json'])
  const afterRemove = parse(readConfig())
  assert.equal(afterRemove.plugins?.[pluginId], undefined)
  assert.equal(afterRemove.marketplaces.alaya.source_type, 'local', 'the marketplace stays configured')
  assert.ok(!existsSync(installed.installedPath), `plugin copy should be gone: ${removed.installedPath ?? installed.installedPath}`)
  const beforeRefusal = readConfig()
  const refused = run(['plugin', 'add', 'alaya-missing@alaya', '--json'])
  assert.notEqual(refused.code, 0, 'an unknown plugin must fail')
  assert.equal(readConfig(), beforeRefusal, 'a failed install must not write the config')

  const marketplaces = run(['plugin', 'marketplace', 'list'])
  assert.equal(marketplaces.code, 0, marketplaces.stderr)
  assert.match(marketplaces.stdout, /^alaya\s/m, 'marketplace list must report the configured source')
  console.log(`Codex CLI: marketplace add/idempotency, plugin add/remove, config preservation, resolved MCP descriptor and a real MCP write/recall passed (${codex})`)
} finally {
  rmSync(dirname(home), { recursive: true, force: true })
  rmSync(dirname(databasePath), { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
