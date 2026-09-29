import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceRegistry } from '../src/ios/device-registry.mjs';
import { executeIosAction as executeAuthorizedFakeIosAction } from '../src/ios/tiktok-ios-executor.mjs';
import { createXcuitestSession } from '../src/ios/xcuitest-session.mjs';
import { createWdaHealthChecker } from '../src/ios/wda-health.mjs';

process.env.PUBLIC_OUTREACH_FAKE_BROWSER = '1';
const executeIosAction = (options) => executeAuthorizedFakeIosAction({ ...options, payload: { testOnly: true, ...options.payload } });

const readyPrerequisites = {
  platform: true,
  xcode: true,
  wda: true,
  paired: true,
  online: true,
  locked: false,
};

function strictHealth() {
  return {
    ok: true,
    state: 'ready',
    prerequisites: readyPrerequisites,
    probe: { ready: true, device_verified: true, wda_verified: true },
  };
}

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
  return { sender_account_id: 'ios-account-001', external_ref: '@alice', ...overrides };
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
  async press() {}
}

class FakeDriver {
  constructor({
    launchError = null,
    locked = false,
    missingWda = false,
    likeActive = false,
    followActive = false,
    existingCommentText = '',
    existingMessageText = '',
    receiptMarkers = true,
    receiptCountSupport = true,
    countIncrementOnSubmit = true,
  } = {}) {
    this.launchError = launchError;
    this.locked = locked;
    this.missingWda = missingWda;
    this.receiptMarkers = receiptMarkers;
    this.receiptCountSupport = receiptCountSupport;
    this.countIncrementOnSubmit = countIncrementOnSubmit;
    this.receiptCounts = {
      comment: existingCommentText ? 1 : 0,
      message: existingMessageText ? 1 : 0,
    };
    this.receiptSequences = {
      comment: existingCommentText ? 1 : 0,
      message: existingMessageText ? 1 : 0,
    };
    this.controls = new Map();
    this.controls.set('current-user', new FakeElement({ attributes: { 'data-sender-handle': '@alice' } }));
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
      attributes: { 'aria-pressed': String(likeActive) },
      onClick: (element) => { element.attributes['aria-pressed'] = 'true'; },
    }));
    this.controls.set('follow-button', new FakeElement({
      attributes: { 'aria-pressed': String(followActive) },
      onClick: (element) => { element.attributes['aria-pressed'] = 'true'; },
    }));
    const commentReceipt = new FakeElement({
      text: existingCommentText,
      visible: Boolean(existingCommentText),
      attributes: this.receiptMarkers && existingCommentText
        ? { 'data-receipt-id': 'comment-existing-1' }
        : {},
    });
    const commentInput = new FakeElement();
    this.controls.set('comment-input', commentInput);
    this.controls.set('comment-item', commentReceipt);
    this.controls.set('comment-submit', new FakeElement({
      onClick: () => {
        Object.assign(commentReceipt.attributes, { 'data-sender-handle': '@alice', 'data-creator-uid': 'creator-001' });
        if (this.countIncrementOnSubmit) this.receiptCounts.comment += 1;
        this.receiptSequences.comment += 1;
        commentReceipt.text = commentInput.text;
        commentReceipt.visible = true;
        if (this.receiptMarkers) commentReceipt.attributes['data-receipt-id'] = `comment-${this.receiptSequences.comment}`;
      },
    }));
    const messageReceipt = new FakeElement({
      text: existingMessageText,
      visible: Boolean(existingMessageText),
      attributes: this.receiptMarkers && existingMessageText
        ? { 'data-message-id': 'message-existing-1' }
        : {},
    });
    const messageInput = new FakeElement();
    this.controls.set('message-input', messageInput);
    this.controls.set('message-item', messageReceipt);
    this.controls.set('message-submit', new FakeElement({
      onClick: () => {
        Object.assign(messageReceipt.attributes, { 'data-sender-handle': '@alice', 'data-creator-uid': 'creator-001' });
        if (this.countIncrementOnSubmit) this.receiptCounts.message += 1;
        this.receiptSequences.message += 1;
        messageReceipt.text = messageInput.text;
        messageReceipt.visible = true;
        if (this.receiptMarkers) messageReceipt.attributes['data-message-id'] = `message-${this.receiptSequences.message}`;
      },
    }));
  }

  async activateApp() {
    if (this.launchError) throw new Error(this.launchError);
  }

  async find(locator) {
    const value = typeof locator === 'string' ? locator : locator.accessibility_id;
    return this.controls.get(value) ?? null;
  }

  async count(locator) {
    if (!this.receiptCountSupport) return null;
    const value = typeof locator === 'string' ? locator : locator.accessibility_id;
    if (value === 'comment-item') return this.receiptCounts.comment;
    if (value === 'message-item') return this.receiptCounts.message;
    return null;
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
    driverProbe: async () => ({ ready: true, device_verified: true, wda_verified: true }),
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
  const first = createDeviceRegistry({
    rootDir,
    prerequisites: readyPrerequisites,
    driverProbe: async () => ({ ready: true, device_verified: true, wda_verified: true }),
  });
  const second = createDeviceRegistry({
    rootDir,
    prerequisites: readyPrerequisites,
    driverProbe: async () => ({ ready: true, device_verified: true, wda_verified: true }),
  });
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

test('lock heartbeat keeps a slow health probe exclusive past the lease interval', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'ios-slow-lock-'));
  let slowMode = false;
  let healthFinished = false;
  const slowHealth = async () => {
    if (slowMode) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      healthFinished = true;
    }
    return strictHealth();
  };
  const options = {
    rootDir,
    healthChecker: slowHealth,
    lockLeaseMs: 30,
    lockHeartbeatMs: 5,
    lockAcquireTimeoutMs: 1_000,
  };
  const first = createDeviceRegistry(options);
  const second = createDeviceRegistry(options);
  await first.registerDevice(device());
  slowMode = true;
  const healthPromise = first.health('iphone-001');
  await new Promise((resolve) => setTimeout(resolve, 60));
  let claimFinished = false;
  const claimPromise = second.claim('iphone-001', { sessionId: 'slow-owner' }).then((result) => {
    claimFinished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(healthFinished, false);
  assert.equal(claimFinished, false);
  await healthPromise;
  const claim = await claimPromise;
  assert.equal(claim.ok, true);
  assert.equal((await second.release({ device_ref: 'iphone-001', session_id: 'slow-owner' })).ok, true);
});

