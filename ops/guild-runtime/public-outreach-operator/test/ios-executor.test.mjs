import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceRegistry } from '../src/ios/device-registry.mjs';
import { executeIosAction } from '../src/ios/tiktok-ios-executor.mjs';
import { createXcuitestSession } from '../src/ios/xcuitest-session.mjs';
import { createWdaHealthChecker } from '../src/ios/wda-health.mjs';

const readyPrerequisites = {
  platform: true,
  xcode: true,
  wda: true,
  paired: true,
  online: true,
  locked: false,
};

function device(overrides = {}) {
  return {
    device_ref: 'iphone-001',
    udid: 'UDID-001',
    platform_version: '17.6',
    wda_bundle_id: 'com.example.WebDriverAgentRunner',
    ...overrides,
  };
}

function account(overrides = {}) {
  return { sender_account_id: 'ios-account-001', ...overrides };
}

class FakeElement {
  constructor({ text = '', attributes = {}, visible = true, onClick = null } = {}) {
    this.text = text;
    this.attributes = { ...attributes };
    this.visible = visible;
    this.onClick = onClick;
  }

  async isDisplayed() { return this.visible; }
  async getAttribute(name) { return this.attributes[name] ?? null; }
  async getText() { return this.text; }
  async click() { await this.onClick?.(this); }
  async clear() { this.text = ''; }
  async setValue(value) { this.text = value; }
}

class FakeDriver {
  constructor({ launchError = null, locked = false, missingWda = false } = {}) {
    this.launchError = launchError;
    this.locked = locked;
    this.missingWda = missingWda;
    this.controls = new Map();
    this.controls.set('user-profile', new FakeElement({
      attributes: { 'data-creator-uid': 'creator-001', 'data-creator-handle': 'creator' },
    }));
    const creatorSearch = new FakeElement();
    this.controls.set('creator-search', creatorSearch);
    this.controls.set('creator-search-result', new FakeElement({
      onClick: () => {
        this.controls.get('user-profile').attributes['data-creator-uid'] = 'creator-002';
        this.controls.get('user-profile').attributes['data-creator-handle'] = 'target_handle';
      },
    }));
    this.controls.set('like-button', new FakeElement({
      attributes: { 'aria-pressed': 'false' },
      onClick: (element) => { element.attributes['aria-pressed'] = 'true'; },
    }));
    this.controls.set('follow-button', new FakeElement({
      attributes: { 'aria-pressed': 'false' },
      onClick: (element) => { element.attributes['aria-pressed'] = 'true'; },
    }));
    const commentReceipt = new FakeElement();
    const commentInput = new FakeElement();
    this.controls.set('comment-input', commentInput);
    this.controls.set('comment-item', commentReceipt);
    this.controls.set('comment-submit', new FakeElement({
      onClick: () => { commentReceipt.text = commentInput.text; commentReceipt.visible = true; },
    }));
    const messageReceipt = new FakeElement();
    const messageInput = new FakeElement();
    this.controls.set('message-input', messageInput);
    this.controls.set('message-item', messageReceipt);
    this.controls.set('message-submit', new FakeElement({
      onClick: () => { messageReceipt.text = messageInput.text; messageReceipt.visible = true; },
    }));
  }

  async activateApp() {
    if (this.launchError) throw new Error(this.launchError);
  }

  async find(locator) {
    const value = typeof locator === 'string' ? locator : locator.accessibility_id;
    return this.controls.get(value) ?? null;
  }

  async takeScreenshot() { return Buffer.from('fake-png').toString('base64'); }
  async getPageSource() { return '<AppiumAUT><XCUIElementTypeApplication /></AppiumAUT>'; }
  async deleteSession() {}
}

async function registry() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'ios-outreach-'));
  return createDeviceRegistry({
    rootDir,
    prerequisites: readyPrerequisites,
    driverProbe: async () => true,
  });
}

