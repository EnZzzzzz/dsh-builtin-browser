/**
 * Build the browser client bundle for dsh-builtin-browser. Emits the closure
 * factory artifact the dsh client loader serves: window.__ModuleLoader__.load
 * stamps the package id, and platform modules (react, cordis, the client
 * shells) resolve through the injected require instead of being bundled.
 * Mirrors the harness repo's clientBundle preset for a single package.
 */

import type { UserConfig } from 'tsdown'

/** Platform modules the browser loader table already owns (external). */
const PLATFORM_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form', '@deepseek-ai/dsh-client-runtime/client',
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
  // Everything not in the loader module table inlines into the bundle; a
  // require() the table cannot answer would throw at runtime.
  noExternal: (id: string) => (PLATFORM_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-builtin-browser", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
