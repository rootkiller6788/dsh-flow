// Syntax-check every shipped module with Node's own parser.
// The file list is walked, not hand-written: the previous hand-maintained list
// still named the pre-unification `canvas.js` at the repo root long after the
// engine merge moved it to `src/`, so `pnpm run build` had been failing.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = messages => {
  for (const message of messages) console.error(`dsh-flow: ${message}`)
  process.exit(1)
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path)
    return /\.m?js$/.test(entry.name) ? [path] : []
  })
}

const files = walk(root).sort()
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
console.log(`dsh-flow: ${files.length} modules parse clean`)

// Every module under src/ is served over HTTP, so it must appear in the
// allowlist in index.js. Adding a module means editing two places; forgetting
// the second 404s the import and the canvas never boots — a failure visible
// only in the browser, never in `node --check`. Assert it here instead.
const source = readFileSync(join(root, 'index.js'), 'utf8')
const listMatch = /const CANVAS_SRC_FILES = \[([^\]]*)\]/.exec(source)
if (listMatch === null) fail(['CANVAS_SRC_FILES not found in index.js'])
const served = new Set(listMatch[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(part => part !== ''))

// `readdirSync(recursive)` reports platform separators; module specifiers in the
// allowlist are always POSIX, so normalise before comparing.
const srcModules = readdirSync(join(root, 'src'), { recursive: true })
  .filter(name => name.endsWith('.js'))
  .map(name => name.split(sep).join('/'))
  .sort()

const modules = new Map()
for (const name of srcModules) modules.set(name, readFileSync(join(root, 'src', name), 'utf8'))

/** Resolve a relative specifier against the importing module's directory. */
function resolveFrom(importer, specifier) {
  const parts = importer.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

// Some src modules are host-only and must NOT be served: they exist for the
// Node side and have no business reaching a browser. The allowlist is a serve
// boundary, so "forgot to add it" and "added it by mistake" are both failures,
// in opposite directions.
const SERVER_ONLY_PREFIXES = ['runner/', 'tools/']

const problems = []
for (const [name, module] of modules) {
  if (SERVER_ONLY_PREFIXES.some(prefix => name.startsWith(prefix))) {
    if (served.has(name)) problems.push(`src/${name} is host-only and must not be served to the canvas`)
    continue
  }
  if (!served.has(name)) problems.push(`src/${name} is not in CANVAS_SRC_FILES (import would 404)`)
  for (const [, specifier] of module.matchAll(/from '(\.[^']+)'/g)) {
    const target = resolveFrom(name, specifier)
    if (!modules.has(target)) problems.push(`src/${name} imports '${specifier}', which resolves to no file`)
    else if (!served.has(target)) problems.push(`src/${name} imports '${specifier}', which is not served`)
  }
}
if (problems.length > 0) fail(problems)
console.log(`dsh-flow: ${served.size} canvas modules served, all relative imports resolve`)

// The rules directory is the pure core: no IO, no host context, no dependency
// on anything outside itself. It must stay importable and testable in plain
// Node, which is what the markdown parser's extraction bought us — assert the
// boundary rather than trusting it.
// Comments are prose, not code: a header explaining "the pure core must not know
// the host ctx" must not itself trip the ctx rule.
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const RULES_PREFIX = 'rules/'
const boundary = []
for (const [name, module] of modules) {
  if (!name.startsWith(RULES_PREFIX)) continue
  const code = stripComments(module)
  if (/from 'node:/.test(code)) boundary.push(`src/${name} imports a node: builtin — the rules core must stay IO-free`)
  if (/\bctx\b/.test(code)) boundary.push(`src/${name} references \`ctx\` — the rules core must not know the host`)
  for (const [, specifier] of module.matchAll(/from '(\.[^']+)'/g)) {
    if (!resolveFrom(name, specifier).startsWith(RULES_PREFIX)) {
      boundary.push(`src/${name} imports '${specifier}' from outside src/rules/ — dependencies point inward only`)
    }
  }
}
if (boundary.length > 0) fail(boundary)
console.log(`dsh-flow: ${modules.size > 0 ? [...modules.keys()].filter(n => n.startsWith(RULES_PREFIX)).length : 0} rules-core modules honour the pure-core boundary`)

// DESIGN.md's first rule is "components reference tokens, never literal
// colours". A documented rule nobody runs is a rule that decays, so it is
// asserted here: every hex/rgb literal must sit inside a token block at the top
// of theme.css (`:root { ... }` / `:root[data-theme="dark"] { ... }`).
const css = readFileSync(join(root, 'theme.css'), 'utf8').split(/\r?\n/)
let inTokens = false
const colourLeaks = []
css.forEach((line, at) => {
  if (at > 0 && /^:root/.test(line)) inTokens = true
  if (/^\}/.test(line)) inTokens = false
  if (!inTokens && /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) colourLeaks.push(`${at + 1}: ${line.trim()}`)
})
if (colourLeaks.length > 0) fail(colourLeaks.map(leak => `theme.css:${leak} — literal colour outside the token blocks`))
console.log('dsh-flow: theme.css has no literal colours outside its token blocks')
