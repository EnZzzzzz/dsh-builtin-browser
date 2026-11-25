/**
 * Element-picking orchestration: inject the vendored Selector editor into the
 * active tab's page surface, poll the guest outbox for a prompt, send it to
 * the tab's Session, then tear the editor down.
 *
 * Injection and polling differ by surface type:
 *  - an Electron `<webview>` is scripted with `executeJavaScript` (works
 *    cross-origin — the guest is a real Chromium page);
 *  - a same-origin `<iframe>` gets the same program via a `<script>` element
 *    (cross-origin frames are opaque and show a toast).
 *
 * The sidebar tab body owns the toolbar and passes its own store, copy, and
 * content key here; this module owns the injection, polling, and send
 * lifecycle. The `sendPrompt` callback is wired by `src/client/index.ts` at
 * apply time so the sessions service resolves at send time, not at apply time.
 *
 * @module dsh-builtin-browser/client/pick-flow
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { buildInjectionCode, buildPollExpression, DESTROY_EXPRESSION, OUTBOX_KEY } from './picker-script.js'
import type { BrowserStore, PageSurfaceElement } from './store.js'

/** Lazily-resolved send callback: queues a prompt into one Session. */
export type SendPrompt = (sessionId: SessionId, text: string) => Promise<void>

/** Copy the pick flow needs from the tab's locale namespace. */
export interface PickFlowCopy {
  pickSent: () => string
  pickNotReady: () => string
  pickCrossOrigin: () => string
}

const POLL_INTERVAL_MS = 500

let sendPrompt: SendPrompt | undefined
let pollTimer: ReturnType<typeof setInterval> | null = null
let sending = false
let polling: BrowserStore | null = null
/** The internal tab picking was armed on, so teardown targets THAT page even
 * after the user switched tabs (picking is disarmed on switch, but the injected
 * editor still lives in the guest until we remove it). */
let pollingTabId: number | null = null

/** Wire the send callback (called once from ./index.ts at apply). */
export function setupPickFlow(handle: { sendPrompt: SendPrompt }): void {
  sendPrompt = handle.sendPrompt
}

/**
 * Run `script` in a tab's guest: webview via executeJavaScript (no same-origin
 * restriction), iframe via a `<script>` element (the browser blocks
 * cross-origin iframe access, so opaque frames throw).
 * @param surface - the tab's page-surface element.
 * @param script - the program to run in the guest.
 * @param userGesture - pass through to webview.executeJavaScript.
 */
async function runInGuest(surface: PageSurfaceElement, script: string, userGesture: boolean): Promise<void> {
  if (surface.executeJavaScript) {
    await surface.executeJavaScript(script, userGesture)
    return
  }
  const doc = (surface as HTMLIFrameElement).contentDocument
  if (!doc) throw new Error('cross-origin')
  const el = doc.createElement('script')
  el.textContent = script
  ;(doc.head || doc.documentElement).appendChild(el)
  el.remove()
}

/** Read the outbox directly from a same-origin iframe; null when opaque. */
function pollFrame(surface: PageSurfaceElement): { text: string | null; present: boolean } | null {
  try {
    const win = (surface as HTMLIFrameElement).contentWindow
    if (!win || !win.document) return null
    const text = win[OUTBOX_KEY as keyof Window] as unknown as string | undefined
    ;(win as unknown as Record<string, unknown>)[OUTBOX_KEY] = null
    return {
      text: typeof text === 'string' ? text : null,
      present: !!win.document.querySelector('.ai-editor-root'),
    }
  }
  catch {
    return null
  }
}

