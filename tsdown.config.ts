/**
 * Build the browser client bundle for dsh-builtin-browser. Emits the factory
 * artifact the dsh Client loader serves: `window.__ModuleLoader__.load` stamps
 * the package id, and platform modules resolve through the injected `require`
 * instead of being bundled.
 *
 * `PLATFORM_EXTERNALS` is exactly the Web shell's static module table (see
 * dsh-web's `qJ()`): react, react-dom, cordis, zod, and the four Client
 * packages the shell seeds. A request outside it either names a boot-graph row
 * (a Harness Client plugin, which a type-only import never turns into a
 * request) or must be inlined, so keep this list in step with the kernel.
 */

import type { UserConfig } from 'tsdown'

/** The Web shell's static module table — the only modules a bundle may externalize. */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const config: UserConfig = {
  name: 'dsh-builtin-browser/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: PLATFORM_EXTERNALS,
  // Everything not in the shell's table inlines into the bundle; a require()
  // the table cannot answer throws at runtime, so nothing else may stay external.
  noExternal: (id: string) => (PLATFORM_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-builtin-browser", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
