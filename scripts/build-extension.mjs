// Bundles the MV3 extension.
//
// Three separate entry points, because the extension has three connection classes with
// different lifetimes. See docs/01-architecture.md and docs/06-chrome-integration.md.
import { build } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';

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
  loader: { '.css': 'text' },
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

// xterm ships its stylesheet as a package asset. Copy rather than inline it, so the CSP
// stays strict and the page loads it as a normal stylesheet.
await copyFile('node_modules/@xterm/xterm/css/xterm.css', `${OUT}/xterm.css`);
