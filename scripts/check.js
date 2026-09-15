// Syntax-check every shipped module with Node's own parser.
// The file list is walked, not hand-written: the previous hand-maintained list
// still named the pre-unification `canvas.js` at the repo root long after the
// engine merge moved it to `src/`, so `pnpm run build` had been failing.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

// The page names its entry by URL, which is a second spelling of a fact the
// allowlist already carries. A mismatch is a canvas that never boots — and
// nothing else here would notice, because the module exists, is served, and is
// simply never asked for. The two side assets have the same shape: named by the
// page, served by a route of their own, checked by nothing.
const entryMatch = /<script type="module" src="\/dsh-flow\/src\/([^"]+)"/.exec(source)
if (entryMatch === null) fail(['the canvas page names no module entry — the canvas would render nothing'])
if (!served.has(entryMatch[1])) {
  fail([`the canvas page loads /dsh-flow/src/${entryMatch[1]}, which is not in CANVAS_SRC_FILES`])
}
for (const asset of ['engine.js', 'theme.css']) {
  if (!existsSync(join(root, asset))) fail([`the canvas page loads /dsh-flow/${asset}, which does not exist`])
}

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

// The layers, and what each one exists to keep.
//
// A boundary nobody checks decays into a folder. The pure core got this
// treatment first because its breakage is the quietest — a rules module that
// reaches for `node:fs` passes every test in plain Node and fails only in a
// browser. Every other layer gets the same discipline here, for the same
// reason: the invariant *is* the boundary, and the directory is only where the
// boundary lives.
//
//   pure     no IO, no host context — importable by plain Node
//   browser  served to the canvas, so it may not reach for anything Node-only
//   host     exists for the Node side and must never be served
const LAYERS = Object.freeze([
  { name: 'rules', entry: 'rules/index.js', pure: true, browser: true, host: false, entryNote: 'the pure core' },
  { name: 'canvas', entry: 'canvas/canvas.js', pure: false, browser: true, host: false, entryNote: 'the page the browser boots from' },
  { name: 'store', entry: 'store/index.js', pure: false, browser: false, host: true, entryNote: 'the team store and its two dependency sets' },
  { name: 'sources', entry: 'sources/sources.js', pure: false, browser: false, host: true, entryNote: 'the source registry' },
  { name: 'runner', entry: 'runner/interface.js', pure: false, browser: false, host: true, entryNote: 'the executor seam, which both implementations satisfy' },
  { name: 'tools', entry: 'tools/index.js', pure: false, browser: false, host: true, entryNote: 'every model-facing tool' },
  { name: 'config', entry: 'config/profile-registry.js', pure: false, browser: false, host: true, entryNote: 'what a deployment configures' },
])

const layerOf = name => LAYERS.find(layer => name.startsWith(`${layer.name}/`))

// Comments are prose, not code: a header explaining "the pure core must not know
// the host ctx" must not itself trip the ctx rule.
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/**
 * Every module specifier a file names.
 *
 * All three forms, because the difference is invisible to a reader and total to
 * a checker: `import './actions.js'` is a dependency exactly as much as
 * `import { x } from './actions.js'`, and a rule that only looked for `from`
 * would let a side-effect import cross any boundary it liked. This was not
 * hypothetical — the first version of this checker missed
 * `import 'node:fs'` in a browser-served module, which is precisely the thing
 * the rule exists to refuse.
 *
 * @param text - the module source, comments already stripped.
 * @returns the specifiers, in source order, duplicates included.
 */
function specifiersOf(text) {
  const found = []
  for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.push(match[1])
  for (const match of text.matchAll(/(?:^|[\s;])import\s+['"]([^'"]+)['"]/g)) found.push(match[1])
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1])
  return found
}

const problems = []

for (const layer of LAYERS) {
  // A layer nobody can point at is not a layer. The entry is what a reader opens
  // first, so its absence means the boundary is not where the documentation says
  // it is — which is how a boundary stops being one.
  if (!modules.has(layer.entry)) {
    problems.push(`src/${layer.entry} is missing — it is the ${layer.name} layer's entry (${layer.entryNote})`)
  }
}

// An allowlist entry with no file behind it serves a 404 forever and is invisible
// until someone opens the page. The other direction is checked per module below.
for (const name of served) {
  if (!modules.has(name)) problems.push(`CANVAS_SRC_FILES names src/${name}, which does not exist`)
}

for (const [name, module] of modules) {
  const layer = layerOf(name)
  if (layer === undefined) {
    problems.push(`src/${name} is not inside any declared layer — a module outside every boundary has none`)
    continue
  }
  const code = stripComments(module)
  const specifiers = specifiersOf(code)
  const targets = specifiers.filter(specifier => specifier.startsWith('.')).map(specifier => resolveFrom(name, specifier))
  const usesNode = specifiers.some(specifier => specifier.startsWith('node:'))

  if (layer.host) {
    // The allowlist is a serve boundary, so "forgot to remove it" is a failure
    // too, in the opposite direction from a missing entry.
    if (served.has(name)) problems.push(`src/${name} is host-only and must not be served to the canvas`)
  } else if (!served.has(name)) {
    problems.push(`src/${name} is not in CANVAS_SRC_FILES (import would 404)`)
  }

  if (layer.browser && usesNode) {
    problems.push(`src/${name} imports a node: builtin — this layer is served to a browser, which has none`)
  }
  if (layer.pure) {
    if (usesNode) problems.push(`src/${name} imports a node: builtin — the rules core must stay IO-free`)
    if (/\bctx\b/.test(code)) problems.push(`src/${name} references \`ctx\` — the rules core must not know the host`)
  }

  for (const target of targets) {
    if (!modules.has(target)) {
      problems.push(`src/${name} imports '${target}', which resolves to no file`)
      continue
    }
    const targetLayer = layerOf(target)
    if (targetLayer === undefined) {
      problems.push(`src/${name} imports src/${target}, which is not inside any declared layer`)
      continue
    }
    if (layer.pure && targetLayer.name !== layer.name) {
      problems.push(`src/${name} imports src/${target} from outside src/rules/ — dependencies point inward only`)
    }
    // The canvas is the outer edge. It reads the pure core — it renders from the
    // same rules the host applies — and nothing else: team data reaches it over
    // HTTP, so importing a host layer would be a boundary crossed rather than a
    // dependency taken.
    if (layer.name === 'canvas' && targetLayer.name !== 'canvas' && targetLayer.name !== 'rules') {
      problems.push(`src/${name} imports src/${target} — the canvas reads the pure core and nothing else`)
    }
    // And nothing points back out at the canvas: it is a leaf, not a library.
    if (layer.name !== 'canvas' && targetLayer.name === 'canvas') {
      problems.push(`src/${name} imports src/${target} — nothing may depend on the canvas`)
    }
  }
}

if (problems.length > 0) fail(problems)
console.log(`dsh-flow: ${modules.size} modules across ${LAYERS.length} layers respect their boundaries`)
console.log(`dsh-flow: ${served.size} of them are served to the canvas, and every one of them resolves`)

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
