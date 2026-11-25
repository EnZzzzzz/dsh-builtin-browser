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
import type { BrowserPageStore, PageSurfaceElement } from './store.js'

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
let polling: BrowserPageStore | null = null

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
  const page = polling
  polling = null
  if (page !== null) page.setPicking(false)
  const surface = page?.getSurface() ?? null
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
 * The ⌖ button handler of one tab: arm picking in that tab, or disarm it.
 * @param options - the tab's store, its Session, its content key, and copy.
 */
export function togglePicking(options: {
  page: BrowserPageStore
  sessionId: SessionId
  contentKey: string
  copy: PickFlowCopy
}): void {
  const { page, sessionId, contentKey, copy } = options
  if (page.getSnapshot().picking) {
    void stopPicking()
    return
  }
  const surface = page.getSurface()
  if (surface === null) {
    // Never fail silently: a toolbar click must always answer.
    page.showToast(copy.pickNotReady())
    return
  }
  void startPicking({ page, sessionId, contentKey, copy, surface })
}

async function startPicking(context: {
  page: BrowserPageStore
  sessionId: SessionId
  contentKey: string
  copy: PickFlowCopy
  surface: PageSurfaceElement
}): Promise<void> {
  const { page, contentKey, copy, surface } = context
  try {
    await runInGuest(surface, buildInjectionCode(contentKey), true)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // `runInGuest` reports a blocked cross-origin frame with this sentinel.
    page.showToast(message === 'cross-origin' ? copy.pickCrossOrigin() : message)
    return
  }
  polling = page
  page.setPicking(true)
  startPoll(context)
}

function startPoll(context: {
  page: BrowserPageStore
  sessionId: SessionId
  copy: PickFlowCopy
}): void {
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

async function pollTick(context: { page: BrowserPageStore; sessionId: SessionId; copy: PickFlowCopy }): Promise<void> {
  const { page, sessionId, copy } = context
  if (sending || !page.getSnapshot().picking) return
  const surface = page.getSurface()
  if (surface === null || polling !== page) {
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

async function handleOutbox(
  context: { page: BrowserPageStore; sessionId: SessionId; copy: PickFlowCopy },
  text: string,
): Promise<void> {
  const { page, sessionId, copy } = context
  sending = true
  try {
    if (sendPrompt === undefined) throw new Error('picker send unavailable')
    await sendPrompt(sessionId, text)
    // Success: tear the editor down and confirm in the toolbar. The sidebar tab
    // stays where it is, so the user watches the message land beside the page.
    await stopPicking()
    page.showToast(copy.pickSent(), true)
  }
  catch (err) {
    // Failure (no active session / RPC error): keep the editor, show the toast.
    page.showToast(err instanceof Error ? err.message : String(err))
  }
  finally {
    sending = false
  }
}