test('registers a ready device and prevents a second active session', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  assert.equal(registered.ok, true);
  assert.equal(registered.device.state, 'ready');
  const first = await devices.claim('iphone-001', { sessionId: 's1' });
  assert.equal(first.ok, true);
  const second = await devices.claim('iphone-001', { sessionId: 's2' });
  assert.equal(second.error_code, 'device_busy');
  assert.equal((await devices.release('iphone-001')).error_code, 'session_lease_required');
  assert.equal((await devices.release({ device_ref: 'iphone-001', session_id: 's1' })).ok, true);
});

test('filesystem lease prevents two registry instances from claiming the same device', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'ios-cross-process-'));
  const first = createDeviceRegistry({ rootDir, prerequisites: readyPrerequisites, driverProbe: async () => true });
  const second = createDeviceRegistry({ rootDir, prerequisites: readyPrerequisites, driverProbe: async () => true });
  await first.registerDevice(device());
  const results = await Promise.all([
    first.claim('iphone-001', { sessionId: 'owner-a' }),
    second.claim('iphone-001', { sessionId: 'owner-b' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.error_code === 'device_busy').length, 1);
  const owner = results.find((result) => result.ok);
  const loser = results.find((result) => !result.ok);
  assert.equal((await first.release({ device_ref: 'iphone-001', session_id: loser?.session_id ?? 'wrong' })).error_code, 'session_mismatch');
  assert.equal((await first.release({ device_ref: 'iphone-001', session_id: owner.session_id })).ok, true);
});

test('missing WDA, locked, offline, and unpaired devices fail closed with explicit states', async () => {
  const wda = await createDeviceRegistry({
    rootDir: await mkdtemp(path.join(os.tmpdir(), 'ios-wda-')),
    prerequisites: { ...readyPrerequisites, wda: false },
  });
  assert.equal((await wda.registerDevice(device())).device.state, 'manual_required');
  assert.equal((await wda.get('iphone-001')).health, 'wda_unavailable');

  const locked = await createDeviceRegistry({
    rootDir: await mkdtemp(path.join(os.tmpdir(), 'ios-locked-')),
    prerequisites: { ...readyPrerequisites, locked: true },
  });
  assert.equal((await locked.registerDevice(device())).device.state, 'manual_required');
  assert.equal((await locked.get('iphone-001')).health, 'device_locked');

  const offline = await createDeviceRegistry({
    rootDir: await mkdtemp(path.join(os.tmpdir(), 'ios-offline-')),
    prerequisites: { ...readyPrerequisites, online: false },
  });
  assert.equal((await offline.registerDevice(device())).device.state, 'offline');

  const unpaired = await createDeviceRegistry({
    rootDir: await mkdtemp(path.join(os.tmpdir(), 'ios-unpaired-')),
    prerequisites: { ...readyPrerequisites, paired: false },
  });
  assert.equal((await unpaired.registerDevice(device())).device.state, 'manual_required');

  const noProbe = await createWdaHealthChecker({ prerequisites: readyPrerequisites })({
    device: { ...device(), platform: 'darwin' },
  });
  assert.equal(noProbe.ok, false);
  assert.equal(noProbe.error_code, 'wda_probe_required');
});

test('session uses accessibility locators, launches TikTok, and closes its lease', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const driver = new FakeDriver();
  const session = createXcuitestSession({
    device: registered.device,
    driver,
    registry: devices,
    healthCheck: async () => ({ ok: true, state: 'ready' }),
  });
  await session.launch();
  await session.tap({ accessibility_id: 'like-button' });
  assert.equal(await (await session.find({ accessibility_id: 'like-button' })).getAttribute('aria-pressed'), 'true');
  await assert.rejects(() => session.find({ x: 10, y: 10 }), { error_code: 'locator_evidence_required' });
  await assert.rejects(
    () => session.find({ x: 10, y: 10 }, { coordinateEvidence: { source: 'test' } }),
    { error_code: 'manual_required' },
  );
  await session.close();
  assert.equal((await devices.get('iphone-001')).state, 'ready');
});

