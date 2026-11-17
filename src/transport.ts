/**
 * 传输层三级链（M1 实现两级）：node fetch → browserFetch 页内 fetch。
 * bf.renderHtml（第三级，JS 渲染/挑战页）——browser-fetch apiVersion≥2 时可用。
 */

import type { MethodCtx } from 'dsh-rss-news-daily'

export interface BrowserFetchLike {
  declareDomains(caller: string, domains: string[]): void
  fetch(domain: string, url: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    credentials?: 'omit' | 'same-origin' | 'include'
    referrer?: string
  }): Promise<{ status: number; body: string }>
  /** 渲染后 outerHTML + 落地 URL（有界 API，不暴露裸 evaluate） */
  renderHtml?(domain: string, url: string, opts?: { waitMs?: number }): Promise<{ status: number; html: string; url: string }>
  markAuthRequired?(domain: string, on?: boolean): void
  /** 前台打开授权页（用户登录/过验证） */
  openForAuth?(domain: string, url?: string): Promise<boolean>
}

export interface FetchOpt {
  preferBrowser?: boolean
  headers?: Record<string, string>
  method?: string
  body?: string
  /** 站级代理：'1'/'true' = 主插件全局代理（prefs.proxyUrl）；URL = 显式代理；空 = 直连 */
  proxy?: string
}

/** 站级 proxy 字段 → ctx.fetch 的 proxy 参数（'1'→true 走全局；URL 透传；空→undefined 直连） */
const proxyArg = (p?: string): string | boolean | undefined =>
  !p ? undefined : (p === '1' || p === 'true' || p === 'global') ? true : p

export type Doc = Awaited<ReturnType<MethodCtx['fetch']>> & { transport?: string }

export async function getDoc(
  ctx: MethodCtx,
  bf: BrowserFetchLike | undefined,
  domain: string,
  url: string,
  opt?: FetchOpt,
): Promise<Doc> {
  let doc = await (opt?.preferBrowser && bf ? browserFirst(ctx, bf, domain, url, opt) : nodeThenBrowser(ctx, bf, domain, url, opt))
  // 挑战页 → 先补一次 bf.fetch（Chrome 里可能已有通过挑战的 cookie，比渲染档便宜）
  if (bf && !('error' in doc) && looksLikeChallenge(doc.body ?? '', doc.status) && doc.transport !== 'browser') {
    try {
      const b = await bf.fetch(domain, url, { method: opt?.method, headers: opt?.headers, body: opt?.body })
      doc = { url, status: b.status, body: b.body, transport: 'browser' }
    } catch { /* bf.fetch 挂 → 继续尝试渲染档 */ }
  }
  // 仍挑战或疑似 JS 壳页 → 渲染档（有 bf.renderHtml 时）：导航真页面等 JS 自己跑完。
  // 挑战页再补一次渲染：Chrome 冷启动/会话 cookie 过期后的首轮渲染常落在 PoW 解题中，
  // 第二次导航时解出的 cookie 已入罐，多数直接放行。
  if (bf?.renderHtml && !('error' in doc) && (looksLikeChallenge(doc.body ?? '', doc.status) || looksLikeShell(doc.body ?? ''))) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await bf.renderHtml(domain, url, { waitMs: attempt === 0 ? 8000 : 15000 })
        if (r.html && !looksLikeChallenge(r.html, r.status)) return { url: r.url, status: r.status, body: r.html, transport: 'render' }
        doc = { url: r.url, status: r.status, body: r.html || doc.body, transport: 'render' }
        if (!looksLikeChallenge(doc.body ?? '', doc.status)) return doc
      } catch { break /* 渲染档挂 → 落回原 doc，调用方按挑战/壳页处理 */ }
    }
  }
  return doc
}

async function browserFirst(
  ctx: MethodCtx, bf: BrowserFetchLike, domain: string, url: string, opt?: FetchOpt,
): Promise<Doc> {
  try {
    const b = await bf.fetch(domain, url, { method: opt?.method, headers: opt?.headers, body: opt?.body })
    return { url, status: b.status, body: b.body, transport: 'browser' }
  } catch {
    return nodeThenBrowser(ctx, undefined, domain, url, opt)
  }
}

async function nodeThenBrowser(
  ctx: MethodCtx, bf: BrowserFetchLike | undefined, domain: string, url: string, opt?: FetchOpt,
): Promise<Doc> {
  const r = await ctx.fetch(url, ctx.signal, { headers: opt?.headers, proxy: proxyArg(opt?.proxy) })
  if (!('error' in r)) return { ...r, transport: 'node' }
  if (!bf) return r
  try {
    const b = await bf.fetch(domain, url, { method: opt?.method, headers: opt?.headers, body: opt?.body })
    return { url, status: b.status, body: b.body, transport: 'browser' }
  } catch {
    return r
  }
}

const CHALLENGE_RE = /captcha|滑块|安全验证|访问验证|浏览器验证|challenge|just a moment|pow\.worker|cf-challenge|login required/i
export function looksLikeChallenge(body: string, status: number): boolean {
  if (status === 401 || status === 403 || status === 429) return true
  return CHALLENGE_RE.test(body.slice(0, 2000))
}
export function markAuth(bf: BrowserFetchLike | undefined, domain: string, on = true): void {
  bf?.markAuthRequired?.(domain, on)
}

/** 登录墙判定（与挑战页分开）：显式拒绝语只在首屏小体上才信——正常页导航里的「登录」字样不误伤。 */
const LOGIN_RE = /未登录|访问受限|请登录|登录后|需要登录|sign in required|login required|unauthorized access/i
export function looksLikeLogin(body: string, status: number): boolean {
  if (body.length > 60_000) return false // 真列表页不至于这么长还带登录墙
  const title = /<title[^>]*>([^<]{0,80})<\/title>/i.exec(body)?.[1] ?? ''
  return LOGIN_RE.test(title) || (LOGIN_RE.test(body.slice(0, 1500)) && body.length < 8_000)
}

/** JS 壳页判定：SPA 未渲染的骨架——小 body + Loading 类标题，或剥光脚本后几乎无链接无文本。 */
const SHELL_TITLE_RE = /<title[^>]*>\s*(loading|please wait|just a moment|请稍候|加载中|checking)/i
export function looksLikeShell(body: string): boolean {
  if (body.length > 8000) return false
  if (SHELL_TITLE_RE.test(body)) return true
  const links = (body.match(/<a[\s>]/gi) ?? []).length
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return links < 3 && text.length < 300
}
