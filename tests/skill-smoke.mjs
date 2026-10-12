import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONFIG_DEFAULTS } from '../src/config.js'
import { LIMITS } from '../src/policy.js'
import { IMAGE_MAX_BYTES } from '../src/images.js'
import { GROUP_MAX_DEPTH } from '../src/store.js'
import { createMemoryVault } from '../src/core/vault.js'
import { buildTools } from '../src/tools.js'
import { runCli } from '../bin/memory-vault.mjs'

/** Frontmatter keys Codex skills understand; anything else is a typo waiting to be ignored. */
const KNOWN_FRONTMATTER_KEYS = ['name', 'description', 'allowed-tools', 'disable-model-invocation', 'user-invocable']

/** The skill file this package ships, resolved the same way `skill print` does. */
const SKILL_FILE = resolve('skills/alaya-database/SKILL.md')

/**
 * Parse the YAML frontmatter of a skill file — shallow, by design: the shipped
 * skill uses flat scalars only, so a line-oriented read is enough for the guard.
 * @param {string} text - The whole SKILL.md text.
 * @returns {Record<string, string>} The frontmatter keys and values.
 */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  assert.equal(lines[0], '---', 'SKILL.md must open with a frontmatter delimiter')
  const end = lines.indexOf('---', 1)
  assert.ok(end > 1, 'SKILL.md frontmatter must be closed')
  const fields = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z-]*):\s?(.*)$/.exec(line)
    if (match) fields[match[1]] = match[2].trim()
  }
  return fields
}

/** Capture one CLI invocation's stdout/stderr alongside its exit code. */
async function cli(argv) {
  let out = '', err = ''
  const code = await runCli(argv, { stdout: text => { out += text }, stderr: text => { err += text } })
  return { code, out, err }
}

// 1. The shipped skill is a valid Codex skill: directory name matches the
//    frontmatter name, the description states when to use it, and no unknown
//    frontmatter keys hide typos.
const skillText = readFileSync(SKILL_FILE, 'utf8')
const frontmatter = parseFrontmatter(skillText)
assert.equal(frontmatter.name, 'alaya-database', 'frontmatter name must match the directory name')
assert.ok(frontmatter.description.length >= 40, 'description must state when to use the skill')
for (const key of Object.keys(frontmatter)) {
  assert.ok(KNOWN_FRONTMATTER_KEYS.includes(key), `unknown frontmatter key "${key}"`)
}

// 2. Every memory_* tool the skill names must exist in the MCP tool set, and
//    every MCP tool must be taught — a renamed tool and a silently dropped
//    chapter are both drift this guard refuses.
const vault = createMemoryVault({ databasePath: ':memory:' })
try {
  const mcpTools = buildTools({ ...vault, summarize: request => vault.summarize({ ...request, source: 'model-write' }) })
    .map(definition => definition.name)
  mcpTools.push('memory_context')
  const mentioned = [...new Set(skillText.match(/memory_[a-z_]+/g) ?? [])]
  for (const name of mentioned) {
    assert.ok(mcpTools.includes(name), `SKILL.md mentions "${name}" which is not an MCP tool`)
  }
  for (const name of mcpTools) {
    assert.ok(mentioned.includes(name), `SKILL.md never teaches the MCP tool "${name}"`)
  }
} finally {
  vault.dispose()
}

// 2b. The numbers the skill teaches must track the constants the code
//     enforces, so tuning a limit without updating the skill turns this red.
const numberFacts = [
  `${String(CONFIG_DEFAULTS.maxEntryChars)} 字符`,
  `${String(LIMITS.title)} 字符`,
  `${String(LIMITS.tag)} 字符`,
  `${String(LIMITS.tags)} 个标签`,
  `${String(LIMITS.batch)} 条`,
  `${String(CONFIG_DEFAULTS.applyMaxEntries)} 条`,
  `${String(CONFIG_DEFAULTS.applyMaxChars)} 字符`,
  `${String(CONFIG_DEFAULTS.searchLimit)} 条`,
  `${String(GROUP_MAX_DEPTH)} 层`,
  `${String(IMAGE_MAX_BYTES / (1024 * 1024))} MB`,
]
for (const fact of numberFacts) {
  assert.ok(skillText.includes(fact), `SKILL.md no longer states "${fact}" — the constant moved and the skill did not`)
}

// 3. `skill` never opens the database: with MEMORY_VAULT_DB pointing at a path
//    that must not come into existence, every skill subcommand still succeeds.
const dir = mkdtempSync(join(tmpdir(), 'memory-vault-skill-'))
const untouchedDb = join(dir, 'must-not-exist.sqlite')
const previousDb = process.env.MEMORY_VAULT_DB
process.env.MEMORY_VAULT_DB = untouchedDb
try {
  const printed = await cli(['skill', 'print'])
  assert.equal(printed.code, 0, printed.err)
  assert.equal(JSON.parse(printed.out).content, skillText, 'skill print returns the shipped file verbatim')
  assert.ok(!existsSync(untouchedDb), 'skill print must not create a database')

  const located = await cli(['skill', 'path'])
  assert.equal(located.code, 0, located.err)
  assert.equal(JSON.parse(located.out).path, SKILL_FILE)

  const helped = await cli(['help'])
  assert.equal(helped.code, 0)
  assert.ok(helped.out.includes('skill'), 'usage lists the skill command')

  const bogus = await cli(['skill', 'detonate'])
  assert.equal(bogus.code, 1)
  assert.ok(bogus.err.includes('print / path / install'))

  const root = join(dir, 'skills')
  const first = await cli(['skill', 'install', '--dir', root])
  assert.equal(first.code, 0, first.err)
  assert.equal(JSON.parse(first.out).overwritten, false, 'a fresh install is not an overwrite')
  const installedPath = join(root, 'alaya-database', 'SKILL.md')
  assert.ok(existsSync(installedPath), 'skill install writes SKILL.md under --dir')
  assert.equal(readFileSync(installedPath, 'utf8'), skillText, 'installed copy matches the source')

  const again = await cli(['skill', 'install', '--dir', root])
  assert.equal(again.code, 0, again.err)
  assert.equal(JSON.parse(again.out).overwritten, true, 'reinstall reports the overwrite')
  assert.equal(readFileSync(installedPath, 'utf8'), skillText, 'install is idempotent')

  const emptyDir = await cli(['skill', 'install', '--dir', ''])
  assert.equal(emptyDir.code, 1, 'an empty --dir must be refused, not installed into the working directory')
  assert.ok(emptyDir.err.includes('--dir 不能为空值'))

  assert.ok(!existsSync(untouchedDb), 'no skill subcommand may create a database')
} finally {
  if (previousDb === undefined) delete process.env.MEMORY_VAULT_DB
  else process.env.MEMORY_VAULT_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}

console.log('skill: frontmatter, tool-name drift guard, database-free install and idempotency passed')
