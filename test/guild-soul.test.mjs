import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureGuildSoul } from '../src/guild-soul.mjs';

test('installs once and preserves a customized default Lead mission', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'guild-soul-'));
  try {
    await mkdir(path.join(fixtureRoot, 'config'));
    await writeFile(path.join(fixtureRoot, 'config', 'guild-soul.md'), 'initial mission\n');
    const first = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(first, {
      installed: true,
      path: path.join(fixtureRoot, '.runtime', 'deerflow-home', 'SOUL.md'),
    });
    assert.equal(await readFile(first.path, 'utf8'), 'initial mission\n');
    await writeFile(first.path, 'operator customization\n');
    const second = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(second, { installed: false, path: first.path });
    assert.equal(await readFile(first.path, 'utf8'), 'operator customization\n');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
