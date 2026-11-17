/**
 * 依赖提示：主插件缺席时，在 dsh 应用内弹层指路（每个缺席周期各一次）。
 *
 *  - 安装提醒：装插件起就没见过主插件 → kind='install'
 *  - 移除提醒：主插件曾被 bootstrap 见过（seenMain）、后来缺席 → kind='removal'
 * 每类 flag 只挡「本缺席周期」——markSeenMain 在主插件在场时清空，
 * 禁用/启用主插件的每个循环都会重新激活弹层；主插件在则永不弹。
 *
 * 形态：后端只挂两条 API 路由（webServer 是宿主服务，不依赖 rndSources），
 * 交互全在客户端 lib/client.js 的应用内 modal 里完成——复制走
 * navigator.clipboard（用户手势），链接走 <a target>。后端零 spawn、
 * 零 profile 变更、零剪贴板动作。
 *
 * flag 语义：dismiss POST 落 dep-state.json；弹层出现过且用户任一交互
 * （含「稍后」）即写——客户端只在用户点按钮时才发 dismiss，单纯刷新不算。
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolveDataDir } from './db.js'

export interface DepState {
  seenMain?: boolean
  installPrompted?: boolean
  removalPrompted?: boolean
}

type Log = { info(msg: string): void; warn(msg: string): void }

export const DEP_PKG = 'dsh-rss-news-daily'
export const DEP_SELF = 'dsh-rss-news-zhuikan'
export const DEP_GITHUB = 'https://github.com/terry2010/dsh-rss-news-daily'
/** 卸载指引：GitHub Discussion（卸载教程 + 意见收集帖） */
export const DEP_UNINSTALL_URL = 'https://github.com/terry2010/dsh-rss-news-zhuikan'
export const DEP_BASE = '/dsh-rss-news-zhuikan'

function statePath(dataDir: string): string {
  return join(dataDir, 'dep-state.json')
}

export function readDepState(dataDir: string): DepState {
  try {
    const s = JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as DepState
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

function writeDepState(dataDir: string, patch: DepState): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(statePath(dataDir), JSON.stringify({ ...readDepState(dataDir), ...patch }))
  } catch { /* flag 写失败不致命——下次启动再弹 */ }
}

/**
 * bootstrap 里调用：主插件在位 → 记 seenMain 并清两类 prompted。
 * flag 语义是「本缺席周期已弹」而非「一生一次」——主插件每次在场都重置，
 * 之后任一禁用/卸载事件重新激活弹层（装过主插件再卸载的场景必须还能提醒）。
 * undefined 键经 JSON.stringify 自动落盘消失。
 */
export function markSeenMain(dataDir = resolveDataDir()): void {
  writeDepState(dataDir, { seenMain: true, installPrompted: undefined, removalPrompted: undefined })
}

/** 解析自己所在的 profile：~/.dsh/profiles/<name>/node_modules/<self>/… */
export function resolveProfile(): { dir: string; name: string } | undefined {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/.exec(self)
    if (m) return { dir: join(self.slice(0, m.index!), 'profiles', m[1]!), name: m[1]! }
  } catch { /* 落到扫描 */ }
  const roots = [join(process.env.HOME || '.', '.dsh', 'profiles')]
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles'))
  for (const root of roots) {
    let names: string[] = []
    try { names = readdirSync(root) } catch { continue }
    for (const name of names) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
        const bundles: unknown[] = pkg?.dsh?.profile?.bundles ?? []
        if (bundles.includes(DEP_SELF) || pkg?.dependencies?.[DEP_SELF]) return { dir: join(root, name), name }
      } catch { /* 坏 profile 跳过 */ }
    }
  }
  return undefined
}

export function marketInstalled(profileDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles: unknown[] = pkg?.dsh?.profile?.bundles ?? []
    return bundles.includes('dshmarket') || bundles.includes('dsh-market')
  } catch {
    return false
  }
}

interface Req { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string }
interface Res {
  writeHead(code: number, headers?: Record<string, string>): void
  end(body?: string): void
}
interface WebServerLike {
  register(opts: { kind: string; path: string; handler: (req: Req, res: Res) => void | Promise<void> }): () => void
}

