/**
 * The built-in browser tab body, registered into the right Sidebar's
 * `sidebar.right.pane.tab` seat under this package's implementation id.
 *
 * The Sidebar owns the COLUMN: docking, splitting, floating, and closing a
 * browser here. This component is the BROWSER ITSELF — a tab strip over one page
 * surface per internal tab — so `target="_blank"` links, popups, and the + button
 * all open another page *inside* the panel instead of spawning system windows or
 * spending a sidebar slot per page.
 *
 * Every internal tab's surface stays mounted; only the active one is visible, so
 * each keeps its scroll position, form state, and history.
 *
 * Page surface selection:
 *  - Inside the Desktop shell (`window.desktopBridge` with a browser port, and a
 *    shell that opted into `webviewTag`), a real `<webview>` per tab — a full
 *    Chromium guest with its own session and history.
 *  - Otherwise (plain Web such as `dsh web`), it degrades to `<iframe>` so the UI
 *    stays usable for sites that allow framing.
 *
 * @module dsh-builtin-browser/client/BrowserTab
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { stopPicking, togglePicking } from './pick-flow.js'
import {
  BLANK_PAGE,
  claimBrowser,
  createBrowserStore,
  takePendingUrl,
  type BrowserStore,
  type BrowserTabRecord,
  type PageSurfaceElement,
} from './store.js'
import { IconArrowLeft, IconArrowRight, IconClose, IconCrosshair, IconPlus, IconRotateCw, IconSquare } from './icons.js'

/** Runtime props of a tab body: owner tab information plus the locale seat. */
export type BrowserTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'builtinBrowser'>

/**
 * Browser chrome styles. Hover and active states need pseudo-classes, which
 * inline styles cannot express, so they live in a stylesheet rendered with the
 * body. Colours are theme tokens only, so light and dark both follow the app.
 */
