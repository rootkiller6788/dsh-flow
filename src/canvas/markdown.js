// dsh-flow canvas — see src/canvas/canvas.js for the module map.
import { escapeHtml } from './html.js'


// ---------------------------------------------------------------------------
// Inline layer — a delimiter stack, not a brace of regexes
// ---------------------------------------------------------------------------
// Runs of * _ ~ are collected with CommonMark's flanking rules and each closer
// is paired back to the nearest eligible opener, so nesting, orphan runs, and
// runs that share a character all resolve the way a compliant parser resolves
// them. The regex approximation this replaces mispaired a lone `**` against
// text hundreds of characters away, which swallowed whole paragraphs into bold.
const PUNCTUATION = /\p{P}/u
const SPACE = /\s/
const isPunct = character => character !== undefined && PUNCTUATION.test(character)
const isSpace = character => character === undefined || SPACE.test(character)

// Only these schemes become anchors; anything else (javascript:, data:) is
// emitted as literal text. Model output is untrusted input to innerHTML.
const SAFE_SCHEME = /^(?:https?|mailto):/i
function linkHref(target) {
  let href = target.trim()
  const angled = /^<(.+)>$/.exec(href)
  if (angled !== null) href = angled[1].trim()
  else href = href.split(/\s+/)[0] ?? ''
  if (href === '') return null
  if (!SAFE_SCHEME.test(href) && !href.startsWith('#') && !href.startsWith('/') && !href.startsWith('./')) return null
  return escapeHtml(href)
}

// Depth-aware scan for a matching close, skipping backslash escapes.
function findClosing(text, from, open, close) {
  let depth = 1
  for (let at = from; at < text.length; at++) {
    const character = text[at]
    if (character === '\\') { at++; continue }
    if (character === open) depth++
    else if (character === close) { depth--; if (depth === 0) return at }
  }
  return -1
}

// A backtick run closes on a run of exactly the same length.
function findBacktickRun(text, from, length) {
  const needle = '`'.repeat(length)
  let at = text.indexOf(needle, from)
  while (at !== -1) {
    if (text[at - 1] !== '`' && text[at + length] !== '`') return at
    let end = at
    while (text[end] === '`') end++
    at = text.indexOf(needle, end)
  }
  return -1
}

