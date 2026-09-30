import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';

import { createProductionExecutor } from '../src/production-executor.mjs';
import { createProfileRegistry } from '../src/web/profile-registry.mjs';

const account = { owner_user_id: 'owner', sender_account_id: 'alice', channel: 'web', external_ref: '@alice' };
const request = { account, creator: { creator_uid: 'creator' }, action: 'like' };

async function fixture(t, { exitCountry = 'US', expectedCountry = 'US', closeFailsOnce = false } = {}) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-initialization-'));
  const events = [];
  let liked = false;
  let closes = 0;
  const controls = {
    '[sender]': { isVisible: async () => true, getAttribute: async (key) => key === 'data-sender-handle' ? '@alice' : null },
    '[profile]': { isVisible: async () => true, getAttribute: async (key) => key === 'data-creator-uid' ? 'creator' : null },
    '[like]': { isVisible: async () => true, getAttribute: async () => String(liked), click: async () => { liked = true; } },
  };
  const chromium = {
    async launchPersistentContext(profile, options) {
      events.push({ type: 'launch', profile, options });
      return {
        async newPage() {
          return {
            async goto(url) {
              events.push({ type: 'goto', url });
              if (url.includes('cloudflare.com')) return { status: () => 200, text: async () => `ip=203.0.113.7\nloc=${exitCountry}\n` };
            },
            async close() { events.push({ type: 'page_close' }); },
            locator: (selector) => ({ first: () => controls[selector] ?? { isVisible: async () => false } }),
          };
        },
        async close() {
          closes += 1;
          events.push({ type: 'context_close' });
          if (closeFailsOnce && closes === 1) throw new Error('browser stays alive');
        },
      };
    },
  };
  const config = {
    pilot: { enabled: true, owner_user_id: 'owner', sender_account_id: 'alice', creator_uid: 'creator', actions: ['like'] },
    sender: {
      owner_user_id: 'owner', sender_account_id: 'alice', channel: 'web', headless: false,
      web_route: { proxy_server: `http://127.0.0.1:${server.address().port}`, expected_country: expectedCountry },
      locators: { loggedInSender: '[sender]', creatorIdentity: '[profile]', profileRoot: '[profile]', likeButton: '[like]' },
    },
  };
  return { root, events, config, executor: createProductionExecutor({ runtimeRoot: root, config, chromium }) };
}

test('preparation connects the account proxy and action consumes the same checked context', async (t) => {
  const { events, executor } = await fixture(t);
  const prepared = await executor.prepareWeb({ account });
  assert.equal(prepared.ready, true);
  assert.equal(typeof prepared.preparation_id, 'string');
  assert.equal(events.filter((event) => event.type === 'launch').length, 1);
  assert.equal(events.find((event) => event.type === 'launch').options.proxy.server.startsWith('http://127.0.0.1:'), true);
  assert.deepEqual(events.filter((event) => event.type === 'goto').map((event) => event.url), ['https://www.cloudflare.com/cdn-cgi/trace']);
  const result = await executor.execute({ ...request, preparation_id: prepared.preparation_id });
  assert.equal(result.verified, true);
  assert.deepEqual(events.filter((event) => event.type === 'goto').map((event) => event.url), ['https://www.cloudflare.com/cdn-cgi/trace', 'https://www.tiktok.com/']);
  assert.equal(events.filter((event) => event.type === 'launch').length, 1);
  assert.equal((await executor.execute({ ...request, preparation_id: prepared.preparation_id })).error_code, 'preparation_not_found');
  await executor.close();
});

test('mismatched exit blocks preparation before any TikTok navigation and frees resources', async (t) => {
  const { root, events, executor } = await fixture(t, { expectedCountry: 'SA' });
  assert.deepEqual(await executor.prepareWeb({ account }), { ready: false, error_code: 'egress_country_mismatch' });
  assert.deepEqual(events.filter((event) => event.type === 'goto').map((event) => event.url), ['https://www.cloudflare.com/cdn-cgi/trace']);
  assert.equal((await readdir(path.join(root, 'slots', 'web'))).length, 0);
  await executor.close();
});

test('preparation is bound to its sender and a missing handle cannot execute', async (t) => {
  const { executor } = await fixture(t);
  assert.equal((await executor.execute(request)).error_code, 'web_preparation_required');
  const prepared = await executor.prepareWeb({ account });
  assert.equal(prepared.ready, true);
  assert.equal((await executor.execute({ ...request, account: { ...account, sender_account_id: 'bob' }, preparation_id: prepared.preparation_id })).error_code, 'pilot_required');
  assert.equal((await executor.execute({ ...request, account: { ...account, owner_user_id: 'other' }, preparation_id: prepared.preparation_id })).error_code, 'pilot_required');
  assert.equal((await executor.releaseWeb({ preparation_id: prepared.preparation_id })).released, true);
  await executor.close();
});

test('failed context close retains the slot until shutdown confirms cleanup', async (t) => {
  const { root, executor } = await fixture(t, { closeFailsOnce: true });
  const prepared = await executor.prepareWeb({ account });
  await assert.rejects(executor.releaseWeb({ preparation_id: prepared.preparation_id }), /browser stays alive/);
  assert.equal((await readdir(path.join(root, 'slots', 'web'))).filter((name) => name.endsWith('.lock')).length, 1);
  await executor.close();
  assert.equal((await readdir(path.join(root, 'slots', 'web'))).length, 0);
});

test('an existing disabled profile remains disabled during preparation', async (t) => {
  const { root, events, executor } = await fixture(t);
  const resourceId = crypto.createHash('sha256').update('owner\0alice').digest('hex');
  const registry = createProfileRegistry({ profileRoot: path.join(root, 'web-profiles') });
  await registry.register({ sender_account_id: resourceId, channel: 'web', status: 'disabled', health: 'unknown' });
  assert.deepEqual(await executor.prepareWeb({ account }), { ready: false, error_code: 'profile_unavailable' });
  assert.equal((await registry.get(resourceId)).status, 'disabled');
  assert.equal(events.filter((event) => event.type === 'launch').length, 0);
  await executor.close();
});

test('missing route blocks before slot or browser creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-unconfigured-'));
  const executor = createProductionExecutor({ runtimeRoot: root, config: { sender: { owner_user_id: 'owner', sender_account_id: 'alice', channel: 'web' } }, chromium: { launchPersistentContext: () => { throw new Error('must not launch'); } } });
  assert.deepEqual(await executor.prepareWeb({ account }), { ready: false, error_code: 'web_route_unconfigured' });
  await executor.close();
});