const BROWSER_CSS = `
/* The body owns exactly the pane box. min-height:0 lets the surface shrink
   below its content size, and overflow:hidden keeps a wide page from pushing
   the chrome out of the pane. */
.dsh-bb-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111)}

/* ONE row holds navigation, the tab pills, and the page actions. The pills are
   the address bar too: clicking the active pill turns it into an editor that
   grows sideways, exactly like the original panel. */
.dsh-bb-bar{display:flex;align-items:center;gap:3px;flex:none;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.dsh-bb-btn{display:flex;align-items:center;justify-content:center;flex:none;border:none;background:transparent;cursor:pointer;padding:5px;border-radius:6px;color:inherit;opacity:.75;transition:background-color 120ms ease,opacity 120ms ease}
.dsh-bb-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 8%,transparent);opacity:1}
.dsh-bb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:-1px;opacity:1}
.dsh-bb-btn:disabled{opacity:.3;cursor:default}
.dsh-bb-btn[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4D6BFE) 22%,transparent);opacity:1}

/* The strip shares the row with the navigation buttons and scrolls when
   crowded; the pills never push the page actions out of the pane. The minimum
   page controls the row height, not the pills, so it stays put while a pill
   grows and the page below never jumps mid-animation. */
.dsh-bb-strip{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;min-height:28px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.dsh-bb-strip::-webkit-scrollbar{display:none}

/* New-tab entrance: the pill fades in with a small lift, which keeps adding a
   tab from feeling like it snapped into place. Only the from-frame is keyed, so
   the animation lands wherever the pill's own layout puts it. This is the only
   motion in the strip: opening and closing the editor are instant, and closing a
   tab is a plain removal, so nothing ever re-flows the strip mid-animation. */
@keyframes dsh-bb-tab-in{
  from{opacity:0;transform:translateY(2px) scale(.96)}
}

/* The pill is a 2-column GRID, not a free flex row:
     column 1 = the title (or the address editor while editing)
     column 2 = the close mark's fixed 16px lane
   Grid puts each child in a named track, so the × always sits in the right
   column no matter how wide the title or the editor turns out to be. The flex
   versions failed exactly here: the × was a flow item placed after the label,
   so while editing (label collapsed to 0 width and the input overlaid as an
   absolute layer) the × landed a third of the way into the pill. */
.dsh-bb-tab{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 16px;column-gap:2px;align-items:center;justify-items:center;box-sizing:border-box;flex:0 0 auto;flex-shrink:1;width:150px;max-width:100%;overflow:hidden;animation:dsh-bb-tab-in 200ms cubic-bezier(.22,1,.36,1);padding:0 4px;border:1px solid transparent;border-radius:8px;cursor:pointer;color:inherit;font:inherit;font-size:12.5px;line-height:18px;background:transparent;opacity:.62;user-select:none;
  /* Entering and leaving the editor is INSTANT. Animating the width laid the
     pill out on every frame, and the title re-centring and the editor appearing
     had to be re-laid-out with it, which read as stutter for no real benefit.
     The pill keeps one shape; only the tab's own entrance animates. */
  transition:background-color 120ms ease,opacity 120ms ease}
.dsh-bb-tab:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 7%,transparent);opacity:.9}
.dsh-bb-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,color-mix(in srgb,var(--dsw-alias-label-primary,#111) 5%,transparent));border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.3));opacity:1}
.dsh-bb-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:-2px}
/* Editing does NOT resize the pill: the address editor replaces the title inside
   the space the tab already has. Widening on click made the whole strip reflow
   and pushed the neighbouring tabs sideways for what is really just a text
   field gaining focus. */
.dsh-bb-tab.dsh-bb-editing{cursor:text}
/* Column 1: a nested flex row holding the optional spinner and the title. */
.dsh-bb-tabMain{grid-column:1;display:flex;align-items:center;justify-content:center;min-width:0;max-width:100%;overflow:hidden}
/* The title ellipsises inside that row instead of widening the grid. */
.dsh-bb-tabLabel{flex:1 1 auto;min-width:0;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* The editor is an overlay over column 1 ONLY. Its right inset is the close
   lane plus the gap plus the pill's right padding (16 + 2 + 4 = 22), so the
   input's own box stops before column 2 and can never paint under the ×. */
/* The editor occupies the title's slot and REPLACES it, with no cross-fade.
   Fading the title out while fading the editor in made one click show three
   different texts in sequence (title, placeholder, caret) and read as stutter.
   Hidden/shown in one frame, the swap looks like the same text becoming
   editable. It stays mounted so opening never adds a node: the closed state
   only makes it non-painting and inert. */
.dsh-bb-tabInput{grid-column:1;position:absolute;top:1px;bottom:1px;left:4px;right:22px;width:auto;z-index:1;box-sizing:border-box;min-width:0;margin:0;padding:0;border:none;border-radius:7px;outline:none;background:transparent;color:inherit;font:inherit;font-size:12.5px;line-height:18px;text-align:center;opacity:0;visibility:hidden;pointer-events:none}
.dsh-bb-tab.dsh-bb-editing .dsh-bb-tabInput{opacity:1;visibility:visible;pointer-events:auto}
.dsh-bb-tabInput::placeholder{color:var(--dsw-alias-label-secondary,#999)}
/* While editing the input paints the address (or its placeholder) over column 1,
   so the static title steps aside. The × stays visible and does not move: it
   owns column 2 in both states. */
/* The title is hidden in the same frame the editor takes over, so the slot
   never shows both at once and never goes empty in between. */
.dsh-bb-tab.dsh-bb-editing .dsh-bb-tabLabel{visibility:hidden}
/* Column 2, pinned by the grid rather than by an offset. */
.dsh-bb-tab .dsh-bb-close{grid-column:2;justify-self:center;align-self:center;display:flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:50%;background:transparent;color:inherit;cursor:pointer;opacity:.45;transition:background-color 120ms ease,opacity 120ms ease}
.dsh-bb-tab:hover .dsh-bb-close,.dsh-bb-tab[aria-selected="true"] .dsh-bb-close,.dsh-bb-close:focus-visible{opacity:.85}
.dsh-bb-tab .dsh-bb-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 14%,transparent);opacity:1}
/* One tab left: the close mark is disabled, not hidden. It keeps its slot so
   the pill is unchanged, but drops the hover affordance and stays inert. */
.dsh-bb-tab .dsh-bb-close:disabled{cursor:default;opacity:.28}
.dsh-bb-tab .dsh-bb-close:disabled:hover{background:transparent;opacity:.28}
.dsh-bb-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:1px}
/* Column 1 as well: the spinner rides with the title it belongs to, so it can
   never take the close mark's track. */
.dsh-bb-tabSpinner{flex:none;width:10px;height:10px;margin-right:6px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4D6BFE) 30%,transparent);border-top-color:var(--dsw-alias-brand-primary,#4D6BFE);animation:dsh-bb-spin .7s linear infinite}
@keyframes dsh-bb-spin{to{transform:rotate(360deg)}}

.dsh-bb-notice{flex:none;padding:6px 10px;font-size:12px;border-bottom:1px solid transparent;line-height:1.4}
.dsh-bb-notice.ok{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 28%,transparent)}
.dsh-bb-notice.err{color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 28%,transparent)}
.dsh-bb-notice.warn{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 10%,transparent);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 26%,transparent)}

/* The surface takes only the height the chrome leaves: flex:1 1 auto plus
   min-height:0 and NO height:100%. A percentage height resolves against the
   root's full height rather than the remaining space, which pushed the page's
   bottom edge out of the pane (and made the guest size its layout viewport from
   the inflated box). */
.dsh-bb-surfaces{position:relative;flex:1 1 auto;min-height:0;min-width:0}
/* Inactive tabs are STACKED, not display:none. An Electron <webview> that loses
   its box gets detached by Chromium and can come back blank or wedged, which is
   exactly what "closing a tab froze the browser" looked like. Keeping every
   surface laid out and simply burying the inactive ones keeps each guest alive. */
.dsh-bb-surface{position:absolute;inset:0;width:100%;height:100%;min-width:0;min-height:0;border:none;background:#fff;display:flex;-webkit-app-region:no-drag}
.dsh-bb-surface[data-active="false"]{visibility:hidden;pointer-events:none;z-index:0}
.dsh-bb-surface[data-active="true"]{visibility:visible;pointer-events:auto;z-index:1}
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

/** Whether the surfaces render inside the Desktop shell's webview. */
function inDesktopShell(): boolean {
  const bridge = (globalThis as { desktopBridge?: { browserPort?: number } }).desktopBridge
  return typeof bridge?.browserPort === 'number'
}

/** Short label for a tab: page title, else the URL host, else "New tab". */
function tabLabel(tab: BrowserTabRecord, blankLabel: string): string {
  if (tab.title !== '') return tab.title
  const address = tab.current || tab.address
  if (address !== '' && address !== BLANK_PAGE) {
    try {
      return new URL(address).hostname
    }
    catch {
      return address
    }
  }
  return blankLabel
}

/**
 * One page surface. Mounted once per internal tab and never unmounted until the
 * tab closes, so hiding it (rather than removing it) preserves the page.
 */
function PageSurface(props: {
  tabId: number
  store: BrowserStore
  inShell: boolean
  visible: boolean
  initialUrl: string
  openInNewTab: (url: string) => void
  onNavigate: (tabId: number) => void
  onLoading: (tabId: number, loading: boolean) => void
  onTitle: (tabId: number, title: string) => void
}): ReactNode {
  const { tabId, store, inShell, visible, initialUrl, openInNewTab, onNavigate, onLoading, onTitle } = props

  // The ref callback must be identity-stable: React re-invokes it on every
  // render otherwise, which would unregister/rebind the surface each time. It
  // reads the live props from a ref so the listeners never capture stale state.
  const live = useRef({ openInNewTab, onNavigate, onLoading, onTitle })
  live.current = { openInNewTab, onNavigate, onLoading, onTitle }
  const firstUrl = useRef(initialUrl)
  const boundRef = useRef<PageSurfaceElement | null>(null)

  const bind = useCallback((element: HTMLElement | null): void => {
    if (element === null) {
      // Unmount: forget the element but never touch its DOM — React removes it.
      store.setSurface(tabId, null)
      boundRef.current = null
      return
    }
    if (boundRef.current === element) return
    const surface = element as PageSurfaceElement
    boundRef.current = surface
    store.setSurface(tabId, surface)
    // Assign the initial URL imperatively, exactly once: `src` is deliberately
    // not a prop, because a re-render would rewrite it and race `loadURL` with a
    // second navigation that aborts the first.
    surface.setAttribute('src', firstUrl.current || BLANK_PAGE)
    surface.addEventListener('did-navigate', () => {
      live.current.onNavigate(tabId)
      // A real navigation replaced the guest document, so an injected editor is
      // gone; leave picking silently.
      void stopPicking()
    })
    surface.addEventListener('did-navigate-in-page', () => live.current.onNavigate(tabId))
    surface.addEventListener('did-finish-load', () => {
      live.current.onLoading(tabId, false)
      live.current.onNavigate(tabId)
    })
    surface.addEventListener('did-start-loading', () => live.current.onLoading(tabId, true))
    surface.addEventListener('did-stop-loading', () => live.current.onLoading(tabId, false))
    surface.addEventListener('page-title-updated', (event) => {
      live.current.onTitle(tabId, (event as { title?: string }).title ?? surface.getTitle?.() ?? '')
    })
    // `allowpopups` is what makes a popup possible at all; without claiming the
    // window here Electron opens a real top-level window for every
    // `target="_blank"` click. Claim it, open an internal tab, keep this page.
    surface.addEventListener('new-window', (event) => {
      event.preventDefault()
      const url = (event as { url?: string }).url ?? ''
      if (url !== '' && url !== BLANK_PAGE) live.current.openInNewTab(url)
    })
  }, [store, tabId])

  if (inShell) {
    return (
      <webview
        ref={bind}
        className="dsh-bb-surface"
        data-active={visible ? 'true' : 'false'}
        allowpopups="true"
        // Standard Chrome UA (no Electron marker) so bot detection treats the
        // guest as a normal browser; the persistent partition keeps cookies and
        // logins across sessions instead of a fresh identity.
        useragent={chromeUserAgent()}
        partition="persist:dsh-browser"
      />
    )
  }
  return (
    <iframe
      ref={bind}
      className="dsh-bb-surface"
      data-active={visible ? 'true' : 'false'}
      title="builtin-browser"
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
    />
  )
}

/**
 * The built-in browser: internal tab strip over one surface per tab.
 * @param props - the Sidebar's tab information hook plus the locale seat.
 */
export function BrowserTab(props: BrowserTabProps): ReactNode {
  const { t } = props
  const info = props.useTabInfo()
  const { tab: sidebarTab } = info
  const sessionId = props.sessionId

  // A URL an agent queued before any browser existed (`browser_navigate` while
  // the sidebar was closed) becomes this browser's first tab.
  const initialUrl = useRef<string | undefined>(undefined)
  if (initialUrl.current === undefined) initialUrl.current = takePendingUrl() ?? ''
  const storeRef = useRef<BrowserStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createBrowserStore({
      sessionId,
      checkpointKey: sidebarTab.contentId,
      inShell: inDesktopShell(),
      initialUrl: initialUrl.current,
    })
  }
  const store = storeRef.current
  const [snapshot, setSnapshot] = useState(store.getSnapshot())
  // The pill being edited inline (its id), plus the draft its input shows.
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store])

  // Follow the address bar whenever the active tab's address changes.
  const active = snapshot.tabs.find((candidate) => candidate.id === snapshot.activeTabId) ?? snapshot.tabs[0]

  // Only the tab on screen drives the shell controller and the pick flow.
  useEffect(() => {
    if (sidebarTab.visible) claimBrowser(store)
  }, [sidebarTab.visible, store])

  useEffect(() => () => store.persist(), [store])

  const refreshNav = useCallback((): void => {
    const element = store.getSurface()
    if (element === null) {
      setCanGoBack(false)
      setCanGoForward(false)
      return
    }
    try {
      setCanGoBack(element.canGoBack?.() ?? false)
      setCanGoForward(element.canGoForward?.() ?? false)
    }
    catch {
      // Not attached yet; the next navigation event reports the real state.
    }
  }, [store])

  // Resync navigation affordances when the active tab changes or reloads.
  useEffect(refreshNav, [refreshNav, snapshot.activeTabId])

  const activeAddress = active?.address ?? ''
  // While a pill is being edited its input owns the draft; otherwise the draft
  // mirrors the active tab so entering edit starts from the current address.
  useEffect(() => {
    if (editing !== null) return
    setDraft(activeAddress)
  }, [activeAddress, editing])

  // Drop an edit session whose tab went away.
  useEffect(() => {
    if (editing === null) return
    if (!snapshot.tabs.some((tab) => tab.id === editing)) setEditing(null)
  }, [editing, snapshot.tabs])

  const openInNewTab = useCallback((url: string): void => {
    store.newTab({ url })
  }, [store])

  const onNavigate = useCallback((tabId: number): void => {
    const element = store.surfaceOf(tabId)
    const url = element?.getURL?.() ?? ''
    if (url !== '') store.setCurrent(tabId, url)
  }, [store])

  const onLoading = useCallback((tabId: number, loading: boolean): void => {
    store.setLoading(tabId, loading)
  }, [store])

  const onTitle = useCallback((tabId: number, title: string): void => {
    store.setTitle(tabId, title)
  }, [store])

  const navigate = useCallback((input: string): void => {
    if (active === undefined) return
    const url = toUrl(input)
    store.navigate(active.id, url)
    const element = store.getSurface()
    if (element === null) return
    if (element.loadURL) element.loadURL(url).catch(() => store.setLoading(active.id, false))
    else element.setAttribute('src', url)
  }, [active, store])

  /** Enter inline editing on one pill, seeded with its address. */
  const startEditing = useCallback((tab: BrowserTabRecord): void => {
    setDraft(tab.address || tab.current || '')
    setEditing(tab.id)
  }, [])

  /** Leave inline editing without navigating. */
  const stopEditing = useCallback((): void => {
    setEditing(null)
    setDraft(activeAddress)
  }, [activeAddress])

  /** Commit an inline address edit; re-committing the same URL never reloads. */
  const commitEdit = useCallback((tabId: number, value: string): void => {
    setEditing(null)
    const trimmed = value.trim()
    const tab = store.getSnapshot().tabs.find((candidate) => candidate.id === tabId)
    if (tab === undefined) return
    store.activateTab(tabId)
    if (trimmed === '') {
      setDraft(tab.address || tab.current || '')
      return
    }
    const url = toUrl(trimmed)
    if (url === (tab.current || tab.address)) {
      setDraft(tab.address || tab.current || '')
      return
    }
    store.navigate(tabId, url)
    const element = store.surfaceOf(tabId)
    if (element === null) return
    if (element.loadURL) element.loadURL(url).catch(() => store.setLoading(tabId, false))
    else element.setAttribute('src', url)
  }, [store])

  /**
   * Close a pill.
   *
   * The removal is immediate and single-commit. An earlier version animated the
   * departing pill in place and dropped it only when the animation ended, which
   * meant the node kept its slot at full size, then vanished while the strip
   * slid everything over — visible as a one-frame flash of a tab where none
   * should be. Closing now frees the space in the same commit it happens, and
   * the remaining pills simply lay out again.
   */
  const requestClose = useCallback((tabId: number): void => {
    if (editing === tabId) setEditing(null)
    store.closeTab(tabId)
  }, [editing, store])

  /** The + button: a new blank tab that opens straight into its address editor. */
  const openNewTab = useCallback((): void => {
    const id = store.newTab()
    setDraft('')
    setEditing(id)
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
    if (active !== undefined) store.setLoading(active.id, false)
  }, [active, store])

  const pick = useCallback((): void => {
    if (active === undefined) return
    togglePicking({
      store,
      sessionId,
      tabId: active.id,
      copy: {
        pickSent: () => t('pick.sent'),
        pickNotReady: () => t('pick.notReady'),
        pickCrossOrigin: () => t('pick.crossOrigin'),
      },
    })
  }, [active, sessionId, store, t])

  const activeLoading = active?.loading ?? false
  const inShell = snapshot.inShell
  // A lone tab cannot be closed (the store refuses, so it never respawns a blank
  // one). The control stays VISIBLE and occupies its grid column so the pill
  // keeps its width, but it is disabled: hiding it left the pill looking
  // half-empty and shifted the title every time the last tab was reached.
  const closeable = snapshot.tabs.length > 1

  return (
    <div className="dsh-bb-root" data-builtin-browser-tabs={snapshot.tabs.length}>
      <style>{BROWSER_CSS}</style>
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
          disabled={!activeLoading}
          title={t('nav.stop')}
          aria-label={t('nav.stop')}
        >
          <IconSquare size={12} />
        </button>

        {/* The pills ARE the address bar: the active one is clickable into an
            inline editor that widens in place. */}
        <div className="dsh-bb-strip" role="tablist" aria-label={t('type.label')}>
          {snapshot.tabs.map((tab) => {
            const selected = tab.id === active?.id
            const isEditing = editing === tab.id
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                className={`dsh-bb-tab${isEditing ? ' dsh-bb-editing' : ''}`}
                title={isEditing ? undefined : (tab.current || tab.address || t('tab.blank'))}
                onAuxClick={(event) => {
                  // Middle click closes, like every other tab strip.
                  if (event.button === 1 && closeable) {
                    event.preventDefault()
                    requestClose(tab.id)
                  }
                }}
                onClick={() => {
                  // Clicking the active pill starts editing it; clicking another
                  // only switches (a second click then edits).
                  if (isEditing) return
                  if (selected) startEditing(tab)
                  else store.activateTab(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (selected) startEditing(tab)
                  else store.activateTab(tab.id)
                }}
              >
                {/* Column 1 keeps the spinner and the title in one nested flex
                    row; the close mark owns column 2. */}
                <span className="dsh-bb-tabMain">
                  {tab.loading && !isEditing && <span className="dsh-bb-tabSpinner" aria-hidden="true" />}
                  {/* Label and close mark stay mounted while editing. The editor
                      overlays them instead of replacing them, so the pill can
                      animate its width open and shut without the address text
                      being laid out again on every frame. */}
                  <span className="dsh-bb-tabLabel">{tabLabel(tab, t('tab.blank'))}</span>
                </span>
                {/* Always rendered so the pill keeps the same shape and the
                    title never shifts. With only one tab left it is disabled
                    rather than hidden: closing the last page is never offered,
                    and the button still fills the grid column that keeps the
                    pill from looking half-empty. */}
                <button
                  type="button"
                  className="dsh-bb-close"
                  disabled={!closeable}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!closeable) return
                    requestClose(tab.id)
                  }}
                  title={t('tab.close')}
                  aria-label={`${t('tab.close')} ${tabLabel(tab, t('tab.blank'))}`}
                >
                  <IconClose size={9} />
                </button>
                {/* The editor is MOUNTED in both states and only faded. Mounting
                    it on the click frame added the input, ran the focus and
                    selected its text all in the same frame the width transition
                    started, which is what made opening feel like dropped
                    frames. Kept in the tree, the animating frames do layout
                    work for the width alone. It is inert while closed:
                    tabIndex -1 keeps it out of the tab order,
                    pointer-events:none keeps it from swallowing the pill's
                    click, and it only paints once .editing fades it in. */}
                <input
                  className="dsh-bb-tabInput"
                  tabIndex={isEditing ? 0 : -1}
                  aria-hidden={!isEditing}
                  ref={(element) => {
                    if (element === null) return
                    if (isEditing) {
                      if (document.activeElement !== element) {
                        element.focus()
                        element.select()
                      }
                    }
                    else if (document.activeElement === element) {
                      element.blur()
                    }
                  }}
                  value={draft === '' ? tabLabel(tab, t('tab.blank')) : draft}
                  readOnly={!isEditing}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={(event) => event.target.select()}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') commitEdit(tab.id, draft)
                    else if (event.key === 'Escape') stopEditing()
                  }}
                  onBlur={() => {
                    if (isEditing) commitEdit(tab.id, draft)
                  }}
                  placeholder={t('address.placeholder')}
                  aria-label={`${t('tab.edit')} ${tabLabel(tab, t('tab.blank'))}`}
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="url"
                />
              </div>
            )
          })}
          <button
            type="button"
            className="dsh-bb-btn"
            onClick={openNewTab}
            title={t('tab.new')}
            aria-label={t('tab.new')}
          >
            <IconPlus size={13.5} />
          </button>
        </div>

        {inShell && (
          <button
            type="button"
            className="dsh-bb-btn"
            onClick={pick}
            title={snapshot.picking ? t('picking.on') : t('picking.off')}
            aria-label={snapshot.picking ? t('picking.on') : t('picking.off')}
            aria-pressed={snapshot.picking}
          >
            <IconCrosshair size={13.5} />
          </button>
        )}
      </div>
      {snapshot.toast !== null && (
        <div className={`dsh-bb-notice ${snapshot.toast.ok ? 'ok' : 'err'}`} role="status">
          {snapshot.toast.text}
        </div>
      )}
      {!inShell && (
        <div className="dsh-bb-notice warn" role="note">
          {t('shell.required')}
        </div>
      )}
      <div className="dsh-bb-surfaces">
        {snapshot.tabs.map((tab) => (
          <PageSurface
            key={tab.id}
            tabId={tab.id}
            store={store}
            inShell={inShell}
            visible={tab.id === active?.id}
            initialUrl={tab.address || BLANK_PAGE}
            openInNewTab={openInNewTab}
            onNavigate={onNavigate}
            onLoading={onLoading}
            onTitle={onTitle}
          />
        ))}
      </div>
    </div>
  )
}
