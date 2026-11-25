/**
 * The tab chip: a globe before the type's label.
 *
 * Registered under `sidebar.right.pane.tab.title` under the same key as the
 * body. Without it the chip would show the title the registry captured when the
 * tab opened; with it the strip follows the active language and carries the
 * package's own glyph, so a browser tab never looks like a text-only tab.
 *
 * @module dsh-builtin-browser/client/BrowserTitle
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconGlobe } from './icons.js'

/** Runtime props of a tab title entry. */
export type BrowserTitleProps =
  & PropsRuntime<'sidebar.right.pane.tab.title'>
  & PropsLocale<'builtinBrowser'>

/**
 * Globe plus localized label.
 * @param props - the locale seat supplies the label.
 */
export function BrowserTitle(props: BrowserTitleProps): ReactNode {
  const label = props.t('type.label')
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <IconGlobe size={13} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  )
}
