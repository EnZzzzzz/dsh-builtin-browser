/**
 * Shared browser panel state: one tiny external store used by both the
 * sidebar toggle (sidebar.footer.action) and the floating panel
 * (shell.overlay). Kept outside React so two independently rendered slots
 * stay in sync without a context provider.
 *
 * Multi-tab model: the panel owns a list of tabs (always at least one), each
 * with its own address, last-committed URL, title, and page-surface element
 * (Electron webview or iframe). All tabs stay mounted — inactive ones are
 * display:none — so each tab keeps its session and history. The shell-facing
 * controller and the pick flow always operate on the ACTIVE tab's surface.
 *
 * @module dsh-builtin-browser/client/store
 */

type Listener = () => void

/** One browser tab. */
export interface BrowserTab {
  /** Stable per-session id. */
  id: number
  /** The URL the user/agent last entered for this tab (drives the editor). */
  address: string
  /** The URL the surface actually finished navigating to. */
  current: string
  /** Last page title reported by the surface; empty until the first load. */
  title: string
}

export interface BrowserPanelState {
  /** Whether the floating browser panel is visible. */
  open: boolean
  /** All tabs, in strip order. Never empty. */
  tabs: BrowserTab[]
  /** The tab the toolbar, controller, and pick flow operate on. */
  activeTabId: number
  /** Whether the panel is running inside an Electron shell (webview available). */
  inShell: boolean
  /** Whether element picking (the vendored Selector editor) is active. */
  picking: boolean
  /** Transient toast shown under the toolbar; auto-clears. `ok` styles it. */
  toast: { text: string; ok: boolean } | null
  /** Command queued while the active tab's surface is unmounted (lazy in-session
   * views); consumed by the view's first surface bind. */
  pending: { op: string; url: string } | null
}

/** Blank page the surface loads until the user or agent navigates. */
export const BLANK_PAGE = 'about:blank'

/** The page-surface element (Electron webview or iframe) the panel owns. */
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

/** Tab surfaces stay mounted per tab so each keeps its session/history. */
const surfaces = new Map<number, PageSurfaceElement>()

let nextTabId = 1

function blankTab(): BrowserTab {
  return { id: nextTabId++, address: '', current: '', title: '' }
}

const firstTab = blankTab()

let state: BrowserPanelState = {
  open: false,
  tabs: [firstTab],
  activeTabId: firstTab.id,
  inShell: false,
  picking: false,
  toast: null,
  pending: null,
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((l) => l())
}

/** The active tab (invariant: tabs is never empty, so this always exists). */
function activeTab(): BrowserTab {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0]
}

/** Patch one tab in place and emit. */
function updateTab(id: number, patch: Partial<Omit<BrowserTab, 'id'>>): void {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab) return
  const next = { ...tab, ...patch }
  if (
    next.address === tab.address
    && next.current === tab.current
    && next.title === tab.title
  ) return
  state = { ...state, tabs: state.tabs.map((t) => (t.id === id ? next : t)) }
  emit()
}

function dismissToast(): void {
  if (state.toast === null) return
  state = { ...state, toast: null }
  emit()
}

export const browserStore = {
  get(): BrowserPanelState {
    return state
  },
  /** The tab the toolbar and controller currently drive. */
  getActiveTab(): BrowserTab {
    return activeTab()
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  toggle(): void {
    state = { ...state, open: !state.open }
    emit()
  },
  setOpen(open: boolean): void {
    if (state.open === open) return
    state = { ...state, open }
    emit()
  },

  // --- Tabs -------------------------------------------------------------

  /** Append a blank tab and activate it. Returns its id. */
  addTab(): number {
    const tab = blankTab()
    state = { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
    emit()
    return tab.id
  },
  /** Close one tab. Closing the last tab replaces it with a fresh blank one. */
  closeTab(id: number): void {
    surfaces.delete(id)
    let tabs = state.tabs.filter((t) => t.id !== id)
    if (tabs.length === 0) tabs = [blankTab()]
    const activeTabId = state.activeTabId === id
      ? (tabs[Math.min(state.tabs.findIndex((t) => t.id === id), tabs.length - 1)]?.id ?? tabs[0].id)
      : state.activeTabId
    state = { ...state, tabs, activeTabId }
    emit()
  },
  /** Make one tab active. */
  activateTab(id: number): void {
    if (state.activeTabId === id || !state.tabs.some((t) => t.id === id)) return
    state = { ...state, activeTabId: id }
    emit()
  },
  /** Set the active tab's address text (what the inline editor shows). */
  setAddress(address: string): void {
    updateTab(activeTab().id, { address })
  },
  /** Record a committed navigation on one tab (keeps the tab record in sync). */
  setCurrent(id: number, current: string): void {
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    updateTab(id, { current, address: current || tab.address })
  },
  /** Record a title reported by one tab's surface. */
  setTitle(id: number, title: string): void {
    updateTab(id, { title })
  },

  // --- Rest of panel state ----------------------------------------------

  setInShell(inShell: boolean): void {
    if (state.inShell === inShell) return
    state = { ...state, inShell }
    emit()
  },
  setPicking(picking: boolean): void {
    if (state.picking === picking) return
    state = { ...state, picking }
    emit()
  },
  /** Show a transient toast under the toolbar; auto-clears after 4 s. */
  showToast(toast: string, ok?: boolean): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    toastTimer = setTimeout(dismissToast, 4000)
    if (state.toast?.text === toast) return
    state = { ...state, toast: { text: toast, ok: ok === true } }
    emit()
  },
  clearToast(): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    dismissToast()
  },
  /** Queue one command for the active tab while its surface is unmounted; the
   * view that renders the surface consumes it on first bind. */
  setPendingCommand(pending: { op: string; url: string } | null): void {
    if (state.pending === pending) return
    state = { ...state, pending }
    emit()
  },
  /** Read-and-clear the queued command, if any. */
  takePendingCommand(): { op: string; url: string } | null {
    if (!state.pending) return null
    const pending = state.pending
    state = { ...state, pending: null }
    emit()
    return pending
  },
  /** Bind one tab's page-surface element (webview in the shell). */
  setSurface(tabId: number, el: PageSurfaceElement | null): void {
    if (el) surfaces.set(tabId, el)
    else surfaces.delete(tabId)
  },
  /** The active tab's surface: what the shell controller and pick flow drive. */
  getSurface(): PageSurfaceElement | null {
    return surfaces.get(activeTab().id) ?? null
  },
}

