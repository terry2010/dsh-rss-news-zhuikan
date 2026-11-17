import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extract, extractCss, extractJson, extractSsr, parseTime } from '../lib/extract.js'

const SITE = 'https://forum.example.com/'

// 聚合页：三个同构板块（相同结构，靠标题文本区分）
const AGG_HTML = `<html><body>
<nav>导航噪音</nav>
<div class="board">
  <h3>电影区</h3>
  <ul class="post-list">
    <li class="row"><a class="t" href="/t/1001">流浪地球3 定档</a><span class="tm">10分钟前</span><span class="v">1.2k</span></li>
    <li class="row"><a class="t" href="/t/1002">哪吒2 票房破纪录</a><span class="tm">2025-06-01 12:00</span><span class="v">300</span></li>
  </ul>
</div>
<div class="board">
  <h3>交易区</h3>
  <ul class="post-list">
    <li class="row"><a class="t" href="/t/2001">出一张显卡</a><span class="tm">昨天 20:00</span><span class="v">50</span></li>
  </ul>
</div>
<div class="board">
  <h3>情感区</h3>
  <ul class="post-list">
    <li class="row"><a class="t" href="/t/3001">女朋友又生气了</a><span class="tm">1小时前</span></li>
  </ul>
</div>
</body></html>`

test('css: 文本锚定位同构区域', () => {
  const rule = {
    type: 'css', item: 'li.row',
    regions: [
      { sel: 'ul.post-list', label: '电影区', anchor: { sel: 'h3', text: '电影区' } },
      { sel: 'ul.post-list', label: '交易区', anchor: { sel: 'h3', text: '交易' } },
    ],
    map: { title: 'a.t', link: 'a.t', time: '.tm', views: '.v' },
  }
  const r = extract(rule, AGG_HTML, SITE)
  assert.equal(r.items.length, 3)
  assert.equal(r.items[0].title, '流浪地球3 定档')
  assert.equal(r.items[0].region, '电影区')
  assert.equal(r.items[0].link, 'https://forum.example.com/t/1001')
  assert.equal(r.items[0].views, 1200)
  assert.equal(r.items[2].region, '交易区')
  assert.deepEqual(r.regionCounts.map(c => c.count), [2, 1])
})

test('css: index 定位兜底', () => {
  const rule = {
    type: 'css', item: 'li.row',
    regions: [{ sel: 'ul.post-list', label: '第三区', index: 2 }],
    map: { title: 'a.t', link: 'a.t' },
  }
  const r = extract(rule, AGG_HTML, SITE)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].title, '女朋友又生气了')
})

test('css: 无 regions 全页抽取', () => {
  const rule = { type: 'css', item: 'li.row', map: { title: 'a.t', link: 'a.t' } }
  const r = extract(rule, AGG_HTML, SITE)
  assert.equal(r.items.length, 4)
})

test('css: 跨区域去重（同 link 只记首个 region）', () => {
  const html = `<div class="a"><ul><li><a href="/t/9">重复帖</a></li></ul></div>
    <div class="b"><ul><li><a href="/t/9">重复帖</a></li></ul></div>`
  const rule = {
    type: 'css', item: 'li',
    regions: [{ sel: '.a ul', label: 'A' }, { sel: '.b ul', label: 'B' }],
    map: { title: 'a', link: 'a' },
  }
  const r = extract(rule, html, SITE)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].region, 'A')
})

test('json: dotted path + 字段映射', () => {
  const body = JSON.stringify({ data: { list: [
    { id: 'a1', name: '条目一', url: '/p/a1', ts: '2025-06-01T08:00:00Z', cnt: 99 },
    { id: 'a2', name: '条目二', url: 'p/a2' },
  ] } })
  const rule = {
    type: 'json', api: 'https://forum.example.com/api/list', items: 'data.list',
    map: { title: 'name', link: 'url', id: 'id', time: 'ts', views: 'cnt' },
  }
  const r = extract(rule, body, SITE)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].dedupeKey, 'id:a1')
  assert.equal(r.items[1].link, 'https://forum.example.com/p/a2')
  assert.equal(r.items[0].views, 99)
})

test('ssr: 数据岛抽取', () => {
  const html = `<html><body><ul><li>x</li></ul>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"list":[{"t":"岛内条目","u":"/i/1"}]}}}</script>
    </body></html>`
  const rule = { type: 'ssr', sel: 'script#__NEXT_DATA__', items: 'props.pageProps.list', map: { title: 't', link: 'u' } }
  const r = extract(rule, html, SITE)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].title, '岛内条目')
})

test('parseTime: ISO/中文相对/英相对/年月日', () => {
  const anchor = Date.parse('2025-06-10T12:00:00Z')
  assert.equal(parseTime('2025-06-01T00:00:00Z', anchor), Date.parse('2025-06-01T00:00:00Z'))
  assert.equal(parseTime('10分钟前', anchor), anchor - 600_000)
  assert.equal(parseTime('3小时前', anchor), anchor - 3 * 3600e3)
  assert.equal(parseTime('2 days ago', anchor), anchor - 2 * 86400e3)
  assert.equal(parseTime('昨天', anchor) < anchor, true)
  assert.equal(parseTime('not a time', anchor), null)
  assert.equal(parseTime(null, anchor), null)
})
