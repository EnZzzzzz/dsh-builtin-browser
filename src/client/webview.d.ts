/**
 * The Electron `<webview>` tag, which JSX does not know.
 *
 * The tag renders only inside the Desktop shell (the shell must create its
 * window with `webviewTag: true`); elsewhere the body renders an iframe instead.
 * `@types/react` exposes its intrinsic-element registry in the `react` module
 * since React 18 types, so the declaration is added there.
 *
 * @module dsh-builtin-browser/client/webview
 */

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/** The subset of `<webview>` attributes this package sets. */
export interface WebviewAttributes extends HTMLAttributes<HTMLElement> {
  /** Standard Chrome UA the guest sends (the shell's own UA carries Electron). */
  useragent?: string
  /** Persistent session partition; keeps cookies and logins across restarts. */
  partition?: string
  /** Let the guest open new windows through its own handler. */
  allowpopups?: string
  /** Initial address; assigned imperatively once instead (see BrowserTab). */
  src?: string
  /** Preload script the guest runs before page scripts. */
  preload?: string
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- JSX.IntrinsicElements requires an interface
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<WebviewAttributes, HTMLElement> & { ref?: unknown }
    }
  }
}
