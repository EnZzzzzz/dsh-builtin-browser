/**
 * Element-picking orchestration: inject the vendored Selector editor into the
 * panel's webview, poll the guest outbox for a prompt, send it to the current
 * session, then tear the editor down and close the panel.
 *
 * React components only read `browserStore` state; this module owns the
 * injection, polling, and send lifecycle. The lazy `sendPrompt` callback is
 * wired in by ./index.ts at apply time so the sessions service resolves at
 * send time rather than at apply time.
 *
 * @module dsh-builtin-browser/client/pick-flow
 */

import { buildInjectionCode, buildPollExpression, DESTROY_EXPRESSION } from './picker-script.js'
import { browserStore } from './store.js'

/** Lazily-resolved send callback: forwards a prompt to the current session. */
type SendPrompt = (text: string) => Promise<void>

const POLL_INTERVAL_MS = 500

let sendPrompt: SendPrompt | undefined
let pollTimer: ReturnType<typeof setInterval> | null = null
let sending = false
let unsubscribe: (() => void) | null = null

/** Wire the send callback (called once from ./index.ts at apply). */
export function setupPickFlow(handle: { sendPrompt: SendPrompt }): void {
  sendPrompt = handle.sendPrompt
}

/** Subscribe once to keep picking in sync with the panel's open state. */
export function mountPickFlow(): void {
  if (unsubscribe) return
  unsubscribe = browserStore.subscribe(() => {
    if (!browserStore.get().open && browserStore.get().picking) {
      void stopPicking()
    }
  })
}

/** The ⌖ button handler: toggle element-picking on/off. */
export function togglePicking(): void {
  if (browserStore.get().picking) {
    void stopPicking()
  } else {
    void startPicking()
  }
}

/** Tear the editor down and leave picking mode (silent, no toast). */
export async function stopPicking(): Promise<void> {
  stopPoll()
  browserStore.setPicking(false)
  const wv = browserStore.getSurface()
  if (wv?.executeJavaScript) {
    try {
      await wv.executeJavaScript(DESTROY_EXPRESSION, false)
    } catch {
      // Guest already navigated away or was destroyed; nothing to tear down.
    }
  }
}

async function startPicking(): Promise<void> {
  const wv = browserStore.getSurface()
  if (!wv?.executeJavaScript) return
  try {
    await wv.executeJavaScript(buildInjectionCode(), true)
  } catch {
    // Injection failed (e.g. mid-navigation); stay idle.
    return
  }
  browserStore.setPicking(true)
  startPoll()
}

function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void pollTick()
  }, POLL_INTERVAL_MS)
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pollTick(): Promise<void> {
  if (sending || !browserStore.get().picking) return
  const wv = browserStore.getSurface()
  if (!wv?.executeJavaScript) {
    void stopPicking()
    return
  }
  let result: unknown
  try {
    result = await wv.executeJavaScript(buildPollExpression(), false)
  } catch {
    // Guest destroyed mid-navigation (address-bar nav while picking).
    void stopPicking()
    return
  }
  const polled = result as { text?: string | null; present?: boolean } | null | undefined
  if (polled && typeof polled.text === 'string' && polled.text.length > 0) {
    await handleOutbox(polled.text)
    return
  }
  if (polled && polled.present === false) {
    // The editor vanished without our teardown: the user closed it via its ✕ or
    // a real navigation replaced the document. Exit silently.
    void stopPicking()
  }
}

async function handleOutbox(text: string): Promise<void> {
  sending = true
  try {
    if (!sendPrompt) throw new Error('picker send unavailable')
    await sendPrompt(text)
    // Success: tear the editor down and close the panel so the user sees the
    // message land in the session.
    await stopPicking()
    browserStore.setOpen(false)
  } catch (err) {
    // Failure (no active session / RPC error): keep the editor and panel, show
    // the red toast under the toolbar.
    browserStore.showToast(err instanceof Error ? err.message : String(err))
  } finally {
    sending = false
  }
}