test('release waits for an in-flight heartbeat and cannot leave a zombie lock', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'ios-release-heartbeat-'));
  let heartbeatStartedResolve;
  const heartbeatStarted = new Promise((resolve) => { heartbeatStartedResolve = resolve; });
  let heartbeatReleaseResolve;
  const heartbeatRelease = new Promise((resolve) => { heartbeatReleaseResolve = resolve; });
  let blockHeartbeats = false;
  const first = createDeviceRegistry({
    rootDir,
    healthChecker: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return strictHealth();
    },
    lockLeaseMs: 20,
    lockHeartbeatMs: 5,
    lockAcquireTimeoutMs: 1_000,
    lockWriteHook: async (record) => {
      if (blockHeartbeats && record.heartbeat_at) {
        heartbeatStartedResolve();
        await heartbeatRelease;
      }
    },
  });
  const second = createDeviceRegistry({ rootDir, lockAcquireTimeoutMs: 1_000 });
  await first.registerDevice(device());
  await first.claim('iphone-001', { sessionId: 'heartbeat-owner' });
  blockHeartbeats = true;
  const healthPromise = first.health('iphone-001');
  await heartbeatStarted;
  const releasePromise = second.release({ device_ref: 'iphone-001', session_id: 'heartbeat-owner' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  heartbeatReleaseResolve();
  assert.equal((await healthPromise).ok, true);
  assert.equal((await releasePromise).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(() => access(path.join(rootDir, 'devices.lock')));
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
  assert.equal((await offline.get('iphone-001')).health, 'device_offline');

  const unpaired = await createDeviceRegistry({
    rootDir: await mkdtemp(path.join(os.tmpdir(), 'ios-unpaired-')),
    prerequisites: { ...readyPrerequisites, paired: false },
  });
  assert.equal((await unpaired.registerDevice(device())).device.state, 'manual_required');
  assert.equal((await unpaired.get('iphone-001')).health, 'device_unpaired');

  const noProbe = await createWdaHealthChecker({ prerequisites: readyPrerequisites })({
    device: { ...device(), platform: 'darwin' },
  });
  assert.equal(noProbe.ok, false);
  assert.equal(noProbe.error_code, 'wda_probe_required');

  for (const probe of [undefined, null, {}, { ready: false }, { ready: true }, true]) {
    const invalidProbe = await createWdaHealthChecker({
      prerequisites: readyPrerequisites,
      driverProbe: async () => probe,
    })({ device: { ...device(), platform: 'darwin' } });
    assert.equal(invalidProbe.ok, false);
    assert.equal(invalidProbe.state, 'manual_required');
    assert.equal(invalidProbe.error_code, 'wda_unavailable');
  }
  const verifiedProbe = await createWdaHealthChecker({
    prerequisites: readyPrerequisites,
    driverProbe: async () => ({
      ready: true,
      device_verified: true,
      wda_verified: true,
    }),
  })({ device: { ...device(), platform: 'darwin' } });
  assert.equal(verifiedProbe.ok, true);
  assert.equal(verifiedProbe.state, 'ready');
});

test('registry rejects an injected ok response that bypasses the strict WDA contract', async () => {
  const devices = createDeviceRegistry({
    rootDir: await mkdtemp(path.join(os.tmpdir(), 'ios-injected-health-')),
    healthChecker: async () => ({ ok: true, state: 'ready' }),
  });
  const registered = await devices.registerDevice(device());
  assert.equal(registered.ok, true);
  assert.equal(registered.device.state, 'manual_required');
  assert.equal(registered.device.health, 'wda_unavailable');
  assert.equal((await devices.get('iphone-001')).state, 'manual_required');
  const refreshed = await devices.health('iphone-001');
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.device.state, 'manual_required');
  assert.equal(refreshed.device.health, 'wda_unavailable');
});

