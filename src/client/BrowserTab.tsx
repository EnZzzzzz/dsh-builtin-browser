/**
 * The built-in browser tab body, registered into the right Sidebar's
 * `sidebar.right.pane.tab` seat under this package's implementation id.
 *
 * The Sidebar is the tab strip now: docking, splitting, floating, closing, and
 * the chips belong to ui-sidebar-right, so this component is one PAGE — a
 * navigation toolbar, a notice rail, and the page surface — and never draws a
 * tab list. Every open of the type is an independent instance
 * (`multiple: true`), so the component owns exactly one surface and one store.
 *
 * Page surface selection:
 *  - Inside the Desktop shell (`window.desktopBridge` with a browser port, and
 *    a shell that opted into `webviewTag`), a real `<webview>` element is
 *    rendered — a full Chromium guest with its own session and history.
 *  - Otherwise (plain Web such as `dsh web`), it degrades to an `<iframe>` so
 *    the UI stays usable for sites that allow framing.
 *
 * The host half reaches the on-screen tab through the Desktop shell's HTTP
 * control endpoint (desktop/main.cjs) + `executeJavaScript` into
 * `pageBrowserController`, so the agent's `browser_*` tools and this toolbar
 * stay in sync.
 *
 * @module dsh-builtin-browser/client/BrowserTab
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { stopPicking, togglePicking } from './pick-flow.js'
import type { BrowserTabInjected } from './env.js'
import { BLANK_PAGE, createBrowserPageStore, type BrowserPageStore, type PageSurfaceElement } from './store.js'
import { IconArrowLeft, IconArrowRight, IconCrosshair, IconPlus, IconRotateCw, IconSquare } from './icons.js'

/** Runtime props of a tab body: owner tab information, the locale seat, and the plugin's injected face. */
export type BrowserTabProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'builtinBrowser'>
  & InjectFace<BrowserTabInjected>

/**
 * Styles for the toolbar. Hover needs a `:hover` pseudo-class, which inline
 * styles cannot express, so they live in a stylesheet rendered with the body.
 * Colours are theme tokens only, so light and dark both follow the app.
 */
const TOOLBAR_CSS = `
/* The body is a flex COLUMN that owns exactly the pane box. min-height:0 lets
   the surface shrink below its content size, and overflow:hidden keeps a wide
   page from pushing the toolbar out of the pane. */
.dsh-bb-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111)}
.dsh-bb-bar{display:flex;align-items:center;gap:2px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));flex:none}
.dsh-bb-btn{display:flex;align-items:center;justify-content:center;flex:none;border:none;background:transparent;cursor:pointer;padding:4px;border-radius:6px;color:inherit;opacity:.75;transition:background-color 120ms ease,opacity 120ms ease}
.dsh-bb-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 8%,transparent);opacity:1}
.dsh-bb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:-1px;opacity:1}
.dsh-bb-btn:disabled{opacity:.3;cursor:default}
.dsh-bb-btn[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4D6BFE) 22%,transparent);opacity:1}
.dsh-bb-address{flex:1;min-width:0;height:26px;margin:0 4px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px;outline:none}
.dsh-bb-address::placeholder{color:var(--dsw-alias-label-secondary,#999)}
.dsh-bb-address:focus{border-color:var(--dsw-alias-brand-primary,#4D6BFE)}
.dsh-bb-notice{flex:none;padding:6px 10px;font-size:12px;border-bottom:1px solid transparent;line-height:1.4}
.dsh-bb-notice.ok{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 28%,transparent)}
.dsh-bb-notice.err{color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 28%,transparent)}
.dsh-bb-notice.warn{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 10%,transparent);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 26%,transparent)}
/* The surface takes only the height the toolbar leaves: flex:1 1 auto plus
   min-height:0 and NO height:100%. A percentage height resolves against the
   ROOT full height rather than the remaining space, so the toolbar would push
   the page bottom edge out of the pane, and the guest sizes its layout
   viewport from this box. */
.dsh-bb-surface{flex:1 1 auto;width:100%;min-width:0;height:auto;min-height:0;border:none;background:#fff;display:flex;-webkit-app-region:no-drag}
/* A desktop page laid out for a wide viewport is clipped to the pane width by
   the guest itself; when a site refuses to reflow, the pane scrolls sideways
   rather than cropping the page at a fixed width. */
.dsh-bb-scroll{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;display:flex}
`

