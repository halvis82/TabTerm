import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { RestoreStore } from './restore-store.js';
import { initLog } from './log.js';

/**
 * Which browsers are remembered as having held a workspace.
 *
 * `owner_profile` is one column and a workspace can be open in two browsers, so it kept whichever
 * wrote last. Provenance is what lets a browser's silence mean anything, and a second owner whose
 * record had been overwritten was not merely unknown, it was gone: nothing after a restart could
 * tell that anybody else had ever held it.
 *
 * Raised by the second review and missed entirely by the pass that answered the first one.
 */
let dir = '';
let db: Database;
let store: RestoreStore;

beforeEach(async () => {
  initLog('error');
  dir = await mkdtemp(join(tmpdir(), 'tt-owners-'));
  db = new Database(join(dir, 'db.sqlite'));
  store = new RestoreStore(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a workspace held by more than one browser', () => {
  it('remembers both, rather than whichever spoke last', () => {
    store.noteOwner('ws-1', 'profile-a');
    store.noteOwner('ws-1', 'profile-b');
    expect([...(store.allOwners().get('ws-1') ?? [])].sort()).toEqual(['profile-a', 'profile-b']);
  });

  it('carries both across a restart, which is where the single column lost one', () => {
    store.noteOwner('ws-1', 'profile-a');
    store.noteOwner('ws-1', 'profile-b');
    const entry = store.provenance().find((e) => e.workspaceId === 'ws-1');
    expect(entry?.profiles?.sort()).toEqual(['profile-a', 'profile-b']);
  });

  it('says the same thing twice for the same owner', () => {
    store.noteOwner('ws-1', 'profile-a');
    store.noteOwner('ws-1', 'profile-a');
    expect([...(store.allOwners().get('ws-1') ?? [])]).toEqual(['profile-a']);
  });

  it('still fills the old column, for readers that have not moved over', () => {
    store.noteOwner('ws-1', 'profile-a');
    const entry = store.provenance().find((e) => e.workspaceId === 'ws-1');
    expect(entry?.profile).toBe('profile-a');
  });

  it('answers nothing for a workspace nobody has held', () => {
    expect(store.allOwners().get('ws-nobody')).toBeUndefined();
  });
});
