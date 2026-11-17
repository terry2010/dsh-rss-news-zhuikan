import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from '../lib/summarize.js'

test('剥壳：script/style 移除，数据岛保留，同构折叠', () => {
  const lis = Array.from({ length: 8 }, (_, i) => `<li class="row"><a href="/t/${i}">帖子${i}</a></li>`).join('')
  const html = `<html><head><style>.x{}</style><script>evil()</script></head>
    <body><ul>${lis}</ul>
    <script id="__NEXT_DATA__" type="application/json">{"a":1}</script></body></html>`
  const out = summarize(html, 'https://x.com/')
  assert.match(out, /base url="https:\/\/x\.com\/"/)
  assert.match(out, /__NEXT_DATA__/)
  assert.doesNotMatch(out, /evil\(\)/)
  assert.match(out, /\+\d+ more/) // 同构折叠
})
