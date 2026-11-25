/**
 * Standalone style playground for the built-in browser tab body.
 *
 * Mounts the REAL `BrowserTab` component outside the dsh runtime so its styles
 * and interactions can be tweaked quickly. The component expects the right
 * Sidebar's framework props, so this harness supplies a minimal stand-in for
 * them:
 *
 *  - `useTabInfo()` returns a fake tab record (content id, visible, no
 *    navigation) — enough for the body's own state machine;
 *  - `sessionId` is a placeholder, and `openAnotherTab` just bumps a counter;
 *  - `t()` reads the real `zh` dictionary from src/client/locales.ts;
 *  - the page surface is faked: no Chromium webview exists here, so the ⌖
 *    button drives the REAL pick flow (src/client/pick-flow.ts) with an
 *    `executeJavaScript` that evals on this page. Hover styles to tweak live
 *    in vendor/selector/editor.css (`.ai-editor-hover-box`); saving triggers a
 *    rebuild + reload. While picking, the editor swallows page clicks — Escape
 *    is the way out.
 *
 * The surrounding sidebar chrome (tab chips, guide, dock) belongs to
 * ui-sidebar-right and is deliberately NOT reproduced: only the body's own
 * toolbar, notices, and surface are this package's to style.
 *
 * Served by ./dev.mjs with watch-rebuild + auto-reload. Not shipped: this
 * directory is dev tooling only.
 *
 * @module playground/main
 */

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserTab } from '../src/client/BrowserTab.js'
import type { BrowserTabProps } from '../src/client/BrowserTab.js'
import { setupPickFlow, stopPicking, togglePicking } from '../src/client/pick-flow.js'
import { claimBrowser, createBrowserStore, type BrowserStore } from '../src/client/store.js'
import { buildInjectionCode } from '../src/client/picker-script.js'
import { LOCALES } from '../src/client/locales.js'

// ---------------------------------------------------------------------------
// Real pick flow, fake guest: every surface gets an `executeJavaScript` that
// evals on this page instead, so the Selector editor annotates the playground
// itself.
// ---------------------------------------------------------------------------

type FakeSurface = HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }

/** A detached element standing in for a guest page (and its executeJavaScript). */
function fakeSurface(): FakeSurface {
  const el = document.createElement('div') as FakeSurface
  el.executeJavaScript = async (code: string) => (0, eval)(code)
  return el
}

const surface = fakeSurface()

function showPicked(text: string): void {
  const box = document.getElementById('picked-result')
  if (box !== null) {
    box.textContent = text
    box.style.display = 'block'
  }
}

// The pick flow sends to the tab's Session in production; here the "session" is
// the picked-result box in the sidebar.
setupPickFlow({
  sendPrompt: async (_sessionId, text) => {
    showPicked(text)
  },
})

// While picking, the editor swallows page clicks, so the ⌖ button is
// unreachable — Escape is the reliable way out.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void stopPicking()
})

// ---------------------------------------------------------------------------
// A minimal stand-in for the right Sidebar's framework props.
// ---------------------------------------------------------------------------

/** The zh dictionary as the context-bound translate seat. */
function translate(key: keyof (typeof LOCALES)['zh']): string {
  return LOCALES.zh[key]
}

/**
 * Mount one browser tab body.
 * @param props - the fake tab information and the region to draw in.
 */
function TabHarness(props: { visible: boolean; onNewTab: () => void }): ReactNode {
  const { visible, onNewTab } = props
  // Stable per mount, so a "remount" button creates a genuinely fresh body.
  const storeRef = useRef<BrowserStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createBrowserStore({
      // The playground has no real Session; the store only keys its checkpoint.
      sessionId: 'playground' as unknown as Parameters<typeof createBrowserStore>[0]['sessionId'],
      checkpointKey: null,
      inShell: true,
    })
  }
  const store = storeRef.current

  // Give every tab a live surface: the body's own <webview>/<iframe> never
  // mounts in this harness, so bind the fake one to each tab and let the pick
  // flow use the active tab's.
  useEffect(() => {
    const tabId = store.getSnapshot().activeTabId
    store.setSurface(tabId, surface)
  }, [store])

  useEffect(() => {
    if (visible) claimBrowser(store)
  }, [store, visible])

  // Sync the picking state into the harness so Escape can restore it.
  useEffect(() => store.subscribe(() => {
    sessionStorage.setItem('pg-picking', store.getSnapshot().picking ? '1' : '')
  }), [store])

  const tabProps = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane', isFloating: false },
      tab: {
        id: 'tab',
        kind: 'builtin-browser',
        contentId: 'pg',
        title: translate('type.label'),
        visible,
        signal: new AbortController().signal,
        navigation: { address: '', params: undefined, revision: 0 },
      },
    }),
    sessionId: 'playground',
    t: translate,
    openAnotherTab: onNewTab,
  } as unknown as BrowserTabProps

  return createElement(BrowserTab, tabProps)
}

