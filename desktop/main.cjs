/**
 * Electron main-process side of the DSH built-in browser.
 *
 * Responsibilities:
 *  1. Create the BrowserWindow that hosts the harness web GUI with
 *     `webviewTag: true`, so the built-in browser plugin can render a real
 *     Chromium `<webview>` element inside the page.
 *  2. Run a loopback HTTP control endpoint (`DSH_DESKTOP_BROWSER_PORT`) that
 *     the harness host half reaches through `ctx.web.fetch`. Each command is
 *     forwarded into the page via `executeJavaScript`, where the browser
 *     plugin's webview element performs the actual navigation.
 *  3. Inject `window.desktopBridge` through the preload so the page knows it
 *     is inside the shell and can report the control port.
 *
 * Integration: require this module from your existing Electron main entry
 * (or copy the pieces below). The harness web GUI URL is the one `dsh web`
 * serves — pass it as DSH_WEB_URL or edit DEFAULT_WEB_URL.
 *
 * Usage:
 *   const { createMainWindow, startBrowserEndpoint } = require('./main.cjs')
 *   app.whenReady().then(() => {
 *     startBrowserEndpoint(getMainWindow)   // before/after window creation
 *     createMainWindow()
 *   })
 *
 * @module dsh-builtin-browser/desktop/main
 */

const { app, BrowserWindow, webContents } = require('electron')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')

/** The harness web GUI this shell hosts. Override with DSH_WEB_URL. */
const WEB_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:50593'

/** Env var the harness host half reads for the control port. */
const CONTROL_PORT_ENV = 'DSH_DESKTOP_BROWSER_PORT'

/**
 * Keep a reference to the window that hosts the web GUI so the control
 * endpoint can reach the page. Assign it when the window is created.
 */
let mainWindow = null

/** @returns {Electron.BrowserWindow|null} the window hosting the harness web GUI. */
function getMainWindow() {
  return mainWindow
}

/** Create the harness web GUI window with webview support enabled. */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      // Required for the built-in browser's <webview> element.
      webviewTag: true,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false so the preload can read process.env (the control port);
      // the page itself still has no Node access (contextIsolation + no
      // nodeIntegration). Tighten if your shell does not need the preload env.
      sandbox: false,
    },
  })
  mainWindow.loadURL(WEB_URL)
  mainWindow.on('closed', () => { mainWindow = null })
  return mainWindow
}

/**
 * Forward one browser command into the page. The page-side controller
 * (`window.__dshBrowser`, registered by the builtin-browser Client half)
 * executes the actual webview operation and returns a JSON value, which is
 * relayed back verbatim.
 *
 * @param {string} op - command name (navigate, back, forward, reload, stop,
 *   eval, content, screenshot, tab-list, tab-new, tab-close, tab-activate).
 * @param {Record<string, unknown>} payload - command arguments.
 * @returns {Promise<unknown>} the JSON value the page returned.
 */
async function forwardToPage(op, payload) {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    throw new Error('harness window not available')
  }
  const script = `(async () => {
    const ctrl = window.__dshBrowser
    if (!ctrl || typeof ctrl.command !== 'function') {
      return { ok: false, error: 'browser controller not mounted (is the builtin-browser plugin running?)' }
    }
    try {
      const value = await ctrl.command(${JSON.stringify({ op, ...payload })})
      return value ?? { ok: true }
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) }
    }
  })()`
  return win.webContents.executeJavaScript(script, true)
}

/**
 * Capture the active browser tab. The page-side `screenshot` op returns the
 * guest's webContents id; the capture itself must run here in the main
 * process. The PNG is written to a temp file and the path is returned, so
 * the agent can read it back with its own file tools (a base64 payload would
 * be useless to a text model and huge in transit).
 *
 * @returns {Promise<unknown>} { ok, path, width, height } or an error value.
 */
async function captureActiveTab() {
  const reply = await forwardToPage('screenshot', {})
  if (!reply || reply.ok !== true || !reply.webContentsId) {
    return reply && reply.ok === false
      ? reply
      : { ok: false, error: 'browser panel did not report a webContents id' }
  }
  const guest = webContents.fromId(reply.webContentsId)
  if (!guest) return { ok: false, error: `no webContents with id ${reply.webContentsId}` }
  const image = await guest.capturePage()
  const size = image.getSize()
  const file = path.join(os.tmpdir(), `dsh-browser-screenshot-${Date.now()}.png`)
  await fs.writeFile(file, image.toPNG())
  return { ok: true, path: file, width: size.width, height: size.height }
}

/**
 * Start the loopback control endpoint the harness host half calls. Picks an
 * OS-assigned port, exports it through `CONTROL_PORT_ENV` (and app userData
 * for the preload), and starts serving `/browser/command`.
 *
 * @param {() => Electron.BrowserWindow|null} windowProvider - resolves the
 *   window hosting the web GUI; read at request time so ordering is flexible.
 * @returns {Promise<{ port: number, close: () => void }>}
 */
function startBrowserEndpoint(windowProvider = getMainWindow) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    if (url.pathname !== '/browser/command') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
      return
    }
    const op = url.searchParams.get('op') || ''
    const payload = {}
    for (const [key, value] of url.searchParams) {
      if (key !== 'op') payload[key] = value
    }
    try {
      const value = op === 'screenshot'
        ? await captureActiveTab()
        : await forwardToPage(op, payload)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }))
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      process.env[CONTROL_PORT_ENV] = String(port)
      console.log(`[builtin-browser] control endpoint on http://127.0.0.1:${port} (${CONTROL_PORT_ENV})`)
      resolve({
        port,
        close: () => server.close(),
      })
    })
  })
}

module.exports = { createMainWindow, startBrowserEndpoint, getMainWindow, CONTROL_PORT_ENV }
