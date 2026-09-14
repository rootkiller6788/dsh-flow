// Syntax-check every shipped module with Node's own parser.
// The file list is walked, not hand-written: the previous hand-maintained list
// still named the pre-unification `canvas.js` at the repo root long after the
// engine merge moved it to `src/`, so `pnpm run build` had been failing.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.name.endsWith('.js') ? [path] : []
  })
}

const files = walk(root).sort()
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
console.log(`dsh-flow: ${files.length} modules parse clean`)

// The canvas is served from an explicit allowlist in index.js, so adding a
// module means editing two places. Forgetting the second one 404s the import
// and the canvas never boots — a failure that shows up only in the browser, not
// in `node --check`. Assert the invariant here instead.
const source = readFileSync(join(root, 'index.js'), 'utf8')
const listMatch = /const CANVAS_SRC_FILES = \[([^\]]*)\]/.exec(source)
if (listMatch === null) {
  console.error('dsh-flow: CANVAS_SRC_FILES not found in index.js')
  process.exit(1)
}
const served = new Set(listMatch[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(part => part !== ''))
const problems = []
for (const name of readdirSync(join(root, 'src'))) {
  if (!name.endsWith('.js')) continue
  if (!served.has(name)) problems.push(`src/${name} is not in CANVAS_SRC_FILES (import would 404)`)
  const module = readFileSync(join(root, 'src', name), 'utf8')
  for (const [, target] of module.matchAll(/from '\.\/([^']+)'/g)) {
    if (!served.has(target)) problems.push(`src/${name} imports ./${target}, which is not served`)
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`dsh-flow: ${problem}`)
  process.exit(1)
}
console.log(`dsh-flow: ${served.size} canvas modules served, all relative imports resolve`)

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
if (colourLeaks.length > 0) {
  for (const leak of colourLeaks) console.error(`dsh-flow: theme.css:${leak} — literal colour outside the token blocks`)
  process.exit(1)
}
console.log('dsh-flow: theme.css has no literal colours outside its token blocks')
