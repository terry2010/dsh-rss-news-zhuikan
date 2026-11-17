/**
 * dsh-rss-news-zhuikan 插件入口。
 *
 * 定位：「无 RSS 网站的订阅器」——用户粘列表页 URL，LLM 学习页面规则生成
 * 抽取规则，插件把新条目作为主插件标准订阅源输出（新闻列表/日报管线），
 * 同时做自己的 diff→词表→命中→桌面通知侧管线。
 *
 * 契约（cordis bundle）：
 *  - name    'rss-news-zhuikan'（cordis.patch.yml id 一致）
 *  - inject  []（rndSources/llm/browserFetch 全走 ctx.inject 动态等待——
 *    主插件后装自动激活；缺席时 dep-prompt 指路）
 *  - apply   method handler 挂进主插件调度（registerMethod+addSources），
 *    per-site 节流在 handler 内做（缓存回放）
 *
 * 存储独立：companions/rss-news-zhuikan/zhuikan.db。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createFetcher, type MethodCtx, type RawItem, type SourceDef } from 'dsh-rss-news-daily'

import { ZkDb, resolveDataDir, resolveMainDataDir, type ItemRow } from './db.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountUi, type WebServerLike } from './ui.js'
import { hasService, markSeenMain, mountDepRoutes } from './dep-prompt.js'
import { getDoc, markAuth, looksLikeChallenge, type BrowserFetchLike } from './transport.js'
import { extract, type ZkItem } from './extract.js'
import { generateRule } from './rulegen.js'
import { decidePush } from './match.js'
import type { JsonRule, SiteRule } from './rules.js'
import type { LlmLike, RouteHint } from './llm.js'

export const name = 'rss-news-zhuikan'
export const inject: string[] = []

const METHOD = 'rss-news-zhuikan:generic'
const BASE = '/dsh-rss-news-zhuikan'
/** 零命中连续 N 轮 → degraded（规则可能腐化，提示重新分析） */
const ZERO_STREAK_DEGRADE = 3

type FeedSourceLike = { id: string; url: string; title: string }
type Log = { info(m: string): void; warn(m: string): void }

const host = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

export function apply(ctx: Context) {
  const log = ctx.logger('zhuikan')
  ctx.inject(['webServer'], (c) => {
    mountDepRoutes((c as unknown as { webServer: Parameters<typeof mountDepRoutes>[0] }).webServer, ctx, log, resolveDataDir())
  })
  if (!hasService(ctx, 'rndSources')) {
    log.warn('rss-news-zhuikan 依赖主插件 dsh-rss-news-daily（rndSources）：请先安装主插件；装上后本插件自动激活')
  }
  ctx.inject(['rndSources'], (c) => bootstrap(c, log))
}

