// Bundles the daemon to a single ESM file.
//
// Native modules are marked external: they cannot be bundled, and the daemon ships with
// its own node_modules inside the app bundle. See docs/13-packaging.md.
import { build } from 'esbuild';

const NATIVE = ['node-pty', 'better-sqlite3'];
const watch = process.argv.includes('--watch');

/**
 * The PTY host is its own executable, and that is the point.
 *
 * It is a separate process so that replacing the daemon does not end anybody's terminal, which
 * means it also has to be a separate build artifact: bundling it into the daemon would put the
 * thing that must not restart inside the thing that restarts. Same native externals, since it
 * is the half that actually uses node-pty.
 */
const hostOptions = {
  entryPoints: ['daemon/src/pty-host/host-main.ts'],
  outfile: 'daemon/dist/pty-host.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external: NATIVE,
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
};

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

/**
 * Emitted separately as well as bundled into the daemon.
 *
 * `scripts/diagnostics.mjs` needs redaction, and the installer needs the agent hooks, and a
 * second copy of either in a script is exactly how "we redact secrets" or "this is what a hook
 * looks like" quietly stops being true. One implementation, tested once.
 *
 * The hooks CLI is its own bundle rather than a flag on the daemon because the daemon imports
 * `node:sqlite` at load, so on a Node too old for it the daemon cannot even print help. The
 * installer has to work before anything else does.
 */
const redactOptions = {
  entryPoints: [
    'daemon/src/redact.ts',
    'daemon/src/extension-id.ts',
    'daemon/src/agent-hooks-cli.ts',
  ],
  outdir: 'daemon/dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'warning',
};

if (watch) {
  const esbuild = await import('esbuild');
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const redactCtx = await esbuild.context(redactOptions);
  await redactCtx.watch();
  const hostCtx = await esbuild.context(hostOptions);
  await hostCtx.watch();
  console.log('daemon: watching');
} else {
  await build(options);
  await build(hostOptions);
  await build(redactOptions);
}
