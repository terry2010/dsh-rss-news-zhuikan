/**
 * 规则生成管线：fetch → summarize → LLM 出规则 → schema 校验 → 试抽验证。
 * LLM 缺席/失败/校验不过均返回明确 error——调用方（UI）按错误文案指路。
 * 重试带证据回喂（上次试抽结果进 prompt），比盲重试收敛快。
 */

import { extract } from './extract.js'
import { generateText, type LlmLike, type RouteHint } from './llm.js'
import { validateRule, type SiteRule } from './rules.js'
import { summarize } from './summarize.js'

export interface PreviewGroup {
  label: string
  regionIndex: number
  count: number
  /** 位置定位（fragile）标 */
  byIndex?: boolean
  items: { title: string; link: string | null; pubTime: string | null; category: string | null }[]
}
export interface PreviewOk {
  ok: true
  rule: SiteRule
  groups: PreviewGroup[]
  total: number
}
export type PreviewResult = PreviewOk | { ok: false; error: string; rawTail?: string; needsAuth?: boolean; pageKind?: string }

/** AI 判页：列表/登录墙/挑战页/空页——小页或抽取 0 条时的兜底判定（正则盖不全登录墙形态）。 */
export async function classifyPage(
  llm: LlmLike, url: string, body: string, route?: RouteHint,
): Promise<'list' | 'login' | 'challenge' | 'empty' | 'other'> {
  try {
    const snippet = body.slice(0, 6000)
    const text = await generateText(llm,
      `Page URL: ${url}\n\nHTML:\n${snippet}\n\nClassify this page into exactly one word: list (shows a list of links/posts), login (requires login to see content), challenge (bot/verification page), empty (blank/error/other). Reply ONLY the word.`,
      { maxTokens: 16, temperature: 0, route })
    const w = text.trim().toLowerCase().replace(/[^a-z]/g, '')
    return (['list', 'login', 'challenge', 'empty'] as const).includes(w as 'list') ? (w as 'list') : 'other'
  } catch {
    return 'other'
  }
}

const SYS = `You generate extraction rules for subscribing to a web list page. Output STRICT JSON only, no prose.
Rule shapes (pick exactly one "type"):
- {"type":"json","api":"URL","method":"GET","items":"dotted.path","map":{"title":"path","link":"path","id":"path?","time":"path?","views":"path?","category":"path?","extra":"path?"}} — prefer when the page fetches a same-origin JSON list API or embeds a clear JSON list.
- {"type":"ssr","sel":"script#ID","items":"dotted.path","map":{...same as json}} — when a data island script tag (e.g. __NEXT_DATA__) holds the list.
- {"type":"css","item":"selector of ONE item element","regions":[{"sel":"container selector","label":"…","anchor":{"sel":"heading sel","text":"heading text"},"index":N}],"map":{"title":"sel","link":"sel to a","id":"sel?","time":"sel?","views":"sel?","category":"sel?","extra":"sel?"}}
Field rules: all map selectors are relative to the item element; only title is required — omit fields not present (never fabricate views/time). For css map.link pick the element whose <a> carries the item URL (or the item itself if it is an <a>).
Regions: enumerate ALL isomorphic list regions on the page (multiple boards/sections each listing newest items). Give each a short label from its nearest visible heading. When several regions share the same container selector, MUST disambiguate with anchor{text} = nearest heading text; only use "index" (0-based) when no heading exists.
api/linkBase must stay on the same site domain as the page URL. Keep selectors simple (tag/class/id/attr); prefer stable semantic classes over hashed ones.`

function extractJson(text: string): unknown {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const raw = m ? m[1]! : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in LLM output')
  return JSON.parse(raw.slice(start, end + 1))
}

export async function generateRule(
  llm: LlmLike,
  pageUrl: string,
  html: string,
  opt?: { signal?: AbortSignal; route?: RouteHint; log?: { info(m: string): void; warn(m: string): void } },
): Promise<PreviewResult> {
  const skeleton = summarize(html, pageUrl)
  let feedback = ''
  let lastErr = ''
  let lastTail = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = `Page URL: ${pageUrl}\n\nSkeleton HTML:\n${skeleton}\n${feedback}\n\nOutput the rule JSON.`
    let raw: unknown
    try {
      const text = await generateText(llm, prompt, { system: SYS, maxTokens: 16384, signal: opt?.signal, route: opt?.route })
      opt?.log?.info(`rulegen attempt ${attempt}: ${text.length} chars; tail=${JSON.stringify(text.slice(-120))}`)
      lastTail = text
      raw = extractJson(text)
    } catch (e) {
      lastErr = `LLM failed: ${(e as Error).message}`
      feedback = '\nYour previous output was not valid JSON. Output only the JSON object.'
      continue
    }
    const v = validateRule(raw, pageUrl)
    if (!v.ok) {
      lastErr = `rule invalid: ${v.error}`
      feedback = `\nYour rule was rejected: ${v.error}. Fix and re-output.`
      continue
    }
    // 试抽验证：css 吃 html；json adapter 这里无法验证（api 未抓）——放行让首轮轮询兜底
    const res = v.rule.type === 'json'
      ? { items: [], regionCounts: undefined }
      : extract(v.rule, html, pageUrl)
    if (v.rule.type !== 'json' && !res.items.length) {
      lastErr = 'trial extraction returned 0 items'
      feedback = '\nYour rule extracted 0 items from the skeleton page. Pick different selectors.'
      continue
    }
    const groups: PreviewGroup[] = v.rule.type === 'css' && v.rule.regions?.length
      ? v.rule.regions.map((r, i) => ({
          label: r.label, regionIndex: i, byIndex: r.index !== undefined,
          count: res.regionCounts?.[i]?.count ?? 0,
          items: res.items.filter((it) => it.region === r.label).slice(0, 10)
            .map((it) => ({ title: it.title, link: it.link, pubTime: it.pubTime, category: it.category })),
        }))
      : [{
          label: v.rule.type === 'json' ? `API ${v.rule.api}` : v.rule.type === 'ssr' ? `data island ${v.rule.sel}` : 'items',
          regionIndex: 0, count: res.items.length,
          items: res.items.slice(0, 10).map((it) => ({ title: it.title, link: it.link, pubTime: it.pubTime, category: it.category })),
        }]
    return { ok: true, rule: v.rule, groups, total: res.items.length }
  }
  return { ok: false, error: lastErr || 'rulegen failed', rawTail: lastTail.slice(-400) }
}
