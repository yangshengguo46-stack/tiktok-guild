import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAndroidDeviceRuntime } from '../src/android/device-runtime.mjs';
import { createAndroidDriver } from '../src/android/appium-driver.mjs';
import { executeAndroidAction } from '../src/android/tiktok-android-executor.mjs';
import { createProductionExecutor } from '../src/production-executor.mjs';

const device = { device_ref: 'phone', udid: 'serial', system_port: 8201, appium_url: 'http://127.0.0.1:4723' };
const runAdb = async () => ({ stdout: 'List of devices attached\nserial device\n' });

for (const mode of ['lost-create-response', 'failed-mismatch-cleanup']) {
  test(`an uncertain Appium session keeps the device fenced: ${mode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'android-fencing-'));
    let creates = 0;
    const fetch = async (_url, options) => {
      if (options.method === 'POST') {
        creates++;
        if (mode === 'lost-create-response') throw Error('response lost after remote session creation');
        return { ok: true, json: async () => ({ value: { sessionId: 'unexpected-session', capabilities: { platformName: 'Android', 'appium:udid': 'wrong' } } }) };
      }
      throw Error('remote session cleanup was not confirmed');
    };
    const runtime = createAndroidDeviceRuntime({ root, runAdb, driverFactory: (options) => createAndroidDriver({ ...options, fetch }) });
    try {
      const first = await runtime.control(device, [{ type: 'observe' }]);
      assert.equal(first.error_code, 'cleanup_unknown');
      assert.equal((await runtime.resume(device)).error_code, 'device_busy');
      assert.equal((await runtime.control(device, [{ type: 'observe' }])).error_code, 'device_busy');
      assert.equal(creates, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('malformed Appium platform evidence still cleans up the returned session', async () => {
  let deletes = 0;
  const fetch = async (_url, options) => {
    if (options.method === 'DELETE') { deletes++; return { ok: true, json: async () => ({ value: null }) }; }
    return { ok: true, json: async () => ({ value: { sessionId: 'untrusted-session', capabilities: { platformName: 123, 'appium:udid': 'serial' } } }) };
  };
  await assert.rejects(createAndroidDriver({ appiumUrl: device.appium_url, udid: device.udid, systemPort: device.system_port, fetch }), { error_code: 'device_mismatch' });
  assert.equal(deletes, 1);
});

for (const sessionId of [123, {}, '   ']) {
  test(`malformed Appium session identity retains the device fence: ${JSON.stringify(sessionId)}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'android-bad-session-'));
    let creates = 0;
    const fetch = async (_url, options) => {
      if (options.method === 'POST') creates++;
      return { ok: true, json: async () => ({ value: { sessionId, capabilities: { platformName: 'Android', 'appium:udid': 'serial' } } }) };
    };
    const runtime = createAndroidDeviceRuntime({ root, runAdb, driverFactory: (options) => createAndroidDriver({ ...options, fetch }) });
    try {
      assert.equal((await runtime.control(device, [{ type: 'observe' }])).error_code, 'cleanup_unknown');
      assert.equal((await runtime.control(device, [{ type: 'observe' }])).error_code, 'device_busy');
      assert.equal(creates, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

function actionFixture({ action = 'follow', before = 'false', signal, afterNavigation } = {}) {
  let clicks = 0;
  const locators = {
    version: 'test-v1', senderIdentity: { accessibility_id: 'sender' }, creatorIdentity: { accessibility_id: 'creator' },
    followButton: { accessibility_id: 'follow' }, followState: { attribute: 'selected', inactive: 'false', active: 'true' },
    videoIdentity: { accessibility_id: 'video' }, videoIdentityProof: { attribute: 'video-id' },
    likeButton: { accessibility_id: 'follow' }, likeState: { attribute: 'selected', inactive: 'false', active: 'true' },
  };
  const driver = {
    activateApp: async () => {}, openDeepLink: async () => { afterNavigation?.(); },
    findElement: async (_using, key) => ({
      getAttribute: async () => key === 'sender' ? '@sender' : key === 'creator' ? '@target' : key === 'video' ? '123' : clicks ? 'true' : before,
      click: async () => { clicks++; },
    }),
  };
  return { input: { driver, action, signal, account: { sender_account_id: 's', external_ref: '@sender' },
    creator: { creator_uid: 'c', handle: '@target', profile_url: 'https://www.tiktok.com/@target' },
    payload: { video_url: 'https://www.tiktok.com/@target/video/123' }, appPackage: 'com.zhiliaoapp.musically', locators }, clicks: () => clicks };
}

for (const action of ['like', 'follow']) {
  for (const before of [null, '', 'unknown']) {
    test(`${action} refuses an unreadable or unrecognized state before writing: ${before}`, async () => {
      const fixture = actionFixture({ action, before });
      const result = await executeAndroidAction(fixture.input);
      assert.equal(result.verified, false);
      assert.equal(result.error_code, 'state_baseline_unknown');
      assert.equal(fixture.clicks(), 0);
    });
  }
}

test('cancellation during navigation prevents the subsequent external write', async () => {
  const abort = new AbortController();
  const fixture = actionFixture({ signal: abort.signal, afterNavigation: () => abort.abort() });
  assert.equal((await executeAndroidAction(fixture.input)).error_code, 'cancelled');
  assert.equal(fixture.clicks(), 0);
});

test('a caller cannot control a device by claiming its public reference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-owner-'));
  let sessions = 0;
  const executor = createProductionExecutor({ runtimeRoot: root, config: { devices: [{ ...device, owner_user_id: 'owner' }] }, runAdb,
    driverFactory: async () => { sessions++; return { getPageSource: async () => '<node text="ready"/>', deleteSession: async () => {} }; } });
  try {
    const request = { operation: 'control', device_ref: 'phone', commands: [{ type: 'observe' }] };
    assert.equal((await executor.execute({ ...request, owner_user_id: 'other' })).error_code, 'device_owner_mismatch');
    assert.equal((await executor.execute(request)).error_code, 'device_owner_mismatch');
    assert.equal(sessions, 0);
    assert.equal((await executor.execute({ ...request, owner_user_id: 'owner' })).ok, true);
    assert.equal(sessions, 1);
  } finally { await executor.close(); await rm(root, { recursive: true, force: true }); }
});

