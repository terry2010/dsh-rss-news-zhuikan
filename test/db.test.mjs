import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZkDb } from '../lib/db.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'zk-test-'))

test('sites/items/terms/hits 基本流转', () => {
  const db = new ZkDb(tmp())
  const id = db.addSite('https://x.com/list', '测试站', '{"type":"css","item":"li","map":{"title":"a"}}')
  assert.equal(db.siteByUrl('https://x.com/list').id, id)

  const row = { site_id: id, dedupe_key: `${id}:id:1`, title: 't1', link: null, pub_time: null,
    pub_ts: null, views: null, category: null, region: null, extra_json: null, first_seen: new Date().toISOString() }
  assert.equal(db.insertItem(row), true)
  assert.equal(db.insertItem(row), false) // dedupe_key 唯一
  assert.equal(db.itemCount(id), 1)

  db.addTerm('关键词', 0)
  db.addTerm('站级词', id)
  db.addTerm('关键词', 0) // UNIQUE 去重
  assert.equal(db.terms(id).length, 2)
  assert.equal(db.terms().length, 2)

  db.addHit(db.items(id, 1)[0].id, '关键词', 'raw')
  db.addHit(db.items(id, 1)[0].id, '关键词', 'raw') // UNIQUE(item,term)
  assert.equal(db.hits().length, 1)

  db.updateSite(id, { zero_streak: 3, status: 'degraded' })
  assert.equal(db.site(id).zero_streak, 3)

  db.removeSite(id)
  assert.equal(db.sites().length, 0)
  assert.equal(db.terms(id).length, 1) // 站级词随站删；全局词（site_id=0）保留
  db.close()
})
