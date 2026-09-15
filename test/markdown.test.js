// Contract for src/markdown.js, which is the rendering path for every piece of
// model output on the canvas. The cases below are the ones that used to break:
// an orphan `**` swallowing a paragraph, fences split on parity, `- - -` read
// as a list, and Windows-authored \r demoting lists to paragraphs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../src/canvas/markdown.js'

const md = input => renderMarkdown(input)

test('an unpaired ** degrades to literal text instead of eating the paragraph', () => {
  assert.equal(
    md('状态 **未定位根因\n下一行 **INFESIBLE** 混着 ** 收尾'),
    '<p>状态 **未定位根因<br>下一行 <strong>INFESIBLE</strong> 混着 ** 收尾</p>',
  )
})

test('emphasis nests', () => {
  assert.equal(md('**bold with *em* inside**'), '<p><strong>bold with <em>em</em> inside</strong></p>')
})

test('***both*** renders as nested strong+em', () => {
  assert.equal(md('***both***'), '<p><em><strong>both</strong></em></p>')
})

test('_ inside a word stays literal', () => {
  assert.equal(md('a snake_case_name b'), '<p>a snake_case_name b</p>')
})

test('strikethrough needs a pair', () => {
  assert.equal(md('~~dead~~ and ~single~'), '<p><s>dead</s> and ~single~</p>')
})

test('code spans protect their markers', () => {
  assert.equal(md('use `**not bold**` here'), '<p>use <code>**not bold**</code> here</p>')
})

test('fenced code block carries its language and escapes its body', () => {
  assert.equal(md('```js\nconst a = 1 < 2\n```'), '<pre><code class="language-js">const a = 1 &lt; 2</code></pre>')
})

test('an unclosed fence still renders as code, so streaming does not throw', () => {
  assert.equal(md('```\nstill typing'), '<pre><code>still typing</code></pre>')
})

test('a tilde fence is a fence too', () => {
  assert.equal(md('~~~\nx\n~~~'), '<pre><code>x</code></pre>')
})

test('tables require the delimiter row to match the header width', () => {
  assert.match(md('| a | b |\n| - | - |\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/)
  // Three header cells against a two-cell delimiter is not a table. The `|`-led
  // line still opens a new block, which is how a table interrupts a paragraph.
  assert.equal(md('| a | b | c |\n| - | - |'), '<p>| a | b | c |</p><p>| - | - |</p>')
})

test('escaped pipes stay inside their cell', () => {
  assert.match(md('| a \\| b | c |\n| - | - |'), /<th>a \| b<\/th><th>c<\/th>/)
})

test('lists nest', () => {
  assert.equal(md('- a\n  - b'), '<ul><li>a<ul><li>b</li></ul></li></ul>')
})

test('a blank line inside an item makes the list loose', () => {
  assert.equal(md('- a\n\n  b'), '<ul><li><p>a</p><p>b</p></li></ul>')
})

test('an ordered list keeps its start number', () => {
  assert.equal(md('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>')
})

test('- - - is a thematic break, not a nested list', () => {
  assert.equal(md('- - -'), '<hr>')
  assert.equal(md('---'), '<hr>')
})

test('a section mark on its own line becomes a heading, or an hr when bare', () => {
  assert.equal(md('■ 一、进度'), '<p class="md-mark">一、进度</p>')
  assert.equal(md('■'), '<hr>')
})

test('a section mark mid-line is left alone', () => {
  assert.equal(md('参数 a ⇒ b'), '<p>参数 a ⇒ b</p>')
})

test('headings and blockquotes', () => {
  assert.equal(md('## 标题\n> 引用里的 **粗体**'), '<h2>标题</h2><blockquote><p>引用里的 <strong>粗体</strong></p></blockquote>')
})

test('http links become anchors, other schemes stay literal', () => {
  assert.equal(md('[文档](https://example.com)'), '<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">文档</a></p>')
  assert.equal(md('[坏](javascript:alert(1))'), '<p>[坏](javascript:alert(1))</p>')
  assert.equal(md('[坏](data:text/html;base64,PHNjcmlwdD4=)'), '<p>[坏](data:text/html;base64,PHNjcmlwdD4=)</p>')
})

test('bare HTML is escaped, never executed', () => {
  assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.equal(md('<script>bad()</script>'), '<p>&lt;script&gt;bad()&lt;/script&gt;</p>')
})

test('a quote inside text is escaped', () => {
  assert.equal(md("it's"), '<p>it&#39;s</p>')
})

test('CRLF input is normalised, so lists are not demoted to paragraphs', () => {
  assert.equal(md('- a\r\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(md('## t\r\nbody'), '<h2>t</h2><p>body</p>')
})

test('deep nesting terminates instead of recursing forever', () => {
  const deep = Array.from({ length: 40 }, (_, i) => '  '.repeat(i) + '- x').join('\n')
  assert.doesNotThrow(() => md(deep))
})

test('empty input renders empty', () => {
  assert.equal(md(''), '')
  assert.equal(md(null), '')
})

test('repeated renders hit the cache and stay identical', () => {
  const input = '**a** `b` [c](https://d.e)'
  assert.equal(md(input), md(input))
})
