// The one escaping primitive. It lives apart from core.js because core.js reads
// `document` at module scope, which would make the markdown parser — a pure
// function over strings — unimportable outside a browser, and therefore
// untestable under `node --test`.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))

export { escapeHtml }
