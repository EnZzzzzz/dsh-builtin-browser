/**
 * Built-in browser state: ONE browser instance holding MANY internal tabs.
 *
 * A sidebar browser tab is the browser itself (its own tab strip, its own page
 * surfaces), not one page. So this module owns a list of internal tabs — each
 * with its own address, title, loading flag, and page element — plus which one
 * is active. That is what makes `target="_blank"` links and popups open a NEW
 * TAB INSIDE the panel instead of escaping into a system window or eating a
 * sidebar slot per page.
 *
 * Every surface stays mounted while only the active one is visible, so each
 * internal tab keeps its scroll position, form state, and history.
 *
 * The module also provides:
 *  - `pageBrowserController` / `window.__dshBrowser`, the page-side controller
 *    the Desktop shell drives through `executeJavaScript`; its `tab-*` ops now
 *    address these internal tabs;
 *  - a localStorage checkpoint per (Session, sidebar tab) so a reload or a
 *    collapsed sidebar does not lose the open pages.
 *
 * @module dsh-builtin-browser/client/store
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

type Listener = () => void

/** Blank page the surface loads until the user or agent navigates. */
export const BLANK_PAGE = 'about:blank'

/** Cap on page text returned by the `content` op, so a huge page cannot flood
 * the agent's context. */
const CONTENT_TEXT_LIMIT = 50_000

/** Failure text every page command returns while the browser has no tabs. */
const NO_TAB = 'no built-in browser tab is open'

/** The page-surface element (Electron webview or iframe) one internal tab owns. */
export interface PageSurfaceElement extends HTMLElement {
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
  /** Electron guest webContents id; the shell uses it for capturePage etc. */
  getWebContentsId?(): number
}

/** One internal browser tab. */
export interface BrowserTabRecord {
  /** Stable id, unique within this browser instance. */
  readonly id: number
  /** The URL the user/agent asked for (what the address bar shows). */
  address: string
  /** The URL the surface reports after a commit. */
  current: string
  /** Last page title; empty until the first load reports one. */
  title: string
  /** The surface is loading right now. */
  loading: boolean
}

/** Whole-browser snapshot: the tab list plus the active id. */
export interface BrowserState {
  readonly tabs: readonly BrowserTabRecord[]
  readonly activeTabId: number
  /** Element picking is armed on the active tab. */
  readonly picking: boolean
  /** Transient notice; auto-clears. `ok` styles it. */
  readonly toast: { readonly text: string; readonly ok: boolean } | null
  /** Whether the surfaces run inside the Desktop shell's webview. */
  readonly inShell: boolean
}

/** One tab surface as the view binds it. */
interface SurfaceBinding {
  element: PageSurfaceElement
}

/** Persisted per-instance state: only what is worth restoring. */
interface Checkpoint {
  readonly tabs: readonly { readonly address: string; readonly title: string }[]
  readonly activeIndex: number
}

/** Storage key prefix for this browser instance's checkpoint. */
const STORAGE_PREFIX = 'dsh.builtin-browser.v2'

/** Read one checkpoint; malformed or unavailable storage reads as absent. */
function readCheckpoint(key: string | null): Checkpoint | null {
  if (key === null || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}.${key}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { tabs, activeIndex } = parsed as { tabs?: unknown; activeIndex?: unknown }
    if (!Array.isArray(tabs)) return null
    const restored = tabs
      .filter((tab): tab is { address?: unknown; title?: unknown } => typeof tab === 'object' && tab !== null)
      .map((tab) => ({
        address: typeof tab.address === 'string' ? tab.address : '',
        title: typeof tab.title === 'string' ? tab.title : '',
      }))
    if (restored.length === 0) return null
    const index = typeof activeIndex === 'number' && activeIndex >= 0 && activeIndex < restored.length ? activeIndex : 0
    return { tabs: restored, activeIndex: index }
  }
  catch {
    // A corrupt entry must not break the browser; the next persist replaces it.
    return null
  }
}

/** The store the view and the shell controller share. */
export interface BrowserStore {
  getSnapshot(): BrowserState
  subscribe(listener: Listener): () => void
  /** The active tab record, or null when the list is somehow empty. */
  activeTab(): BrowserTabRecord | null
  /** Bind (or unbind) one internal tab's surface element. */
  setSurface(tabId: number, element: PageSurfaceElement | null): void
  /** The active tab's surface element, when mounted. */
  getSurface(): PageSurfaceElement | null
  /** One tab's surface element (used to show/hide without unmounting). */
  surfaceOf(tabId: number): PageSurfaceElement | null

