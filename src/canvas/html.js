// The one escaping primitive. It lives apart from core.js because core.js reads
// `document` at module scope, which would make the markdown parser — a pure
// function over strings — unimportable outside a browser, and therefore
// untestable under `node --test`.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))

export { escapeHtml }

// Select one session family without leaking unrelated conversations in the same cwd.
export function sessionFamily(threads, sessionId, scope = 'session') {
  if (scope === 'workspace') return threads
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  let root = threads.find(thread => thread.dshSessionId === sessionId)
  if (!root) return []
  const ancestors = new Set([root.id])
  while (byId.has(root.parentId) && !ancestors.has(root.parentId)) {
    root = byId.get(root.parentId)
    ancestors.add(root.id)
  }
  const included = new Set([root.id])
  let changed = true
  while (changed) {
    changed = false
    for (const thread of threads) {
      if (!included.has(thread.id) && included.has(thread.parentId)) {
        included.add(thread.id)
        changed = true
      }
    }
  }
  return threads.filter(thread => included.has(thread.id))
}
