import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { createPlaywrightPool } from '../src/web/playwright-pool.mjs';
import { createProductionExecutor } from '../src/production-executor.mjs';
import { createProfileRegistry } from '../src/web/profile-registry.mjs';
import { acquireResourceSlot } from '../src/resource-slots.mjs';

test('failed context close retains profile and context ownership for bounded shutdown retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'close-fence-'));
  let closes = 0;
  const context = { close: async () => { if (++closes === 1) throw Error('browser stays alive'); } };
  const first = createPlaywrightPool({ profileRoot: root, launchPersistentContext: async () => context });
  const other = createPlaywrightPool({ profileRoot: root, launchPersistentContext: async () => { throw Error('must not launch'); } });
  await first.register({ sender_account_id: 'sender' });
  const lease = await first.claim('sender');
  await assert.rejects(first.release(lease.lease_id), /browser stays alive/);
  assert.equal(first.activeCount, 1);
  assert.equal((await other.claim('sender')).ok, false);
  await first.close();
  assert.equal(first.activeCount, 0);
  assert.equal(closes, 2);
  await other.close();
});

test('production retains the host slot after failed browser cleanup and releases only after confirmed close', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'production-close-fence-'));
  const proxy = net.createServer((socket) => socket.end());
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  let live = 0; let launches = 0; let closes = 0;
  const page = () => {
    let liked = false;
    const controls = {
      '[sender]': { isVisible: async () => true, getAttribute: async (key) => key === 'data-sender-handle' ? '@alice' : null },
      '[profile]': { isVisible: async () => true, getAttribute: async (key) => key === 'data-creator-uid' ? 'creator' : null },
      '[like]': { isVisible: async () => true, getAttribute: async () => String(liked), click: async () => { liked = true; } },
    };
    return { goto: async (url) => url.includes('cloudflare.com') ? { status: () => 200, text: async () => 'ip=203.0.113.7\nloc=US\n' } : undefined, close: async () => {}, locator: (selector) => ({ first: () => controls[selector] ?? { isVisible: async () => false } }) };
  };
  const config = { pilot: { enabled: true, owner_user_id: 'owner', sender_account_id: 'sender', creator_uid: 'creator', actions: ['like'] }, sender: { owner_user_id: 'owner', sender_account_id: 'sender', channel: 'web', web_route: { proxy_server: `http://127.0.0.1:${proxy.address().port}`, expected_country: 'US' }, locators: { loggedInSender: '[sender]', profileRoot: '[profile]', creatorIdentity: '[profile]', likeButton: '[like]' } } };
  const executor = createProductionExecutor({ runtimeRoot: root, config, chromium: { launchPersistentContext: async () => {
    launches++; live++;
    return { newPage: async () => page(), close: async () => { if (++closes === 1) throw Error('browser stays alive'); live--; } };
  } } });
  const request = { account: { owner_user_id: 'owner', sender_account_id: 'sender', channel: 'web', external_ref: '@alice' }, creator: { creator_uid: 'creator' }, action: 'like' };
  const preparation = await executor.prepareWeb({ account: request.account });
  assert.equal(preparation.ready, true);
  await assert.rejects(executor.execute({ ...request, preparation_id: preparation.preparation_id }), /browser stays alive/);
  assert.equal((await readdir(path.join(root, 'slots', 'web'))).filter((name) => name.endsWith('.lock')).length, 1);
  assert.equal((await executor.execute(request)).verified, false);
  assert.equal(launches, 1); assert.equal(live, 1);
  await executor.close();
  assert.equal(live, 0);
  assert.equal((await readdir(path.join(root, 'slots', 'web'))).length, 0);
});

test('repeated shutdown failure keeps host slot and context for another cleanup attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shutdown-close-fence-'));
  let failing = true;
  const pool = createPlaywrightPool({ profileRoot: root, launchPersistentContext: async () => ({ close: async () => { if (failing) throw Error('still alive'); } }) });
  await pool.register({ sender_account_id: 'sender' }); await pool.claim('sender');
  await assert.rejects(pool.close(), /unconfirmed/);
  await assert.rejects(pool.close(), /unconfirmed/);
  assert.equal(pool.activeCount, 1);
  failing = false; await pool.close(); assert.equal(pool.activeCount, 0);
});

test('shutdown cannot free a retained iPhone slot after session cleanup failed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'device-close-fence-'));
  const config = { pilot: { enabled: true, owner_user_id: 'owner', sender_account_id: 'sender', creator_uid: 'creator', actions: ['like'] }, sender: { owner_user_id: 'owner', sender_account_id: 'sender', channel: 'ios', device: {} } };
  const executor = createProductionExecutor({ runtimeRoot: root, config, driverFactory: async () => ({ verifyHealth: async () => ({}), deleteSession: async () => { throw Error('session deletion unconfirmed'); } }) });
  await assert.rejects(executor.execute({ account: { owner_user_id: 'owner', sender_account_id: 'sender', channel: 'ios', device_ref: 'test-phone' }, creator: { creator_uid: 'creator' }, action: 'like' }), /session deletion unconfirmed/);
  await assert.rejects(executor.close(), /Device cleanup remains unconfirmed/);
  assert.equal((await readdir(path.join(root, 'slots', 'ios'))).filter((name) => name.endsWith('.lock')).length, 1);
});

for (const launched of [false, true]) test(`hard Node death ${launched ? 'with a browser' : 'before browser launch'} preserves the correct recovery fence`, async () => {
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-hard-death-'));
  const poolUrl = new URL('../src/web/playwright-pool.mjs', import.meta.url).href;
  const registryUrl = new URL('../src/web/profile-registry.mjs', import.meta.url).href;
  const slotUrl = new URL('../src/resource-slots.mjs', import.meta.url).href;
  const code = `import { createPlaywrightPool } from ${JSON.stringify(poolUrl)};import { createProfileRegistry } from ${JSON.stringify(registryUrl)};import { acquireResourceSlot } from ${JSON.stringify(slotUrl)};
    const root=${JSON.stringify(root)};const registry=createProfileRegistry({profileRoot:root+'/profiles',leaseTtlMs:1});await registry.register({sender_account_id:'sender'});
    const slot=await acquireResourceSlot({root,kind:'web',maximum:1});
    if(${launched}){await slot.markCleanupRequired();const pool=createPlaywrightPool({registry,profileRoot:root+'/profiles',launchPersistentContext:async()=>({close:async()=>{}})});await pool.claim('sender');}
    else await registry.acquire('sender');process.exit(12);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
  await new Promise((resolve, reject) => { child.once('exit', (code) => code === 12 ? resolve() : reject(Error('child failed'))); child.once('error', reject); });
  const registry = createProfileRegistry({ profileRoot: path.join(root, 'profiles'), clock: () => Date.now() + 3600000, ownerAlive: () => false });
  const recovered = await registry.recoverExpired();
  assert.equal(recovered.length, launched ? 0 : 1);
  const slot = await acquireResourceSlot({root,kind:'web',maximum:1});
  assert.equal(slot.ok, !launched);
  if (launched) assert.equal((await registry.acquire('sender')).error_code, 'profile_cleanup_required');
  else await slot.release();
});