test('registry rejects non-ok ready and paired health states before persistence or claim', async () => {
  for (const reportedState of ['ready', 'paired']) {
    const devices = createDeviceRegistry({
      rootDir: await mkdtemp(path.join(os.tmpdir(), `ios-invalid-${reportedState}-`)),
      healthChecker: async () => ({ ok: false, state: reportedState }),
    });
    const registered = await devices.registerDevice(device());
    assert.equal(registered.device.state, 'manual_required');
    assert.equal(registered.device.health, 'wda_unavailable');
    const claim = await devices.claim('iphone-001', { sessionId: `invalid-${reportedState}` });
    assert.equal(claim.ok, false);
    assert.equal(claim.error_code, 'wda_unavailable');
  }
});

test('claim preserves explicit fresh health state while refusing the lease', async () => {
  for (const failure of [
    { state: 'offline', error_code: 'device_offline' },
    { state: 'manual_required', error_code: 'device_locked' },
    { state: 'manual_required', error_code: 'device_unpaired' },
  ]) {
    let calls = 0;
    const devices = createDeviceRegistry({
      rootDir: await mkdtemp(path.join(os.tmpdir(), `ios-claim-${failure.error_code}-`)),
      healthChecker: async () => {
        calls += 1;
        return calls === 1
          ? strictHealth()
          : { ok: false, state: failure.state, error_code: failure.error_code };
      },
    });
    await devices.registerDevice(device());
    const claim = await devices.claim('iphone-001', { sessionId: `claim-${failure.error_code}` });
    assert.equal(claim.ok, false);
    assert.equal(claim.error_code, failure.error_code);
    assert.equal(claim.device.state, failure.state);
    assert.equal(claim.device.health, failure.error_code);
    assert.equal((await devices.get('iphone-001')).active_session_id, null);
  }
});

test('session uses accessibility locators, launches TikTok, and closes its lease', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const driver = new FakeDriver();
  const session = createXcuitestSession({
    device: registered.device,
    driver,
    registry: devices,
    healthCheck: strictHealth,
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

test('session rejects an ok response that does not satisfy the strict WDA contract', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const session = createXcuitestSession({
    device: registered.device,
    driver: new FakeDriver(),
    registry: devices,
    healthCheck: async () => ({ ok: true, state: 'ready' }),
  });
  await assert.rejects(() => session.launch(), { error_code: 'wda_unavailable' });
  await session.close();
});

test('launch failure, cancellation, and manual takeover include failure evidence', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const events = [];
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: strictHealth,
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
      healthCheck: strictHealth,
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
      healthCheck: strictHealth,
    },
    account: account({ driver: new FakeDriver() }),
    creator: { handle: 'wrong_handle' },
    action: 'like',
  });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.error_code, 'unknown');
});