function bootstrap(ctx: Context, log: Log) {
  markSeenMain()
  if (ctx.rndSources.apiVersion < 1) {
    log.warn('rndSources apiVersion < 1; zhuikan inert (upgrade dsh-rss-news-daily)')
    return
  }
  const db = new ZkDb()
  const fetcher = createFetcher({ timeoutMs: 15_000, retries: 1 })

  let bf: BrowserFetchLike | undefined
  const declareSiteDomains = () => {
    if (!bf) return
    const domains = new Set<string>()
    for (const s of db.sites()) {
      domains.add(host(s.url))
      const r = JSON.parse(s.rules_json) as SiteRule
      if (r.type === 'json') domains.add(host((r as JsonRule).api))
    }
    bf.declareDomains(name, [...domains].filter(Boolean))
  }
  ctx.inject(['browserFetch'], (c) => {
    bf = (c as unknown as { browserFetch: BrowserFetchLike }).browserFetch
    declareSiteDomains()
    log.info('browserFetch attached: node-first with browser fallback')
  })

  let llm: LlmLike | undefined
  ctx.inject(['llm'], (c) => {
    llm = (c as unknown as { llm: LlmLike }).llm
    log.info('host llm attached: rulegen enabled')
  })
  // 路由提示：主插件 prefs.llm（用户显式选的 provider/model）——缺席走 catalog 探测
  const routeHint = (): RouteHint | undefined => {
    try {
      const p = JSON.parse(readFileSync(join(resolveMainDataDir(), 'prefs.json'), 'utf8'))
      const l = p?.llm as { provider?: string; model?: string } | undefined
      return l?.provider && l?.model ? { provider: l.provider, model: l.model } : undefined
    } catch { return undefined }
  }

  const mctx = (url: string): MethodCtx => ({ fetch: fetcher, log: log as MethodCtx['log'], signal: undefined, kv: { get: () => undefined, set: () => {} } })

  // ---- 主插件源同步：removeSources 整 provider 重写（单站无法单独删） ----
  const syncSources = async () => {
    await ctx.rndSources.removeSources(name)
    const defs: SourceDef[] = db.sites().filter((s) => s.enabled === 1).map((s) => ({
      url: s.url, title: s.label || s.url, method: METHOD,
      category: '追看', tier: 2, lang: 'zh', enabled: true,
      summarize: false,
    }))
    if (defs.length) await ctx.rndSources.addSources(name, defs)
    declareSiteDomains()
  }

  const toRaw = (it: ZkItem, siteId: number): RawItem => ({
    id: `zk${siteId}:${it.dedupeKey}`,
    title: it.title,
    link: it.link ?? undefined,
    summary: it.extra ?? it.category ?? undefined,
    publishedAt: it.pubTs ? new Date(it.pubTs).toISOString() : undefined,
  })

  const rowOf = (siteId: number, it: ZkItem, now: string): Omit<ItemRow, 'id'> => ({
    site_id: siteId, dedupe_key: `${siteId}:${it.dedupeKey}`, title: it.title,
    link: it.link, pub_time: it.pubTime, pub_ts: it.pubTs, views: it.views,
    category: it.category, region: it.region, extra_json: it.extra, first_seen: now,
  })

  /** 一轮抓取的公共尾部：入库 diff → 词表/推送 → 状态更新。返回本轮 RawItem。 */
  const settle = (siteId: number, items: ZkItem[], firstEver: boolean): { raws: RawItem[]; pushed: number; hits: number } => {
    const now = new Date().toISOString()
    const terms = db.terms(siteId)
    const pushTitles: string[] = []
    let hits = 0
    for (const it of items.slice(0, 500)) {
      const inserted = db.insertItem(rowOf(siteId, it, now))
      if (!inserted) continue
      if (firstEver) continue // 基线轮：只入库不推送
      const row = db.items(siteId, 1)[0]!
      const dec = decidePush(row, terms)
      if (!dec.push) continue
      pushTitles.push(row.title)
      for (const t of dec.terms) { db.addHit(row.id, t, 'raw'); hits++ }
    }
    if (pushTitles.length) {
      const site = db.site(siteId)!
      const title = `追看 · ${site.label || site.url}`
      const body = pushTitles.length === 1
        ? pushTitles[0]!
        : `${pushTitles.length} 条更新：${pushTitles.slice(0, 3).join('；')}${pushTitles.length > 3 ? '…' : ''}`
      try { ctx.rndSources.notify(title, body, `${BASE}/`) } catch { /* notify 尽力而为 */ }
    }
    return { raws: items.map((it) => toRaw(it, siteId)), pushed: pushTitles.length, hits }
  }

  // ---- method handler：主插件调度器每轮调它；per-site 节流在内 ----
  const handler = async (src: FeedSourceLike, ctx2: MethodCtx): Promise<RawItem[]> => {
    const site = db.siteByUrl(src.url)
    if (!site || site.enabled !== 1) return []
    const nowMs = Date.now()
    const lastPoll = site.last_poll_at ? Date.parse(site.last_poll_at) : 0
    if (lastPoll && nowMs - lastPoll < site.interval_s * 900) {
      return site.cache_json ? JSON.parse(site.cache_json) as RawItem[] : []
    }
    const rule = JSON.parse(site.rules_json) as SiteRule
    const fetchUrl = rule.type === 'json' ? rule.api : site.url
    const doc = await getDoc(ctx2, bf, host(fetchUrl), fetchUrl, {
      preferBrowser: site.transport_level === 'browser',
      method: rule.type === 'json' ? rule.method : undefined,
      body: rule.type === 'json' ? rule.body : undefined,
      headers: rule.type === 'json' ? { accept: 'application/json' } : undefined,
      proxy: site.proxy ?? undefined,
    })
    if ('error' in doc) throw new Error(`fetch ${fetchUrl}: ${doc.error}`)
    if (looksLikeChallenge(doc.body ?? '', doc.status)) {
      markAuth(bf, host(fetchUrl))
      throw new Error(`challenge/login wall at ${fetchUrl} (${doc.status})`)
    }
    const firstEver = !db.hasBaseline(site.id)
    const res = extract(rule, doc.body ?? '', site.url)
    const patch: Parameters<typeof db.updateSite>[1] = {
      last_poll_at: new Date(nowMs).toISOString(),
      last_items: res.items.length,
    }
    if (res.items.length) {
      patch.zero_streak = 0
      patch.last_ok_at = new Date(nowMs).toISOString()
      if (site.status === 'degraded') patch.status = 'active'
    } else {
      const streak = site.zero_streak + 1
      patch.zero_streak = streak
      if (streak >= ZERO_STREAK_DEGRADE && site.status === 'active') patch.status = 'degraded'
    }
    const { raws, pushed, hits } = settle(site.id, res.items, firstEver)
    patch.cache_json = JSON.stringify(raws)
    db.updateSite(site.id, patch)
    if (pushed || hits) log.info(`${site.label}: +${pushed} pushed, ${hits} hits`)
    return raws
  }

  // ---- 预览/重分析（UI 调用）----
  const fetchPage = async (url: string, proxy?: string): Promise<{ ok: true; body: string } | { ok: false; error: string }> => {
    const doc = await getDoc(mctx(url), bf, host(url), url, { proxy })
    if ('error' in doc) return { ok: false, error: `fetch failed: ${doc.error}` }
    if (looksLikeChallenge(doc.body ?? '', doc.status)) return { ok: false, error: `page blocked (${doc.status}): likely login/challenge` }
    return { ok: true, body: doc.body ?? '' }
  }
  const preview = async (url: string, proxy?: string) => {
    if (!llm) return { ok: false as const, error: 'LLM service unavailable — configure a model provider first' }
    const page = await fetchPage(url, proxy)
    if (!page.ok) return page
    if (bf) bf.declareDomains(name, [...new Set([...domains(), host(url)])])
    return generateRule(llm, url, page.body, { log, route: routeHint() })
  }
  const domains = () => db.sites().map((s) => host(s.url))
  const reanalyze = async (siteId: number) => {
    const site = db.site(siteId)
    if (!site) return { ok: false, error: 'site not found' }
    const r = await preview(site.url)
    if (!r.ok) return { ok: false, error: r.error }
    db.updateSite(siteId, { pending_rules_json: JSON.stringify(r.rule), status: 'rules_pending' })
    return { ok: true, groups: r.groups }
  }

  /** 新站启用后立即基线一轮（不等主插件下个全局 tick） */
  const kickSite = (siteId: number) => {
    const site = db.site(siteId)
    if (!site) return
    void handler({ id: String(site.id), url: site.url, title: site.label }, mctx(site.url))
      .catch((e) => log.warn(`kick ${site.label} failed: ${(e as Error).message}`))
  }

  // ---- 注册 ----
  ctx.rndSources.registerMethod(METHOD, handler as Parameters<typeof ctx.rndSources.registerMethod>[1])
  ctx.rndSources.registerView(name, { id: 'zhuikan', title: '追看', url: `${BASE}/` })
  void syncSources().then(() => {
    const n = db.sites().filter((s) => s.enabled === 1).length
    if (n) log.info(`restored ${n} site source(s) into main scheduler`)
  })
  const llmTest = async () => {
    if (!llm) return { ok: false, error: 'no llm service' }
    const t0 = Date.now()
    try {
      const { generateText, resolveRoute } = await import('./llm.js')
      const route = await resolveRoute(llm, routeHint())
      const text = await generateText(llm, 'Reply with exactly this JSON: {"ok":true}', { maxTokens: 512, route: routeHint() })
      return { ok: true, route: `${route.provider}/${route.model}`, text: text.slice(0, 200), ms: Date.now() - t0 }
    } catch (e) {
      return { ok: false, error: (e as Error).message, ms: Date.now() - t0 }
    }
  }
  ctx.inject(['webServer'], (c) => {
    const dispose = mountUi((c as unknown as { webServer: WebServerLike }).webServer, {
      db, log, preview, syncSources, kickSite, reanalyze, llmReady: () => llm !== undefined, llmTest,
    })
    c.effect(() => dispose)
  })
  ctx.effect(() => () => { db.close() })
  log.info(`zhuikan: method=${METHOD}, db=${resolveDataDir()}`)
}