test('an oversized receipt baseline cannot turn an old comment into a fresh receipt', async () => {
  let writes = 0;
  const item = (id) => ({ getAttribute: async (key) => ({ id, sender: '@sender', target: '@target' })[key], getText: async () => 'hello' });
  const baseline = Array.from({ length: 101 }, (_, index) => item(`old-${index}`));
  const driver = {
    activateApp: async () => {}, openDeepLink: async () => {},
    findElements: async () => writes ? [item('old-100')] : baseline,
    findElement: async (_using, key) => ({
      getAttribute: async () => ({ sender: '@sender', creator: '@target', video: '123' })[key],
      clear: async () => {}, setValue: async () => {}, click: async () => { writes++; },
    }),
  };
  const result = await executeAndroidAction({
    driver, action: 'comment', account: { sender_account_id: 's', external_ref: '@sender' },
    creator: { creator_uid: 'c', handle: '@target' }, payload: { video_url: 'https://www.tiktok.com/@target/video/123', comment: 'hello' },
    appPackage: 'com.zhiliaoapp.musically', locators: {
      version: 'test-v1', senderIdentity: { accessibility_id: 'sender' }, creatorIdentity: { accessibility_id: 'creator' },
      videoIdentity: { accessibility_id: 'video' }, videoIdentityProof: { attribute: 'video-id' },
      commentInput: { accessibility_id: 'input' }, commentSubmit: { accessibility_id: 'submit' }, commentReceipt: { accessibility_id: 'receipt' },
      commentProof: { id_attribute: 'id', sender_attribute: 'sender', target_attribute: 'target' },
    },
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'receipt_baseline_unknown');
  assert.equal(writes, 0);
});

for (const invalidId of [{ same: 'old-id' }, true, 123, '   ']) {
  for (const phase of ['baseline', 'after']) {
    test(`invalid platform receipt IDs cannot prove freshness: ${phase} ${JSON.stringify(invalidId)}`, async () => {
      let writes = 0;
      const driver = {
        activateApp: async () => {}, openDeepLink: async () => {},
        findElements: async () => phase === 'after' && !writes ? [] : [{
          getAttribute: async (key) => ({ id: structuredClone(invalidId), sender: '@sender', target: '@target' })[key],
          getText: async () => 'hello',
        }],
        findElement: async (_using, key) => ({
          getAttribute: async () => ({ sender: '@sender', creator: '@target' })[key],
          clear: async () => {}, setValue: async () => {}, click: async () => { writes++; },
        }),
      };
      const result = await executeAndroidAction({
        driver, action: 'message', account: { sender_account_id: 's', external_ref: '@sender' },
        creator: { creator_uid: 'c', handle: '@target', profile_url: 'https://www.tiktok.com/@target' }, payload: { message: 'hello' },
        appPackage: 'com.zhiliaoapp.musically', locators: {
          version: 'test-v1', senderIdentity: { accessibility_id: 'sender' }, creatorIdentity: { accessibility_id: 'creator' },
          messageInput: { accessibility_id: 'input' }, messageSubmit: { accessibility_id: 'submit' }, messageReceipt: { accessibility_id: 'receipt' },
          messageProof: { id_attribute: 'id', sender_attribute: 'sender', target_attribute: 'target' },
        },
      });
      assert.equal(result.verified, false);
      assert.equal(result.error_code, phase === 'baseline' ? 'receipt_baseline_unknown' : 'write_unknown');
      assert.equal(writes, phase === 'baseline' ? 0 : 1);
    });
  }
}
