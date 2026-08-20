/**
 * Standalone style playground for the built-in browser UI.
 *
 * Mounts the real plugin components outside the dsh runtime so styles can be
 * tweaked quickly:
 *
 *  - `BrowserToggle` (sidebar.footer.action) in a fake sidebar strip, wide
 *    and narrow variants;
 *  - `BrowserPanel` (shell.overlay) — the combined toolbar/tab row — forced
 *    open on load; close it with its ✕ to see the rest of the playground;
 *  - the vendored Selector editor (标注组件), driven by the REAL pick flow
 *    (src/client/pick-flow.ts): the panel's ⌖ button works here because the
 *    playground patches each panel surface with an `executeJavaScript` that
 *    evals on this page. Hover styles to tweak live in
 *    vendor/selector/editor.css (`.ai-editor-hover-box`); saving triggers a
 *    rebuild + reload of this page. While picking, the editor swallows page
 *    clicks — Escape is the way out.
 *
 * Served by ./dev.mjs with watch-rebuild + auto-reload. Not shipped: this
 * directory is dev tooling only.
 *
 * @module playground/main
 */

import { createElement, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPanel, type BrowserPanelProps } from '../src/client/BrowserPanel.js'
import { BrowserToggle, type BrowserToggleProps } from '../src/client/BrowserToggle.js'
import { browserStore } from '../src/client/store.js'
import { setupPickFlow, stopPicking, togglePicking } from '../src/client/pick-flow.js'
import { buildInjectionCode } from '../src/client/picker-script.js'

// ---------------------------------------------------------------------------
// Real pick flow, fake guest: no Chromium webview here, so every panel
// surface gets an `executeJavaScript` that evals on this page instead. The
// Selector editor then annotates the playground page itself.
// ---------------------------------------------------------------------------

/**
 * A never-mounted element standing in for the guest page while the panel is
 * closed (its real surfaces unmount with the panel, and pick-flow needs a
 * surface to inject into). Its executeJavaScript evals on this page.
 */
const fakeSurface = document.createElement('div') as HTMLElement & {
  executeJavaScript: (code: string) => Promise<unknown>
}
fakeSurface.executeJavaScript = async (code: string) => (0, eval)(code)

function patchSurfaces(): void {
  // Mounted panel surfaces (webview in shell mode, iframe otherwise) get a
  // page-level eval too, so ⌖ with the panel open injects the editor here.
  for (const el of document.querySelectorAll('webview, iframe')) {
    const fake = el as HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> }
    if (!fake.executeJavaScript) {
      fake.executeJavaScript = async (code: string) => (0, eval)(code)
    }
  }
  // Panel closed → no mounted surface → register the fake one so the real
  // pick flow still runs (this is how you hover the test blocks below).
  if (!browserStore.getSurface()) {
    browserStore.setSurface(browserStore.get().activeTabId, fakeSurface)
  }
}
setInterval(patchSurfaces, 300)

function showPicked(text: string): void {
  const box = document.getElementById('picked-result')
  if (box) {
    box.textContent = text
    box.style.display = 'block'
  }
}

// The pick flow sends to the current session in production; here the
// "session" is the picked-result box in the sidebar. Note mountPickFlow is
// intentionally NOT wired: it stops picking whenever the panel closes, but
// in the playground you close the panel FIRST and then pick page elements.
setupPickFlow({
  sendPrompt: async (text) => {
    showPicked(text)
  },
})

// While picking, the editor swallows page clicks (it is picking elements),
// so the ⌖ button is unreachable — Escape is the reliable way out.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && browserStore.get().picking) void stopPicking()
})

// Style-tweaking loop helper: the dev server reloads this page after every
// rebuild, which would kill the editor mid-tweak. Remember the picking state
// and resume it after the reload, so hover-style edits feel live.
const PICK_FLAG = 'pg-picking'
browserStore.subscribe(() => {
  sessionStorage.setItem(PICK_FLAG, browserStore.get().picking ? '1' : '')
})
if (sessionStorage.getItem(PICK_FLAG) === '1') {
  // Wait one patch-interval so a surface (fake or real) is registered first.
  setTimeout(() => {
    if (!browserStore.get().picking) togglePicking()
  }, 500)
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
  const [panelKey, setPanelKey] = useState(0)
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #333' }}>
        <strong>样式 Playground</strong>
        <button onClick={() => togglePicking()}>启动/停止拾取</button>
        <button onClick={() => browserStore.toggle()}>开/关浏览器面板</button>
        <button onClick={() => setPanelKey((k) => k + 1)}>重挂载面板</button>
        <span style={{ opacity: 0.5, fontSize: 12 }}>改样式保存后自动重建并刷新</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside style={{ width: 220, padding: 12, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.5 }}>侧边栏按钮(宽)</div>
          <BrowserToggle {...({ wide: true } as unknown as BrowserToggleProps)} />
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>侧边栏按钮(窄)</div>
          <div style={{ width: 40 }}>
            <BrowserToggle {...({ wide: false } as unknown as BrowserToggleProps)} />
          </div>
          <pre id="picked-result" style={{ display: 'none', whiteSpace: 'pre-wrap', fontSize: 11, background: '#1c1c1e', padding: 8, borderRadius: 8, maxHeight: 240, overflow: 'auto' }} />
        </aside>
        <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
          <h1>演示内容</h1>
          <p>点头部或面板工具栏的拾取按钮(⌖),编辑器注入在本页面上工作。Esc 退出拾取。</p>
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
          <ul style={{ marginTop: 24, lineHeight: 2 }}>
            <li>列表项一:https://example.com/a</li>
            <li>列表项二:包含 <code>行内代码</code> 和 <a href="#x">链接</a></li>
            <li>列表项三:<strong>加粗</strong>、<em>斜体</em>混合文本</li>
          </ul>
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
              <article style={{ width: 340, border: '1px solid #444', borderRadius: 12, padding: '4px 16px 14px', fontSize: 13, lineHeight: 1.8 }}>
                <h3>文字块</h3>
                <p style={{ margin: '6px 0' }}>
                  一段普通正文,里面夹着 <a href="#y">一个链接</a>、<code>inline code</code> 和
                  <mark style={{ background: '#F5D90A55', borderRadius: 3 }}>高亮文本</mark>,方便测试各种行内元素的 hover。
                </p>
                <p style={{ margin: '6px 0', opacity: 0.7 }}>第二段,字号相同、透明度低一点,用来对比 hover 框在弱对比文字上的表现。</p>
              </article>
            </div>
          </section>
        </main>
      </div>
      {/* key 让「重挂载面板」强制全新挂载,模拟面板首次打开。 */}
      <BrowserPanel key={panelKey} {...({} as unknown as BrowserPanelProps)} />
    </>
  )
}

// Open the panel on load so its styles are immediately visible, and claim
// shell mode so the panel's ⌖ pick button renders (its surface is faked
// above — no real webview guest exists here).
browserStore.setOpen(true)
browserStore.setInShell(true)

document.body.style.margin = '0'
document.body.style.background = '#141415'
document.body.style.color = '#e8e8e8'
document.body.style.fontFamily = '-apple-system, "PingFang SC", sans-serif'
const app = document.getElementById('root')!
app.style.display = 'flex'
app.style.flexDirection = 'column'
app.style.height = '100vh'

createRoot(app).render(createElement(Shell))

// Debug handle for poking the store from the page console (playground only).
;(window as unknown as { __pg: unknown }).__pg = { browserStore, buildInjectionCode }
