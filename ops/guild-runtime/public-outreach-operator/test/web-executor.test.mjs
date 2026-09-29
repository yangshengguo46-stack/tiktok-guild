import assert from 'node:assert/strict';
import test from 'node:test';

import { executeWebAction } from '../src/web/tiktok-web-executor.mjs';
import { FAKE_LOCATORS } from '../src/web/page-objects.mjs';

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
  constructor({ login = false, challenge = false } = {}) {
    this.controls = new Map();
    this.controls.set(FAKE_LOCATORS.loginRequired, new FakeLocator({ visible: login }));
    this.controls.set(FAKE_LOCATORS.challenge, new FakeLocator({ visible: challenge }));
    this.controls.set(FAKE_LOCATORS.profileRoot, new FakeLocator({ visible: true }));
    this.controls.set(FAKE_LOCATORS.creatorSearch, new FakeLocator());
    this.controls.set(FAKE_LOCATORS.creatorResult, new FakeLocator());
    this.controls.set(FAKE_LOCATORS.likeButton, new FakeLocator({
      visible: true,
      attributes: { 'aria-pressed': 'false' },
      onClick: async (locator) => { locator.attributes['aria-pressed'] = 'true'; },
    }));
    const commentReceipt = new FakeLocator();
    this.controls.set(FAKE_LOCATORS.commentReceipt, commentReceipt);
    this.controls.set(FAKE_LOCATORS.commentInput, new FakeLocator({ visible: true }));
    this.controls.set(FAKE_LOCATORS.commentSubmit, new FakeLocator({
      visible: true,
      onClick: async () => {
        commentReceipt.visible = true;
        commentReceipt.text = this.controls.get(FAKE_LOCATORS.commentInput).value;
      },
    }));
    this.controls.set(FAKE_LOCATORS.followButton, new FakeLocator({
      visible: true,
      attributes: { 'aria-pressed': 'false' },
      onClick: async (locator) => { locator.attributes['aria-pressed'] = 'true'; },
    }));
    const messageReceipt = new FakeLocator();
    this.controls.set(FAKE_LOCATORS.messageReceipt, messageReceipt);
    this.controls.set(FAKE_LOCATORS.messageInput, new FakeLocator({ visible: true }));
    this.controls.set(FAKE_LOCATORS.messageSubmit, new FakeLocator({
      visible: true,
      onClick: async () => {
        messageReceipt.visible = true;
        messageReceipt.text = this.controls.get(FAKE_LOCATORS.messageInput).value;
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
  locators: FAKE_LOCATORS,
  ...hooks,
});

test('executes like, comment, follow in order and returns verified receipts', async () => {
  const page = new FakePage();
  const result = await executeWebAction({
    account: account(page),
    creator: { creator_uid: 'creator_001' },
    action: ['like', 'comment', 'follow'],
    payload: { comment: 'Hello from our creator team.' },
  });
  assert.equal(result.verified, true);
  assert.equal(result.receipt_payload.receipt_type, 'public_action_receipt');
  assert.deepEqual(result.receipt_payload.actions.map((item) => item.action), ['like', 'comment', 'follow']);
  assert.equal(result.receipt_payload.actions[1].payload.text, 'Hello from our creator team.');
  assert.equal(result.verification_source.length, 3);
});

test('message is optional and still requires message read-back', async () => {
  const result = await executeWebAction({
    account: account(new FakePage()),
    creator: { creator_uid: 'creator_002' },
    action: 'message',
    payload: { message: 'Would you be open to chatting?' },
  });
  assert.equal(result.verified, true);
  assert.equal(result.receipt_payload.receipt_type, 'dm_receipt');
  assert.equal(result.receipt_payload.action, 'message');
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
  });
  assert.equal(result.verified, false);
  assert.equal(result.error_code, 'login_required');
  assert.deepEqual(result.manual_takeover, { task_id: 'takeover-1', reason: 'login_required' });
  assert.deepEqual(events, [['pause', 'login_required']]);

  const challenge = await executeWebAction({
    account: account(new FakePage({ challenge: true })),
    creator: { creator_uid: 'creator_004' },
    action: 'like',
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
    signal: { aborted: true },
  });
  assert.deepEqual(cancelled, { verified: false, error_code: 'cancelled' });

  const outOfOrder = await executeWebAction({
    account: account(new FakePage()),
    creator: { creator_uid: 'creator_007' },
    action: ['follow', 'like'],
  });
  assert.equal(outOfOrder.verified, false);
  assert.equal(outOfOrder.error_code, 'provider_rejected');
});
