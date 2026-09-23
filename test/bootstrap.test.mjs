import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { bootstrapRuntime } from '../scripts/bootstrap.mjs';

const PACKAGE_ROOT = '/tmp/deerflow-native-guild';
const OFFICIAL_REPOSITORY = 'https://github.com/bytedance/deer-flow.git';
const PINNED_COMMIT = '769589e8daee14c2587a634b6b43bd96471a41a1';

function runtimeConfig(overrides = {}, productPatches = []) {
  return {
    packageRoot: PACKAGE_ROOT,
    manifest: {
      deerflow: {
        repository: OFFICIAL_REPOSITORY,
        commit: PINNED_COMMIT,
        ...overrides,
      },
      runtime_root: '.runtime',
      product_patches: productPatches,
    },
  };
}

test('bootstrap rejects a floating ref before invoking a process', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig({ commit: 'main' }),
      pathExists: async () => false,
      makeDirectory: async () => {},
      run: async (...args) => { calls.push(args); return { code: 0, stdout: '' }; },
    }),
    /full 40-character commit/i,
  );
  assert.deepEqual(calls, []);
});

test('bootstrap rejects a non-official remote before invoking a process', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig({ repository: 'https://example.test/fork.git' }),
      pathExists: async () => false,
      makeDirectory: async () => {},
      run: async (...args) => { calls.push(args); return { code: 0, stdout: '' }; },
    }),
    /official upstream repository/i,
  );
  assert.deepEqual(calls, []);
});

test('bootstrap refuses a non-empty foreign checkout without deleting it', async () => {
  const destination = path.join(PACKAGE_ROOT, '.runtime', 'deer-flow');
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig(),
      pathExists: async (candidate) => candidate === destination,
      makeDirectory: async () => {},
      run: async () => { throw new Error('process must not run'); },
    }),
    /not a managed Git checkout/i,
  );
});

test('bootstrap rejects an existing checkout from another remote', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig(),
      pathExists: async () => true,
      makeDirectory: async () => {},
      run: async (command, args) => {
        calls.push([command, args]);
        return { code: 0, stdout: 'https://example.test/fork.git\n', stderr: '' };
      },
    }),
    /official upstream repository/i,
  );
  assert.equal(calls.length, 1);
});

test('bootstrap reports a resolved HEAD mismatch and does not install', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig(),
      pathExists: async () => true,
      makeDirectory: async () => {},
      run: async (command, args) => {
        calls.push([command, args]);
        if (args.includes('config')) return { code: 0, stdout: `${OFFICIAL_REPOSITORY}\n`, stderr: '' };
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      },
    }),
    /expected pinned HEAD.*move.*aside/i,
  );
  assert.equal(calls.some(([, args]) => args.includes('install')), false);
});

test('bootstrap applies declared product patches after verifying the pinned checkout', async () => {
  const events = [];
  const patch = 'patches/0001-example.patch';

  await bootstrapRuntime({
    config: runtimeConfig({}, [patch]),
    pathExists: async () => true,
    makeDirectory: async () => {},
    applyPatches: async (options) => {
      events.push(['patch', options]);
    },
    installSoul: async ({ packageRoot }) => { events.push(['soul', packageRoot]); },
    run: async (command, args) => {
      if (args.includes('config')) {
        events.push(['remote']);
        return { code: 0, stdout: `${OFFICIAL_REPOSITORY}\n`, stderr: '' };
      }
      if (args.includes('rev-parse')) {
        events.push(['head']);
        return { code: 0, stdout: `${PINNED_COMMIT}\n`, stderr: '' };
      }
      events.push([command, args]);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(events.slice(0, 5).map(([name]) => name), ['remote', 'head', 'patch', 'soul', 'npm']);
  assert.equal(events[2][1].packageRoot, PACKAGE_ROOT);
  assert.equal(events[2][1].destination, `${PACKAGE_ROOT}/.runtime/deer-flow`);
  assert.deepEqual(events[2][1].patches, [patch]);
});

test('bootstrap clones, verifies, installs, and is idempotent at the pinned commit', async () => {
  let checkoutExists = false;
  const calls = [];
  const options = {
    config: runtimeConfig(),
    installSoul: async () => {},
    pathExists: async (candidate) => checkoutExists
      && (candidate.endsWith('/deer-flow') || candidate.endsWith('/deer-flow/.git')),
    makeDirectory: async () => {},
    run: async (command, args, runOptions) => {
      calls.push([command, args, runOptions]);
      if (command === 'git' && args[0] === 'clone') checkoutExists = true;
      if (args.includes('config')) return { code: 0, stdout: `${OFFICIAL_REPOSITORY}\n`, stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${PINNED_COMMIT}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await bootstrapRuntime(options);
  await bootstrapRuntime(options);

  assert.equal(calls.filter(([command, args]) => command === 'git' && args[0] === 'clone').length, 1);
  assert.equal(
    calls.filter(([command, args]) => command === 'npm'
      && args.includes('--prefix')
      && args.includes('pnpm@10.26.2')).length,
    2,
  );
  assert.equal(calls.filter(([command, args]) => command === 'make' && args[0] === 'install').length, 2);
  const makeCall = calls.find(([command, args]) => command === 'make' && args[0] === 'install');
  assert.equal(makeCall[2].env.CI, 'true');
  assert.equal(
    makeCall[2].env.PATH.startsWith(`${PACKAGE_ROOT}/.runtime/tools/pnpm/node_modules/.bin${path.delimiter}`),
    true,
  );
});
