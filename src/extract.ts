/**
 * 抽取引擎：按 SiteRule 把 HTML/JSON 变成 ZkItem[]。
 * adapter 优先级 json > ssr > css > llm(兜底)——rulegen 已决定 type，这里只执行。
 */

import { createHash } from 'node:crypto'
import { load } from './vendor/cheerio.js'
import type { AnyNode, Cheerio, CheerioAPI } from './vendor/cheerio.js'
import type { CssRule, JsonRule, RegionRule, SiteRule, SsrRule } from './rules.js'

export interface ZkItem {
  dedupeKey: string
  title: string
  link: string | null
  pubTime: string | null
  pubTs: number | null
  views: number | null
  category: string | null
  region: string | null
  extra: string | null
}

export interface ExtractResult {
  items: ZkItem[]
  /** 每个区域的命中数（css adapter；json/ssr 单组恒为 1 项） */
  regionCounts?: { label: string; count: number }[]
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

/** dotted path 取值：a.b.0.c */
function dig(obj: unknown, path: string): unknown {
  let cur = obj
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

const abs = (href: string | undefined | null, base: string): string | null => {
  if (!href) return null
  try { return new URL(href, base).href } catch { return null }
}

/** 时间原文 → epoch ms。ISO/常见格式 + 中英相对时间（锚=抓取时刻）。 */
export function parseTime(raw: string | null | undefined, anchor = Date.now()): number | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s) return null
  const iso = Date.parse(s)
  if (Number.isFinite(iso)) return iso
  let m = /^(\d+)\s*(秒|分钟|小时|天|周|个月|年)前/.exec(s)
  if (m) {
    const n = Number(m[1])
    const unit = { 秒: 1e3, 分钟: 60e3, 小时: 3600e3, 天: 86400e3, 周: 604800e3, 个月: 2592e6, 年: 31536e6 }[m[2]!]!
    return anchor - n * unit
  }
  m = /^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.exec(s)
  if (m) {
    const n = Number(m[1])
    const unit: Record<string, number> = { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3, month: 2592e6, year: 31536e6 }
    return anchor - n * unit[m[2]!.toLowerCase()]!
  }
  m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(s)
  if (m) {
    const t = /(\d{1,2})[:：](\d{2})/.exec(s)
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0)
    return d.getTime()
  }
  m = /(\d{1,2})[-/](\d{1,2})\s+(\d{1,2})[:：](\d{2})/.exec(s) // MM-DD HH:mm（当年）
  if (m) {
    const d = new Date(new Date(anchor).getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]))
    return d.getTime()
  }
  if (/刚刚|刚才|just now/i.test(s)) return anchor
  if (/昨天|yesterday/i.test(s)) {
    const t = /(\d{1,2})[:：](\d{2})/.exec(s)
    const d = new Date(anchor)
    d.setDate(d.getDate() - 1)
    if (t) { d.setHours(Number(t[1]), Number(t[2]), 0, 0) }
    return d.getTime()
  }
  return null
}

const toInt = (s: string | null | undefined): number | null => {
  if (!s) return null
  const m = /([\d,.]+)\s*([kKwW万])?/.exec(s.replace(/[^\d,.\w万]/g, ' '))
  if (!m) return null
  let n = Number(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  if (/[wW万]/.test(m[2] ?? '')) n *= 10_000
  else if (/k/i.test(m[2] ?? '')) n *= 1_000
  return Math.round(n)
}

// ---------------- json / ssr ----------------

function jsonItems(rows: unknown[], map: JsonRule['map'], base: string, region?: string): ZkItem[] {
  const out: ZkItem[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || !row) continue
    const str = (p?: string) => {
      const v = p ? dig(row, p) : undefined
      return v === undefined || v === null ? null : String(v)
    }
    const title = str(map.title)?.trim()
    if (!title) continue
    const link = abs(str(map.link), base)
    const id = str(map.id)
    const pubTime = str(map.time)
    const pubTs = parseTime(pubTime)
    const dedupeKey = id ? `id:${id}` : link ? `link:${link}` : `h:${sha1(`${title}|${pubTime ?? ''}`)}`
    out.push({
      dedupeKey, title, link, pubTime, pubTs,
      views: toInt(str(map.views)), category: str(map.category),
      region: region ?? null, extra: str(map.extra),
    })
  }
  return out
}

export function extractJson(rule: JsonRule, body: string, siteUrl: string): ExtractResult {
  const data = JSON.parse(body) as unknown
  const rows = dig(data, rule.items)
  if (!Array.isArray(rows)) return { items: [] }
  const base = rule.linkBase ?? siteUrl
  return { items: jsonItems(rows, rule.map, base) }
}

