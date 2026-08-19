/**
 * Shared browser panel state: one tiny external store used by both the
 * sidebar toggle (sidebar.footer.action) and the floating panel
 * (shell.overlay). Kept outside React so two independently rendered slots
 * stay in sync without a context provider.
 *
 * @module dsh-builtin-browser/client/store
 */

type Listener = () => void

export interface BrowserPanelState {
  /** Whether the floating browser panel is visible. */
  open: boolean
  /** The URL currently shown in the address bar. */
  address: string
  /** The URL the webview actually finished navigating to. */
  current: string
  /** Whether the panel is running inside an Electron shell (webview available). */
  inShell: boolean
  /** Whether element picking (the vendored Selector editor) is active. */
  picking: boolean
  /** Transient error toast shown under the toolbar; auto-clears. */
  toast: string | null
}

const DEFAULT_ADDRESS = 'https://example.com'

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
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>
  /** Electron guest webContents id; the shell uses it for capturePage etc. */
  getWebContentsId?(): number
}

let surface: PageSurfaceElement | null = null

let state: BrowserPanelState = {
  open: false,
  address: DEFAULT_ADDRESS,
  current: '',
  inShell: false,
  picking: false,
  toast: null,
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((l) => l())
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
  setAddress(address: string): void {
    if (state.address === address) return
    state = { ...state, address }
    emit()
  },
  setCurrent(current: string): void {
    if (state.current === current) return
    state = { ...state, current, address: current || state.address }
    emit()
  },
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
  /** Bind the page-surface element the controller drives. */
  setSurface(el: PageSurfaceElement | null): void {
    surface = el
  },
  /** The currently bound page-surface element (webview in the shell). */
  getSurface(): PageSurfaceElement | null {
    return surface
  },
}

/**
 * The global controller the Desktop shell drives via executeJavaScript
 * (desktop/main.cjs forwards `/browser/command` here). Every method returns a
 * JSON value the shell relays back to the harness host half verbatim.
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
