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
  /** Transient error toast shown under the toolbar; auto-clears. */
  toast: string | null
}

/** Blank page the surface loads until the user or agent navigates. */
export const BLANK_PAGE = 'about:blank'

/** The page-surface element (Electron webview or iframe) the panel owns. */
interface PageSurfaceElement extends HTMLElement {
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
  showToast(toast: string): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    toastTimer = setTimeout(dismissToast, 4000)
    if (state.toast === toast) return
    state = { ...state, toast }
    emit()
  },
  clearToast(): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    dismissToast()
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

/**
 * The global controller the Desktop shell drives via executeJavaScript
 * (desktop/main.cjs forwards `/browser/command` here). Commands always apply
 * to the active tab. Every method returns a JSON value the shell relays back
 * to the harness host half verbatim.
 */
export const pageBrowserController = {
  async command(payload: { op?: string; url?: string; script?: string }): Promise<unknown> {
    const el = browserStore.getSurface()
    if (!el) return { ok: false, error: 'browser panel not mounted' }
    switch (payload.op) {
      case 'navigate': {
        const url = String(payload.url || '')
        if (!url) return { ok: false, error: 'navigate requires a url' }
        if (el.loadURL) {
          try {
            await el.loadURL(url)
          }
          catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }
        else {
          el.setAttribute('src', url)
        }
        browserStore.setAddress(url)
        return { ok: true, url, title: el.getTitle?.() ?? '' }
      }
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
      default:
        return { ok: false, error: `unknown browser command: ${payload.op}` }
    }
  },
}
