/**
 * 传输层三级链（M1 实现两级）：node fetch → browserFetch 页内 fetch。
 * bf.renderHtml（第三级，JS 渲染站）M3 再补——见 docs/design.md §11。
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
  /** M3：渲染后 outerHTML（有界 API，不暴露裸 evaluate） */
  renderHtml?(domain: string, url: string, opts?: { waitMs?: number }): Promise<{ status: number; html: string }>
  markAuthRequired?(domain: string, on?: boolean): void
}

export type Doc = Awaited<ReturnType<MethodCtx['fetch']>>

export interface FetchOpt {
  preferBrowser?: boolean
  headers?: Record<string, string>
  method?: string
  body?: string
  /** 站级代理（http://host:port）——node 档经 undici ProxyAgent；browser 档不支持（Chrome 进程级代理） */
  proxy?: string
}

export async function getDoc(
  ctx: MethodCtx,
  bf: BrowserFetchLike | undefined,
  domain: string,
  url: string,
  opt?: FetchOpt,
): Promise<Doc> {
  if (!opt?.preferBrowser || !bf) return nodeThenBrowser(ctx, bf, domain, url, opt)
  try {
    const b = await bf.fetch(domain, url, { method: opt.method, headers: opt.headers, body: opt.body })
    return { url, status: b.status, body: b.body }
  } catch {
    return nodeThenBrowser(ctx, undefined, domain, url, opt)
  }
}

async function nodeThenBrowser(
  ctx: MethodCtx,
  bf: BrowserFetchLike | undefined,
  domain: string,
  url: string,
  opt?: FetchOpt,
): Promise<Doc> {
  const r = await ctx.fetch(url, ctx.signal, { headers: opt?.headers, proxy: opt?.proxy || undefined })
  if (!('error' in r) || !bf) return r
  try {
    const b = await bf.fetch(domain, url, { method: opt?.method, headers: opt?.headers, body: opt?.body })
    return { url, status: b.status, body: b.body }
  } catch {
    return r
  }
}

const CHALLENGE_RE = /captcha|滑块|安全验证|访问验证|challenge|login required/i
export function looksLikeChallenge(body: string, status: number): boolean {
  if (status === 401 || status === 403 || status === 429) return true
  return CHALLENGE_RE.test(body.slice(0, 2000))
}
export function markAuth(bf: BrowserFetchLike | undefined, domain: string, on = true): void {
  bf?.markAuthRequired?.(domain, on)
}
