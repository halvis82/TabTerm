// Bundles the MV3 extension.
//
// Three separate entry points, because the extension has three connection classes with
// different lifetimes. See docs/01-architecture.md and docs/06-chrome-integration.md.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const OUT = 'extension/dist';
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    'service-worker': 'extension/src/service-worker.ts',
    offscreen: 'extension/src/offscreen/offscreen.ts',
    terminal: 'extension/src/terminal/terminal-page.ts',
  },
  outdir: OUT,
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'esm',
  splitting: false,
  sourcemap: true,
  logLevel: 'info',
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

if (watch) {
  const ctx = await (await import('esbuild')).context(options);
  await ctx.watch();
  console.log('extension: watching');
} else {
  await build(options);
}

await cp('extension/public', OUT, { recursive: true });
