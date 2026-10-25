// Builds the page the relay serves, as one file with everything inside it.
//
// One file because the relay's policy lets the page load nothing from anywhere, so no other server
// can ever change what runs on it. The relay works out the hash of the script from this file when
// it starts, so that script is the only one a browser will run. See relay/worker.js.
//
// The output is committed, so somebody deploying a relay needs nothing but the relay folder.
// `relay-page.test.ts` fails when it is not what this produces from the current source.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function renderRelayPage() {
  const result = await build({
    entryPoints: [`${root}relay/page/main.ts`],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['safari16', 'chrome114', 'firefox115'],
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  const js = result.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
  const css = readFileSync(`${root}node_modules/@xterm/xterm/css/xterm.css`, 'utf8');
  return readFileSync(`${root}relay/page/index.html`, 'utf8')
    .replace('/*XTERM_CSS*/', () => css)
    .replace('/*MAIN_JS*/', () => js);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = await renderRelayPage();
  writeFileSync(`${root}relay/page.html`, page);
  console.log(`relay/page.html ${(page.length / 1024).toFixed(0)} KB`);
}
