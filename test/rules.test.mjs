import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateRule, sameSite } from '../lib/rules.js'

const SITE = 'https://forum.example.com/list'

test('sameSite: eTLD+1 判定', () => {
  assert.equal(sameSite('https://forum.example.com/a', 'https://api.example.com/b'), true)
  assert.equal(sameSite('https://forum.example.com', 'https://evil.com'), false)
})

test('css 规则校验：regions/anchor/index', () => {
  const ok = validateRule({
    type: 'css', item: 'li',
    regions: [{ sel: 'ul', label: 'A', anchor: { sel: 'h3', text: 'A' } }, { sel: 'ul', label: 'B', index: 1 }],
    map: { title: 'a', link: 'a' },
  }, SITE)
  assert.equal(ok.ok, true)
  assert.equal(validateRule({ type: 'css', item: 'li', map: {} }, SITE).ok, false)
  assert.equal(validateRule({ type: 'css', item: 'li', regions: [], map: { title: 'a' } }, SITE).ok, false)
})

test('json 规则：api 必须同站（SSRF 闸门）', () => {
  assert.equal(validateRule({
    type: 'json', api: 'https://evil.com/x', items: 'a.b', map: { title: 't' },
  }, SITE).ok, false)
  assert.equal(validateRule({
    type: 'json', api: 'https://api.example.com/x', items: 'data.list', map: { title: 't' },
  }, SITE).ok, true)
  assert.equal(validateRule({
    type: 'json', api: 'https://api.example.com/x', items: 'bad path!', map: { title: 't' },
  }, SITE).ok, false)
})
