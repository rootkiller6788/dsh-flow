// Workspace path scope. Ported from `dsh-agent-teams/src/quality-gates.ts`
// (`normalizeWorkspacePath`, `pathMatchesScope`, `isDefaultExcluded`,
// `classifyChangedPath`, `collectChangedPaths`, `inScopeOverlap`).
//
// These decide whether a task stayed inside the files it declared it would
// touch. The rules are deny-by-default at two levels: a path that escapes the
// workspace is `illegal` outright, and a path nobody declared is `undeclared`
// rather than assumed fine.

/** Outcome of classifying one changed path against a task's declared scope. */
export const PATH_CLASSIFICATIONS = Object.freeze(['in_scope', 'out_of_scope', 'undeclared', 'illegal'])

/**
 * Normalize a workspace-relative POSIX path. `undefined` means illegal.
 *
 * Rejected outright: empty, home-anchored (`~`), drive-anchored (`C:`),
 * absolute, and anything containing a `..` segment — a changed-path list is
 * evidence about this workspace, and a path that could name something outside
 * it cannot be evidence.
 */
export function normalizeWorkspacePath(path) {
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('~') || /^[A-Za-z]:/.test(trimmed)) return undefined
  const posix = trimmed.replaceAll('\\', '/')
  if (posix.startsWith('/')) return undefined
  const parts = []
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  return parts.join('/')
}

/**
 * Whether a path falls under a scope pattern.
 *
 * A pattern ending in `/` (or `.` / `./`) names a directory and matches
 * everything beneath it; any other pattern must match the path exactly. A
 * pattern that is itself illegal matches nothing, with one exception kept from
 * the original: a bare `.` or `./` means "the whole workspace".
 */
export function pathMatchesScope(path, pattern) {
  const normalizedPath = normalizeWorkspacePath(path)
  if (normalizedPath === undefined) return false
  const rawPattern = pattern.trim().replaceAll('\\', '/')
  if (rawPattern.startsWith('~') || rawPattern.startsWith('/') || /^[A-Za-z]:/.test(rawPattern)) return false
  const directory = rawPattern.endsWith('/')
  const normalizedPattern = normalizeWorkspacePath(rawPattern)
  if (normalizedPattern === undefined) {
    if (directory && (rawPattern === './' || rawPattern === '/' || rawPattern === '.')) return true
    return false
  }
  if (directory || rawPattern === './' || rawPattern === '.') {
    if (normalizedPattern === '') return true
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`)
  }
  return normalizedPath === normalizedPattern
}

/**
 * Paths excluded regardless of what a task declared: version-control and
 * harness state, dotenv files, anything under a `secrets` segment, and SSH
 * private keys. A task cannot opt itself into touching these.
 */
export function isDefaultExcluded(path) {
  const normalized = normalizeWorkspacePath(path)
  if (normalized === undefined) return false
  const segments = normalized.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (segments[0] === '.git' || segments[0] === '.dsh') return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (segments.includes('secrets')) return true
  if (base.startsWith('id_rsa')) return true
  return false
}

/**
 * Classify one changed path against a task's declared scope.
 * @returns `illegal`, `out_of_scope`, `in_scope` or `undeclared`.
 */
export function classifyChangedPath(path, inScope = [], outOfScope = []) {
  if (normalizeWorkspacePath(path) === undefined) return 'illegal'
  if (isDefaultExcluded(path)) return 'out_of_scope'
  if (outOfScope.some(pattern => pathMatchesScope(path, pattern))) return 'out_of_scope'
  if (inScope.some(pattern => pathMatchesScope(path, pattern))) return 'in_scope'
  return 'undeclared'
}

/**
 * Extract workspace-relative paths from `git status` output.
 *
 * Handles rename lines (`old -> new`, taking the new path), the two-column
 * status prefix, and quoted paths. Duplicates collapse; unusable lines are
 * dropped rather than guessed at.
 */
export function collectChangedPaths(gitStatusText) {
  const paths = []
  const seen = new Set()
  for (const rawLine of gitStatusText.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    let candidate = line
    const rename = /->\s+(\S+)$/u.exec(line)
    if (/^[ MADRCU?!]{1,2}\s+/u.test(line)) {
      candidate = rename?.[1] ?? line.replace(/^[ MADRCU?!]{1,2}\s+/u, '')
    }
    const cleaned = candidate.replace(/^"|"$/gu, '').trim()
    const normalized = normalizeWorkspacePath(cleaned)
    if (normalized === undefined || seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return paths
}

/**
 * Declared scopes that overlap between two lists, matched in either direction
 * so `src/` and `src/a.js` are reported as colliding whichever way round they
 * appear.
 */
export function inScopeOverlap(left, right) {
  if (left === undefined || right === undefined) return []
  const hits = []
  for (const a of left) {
    for (const b of right) {
      if (pathMatchesScope(a, b) || pathMatchesScope(b, a) || a === b) {
        if (!hits.includes(a)) hits.push(a)
      }
    }
  }
  return hits
}
