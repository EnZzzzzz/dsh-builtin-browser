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
 *  - the vendored Selector editor (标注组件): the "启动拾取" button runs the
 *    exact injection payload the webview would run, right on this page, over
 *    the demo content below.
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
import { buildInjectionCode, buildPollExpression, DESTROY_EXPRESSION } from '../src/client/picker-script.js'

// ---------------------------------------------------------------------------
// Picker controls (eval the real injection payload on this page).
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null

function showPicked(text: string): void {
  const box = document.getElementById('picked-result')
  if (box) {
    box.textContent = text
    box.style.display = 'block'
  }
}

function stopPicking(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  ;(0, eval)(DESTROY_EXPRESSION)
  const btn = document.getElementById('pick-btn')
  if (btn) btn.textContent = '启动拾取'
}

function startPicking(): void {
  ;(0, eval)(buildInjectionCode())
  const btn = document.getElementById('pick-btn')
  if (btn) btn.textContent = '停止拾取'
  pollTimer = setInterval(() => {
    const r = (0, eval)(buildPollExpression()) as { text?: string | null; present?: boolean } | null
    if (r?.text) {
      stopPicking()
      showPicked(r.text)
    } else if (r && r.present === false) {
      stopPicking()
    }
  }, 500)
}

function togglePicking(): void {
  if (pollTimer) stopPicking()
  else startPicking()
}

// While picking, the editor swallows page clicks (it is picking elements), so
// the 停止拾取 button is unreachable — Escape is the reliable way out.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pollTimer) stopPicking()
})

// ---------------------------------------------------------------------------
// Playground shell.
// ---------------------------------------------------------------------------

function Shell(): ReactNode {
  const [panelKey, setPanelKey] = useState(0)
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #333' }}>
        <strong>样式 Playground</strong>
        <button id="pick-btn" onClick={togglePicking}>启动拾取</button>
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
          <p>拾取器注入在这个页面上工作。点上面的「启动拾取」,然后点击下面任意元素。</p>
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
          <ul style={{ marginTop: 24, lineHeight: 2 }}>
            <li>列表项一:https://example.com/a</li>
            <li>列表项二:包含 <code>行内代码</code> 和 <a href="#x">链接</a></li>
            <li>列表项三:<strong>加粗</strong>、<em>斜体</em>混合文本</li>
          </ul>
        </main>
      </div>
      {/* key 让「重挂载面板」强制全新挂载,模拟面板首次打开。 */}
      <BrowserPanel key={panelKey} {...({} as unknown as BrowserPanelProps)} />
    </>
  )
}

// Open the panel on load so its styles are immediately visible.
browserStore.setOpen(true)

document.body.style.margin = '0'
document.body.style.background = '#141415'
document.body.style.color = '#e8e8e8'
document.body.style.fontFamily = '-apple-system, "PingFang SC", sans-serif'
const app = document.getElementById('root')!
app.style.display = 'flex'
app.style.flexDirection = 'column'
app.style.height = '100vh'

createRoot(app).render(createElement(Shell))
