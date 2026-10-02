import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}
/** Transaction ordering is shared by the real worker and the failure-injection tests. */
export async function activateUpdate({
  journal,
  prepare,
  backup,
  activate,
  healthy,
  restore,
  oldHealthy,
}) {
  await journal('preparing');
  await prepare();
  await backup();
  // Persist intent before the first mutation, so recovery also covers a killed installer.
  await journal('installing');
  try {
    await activate();
    if (!(await healthy())) throw new Error('The updated companion did not pass its health check');
    await journal('updated');
  } catch (error) {
    try {
      await restore();
      if (!(await oldHealthy())) throw new Error('Previous companion did not restart');
      await journal('rolled-back');
    } catch {
      await journal('manual');
      throw new Error(
        'Automatic recovery failed. Run the companion installer from a known-good checkout. Your terminal service was not stopped.',
      );
    }
    throw error;
  }
}
