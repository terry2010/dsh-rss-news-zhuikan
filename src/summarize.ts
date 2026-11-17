/**
 * 页面骨架化：剥掉噪音、折叠同构重复节点，产出 LLM 可读的 DOM 摘要。
 * 保留 class/id/href/datetime 等结构性属性与数据岛 script——
 * 模型要看到原始结构才写得出可执行选择器。
 */

import { load } from './vendor/cheerio.js'
import type { AnyNode } from './vendor/cheerio.js'

const BUDGET = 40_000
/** 数据岛保留（ssr adapter 要拿它）；其余 script/style 全剥 */
const ISLAND_RE = /application\/(ld\+)?json|__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__APOLLO_STATE__|data-island/i

export function summarize(html: string, url: string): string {
  const $ = load(html)
  $('script').each((_, el) => {
    const $el = $(el)
    const marker = `${$el.attr('type') ?? ''} ${$el.attr('id') ?? ''}`
    if (!ISLAND_RE.test(marker)) $el.remove()
  })
  $('style, noscript, iframe, svg, canvas, form, input, select, textarea').remove()
  $('*').each((_, el) => {
    const node = el as { type?: string; attribs?: Record<string, string>; children?: AnyNode[] }
    if (node.attribs) {
      for (const k of Object.keys(node.attribs)) {
        // 结构属性保留；样式/事件/追踪属性剥掉
        if (!/^(class|id|href|src|type|datetime|data-|aria-|role|title|alt|action|method|name|value)$/i.test(k) || /^on/i.test(k)) {
          delete node.attribs[k]
        }
      }
    }
  })
  collapseRepeats($, 'body')
  let out = `<base url="${url}">\n` + ($('body').html() ?? $.html())
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  if (out.length > BUDGET) out = out.slice(0, BUDGET) + '\n<!-- truncated -->'
  return out
}

/** 同签名兄弟节点保留前 3 个，其余折叠为注释占位——列表结构可见、token 不爆 */
function collapseRepeats($: ReturnType<typeof load>, rootSel: string): void {
  $(rootSel).find('*').each((_, parent) => {
    const kids = $(parent).children()
    if (kids.length < 6) return
    const groups = new Map<string, number[]>()
    kids.each((i, kid) => {
      const el = kid as { tagName?: string; name?: string; attribs?: Record<string, string> }
      const tag = el.tagName || el.name || '?'
      const cls = (el.attribs?.class ?? '').split(/\s+/).filter(Boolean).sort().join('.')
      const sig = `${tag}.${cls}`
      groups.set(sig, [...(groups.get(sig) ?? []), i])
    })
    for (const idxs of groups.values()) {
      if (idxs.length > 3) {
        for (let j = idxs.length - 1; j >= 3; j--) {
          const el = kids.get(idxs[j]!)
          $(el).replaceWith(j === 3 ? `<!-- +${idxs.length - 3} more -->` : '')
        }
      }
    }
  })
}
