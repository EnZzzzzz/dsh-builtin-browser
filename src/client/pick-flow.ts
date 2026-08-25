/**
 * Element-picking orchestration: inject the vendored Selector editor into the
 * active tab's page surface, poll the guest outbox for a prompt, send it to
 * the current session, then tear the editor down.
 *
 * Injection and polling differ by surface type:
 *  - an Electron `<webview>` is scripted with `executeJavaScript` (works
 *    cross-origin — the guest is a real Chromium page);
 *  - a same-origin `<iframe>` gets the same program via a `<script>` element
 *    (cross-origin frames are opaque and show a toast).
 *
 * React components only read `browserStore` state; this module owns the
 * injection, polling, and send lifecycle. The lazy `sendPrompt` callback is
 * wired in by ./index.ts at apply time so the sessions service resolves at
 * send time rather than at apply time. This is the shared engine behind every
 * browser view (floating panel, in-session view), so it must not depend on
 * which view renders the surface.
 *
 * @module dsh-builtin-browser/client/pick-flow
 */

import { buildInjectionCode, buildPollExpression, DESTROY_EXPRESSION, OUTBOX_KEY } from './picker-script.js'
import { browserStore, type PageSurfaceElement } from './store.js'

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

/** Subscribe once to keep picking in sync with the browser's open state. */
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

/**
 * Run `script` in the active tab's guest: webview via executeJavaScript (no
 * same-origin restriction), iframe via a `<script>` element (the browser
 * blocks cross-origin iframe access, so opaque frames throw).
 * @param surface - the active tab's page-surface element.
 * @param script - the program to run in the guest.
 * @param userGesture - pass through to webview.executeJavaScript.
 */
async function runInGuest(surface: PageSurfaceElement, script: string, userGesture: boolean): Promise<void> {
  if (surface.executeJavaScript) {
    await surface.executeJavaScript(script, userGesture)
    return
  }
  const doc = (surface as HTMLIFrameElement).contentDocument
  if (!doc) throw new Error('浏览器安全策略禁止标注跨域页面（iframe 模式）；请使用 dsh-desktop 桌面端，或导航到同源页面')
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
  } catch {
    return null
  }
}

/** Tear the editor down and leave picking mode (silent, no toast). */
export async function stopPicking(): Promise<void> {
  stopPoll()
  browserStore.setPicking(false)
  const surface = browserStore.getSurface()
  if (!surface) return
  try {
    if (surface.executeJavaScript) {
      await surface.executeJavaScript(DESTROY_EXPRESSION, false)
    } else {
      const win = (surface as HTMLIFrameElement).contentWindow
      if (win) {
        const guest = win as unknown as Record<string, unknown>
        if (typeof guest.__SELECTOR_DESTROY__ === 'function') (guest.__SELECTOR_DESTROY__ as () => void)()
        const style = win.document?.getElementById('__dsh_selector_style')
        if (style) style.remove()
      }
    }
  } catch {
    // Guest already navigated away or was destroyed; nothing to tear down.
  }
}

async function startPicking(): Promise<void> {
  const surface = browserStore.getSurface()
  if (!surface) return
  try {
    await runInGuest(surface, buildInjectionCode(browserStore.get().activeTabId), true)
  } catch (err) {
    browserStore.showToast(err instanceof Error ? err.message : String(err))
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
  const surface = browserStore.getSurface()
  if (!surface) {
    void stopPicking()
    return
  }
  let polled: { text?: string | null; present?: boolean } | null | undefined
  if (surface.executeJavaScript) {
    try {
      polled = await surface.executeJavaScript(buildPollExpression(), false) as { text?: string | null; present?: boolean } | null | undefined
    } catch {
      // Guest destroyed mid-navigation (manual nav while picking).
      void stopPicking()
      return
    }
  } else {
    polled = pollFrame(surface)
    if (polled === null) {
      void stopPicking()
      return
    }
  }
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
    // Success: tear the editor down and confirm. The floating panel also
    // closes so the user sees the message land in the session; an in-session
    // view keeps its (view-ring) visibility and just shows the toast.
    await stopPicking()
    browserStore.showToast('标注已发送给助手', true)
    browserStore.setOpen(false)
  } catch (err) {
    // Failure (no active session / RPC error): keep the editor, show the red
    // toast under the toolbar.
    browserStore.showToast(err instanceof Error ? err.message : String(err))
  } finally {
    sending = false
  }
}
