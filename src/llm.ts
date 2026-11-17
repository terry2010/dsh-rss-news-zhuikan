/**
 * ctx.llm 宿主服务封装：与主插件同一个 provider/model 池，零配置。
 * 解析优先级：① 主插件 prefs.json llm.provider/model（用户显式路由）
 * ② 逐 provider 试 listModels（deepseek|official 优先）首个非空 catalog
 * 均失败 → LlmUnavailableError（UI 指路配置模型）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

export interface LlmLike {
  listProviders(): { id: string }[] | Promise<{ id: string }[]>
  listModels(provider: string): { id: string }[] | Promise<{ id: string }[]>
  stream(opts: {
    provider: string
    model: string
    messages: ReturnType<typeof createUserMessage>[]
    system?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string; delta?: string }>
}

export class LlmUnavailableError extends Error {}
export interface RouteHint { provider?: string; model?: string }

const MODEL_RE = /chat|flash|deepseek|v3|r1|pro|ornith|qwen|gpt/i

export async function resolveRoute(llm: LlmLike, hint?: RouteHint): Promise<{ provider: string; model: string }> {
  const providers = await llm.listProviders()
  if (!providers.length) throw new LlmUnavailableError('no LLM provider registered')
  const ids = new Set(providers.map((p) => p.id))
  // ① 用户显式路由（主插件 prefs）
  if (hint?.provider && hint?.model && ids.has(hint.provider)) {
    return { provider: hint.provider, model: hint.model }
  }
  // ② catalog 探测：provider 按偏好排序，首个非空 catalog 胜出
  const ordered = [...providers].sort((a, b) =>
    Number(/deepseek|official/i.test(b.id)) - Number(/deepseek|official/i.test(a.id)))
  for (const p of ordered) {
    const models = await Promise.resolve(llm.listModels(p.id)).catch((): { id: string }[] => [])
    if (!models.length) continue
    const model = (models.find((m) => MODEL_RE.test(m.id)) ?? models[0]!).id
    return { provider: p.id, model }
  }
  // ③ 全部空 catalog：回到偏好 provider + hint 模型或通用猜名——adapter 侧最终裁决
  const preferred = ordered[0]!.id
  if (hint?.provider && hint?.model) return { provider: preferred, model: hint.model }
  throw new LlmUnavailableError(
    `no provider advertises a model catalog (tried: ${ordered.map((p) => p.id).join(', ')})`)
}

export async function generateText(
  llm: LlmLike,
  prompt: string,
  opts?: { system?: string; maxTokens?: number; temperature?: number; signal?: AbortSignal; route?: RouteHint },
): Promise<string> {
  const route = await resolveRoute(llm, opts?.route)
  // system 折进 user prompt——部分本地模型 chat template 不支持 system 首条
  const userText = opts?.system ? `${opts.system}\n\n${prompt}` : prompt
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } })],
    maxTokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature ?? 0.1,
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  })
  let out = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && chunk.text) out += chunk.text
  }
  return out
}
