import type { UserConfig } from 'tsdown'

const config: UserConfig = {
  entry: { playground: './main.tsx' },
  outDir: './dist',
  format: 'esm',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: true,
  minify: false,
  // The playground is standalone: react/react-dom inline into the bundle
  // (in the real plugin they come from the dsh loader module table).
  deps: { alwaysBundle: [/.*/] },
}

export default config
