import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProfileRegistry } from '../src/web/profile-registry.mjs';
import { createPlaywrightPool } from '../src/web/playwright-pool.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'public-outreach-web-'));
}

function account(senderAccountId, overrides = {}) {
  return { sender_account_id: senderAccountId, ...overrides };
}

function fakeLauncher(paths) {
  return async (userDataDir) => {
    paths.push(userDataDir);
    return {
      closed: false,
      async close() {
        this.closed = true;
      },
    };
  };
}

test('registers up to 50 profiles and leases at most 10 healthy enabled accounts', async () => {
  const profileRoot = await tempRoot();
  const launched = [];
  const pool = createPlaywrightPool({
    profileRoot,
    maxActive: 10,
    launchPersistentContext: fakeLauncher(launched),
  });
  for (let index = 1; index <= 50; index += 1) {
    assert.equal((await pool.register(account(`account_${index}`))).ok, true);
  }
  assert.equal((await pool.register(account('account_51'))).error_code, 'profile_limit_exceeded');
  const leases = [];
  for (let index = 0; index < 10; index += 1) {
    const lease = await pool.claim();
    assert.equal(lease.ok, true);
    leases.push(lease);
  }
  assert.equal(pool.activeCount, 10);
  assert.equal((await pool.claim()).error_code, 'capacity_exhausted');
  assert.equal(launched.length, 10);
  await pool.close();
});

test('enforces same-profile exclusivity across pool owners', async () => {
  const profileRoot = await tempRoot();
  const first = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher([]),
  });
  const second = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher([]),
  });
  await first.register(account('exclusive'));
  assert.equal((await first.claim('exclusive')).ok, true);
  const conflict = await second.claim('exclusive');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error_code, 'profile_in_use');
  await first.close();
  assert.equal((await second.claim('exclusive')).ok, true);
  await second.close();
});

test('close and reopen preserves login storage and never shares profile directories', async () => {
  const profileRoot = await tempRoot();
  const launched = [];
  const pool = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher(launched),
  });
  await pool.register(account('one'));
  await pool.register(account('two'));
  const first = await pool.claim('one');
  const second = await pool.claim('two');
  assert.notEqual(first.userDataDir, second.userDataDir);
  await pool.close();
  await access(first.userDataDir);
  await access(second.userDataDir);
  const persisted = await readdir(path.join(profileRoot, 'profiles'));
  assert.deepEqual(persisted.sort(), ['one', 'two']);

  const reopened = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher(launched),
  });
  const lease = await reopened.claim('one');
  assert.equal(lease.ok, true);
  assert.equal(lease.userDataDir, first.userDataDir);
  await reopened.close();
});

test('expired leases are recovered before a new batch claims a slot', async () => {
  const profileRoot = await tempRoot();
  let current = 1000;
  const registry = createProfileRegistry({ profileRoot, clock: () => current });
  const pool = createPlaywrightPool({
    profileRoot,
    maxActive: 1,
    leaseTtlMs: 100,
    registry,
    launchPersistentContext: fakeLauncher([]),
  });
  await pool.register(account('expiring'));
  const first = await pool.claim('expiring');
  assert.equal(first.ok, true);
  current = 1200;
  const second = await pool.claim('expiring');
  assert.equal(second.ok, true);
  assert.notEqual(second.lease_id, first.lease_id);
  await pool.close();
});

test('disabled or unhealthy accounts are excluded from automatic claims', async () => {
  const profileRoot = await tempRoot();
  const pool = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher([]),
  });
  await pool.register(account('disabled', { status: 'disabled' }));
  await pool.register(account('sick', { health: 'unhealthy' }));
  const result = await pool.claim();
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'capacity_exhausted');
  await pool.close();
});

test('web pool rejects iOS registration and explicit non-web claims', async () => {
  const profileRoot = await tempRoot();
  const pool = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher([]),
  });
  assert.equal((await pool.register(account('ios_001', { channel: 'ios' }))).error_code, 'channel_mismatch');
  assert.equal((await pool.claim({ sender_account_id: 'ios_001', channel: 'ios' })).error_code, 'channel_mismatch');
  await pool.close();
});

test('an existing on-disk iOS profile is skipped without crashing the Web pool', async () => {
  const profileRoot = await tempRoot();
  const profileDir = path.join(profileRoot, 'profiles', 'ios_existing');
  await mkdir(profileDir, { recursive: true });
  await mkdir(path.join(profileRoot, 'locks'), { recursive: true });
  await writeFile(path.join(profileDir, 'registry.json'), JSON.stringify({
    sender_account_id: 'ios_existing',
    channel: 'ios',
    status: 'enabled',
    health: 'healthy',
  }));
  const pool = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: fakeLauncher([]),
  });
  const result = await pool.claim();
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'web_profile_unavailable');
  await pool.close();
});

test('release requires the lease token and cannot release another pool owner', async () => {
  const profileRoot = await tempRoot();
  const first = createPlaywrightPool({ profileRoot, launchPersistentContext: fakeLauncher([]) });
  const second = createPlaywrightPool({ profileRoot, launchPersistentContext: fakeLauncher([]) });
  await first.register(account('owned'));
  const lease = await first.claim('owned');
  assert.equal((await second.release({ sender_account_id: 'owned' })).error_code, 'lease_token_required');
  assert.equal((await second.release({ lease_id: 'wrong', sender_account_id: 'owned' })).error_code, 'lease_not_found');
  assert.equal((await second.claim('owned')).error_code, 'profile_in_use');
  assert.equal((await first.release(lease.lease_id)).ok, true);
  await first.close();
  await second.close();
});

test('concurrent registration preserves the exact 50-profile cap', async () => {
  const profileRoot = await tempRoot();
  const pool = createPlaywrightPool({ profileRoot, launchPersistentContext: fakeLauncher([]) });
  const results = await Promise.all(
    Array.from({ length: 51 }, (_, index) => pool.register(account(`parallel_${index}`))),
  );
  assert.equal(results.filter((result) => result.ok).length, 50);
  assert.equal(results.filter((result) => result.error_code === 'profile_limit_exceeded').length, 1);
  assert.equal((await pool.health()).accounts.length, 50);
  await pool.close();
});
