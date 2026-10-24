import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { exerciseMcp } from './mcp-smoke.mjs'
import { inspectCodexPlugin } from '../src/codex.js'

// fs.cpSync silently copies nothing when the destination has a non-ASCII name on
// Windows, and the point here is a plugin root with a space and Chinese
// characters, so walk the tree by hand.
function copyTree(from, to) {
  if (!existsSync(to)) mkdirSync(to, { recursive: true })
  for (const item of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, item.name), target = join(to, item.name)
    if (item.isDirectory()) copyTree(source, target)
    else copyFileSync(source, target)
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const manifest = json('.codex-plugin/plugin.json')
const pkg = json('package.json')
const marketplace = json('.agents/plugins/marketplace.json')

// The manifest is read by Codex itself, so hold it to the fields a real
// codex-cli resolves (verified against codex-cli 0.163.0-alpha.11.1: marketplace
// add, plugin add, plugin list and mcp list all accept this file). An
// undocumented key here would be a claim nothing verifies.
const manifestKeys = new Set(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'skills', 'mcpServers', 'interface', 'apps', 'hooks', 'extensions'])
assert.deepEqual(Object.keys(manifest).filter(key => !manifestKeys.has(key)), [], 'unknown manifest keys')
assert.ok(!('requires_local_executor' in manifest), 'unverified launch gate must not be declared')
assert.equal(manifest.name, pkg.name)
assert.equal(manifest.version, pkg.version)
assert.equal(manifest.skills, './skills/')
assert.ok(existsSync(join(root, manifest.skills, 'alaya-database/SKILL.md')))
const frontmatter = readFileSync(join(root, manifest.skills, 'alaya-database/SKILL.md'), 'utf8').split('---')[1] ?? ''
assert.match(frontmatter, /^name:\s*alaya-database$/m, 'skill name must match its folder')
assert.match(frontmatter, /^description:\s*\S/m, 'skill description drives discovery')
assert.equal(manifest.mcpServers, './.mcp.json')
assert.equal(manifest.interface.displayName, 'Alaya Database')
assert.deepEqual(manifest.interface.capabilities, ['Read', 'Write'])
assert.equal(manifest.interface.category, 'Productivity')
assert.ok(manifest.interface.shortDescription.length <= 80)
assert.ok(manifest.interface.defaultPrompt.length >= 1 && manifest.interface.defaultPrompt.every(item => item.trim()))
for (const key of ['homepage', 'repository', 'author']) assert.ok(manifest[key], `${key} must be factual or absent`)

// Portability: Codex joins `cwd` onto the installed plugin root and then runs
// `args` there (verified: `cwd: "."` resolves to
// <codex home>/plugins/cache/<marketplace>/<plugin>/<version>). A placeholder
// such as ${PLUGIN_ROOT} is only substituted in some fields, so a cwd built from
// it resolved to a directory that does not exist and the server could not start.
const servers = json(manifest.mcpServers).mcpServers
assert.deepEqual(Object.keys(servers), ['memory-vault'])
const launch = servers['memory-vault']
assert.equal(launch.command, 'node')
assert.equal(launch.cwd, '.')
assert.deepEqual(launch.args, ['bin/memory-vault.mjs', 'mcp'])
for (const value of [launch.cwd, ...launch.args]) {
  assert.ok(!value.includes('$'), `no placeholder may appear in the launch descriptor: ${value}`)
  assert.ok(!isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value), `no absolute path in the launch descriptor: ${value}`)
}
assert.equal(launch.env, undefined, 'no machine-specific environment or secrets in the bundle')
assert.ok(launch.env_vars.every(name => /^[A-Z][A-Z0-9_]*$/.test(name)))
assert.equal(new Set(launch.env_vars).size, launch.env_vars.length, 'env_vars must not repeat')
assert.ok(launch.env_vars.includes('MEMORY_VAULT_DB'), 'the vault override has to reach the server')

