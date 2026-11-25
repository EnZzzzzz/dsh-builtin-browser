/**
 * The built-in browser as a right-Sidebar tab TYPE: stage one of the two-stage
 * registration ui-sidebar-right defines — what the type is, what the guide page
 * offers for it, and how its chip is titled.
 *
 * `multiple: true` because a browser tag is a page, not a singleton view: every
 * guide pick or shortcut press opens another independent instance, which is what
 * the old floating panel's own tab strip used to provide.
 *
 * `keepMounted: true` so each tab keeps its webview (and with it the page's
 * scroll position, form state, and Chromium history) while the user switches
 * tabs, collapses the sidebar, or floats the tab — the shipped Browser type
 * keeps its Desktop guests mounted for the same reason.
 *
 * @module dsh-builtin-browser/client/definition
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { BuiltinBrowserKey } from './locales.js'
import { IconGlobe } from './icons.js'

/** The tab kind this package owns. */
export const BROWSER_KIND = 'builtin-browser'

/** This implementation's identity in the tab system, and the key its body and title register under. */
export const BROWSER_ID = 'dsh-builtin-browser'

/** The shortcut that opens one more browser tab. */
export const NEW_TAB_COMMAND = 'builtinBrowser.new' as ShortcutCommandId

/**
 * Build the tab type's registry definition.
 * @param t - the package's namespace-bound translate, read fresh on every label
 *   so the chip and the guide follow a language switch without re-registering.
 * @returns the definition to register through `ctx.sidebarRightTabs`.
 */
export function browserDefinition(t: TranslateNS<'builtinBrowser'>): SidebarRightTabDefinition {
  const copy = (key: BuiltinBrowserKey) => () => t(key)
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    multiple: true,
    keepMounted: true,
    // A page type joins no address ranking; it is opened by kind.
    priority: 'builtin',
    title: copy('type.label'),
    guide: [{
      id: 'new',
      commandId: NEW_TAB_COMMAND,
      order: 20,
      title: copy('guide.title'),
      description: copy('guide.description'),
      icon: IconGlobe,
    }],
  }
}
