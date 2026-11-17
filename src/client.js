/**
 * 客户端半体（classic script！宿主经 window.__ModuleLoader__.load 加载，
 * 禁止 ESM export）。唯一职责：主插件缺席时在应用内弹一次指路 modal。
 *
 * 数据来源：GET /dsh-rss-news-zhuikan/api/dep（相对路径——与市场 client 同款，
 * shell 页面 origin 下相对 fetch 由宿主路由到 webServer）。
 * mainPresent=false 且该 kind 未 dismiss 过 → 弹层；用户任一按钮交互
 * （含「稍后」）→ POST dismiss 写 flag，各一生一次。
 * 复制走 navigator.clipboard（用户手势）；失败静默，绝不拖垮 dsh 启动。
 */
;(() => {
  'use strict'

  const API = '/dsh-rss-news-zhuikan/api/dep'

  window.__ModuleLoader__.load({
    id: 'dsh-rss-news-zhuikan',
    factory: () => {
      const inject = []

      let shown = false
      function apply(ctx) {
        const log = (ctx && ctx.logger ? ctx.logger('kuaixun-client') : console)
        const run = () => check(log).catch(() => { /* 后端未就绪/路由未挂 → 放弃 */ })
        // 客户端 apply 可能早于后端挂路由 + 主插件 compose 宽限内——多次重查
        setTimeout(run, 1500)
        setTimeout(run, 6000)
        setTimeout(run, 12000)
        setTimeout(run, 20000)
      }

      async function check(log) {
        if (shown) return
        const res = await fetch(API, { cache: 'no-store' })
        if (!res.ok) return
        const st = await res.json()
        if (!st || st.mainPresent || st.pending || st.prompted) return
        shown = true
        showModal(st, log)
      }

      async function dismiss(kind) {
        try {
          await fetch(API + '/dismiss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind }),
          })
        } catch { /* flag 写不上下次再来 */ }
      }

      function el(tag, attrs, children) {
        const n = document.createElement(tag)
        for (const [k, v] of Object.entries(attrs || {})) {
          if (k === 'style') Object.assign(n.style, v)
          else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
          else n.setAttribute(k, v)
        }
        for (const c of children || []) n.append(c)
        return n
      }

      function copyBtn(text, log) {
        const b = el('button', { style: btnStyle(false) }, ['复制'])
        b.addEventListener('click', () => {
          const done = () => { b.textContent = '已复制' }
          try {
            navigator.clipboard.writeText(text).then(done, () => { b.textContent = text })
          } catch {
            b.textContent = text // 剪贴板不可用时直接露出文本，手动抄
          }
        })
        return b
      }

      const btnStyle = (primary) => ({
        padding: '6px 14px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
        border: primary ? 'none' : '1px solid var(--dsw-alias-border-l3, #d9dde3)',
        background: primary ? 'var(--dsw-alias-brand-primary, #4f6ef7)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-primary, #1f2328)',
      })
      const codeStyle = {
        fontFamily: 'ui-monospace, monospace', fontSize: '12px', padding: '6px 8px',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: '6px',
        userSelect: 'all', wordBreak: 'break-all', flex: '1',
      }

      function showModal(st, log) {
        const isRemoval = st.kind === 'removal'
        const title = isRemoval ? '主插件已被移除或禁用' : '欢迎使用追看插件'
        const desc = isRemoval
          ? `检测到主插件 ${st.pkg} 已被移除或禁用，追看插件当前无法工作。重新安装或启用即可恢复。`
          : `追看插件是新闻精选插件的伴随插件，需要安装主插件 ${st.pkg} 才能工作，安装后本插件自动激活运行。`

        const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [])
        const section = (lines) => el('div', {
          style: { fontSize: '12.5px', lineHeight: '1.7', color: 'var(--dsw-alias-label-secondary, #5c6570)', padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: '8px' },
        }, lines.map((l) => typeof l === 'string' ? el('div', {}, [l]) : l))
        const cmdRow = (cmd) => el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [el('code', { style: codeStyle }, [cmd]), copyBtn(cmd)])
        const kwRow = (kw) => el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [el('code', { style: codeStyle }, [kw]), copyBtn(kw)])

        const overlay = el('div', {
          style: {
            position: 'fixed', inset: '0', zIndex: '99999', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,.35)',
          },
        }, [])
        const card = el('div', {
          style: {
            width: '420px', maxWidth: '90vw', padding: '18px 20px', borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #1f2328)',
            boxShadow: '0 8px 30px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', gap: '12px',
          },
        }, [])
        overlay.append(card)

        const close = () => {
          void dismiss(st.kind) // 只有显式点「知道了」/动作按钮才算已交互
          overlay.remove()
        }
        // 点遮罩只隐藏不 dismiss——误触不烧掉一生一次的额度，下次加载再弹
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

        card.append(el('div', { style: { fontSize: '15px', fontWeight: '600' } }, [title]))
        card.append(el('div', {
          style: { fontSize: '12.5px', lineHeight: '1.7', color: 'var(--dsw-alias-label-secondary, #5c6570)', padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: '8px' },
        }, [
          el('div', { style: { fontWeight: '600', color: 'var(--dsw-alias-label-primary, #1f2328)', marginBottom: '2px' } }, ['「追看」——六大一手追看源的实时聚合']),
          el('div', {}, ['· 财联社电报 / 金十 / 华尔街见闻 / 东方财富 / 同花顺 / 新浪，60 秒轮询']),
          el('div', {}, ['· 多源互证标记 + 关键词/重要性提醒 + 桌面通知']),
          el('div', {}, ['· 专属「追看」阅读器 tab 实时电报流']),
          el('div', {}, ['· 「追看快报」每小时 AI 摘要，并入主插件快报视图']),
        ]))
        card.append(el('div', { style: { fontSize: '13px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #5c6570)' } }, [desc]))

        const detail = el('div', {}, [])
        card.append(detail)
        let acted = false
        const act = (node) => {
          detail.replaceChildren(node)
          if (!acted) { acted = true; void dismiss(st.kind) } // 任一交互即视为已提示
        }

        const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [])
        if (st.marketInstalled) {
          row.append(el('button', {
            style: btnStyle(true),
            onclick: () => act(section([
              '在「插件 → 插件市场」的搜索框粘贴关键词：',
              kwRow(st.pkg),
              '装好后本插件自动激活。',
            ])),
          }, ['去插件市场安装']))
        }
        row.append(el('button', {
          style: btnStyle(!st.marketInstalled),
          onclick: () => {
            try { window.open(st.github, '_blank') } catch { /* 无浏览器环境 */ }
            act(section([
              '已打开 GitHub 发布页。下载后在插件市场里用「链接安装」，或复制命令在终端执行：',
              cmdRow(st.installCmd),
            ]))
          },
        }, ['去 GitHub 下载安装']))
        row.append(el('button', {
          style: btnStyle(false),
          onclick: () => {
            try { window.open(st.uninstallUrl, '_blank') } catch { /* 无浏览器环境 */ }
            act(section(['已在浏览器打开卸载指引页。按页面说明移除后，本插件不再提示。']))
          },
        }, ['移除追看']))
        card.append(row)

        card.append(el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [
          el('button', { style: { ...btnStyle(false), border: 'none', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' }, onclick: close }, ['知道了（不再提醒）']),
        ]))

        document.body.append(overlay)
      }

      return { inject, apply }
    },
  })
})()
