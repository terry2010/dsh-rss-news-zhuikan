/**
 * 关键词订阅匹配 + 推送判定（docs/design.md §5.1）。
 * 按站独立判定：适用词集 = 全局词 + 该站站级词。
 *  - 适用词集为空 → 不推送（推送=关键词命中提醒；全部条目反正进全部新闻，
 *    空词表全量推等于每轮骚扰）
 *  - 非空 → 只推命中项并写 hits；未命中安静入库
 */

import type { ItemRow, TermRow } from './db.js'

export interface NewItem extends ItemRow { isNew?: boolean }

/** 粗筛：term 小写子串匹配 title+category+region（大小写不敏感） */
export function matchTerms(item: ItemRow, terms: TermRow[]): string[] {
  const hay = `${item.title} ${item.category ?? ''} ${item.region ?? ''}`.toLowerCase()
  return terms.filter((t) => hay.includes(t.term.toLowerCase())).map((t) => t.term)
}

export interface PushDecision {
  push: boolean
  /** 命中的词（有 hits 要写时） */
  terms: string[]
}
export function decidePush(item: ItemRow, applicableTerms: TermRow[]): PushDecision {
  if (!applicableTerms.length) return { push: false, terms: [] }
  const terms = matchTerms(item, applicableTerms)
  return { push: terms.length > 0, terms }
}
