/**
 * dsh-builtin-browser browser half: the built-in browser of a Desktop-wrapped
 * DeepSeek Harness, delivered as a NATIVE RIGHT-SIDEBAR TAB.
 *
 * Entry point (what replaced the old private floating panel):
 *  - the type registers through `ctx.sidebarRightTabs` (stage one: what it is,
 *     plus the guide capsule that opens it), and its body and title through the
 *     official `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats
 *     under this package's id (stage two);
 *  - the tab strip, docking, splitting, floating, and closing belong to
 *     ui-sidebar-right, so this package draws no tab list, no overlay, and no
 *     sidebar button of its own, and depends on neither `shell.overlay` nor the
 *     legacy `sidebar.footer.action` seat;
 *  - `window.__dshBrowser` (the page-side controller the Desktop shell drives
 *     through `executeJavaScript`) still exists for the host half's `browser_*`
 *     tools, but it now targets the browser tab that is on screen.
 *
 * @module dsh-builtin-browser/client
 */

import type { ClientContext } from './env.js'
// Type-only imports: they bring the SlotMap / LocaleNamespaceMap / standard-prop
// declarations into this program and are erased at build time, so they create
// no module request from the bundle.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BrowserTab } from './BrowserTab.js'
import { BrowserTitle } from './BrowserTitle.js'
import { BROWSER_KIND, browserDefinition, NEW_TAB_COMMAND } from './definition.js'
import type { BrowserTabInjected, SidebarRightTarget } from './env.js'
import { LOCALES, NS } from './locales.js'
import { setupPickFlow } from './pick-flow.js'
import { clearActiveBrowserStore, pageBrowserController, setBrowserOpenHandler } from './store.js'

/** Required services (cordis fiber inject): slots, the right Sidebar, and copy. */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale']

/** Window slot the Desktop shell's executeJavaScript targets. */
const CONTROLLER_KEY = '__dshBrowser'

/**
 * Defensive slash-command guard. Selector prompts always start with `##`, so
 * this never fires in practice, but a leading `/` would otherwise be parsed as a
 * dsh slash command. A zero-width first line keeps the text out of that branch.
 * @param text - the prompt text to guard.
 */
function guardSlash(text: string): string {
  return text.startsWith('/') ? `\u200B\n${text}` : text
}

/**
 * Wrap one prompt into the Session the browser tab belongs to. Resolves the
 * sessions service lazily (at send time, not apply time) and throws a
 * user-facing message for the pick flow's toast.
 * @param ctx - the browser plugin context.
 * @param sessionId - owning Session of the tab the annotation came from.
 * @param text - the prompt text (Selector's Design-Feedback markdown).
 * @param t - the package's translate seat, for the two failure messages.
 */
async function sendToSession(
  ctx: ClientContext,
  sessionId: SessionId,
  text: string,
  t: (key: import('./locales.js').BuiltinBrowserKey) => string,
): Promise<void> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null) throw new Error(t('pick.noSession'))
  const session = sessions.binding(sessionId)?.session
  if (!session) throw new Error(t('pick.sessionClosed'))
  const result = await session.prompt([{ type: 'text', text: guardSlash(text) }], 'queue')
  if (!result.ok) throw new Error(result.error.message)
}

/**
 * Build the `browser.new` command: one more browser tab beside the one in focus.
 * @param ctx - the browser plugin context.
 * @param label - localized command label, also the reason when nothing is open.
 * @returns the command definition to register.
 */
function newTabCommand(ctx: ClientContext, label: () => string): ShortcutCommand {
  return {
    id: NEW_TAB_COMMAND,
    label,
    aliases: ['browser', 'new browser tab'],
    defaults: {
      'desktop:macos': { code: 'KeyT', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyT', modifiers: ['primary', 'shift'] },
      'desktop:linux': { code: 'KeyT', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt', 'shift'] },
      'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt', 'shift'] },
    },
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: ({ target }) => {
      const captured: SidebarRightTarget | undefined = ctx.sidebarRight.commandTarget(target ?? null)
      if (captured === undefined) return { status: 'blocked', reason: label() }
      return {
        status: 'handled',
        run: () => {
          // ui-sidebar-right expands the column and places the page in the
          // active docked pane; each open is a new instance (multiple: true).
          ctx.sidebarRight.openTab(BROWSER_KIND)
        },
      }
    },
  }
}

/**
 * Mount the built-in browser tab type.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined || slots === null) return

  ctx.effect(() => ctx.locale.register(NS, LOCALES), 'builtin-browser: copy')
  const t = ctx.locale.bind(NS)

  // Element picking sends into the tab's own Session.
  setupPickFlow({ sendPrompt: (sessionId, text) => sendToSession(ctx, sessionId, text, t) })

  // Publish the page-side controller the Desktop shell drives via
  // executeJavaScript (desktop/main.cjs). Owned by this fiber, so a stopped or
  // updated plugin leaves no stale controller answering shell commands.
  const win = globalThis as { [CONTROLLER_KEY]?: unknown }
  win[CONTROLLER_KEY] = pageBrowserController
  ctx.effect(() => () => {
    if (win[CONTROLLER_KEY] === pageBrowserController) delete win[CONTROLLER_KEY]
    clearActiveBrowserStore()
  }, 'builtin-browser: controller')

  // Let a command with no browser on screen surface one, so an agent's first
  // navigate/tab-new does not fail just because the sidebar was closed.
  ctx.effect(() => {
    setBrowserOpenHandler(() => ctx.sidebarRight.openTab(BROWSER_KIND))
    return () => setBrowserOpenHandler(null)
  }, 'builtin-browser: open handler')

  // Stage one: the tab TYPE and its guide capsule.
  ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(t)), 'builtin-browser: type')

  // Tabs live INSIDE the browser, so the body needs no plugin-injected face:
  // the tab strip owns new/close/switch, and a link that would open a window
  // becomes one more internal tab. `browser.new` still opens ANOTHER BROWSER
  // (one more sidebar tab), which is a different thing from a page tab.
  const injected: BrowserTabInjected = {}

  // Stage two: the body, keyed by this implementation's id. The seat supplies
  // the standard props (`useTabInfo`, `sessionId`) and, through `locale`, the
  // `t` seat the component renders with.
  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
    { name: 'sidebar.right.pane.tab', key: 'dsh-builtin-browser', locale: NS, inject: () => injected },
    BrowserTab,
  )), 'builtin-browser: body')

  // The chip: a globe plus the localized type label, so the strip follows the
  // active language instead of a title captured when the tab opened.
  ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register(
    { name: 'sidebar.right.pane.tab.title', key: 'dsh-builtin-browser', locale: NS, inject: () => injected },
    BrowserTitle,
  )), 'builtin-browser: title')

  // `browser.new`: one more tab, next to the focused page.
  ctx.inject(['shortcuts'], (shortcutCtx) => {
    shortcutCtx.effect(
      () => shortcutCtx.shortcuts.register(newTabCommand(ctx, () => t('guide.title'))),
      'builtin-browser: new-tab shortcut',
    )
  })
}
