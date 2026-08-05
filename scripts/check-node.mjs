// Fails loudly when the runtime cannot do what the code needs.
//
// node:sqlite arrived in Node 22. On an older runtime the daemon still typechecks and still
// builds, and only falls over at the moment it opens its database, which is a long way from
// the cause. See docs/adr/0015-node-sqlite-over-native.md.
const [major] = process.versions.node.split('.').map(Number);

let hasSqlite = false;
try {
  await import('node:sqlite');
  hasSqlite = true;
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  console.error(
    `\nTabTerm needs Node 22 or newer for its built-in SQLite.\n` +
      `  running: v${process.versions.node}\n` +
      `  fix:     brew install node@24, then run with that on PATH, for example\n` +
      `           PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run verify\n`,
  );
  process.exit(1);
}

console.log(`node v${process.versions.node} (major ${String(major)}) has node:sqlite`);