  // --- Tab management ---------------------------------------------------
  /** Open a new tab (focusing it) and return its id. */
  newTab(options?: { readonly url?: string; readonly activate?: boolean }): number
  /** Close one tab; closing the last one leaves a fresh blank tab. */
  closeTab(tabId: number): void
  /** Make one tab active. */
  activateTab(tabId: number): void
  /** Run a navigation on one tab (defaults to the active tab). */
  navigate(tabId: number, url: string): void

  // --- Per-tab record updates -------------------------------------------
  setAddress(tabId: number, address: string): void
  setCurrent(tabId: number, current: string): void
  setTitle(tabId: number, title: string): void
  setLoading(tabId: number, loading: boolean): void

  // --- Browser-wide state -----------------------------------------------
  setPicking(picking: boolean): void
  showToast(text: string, ok?: boolean): void
  clearToast(): void
  /** Whether surfaces run inside the Desktop shell. */
  inShell(): boolean
  /** Write the open pages to the checkpoint slot. */
  persist(): void
}

/** The browser instance the shell controller and the pick flow drive. */
let activeBrowser: BrowserStore | null = null

/**
 * Opens the browser view when a command arrives with none mounted. Wired by
 * `index.ts` to `ctx.sidebarRight.openTab`, so an agent's first
 * `browser_navigate` / `browser_tab_new` can surface the panel itself instead of
 * failing just because the user had not opened the sidebar yet.
 */
let openView: (() => void) | null = null

/** A URL an agent asked for before any browser was mounted. */
let pendingUrl: string | undefined

/**
 * Read-and-clear the URL a command queued while no browser was mounted.
 * @returns the queued URL, if any.
 */
export function takePendingUrl(): string | undefined {
  const url = pendingUrl
  pendingUrl = undefined
  return url
}

/**
 * Wire the "open the browser view" behavior (called once from `index.ts`).
 * @param handler - opens one browser tab in the right Sidebar, or null to clear.
 */
export function setBrowserOpenHandler(handler: (() => void) | null): void {
  openView = handler
}

/**
 * Create the browser store for one sidebar tab.
 * @param options - owning Session, the checkpoint key (the sidebar tab's content
 *   address, which tells several sidebar tabs apart), whether surfaces run in
 *   the Desktop shell, and URLs to open on creation.
 * @returns the store.
 */
