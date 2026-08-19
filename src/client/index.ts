/**
 * dsh-builtin-browser browser half: registers two additive slots that make up
 * the built-in browser UI:
 *
 *  - `sidebar.footer.action` (id `builtin-browser`): a small action beside
 *    Settings that toggles the browser panel open/closed.
 *  - `shell.overlay` (id `builtin-browser`): the floating browser panel
 *    itself — address bar, navigation buttons, and the page surface
 *    (`<webview>` inside the Electron Desktop shell, `<iframe>` otherwise).
 *
 * The two entries share one tiny external store (./store.ts) instead of a
 * context provider, because they render in different slots.
 *
 * Export discipline (packages/client/AGENTS.md): only `apply`/`inject` are
 * exported; the components and their props stay internal.
 *
 * @module dsh-builtin-browser/client
 */

// Type-only: pulls the slots shell's SlotMap merge (the 'sidebar.footer.action'
// and 'shell.overlay' entries are declared by ui-sidebar and ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BrowserPanel } from './BrowserPanel.js'
import { BrowserToggle } from './BrowserToggle.js'
import { mountPickFlow, setupPickFlow } from './pick-flow.js'
import { browserStore, pageBrowserController } from './store.js'

/** Required services (cordis fiber inject): the slots registry. */
export const inject = ['slots']

/** Window slot the shell's executeJavaScript targets. */
const CONTROLLER_KEY = '__dshBrowser'

/**
 * Defensive slash-command guard. Selector prompts always start with `Page:`, so
 * this never fires in practice, but a leading `/` would otherwise be parsed as a
 * dsh slash command. A zero-width first line keeps the text out of that branch.
 * @param text - the prompt text to guard.
 */
function guardSlash(text: string): string {
  return text.startsWith('/') ? `\u200B\n${text}` : text
}

/**
 * Queue one prompt text into the current session. Resolves the sessions service
 * lazily (at send time, not apply time) and throws a user-facing message on the
 * "no active session" and RPC-failure paths for the pick flow's toast.
 * @param ctx - the browser plugin context.
 * @param text - the prompt text (Selector format, `Page:`-led).
 */
async function sendToSession(ctx: ClientContext, text: string): Promise<void> {
  const sessions = ctx.get('sessions')
  if (!sessions) throw new Error('会话服务不可用')
  const current = sessions.list.getSnapshot().current
  if (current === undefined) throw new Error('没有活跃会话，请先新建会话')
  const session = sessions.binding(current)?.session
  if (!session) throw new Error('没有活跃会话，请先新建会话')
  const result = await session.prompt([{ type: 'text', text: guardSlash(text) }], 'queue')
  if (!result.ok) throw new Error(result.error.message)
}

/**
 * Mount the built-in browser UI.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  // Detect the Electron shell: the shell's preload (desktop/preload.js)
  // exposes `window.desktopBridge`, which also carries the control port the
  // host half needs. Nothing here requires it — outside a shell the panel
  // degrades to an iframe.
  const desktopBridge = (globalThis as { desktopBridge?: { browserPort?: number } }).desktopBridge
  if (desktopBridge?.browserPort) {
    browserStore.setInShell(true)
  }

  // Wire the element-picking flow: the send callback resolves `sessions` lazily,
  // and the mount keeps picking in sync with the panel's open state.
  setupPickFlow({ sendPrompt: (text) => sendToSession(ctx, text) })
  mountPickFlow()

  // Publish the page-side controller the Desktop shell drives via
  // executeJavaScript (desktop/main.cjs). Owned by this fiber: removed when
  // the plugin stops or updates, so stale pages never answer commands.
  const win = globalThis as { [CONTROLLER_KEY]?: unknown }
  win[CONTROLLER_KEY] = pageBrowserController
  ctx.effect(() => () => {
    if (win[CONTROLLER_KEY] === pageBrowserController) {
      delete win[CONTROLLER_KEY]
    }
  })

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'builtin-browser', order: 10, label: () => browserStore.get().open ? '关闭浏览器' : '内置浏览器' },
    BrowserToggle,
  ))

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'builtin-browser', order: 10, label: () => '内置浏览器' },
    BrowserPanel,
  ))
}