// ---------------------------------------------------------------------------
// Playground shell.
// ---------------------------------------------------------------------------

/** Inline SVG placeholder image (data URI — no network needed). */
function svgImg(label: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="160" rx="10" fill="url(#g)"/><text x="160" y="88" font-size="20" fill="#ffffff" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function Shell(): ReactNode {
  const [tabKey, setTabKey] = useState(0)
  const [visible, setVisible] = useState(true)
  const [newTabs, setNewTabs] = useState(0)
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #333' }}>
        <strong>样式 Playground</strong>
        <button onClick={() => togglePicking()}>启动/停止拾取</button>
        <button onClick={() => setVisible((v) => !v)}>切换可见(visible: {String(visible)})</button>
        <button onClick={() => setTabKey((k) => k + 1)}>重挂载标签页</button>
        <span style={{ opacity: 0.5, fontSize: 12 }}>新建标签按钮点了 {newTabs} 次 · 改样式保存后自动重建并刷新</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
          <h1>演示内容</h1>
          <p>点浏览器工具栏的拾取按钮(⌖),编辑器注入在本页面上工作。Esc 退出拾取。</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 16 }}>
            {['深潜蓝', '柠檬黄', '安全橙'].map((name, i) => (
              <div key={name} className="demo-card" style={{ border: '1px solid #444', borderRadius: 12, padding: 16 }}>
                <div style={{ width: '100%', height: 72, borderRadius: 8, background: ['#4D6BFE', '#F5D90A', '#FF6B35'][i] }} />
                <h3>{name}</h3>
                <p style={{ fontSize: 13, opacity: 0.7 }}>一张演示卡片,包含标题、色块和描述文字,供拾取器选择。</p>
                <button>卡片按钮</button>
              </div>
            ))}
          </div>
          <section style={{ marginTop: 32 }}>
            <h2>标注测试区</h2>
            <p style={{ fontSize: 13, opacity: 0.7 }}>
              专门用来调拾取 hover 动效的测试块(vendor/selector/editor.css 的 .ai-editor-hover-box)。
            </p>
            <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
              <div
                className="annot-test-plain"
                style={{
                  width: 220, height: 120, border: '1px dashed #666', borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                }}
              >
                测试块 A(纯块)
              </div>
              <div
                className="annot-test-nested"
                style={{
                  width: 260, border: '1px solid #555', borderRadius: 10, padding: 14, fontSize: 13,
                }}
              >
                测试块 B(嵌套)
                <div style={{ marginTop: 10, padding: '10px 12px', background: '#4D6BFE22', borderRadius: 8 }}>
                  内层元素
                  <span style={{ marginLeft: 8, padding: '2px 8px', background: '#4D6BFE', borderRadius: 6, color: '#fff' }}>
                    徽章
                  </span>
                </div>
              </div>
            </div>
          </section>
          <section style={{ marginTop: 32 }}>
            <h2>内容测试区</h2>
            <div style={{ display: 'flex', gap: 16, marginTop: 12, alignItems: 'flex-start' }}>
              <figure style={{ margin: 0, width: 320, border: '1px solid #444', borderRadius: 12, overflow: 'hidden' }}>
                <img src={svgImg('示意图', '#4D6BFE', '#9b5cff')} alt="示意图" style={{ display: 'block', width: '100%' }} />
                <figcaption style={{ padding: '10px 14px', fontSize: 13 }}>
                  <strong>图片卡片</strong>
                  <span style={{ opacity: 0.7 }}> — 图 + 图注,hover 可以分别选中 img 和 figcaption。</span>
                </figcaption>
              </figure>
            </div>
          </section>
        </main>
        {/* The right Sidebar pane: only the body's own chrome is ours to style. */}
        <aside style={{ width: 420, borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '6px 10px', fontSize: 12, opacity: 0.5, borderBottom: '1px solid #2a2a2a' }}>
            右侧栏 Browser 标签页(外壳属于 ui-sidebar-right)
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <TabHarness key={tabKey} visible={visible} onNewTab={() => setNewTabs((n) => n + 1)} />
          </div>
          <pre id="picked-result" style={{ display: 'none', whiteSpace: 'pre-wrap', fontSize: 11, background: '#1c1c1e', padding: 8, maxHeight: 200, overflow: 'auto', margin: 0 }} />
        </aside>
      </div>
    </>
  )
}

document.body.style.margin = '0'
document.body.style.background = '#141415'
document.body.style.color = '#e8e8e8'
document.body.style.fontFamily = '-apple-system, "PingFang SC", sans-serif'
const app = document.getElementById('root')!
app.style.display = 'flex'
app.style.flexDirection = 'column'
app.style.height = '100vh'

createRoot(app).render(createElement(Shell))

// Debug handle for poking things from the page console (playground only).
;(window as unknown as { __pg: unknown }).__pg = { buildInjectionCode, stopPicking }
