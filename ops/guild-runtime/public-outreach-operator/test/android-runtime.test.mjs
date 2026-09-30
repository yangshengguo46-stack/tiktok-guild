import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAndroidDeviceRuntime, compactHierarchy } from '../src/android/device-runtime.mjs';
import { createAndroidDriver } from '../src/android/appium-driver.mjs';
import { executeAndroidAction } from '../src/android/tiktok-android-executor.mjs';
import { createProductionExecutor } from '../src/production-executor.mjs';

test('compact hierarchy returns bounded semantic data without screenshots', () => {
  const xml = '<hierarchy><node text="Hello &amp; bye" resource-id="app:id/send" content-desc="Send" clickable="true" bounds="[1,2][3,4]" /><node text="secret" password="true" clickable="true" /></hierarchy>';
  assert.deepEqual(compactHierarchy(xml), [{ text: 'Hello & bye', resource_id: 'app:id/send', description: 'Send', clickable: true }]);
});

test('Android runtime binds one device and manual takeover blocks AI writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-runtime-'));
  const events = [];
  const driverFactory = async (options) => {
    events.push(['session', options.udid]);
    return { findElement: async () => ({ click: async () => events.push(['tap']) }), getPageSource: async () => '<node text="Ready" clickable="true"/>', deleteSession: async () => events.push(['close']) };
  };
  const runAdb = async () => ({ stdout: 'List of devices attached\nserial-1 device product:x\nserial-2 offline\n' });
  const runtime = createAndroidDeviceRuntime({ root, runAdb, driverFactory });
  const device = { device_ref: 'host-a:serial-1', udid: 'serial-1', system_port: 8201, appium_url: 'http://127.0.0.1:4723' };
  try {
    assert.deepEqual(await runtime.doctor(device), { ok: true, device_ref: device.device_ref, udid: 'serial-1' });
    assert.deepEqual(await runtime.control(device, [{ type: 'tap', locator: { resource_id: 'app:id/send' } }, { type: 'observe' }]), { ok: true, device_ref: device.device_ref, results: [{ ok: true }, { nodes: [{ text: 'Ready', clickable: true }] }] });
    assert.deepEqual(events, [['session', 'serial-1'], ['tap'], ['close']]);
    const manual = await runtime.takeover(device);
    assert.deepEqual(manual.scrcpy, ['scrcpy', '-s', 'serial-1']);
    assert.deepEqual(await runtime.control(device, [{ type: 'observe' }]), { ok: false, error_code: 'manual_takeover', device_ref: device.device_ref });
    await runtime.resume(device);
    assert.equal((await runtime.control(device, [{ type: 'observe' }])).ok, true);
    assert.deepEqual(await runtime.doctor({ ...device, udid: 'serial-2' }), { ok: false, error_code: 'device_offline', device_ref: device.device_ref });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Appium session is pinned to UiAutomator2, serial and unique system port', async () => {
  let body;
  const fetch = async (url, options) => {
    if (url.endsWith('/session') && options.method === 'POST') {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ value: { sessionId: 's1', capabilities: { platformName: 'Android', 'appium:udid': 'serial-1' } } }) };
    }
    return { ok: true, json: async () => ({ value: null }) };
  };
  const driver = await createAndroidDriver({ appiumUrl: 'http://127.0.0.1:4723', udid: 'serial-1', systemPort: 8201, fetch });
  assert.equal(body.capabilities.alwaysMatch['appium:automationName'], 'UiAutomator2');
  assert.equal(body.capabilities.alwaysMatch['appium:udid'], 'serial-1');
  assert.equal(body.capabilities.alwaysMatch['appium:systemPort'], 8201);
  await driver.deleteSession();
});

test('uncertain write pauses the device and failed Appium cleanup retains its lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-uncertain-'));
  const device = { device_ref: 'host-a:serial-1', udid: 'serial-1', system_port: 8201, appium_url: 'http://127.0.0.1:4723' };
  const runAdb = async () => ({ stdout: 'List of devices attached\nserial-1 device\n' });
  const runtime = createAndroidDeviceRuntime({ root, runAdb, driverFactory: async () => ({
    findElement: async () => ({ click: async () => { throw Error('lost response'); } }),
    deleteSession: async () => {},
  }) });
  try {
    assert.equal((await runtime.control(device, [{ type: 'tap', locator: { accessibility_id: 'send' } }])).error_code, 'write_unknown');
    assert.equal((await runtime.control(device, [{ type: 'observe' }])).error_code, 'manual_takeover');
    await runtime.resume(device);
  } finally { await rm(root, { recursive: true, force: true }); }

  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'android-cleanup-'));
  const cleanupRuntime = createAndroidDeviceRuntime({ root: cleanupRoot, runAdb, driverFactory: async () => ({
    getPageSource: async () => '<node text="ready"/>', deleteSession: async () => { throw Error('remote session alive'); },
  }) });
  try {
    assert.equal((await cleanupRuntime.control(device, [{ type: 'observe' }])).error_code, 'cleanup_unknown');
    assert.equal((await cleanupRuntime.control(device, [{ type: 'observe' }])).error_code, 'device_busy');
  } finally { await rm(cleanupRoot, { recursive: true, force: true }); }
});

