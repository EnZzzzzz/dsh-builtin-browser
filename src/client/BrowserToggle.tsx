/**
 * Sidebar-foot toggle for the built-in browser, registered into the
 * `sidebar.footer.action` slot: one small action beside Settings that opens or
 * closes the floating browser panel.
 *
 * @module dsh-builtin-browser/client/BrowserToggle
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserStore } from './store.js'

/**
 * Runtime props of the sidebar.footer.action entry: the owner share (wide)
 * plus the global standard seat.
 */
export type BrowserToggleProps = PropsRuntime<'sidebar.footer.action'>

/**
 * The sidebar action button toggling the built-in browser panel.
 * @param props - the sidebar footer action owner share.
 */
export function BrowserToggle(props: BrowserToggleProps): ReactNode {
  const { wide } = props
  const [open, setOpen] = useState(browserStore.get().open)

  useEffect(() => browserStore.subscribe(() => setOpen(browserStore.get().open)), [])

  const label = open ? '关闭浏览器' : '内置浏览器'
  return (
    <button
      type="button"
      onClick={() => browserStore.toggle()}
      title={label}
      aria-label={label}
      aria-pressed={open}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        width: '100%',
        border: 'none',
        background: open ? 'rgba(127,127,127,0.18)' : 'transparent',
        cursor: 'pointer',
        padding: wide ? '6px 10px' : '6px',
        borderRadius: 8,
        color: 'inherit',
        fontSize: 14,
      }}
    >
      <span role="img" aria-hidden="true">🌐</span>
      {wide && <span>{label}</span>}
    </button>
  )
}
