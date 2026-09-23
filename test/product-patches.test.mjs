import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyProductPatches,
  verifyProductPatches,
} from '../src/product-patches.mjs';

const REAL_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE_ROOT = '/tmp/guild';
const DESTINATION = '/tmp/guild/.runtime/deer-flow';
const PATCH = 'patches/0001-example.patch';

const pathExists = async () => true;
const pathInfo = async () => ({
  isFile: () => true,
  isSymbolicLink: () => false,
});

test('real cumulative patch includes all packaged product surfaces', async () => {
  const manifest = JSON.parse(await readFile(path.join(REAL_PACKAGE_ROOT, 'config', 'local-manifest.json'), 'utf8'));
  assert.equal(manifest.product_patches.length, 1);

  const patch = await readFile(path.join(REAL_PACKAGE_ROOT, manifest.product_patches[0]), 'utf8');
  // This guards packaging completeness. Pinned-source pytest covers runtime behavior.
  assert.match(patch, /frontend\/src\/app\/workspace\/guild\/page\.tsx/u);
  assert.match(patch, /backend\/packages\/harness\/deerflow\/creator_agent\/runtime\.py/u);
  assert.match(patch, /backend\/packages\/harness\/deerflow\/creator_agent\/persona_selector\.py/u);
  assert.match(patch, /backend\/packages\/harness\/deerflow\/persistence\/creator_agent_relationship\/sql\.py/u);
  assert.match(patch, /backend\/packages\/harness\/deerflow\/persistence\/migrations\/versions\/0025_creator_agent_relationship\.py/u);
  assert.match(patch, /backend\/tests\/test_creator_agent_personas\.py/u);
  assert.match(patch, /backend\/tests\/test_creator_agent_relationship\.py/u);
  assert.match(patch, /backend\/tests\/test_creator_agent_runtime\.py/u);

  for (const obsolete of [
    'TRUSTED_CHANNEL_PROVENANCE_CONTEXT_KEY',
    'guild_creator_context',
    '0025_guild_creator_context',
    'deerflow/recruitment',
    'deerflow\\.recruitment',
    'guild_method_lookup',
  ]) {
    assert.doesNotMatch(patch, new RegExp(obsolete, 'u'));
  }
});

test('applies one declared patch once', async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes('--reverse')) return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  await applyProductPatches({
    packageRoot: PACKAGE_ROOT,
    destination: DESTINATION,
    patches: [PATCH],
    run,
    pathExists,
    pathInfo,
  });

  assert.deepEqual(calls, [
    ['-C', DESTINATION, 'apply', '--reverse', '--check', `${PACKAGE_ROOT}/${PATCH}`],
    ['-C', DESTINATION, 'apply', '--check', `${PACKAGE_ROOT}/${PATCH}`],
    ['-C', DESTINATION, 'apply', `${PACKAGE_ROOT}/${PATCH}`],
  ]);
});

test('does not reapply a patch already present', async () => {
  const calls = [];

  await applyProductPatches({
    packageRoot: PACKAGE_ROOT,
    destination: DESTINATION,
    patches: [PATCH],
    run: async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
    pathExists,
    pathInfo,
  });

  assert.deepEqual(calls, [
    ['-C', DESTINATION, 'apply', '--reverse', '--check', `${PACKAGE_ROOT}/${PATCH}`],
  ]);
});

test('rejects a conflict without applying the patch', async () => {
  const calls = [];

  await assert.rejects(
    applyProductPatches({
      packageRoot: PACKAGE_ROOT,
      destination: DESTINATION,
      patches: [PATCH],
      run: async (_command, args) => {
        calls.push(args);
        return { code: 1, stdout: '', stderr: 'conflict' };
      },
      pathExists,
      pathInfo,
    }),
    /product patch conflicts/i,
  );

  assert.deepEqual(calls, [
    ['-C', DESTINATION, 'apply', '--reverse', '--check', `${PACKAGE_ROOT}/${PATCH}`],
    ['-C', DESTINATION, 'apply', '--check', `${PACKAGE_ROOT}/${PATCH}`],
  ]);
});

test('rejects a patch outside the package patch directory', async () => {
  await assert.rejects(
    applyProductPatches({
      packageRoot: PACKAGE_ROOT,
      destination: DESTINATION,
      patches: ['../outside.patch'],
      run: async () => { throw new Error('must not run'); },
      pathExists,
      pathInfo,
    }),
    /patch path must stay inside/i,
  );
});

test('rejects more than one cumulative product patch', async () => {
  await assert.rejects(
    applyProductPatches({
      packageRoot: PACKAGE_ROOT,
      destination: DESTINATION,
      patches: [PATCH, 'patches/0002-example.patch'],
      run: async () => { throw new Error('must not run'); },
      pathExists,
      pathInfo,
    }),
    /only one cumulative product patch/i,
  );
});

test('verify accepts an applied patch and rejects a missing patch', async () => {
  const base = {
    packageRoot: PACKAGE_ROOT,
    destination: DESTINATION,
    patches: [PATCH],
    pathExists,
    pathInfo,
  };

  await verifyProductPatches({
    ...base,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  await assert.rejects(
    verifyProductPatches({
      ...base,
      run: async () => ({ code: 1, stdout: '', stderr: 'not applied' }),
    }),
    /product patch is not applied/i,
  );
});

test('rejects a symlink patch before invoking git', async () => {
  await assert.rejects(
    applyProductPatches({
      packageRoot: PACKAGE_ROOT,
      destination: DESTINATION,
      patches: [PATCH],
      run: async () => { throw new Error('must not run'); },
      pathExists,
      pathInfo: async () => ({
        isFile: () => true,
        isSymbolicLink: () => true,
      }),
    }),
    /invalid product patch/i,
  );
});
