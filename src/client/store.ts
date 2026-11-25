/**
 * Built-in browser tab state: one small external store per sidebar browser
 * TAB, instead of the old single global multi-tab panel.
 *
 * The right Sidebar (ui-sidebar-right) is the tab strip now: it owns docking,
 * splitting, floating, and closing, and a tab type may declare `multiple: true`
 * so every open is an independent instance. This module therefore stores the
 * page of ONE tab — its address, the committed URL and title, and whether the
 * element-picking flow is armed — plus the two hooks the rest of the package
 * needs:
 *
 *  - `pageBrowserController` / `window.__dshBrowser`, the page-side controller
 *    the Desktop shell drives through `executeJavaScript`, which always targets
 *    the ACTIVE tab (the last tab that mounted or was activated);
 *  - a localStorage checkpoint per (Session, tab) so a reload or a collapsed
 *    sidebar does not lose the address, mirroring how the shipped Browser tab
 *    checkpoints its own page.
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

/** Failure text every command returns while no browser tab exists. */
const NO_TAB = 'no built-in browser tab is open; open the Built-in browser tab from the sidebar guide first'

/** One tab's page state. */
export interface BrowserPageState {
  /** The URL the user/agent last asked for (what the address bar shows). */
  address: string
  /** The URL the surface actually reports; empty until the first commit. */
  current: string
  /** Last page title reported by the surface; empty until the first load. */
  title: string
  /** The webview event bridge is attached and the guest lives in this shell. */
  inShell: boolean
  /** Element picking (the vendored Selector editor) is armed. */
  picking: boolean
  /** Transient notice under the toolbar; auto-clears. `ok` styles it. */
  toast: { text: string; ok: boolean } | null
}

/** The page-surface element (Electron webview or iframe) a tab owns. */
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

/** The public face of one tab's page store. */
export interface BrowserPageStore {
  /** Current immutable snapshot. */
  getSnapshot(): BrowserPageState
  /** Observe every change; returns the unsubscribe callback. */
  subscribe(listener: Listener): () => void
  setAddress(address: string): void
  setCurrent(current: string): void
  setTitle(title: string): void
  setPicking(picking: boolean): void
  /** Show a transient notice; auto-clears after 4 s. */
  showToast(text: string, ok?: boolean): void
  clearToast(): void
  /** Bind this tab's surface element (webview in the shell, iframe otherwise). */
  setSurface(el: PageSurfaceElement | null): void
  /** This tab's surface element, when mounted. */
  getSurface(): PageSurfaceElement | null
  /** Make this tab the one the shell controller and pick flow drive. */
  claim(): void
  /** Persist the page into its checkpoint slot (called when the tab opens or closes). */
  persist(): void
}

const EMPTY_STATE: BrowserPageState = {
  address: '',
  current: '',
  title: '',
  inShell: false,
  picking: false,
  toast: null,
}

/** Storage key prefix for the per-tab checkpoint. */
const STORAGE_PREFIX = 'dsh.builtin-browser.v1'

/** What a checkpoint remembers: the readable page, never the toast or picking. */
interface Checkpoint {
  address: string
  title: string
}

/** Read one checkpoint; a malformed or unavailable store reads as absent. */
function readCheckpoint(key: string | null): Checkpoint | null {
  if (key === null || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}.${key}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { address, title } = parsed as { address?: unknown; title?: unknown }
    return { address: typeof address === 'string' ? address : '', title: typeof title === 'string' ? title : '' }
  }
  catch {
    // A corrupt entry must not break the tab; the next persist replaces it.
    return null
  }
}

/**
 * The tab the shell controller and the pick flow drive. Every tab body reports
 * itself through `claim()` on mount, focus, and navigation, so the pointer
 * follows the tab the user is actually looking at.
 */
let activePage: BrowserPageStore | null = null

/**
 * Create the store for one sidebar browser tab.
 * @param options - owning Session and the tab's checkpoint key (its content
 *   address segment), which tells several tabs of one Session apart.
 * @returns the per-tab page store.
 */
/**
 * Create the store for one sidebar browser tab.
 * @param options - owning Session, the tab's checkpoint key (its content
 *   address, which tells several tabs of one Session apart), and whether the
 *   page runs inside the Desktop shell's webview.
 * @returns the per-tab page store.
 */
