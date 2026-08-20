/**
 * The browser panel itself, rendered into the `shell.overlay` slot: a floating
 * frame-wide surface with one combined row — navigation buttons, the tab
 * pills, and panel actions — plus the actual page surfaces. There is no
 * standalone address bar: double-click a tab pill to edit its address inline.
 *
 * Multi-tab: every tab keeps its own page surface mounted (inactive ones are
 * display:none), so each tab preserves its session and history. The toolbar,
 * the shell's executeJavaScript controller, and the pick flow all operate on
 * the ACTIVE tab's surface (see browserStore.getSurface).
 *
 * Page surface selection:
 *  - Inside the Electron Desktop shell (`window.desktopBridge` present and the
 *    shell opted into `webviewTag`), a real `<webview>` element is rendered —
 *    a full Chromium guest with its own session, history, and devtools. All
 *    navigation is driven by the `WebviewControl` helper below, which talks to
 *    the element's native API (`loadURL`, `goBack`, ...).
 *  - Otherwise (plain browser tab, e.g. `dsh web`), it degrades to an
 *    `<iframe>` so the UI is still usable for sites that allow framing.
 *
 * The host half reaches the active tab's webview through the Desktop shell's
 * HTTP control endpoint (desktop/main.js) + `executeJavaScript` into this
 * page, so the agent's `browser_*` tools and the manual toolbar stay in sync.
 *
 * @module dsh-builtin-browser/client/BrowserPanel
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { stopPicking, togglePicking } from './pick-flow.js'
import { BLANK_PAGE, browserStore, type BrowserTab } from './store.js'
import { IconArrowLeft, IconArrowRight, IconCrosshair, IconPlus, IconRotateCw, IconSquare, IconX } from './icons.js'

/**
 * Runtime props of the shell.overlay entry: the global standard seat only
 * (root scope, no owner share). The panel is frame-global, so it reads nothing
 * from these props.
 */
export type BrowserPanelProps = PropsRuntime<'shell.overlay'>

/**
 * Toolbar and tab styles. Hover needs a `:hover` pseudo-class, which inline
 * styles cannot express, so these live in a real stylesheet rendered once
 * with the panel. The hover fill is the DeepSeek brand blue (#4D6BFE) at low
 * alpha: a circular badge behind toolbar icons, a soft wash on tab pills.
 */
const TOOLBAR_CSS = `
.dsh-browser-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px;
  border-radius: 50%;
  color: inherit;
  opacity: 0.85;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.dsh-browser-btn:hover:not(:disabled) {
  background: rgba(77, 107, 254, 0.06);
  opacity: 1;
}
.dsh-browser-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
/* New-tab entrance: the pill grows from zero width to its natural width
   (only the from-frame is keyed, so it lands on whatever the computed width
   is — 132px normally, 260px when it opens straight into editing). */
@keyframes dsh-browser-tab-in {
  from {
    min-width: 0;
    max-width: 0;
    padding-left: 0;
    padding-right: 0;
    opacity: 0;
  }
}
.dsh-browser-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  /* Adaptive width: grows to share spare space in the row (up to ~1.5x the
     compact pill width), shrinks back to content size when crowded. */
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 88px;
  max-width: 132px;
  overflow: hidden;
  animation: dsh-browser-tab-in 240ms ease-in-out;
  padding: 3px 6px 3px 10px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 9px;
  background: var(--bg, #ffffff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  cursor: pointer;
  color: inherit;
  font-size: 12.5px;
  transition: background-color 120ms ease, box-shadow 120ms ease, border-color 120ms ease,
    max-width 240ms ease-in-out;
  user-select: none;
}
.dsh-browser-tab:hover {
  background: rgba(77, 107, 254, 0.06);
}
.dsh-browser-tab.active {
  border-color: rgba(127, 127, 127, 0.45);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.09);
}
.dsh-browser-tab.editing {
  cursor: text;
  flex-basis: 220px;
  max-width: 260px;
}
.dsh-browser-tab .dsh-browser-tab-title {
  /* Take all spare width so the close button hugs the pill's right edge. */
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  /* Inactive tabs read softer; hover deepens the ink with a quick fade. */
  opacity: 0.55;
  transition: opacity 120ms ease;
}
.dsh-browser-tab:hover .dsh-browser-tab-title {
  opacity: 0.85;
}
.dsh-browser-tab.active .dsh-browser-tab-title,
.dsh-browser-tab.active:hover .dsh-browser-tab-title {
  opacity: 1;
}
.dsh-browser-tab .dsh-browser-tab-input {
  flex: 1;
  min-width: 60px;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0;
}
.dsh-browser-tab .dsh-browser-btn {
  padding: 2px;
}
/* Keep an inactive tab's close button quiet until the pill is hovered. */
.dsh-browser-tab:not(.active):not(:hover) .dsh-browser-btn {
  opacity: 0.5;
}
`