test('profile URL navigation and missing Enter support fail into bounded manual takeover', async () => {
  const urlDevices = await registry();
  const urlRegistered = await urlDevices.registerDevice(device());
  const urlResult = await executeIosAction({
    device: {
      ...urlRegistered.device,
      registry: urlDevices,
      healthCheck: strictHealth,
    },
    account: account({ driver: new FakeDriver() }),
    creator: { profile_url: 'https://www.tiktok.com/@target_handle' },
    action: 'like',
  });
  assert.equal(urlResult.verified, false);
  assert.equal(urlResult.error_code, 'manual_required');

  const searchDevices = await registry();
  const searchRegistered = await searchDevices.registerDevice(device());
  const noEnterDriver = new FakeDriver();
  noEnterDriver.controls.get('creator-search').press = undefined;
  const searchResult = await executeIosAction({
    device: {
      ...searchRegistered.device,
      registry: searchDevices,
      healthCheck: strictHealth,
    },
    account: account({ driver: noEnterDriver }),
    creator: { handle: 'target_handle' },
    action: 'like',
  });
  assert.equal(searchResult.verified, false);
  assert.equal(searchResult.error_code, 'manual_required');
});

test('custom iOS locators require pilot authorization and coordinate fallbacks go to takeover', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: strictHealth,
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
      healthCheck: strictHealth,
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

test('comment and message require a fresh receipt beyond stale visible text', async () => {
  const commentDevices = await registry();
  const commentRegistered = await commentDevices.registerDevice(device());
  const staleComment = await executeIosAction({
    device: {
      ...commentRegistered.device,
      registry: commentDevices,
      healthCheck: strictHealth,
    },
    account: account({
      driver: new FakeDriver({
        existingCommentText: 'hello',
        receiptMarkers: false,
        receiptCountSupport: false,
      }),
    }),
    creator: { creator_uid: 'creator-001' },
    action: 'comment',
    payload: { comment: 'hello', testOnly: true },
  });
  assert.equal(staleComment.verified, false);
  assert.equal(staleComment.error_code, 'unknown');
  assert.equal(staleComment.manual_takeover.status, 'manual_required');

  const messageDevices = await registry();
  const messageRegistered = await messageDevices.registerDevice(device());
  const staleMessage = await executeIosAction({
    device: {
      ...messageRegistered.device,
      registry: messageDevices,
      healthCheck: strictHealth,
    },
    account: account({
      driver: new FakeDriver({
        existingMessageText: 'hello again',
        receiptMarkers: false,
        receiptCountSupport: false,
      }),
    }),
    creator: { creator_uid: 'creator-001' },
    action: 'message',
    payload: { message: 'hello again', testOnly: true },
  });
  assert.equal(staleMessage.verified, false);
  assert.equal(staleMessage.error_code, 'unknown');
  assert.equal(staleMessage.manual_takeover.status, 'manual_required');
});

test('like and follow require an inactive-to-active transition', async () => {
  const likeDevices = await registry();
  const likeRegistered = await likeDevices.registerDevice(device());
  const alreadyLiked = await executeIosAction({
    device: {
      ...likeRegistered.device,
      registry: likeDevices,
      healthCheck: strictHealth,
    },
    account: account({ driver: new FakeDriver({ likeActive: true }) }),
    creator: { creator_uid: 'creator-001' },
    action: 'like',
  });
  assert.equal(alreadyLiked.verified, false);
  assert.equal(alreadyLiked.error_code, 'already_state');
  assert.equal(alreadyLiked.manual_takeover.status, 'manual_required');

  const followDevices = await registry();
  const followRegistered = await followDevices.registerDevice(device());
  const alreadyFollowed = await executeIosAction({
    device: {
      ...followRegistered.device,
      registry: followDevices,
      healthCheck: strictHealth,
    },
    account: account({ driver: new FakeDriver({ followActive: true }) }),
    creator: { creator_uid: 'creator-001' },
    action: 'follow',
  });
  assert.equal(alreadyFollowed.verified, false);
  assert.equal(alreadyFollowed.error_code, 'already_state');
  assert.equal(alreadyFollowed.manual_takeover.status, 'manual_required');
});

test('ordered like comment follow and message return the same receipt envelope', async () => {
  const devices = await registry();
  const registered = await devices.registerDevice(device());
  const result = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: strictHealth,
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
  assert.match(result.receipt_payload.actions[1].evidence[0], /fresh-item:new:comment-1/);

  const message = await executeIosAction({
    device: {
      ...registered.device,
      registry: devices,
      healthCheck: strictHealth,
    },
    account: account({ driver: new FakeDriver() }),
    creator: { creator_uid: 'creator-001' },
    action: 'message',
    payload: { message: 'hello again', testOnly: true },
  });
  assert.equal(message.verified, true);
  assert.equal(message.receipt_payload.receipt_type, 'dm_receipt');
  assert.match(message.receipt_payload.evidence[0], /fresh-item:new:message-1/);
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
      healthCheck: strictHealth,
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
