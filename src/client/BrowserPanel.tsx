/**
 * The browser panel itself, rendered into the `shell.overlay` slot: a floating
 * frame-wide surface with an address bar, navigation buttons, and the actual
 * page surface.
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
 * The host half reaches this same webview through the Desktop shell's HTTP
 * control endpoint (desktop/main.js) + `executeJavaScript` into this page,
 * so the agent's `browser_*` tools and the manual toolbar stay in sync.
 *
 * @module dsh-builtin-browser/client/BrowserPanel
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { stopPicking, togglePicking } from './pick-flow.js'
import { browserStore } from './store.js'

/**
 * Runtime props of the shell.overlay entry: the global standard seat only
 * (root scope, no owner share). The panel is frame-global, so it reads nothing
 * from these props.
 */
export type BrowserPanelProps = PropsRuntime<'shell.overlay'>

/** Normalize whatever the user typed into the address bar into an absolute URL. */
function toUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'https://example.com'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
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
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>
  getWebContentsId?(): number
}

/**
 * The toolbar + page surface of the built-in browser.
 * @param _props - slot owner props (unused; the panel is frame-global).
 */
export function BrowserPanel(_props: BrowserPanelProps): ReactNode {
  const [state, setState] = useState(browserStore.get())
  const [addressInput, setAddressInput] = useState(state.address)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const inShell = Boolean(
    typeof window !== 'undefined' && (window as { desktopBridge?: unknown }).desktopBridge,
  )

  useEffect(() => browserStore.subscribe(() => {
    const next = browserStore.get()
    setState(next)
    setAddressInput(next.address)
  }), [])

  // Bind the page-surface element into the store so the shell's
  // executeJavaScript controller can drive it too. Unbind on unmount.
  const bindSurface = useCallback((el: HTMLElement | null): void => {
    browserStore.setSurface(el as WebviewElement | null)
  }, [])

  // Refresh nav state from the webview after any navigation event.
  const refreshNavState = useCallback((): void => {
    const wv = browserStore.getSurface()
    if (!wv) return
    try {
      setCanGoBack(wv.canGoBack?.() ?? false)
      setCanGoForward(wv.canGoForward?.() ?? false)
      const url = wv.getURL?.() ?? ''
      if (url) browserStore.setCurrent(url)
    } catch {
      // webview not attached yet; ignore.
    }
  }, [])

  const navigate = useCallback((input: string): void => {
    const url = toUrl(input)
    setAddressInput(url)
    browserStore.setAddress(url)
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

  // Attach webview event listeners once the element exists.
  useEffect(() => {
    const wv = browserStore.getSurface()
    if (!wv || !inShell) return
    const onDidNavigate = (): void => {
      refreshNavState()
      // A real navigation replaced the guest document, so the injected editor is
      // gone. Exit picking silently (matches §4.4: address-bar nav while picking).
      void stopPicking()
    }
    const onDidNavigateInPage = (): void => refreshNavState()
    const onDidFinishLoad = (): void => {
      setLoading(false)
      refreshNavState()
    }
    const onDidStartLoading = (): void => setLoading(true)
    const onDidStopLoading = (): void => setLoading(false)
    wv.addEventListener('did-navigate', onDidNavigate)
    wv.addEventListener('did-navigate-in-page', onDidNavigateInPage)
    wv.addEventListener('did-finish-load', onDidFinishLoad)
    wv.addEventListener('did-start-loading', onDidStartLoading)
    wv.addEventListener('did-stop-loading', onDidStopLoading)
    return () => {
      wv.removeEventListener('did-navigate', onDidNavigate)
      wv.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
      wv.removeEventListener('did-finish-load', onDidFinishLoad)
      wv.removeEventListener('did-start-loading', onDidStartLoading)
      wv.removeEventListener('did-stop-loading', onDidStopLoading)
    }
  }, [inShell, refreshNavState])

  // Open the panel's first page if the agent navigated before the panel opened.
  useEffect(() => {
    if (state.open && state.current && state.address !== state.current) {
      // The store's address is authoritative for the address bar; the webview
      // follows it only when the user/agent actually navigates.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open])

  if (!state.open) return null

  const toolbarStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    borderBottom: '1px solid rgba(127,127,127,0.25)',
    background: 'var(--bg, #ffffff)',
  }
  const buttonStyle: CSSProperties = {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 14,
    padding: '4px 8px',
    borderRadius: 6,
    color: 'inherit',
    opacity: 0.85,
  }
  const inputStyle: CSSProperties = {
    flex: 1,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
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
      <div style={toolbarStyle}>
        <button
          type="button"
          style={buttonStyle}
          onClick={goBack}
          disabled={!canGoBack}
          title="后退"
          aria-label="后退"
        >
          ←
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={goForward}
          disabled={!canGoForward}
          title="前进"
          aria-label="前进"
        >
          →
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={reload}
          title="刷新"
          aria-label="刷新"
        >
          ⟳
        </button>
        {state.inShell && (
          <button
            type="button"
            style={{
              ...buttonStyle,
              background: state.picking ? 'rgba(59, 130, 246, 0.28)' : undefined,
              opacity: 1,
            }}
            onClick={() => togglePicking()}
            title="拾取元素发给助手"
            aria-label="拾取元素发给助手"
            aria-pressed={state.picking}
          >
            ⌖
          </button>
        )}
        {loading && (
          <button
            type="button"
            style={buttonStyle}
            onClick={stop}
            title="停止"
            aria-label="停止"
          >
            ✕
          </button>
        )}
        <input
          style={inputStyle}
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(addressInput)
          }}
          placeholder="输入网址后回车"
          aria-label="地址栏"
          spellCheck={false}
        />
        <button
          type="button"
          style={buttonStyle}
          onClick={() => navigate(addressInput)}
          title="前往"
        >
          前往
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => browserStore.setOpen(false)}
          title="关闭"
          aria-label="关闭浏览器"
        >
          ✕
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
      {inShell ? (
        // Real Chromium guest inside the Desktop shell.
        <webview
          ref={bindSurface}
          src={state.address}
          style={surfaceStyle}
          allowpopups
        />
      ) : (
        // Degraded frame in a plain browser tab.
        <iframe
          ref={bindSurface}
          src={state.address}
          style={surfaceStyle}
          onLoad={() => {
            setLoading(false)
            browserStore.setCurrent(state.address)
          }}
          title="内置浏览器"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      )}
    </div>
  )
}