function inlineHtml(text) {
  let head = null
  let tail = null
  let pending = ''
  const delimiters = []

  function append(node) {
    node.prev = tail
    node.next = null
    if (tail === null) head = node
    else tail.next = node
    tail = node
    return node
  }
  function detach(node) {
    if (node.prev === null) head = node.next
    else node.prev.next = node.next
    if (node.next === null) tail = node.prev
    else node.next.prev = node.prev
    node.prev = null
    node.next = null
  }
  function attachAfter(anchor, node) {
    node.prev = anchor
    node.next = anchor.next
    if (anchor.next === null) tail = node
    else anchor.next.prev = node
    anchor.next = node
    return node
  }
  function attachBefore(anchor, node) {
    node.next = anchor
    node.prev = anchor.prev
    if (anchor.prev === null) head = node
    else anchor.prev.next = node
    anchor.prev = node
    return node
  }
  const flush = () => {
    if (pending !== '') append({ literal: escapeHtml(pending), prev: null, next: null })
    pending = ''
  }

  let index = 0
  while (index < text.length) {
    const character = text[index]

    if (character === '\\' && /[!-/:-@[-`{-~]/.test(text[index + 1] ?? '')) {
      pending += text[index + 1]
      index += 2
      continue
    }

    if (character === '`') {
      let run = 0
      while (text[index + run] === '`') run++
      const close = findBacktickRun(text, index + run, run)
      if (close !== -1) {
        flush()
        const raw = text.slice(index + run, close).replace(/\n/g, ' ')
        const body = raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '' ? raw.slice(1, -1) : raw
        append({ literal: `<code>${escapeHtml(body)}</code>`, prev: null, next: null })
        index = close + run
        continue
      }
      pending += '`'.repeat(run)
      index += run
      continue
    }

    if (character === '<') {
      const close = text.indexOf('>', index + 1)
      const inner = close === -1 ? '' : text.slice(index + 1, close)
      if (close !== -1 && !/\s/.test(inner) && SAFE_SCHEME.test(inner)) {
        flush()
        append({ literal: `<a href="${escapeHtml(inner)}" target="_blank" rel="noreferrer noopener">${escapeHtml(inner)}</a>`, prev: null, next: null })
        index = close + 1
        continue
      }
      pending += character
      index++
      continue
    }

    // `!` before `[` means an image; we do not fetch remote images, so leave it.
    if (character === '[' && !pending.endsWith('!')) {
      const labelEnd = findClosing(text, index + 1, '[', ']')
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const targetEnd = findClosing(text, labelEnd + 2, '(', ')')
        const href = targetEnd === -1 ? null : linkHref(text.slice(labelEnd + 2, targetEnd))
        if (href !== null) {
          const label = inlineHtml(text.slice(index + 1, labelEnd))
          flush()
          append({ literal: `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`, prev: null, next: null })
          index = targetEnd + 1
          continue
        }
      }
      pending += character
      index++
      continue
    }

    if (character === '*' || character === '_' || character === '~') {
      let run = 0
      while (text[index + run] === character) run++
      const before = text[index - 1]
      const after = text[index + run]
      const leftFlanking = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before))
      const rightFlanking = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after))
      flush()
      const node = { literal: character.repeat(run), char: character, count: run, active: true, prev: null, next: null }
      // `_` may not open or close inside a word (that is what keeps snake_case
      // literal); `*` and `~` carry no such restriction.
      if (character === '_') {
        node.canOpen = leftFlanking && (!rightFlanking || isPunct(before))
        node.canClose = rightFlanking && (!leftFlanking || isPunct(after))
      } else {
        node.canOpen = leftFlanking
        node.canClose = rightFlanking
      }
      append(node)
      delimiters.push(node)
      index += run
      continue
    }

    pending += character
    index++
  }
  flush()

  for (let closerIndex = 0; closerIndex < delimiters.length; closerIndex++) {
    const closer = delimiters[closerIndex]
    if (!closer.active || !closer.canClose) continue
    while (closer.active && closer.count > 0) {
      let opener = null
      let openerIndex = -1
      for (let at = closerIndex - 1; at >= 0; at--) {
        const candidate = delimiters[at]
        if (!candidate.active || !candidate.canOpen || candidate.char !== closer.char || candidate.count === 0) continue
        if (closer.char === '~' && (candidate.count < 2 || closer.count < 2)) continue
        // Rule of three: when either run both opens and closes, their combined
        // length must not be a multiple of three unless both lengths are.
        if ((closer.canOpen || candidate.canClose) && (candidate.count + closer.count) % 3 === 0 && candidate.count % 3 !== 0) continue
        opener = candidate
        openerIndex = at
        break
      }
      if (opener === null) break
      const strong = closer.char === '~' || (opener.count >= 2 && closer.count >= 2)
      const tag = strong ? (closer.char === '~' ? 's' : 'strong') : 'em'
      const consumed = strong ? 2 : 1
      attachAfter(opener, { literal: `<${tag}>`, prev: null, next: null })
      attachBefore(closer, { literal: `</${tag}>`, prev: null, next: null })
      opener.count -= consumed
      closer.count -= consumed
      opener.literal = opener.char.repeat(opener.count)
      closer.literal = closer.char.repeat(closer.count)
      // Runs strictly between the pair can no longer match anything.
      for (let at = openerIndex + 1; at < closerIndex; at++) delimiters[at].active = false
      if (opener.count === 0) detach(opener)
      if (closer.count === 0) { detach(closer); closer.active = false }
    }
  }

  let html = ''
  for (let node = head; node !== null; node = node.next) html += node.literal
  return html
}


