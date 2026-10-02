import { expect, it } from 'vitest';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';

it('retains the last workspace when a late directory lookup has lost the live mapping', () => {
  const db = new Database(':memory:');
  try {
    const data = new LauncherData(db);
    data.rememberSession({
      id: 'ended',
      workspaceId: 'old-workspace',
      cwd: '/project',
      shell: '/bin/zsh',
    });
    data.rememberSession({
      id: 'ended',
      cwd: '/project/subdir',
      shell: '/bin/zsh',
      lastCommand: 'pwd',
    });
    expect(data.recallWorkspace('old-workspace')).toMatchObject({
      cwd: '/project/subdir',
      lastCommand: 'pwd',
      sessionId: 'ended',
    });
    data.rememberSession({
      id: 'ended',
      workspaceId: 'new-workspace',
      cwd: '/project/subdir',
      shell: '/bin/zsh',
    });
    expect(data.recallWorkspace('old-workspace')).toBeNull();
    expect(data.recallWorkspace('new-workspace')).toMatchObject({
      cwd: '/project/subdir',
      sessionId: 'ended',
    });
  } finally {
    db.close();
  }
});
