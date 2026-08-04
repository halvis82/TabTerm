// Bundles the daemon to a single ESM file.
//
// Native modules are marked external: they cannot be bundled, and the daemon ships with
// its own node_modules inside the app bundle. See docs/13-packaging.md.
import { build } from 'esbuild';

const NATIVE = ['node-pty', 'better-sqlite3'];
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['daemon/src/main.ts'],
  outfile: 'daemon/dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external: NATIVE,
  logLevel: 'info',
  // esbuild emits ESM that may reference require() from CJS deps.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
};

if (watch) {
  const ctx = await (await import('esbuild')).context(options);
  await ctx.watch();
  console.log('daemon: watching');
} else {
  await build(options);
}