test('Android TikTok action requires versioned locators and verifies exact sender, target and state change', async () => {
  const account = { sender_account_id: 'a1', external_ref: '@sender' };
  const creator = { creator_uid: 'creator-1', handle: '@target', profile_url: 'https://www.tiktok.com/@target' };
  const locators = { version: 'pilot-1', senderIdentity: { accessibility_id: 'sender' }, creatorIdentity: { accessibility_id: 'target' }, followButton: { accessibility_id: 'follow' }, followState: { attribute: 'selected', active: 'true' } };
  let active = false;
  const events = [];
  const driver = {
    findElement: async (using, value) => {
      events.push(value);
      if (value === 'sender') return { getAttribute: async (key) => key === 'content-desc' ? '@sender' : null };
      if (value === 'target') return { getAttribute: async (key) => key === 'content-desc' ? '@target' : null };
      if (value === 'follow') return { getAttribute: async (key) => key === 'selected' ? String(active) : null, click: async () => { active = true; } };
      throw Error('unknown locator');
    },
    activateApp: async () => { events.push('activate'); },
    openDeepLink: async () => {},
  };
  const missing = await executeAndroidAction({ driver, account, creator, action: 'follow', locators: {} });
  assert.equal(missing.error_code, 'locator_evidence_required');
  const result = await executeAndroidAction({ driver, account, creator, action: 'follow', locators, appPackage: 'com.zhiliaoapp.musically' });
  assert.equal(result.verified, true);
  assert.deepEqual(events.slice(0, 2), ['activate', 'sender']);
  assert.equal(result.provider_ref, 'creator-1');
  assert.equal(result.receipt_payload.transition.before, 'false');
  assert.equal(result.receipt_payload.transition.after, 'true');
  assert.equal((await executeAndroidAction({ driver, account: { ...account, external_ref: '@wrong' }, creator, action: 'follow', locators, appPackage: 'com.zhiliaoapp.musically' })).error_code, 'sender_identity_mismatch');
});

test('Android like refuses a video ID mismatch before any platform write', async () => {
  let clicked = false;
  const driver = {
    activateApp: async () => {}, openDeepLink: async () => {},
    findElement: async (using, value) => ({
      getAttribute: async (attribute) => ({ sender: '@sender', creator: '@target', video: '999', like: 'false' })[value],
      click: async () => { clicked = true; },
    }),
  };
  const result = await executeAndroidAction({
    driver, account: { sender_account_id: 'a1', external_ref: '@sender' },
    creator: { creator_uid: 'target-uid', handle: '@target' }, action: 'like',
    payload: { video_url: 'https://www.tiktok.com/@target/video/123' }, appPackage: 'com.zhiliaoapp.musically',
    locators: { version: 'pilot-1', senderIdentity: { accessibility_id: 'sender' }, creatorIdentity: { accessibility_id: 'creator' },
      videoIdentity: { accessibility_id: 'video' }, videoIdentityProof: { attribute: 'data-video-id' },
      likeButton: { accessibility_id: 'like' }, likeState: { attribute: 'selected', active: 'true' } },
  });
  assert.equal(result.error_code, 'video_identity_mismatch');
  assert.equal(clicked, false);
});

test('production executor rejects old channel and exposes per-device control', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-production-'));
  const device = { device_ref: 'host-a:serial-1', udid: 'serial-1', system_port: 8201, appium_url: 'http://127.0.0.1:4723' };
  const executor = createProductionExecutor({ runtimeRoot: root, config: { devices: [device], sender: { owner_user_id: 'owner', sender_account_id: 'sender', channel: 'android', device_ref: device.device_ref }, pilot: { enabled: true, owner_user_id: 'owner', sender_account_id: 'sender', creator_uid: 'creator', actions: ['follow'] } }, runAdb: async () => ({ stdout: 'List of devices attached\nserial-1 device\n' }), driverFactory: async () => ({ getPageSource: async () => '<node text="Ready"/>', deleteSession: async () => {} }) });
  try {
    const base = { account: { owner_user_id: 'owner', sender_account_id: 'sender', channel: 'web', device_ref: device.device_ref }, creator: { creator_uid: 'creator' }, action: 'follow' };
    assert.equal((await executor.execute(base)).error_code, 'sender_unconfigured');
    assert.equal((await executor.execute({ operation: 'control', device_ref: device.device_ref, commands: [{ type: 'observe' }] })).results[0].nodes[0].text, 'Ready');
    assert.equal((await executor.execute({ operation: 'doctor', device_ref: 'unknown' })).error_code, 'device_unconfigured');
  } finally { await executor.close(); await rm(root, { recursive: true, force: true }); }
});

test('production executor rejects duplicate device identities before starting sessions', async () => {
  const device = { device_ref: 'host:one', udid: 'serial-1', system_port: 8201, appium_url: 'http://127.0.0.1:4723' };
  assert.throws(() => createProductionExecutor({ runtimeRoot: '/tmp/outreach-duplicate-test', config: { devices: [device, { ...device, device_ref: 'host:two' }] } }), /unique udid/);
  assert.throws(() => createProductionExecutor({ runtimeRoot: '/tmp/outreach-duplicate-test', config: { devices: [device, { ...device, udid: 'serial-2' }] } }), /unique device_ref/);
});