export function createBrowserPageStore(options: {
  sessionId: SessionId
  checkpointKey: string | null
  inShell: boolean
}): BrowserPageStore {
  const { checkpointKey, inShell } = options
  const checkpoint = readCheckpoint(checkpointKey)
  let state: BrowserPageState = {
    ...EMPTY_STATE,
    inShell,
    address: checkpoint?.address ?? '',
    title: checkpoint?.title ?? '',
  }
  let surface: PageSurfaceElement | null = null
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<Listener>()

  const emit = (): void => {
    listeners.forEach((listener) => listener())
  }

  const patch = (next: Partial<BrowserPageState>): void => {
    const keys = Object.keys(next) as (keyof BrowserPageState)[]
    if (keys.every((key) => state[key] === next[key])) return
    state = { ...state, ...next }
    emit()
  }

  const persist = (): void => {
    if (checkpointKey === null || typeof localStorage === 'undefined') return
    try {
      const key = `${STORAGE_PREFIX}.${checkpointKey}`
      if (state.address === '' && state.title === '') {
        localStorage.removeItem(key)
        return
      }
      const saved: Checkpoint = { address: state.address, title: state.title }
      localStorage.setItem(key, JSON.stringify(saved))
    }
    catch {
      // Storage full or disabled (private mode): the page loses its checkpoint.
    }
  }

  const store: BrowserPageStore = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setAddress(address) {
      patch({ address })
      persist()
    },
    setCurrent(current) {
      if (current === '' || current === BLANK_PAGE) return
      if (state.address !== current) {
        patch({ current, address: current })
        persist()
        return
      }
      patch({ current })
    },
    setTitle(title) {
      if (title === state.title) return
      patch({ title })
      persist()
    },
    setPicking(picking) {
      if (picking === state.picking) return
      patch({ picking })
      if (picking) store.claim()
    },
    showToast(text, ok) {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toastTimer = undefined
        if (state.toast !== null) patch({ toast: null })
      }, 4000)
      patch({ toast: { text, ok: ok === true } })
    },
    clearToast() {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      toastTimer = undefined
      patch({ toast: null })
    },
    setSurface(el) {
      surface = el
      if (el !== null) store.claim()
    },
    getSurface: () => surface,
    claim() {
      activePage = store
    },
    persist,
  }

  return store
}

/**
 * The active tab's page store, or null while no browser tab is open.
 * @returns the store the shell controller and the pick flow operate on.
 */
export function activeBrowserPage(): BrowserPageStore | null {
  return activePage
}

/** Dropped by the owning fiber so a stale page never answers shell commands. */
export function clearActiveBrowserPage(): void {
  activePage = null
}

/**
 * The global controller the Desktop shell drives via executeJavaScript
 * (desktop/main.cjs forwards `/browser/command` here). Commands always apply to
 * the active tab; every method returns a JSON value the shell relays back to
 * the harness host half verbatim.
 */
export const pageBrowserController = {
  async command(payload: { op?: string; url?: string; script?: string }): Promise<unknown> {
    const page = activePage
    const el = page?.getSurface() ?? null
    if (payload.op === 'navigate') {
      const url = String(payload.url || '')
      if (!url) return { ok: false, error: 'navigate requires a url' }
      if (page === null || el === null) return { ok: false, error: NO_TAB }
      page.setAddress(url)
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
      return { ok: true, url, title: el.getTitle?.() ?? '' }
    }
    if (page === null || el === null) return { ok: false, error: NO_TAB }
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
          return { ok: false, error: 'executeJavaScript unavailable outside the Desktop shell' }
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
          return { ok: false, error: 'executeJavaScript unavailable outside the Desktop shell' }
        }
        try {
          const text = await el.executeJavaScript('document.body ? document.body.innerText : ""', true)
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
        // The capture happens in the shell's main process
        // (webContents.capturePage); hand over the guest id.
        const id = el.getWebContentsId?.()
        if (!id) return { ok: false, error: 'webContents id unavailable outside the Desktop shell' }
        return { ok: true, webContentsId: id }
      }
      case 'tab-list':
        return { ok: true, tabs: [{ id: 0, url: el.getURL?.() ?? '', title: el.getTitle?.() ?? '', active: true }] }
      default:
        return { ok: false, error: `unknown browser command: ${payload.op}` }
    }
  },
}
