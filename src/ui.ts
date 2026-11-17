/**
 * 管理台 UI 挂载：/dsh-rss-news-zhuikan/ 静态页 + /api/* 路由。
 * 与主插件/快讯同一套 webServer 路由惯例（kind + sameSite 防护）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZkDb, SiteRow } from './db.js'
import type { PreviewResult } from './rulegen.js'
import type { SiteRule } from './rules.js'

const BASE = '/dsh-rss-news-zhuikan'

interface Req {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: 'data', cb: (chunk: Buffer | string) => void): unknown
  on(event: 'end', cb: () => void): unknown
}
interface Res {
  statusCode: number
  setHeader(k: string, v: string): void
  end(b?: string | Buffer): void
}
export interface WebServerLike {
  register(opts: { kind: string; path: string; handler: (req: Req, res: Res) => void }): () => void
}
type Log = { info(m: string): void; warn(m: string): void }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
function sameSite(req: Req): boolean {
  return String(req.headers?.['sec-fetch-site'] || '').toLowerCase() !== 'cross-site'
}
async function serveStatic(res: Res, rel: string): Promise<void> {
  const webDir = join(fileURLToPath(new URL('.', import.meta.url)), 'web')
  const safe = rel.split('?')[0].replace(/^\/+|\.{2,}/g, '') || 'index.html'
  const file = join(webDir, safe)
  try {
    const body = await readFile(file)
    res.statusCode = 200
    res.setHeader('content-type', MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}
function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (c) => { s += c; if (s.length > 262_144) reject(new Error('body too large')) })
    req.on('end', () => resolve(s))
  })
}
const json = (res: Res, code: number, body: unknown) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
const siteOut = (db: ZkDb, s: SiteRow) => ({
  id: s.id, url: s.url, label: s.label, proxy: s.proxy, status: s.status, enabled: s.enabled === 1,
  intervalS: s.interval_s, transport: s.transport_level, zeroStreak: s.zero_streak,
  lastPollAt: s.last_poll_at, lastOkAt: s.last_ok_at, lastItems: s.last_items,
  itemCount: db.itemCount(s.id),
  rules: JSON.parse(s.rules_json) as SiteRule,
  pendingRules: s.pending_rules_json ? JSON.parse(s.pending_rules_json) : null,
})

export interface UiDeps {
  db: ZkDb
  log: Log
  /** 预览：拉页面 + rulegen；LLM 缺席时返回错误 */
  preview: (url: string, proxy?: string) => Promise<PreviewResult | { ok: false; error: string }>
  /** 站点启用/词表变更后主插件源同步 */
  syncSources: () => Promise<void>
  /** 站点启用后立即跑一轮（基线入库） */
  kickSite: (siteId: number) => void
  /** 重新分析（规则腐化/手动）→ pending_rules */
  reanalyze: (siteId: number) => Promise<{ ok: boolean; error?: string; groups?: unknown }>
  llmReady: () => boolean
  /** LLM 通路探针（小 prompt，秒级回） */
  llmTest?: () => Promise<{ ok: boolean; route?: string; text?: string; ms?: number; error?: string }>
}

