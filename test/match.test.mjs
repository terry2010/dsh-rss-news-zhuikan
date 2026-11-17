import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidePush, matchTerms } from '../lib/match.js'

const item = (over = {}) => ({
  id: 1, site_id: 7, dedupe_key: 'k', title: '新枪版 流浪地球3', link: null,
  pub_time: null, pub_ts: null, views: null, category: '枪版', region: '电影区',
  extra_json: null, first_seen: '2025-01-01', ...over,
})
const term = (t, site = 0) => ({ id: 1, site_id: site, term: t, group_name: '', created_at: '' })

test('适用词集为空 → 全量推送', () => {
  const d = decidePush(item(), [])
  assert.equal(d.push, true)
  assert.deepEqual(d.terms, [])
})

test('命中 title/category/region', () => {
  assert.deepEqual(matchTerms(item(), [term('流浪地球')]), ['流浪地球'])
  assert.deepEqual(matchTerms(item(), [term('枪版')]), ['枪版'])
  assert.deepEqual(matchTerms(item(), [term('电影区')]), ['电影区'])
  assert.deepEqual(matchTerms(item(), [term('不存在的词')]), [])
})

test('非空词集：只推命中', () => {
  assert.equal(decidePush(item(), [term('流浪')]).push, true)
  assert.equal(decidePush(item(), [term('无关词')]).push, false)
})

test('大小写不敏感', () => {
  assert.deepEqual(matchTerms(item({ title: 'New CAM Version' }), [term('cam')]), ['cam'])
})