/** Tear the editor down and leave picking mode (silent, no toast). */
export async function stopPicking(): Promise<void> {
  stopPoll()
  const store = polling
  const tabId = pollingTabId
  polling = null
  pollingTabId = null
  if (store !== null) store.setPicking(false)
  const surface = store === null || tabId === null ? null : store.surfaceOf(tabId)
  if (surface === null) return
  try {
    if (surface.executeJavaScript) {
      await surface.executeJavaScript(DESTROY_EXPRESSION, false)
    }
    else {
      const win = (surface as HTMLIFrameElement).contentWindow
      if (win) {
        const guest = win as unknown as Record<string, unknown>
        if (typeof guest.__SELECTOR_DESTROY__ === 'function') (guest.__SELECTOR_DESTROY__ as () => void)()
        const style = win.document?.getElementById('__dsh_selector_style')
        if (style !== undefined && style !== null) style.remove()
      }
    }
  }
  catch {
    // Guest already navigated away or was destroyed; nothing to tear down.
  }
}

/**
 * The ⌖ button handler: arm picking on the browser's active internal tab, or
 * disarm it.
 * @param options - the browser store, its Session, the active internal tab, and copy.
 */
export function togglePicking(options: {
  store: BrowserStore
  sessionId: SessionId
  tabId: number
  copy: PickFlowCopy
}): void {
  const { store, sessionId, tabId, copy } = options
  if (store.getSnapshot().picking) {
    void stopPicking()
    return
  }
  const surface = store.surfaceOf(tabId)
  if (surface === null) {
    // Never fail silently: a toolbar click must always answer.
    store.showToast(copy.pickNotReady())
    return
  }
  void startPicking({ store, sessionId, tabId, copy, surface })
}

async function startPicking(context: PickContext & { surface: PageSurfaceElement }): Promise<void> {
  const { store, tabId, copy, surface } = context
  try {
    await runInGuest(surface, buildInjectionCode(tabId), true)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // `runInGuest` reports a blocked cross-origin frame with this sentinel.
    store.showToast(message === 'cross-origin' ? copy.pickCrossOrigin() : message)
    return
  }
  polling = store
  pollingTabId = tabId
  store.setPicking(true)
  startPoll(context)
}

/** What one picking session needs: the browser, its Session, its tab, and copy. */
interface PickContext {
  store: BrowserStore
  sessionId: SessionId
  tabId: number
  copy: PickFlowCopy
}

function startPoll(context: PickContext): void {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    void pollTick(context)
  }, POLL_INTERVAL_MS)
}

function stopPoll(): void {
  if (pollTimer === null) return
  clearInterval(pollTimer)
  pollTimer = null
}

async function pollTick(context: PickContext): Promise<void> {
  const { store, tabId } = context
  if (sending || !store.getSnapshot().picking) return
  const surface = store.surfaceOf(tabId)
  // The tab must still be the browser's active one: switching away ends picking.
  if (surface === null || polling !== store || store.getSnapshot().activeTabId !== tabId) {
    void stopPicking()
    return
  }
  let polled: { text?: string | null; present?: boolean } | null | undefined
  if (surface.executeJavaScript) {
    try {
      polled = await surface.executeJavaScript(buildPollExpression(), false) as { text?: string | null; present?: boolean } | null | undefined
    }
    catch {
      // Guest destroyed mid-navigation (manual nav while picking).
      void stopPicking()
      return
    }
  }
  else {
    polled = pollFrame(surface)
    if (polled === null) {
      void stopPicking()
      return
    }
  }
  if (polled !== null && polled !== undefined && typeof polled.text === 'string' && polled.text.length > 0) {
    await handleOutbox(context, polled.text)
    return
  }
  if (polled !== null && polled !== undefined && polled.present === false) {
    // The editor vanished without our teardown: the user closed it via its ✕ or
    // a real navigation replaced the document. Exit silently.
    void stopPicking()
  }
}

async function handleOutbox(context: PickContext, text: string): Promise<void> {
  const { store, sessionId, copy } = context
  sending = true
  try {
    if (sendPrompt === undefined) throw new Error('picker send unavailable')
    await sendPrompt(sessionId, text)
    // Success: tear the editor down and confirm in the toolbar. The sidebar tab
    // stays where it is, so the user watches the message land beside the page.
    await stopPicking()
    store.showToast(copy.pickSent(), true)
  }
  catch (err) {
    // Failure (no active session / RPC error): keep the editor, show the toast.
    store.showToast(err instanceof Error ? err.message : String(err))
  }
  finally {
    sending = false
  }
}
