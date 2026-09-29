import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeWebAction } from '../src/web/tiktok-web-executor.mjs';
import { FAKE_LOCATORS } from '../src/web/page-objects.mjs';
import { createPlaywrightPool } from '../src/web/playwright-pool.mjs';
import { createProfileRegistry } from '../src/web/profile-registry.mjs';

process.env.PUBLIC_OUTREACH_FAKE_BROWSER = '1';

class FakeLocator {
  constructor({ visible = false, text = '', attributes = {}, onClick = null, onFill = null } = {}) {
    this.visible = visible;
    this.text = text;
    this.attributes = { ...attributes };
    this.onClick = onClick;
    this.onFill = onFill;
  }

  async isVisible() {
    return this.visible;
  }

  async getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  async textContent() {
    return this.text;
  }

  async count() {
    return this.countValue ?? (this.visible ? 1 : 0);
  }

  async click() {
    await this.onClick?.(this);
  }

  async fill(value) {
    this.value = value;
    await this.onFill?.(value, this);
  }

  async press() {}
}

class FakePage {
  constructor({
    login = false,
    challenge = false,
    creatorUid = 'creator_001',
    creatorHandle = 'creator',
    searchable = false,
    existingComment = null,
    existingMessage = null,
  } = {}) {
    this.controls = new Map();
    this.controls.set(FAKE_LOCATORS.loginRequired, new FakeLocator({ visible: login }));
    this.controls.set(FAKE_LOCATORS.challenge, new FakeLocator({ visible: challenge }));
    this.controls.set(FAKE_LOCATORS.profileRoot, new FakeLocator({ visible: true }));
    this.controls.set(FAKE_LOCATORS.creatorIdentity, new FakeLocator({
      visible: true,
      attributes: { 'data-creator-uid': creatorUid, 'data-creator-handle': creatorHandle },
    }));
    this.controls.set(FAKE_LOCATORS.creatorSearch, new FakeLocator({ visible: searchable }));
    this.controls.set(FAKE_LOCATORS.creatorResult, new FakeLocator({ visible: searchable }));
    this.controls.set(FAKE_LOCATORS.likeButton, new FakeLocator({
      visible: true,
      attributes: { 'aria-pressed': 'false' },
      onClick: async (locator) => { locator.attributes['aria-pressed'] = 'true'; },
    }));
    const commentReceipt = new FakeLocator({
      visible: existingComment !== null,
      text: existingComment ?? '',
      attributes: existingComment !== null ? { 'data-receipt-id': 'old-comment' } : {},
    });
    this.controls.set(FAKE_LOCATORS.commentReceipt, commentReceipt);
    this.controls.set(FAKE_LOCATORS.commentInput, new FakeLocator({ visible: true }));
    this.controls.set(FAKE_LOCATORS.commentSubmit, new FakeLocator({
      visible: true,
      onClick: async () => {
        const previousCount = commentReceipt.countValue ?? (commentReceipt.visible ? 1 : 0);
        commentReceipt.visible = true;
        commentReceipt.text = this.controls.get(FAKE_LOCATORS.commentInput).value;
        commentReceipt.countValue = previousCount + 1;
        commentReceipt.attributes['data-receipt-id'] = `comment-${commentReceipt.countValue}`;
      },
    }));
    this.controls.set(FAKE_LOCATORS.followButton, new FakeLocator({
      visible: true,
      attributes: { 'aria-pressed': 'false' },
      onClick: async (locator) => { locator.attributes['aria-pressed'] = 'true'; },
    }));
    const messageReceipt = new FakeLocator({
      visible: existingMessage !== null,
      text: existingMessage ?? '',
      attributes: existingMessage !== null ? { 'data-receipt-id': 'old-message' } : {},
    });
    this.controls.set(FAKE_LOCATORS.messageReceipt, messageReceipt);
    this.controls.set(FAKE_LOCATORS.messageInput, new FakeLocator({ visible: true }));
    this.controls.set(FAKE_LOCATORS.messageSubmit, new FakeLocator({
      visible: true,
      onClick: async () => {
        const previousCount = messageReceipt.countValue ?? (messageReceipt.visible ? 1 : 0);
        messageReceipt.visible = true;
        messageReceipt.text = this.controls.get(FAKE_LOCATORS.messageInput).value;
        messageReceipt.countValue = previousCount + 1;
        messageReceipt.attributes['data-receipt-id'] = `message-${messageReceipt.countValue}`;
      },
    }));
  }

