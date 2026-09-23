import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function ensureGuildSoul({ packageRoot }) {
  const home = path.join(packageRoot, '.runtime', 'deerflow-home');
  const target = path.join(home, 'SOUL.md');
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await copyFile(path.join(packageRoot, 'config', 'guild-soul.md'), target, constants.COPYFILE_EXCL);
    return { installed: true, path: target };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { installed: false, path: target };
  }
}