test('launch failure, cancellation, and manual takeover include failure evidence', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const events = [];
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({
      driver: new FakeDriver({ launchError: 'WDA app launch failed' }),
      pause: async ({ error_code }) => events.push(['pause', error_code]),
      createManualTakeover: async ({ error_code }) => ({ task_id: `takeover-${error_code}` }),
    }),
    creator: { creator_uid: 'creator-001' },
    action: 'like',
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'app_launch_failed');
  assert.equal(result.manual_takeover.status, 'manual_required');
  assert.deepEqual(events, [['pause', 'app_launch_failed']]);
  assert.equal(result.evidence.some((item) => item.type === 'screenshot'), true);
  assert.equal(result.evidence.some((item) => item.type === 'accessibility_snapshot'), true);

  const cancelled = await executeIosAction({
    device: registered.device,
    account: account({ driver: new FakeDriver() }),
    creator: { creator_uid: 'creator-001' },
    action: 'like',
    signal: { aborted: true },
  });
  assert.deepEqual(cancelled, { verified: false, error_code: 'cancelled' });
});

test('creator handle is searched and canonically read back before a public action', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({ driver: new FakeDriver() }),
    creator: { handle: 'target_handle' },
    action: 'like',
  });
  assert.equal(result.verified, true);
  assert.equal(result.receipt_payload.creator_uid, 'creator-002');

  const mismatch = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({ driver: new FakeDriver() }),
    creator: { handle: 'wrong_handle' },
    action: 'like',
  });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.error_code, 'unknown');
});

test('custom iOS locators require pilot authorization and coordinate fallbacks go to takeover', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({ driver: new FakeDriver() }),
    creator: { creator_uid: 'creator-001' },
    action: 'like',
    payload: { locators: { likeButton: { accessibility_id: 'custom-like' } } },
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'pilot_required');
  assert.equal(result.manual_takeover.status, 'manual_required');

  const coordinateDevices = await registry();
  const coordinateRegistered = await coordinateDevices.registerDevice(device());
  const coordinate = await executeIosAction({
    device: {
      ...coordinateRegistered.device,
      registry: coordinateDevices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({
      driver: new FakeDriver(),
      pilot_enabled: true,
    }),
    creator: { creator_uid: 'creator-001' },
    action: 'like',
    payload: {
      pilotEnabled: true,
      locators: { likeButton: { x: 10, y: 20, evidence: { source: 'test' } } },
    },
  });
  assert.equal(coordinate.verified, false);
  assert.equal(coordinate.error_code, 'manual_required');
  assert.equal(coordinate.manual_takeover.status, 'manual_required');
});

test('ordered like comment follow and message return the same receipt envelope', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({ driver: new FakeDriver() }),
    creator: { creator_uid: 'creator-001' },
    action: ['like', 'comment', 'follow'],
    payload: { comment: 'hello', testOnly: true },
  });
  assert.equal(result.verified, true);
  assert.equal(result.receipt_payload.receipt_type, 'public_action_receipt');
  assert.deepEqual(result.receipt_payload.actions.map((item) => item.action), ['like', 'comment', 'follow']);
  assert.equal(result.receipt_payload.sender_account_id, 'ios-account-001');

  const message = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({ driver: new FakeDriver() }),
    creator: { creator_uid: 'creator-001' },
    action: 'message',
    payload: { message: 'hello again', testOnly: true },
  });
  assert.equal(message.verified, true);
  assert.equal(message.receipt_payload.receipt_type, 'dm_receipt');
});

test('evidence can be persisted to the configured root and never proves success alone', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'ios-evidence-'));
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      evidenceRoot,
      healthCheck: async () => ({ ok: true, state: 'ready' }),
    },
    account: account({ driver: new FakeDriver() }),
    creator: { creator_uid: 'wrong-creator' },
    action: 'like',
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'unknown');
  assert.equal(result.evidence.every((item) => item.source === 'failure_evidence'), true);
  const files = await readFile(result.evidence.find((item) => item.type === 'accessibility_snapshot').path, 'utf8');
  assert.match(files, /XCUIElementTypeApplication/);
});
