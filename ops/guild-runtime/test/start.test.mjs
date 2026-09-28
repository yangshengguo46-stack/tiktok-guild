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
  assert.equal(
    receivedOptions.env.TIKTOK_BROKER_PROFILE_DIR,
    path.join(process.env.HOME ?? '', '.codex', 'tiktok-live-broker-operator', 'profile'),
  );
  assert.equal(receivedOptions.env.TIKTOK_BROKER_ACCOUNT_REF, 'affiliate:mira.creator_01');
  assert.equal(receivedOptions.env.TIKTOK_BROKER_IDENTITY_TEXT, 'Mira');
});

test('broker identity environment overrides the local defaults', async () => {
  const previous = {
    profile: process.env.TIKTOK_BROKER_PROFILE_DIR,
    account: process.env.TIKTOK_BROKER_ACCOUNT_REF,
    identity: process.env.TIKTOK_BROKER_IDENTITY_TEXT,
  };
  Object.assign(process.env, {
    TIKTOK_BROKER_PROFILE_DIR: '/tmp/custom-broker-profile',
    TIKTOK_BROKER_ACCOUNT_REF: 'affiliate:custom.creator',
    TIKTOK_BROKER_IDENTITY_TEXT: 'Custom Broker',
  });
  let receivedOptions;
  try {
    await startRuntime({
      packageRoot: FORK_ROOT,
      installSoul: async () => {},
      doctor: async () => ({ ok: true, checks: [] }),
      start: async (_command, _args, options) => {
        receivedOptions = options;
        return 0;
      },
    });
  } finally {
    for (const [key, value] of Object.entries({
      TIKTOK_BROKER_PROFILE_DIR: previous.profile,
      TIKTOK_BROKER_ACCOUNT_REF: previous.account,
      TIKTOK_BROKER_IDENTITY_TEXT: previous.identity,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(receivedOptions.env.TIKTOK_BROKER_PROFILE_DIR, '/tmp/custom-broker-profile');
  assert.equal(receivedOptions.env.TIKTOK_BROKER_ACCOUNT_REF, 'affiliate:custom.creator');
  assert.equal(receivedOptions.env.TIKTOK_BROKER_IDENTITY_TEXT, 'Custom Broker');
});