/** Normalize whatever the user typed into the address bar into an absolute URL. */
export function toUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') return BLANK_PAGE
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  // A bare host or host/path is the common case: default to HTTPS.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(trimmed)) return `https://${trimmed}`
  // A lone word is a search, not a host.
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`
}

/**
 * Standard Chrome UA for the webview guest. The shell page's own UA is
 * `... Chrome/x.y.z Electron/a.b.c Safari/...`; dropping the Electron segment
 * yields the matching vanilla Chrome UA. Bot detection (e.g. Cloudflare)
 * rejects the Electron marker outright, so the guest must not send it.
 */
function chromeUserAgent(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgent.replace(/\s+Electron\/[\d.]+/, '')
}

/** Marks a surface element whose listeners are attached. */
const BOUND_FLAG = '__dshBuiltinBrowserBound'

/** Marks a surface element whose initial URL was assigned at bind time. */
const SRC_FLAG = '__dshBuiltinBrowserSrcSet'

/** Whether the page renders inside the Desktop shell's webview. */
function inDesktopShell(): boolean {
  const bridge = (globalThis as { desktopBridge?: { browserPort?: number } }).desktopBridge
  return typeof bridge?.browserPort === 'number'
}

/**
 * The page of one built-in browser tab.
 * @param props - the Sidebar's tab information hook plus the locale seat.
 */
export function BrowserTab(props: BrowserTabProps): ReactNode {
  const { t } = props
  const info = props.useTabInfo()
  const { tab } = info
  const sessionId = props.sessionId
  // The content address ui-sidebar-right mints for this instance is both this
  // store's identity and its checkpoint key.
  const contentKey = tab.contentId
  const storeRef = useRef<BrowserPageStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createBrowserPageStore({
      sessionId,
      checkpointKey: contentKey,
      inShell: inDesktopShell(),
    })
  }
  const store = storeRef.current

  const [state, setState] = useState(store.getSnapshot())
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState(state.address)

  useEffect(() => store.subscribe(() => {
    const next = store.getSnapshot()
    setState(next)
    setDraft(next.address)
  }), [store])

  // Persist the page when this occurrence ends (tab closed, Session removed).
  useEffect(() => () => {
    store.persist()
  }, [store])

  // This tab becomes the shell's target whenever it is the one on screen.
  const visible = tab.visible
  useEffect(() => {
    if (visible) store.claim()
  }, [store, visible])

  // Refresh nav state from the surface after any navigation event.
  const refreshNavState = useCallback((): void => {
    const el = store.getSurface()
    if (el === null) {
      setCanGoBack(false)
      setCanGoForward(false)
      return
    }
    try {
      setCanGoBack(el.canGoBack?.() ?? false)
      setCanGoForward(el.canGoForward?.() ?? false)
      const url = el.getURL?.() ?? ''
      if (url !== '') store.setCurrent(url)
    }
    catch {
      // Not attached yet; the next navigation event reports the real state.
    }
  }, [store])

  /**
   * Bind the surface element. The initial URL is assigned imperatively, exactly
   * once per element: `src` is deliberately NOT a JSX prop, because a re-render
   * would rewrite the attribute on every address change, racing `loadURL` with
   * a second navigation that ERR_ABORTs it and leaves the guest on the old page.
   */
  const bindSurface = useCallback((el: HTMLElement | null): void => {
    const surface = el as (PageSurfaceElement & { [BOUND_FLAG]?: boolean; [SRC_FLAG]?: boolean }) | null
    store.setSurface(surface)
    if (surface === null) return
    if (!surface[SRC_FLAG]) {
      surface[SRC_FLAG] = true
      surface.setAttribute('src', store.getSnapshot().address || BLANK_PAGE)
    }
    if (surface[BOUND_FLAG]) return
    surface[BOUND_FLAG] = true
    surface.addEventListener('did-navigate', () => {
      if (!visible) return
      refreshNavState()
      // A real navigation replaced the guest document, so the injected editor
      // is gone; leave picking silently.
      void stopPicking()
    })
    surface.addEventListener('did-navigate-in-page', () => {
      if (visible) refreshNavState()
    })
    surface.addEventListener('did-finish-load', () => {
      if (!visible) return
      setLoading(false)
      refreshNavState()
    })
    surface.addEventListener('did-start-loading', () => {
      if (visible) setLoading(true)
    })
    surface.addEventListener('did-stop-loading', () => {
      if (visible) setLoading(false)
    })
    surface.addEventListener('page-title-updated', (event) => {
      const title = (event as { title?: string }).title ?? surface.getTitle?.() ?? ''
      store.setTitle(title)
    })
  }, [refreshNavState, store, visible])

  // Sync nav/loading indicators with this tab.
  useEffect(() => {
    refreshNavState()
    try {
      setLoading(store.getSurface()?.isLoading?.() ?? false)
    }
    catch {
      // A freshly mounted webview throws before dom-ready ("The WebView must
      // be attached to the DOM..."). Uncaught, this unmounts the tab body;
      // treat it as "not loading" and let did-start-loading flip the indicator.
      setLoading(false)
    }
  }, [refreshNavState, store])

  // Leaving this occurrence while picking must tear the guest's editor down.
  useEffect(() => () => {
    if (store.getSnapshot().picking) void stopPicking()
  }, [store])

  const navigate = useCallback((input: string): void => {
    const url = toUrl(input)
    store.setAddress(url === BLANK_PAGE ? '' : url)
    const el = store.getSurface()
    if (el === null) return
    setLoading(true)
    if (el.loadURL) {
      el.loadURL(url).catch(() => setLoading(false))
    }
    else {
      el.setAttribute('src', url)
    }
  }, [store])

  const goBack = useCallback((): void => {
    store.getSurface()?.goBack?.()
  }, [store])
  const goForward = useCallback((): void => {
    store.getSurface()?.goForward?.()
  }, [store])
  const reload = useCallback((): void => {
    store.getSurface()?.reload?.()
  }, [store])
  const stop = useCallback((): void => {
    store.getSurface()?.stop?.()
    setLoading(false)
  }, [store])

  const pick = useCallback((): void => {
    togglePicking({
      page: store,
      sessionId,
      contentKey,
      copy: {
        pickSent: () => t('pick.sent'),
        pickNotReady: () => t('pick.notReady'),
        pickCrossOrigin: () => t('pick.crossOrigin'),
      },
    })
  }, [contentKey, sessionId, store, t])

  const inShell = state.inShell

  return (
    <div className="dsh-bb-root" data-builtin-browser-tab={contentKey}>
      <style>{TOOLBAR_CSS}</style>
      <div className="dsh-bb-bar" role="toolbar" aria-label={t('type.label')}>
        <button
          type="button"
          className="dsh-bb-btn"
          onClick={goBack}
          disabled={!canGoBack}
          title={t('nav.back')}
          aria-label={t('nav.back')}
        >
          <IconArrowLeft size={13.5} />
        </button>
        <button
          type="button"
          className="dsh-bb-btn"
          onClick={goForward}
          disabled={!canGoForward}
          title={t('nav.forward')}
          aria-label={t('nav.forward')}
        >
          <IconArrowRight size={13.5} />
        </button>
        <button
          type="button"
          className="dsh-bb-btn"
          onClick={reload}
          title={t('nav.reload')}
          aria-label={t('nav.reload')}
        >
          <IconRotateCw size={12.5} />
        </button>
        {/* Always rendered so the row does not reflow when a load starts. */}
        <button
          type="button"
          className="dsh-bb-btn"
          onClick={stop}
          disabled={!loading}
          title={t('nav.stop')}
          aria-label={t('nav.stop')}
        >
          <IconSquare size={12} />
        </button>
        <input
          className="dsh-bb-address"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              navigate(draft)
              event.currentTarget.blur()
            }
            else if (event.key === 'Escape') {
              setDraft(state.address)
              event.currentTarget.blur()
            }
          }}
          placeholder={t('address.placeholder')}
          aria-label={t('address.placeholder')}
          spellCheck={false}
          autoComplete="off"
          inputMode="url"
        />
        {inShell && (
          <button
            type="button"
            className="dsh-bb-btn"
            onClick={pick}
            title={state.picking ? t('picking.on') : t('picking.off')}
            aria-label={state.picking ? t('picking.on') : t('picking.off')}
            aria-pressed={state.picking}
          >
            <IconCrosshair size={13.5} />
          </button>
        )}
        <button
          type="button"
          className="dsh-bb-btn"
          onClick={() => props.openAnotherTab()}
          title={t('tab.new')}
          aria-label={t('tab.new')}
        >
          <IconPlus size={13.5} />
        </button>
      </div>
      {state.toast !== null && (
        <div className={`dsh-bb-notice ${state.toast.ok ? 'ok' : 'err'}`} role="status">
          {state.toast.text}
        </div>
      )}
      {!inShell && (
        <div className="dsh-bb-notice warn" role="note">
          {t('shell.required')}
        </div>
      )}
      {inShell ? (
        <webview
          ref={bindSurface}
          className="dsh-bb-surface"
          allowpopups="true"
          // Standard Chrome UA (no Electron marker) so bot detection treats the
          // guest as a normal browser; the persistent partition keeps cookies
          // and login state across sessions instead of a fresh identity.
          useragent={chromeUserAgent()}
          partition="persist:dsh-browser"
        />
      ) : (
        // Degraded frame in plain Web; sites that refuse framing stay blank.
        <iframe
          ref={bindSurface}
          className="dsh-bb-surface"
          title={t('type.label')}
          onLoad={() => store.setCurrent(store.getSnapshot().address)}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      )}
    </div>
  )
}
