/**
 * SiteRule 数据契约 + 校验——AI 生成规则的信任边界，这里做确定性闸门。
 * 详见 docs/design.md §3（不入库）。
 */

/** css adapter 的字段映射：选择器均为相对 item 元素的子选择器。title 必填，其余尽力而为。 */
export interface CssFieldMap {
  title: string
  /** 指向 <a> 元素；取 href。缺省用 item 元素本身（若是 <a>） */
  link?: string
  /** 稳定 id 来源（attr 值/文本）；缺省走 link→hash 回退 */
  id?: string
  /** 原始时间文本（原样入库 pub_time，另解析 pub_ts） */
  time?: string
  views?: string
  category?: string
  /** 兜底额外文本（进 extra_json） */
  extra?: string
}

/** json/ssr adapter 的字段映射：dotted path（a.b.0.c）。title 必填。 */
export interface JsonFieldMap {
  title: string
  link?: string
  id?: string
  time?: string
  views?: string
  category?: string
  extra?: string
}

/** 区域三级定位：A=anchor 文本锚（最稳）B=独立 sel C=index 位置（易漂移）。 */
export interface RegionRule {
  /** 区域容器选择器（anchor/index 模式下与同构邻区可相同） */
  sel: string
  label: string
  /** A 级：先找 sel 内 textContent 含 text 的锚元素，再取其邻近同构列表容器 */
  anchor?: { sel: string; text: string }
  /** C 级：sel 命中多个容器时取第 N 个（0 起） */
  index?: number
}

export interface CssRule { type: 'css'; item: string; regions?: RegionRule[]; map: CssFieldMap }
export interface JsonRule {
  type: 'json'
  /** 列表 JSON 端点（必须与站点 url 同 eTLD+1） */
  api: string
  method?: 'GET' | 'POST'
  body?: string
  /** items 数组的 dotted path */
  items: string
  /** 相对 link 的基底；必须与站点同 eTLD+1 */
  linkBase?: string
  map: JsonFieldMap
}
export interface SsrRule {
  type: 'ssr'
  /** 数据岛 script 选择器，如 script#__NEXT_DATA__ */
  sel: string
  /** 岛 JSON 内 items 数组的 dotted path */
  items: string
  linkBase?: string
  map: JsonFieldMap
}
export interface LlmRule { type: 'llm'; hint?: string }
export type SiteRule = CssRule | JsonRule | SsrRule | LlmRule

const SEL_MAX = 200
const PATH_RE = /^[A-Za-z_][\w$]*(\.(\d+|[A-Za-z_][\w$]*))*$/

/** eTLD+1 简化判定：末两段相同（够挡跨域 api/linkBase 注入） */
export function sameSite(a: string, b: string): boolean {
  try {
    const pa = new URL(a).hostname.toLowerCase().split('.')
    const pb = new URL(b).hostname.toLowerCase().split('.')
    return pa.slice(-2).join('.') === pb.slice(-2).join('.')
  } catch { return false }
}

function okSel(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= SEL_MAX
}
function okPath(s: unknown): s is string {
  return typeof s === 'string' && PATH_RE.test(s) && s.length <= 300
}
function mapErr(map: unknown, paths: boolean): string | undefined {
  if (typeof map !== 'object' || !map) return 'map missing'
  const m = map as Record<string, unknown>
  const check = paths ? okPath : okSel
  if (!check(m.title)) return 'map.title invalid'
  for (const k of ['link', 'id', 'time', 'views', 'category', 'extra']) {
    if (m[k] !== undefined && !check(m[k])) return `map.${k} invalid`
  }
  return undefined
}

export type Validated = { ok: true; rule: SiteRule } | { ok: false; error: string }
export function validateRule(raw: unknown, siteUrl: string): Validated {
  if (typeof raw !== 'object' || !raw) return { ok: false, error: 'rule not object' }
  const r = raw as Record<string, unknown>
  switch (r.type) {
    case 'css': {
      if (!okSel(r.item)) return { ok: false, error: 'css.item invalid' }
      const me = mapErr(r.map, false)
      if (me) return { ok: false, error: `css ${me}` }
      if (r.regions !== undefined) {
        if (!Array.isArray(r.regions) || !r.regions.length) return { ok: false, error: 'regions empty' }
        for (const [i, g] of r.regions.entries()) {
          const gg = g as Record<string, unknown>
          if (!okSel(gg.sel)) return { ok: false, error: `regions[${i}].sel invalid` }
          if (typeof gg.label !== 'string' || !gg.label) return { ok: false, error: `regions[${i}].label missing` }
          if (gg.anchor !== undefined) {
            const a = gg.anchor as Record<string, unknown>
            if (!okSel(a.sel) || typeof a.text !== 'string' || !a.text) return { ok: false, error: `regions[${i}].anchor invalid` }
          }
          if (gg.index !== undefined && (!Number.isInteger(gg.index) || (gg.index as number) < 0)) {
            return { ok: false, error: `regions[${i}].index invalid` }
          }
        }
      }
      return { ok: true, rule: r as unknown as CssRule }
    }
    case 'json': {
      if (typeof r.api !== 'string' || !/^https?:\/\//.test(r.api)) return { ok: false, error: 'json.api invalid' }
      if (!sameSite(r.api, siteUrl)) return { ok: false, error: `json.api off-site: ${r.api}` }
      if (!okPath(r.items)) return { ok: false, error: 'json.items path invalid' }
      if (r.method !== undefined && r.method !== 'GET' && r.method !== 'POST') return { ok: false, error: 'json.method invalid' }
      if (r.body !== undefined && typeof r.body !== 'string') return { ok: false, error: 'json.body invalid' }
      if (r.linkBase !== undefined && (typeof r.linkBase !== 'string' || !sameSite(r.linkBase, siteUrl))) {
        return { ok: false, error: 'json.linkBase off-site' }
      }
      const me = mapErr(r.map, true)
      if (me) return { ok: false, error: `json ${me}` }
      return { ok: true, rule: r as unknown as JsonRule }
    }
    case 'ssr': {
      if (!okSel(r.sel)) return { ok: false, error: 'ssr.sel invalid' }
      if (!okPath(r.items)) return { ok: false, error: 'ssr.items path invalid' }
      if (r.linkBase !== undefined && (typeof r.linkBase !== 'string' || !sameSite(r.linkBase, siteUrl))) {
        return { ok: false, error: 'ssr.linkBase off-site' }
      }
      const me = mapErr(r.map, true)
      if (me) return { ok: false, error: `ssr ${me}` }
      return { ok: true, rule: r as unknown as SsrRule }
    }
    case 'llm':
      return { ok: true, rule: { type: 'llm', hint: typeof r.hint === 'string' ? r.hint.slice(0, 500) : undefined } }
    default:
      return { ok: false, error: `unknown rule type: ${String(r.type)}` }
  }
}
