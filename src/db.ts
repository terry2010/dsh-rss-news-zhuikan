/**
 * 独立存储：companions/rss-news-zhuikan/zhuikan.db（主插件备份通道免费覆盖）。
 * 时间戳约定：_at=ISO TEXT，_ts=epoch ms。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function resolveMainDataDir(): string {
  const home = process.env.DSH_HOME
  if (home) return join(home, 'data', 'rss-news-daily')
  return join(process.env.HOME || '.', '.dsh', 'rss-news-daily')
}
export function resolveDataDir(): string {
  return join(resolveMainDataDir(), 'companions', 'rss-news-zhuikan')
}

export interface SiteRow {
  id: number
  url: string
  label: string
  proxy: string | null
  rules_json: string
  pending_rules_json: string | null
  status: string
  enabled: number
  interval_s: number
  transport_level: string
  zero_streak: number
  last_poll_at: string | null
  last_ok_at: string | null
  last_items: number
  cache_json: string | null
  created_at: string
}
export interface ItemRow {
  id: number
  site_id: number
  dedupe_key: string
  title: string
  link: string | null
  pub_time: string | null
  pub_ts: number | null
  views: number | null
  category: string | null
  region: string | null
  extra_json: string | null
  first_seen: string
}
export interface TermRow { id: number; site_id: number; term: string; group_name: string; created_at: string }
export interface HitRow {
  id: number; item_id: number; term: string; confidence: string
  evidence: string | null; mailed: number; created_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  proxy TEXT,
  rules_json TEXT NOT NULL,
  pending_rules_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_s INTEGER NOT NULL DEFAULT 3600,
  transport_level TEXT NOT NULL DEFAULT 'node',
  zero_streak INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  last_ok_at TEXT,
  last_items INTEGER NOT NULL DEFAULT 0,
  cache_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  link TEXT,
  pub_time TEXT,
  pub_ts INTEGER,
  views INTEGER,
  category TEXT,
  region TEXT,
  extra_json TEXT,
  first_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_site ON items(site_id, first_seen DESC);
CREATE TABLE IF NOT EXISTS watch_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL DEFAULT 0,
  term TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(site_id, term)
);
CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'raw',
  evidence TEXT,
  mailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, term)
);
`

export class ZkDb {
  private d: DatabaseSync
  constructor(dir = resolveDataDir()) {
    mkdirSync(dir, { recursive: true })
    this.d = new DatabaseSync(join(dir, 'zhuikan.db'))
    this.d.exec(SCHEMA)
    try { this.d.exec('ALTER TABLE sites ADD COLUMN proxy TEXT') } catch { /* 已存在 */ }
  }
  close(): void { this.d.close() }

  // ---- sites ----
  sites(): SiteRow[] {
    return this.d.prepare('SELECT * FROM sites ORDER BY id').all() as unknown as SiteRow[]
  }
  site(id: number): SiteRow | undefined {
    return this.d.prepare('SELECT * FROM sites WHERE id=?').get(id) as unknown as SiteRow | undefined
  }
  siteByUrl(url: string): SiteRow | undefined {
    return this.d.prepare('SELECT * FROM sites WHERE url=?').get(url) as unknown as SiteRow | undefined
  }
  addSite(url: string, label: string, rulesJson: string, intervalS = 3600, proxy?: string): number {
    const r = this.d.prepare(
      'INSERT INTO sites(url,label,rules_json,interval_s,proxy,created_at) VALUES(?,?,?,?,?,?)',
    ).run(url, label, rulesJson, intervalS, proxy ?? null, new Date().toISOString())
    return Number(r.lastInsertRowid)
  }
  updateSite(id: number, patch: Partial<Pick<SiteRow,
    'label' | 'proxy' | 'rules_json' | 'pending_rules_json' | 'status' | 'enabled' | 'interval_s'
    | 'transport_level' | 'zero_streak' | 'last_poll_at' | 'last_ok_at' | 'last_items' | 'cache_json'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (!keys.length) return
    const sql = `UPDATE sites SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`
    this.d.prepare(sql).run(...keys.map((k) => patch[k] as string | number | null), id)
  }
  removeSite(id: number): void {
    this.d.prepare('DELETE FROM items WHERE site_id=?').run(id)
    this.d.prepare('DELETE FROM watch_terms WHERE site_id=?').run(id)
    this.d.prepare('DELETE FROM sites WHERE id=?').run(id)
  }

  // ---- items ----
  /** INSERT OR IGNORE；返回真正新入库的行数。
   *  除 dedupe_key 外另做 title+pub_ts 软去重——规则改良（如补上 link）换 key 时不重复入库。
   *  已存在的行做空字段回填：否则早期抽取缺 link 的行会永远停在 null（raws 每轮重抽是好的，
   *  但本站条目列表展示的是这张表）。 */
  insertItem(it: Omit<ItemRow, 'id'>): boolean {
    const dup = this.d.prepare(
      `SELECT 1 FROM items WHERE site_id=? AND title=? AND pub_ts IS NOT DISTINCT FROM ? LIMIT 1`,
    ).get(it.site_id, it.title, it.pub_ts)
    if (!dup) {
      const r = this.d.prepare(
        `INSERT OR IGNORE INTO items(site_id,dedupe_key,title,link,pub_time,pub_ts,views,category,region,extra_json,first_seen)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(it.site_id, it.dedupe_key, it.title, it.link, it.pub_time, it.pub_ts,
        it.views, it.category, it.region, it.extra_json, it.first_seen)
      if (Number(r.changes) > 0) return true
    }
    this.d.prepare(
      `UPDATE items SET link=COALESCE(link,?), pub_time=COALESCE(pub_time,?), pub_ts=COALESCE(pub_ts,?),
         views=COALESCE(views,?), category=COALESCE(category,?), region=COALESCE(region,?), extra_json=COALESCE(extra_json,?)
       WHERE site_id=? AND (dedupe_key=? OR (title=? AND pub_ts IS NOT DISTINCT FROM ?))`,
    ).run(it.link, it.pub_time, it.pub_ts, it.views, it.category, it.region, it.extra_json,
      it.site_id, it.dedupe_key, it.title, it.pub_ts)
    return false
  }
  items(siteId: number | undefined, limit = 100, offset = 0): ItemRow[] {
    return siteId === undefined
      ? this.d.prepare('SELECT * FROM items ORDER BY first_seen DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as ItemRow[]
      : this.d.prepare('SELECT * FROM items WHERE site_id=? ORDER BY first_seen DESC LIMIT ? OFFSET ?').all(siteId, limit, offset) as unknown as ItemRow[]
  }
  itemCount(siteId: number): number {
    return Number((this.d.prepare('SELECT COUNT(*) c FROM items WHERE site_id=?').get(siteId) as { c: number }).c)
  }
  hasBaseline(siteId: number): boolean {
    return this.itemCount(siteId) > 0
  }

  // ---- watch_terms ----
  terms(siteId?: number): TermRow[] {
    return siteId === undefined
      ? this.d.prepare('SELECT * FROM watch_terms ORDER BY site_id, id').all() as unknown as TermRow[]
      : this.d.prepare('SELECT * FROM watch_terms WHERE site_id IN (0, ?) ORDER BY id').all(siteId) as unknown as TermRow[]
  }
  addTerm(term: string, siteId = 0, group = ''): void {
    this.d.prepare(
      'INSERT OR IGNORE INTO watch_terms(site_id,term,group_name,created_at) VALUES(?,?,?,?)',
    ).run(siteId, term, group, new Date().toISOString())
  }
  updateTerm(id: number, term: string, siteId = 0): 'ok' | 'dup' | 'gone' {
    const dup = this.d.prepare('SELECT id FROM watch_terms WHERE site_id=? AND term=? AND id<>?').get(siteId, term, id)
    if (dup) return 'dup'
    const r = this.d.prepare('UPDATE watch_terms SET term=?, site_id=? WHERE id=?').run(term, siteId, id)
    return r.changes ? 'ok' : 'gone'
  }
  removeTerm(id: number): void {
    this.d.prepare('DELETE FROM watch_terms WHERE id=?').run(id)
  }

  // ---- hits ----
  addHit(itemId: number, term: string, confidence = 'raw', evidence?: string): void {
    this.d.prepare(
      'INSERT OR IGNORE INTO hits(item_id,term,confidence,evidence,created_at) VALUES(?,?,?,?,?)',
    ).run(itemId, term, confidence, evidence ?? null, new Date().toISOString())
  }
  hits(limit = 100): (HitRow & { title: string; link: string | null; site_id: number })[] {
    return this.d.prepare(
      `SELECT h.*, i.title, i.link, i.site_id FROM hits h JOIN items i ON i.id=h.item_id
       ORDER BY h.id DESC LIMIT ?`,
    ).all(limit) as unknown as (HitRow & { title: string; link: string | null; site_id: number })[]
  }
}
