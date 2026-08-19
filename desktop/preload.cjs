/**
 * Electron preload for the DSH built-in browser shell.
 *
 * Exposes a minimal, frozen `window.desktopBridge` to the harness web GUI so
 * the page can tell it is inside the shell and learn the control endpoint
 * port. No Node capabilities leak into the page: only the port number (and
 * this shell's marker) cross the context bridge.
 *
 * The browser controller itself (`window.__dshBrowser`) is registered by the
 * builtin-browser Client half, NOT here — this file only tells the page that
 * the shell exists.
 *
 * @module dsh-builtin-browser/desktop/preload
 */

const { contextBridge } = require('electron')

const desktopBridge = Object.freeze({
  /** Marker: the page is running inside the Desktop shell with webview support. */
  isDesktopShell: true,
  /** Loopback control endpoint port, when the main process has started it. */
  browserPort: Number(process.env.DSH_DESKTOP_BROWSER_PORT) || null,
})

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
