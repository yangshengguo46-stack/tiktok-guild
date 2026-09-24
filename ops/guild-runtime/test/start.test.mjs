import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startRuntime } from '../scripts/start.mjs';

const FORK_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

test('local guild start bypasses the setup account gate with a synthetic admin', async () => {
  let receivedOptions;
  const result = await startRuntime({
    packageRoot: FORK_ROOT,
    installSoul: async () => {},
    doctor: async () => ({ ok: true, checks: [] }),
    start: async (_command, _args, options) => {
      receivedOptions = options;
      return 0;
    },
  });

  assert.equal(result.code, 0);
  assert.equal(receivedOptions.env.DEER_FLOW_AUTH_DISABLED, '1');
  assert.equal(receivedOptions.env.DEER_FLOW_CONFIG_PATH, path.join(FORK_ROOT, 'ops', 'guild-runtime', 'config', 'config.yaml'));
});