  locator(selector) {
    return this.controls.get(selector) ?? new FakeLocator();
  }

  async waitForTimeout() {}
}

const account = (page, hooks = {}) => ({
  sender_account_id: 'ordinary_001',
  page,
  ...hooks,
});

test('executes like, comment, follow in order and returns verified receipts', async () => {
  const page = new FakePage();
  const result = await executeWebAction({
    account: account(page),
    creator: { creator_uid: 'creator_001' },
    action: ['like', 'comment', 'follow'],
    payload: { comment: 'Hello from our creator team.', testOnly: true },
  });
  assert.equal(result.verified, true);
  assert.equal(result.receipt_payload.receipt_type, 'public_action_receipt');
  assert.deepEqual(result.receipt_payload.actions.map((item) => item.action), ['like', 'comment', 'follow']);
  assert.equal(result.receipt_payload.actions[1].payload.text, 'Hello from our creator team.');
  assert.equal(result.verification_source.length, 3);
});

test('handle-only creator identity requires canonical handle read-back', async () => {
  const matched = await executeWebAction({
    account: account(new FakePage({ creatorHandle: 'target_handle', searchable: true })),
    creator: { handle: 'target_handle' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(matched.verified, true);

  const mismatched = await executeWebAction({
    account: account(new FakePage({ creatorHandle: 'other_handle', searchable: true })),
    creator: { handle: 'target_handle' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.error_code, 'unknown');
});

test('message is optional and still requires message read-back', async () => {
  const result = await executeWebAction({
    account: account(new FakePage({ creatorUid: 'creator_002' })),
    creator: { creator_uid: 'creator_002' },
    action: 'message',
    payload: { message: 'Would you be open to chatting?', testOnly: true },
  });
  assert.equal(result.verified, true);
  assert.equal(result.receipt_payload.receipt_type, 'dm_receipt');
  assert.equal(result.receipt_payload.action, 'message');
});

test('stale existing comment or message text without a fresh marker is unknown', async () => {
  const commentPage = new FakePage({ existingComment: 'already posted' });
  commentPage.controls.get(FAKE_LOCATORS.commentReceipt).count = undefined;
  commentPage.controls.get(FAKE_LOCATORS.commentSubmit).onClick = async () => {};
  const comment = await executeWebAction({
    account: account(commentPage),
    creator: { creator_uid: 'creator_001' },
    action: 'comment',
    payload: { comment: 'already posted', testOnly: true },
  });
  assert.equal(comment.verified, false);
  assert.equal(comment.error_code, 'unknown');
  assert.equal(comment.manual_takeover.status, 'manual_required');

  const messagePage = new FakePage({ existingMessage: 'already sent' });
  messagePage.controls.get(FAKE_LOCATORS.messageReceipt).count = undefined;
  messagePage.controls.get(FAKE_LOCATORS.messageSubmit).onClick = async () => {};
  const message = await executeWebAction({
    account: account(messagePage),
    creator: { creator_uid: 'creator_001' },
    action: 'message',
    payload: { message: 'already sent', testOnly: true },
  });
  assert.equal(message.verified, false);
  assert.equal(message.error_code, 'unknown');
});

test('pre-existing like and follow state returns bounded already_state', async () => {
  const likePage = new FakePage();
  likePage.controls.get(FAKE_LOCATORS.likeButton).attributes['aria-pressed'] = 'true';
  const like = await executeWebAction({
    account: account(likePage),
    creator: { creator_uid: 'creator_001' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(like.verified, false);
  assert.equal(like.error_code, 'already_state');

  const followPage = new FakePage();
  followPage.controls.get(FAKE_LOCATORS.followButton).attributes['aria-pressed'] = 'true';
  const follow = await executeWebAction({
    account: account(followPage),
    creator: { creator_uid: 'creator_001' },
    action: 'follow',
    payload: { testOnly: true },
  });
  assert.equal(follow.verified, false);
  assert.equal(follow.error_code, 'already_state');
});

test('login and challenge states pause the account and request manual takeover', async () => {
  const events = [];
  const result = await executeWebAction({
    account: account(new FakePage({ login: true }), {
      pause: async (details) => events.push(['pause', details.error_code]),
      createManualTakeover: async (details) => ({ task_id: 'takeover-1', reason: details.error_code }),
    }),
    creator: { creator_uid: 'creator_003' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'login_required');
  assert.deepEqual(result.manual_takeover.task, { task_id: 'takeover-1', reason: 'login_required' });
  assert.deepEqual(events, [['pause', 'login_required']]);

  const challenge = await executeWebAction({
    account: account(new FakePage({ challenge: true })),
    creator: { creator_uid: 'creator_004' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(challenge.verified, false);
  assert.equal(challenge.error_code, 'challenge');
});

test('missing read-back never becomes success and unknown results create takeover', async () => {
  const page = new FakePage();
  page.controls.get(FAKE_LOCATORS.likeButton).onClick = async () => {};
  let takeoverReason = null;
  const result = await executeWebAction({
    account: account(page, {
      createManualTakeover: async ({ error_code }) => {
        takeoverReason = error_code;
        return { task_id: 'takeover-2' };
      },
    }),
    creator: { creator_uid: 'creator_005' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'unknown');
  assert.equal(takeoverReason, 'unknown');
});

test('cancellation is explicit and ordered actions reject invalid order', async () => {
  const cancelled = await executeWebAction({
    account: account(new FakePage()),
    creator: { creator_uid: 'creator_006' },
    action: 'like',
    payload: { testOnly: true },
    signal: { aborted: true },
  });
  assert.deepEqual(cancelled, { verified: false, error_code: 'cancelled' });

  const outOfOrder = await executeWebAction({
    account: account(new FakePage()),
    creator: { creator_uid: 'creator_007' },
    action: ['follow', 'like'],
    payload: { testOnly: true },
  });
  assert.equal(outOfOrder.verified, false);
  assert.equal(outOfOrder.error_code, 'provider_rejected');
});

test('missing action returns bounded unknown/manual-required state', async () => {
  const result = await executeWebAction({
    account: account(new FakePage()),
    creator: { creator_uid: 'creator_001' },
    action: [],
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'unknown');
  assert.equal(result.manual_takeover.status, 'manual_required');
});

test('stale profile identity and missing search results stop before a write', async () => {
  const stale = await executeWebAction({
    account: account(new FakePage({ creatorUid: 'wrong_creator' })),
    creator: { creator_uid: 'requested_creator' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(stale.verified, false);
  assert.equal(stale.error_code, 'unknown');

  const missingSearchPage = new FakePage({ creatorUid: 'requested_creator' });
  missingSearchPage.controls.get(FAKE_LOCATORS.creatorResult).visible = false;
  const missingSearch = await executeWebAction({
    account: account(missingSearchPage),
    creator: { creator_uid: 'requested_creator', handle: 'requested' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(missingSearch.verified, false);
  assert.equal(missingSearch.error_code, 'selector_missing');
});

test('custom locators cannot bypass the pilot gate', async () => {
  const result = await executeWebAction({
    account: account(new FakePage()),
    creator: { creator_uid: 'creator_001' },
    action: 'like',
    payload: { locators: FAKE_LOCATORS },
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'pilot_required');
  assert.equal(result.manual_takeover.status, 'manual_required');
});

test('a claimed pool lease can be passed directly to the web executor', async () => {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'public-outreach-lease-'));
  const pool = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: async () => ({
      async newPage() {
        return new FakePage({ creatorUid: 'creator_lease' });
      },
      async close() {},
    }),
  });
  await pool.register({ sender_account_id: 'lease_account' });
  const lease = await pool.claim('lease_account');
  const result = await executeWebAction({
    account: lease,
    creator: { creator_uid: 'creator_lease' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(result.verified, true);
  await pool.close();
});

test('pool lease manual takeover persists paused/manual-required state in the registry', async () => {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'public-outreach-takeover-'));
  const pool = createPlaywrightPool({
    profileRoot,
    launchPersistentContext: async () => ({
      async newPage() {
        return new FakePage({ login: true });
      },
      async close() {},
    }),
  });
  await pool.register({ sender_account_id: 'persisted' });
  const lease = await pool.claim('persisted');
  const result = await executeWebAction({
    account: lease,
    creator: { creator_uid: 'creator_001' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(result.verified, false);
  assert.equal(result.manual_takeover.task_status, 'created');
  assert.equal(result.manual_takeover.task.status, 'manual_required');
  const health = await pool.health('persisted');
  assert.equal(health.account.status, 'paused');
  assert.equal(health.account.manual_takeover.status, 'manual_required');
  assert.equal(health.account.manual_takeover.error_code, 'login_required');
  assert.equal(health.account.manual_takeover.task_id, undefined);
  assert.equal(result.manual_takeover.task.task_id, 'manual-takeover:persisted:login_required');
  await pool.close();
});

test('executor refuses an old lease after another owner fences it out', async () => {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'public-outreach-fence-'));
  let current = 1000;
  let ownerAlive = true;
  const registryA = createProfileRegistry({
    profileRoot,
    clock: () => current,
    ownerId: 'executor-owner-a',
    pid: 3111,
    ownerAlive: () => ownerAlive,
  });
  const registryB = createProfileRegistry({
    profileRoot,
    clock: () => current,
    ownerId: 'executor-owner-b',
    pid: 3222,
    ownerAlive: () => ownerAlive,
  });
  const launch = async () => ({
    async newPage() {
      return new FakePage({ creatorUid: 'creator_fenced' });
    },
    async close() {},
  });
  const poolA = createPlaywrightPool({
    profileRoot,
    ownerId: 'executor-owner-a',
    leaseTtlMs: 100,
    heartbeatIntervalMs: 100_000,
    registry: registryA,
    launchPersistentContext: launch,
  });
  const poolB = createPlaywrightPool({
    profileRoot,
    ownerId: 'executor-owner-b',
    leaseTtlMs: 100,
    heartbeatIntervalMs: 100_000,
    registry: registryB,
    launchPersistentContext: launch,
  });
  await poolA.register({ sender_account_id: 'fenced_executor' });
  const oldLease = await poolA.claim('fenced_executor');
  current = 1200;
  ownerAlive = false;
  assert.equal((await poolB.claim('fenced_executor')).ok, true);
  const result = await executeWebAction({
    account: oldLease,
    creator: { creator_uid: 'creator_fenced' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'lease_lost');
  await poolA.close();
  await poolB.close();
});

test('manual takeover remains deterministic when hooks are absent or throw', async () => {
  const absent = await executeWebAction({
    account: account(new FakePage({ login: true })),
    creator: { creator_uid: 'creator_001' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(absent.verified, false);
  assert.equal(absent.manual_takeover.status, 'manual_required');
  assert.equal(absent.manual_takeover.pause_status, 'paused');
  assert.equal(absent.manual_takeover.task_status, 'manual_required');

  const thrown = await executeWebAction({
    account: account(new FakePage({ challenge: true }), {
      pause: async () => { throw new Error('pause unavailable'); },
      createManualTakeover: async () => { throw new Error('task unavailable'); },
    }),
    creator: { creator_uid: 'creator_001' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(thrown.verified, false);
  assert.equal(thrown.error_code, 'challenge');
  assert.equal(thrown.manual_takeover.status, 'manual_required');
  assert.equal(thrown.manual_takeover.pause_status, 'hook_failed');
  assert.equal(thrown.manual_takeover.task_status, 'hook_failed');
});

test('manual takeover persistence is retained when an external hook throws', async () => {
  let persisted = null;
  const result = await executeWebAction({
    account: account(new FakePage({ login: true }), {
      persistManualTakeover: async (details) => {
        persisted = { task_id: 'manual-takeover:ordinary_001:login_required', ...details };
        return persisted;
      },
      createManualTakeover: async () => { throw new Error('external unavailable'); },
    }),
    creator: { creator_uid: 'creator_001' },
    action: 'like',
    payload: { testOnly: true },
  });
  assert.equal(result.verified, false);
  assert.equal(result.manual_takeover.task.task_id, 'manual-takeover:ordinary_001:login_required');
  assert.equal(persisted.error_code, 'login_required');
});
