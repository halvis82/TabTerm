import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One table for every setting a person can change, and a test that keeps it honest.
 *
 * The question each setting has to answer is not "does it work" but "does it tell the truth": is
 * it stored, does changing it take effect now or at some unexplained later moment, and does Reset
 * put it back now or only after the next daemon start.
 *
 * Written as a table because the failure it exists to catch is one of omission. Reset emptied the
 * stored file and put two of the four values back in memory: the scrollback budget and the agent
 * command kept whatever they had been set to, so a reset appeared to work, changed neither, and
 * then took effect at the next daemon start. Nothing was wrong with any single line of that code.
 */
const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(here, 'server.ts'), 'utf8');
/**
 * The background timeout is loaded in `main`, not in the server.
 *
 * Both files count as "the daemon reads it at startup", and pretending otherwise would mean either
 * a wrong answer in the table or moving working code to satisfy a test.
 */
const startup = server + readFileSync(join(here, 'main.ts'), 'utf8');
const resetBlock = server.slice(
  server.indexOf("case 'reset-settings': {"),
  server.indexOf("case 'reset-everything': {"),
);

interface Setting {
  /** What it is called in the stored file. */
  key: string;
  /** The field the running daemon keeps it in. */
  field: string;
  /** What Reset must put it back to, as it appears in the reset block. */
  resetTo: string;
  /** The message every page is told about, so an open settings panel is not left stale. */
  broadcast: string;
}

const SETTINGS: Setting[] = [
  {
    key: 'notify',
    field: 'this.#notifyPolicy',
    resetTo: 'clampPolicy(undefined)',
    broadcast: 'notify-policy',
  },
  {
    key: 'keepBackgroundSeconds',
    field: 'this.#sessions.keepBackgroundSeconds',
    resetTo: 'DEFAULT_KEEP_BACKGROUND_SECONDS',
    broadcast: 'background-timeout',
  },
  {
    key: 'scrollbackBytes',
    field: 'this.#scrollbackBytes',
    resetTo: 'DEFAULT_SCROLLBACK_BYTES',
    broadcast: 'scrollback-budget',
  },
  {
    key: 'agentCommand',
    field: 'this.#agentCommand',
    resetTo: '[...this.#config.agentCommand]',
    broadcast: 'agent-command',
  },
];

describe('every setting that is stored', () => {
  it('is written to the settings file when it changes', () => {
    for (const setting of SETTINGS) {
      expect(server, `${setting.key} must be persisted where it is changed`).toContain(
        `updateUserSetting('${setting.key}'`,
      );
    }
  });

  it('is read back when the daemon starts', () => {
    for (const setting of SETTINGS) {
      expect(startup, `${setting.key} must be read at startup or it only lasts one run`).toContain(
        `readUserSettings()['${setting.key}']`,
      );
    }
  });

  it('is put back by Reset, in memory and not only on disk', () => {
    for (const setting of SETTINGS) {
      expect(resetBlock, `Reset must restore ${setting.key} now, not at the next start`).toContain(
        `${setting.field} = ${setting.resetTo}`,
      );
    }
  });

  it('is announced by Reset, so an open settings panel is not left showing the old value', () => {
    for (const setting of SETTINGS) {
      expect(resetBlock, `Reset must tell the pages about ${setting.key}`).toContain(
        setting.broadcast,
      );
    }
  });

  it('has no stored setting missing from this table', () => {
    /**
     * The other direction, which is the one that rots.
     *
     * A setting added later is persisted by whoever adds it and is easy to leave out of Reset. This
     * finds every key the server stores and insists it is accounted for here.
     */
    const stored = [...server.matchAll(/updateUserSetting\('([^']+)'/g)].map((m) => m[1]);
    const known = new Set(SETTINGS.map((s) => s.key));
    expect([...new Set(stored)].filter((k) => k !== undefined && !known.has(k))).toEqual([]);
  });
});