// ---------------------------------------------------------------------------
// Block layer
// ---------------------------------------------------------------------------
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/
const FENCE = /^(\s*)(`{3,}|~{3,})\s*(.*)$/
// `- - -` is a thematic break, not a nested list: the marker may repeat with
// spaces between.
const THEMATIC = /^\s*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^\s*>/
const ROW = /^\s*\|/
// Section marks models emit on their own line, kept as a configurable whitelist.
const SECTION_MARK = /^\s*[■□◆▲⇒]\s*/

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cell = ''
  for (let at = 0; at < trimmed.length; at++) {
    const character = trimmed[at]
    if (character === '\\' && trimmed[at + 1] === '|') { cell += '|'; at++; continue }
    if (character === '|') { cells.push(cell.trim()); cell = ''; continue }
    cell += character
  }
  cells.push(cell.trim())
  return cells
}

function isDelimiterRow(line, columns) {
  if (!line.includes('-')) return false
  const cells = splitRow(line)
  return cells.length === columns && cells.every(cell => /^:?-+:?$/.test(cell))
}

// Tight list items carry no <p> wrapper, but an item that also holds a nested
// list still renders its leading paragraph as one. Inline output cannot contain
// a block tag, so unwrapping just the first paragraph is always safe.
function unwrapLeadingParagraph(html) {
  if (!html.startsWith('<p>')) return html
  const close = html.indexOf('</p>')
  if (close === -1) return html
  return html.slice(3, close) + html.slice(close + 4)
}

// A fence closes on a run of the same character at least as long as the opener.
function isFenceClose(line, marker, length) {
  const trimmed = line.trim()
  if (trimmed.length < length) return false
  for (const character of trimmed) if (character !== marker) return false
  return true
}

function startsBlock(line) {
  const trimmed = line.trim()
  return trimmed === '' || FENCE.test(line) || THEMATIC.test(line) || SECTION_MARK.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || ROW.test(line)
}

const MAX_DEPTH = 8

function blockHtml(text, depth = 0) {
  if (depth > MAX_DEPTH) return `<p>${text.split('\n').map(escapeHtml).join('<br>')}</p>`
  const lines = text.split('\n')
  const output = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[2][0]
      const length = fence[2].length
      const info = fence[3].trim()
      const body = []
      index++
      while (index < lines.length) {
        if (isFenceClose(lines[index], marker, length)) { index++; break }
        body.push(lines[index++])
      }
      const language = /^[\w+#.-]+/.exec(info)?.[0] ?? ''
      output.push(`<pre><code${language === '' ? '' : ` class="language-${escapeHtml(language)}"`}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    if (THEMATIC.test(line)) { output.push('<hr>'); index++; continue }

    if (SECTION_MARK.test(line)) {
      const body = line.replace(SECTION_MARK, '')
      if (body === '') { output.push('<hr>'); index++; continue }
      output.push(`<p class="md-mark">${inlineHtml(body)}</p>`)
      index++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      output.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`)
      index++
      continue
    }

    if (ROW.test(line) && index + 1 < lines.length) {
      const header = splitRow(line)
      if (isDelimiterRow(lines[index + 1], header.length)) {
        const rows = []
        index += 2
        while (index < lines.length && lines[index].trim() !== '' && ROW.test(lines[index])) rows.push(splitRow(lines[index++]))
        output.push(`<table><thead><tr>${header.map(cell => `<th>${inlineHtml(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
        continue
      }
    }

    if (QUOTE.test(line)) {
      const quoted = []
      while (index < lines.length && QUOTE.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ''))
      output.push(`<blockquote>${blockHtml(quoted.join('\n'), depth + 1)}</blockquote>`)
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      const ordered = /\d/.test(item[2][0])
      const baseIndent = item[1].length
      const contentColumn = baseIndent + item[2].length + 1
      const start = ordered ? Number.parseInt(item[2], 10) : 1
      const items = []
      let loose = false
      while (index < lines.length) {
        const row = LIST_ITEM.exec(lines[index])
        if (row === null || row[1].length !== baseIndent || /\d/.test(row[2][0]) !== ordered) break
        const content = [row[3]]
        index++
        while (index < lines.length) {
          const next = lines[index]
          if (next.trim() === '') {
            // A blank line continues the item only if indented content follows.
            const following = lines[index + 1]
            if (following === undefined || following.trim() === '' || !/^\s/.test(following)) break
            content.push('')
            loose = true
            index++
            continue
          }
          const indent = /^\s*/.exec(next)[0].length
          if (indent <= baseIndent) break
          content.push(next.slice(Math.min(contentColumn, indent)))
          index++
        }
        items.push(content.join('\n'))
      }
      const body = items.map(content => {
        const rendered = blockHtml(content, depth + 1)
        return `<li>${loose ? rendered : unwrapLeadingParagraph(rendered)}</li>`
      }).join('')
      output.push(ordered ? `<ol${start === 1 ? '' : ` start="${start}"`}>${body}</ol>` : `<ul>${body}</ul>`)
      continue
    }

    const paragraph = []
    while (index < lines.length && !startsBlock(lines[index])) paragraph.push(lines[index++])
    // Unreachable unless the line opened a ROW that failed the table lookahead.
    if (paragraph.length === 0) paragraph.push(lines[index++])
    output.push(`<p>${paragraph.map(inlineHtml).join('<br>')}</p>`)
  }

  return output.join('')
}


const markdownCache = new Map()
const MARKDOWN_CACHE_LIMIT = 5000
function renderMarkdown(text) {
  // Normalise line endings first: every block matcher is `$`-anchored, so a
  // stray \r (Windows-authored relay payloads, pasted text) silently demotes
  // lists and headings to paragraphs.
  const key = String(text ?? '')
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const rendered = blockHtml(key.replace(/\r\n?/g, '\n'))
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.delete(markdownCache.keys().next().value)
  markdownCache.set(key, rendered)
  return rendered
}

export { renderMarkdown }