// A local marketplace makes this repository installable with
// `codex plugin marketplace add <repo>` + `codex plugin add alaya-database@alaya`.
assert.equal(marketplace.name, 'alaya')
assert.equal(marketplace.interface.displayName, 'Alaya')
assert.equal(marketplace.plugins.length, 1)
const listed = marketplace.plugins[0]
assert.equal(listed.name, manifest.name)
assert.deepEqual(listed.source, { source: 'local', path: '.' })
assert.equal(listed.policy.installation, 'AVAILABLE')
assert.equal(listed.policy.authentication, 'ON_INSTALL')

for (const path of ['.codex-plugin', '.mcp.json', '.agents', 'skills', 'bin', 'src', 'docs']) {
  assert.ok(pkg.files.includes(path), `npm package must include ${path}`)
}

// `codex plugin` is the read-only entry point: it reports the same facts the
// client would resolve, plus the exact install commands, without touching any
// configuration or database.
const report = inspectCodexPlugin({ pluginRoot: root })
assert.equal(report.ready, true)
assert.deepEqual(report.problems, [])
assert.equal(report.plugin, pkg.name)
assert.equal(report.version, pkg.version)
assert.equal(report.marketplace, marketplace.name)
assert.match(report.commands.addMarketplace, /^codex plugin marketplace add ".*"$/)
assert.equal(report.commands.install, `codex plugin add ${pkg.name}@${marketplace.name}`)
const brokenRoot = join(mkdtempSync(join(tmpdir(), 'alaya-plugin-broken-')), 'broken plugin')
mkdirSync(join(brokenRoot, '.codex-plugin'), { recursive: true })
writeFileSync(join(brokenRoot, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'alaya-database', version: '0.0.1', skills: './skills/', mcpServers: './.mcp.json' }))
writeFileSync(join(brokenRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'memory-vault': { command: 'node', args: ['${PLUGIN_ROOT}/bin/memory-vault.mjs', 'mcp'], cwd: '${PLUGIN_ROOT}' } } }))
writeFileSync(join(brokenRoot, 'package.json'), JSON.stringify({ name: 'alaya-database', version: pkg.version }))
const broken = inspectCodexPlugin({ pluginRoot: brokenRoot })
assert.equal(broken.ready, false)
assert.ok(broken.problems.some(problem => problem.includes('cwd')), 'a placeholder cwd must be reported')
assert.ok(broken.problems.some(problem => problem.includes('占位符')))
assert.ok(broken.problems.some(problem => problem.includes('版本')))
rmSync(dirname(brokenRoot), { recursive: true, force: true })

const temporary = mkdtempSync(join(tmpdir(), 'alaya-plugin-'))
try {
  // Relocate the bundle the way the client's cache copy does, then launch the
  // descriptor exactly as Codex resolves it: the plugin root becomes the process
  // cwd and the relative script path is resolved there by Node. The copy has no
  // node_modules, so this also proves the MCP path needs nothing but Node itself.
  const relocated = join(temporary, 'relocated plugin root 中文')
  mkdirSync(relocated, { recursive: true })
  copyFileSync(join(root, '.mcp.json'), join(relocated, '.mcp.json'))
  for (const entry of ['.codex-plugin', 'bin', 'src', 'skills']) copyTree(join(root, entry), join(relocated, entry))
  const cwd = resolve(relocated, launch.cwd)
  const script = resolve(cwd, launch.args[0])
  assert.ok(existsSync(script), 'the launch target must exist inside the bundle')
  assert.ok(script.startsWith(relocated), 'the launch target must stay inside the plugin root')
  await exerciseMcp(launch.command, launch.args, join(temporary, 'plugin-test.sqlite'), {}, { cwd })
  console.log('Codex plugin: manifest schema, portable launch descriptor, marketplace entry, read-only plugin report, npm bundle and a real MCP write/recall from a relocated plugin root passed')
} finally { rmSync(temporary, { recursive: true, force: true }) }