/** Normalize whatever the user typed into a tab's address editor into an absolute URL. */
function toUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return BLANK_PAGE
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/** Short label for a tab: page title, else the URL host, else "新标签页". */
function tabLabel(tab: BrowserTab): string {
  if (tab.title) return tab.title
  if (tab.current) {
    try {
      return new URL(tab.current).hostname
    } catch {
      return tab.current
    }
  }
  return '新标签页'
}

/**
 * Thin wrapper over the Electron `<webview>` element's native API. The element
 * methods are not typed by React, so this module declares the slice we use and
 * guards every call.
 */
interface WebviewElement extends HTMLElement {
  loadURL?(url: string): Promise<void>
  goBack?(): void
  goForward?(): void
  reload?(): void
  stop?(): void
  getURL?(): string
  getTitle?(): string
  canGoBack?(): boolean
  canGoForward?(): boolean
  isLoading?(): boolean
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>
  getWebContentsId?(): number
}

/** Marks a webview element whose listeners are already attached. */
const BOUND_FLAG = '__dshBrowserBound'

/**
 * The combined toolbar/tab row plus the page surfaces of the built-in browser.
 * @param _props - slot owner props (unused; the panel is frame-global).
 */
export function BrowserPanel(_props: BrowserPanelProps): ReactNode {
  const [state, setState] = useState(browserStore.get())
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0]
  // Inline address editing: which tab pill is being edited, and its draft.
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const inShell = Boolean(
    typeof window !== 'undefined' && (window as { desktopBridge?: unknown }).desktopBridge,
  )

  useEffect(() => browserStore.subscribe(() => {
    const next = browserStore.get()
    setState(next)
    // Drop the edit session if its tab went away; otherwise keep the draft.
    setEditing((cur) => (cur && !next.tabs.some((t) => t.id === cur.id) ? null : cur))
  }), [])

  // Refresh nav state from the active tab's webview after any navigation event.
  const refreshNavState = useCallback((): void => {
    const wv = browserStore.getSurface()
    if (!wv) {
      setCanGoBack(false)
      setCanGoForward(false)
      return
    }
    try {
      setCanGoBack(wv.canGoBack?.() ?? false)
      setCanGoForward(wv.canGoForward?.() ?? false)
      const url = wv.getURL?.() ?? ''
      // Keep the blank page out of the tab record (blank stays blank).
      if (url && url !== BLANK_PAGE) browserStore.setCurrent(browserStore.get().activeTabId, url)
    } catch {
      // webview not attached yet; ignore.
    }
  }, [])

  // Bind one tab's page-surface element into the store so the shell's
  // executeJavaScript controller can drive it too. Webview event listeners
  // are attached once per element (BOUND_FLAG); they only touch component
  // nav/loading state while their tab is the active one, but always keep
  // the tab's title up to date for the strip.
  const bindSurface = (tabId: number) => (el: HTMLElement | null): void => {
    const wv = el as (WebviewElement & { [BOUND_FLAG]?: boolean }) | null
    browserStore.setSurface(tabId, wv)
    if (!wv || !inShell || wv[BOUND_FLAG]) return
    wv[BOUND_FLAG] = true
    const isActive = (): boolean => browserStore.get().activeTabId === tabId
    wv.addEventListener('did-navigate', () => {
      if (!isActive()) return
      refreshNavState()
      // A real navigation replaced the guest document, so the injected editor
      // is gone. Exit picking silently (matches §4.4: manual nav while
      // picking).
      void stopPicking()
    })
    wv.addEventListener('did-navigate-in-page', () => {
      if (isActive()) refreshNavState()
    })
    wv.addEventListener('did-finish-load', () => {
      if (!isActive()) return
      setLoading(false)
      refreshNavState()
    })
    wv.addEventListener('did-start-loading', () => {
      if (isActive()) setLoading(true)
    })
    wv.addEventListener('did-stop-loading', () => {
      if (isActive()) setLoading(false)
    })
    wv.addEventListener('page-title-updated', (event) => {
      const title = (event as { title?: string }).title ?? wv.getTitle?.() ?? ''
      browserStore.setTitle(tabId, title)
    })
  }

  // Re-sync nav/loading indicators whenever the active tab changes.
  useEffect(() => {
    refreshNavState()
    try {
      setLoading(browserStore.getSurface()?.isLoading?.() ?? false)
    } catch {
      // A freshly mounted webview throws before dom-ready ("The WebView must
      // be attached to the DOM..."). Uncaught, this error unmounts the whole
      // panel tree for good — treat as "not loading"; did-start-loading will
      // flip the indicator once the guest is live.
      setLoading(false)
    }
  }, [state.activeTabId, refreshNavState])

  const navigate = useCallback((input: string): void => {
    const url = toUrl(input)
    // Blank stays blank: don't echo "about:blank" into the tab record.
    const shown = url === BLANK_PAGE ? '' : url
    browserStore.setAddress(shown)
    const wv = browserStore.getSurface()
    if (wv?.loadURL) {
      setLoading(true)
      wv.loadURL(url).catch(() => setLoading(false))
    } else if (wv) {
      // iframe fallback: swap the src attribute.
      wv.setAttribute('src', url)
      setLoading(true)
    }
  }, [])

  // Commit an inline tab-address edit: activate that tab, then navigate it.
  const commitEdit = useCallback((tabId: number, value: string): void => {
    setEditing(null)
    if (!value.trim()) return
    browserStore.activateTab(tabId)
    navigate(value)
  }, [navigate])

  const goBack = useCallback((): void => {
    browserStore.getSurface()?.goBack?.()
  }, [])
  const goForward = useCallback((): void => {
    browserStore.getSurface()?.goForward?.()
  }, [])
  const reload = useCallback((): void => {
    browserStore.getSurface()?.reload?.()
  }, [])
  const stop = useCallback((): void => {
    browserStore.getSurface()?.stop?.()
    setLoading(false)
  }, [])

  if (!state.open) return null

  const toolbarStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 10px',
    borderBottom: '1px solid rgba(127,127,127,0.25)',
    background: 'var(--bg, #ffffff)',
  }
  const tabsStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    minWidth: 0,
    overflowX: 'auto',
    padding: '1px 2px',
  }
  const surfaceStyle: CSSProperties = {
    flex: 1,
    width: '100%',
    border: 'none',
    background: '#fff',
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg, #fff)',
        color: 'var(--fg, #111)',
      }}
      role="dialog"
      aria-label="内置浏览器"
    >
      <style>{TOOLBAR_CSS}</style>
      <div style={toolbarStyle} role="toolbar" aria-label="浏览器工具栏">
        <button
          type="button"
          className="dsh-browser-btn"
          onClick={goBack}
          disabled={!canGoBack}
          title="后退"
          aria-label="后退"
        >
          <IconArrowLeft size={13.5} />
        </button>
        <button
          type="button"
          className="dsh-browser-btn"
          onClick={goForward}
          disabled={!canGoForward}
          title="前进"
          aria-label="前进"
        >
          <IconArrowRight size={13.5} />
        </button>
        <button
          type="button"
          className="dsh-browser-btn"
          onClick={reload}
          title="刷新"
          aria-label="刷新"
        >
          <IconRotateCw size={13.5} />
        </button>
        {loading && (
          <button
            type="button"
            className="dsh-browser-btn"
            onClick={stop}
            title="停止"
            aria-label="停止"
          >
            <IconSquare size={10} />
          </button>
        )}
        <div style={tabsStyle} role="tablist" aria-label="标签页">
          {state.tabs.map((tab) => {
            const isEditing = editing?.id === tab.id
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === active.id}
                tabIndex={0}
                className={`dsh-browser-tab${tab.id === active.id ? ' active' : ''}${isEditing ? ' editing' : ''}`}
                title={isEditing ? undefined : (tab.current || '新标签页，双击编辑地址')}
                onClick={() => browserStore.activateTab(tab.id)}
                onDoubleClick={() => {
                  browserStore.activateTab(tab.id)
                  setEditing({ id: tab.id, value: tab.address || tab.current || '' })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') browserStore.activateTab(tab.id)
                }}
              >
                {isEditing ? (
                  <input
                    className="dsh-browser-tab-input"
                    autoFocus
                    value={editing.value}
                    onChange={(e) => setEditing({ id: tab.id, value: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') commitEdit(tab.id, editing.value)
                      else if (e.key === 'Escape') setEditing(null)
                    }}
                    onBlur={() => commitEdit(tab.id, editing.value)}
                    placeholder="输入网址后回车"
                    aria-label={`编辑标签页地址 ${tabLabel(tab)}`}
                    spellCheck={false}
                  />
                ) : (
                  <span className="dsh-browser-tab-title">{tabLabel(tab)}</span>
                )}
                <button
                  type="button"
                  className="dsh-browser-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    browserStore.closeTab(tab.id)
                  }}
                  title="关闭标签页"
                  aria-label={`关闭标签页 ${tabLabel(tab)}`}
                >
                  <IconX size={10} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="dsh-browser-btn"
            onClick={() => {
              const id = browserStore.addTab()
              // A fresh tab has no address; open the inline editor right away.
              setEditing({ id, value: '' })
            }}
            title="新建标签页"
            aria-label="新建标签页"
          >
            <IconPlus size={13.5} />
          </button>
        </div>
        {state.inShell && (
          <button
            type="button"
            className="dsh-browser-btn"
            // While picking is armed the badge stays filled; hover styles are
            // suppressed by this inline background until picking ends.
            style={{
              background: state.picking ? 'rgba(77, 107, 254, 0.28)' : undefined,
              opacity: state.picking ? 1 : undefined,
            }}
            onClick={() => togglePicking()}
            title="拾取元素发给助手"
            aria-label="拾取元素发给助手"
            aria-pressed={state.picking}
          >
            <IconCrosshair size={13.5} />
          </button>
        )}
        <button
          type="button"
          className="dsh-browser-btn"
          onClick={() => browserStore.setOpen(false)}
          title="关闭"
          aria-label="关闭浏览器"
        >
          <IconX size={13.5} />
        </button>
      </div>
      {state.toast && (
        <div
          role="alert"
          style={{
            padding: '8px 12px',
            background: 'rgba(220, 38, 38, 0.14)',
            color: '#dc2626',
            borderBottom: '1px solid rgba(220, 38, 38, 0.3)',
            fontSize: 13,
          }}
        >
          {state.toast}
        </div>
      )}
      {state.tabs.map((tab) => {
        const hidden: CSSProperties = tab.id === active.id ? {} : { display: 'none' }
        return inShell ? (
          // Real Chromium guest inside the Desktop shell; stays mounted per
          // tab so the session and history survive tab switches.
          <webview
            key={tab.id}
            ref={bindSurface(tab.id)}
            src={tab.address || BLANK_PAGE}
            style={{ ...surfaceStyle, ...hidden }}
            allowpopups
          />
        ) : (
          // Degraded frame in a plain browser tab.
          <iframe
            key={tab.id}
            ref={bindSurface(tab.id)}
            src={tab.address || BLANK_PAGE}
            style={{ ...surfaceStyle, ...hidden }}
            onLoad={() => {
              if (browserStore.get().activeTabId !== tab.id) return
              setLoading(false)
              browserStore.setCurrent(tab.id, tab.address)
            }}
            title="内置浏览器"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          />
        )
      })}
    </div>
  )
}