export function mountUi(ws: WebServerLike, deps: UiDeps): () => void {
  const { db, log } = deps
  const guard = (fn: (req: Req, res: Res) => void | Promise<void>) => (req: Req, res: Res): Promise<void> => {
    if (!sameSite(req)) { res.statusCode = 403; res.end('forbidden'); return Promise.resolve() }
    return Promise.resolve(fn(req, res)).catch((e) => {
      log.warn(`api error: ${(e as Error).message}`)
      try { json(res, 500, { ok: false, error: (e as Error).message }) } catch { /* res ended */ }
    })
  }
  const disposers = [
    ws.register({ kind: 'exact', path: `${BASE}/`, handler: guard((_q, r) => serveStatic(r, 'index.html')) }),
    ws.register({ kind: 'exact', path: BASE, handler: guard((_q, r) => serveStatic(r, 'index.html')) }),
    ws.register({ kind: 'prefix', path: `${BASE}/web`, handler: guard((q, r) => serveStatic(r, (q.url || '').replace(`${BASE}/web/`, ''))) }),

    ws.register({
      kind: 'exact', path: `${BASE}/api/sites`,
      handler: guard((req, res) => json(res, 200, {
        ok: true, llmReady: deps.llmReady(),
        sites: db.sites().map((s) => siteOut(db, s)),
      })),
    }),

    // 加站第一步：粘 URL → 拉页 + rulegen → 区域分组预览
    ws.register({
      kind: 'exact', path: `${BASE}/api/preview`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        const body = JSON.parse(await readBody(req) || '{}') as { url?: string; proxy?: string }
        const url = String(body.url ?? '').trim()
        if (!/^https?:\/\//.test(url)) return json(res, 400, { ok: false, error: 'url must be http(s)' })
        const proxy = String(body.proxy ?? '').trim() || undefined
        if (proxy && !/^https?:\/\//.test(proxy)) return json(res, 400, { ok: false, error: 'proxy must be http(s)://' })
        json(res, 200, await deps.preview(url, proxy))
      }),
    }),

    // 加站第二步：用户圈选区域 → 存站 + 注册主插件源 + 立即基线抓取
    ws.register({
      kind: 'exact', path: `${BASE}/api/site/add`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        const body = JSON.parse(await readBody(req) || '{}') as {
          url?: string; label?: string; rule?: SiteRule; regions?: number[]; proxy?: string
        }
        const url = String(body.url ?? '').trim()
        if (!/^https?:\/\//.test(url) || !body.rule) return json(res, 400, { ok: false, error: 'url+rule required' })
        if (db.siteByUrl(url)) return json(res, 409, { ok: false, error: 'site already exists' })
        const rule = body.rule
        if (rule.type === 'css' && rule.regions?.length && Array.isArray(body.regions)) {
          rule.regions = body.regions.map((i) => rule.regions![i]).filter(Boolean)
          if (!rule.regions.length) return json(res, 400, { ok: false, error: 'pick at least one region' })
        }
        const id = db.addSite(url, String(body.label ?? '').trim() || new URL(url).hostname, JSON.stringify(rule), 3600, String(body.proxy ?? '').trim() || undefined)
        await deps.syncSources()
        deps.kickSite(id)
        json(res, 200, { ok: true, site: siteOut(db, db.site(id)!) })
      }),
    }),

    // 站点操作：enable/disable/remove/interval/relabel —— POST /api/site/op {id,op,...}
    ws.register({
      kind: 'exact', path: `${BASE}/api/site/op`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        const b = JSON.parse(await readBody(req) || '{}') as {
          id?: number; op?: string; label?: string; intervalS?: number
        }
        const site = b.id ? db.site(b.id) : undefined
        if (!site) return json(res, 404, { ok: false, error: 'site not found' })
        switch (b.op) {
          case 'enable': db.updateSite(site.id, { enabled: 1, status: site.status === 'disabled' ? 'active' : site.status }); break
          case 'disable': db.updateSite(site.id, { enabled: 0, status: 'disabled' }); break
          case 'remove': db.removeSite(site.id); await deps.syncSources(); return json(res, 200, { ok: true })
          case 'relabel': db.updateSite(site.id, { label: String(b.label ?? site.label) }); break
          case 'interval': {
            const s = Math.max(300, Math.min(86400, Number(b.intervalS) || site.interval_s))
            db.updateSite(site.id, { interval_s: s })
            break
          }
          case 'reanalyze': {
            const r = await deps.reanalyze(site.id)
            return json(res, 200, { ok: r.ok, error: r.error, groups: r.groups, site: siteOut(db, db.site(site.id)!) })
          }
          case 'confirm-rules': {
            const pend = (b as { rule?: SiteRule }).rule ?? (site.pending_rules_json ? JSON.parse(site.pending_rules_json) : null)
            if (!pend) return json(res, 400, { ok: false, error: 'no pending rules' })
            const rule = pend as SiteRule
            if (rule.type === 'css' && rule.regions?.length && Array.isArray((b as { regions?: number[] }).regions)) {
              const idxs = (b as { regions: number[] }).regions
              rule.regions = idxs.map((i) => (pend as SiteRule & { regions?: unknown[] }).type === 'css'
                ? (pend as { regions: { sel: string; label: string }[] }).regions[i]
                : undefined).filter(Boolean) as typeof rule.regions
              if (!rule.regions.length) return json(res, 400, { ok: false, error: 'pick at least one region' })
            }
            db.updateSite(site.id, { rules_json: JSON.stringify(rule), pending_rules_json: null, status: 'active', zero_streak: 0 })
            await deps.syncSources()
            deps.kickSite(site.id)
            return json(res, 200, { ok: true, site: siteOut(db, db.site(site.id)!) })
          }
          case 'reject-rules':
            db.updateSite(site.id, { pending_rules_json: null, status: site.zero_streak >= 3 ? 'degraded' : 'active' })
            return json(res, 200, { ok: true })
          default: return json(res, 400, { ok: false, error: `unknown op ${b.op}` })
        }
        await deps.syncSources()
        json(res, 200, { ok: true, site: siteOut(db, db.site(site.id)!) })
      }),
    }),

    // 词表：GET 全量；POST {term, siteId?, group?} 增；POST remove {id}
    ws.register({
      kind: 'exact', path: `${BASE}/api/terms`,
      handler: guard(async (req, res) => {
        if (req.method === 'GET') return json(res, 200, { ok: true, terms: db.terms() })
        const b = JSON.parse(await readBody(req) || '{}') as { op?: string; id?: number; term?: string; siteId?: number; group?: string }
        if (b.op === 'remove' && b.id) db.removeTerm(b.id)
        else if (b.term?.trim()) db.addTerm(b.term.trim(), Number(b.siteId) || 0, String(b.group ?? '').trim())
        json(res, 200, { ok: true, terms: db.terms() })
      }),
    }),

    ws.register({
      kind: 'exact', path: `${BASE}/api/llm-test`,
      handler: guard(async (_q, res) => {
        if (!deps.llmTest) return json(res, 501, { ok: false, error: 'no probe' })
        json(res, 200, await deps.llmTest())
      }),
    }),

    ws.register({
      kind: 'exact', path: `${BASE}/api/hits`,
      handler: guard((_q, res) => json(res, 200, { ok: true, hits: db.hits(200) })),
    }),

    ws.register({
      kind: 'exact', path: `${BASE}/api/items`,
      handler: guard((req, res) => {
        const u = new URL(req.url || '', 'http://x')
        const siteId = u.searchParams.get('site_id')
        const items = db.items(siteId ? Number(siteId) : undefined, Number(u.searchParams.get('limit')) || 200)
        json(res, 200, { ok: true, items })
      }),
    }),
  ]
  log.info('zhuikan admin page mounted')
  return () => { for (const d of disposers) d() }
}
