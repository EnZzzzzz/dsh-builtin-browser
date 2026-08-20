/**
 * Playground dev server: static file serving + watch-rebuild + auto-reload.
 *
 *   npm run playground
 *
 * Watches `src/client/` and `vendor/selector/`; on any change it re-runs the
 * selector asset assembly (vendor/selector/build.mjs) and the playground
 * bundle (tsdown), then tells every open page to reload over SSE. Editing
 * inline styles, TOOLBAR_CSS, or vendor/selector/editor.css therefore shows
 * up in the browser within ~a second of saving.
 *
 * @module playground/dev
 */

import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const distDir = join(here, 'dist')

const PORT = Number(process.env.PLAYGROUND_PORT) || 41770

/** Files written BY the build — watching them would loop forever. */
const GENERATED = new Set(['selector-assets.ts', 'editor.bundle.js'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
}

// ---------------------------------------------------------------------------
// Build pipeline: selector assets → playground bundle → notify pages.
// ---------------------------------------------------------------------------

const sseClients = new Set()

function broadcastReload() {
  for (const res of sseClients) res.write('data: reload\n\n')
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: root }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      if (err) reject(err)
      else resolve()
    })
  })
}

let building = false
let queued = false

async function build() {
  if (building) {
    queued = true
    return
  }
  building = true
  const started = Date.now()
  try {
    await run('node', ['vendor/selector/build.mjs'])
    await run('npx', ['tsdown', '--config', 'playground/tsdown.config.ts'])
    console.log(`[playground] rebuilt in ${Date.now() - started} ms`)
    broadcastReload()
  } catch {
    console.error('[playground] build failed (see above); page left as-is')
  } finally {
    building = false
    if (queued) {
      queued = false
      void build()
    }
  }
}

let debounce
for (const dir of ['src/client', 'vendor/selector', 'playground']) {
  watch(join(root, dir), { recursive: true }, (_event, filename) => {
    if (!filename || GENERATED.has(filename) || filename.startsWith('dist/')) return
    clearTimeout(debounce)
    debounce = setTimeout(() => void build(), 150)
  })
}

// ---------------------------------------------------------------------------
// Static server + SSE endpoint.
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.url === '/__playground_events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }
  const path = req.url === '/' ? '/index.html' : (req.url ?? '/index.html').split('?')[0]
  const file = path === '/index.html' ? join(here, 'index.html') : join(distDir, path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[playground] http://127.0.0.1:${PORT}`)
  void build()
})