export function createBrowserStore(options: {
  sessionId: SessionId
  checkpointKey: string | null
  inShell: boolean
  initialUrl?: string
}): BrowserStore {
  const { checkpointKey, inShell } = options
  const checkpoint = readCheckpoint(checkpointKey)
  let nextId = 1
  let state: BrowserState
  let activeIndex = 0
  const surfaces = new Map<number, SurfaceBinding>()
  const listeners = new Set<Listener>()
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const makeTab = (address: string, title: string): BrowserTabRecord => ({
    id: nextId++,
    address,
    current: address,
    title,
    loading: false,
  })

  // A new instance starts from its checkpoint, or from the URL it was opened
  // with, or from one blank tab.
  const seedAddress = options.initialUrl ?? checkpoint?.tabs[0]?.address ?? ''
  if (checkpoint !== null) {
    const restored = checkpoint.tabs.map((tab) => makeTab(tab.address, tab.title))
    activeIndex = checkpoint.activeIndex
    if (options.initialUrl !== undefined && options.initialUrl !== '') {
      // Opened with an explicit URL (a popup, a shortcut): add it as a new tab.
      restored.push(makeTab(options.initialUrl, ''))
      activeIndex = restored.length - 1
    }
    state = { tabs: restored, activeTabId: restored[activeIndex]?.id ?? restored[0].id, picking: false, toast: null, inShell }
  }
  else {
    const first = makeTab(seedAddress, '')
    state = { tabs: [first], activeTabId: first.id, picking: false, toast: null, inShell }
  }

  const emit = (): void => {
    listeners.forEach((listener) => listener())
  }

  const replaceTab = (tabId: number, patch: Partial<BrowserTabRecord>): void => {
    const index = state.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const current = state.tabs[index]
    const next = { ...current, ...patch }
    if (next.address === current.address && next.current === current.current
      && next.title === current.title && next.loading === current.loading) return
    const tabs = state.tabs.slice()
    tabs[index] = next
    state = { ...state, tabs }
    activeIndex = tabs.findIndex((tab) => tab.id === state.activeTabId)
    emit()
  }

  const persist = (): void => {
    if (checkpointKey === null || typeof localStorage === 'undefined') return
    try {
      const key = `${STORAGE_PREFIX}.${checkpointKey}`
      const tabs = state.tabs
        .map((tab) => ({ address: tab.address || tab.current, title: tab.title }))
        .filter((tab) => tab.address !== '' || tab.title !== '')
      if (tabs.length === 0) {
        localStorage.removeItem(key)
        return
      }
      const saved: Checkpoint = {
        tabs,
        activeIndex: Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeTabId)),
      }
      localStorage.setItem(key, JSON.stringify(saved))
    }
    catch {
      // Storage full or disabled (private mode): pages lose their checkpoint.
    }
  }

  const store: BrowserStore = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    activeTab() {
      return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null
    },
    setSurface(tabId, element) {
      if (element === null) surfaces.delete(tabId)
      else surfaces.set(tabId, { element })
    },
    getSurface() {
      const active = store.activeTab()
      return active === null ? null : surfaces.get(active.id)?.element ?? null
    },
    surfaceOf(tabId) {
      return surfaces.get(tabId)?.element ?? null
    },

    newTab(newOptions) {
      const url = newOptions?.url ?? ''
      const tab = makeTab(url, '')
      const tabs = [...state.tabs, tab]
      const activate = newOptions?.activate !== false
      state = { ...state, tabs, activeTabId: activate ? tab.id : state.activeTabId }
      activeIndex = tabs.findIndex((candidate) => candidate.id === state.activeTabId)
      emit()
      persist()
      return tab.id
    },
    closeTab(tabId) {
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return
      // Drop the reference only. React owns the DOM: the surface unmounts when
      // its record leaves `tabs`, and removing the node here would leave React
      // holding a detached element and tear the whole view down.
      surfaces.delete(tabId)
      let tabs = state.tabs.filter((tab) => tab.id !== tabId)
      let activeTabId = state.activeTabId
      if (tabs.length === 0) {
        const blank = makeTab('', '')
        tabs = [blank]
        activeTabId = blank.id
      }
      else if (activeTabId === tabId) {
        // Focus the neighbour that took the closed tab's place, else the last.
        activeTabId = tabs[Math.min(index, tabs.length - 1)].id
      }
      // Closing the tab that was being picked on disarms picking.
      const picking = state.picking && state.activeTabId === tabId ? false : state.picking
      state = { ...state, tabs, activeTabId, picking }
      activeIndex = tabs.findIndex((tab) => tab.id === activeTabId)
      emit()
      persist()
    },
    activateTab(tabId) {
      if (tabId === state.activeTabId || !state.tabs.some((tab) => tab.id === tabId)) return
      state = { ...state, activeTabId: tabId }
      activeIndex = state.tabs.findIndex((tab) => tab.id === tabId)
      emit()
      persist()
    },
    navigate(tabId, url) {
      replaceTab(tabId, { address: url === BLANK_PAGE ? '' : url, loading: true })
      persist()
    },
    setAddress(tabId, address) {
      replaceTab(tabId, { address })
      persist()
    },
    setCurrent(tabId, current) {
      if (current === '' || current === BLANK_PAGE) return
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (tab === undefined) return
      replaceTab(tabId, tab.address === '' ? { current, address: current } : { current })
      persist()
    },
    setTitle(tabId, title) {
      replaceTab(tabId, { title })
      persist()
    },
    setLoading(tabId, loading) {
      replaceTab(tabId, { loading })
    },

    setPicking(picking) {
      if (picking === state.picking) return
      state = { ...state, picking }
      emit()
    },
    showToast(text, ok) {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toastTimer = undefined
        if (state.toast !== null) {
          state = { ...state, toast: null }
          emit()
        }
      }, 4000)
      state = { ...state, toast: { text, ok: ok === true } }
      emit()
    },
    clearToast() {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      toastTimer = undefined
      if (state.toast === null) return
      state = { ...state, toast: null }
      emit()
    },
    inShell: () => state.inShell,
    persist,
  }

  // The newest instance claims the shell controller; views re-claim on focus.
  activeBrowser = store
  return store
}

/** Report a browser as the one the shell controller drives (focus/mount). */
export function claimBrowser(store: BrowserStore): void {
  activeBrowser = store
}

/**
 * The active browser instance, or null while none is mounted.
 * @returns the store the shell controller and the pick flow operate on.
 */
export function activeBrowserStore(): BrowserStore | null {
  return activeBrowser
}

/** Dropped by the owning fiber so a stale browser never answers shell commands. */
export function clearActiveBrowserStore(): void {
  activeBrowser = null
}

/** Load one URL into a surface. */
async function loadInto(element: PageSurfaceElement, url: string): Promise<void> {
  if (element.loadURL) {
    await element.loadURL(url)
    return
  }
  // Bare iframe fallback (plain Web, no Electron guest).
  element.setAttribute('src', url)
}

/**
 * The global controller the Desktop shell drives via `executeJavaScript`
 * (desktop/main.cjs forwards `/browser/command` here). Commands apply to the
 * active INTERNAL tab; every method returns a JSON value the shell relays back
 * to the harness host half verbatim.
 */
