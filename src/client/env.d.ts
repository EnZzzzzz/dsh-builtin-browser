/**
 * Ambient declarations this package adds on top of the shipped types.
 *
 * Two gaps, each closed without vendoring anything:
 *
 *  1. `ctx.sidebarRight` / `ctx.sidebarRightTabs` are declared by
 *     ui-sidebar-right's `./client` entry. That entry's declarations pull in the
 *     whole right Sidebar, so the narrow face those services expose is restated
 *     here for the calls this package makes.
 *  2. The `<webview>` tag React does not know is declared in `webview.d.ts`.
 *
 * The session standard kit (`sessionId`) is merged by
 * `@deepseek-ai/dsh-client-runtime/client` in a source checkout, but that package
 * is not published at this kernel's version; the one member this package reads is
 * therefore declared here, matching the runtime's own merge.
 *
 * @module dsh-builtin-browser/client/env
 */

// A module (not a script): the declarations below are module augmentations of
// the packages they name, and only an imported file merges into them.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Where an open lands; every field is optional (owner: ui-sidebar-right). */
export interface SidebarRightPlacement {
  readonly paneId?: string
  readonly preferNewPane?: boolean
  readonly replaceTab?: string
  readonly revealIfOpened?: boolean
}

// Session-scoped slot entries receive this kit from the framework (owner of the
// concrete merge: @deepseek-ai/dsh-client-runtime); a session-scoped sidebar tab
// always has a Session, so `sessionId` is required here.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** The framework-resolved Session id (owners never pass it). */
    sessionId: SessionId
  }
}

/** A captured page identity returned by `commandTarget` (owner: ui-sidebar-right). */
export interface SidebarRightTarget {
  readonly sessionId: SessionId
}

/** The Client half's context; the shipped Client packages spell it `ClientContext`. */
export type ClientContext = Context

/** What this package contributes to a tab body beyond the standard seats. */
export interface BrowserTabInjected {
  /** Open one more browser tab in the active docked pane. */
  readonly openAnotherTab: () => void
}

// The body's injected face is an extension point: declare ours so the slot
// framework types `props.openAnotherTab` on `sidebar.right.pane.tab`.
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabInjected extends BrowserTabInjected {}
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right-Sidebar navigation controller (the members this package calls). */
    readonly sidebarRight: {
      /** Open one page of a registered kind in the active docked pane, expanding the column. */
      openTab(kind: string, options?: SidebarRightPlacement & { readonly params?: unknown }): void
      /** Capture the pane and tab holding current focus, or the on-screen active pane. */
      commandTarget(element?: Element | null): SidebarRightTarget | undefined
    }
    /** Right-Sidebar tab-type registry (the member this package calls). */
    readonly sidebarRightTabs: {
      register(definition: import('@deepseek-ai/dsh-client-ui-sidebar-right/client').SidebarRightTabDefinition): () => void
    }
  }
}