/**
 * 服务探测。cordis 里 ctx.inject 声明在【子插件 fiber】上——外层 ctx.<svc>
 * 永远抛 without inject（与服务是否在场无关），不能靠属性访问。
 * ctx.reflect.get(name) 是官方无 inject 要求的读法（strict 默认只认 ACTIVE
 * 提供者：禁用/卸载 → undefined）。测试假 ctx 没有 reflect → 退回直接访问。
 */
export function hasService(ctx: unknown, name: string): boolean {
  const c = ctx as Record<string, unknown> | undefined
  try {
    const reflect = c?.reflect as { get?: (n: string) => unknown } | undefined
    if (typeof reflect?.get === 'function') return reflect.get(name) !== undefined
    return Boolean(c?.[name])
  } catch {
    return false
  }
}

function json(res: Res, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

async function readBody(req: Req): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

export interface DepStatusDeps {
  dataDir: string
  /** 现场探测服务（默认看捕获的 ctx） */
  mainPresent?: () => boolean
  /** 启动宽限毫秒数内缺席视为 pending（主插件可能还在 compose 中） */
  pending?: boolean
  profile?: { dir: string; name: string }
}

export function depStatus(deps: DepStatusDeps): Record<string, unknown> {
  const state = readDepState(deps.dataDir)
  const mainPresent = deps.mainPresent?.() ?? false
  const pending = !mainPresent && Boolean(deps.pending)
  const kind: 'install' | 'removal' = state.seenMain ? 'removal' : 'install'
  const profile = deps.profile ?? resolveProfile()
  return {
    mainPresent,
    pending,
    kind,
    prompted: kind === 'install' ? Boolean(state.installPrompted) : Boolean(state.removalPrompted),
    marketInstalled: profile ? marketInstalled(profile.dir) : false,
    profile: profile?.name ?? 'desktop',
    pkg: DEP_PKG,
    selfPkg: DEP_SELF,
    github: DEP_GITHUB,
    uninstallUrl: DEP_UNINSTALL_URL,
    installCmd: `dsh plugin --profile ${profile?.name ?? 'desktop'} add ${DEP_PKG}`,
    removeCmd: `dsh plugin --profile ${profile?.name ?? 'desktop'} remove ${DEP_SELF}`,
  }
}

/**
 * 挂依赖提示路由（apply 阶段即挂，不依赖 rndSources）：
 *  GET  /dep          → 状态 JSON（跨源页面可读但 JS 拿不到——无 CORS 头）
 *  POST /dep/dismiss  → 写 flag；要求 JSON content-type（非简单请求，
 *                       跨站页面过不了 preflight——天然 CSRF 防护）
 */
/** compose 宽限：主插件可能还没轮到注册，这段时间缺席报 pending 不报 missing */
export const DEP_GRACE_MS = 15_000

export function mountDepRoutes(ws: WebServerLike, ctx: unknown, log: Log, dataDir: string): () => void {
  const mountedAt = Date.now()
  const status = () => depStatus({
    dataDir,
    mainPresent: () => hasService(ctx, 'rndSources'),
    pending: Date.now() - mountedAt < DEP_GRACE_MS,
  })
  const offGet = ws.register({
    kind: 'exact',
    path: `${DEP_BASE}/api/dep`,
    handler: (_q, r) => { try { json(r, 200, status()) } catch (e) { json(r, 500, { error: String(e) }) } },
  })
  const offPost = ws.register({
    kind: 'exact',
    path: `${DEP_BASE}/api/dep/dismiss`,
    handler: async (q, r) => {
      if (q.method !== 'POST') { r.writeHead(405); r.end(); return }
      const ct = String(q.headers?.['content-type'] || '')
      if (!ct.includes('application/json')) { json(r, 403, { error: 'json content-type required' }); return }
      let kind = ''
      try { kind = String(JSON.parse(await readBody(q))?.kind ?? '') } catch { /* 忽略坏 body */ }
      const s = status()
      writeDepState(dataDir, kind === 'removal' || (kind === '' && s.kind === 'removal')
        ? { removalPrompted: true }
        : { installPrompted: true })
      json(r, 200, { ok: true })
    },
  })
  log.info(`dep-prompt routes mounted: GET ${DEP_BASE}/api/dep`)
  return () => { offGet(); offPost() }
}
