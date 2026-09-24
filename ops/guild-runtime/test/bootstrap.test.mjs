import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { bootstrapRuntime } from '../scripts/bootstrap.mjs';

const FORK_ROOT = '/tmp/deerflow-fork';
const OPS_ROOT = `${FORK_ROOT}/ops/guild-runtime`;
const OFFICIAL_REPOSITORY = 'https://github.com/bytedance/deer-flow.git';
const PINNED_COMMIT = '769589e8daee14c2587a634b6b43bd96471a41a1';

function runtimeConfig(overrides = {}) {
  return {
    packageRoot: FORK_ROOT,
    opsRoot: OPS_ROOT,
    manifest: {
      deerflow: {
        repository: OFFICIAL_REPOSITORY,
        commit: PINNED_COMMIT,
        ...overrides,
      },
    },
  };
}

test('bootstrap rejects a floating upstream commit before invoking a process', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig({ commit: 'main' }),
      makeDirectory: async () => {},
      run: async (...args) => { calls.push(args); return { code: 0, stdout: '' }; },
    }),
    /full 40-character commit/i,
  );
  assert.deepEqual(calls, []);
});

test('bootstrap rejects a different full commit before invoking git', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig({ commit: '0000000000000000000000000000000000000000' }),
      makeDirectory: async () => {},
      run: async (...args) => { calls.push(args); return { code: 0, stdout: '' }; },
    }),
    /approved pinned commit/i,
  );
  assert.deepEqual(calls, []);
});

test('bootstrap requires the pinned upstream commit to be an ancestor of the fork', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapRuntime({
      config: runtimeConfig(),
      makeDirectory: async () => {},
      installSoul: async () => {},
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        return { code: 1, stdout: '', stderr: 'not an ancestor' };
      },
    }),
    /pinned upstream.*ancestor/i,
  );
  assert.deepEqual(calls, [{
    command: 'git',
    args: ['-C', FORK_ROOT, 'merge-base', '--is-ancestor', PINNED_COMMIT, 'HEAD'],
    options: { cwd: FORK_ROOT },
  }]);
});

test('bootstrap installs the current fork without cloning or applying a product patch', async () => {
  const calls = [];
  const soulInstalls = [];

  const result = await bootstrapRuntime({
    config: runtimeConfig(),
    makeDirectory: async () => {},
    installSoul: async (options) => { soulInstalls.push(options); },
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('config')) return { code: 0, stdout: `${OFFICIAL_REPOSITORY}\n`, stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${PINNED_COMMIT}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, {
    repository: OFFICIAL_REPOSITORY,
    commit: PINNED_COMMIT,
    destination: FORK_ROOT,
  });
  assert.deepEqual(soulInstalls, [{ packageRoot: FORK_ROOT }]);
  assert.equal(calls.some(({ args }) => args.includes('clone')), false);
  assert.equal(calls.some(({ args }) => args.includes('apply')), false);
  assert.deepEqual(calls[0], {
    command: 'git',
    args: ['-C', FORK_ROOT, 'merge-base', '--is-ancestor', PINNED_COMMIT, 'HEAD'],
    options: { cwd: FORK_ROOT },
  });
  const install = calls.find(({ command, args }) => command === 'make' && args[0] === 'install');
  assert.equal(install.options.cwd, FORK_ROOT);
  assert.equal(install.options.env.CI, 'true');
  assert.equal(
    install.options.env.PATH.startsWith(`${OPS_ROOT}/.runtime/tools/pnpm/node_modules/.bin${path.delimiter}`),
    true,
  );
});