export const pageBrowserController = {
  async command(payload: { op?: string; url?: string; script?: string; id?: number | string }): Promise<unknown> {
    const store = activeBrowser
    const op = payload.op ?? ''

    // Tab bookkeeping works even while the view is mid-mount.
    if (op === 'tab-list') {
      if (store === null) return { ok: true, tabs: [] }
      const snapshot = store.getSnapshot()
      return {
        ok: true,
        tabs: snapshot.tabs.map((tab) => ({
          id: tab.id,
          url: tab.current || tab.address,
          title: tab.title,
          active: tab.id === snapshot.activeTabId,
        })),
      }
    }
    if (op === 'tab-new') {
      const url = String(payload.url ?? '')
      if (store === null) {
        // No browser on screen: surface one, then report that the caller should
        // retry (the new view mounts with its own first tab).
        if (openView !== null) {
          openView()
          return { ok: true, pending: true, hint: 'the browser opened; retry the command once it mounts' }
        }
        return { ok: false, error: NO_TAB }
      }
      const id = store.newTab({ url })
      return { ok: true, id }
    }
    if (op === 'tab-close') {
      if (store === null) return { ok: false, error: NO_TAB }
      const id = Number(payload.id)
      if (!store.getSnapshot().tabs.some((tab) => tab.id === id)) {
        return { ok: false, error: `no such tab: ${String(payload.id)}` }
      }
      store.closeTab(id)
      return { ok: true }
    }
    if (op === 'tab-activate') {
      if (store === null) return { ok: false, error: NO_TAB }
      const id = Number(payload.id)
      if (!store.getSnapshot().tabs.some((tab) => tab.id === id)) {
        return { ok: false, error: `no such tab: ${String(payload.id)}` }
      }
      store.activateTab(id)
      return { ok: true, id }
    }

    if (op === 'navigate') {
      const url = String(payload.url ?? '')
      if (url === '') return { ok: false, error: 'navigate requires a url' }
      if (store === null) {
        // Nothing is open: ask the view to appear pointed at this URL.
        if (openView !== null) {
          pendingUrl = url
          openView()
          return { ok: true, url, title: '', pending: true }
        }
        return { ok: false, error: NO_TAB }
      }
      const activeTab = store.activeTab()
      if (activeTab === null) return { ok: false, error: NO_TAB }
      store.navigate(activeTab.id, url)
      const element = store.getSurface()
      if (element !== null) {
        try {
          await loadInto(element, url)
        }
        catch (err) {
          store.setLoading(activeTab.id, false)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      return { ok: true, url, title: element?.getTitle?.() ?? '' }
    }

    if (store === null) return { ok: false, error: NO_TAB }
    const active = store.activeTab()
    if (active === null) return { ok: false, error: NO_TAB }

    const element = store.getSurface()
    if (element === null) return { ok: false, error: 'browser surface not mounted' }
    switch (op) {
      case 'back':
        element.goBack?.()
        return { ok: true, url: element.getURL?.() ?? '', title: element.getTitle?.() ?? '' }
      case 'forward':
        element.goForward?.()
        return { ok: true, url: element.getURL?.() ?? '', title: element.getTitle?.() ?? '' }
      case 'reload':
        element.reload?.()
        return { ok: true }
      case 'stop':
        element.stop?.()
        return { ok: true }
      case 'eval': {
        const script = String(payload.script ?? '')
        if (!element.executeJavaScript) {
          return { ok: false, error: 'executeJavaScript unavailable outside the Desktop shell' }
        }
        try {
          const result = await element.executeJavaScript(script, true)
          return { ok: true, result: result === undefined ? null : result }
        }
        catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      case 'content': {
        if (!element.executeJavaScript) {
          return { ok: false, error: 'executeJavaScript unavailable outside the Desktop shell' }
        }
        try {
          const text = await element.executeJavaScript('document.body ? document.body.innerText : ""', true)
          const full = typeof text === 'string' ? text : ''
          return {
            ok: true,
            url: element.getURL?.() ?? '',
            title: element.getTitle?.() ?? '',
            text: full.slice(0, CONTENT_TEXT_LIMIT),
            truncated: full.length > CONTENT_TEXT_LIMIT,
          }
        }
        catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      case 'screenshot': {
        // The capture happens in the shell's main process
        // (webContents.capturePage); hand over the guest id.
        const id = element.getWebContentsId?.()
        if (!id) return { ok: false, error: 'webContents id unavailable outside the Desktop shell' }
        return { ok: true, webContentsId: id }
      }
      default:
        return { ok: false, error: `unknown browser command: ${op}` }
    }
  },
}