export function extractSsr(rule: SsrRule, html: string, siteUrl: string): ExtractResult {
  const $ = load(html)
  const el = $(rule.sel).first()
  if (!el.length) return { items: [] }
  const raw = el.text().trim()
  try {
    const data = JSON.parse(raw) as unknown
    const rows = dig(data, rule.items)
    if (!Array.isArray(rows)) return { items: [] }
    return { items: jsonItems(rows, rule.map, rule.linkBase ?? siteUrl) }
  } catch {
    return { items: [] }
  }
}

// ---------------- css ----------------

/** 区域容器三级定位：anchor 文本锚 → index 序号 → 全量 sel */
function regionContainers($: CheerioAPI, region: RegionRule): Cheerio<AnyNode>[] {
  if (region.anchor) {
    const anchorEl = $(region.anchor.sel).filter((_, el) =>
      $(el).text().includes(region.anchor!.text)).first()
    if (!anchorEl.length) return []
    // 就近后继：先平级 nextAll，再父链逐层向上找 nextAll——命中首个含条目匹配的容器
    let scope = anchorEl.nextAll()
    let el = anchorEl.parent()
    for (let depth = 0; depth < 4 && el.length; depth++) {
      scope = scope.add(el.nextAll())
      el = el.parent()
    }
    const hit = scope.filter((_, e) => $(e).is(region.sel) || $(e).find(region.sel).length > 0).first()
    if (!hit.length) return []
    const containers = hit.is(region.sel) ? hit : hit.find(region.sel).first()
    return [containers]
  }
  const all = $(region.sel)
  if (region.index !== undefined) {
    const el = all.eq(region.index)
    return el.length ? [el] : []
  }
  return all.toArray().map((el) => $(el))
}

function textOf($: CheerioAPI, item: Cheerio<AnyNode>, sel?: string): string | null {
  if (!sel) return null
  const el = item.is(sel) ? item : item.find(sel).first()
  if (!el.length) return null
  const t = (el.attr('datetime') ?? el.attr('title') ?? '').trim() || el.text().replace(/\s+/g, ' ').trim()
  return t || null
}

export function extractCss(rule: CssRule, html: string, siteUrl: string): ExtractResult {
  const $ = load(html)
  const regions: { label: string; containers: Cheerio<AnyNode>[] }[] =
    rule.regions?.length
      ? rule.regions.map((r) => ({ label: r.label, containers: regionContainers($, r) }))
      : [{ label: '', containers: [$('html') as Cheerio<AnyNode>] }]

  const items: ZkItem[] = []
  const regionCounts: { label: string; count: number }[] = []
  const seen = new Set<string>()
  for (const { label, containers } of regions) {
    let count = 0
    for (const c of containers) {
      c.find(rule.item).each((_, el) => {
        const item = $(el)
        const titleEl = item.is(rule.map.title) ? item : item.find(rule.map.title).first()
        const title = (titleEl.text() || '').replace(/\s+/g, ' ').trim()
        if (!title) return
        const linkSel = rule.map.link ?? rule.map.title
        const linkEl = item.is('a') ? item
          : item.find(linkSel).filter((_, e) => (e as { tagName?: string }).tagName === 'a' || $(e).find('a').length > 0).first()
        const a = linkEl.is('a') ? linkEl : linkEl.find('a').first()
        const link = abs(a.attr('href'), siteUrl)
        const id = textOf($, item, rule.map.id) ?? a.attr('data-id') ?? null
        const pubTime = textOf($, item, rule.map.time)
        const pubTs = parseTime(pubTime)
        const dedupeKey = id ? `id:${id}` : link ? `link:${link}` : `h:${sha1(`${title}|${pubTime ?? ''}`)}`
        if (seen.has(dedupeKey)) return // 跨区域重复：region 记首个
        seen.add(dedupeKey)
        count++
        items.push({
          dedupeKey, title, link, pubTime, pubTs,
          views: toInt(textOf($, item, rule.map.views)),
          category: textOf($, item, rule.map.category),
          region: label || null,
          extra: textOf($, item, rule.map.extra),
        })
      })
    }
    regionCounts.push({ label, count })
  }
  return { items, regionCounts }
}

/** 统一入口：按 rule.type 分发（html 或 json body 由调用方按 type 传入）。 */
export function extract(rule: SiteRule, body: string, siteUrl: string): ExtractResult {
  switch (rule.type) {
    case 'json': return extractJson(rule, body, siteUrl)
    case 'ssr': return extractSsr(rule, body, siteUrl)
    case 'css': return extractCss(rule, body, siteUrl)
    case 'llm': return { items: [] } // M3+ 兜底：规则确认前不落 llm-adapter
  }
}