/** Cap on page text returned by the `content` op, so a huge page cannot
 * flood the agent's context. */
const CONTENT_TEXT_LIMIT = 50_000

/**
 * Consumer-registered "open the browser" behavior, called by the controller
 * whenever a command opens the browser (navigate). The floating panel shows
 * itself through `setOpen(true)`; an in-session view (dsh-sidebar-live)
 * registers a handler that switches its conversation view instead. This keeps
 * one controller while letting each view decide what "open" means.
 */
let openHandler: (() => void) | null = null

/**
 * Set (or clear) the consumer's open behavior.
 * @param handler - the view's open behavior, or null to clear.
 */
export function setOpenHandler(handler: (() => void) | null): void {
  openHandler = handler
}

/**
 * The global controller the Desktop shell drives via executeJavaScript
 * (desktop/main.cjs forwards `/browser/command` here). Commands always apply
 * to the active tab. Every method returns a JSON value the shell relays back
 * to the harness host half verbatim.
 */
export const pageBrowserController = {
  async command(payload: { op?: string; url?: string; script?: string; id?: number | string }): Promise<unknown> {
    const el = browserStore.getSurface()
    switch (payload.op) {
      // Tab bookkeeping works even without a mounted surface.
      case 'tab-list': {
        const { tabs, activeTabId } = browserStore.get()
        return {
          ok: true,
          tabs: tabs.map((t) => ({ id: t.id, url: t.current, title: t.title, active: t.id === activeTabId })),
        }
      }
      case 'tab-new': {
        const id = browserStore.addTab()
        return { ok: true, id }
      }
      case 'tab-close': {
        const id = Number(payload.id)
        if (!browserStore.get().tabs.some((t) => t.id === id)) {
          return { ok: false, error: `no such tab: ${String(payload.id)}` }
        }
        browserStore.closeTab(id)
        return { ok: true }
      }
      case 'tab-activate': {
        const id = Number(payload.id)
        if (!browserStore.get().tabs.some((t) => t.id === id)) {
          return { ok: false, error: `no such tab: ${String(payload.id)}` }
        }
        browserStore.activateTab(id)
        return { ok: true, id }
      }
    }
    // Navigate works WITHOUT a mounted surface: it opens the browser
    // (openHandler) and, when the active tab's surface is not mounted yet (a
    // lazy in-session view renders it on its next mount), queues the command
    // for the view to consume on first bind.
    if (payload.op === 'navigate') {
      const url = String(payload.url || '')
      if (!url) return { ok: false, error: 'navigate requires a url' }
      browserStore.setOpen(true)
      if (openHandler) openHandler()
      const surface = browserStore.getSurface()
      if (!surface) {
        browserStore.setPendingCommand({ op: 'navigate', url })
        return { ok: true, url, title: '', pending: true }
      }
      if (surface.loadURL) {
        try {
          await surface.loadURL(url)
        }
        catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      else {
        surface.setAttribute('src', url)
      }
      browserStore.setAddress(url)
      return { ok: true, url, title: surface.getTitle?.() ?? '' }
    }
    if (!el) return { ok: false, error: 'browser panel not mounted' }
    switch (payload.op) {
      case 'back':
        el.goBack?.()
        return { ok: true, url: el.getURL?.() ?? '', title: el.getTitle?.() ?? '' }
      case 'forward':
        el.goForward?.()
        return { ok: true, url: el.getURL?.() ?? '', title: el.getTitle?.() ?? '' }
      case 'reload':
        el.reload?.()
        return { ok: true }
      case 'stop':
        el.stop?.()
        return { ok: true }
      case 'eval': {
        const script = String(payload.script || '')
        if (!el.executeJavaScript) {
          return { ok: false, error: 'executeJavaScript unavailable outside the Electron shell' }
        }
        try {
          const result = await el.executeJavaScript(script, true)
          return { ok: true, result: result === undefined ? null : result }
        }
        catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      case 'content': {
        if (!el.executeJavaScript) {
          return { ok: false, error: 'executeJavaScript unavailable outside the Electron shell' }
        }
        try {
          const text = await el.executeJavaScript(
            'document.body ? document.body.innerText : ""', true,
          )
          const full = typeof text === 'string' ? text : ''
          return {
            ok: true,
            url: el.getURL?.() ?? '',
            title: el.getTitle?.() ?? '',
            text: full.slice(0, CONTENT_TEXT_LIMIT),
            truncated: full.length > CONTENT_TEXT_LIMIT,
          }
        }
        catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      case 'screenshot': {
        // The actual capture happens in the shell's main process
        // (webContents.capturePage); we just hand over the guest id.
        const id = el.getWebContentsId?.()
        if (!id) return { ok: false, error: 'webContents id unavailable outside the Electron shell' }
        return { ok: true, webContentsId: id }
      }
      default:
        return { ok: false, error: `unknown browser command: ${payload.op}` }
    }
  },
}
