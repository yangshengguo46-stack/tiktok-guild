import { freshMatchingItem, readIdentity, receiptItem, senderMatches } from '../provider-proof.mjs';

export const LOCATOR_VERSION = 'tiktok-web@1';

// These semantic locators are used by the offline fake-browser tests. Provider
// selectors are intentionally only activated when the separately authorized
// pilot flag is set.
export const FAKE_LOCATORS = Object.freeze({
  loggedInSender: '[data-outreach-current-sender]',
  loginRequired: '[data-outreach-login-required]',
  challenge: '[data-outreach-challenge]',
  creatorSearch: '[data-outreach-creator-search]',
  creatorResult: '[data-outreach-creator-result]',
  profileRoot: '[data-outreach-profile]',
  creatorIdentity: '[data-outreach-creator-identity]',
  likeButton: '[data-outreach-like]',
  commentInput: '[data-outreach-comment-input]',
  commentSubmit: '[data-outreach-comment-submit]',
  commentReceipt: '[data-outreach-comment-receipt]',
  followButton: '[data-outreach-follow]',
  messageInput: '[data-outreach-message-input]',
  messageSubmit: '[data-outreach-message-submit]',
  messageReceipt: '[data-outreach-message-receipt]',
});

export const PILOT_LOCATORS = Object.freeze({
  loggedInSender: '[data-e2e="current-user"]',
  loginRequired: '[data-e2e="login-button"]',
  challenge: '[data-e2e="captcha-container"]',
  creatorSearch: '[data-e2e="search-input"]',
  creatorResult: '[data-e2e="search-user-container"]',
  profileRoot: '[data-e2e="user-page"]',
  creatorIdentity: '[data-e2e="user-page"]',
  likeButton: '[data-e2e="browse-like-icon"]',
  commentInput: '[data-e2e="comment-input"]',
  commentSubmit: '[data-e2e="comment-post"]',
  commentReceipt: '[data-e2e="comment-item"]',
  followButton: '[data-e2e="follow-button"]',
  messageInput: '[data-e2e="message-input"]',
  messageSubmit: '[data-e2e="message-send"]',
  messageReceipt: '[data-e2e="message-item"]',
});

export class WebActionError extends Error {
  constructor(errorCode, message = errorCode, details = {}) {
    super(message);
    this.name = 'WebActionError';
    this.error_code = errorCode;
    this.details = details;
  }
}

function pilotAllowed(explicit) {
  if (explicit === true) return true;
  return ['1', 'true', 'yes'].includes(String(process.env.PUBLIC_OUTREACH_TIKTOK_PILOT ?? '').toLowerCase());
}

function first(value) {
  return typeof value?.first === 'function' ? value.first() : value;
}

function locatorFor(page, selector) {
  if (!page || typeof page.locator !== 'function') return null;
  return first(page.locator(selector));
}

function collectionFor(page, selector) {
  if (!page || typeof page.locator !== 'function') return null;
  return page.locator(selector);
}

async function visible(locator) {
  if (!locator) return false;
  if (typeof locator.isVisible === 'function') return Boolean(await locator.isVisible());
  if (typeof locator.visible === 'boolean') return locator.visible;
  return false;
}

async function attribute(locator, name) {
  if (!locator || typeof locator.getAttribute !== 'function') return null;
  return locator.getAttribute(name);
}

async function text(locator) {
  if (!locator) return '';
  if (typeof locator.textContent === 'function') return (await locator.textContent()) ?? '';
  return typeof locator.text === 'string' ? locator.text : '';
}

async function isActive(locator) {
  if (!locator) return false;
  if (typeof locator.isActive === 'function') return Boolean(await locator.isActive());
  const values = await Promise.all([
    attribute(locator, 'aria-pressed'),
    attribute(locator, 'aria-checked'),
    attribute(locator, 'data-state'),
    attribute(locator, 'data-active'),
    attribute(locator, 'data-following'),
  ]);
  if (values.some((value) => ['true', 'active', 'following', 'liked', 'selected'].includes(String(value).toLowerCase()))) {
    return true;
  }
  const content = (await text(locator)).toLowerCase();
  return /\b(liked|following|已点赞|已关注)\b/.test(content);
}

async function click(locator) {
  if (!locator || typeof locator.click !== 'function') throw new WebActionError('selector_missing', 'Required action control is missing.');
  await locator.click();
}

async function receiptSnapshot(collection) {
  if (!collection) return [];
  const count = typeof collection.count === 'function' ? await collection.count() : 1;
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const element = typeof collection.nth === 'function' ? collection.nth(index) : first(collection);
    if (await visible(element)) items.push(await receiptItem(element));
    if (typeof collection.nth !== 'function') break;
  }
  return items;
}

async function fill(locator, value) {
  if (!locator || typeof locator.fill !== 'function') throw new WebActionError('selector_missing', 'Required input control is missing.');
  await locator.fill(value);
}

async function checkGate(page, locators) {
  if (await visible(locatorFor(page, locators.loginRequired))) {
    throw new WebActionError('login_required', 'The provider requires a manual login.');
  }
  if (await visible(locatorFor(page, locators.challenge))) {
    throw new WebActionError('challenge', 'The provider presented a challenge requiring manual takeover.');
  }
}

export class TikTokWebPageObjects {
  constructor({ page, locators = null, pilotEnabled = false, testOnly = false } = {}) {
    if (!page) throw new TypeError('page is required.');
    this.page = page;
    this.pilotEnabled = pilotAllowed(pilotEnabled);
    this.testOnly = testOnly === true && process.env.PUBLIC_OUTREACH_FAKE_BROWSER === '1';
    if (locators && !this.pilotEnabled && !this.testOnly) {
      throw new WebActionError('pilot_required', 'Custom provider selectors require the authorized pilot flag.');
    }
    if (locators && (this.pilotEnabled || this.testOnly)) {
      this.locators = Object.freeze({ ...FAKE_LOCATORS, ...locators });
    } else if (this.pilotEnabled) {
      this.locators = PILOT_LOCATORS;
    } else if (this.testOnly) {
      this.locators = FAKE_LOCATORS;
    } else {
      throw new WebActionError('pilot_required', 'Real provider selectors require the authorized pilot flag.');
    }
  }

  async verifySender(account) {
    await checkGate(this.page, this.locators);
    const element = locatorFor(this.page, this.locators.loggedInSender);
    if (!await visible(element)) throw new WebActionError('sender_identity_missing', 'Logged-in sender identity is unavailable.');
    const observed = await readIdentity(element, 'sender');
    if (!senderMatches(observed, account.external_ref)) {
      throw new WebActionError('sender_identity_mismatch', 'Logged-in sender differs from the registered account.');
    }
    this.observedSender = observed;
    return observed;
  }

  async prepareCreator(creator = {}) {
    await checkGate(this.page, this.locators);
    const creatorUid = creator.creator_uid ?? creator.uid ?? creator.user_id ?? null;
    const creatorHandle = creator.handle ?? creator.username ?? null;
    if (!creatorUid && !creatorHandle) {
      throw new WebActionError('provider_rejected', 'Creator identity is required before a provider write.');
    }
    if (creator.profile_url && this.pilotEnabled && typeof this.page.goto === 'function') {
      await this.page.goto(creator.profile_url);
    } else if (creatorHandle && typeof this.page.locator === 'function') {
      const search = locatorFor(this.page, this.locators.creatorSearch);
      if (!search || !await visible(search)) throw new WebActionError('selector_missing', 'Creator search control is missing.');
      await fill(search, creatorHandle);
      if (typeof search.press === 'function') await search.press('Enter');
      const result = locatorFor(this.page, this.locators.creatorResult);
      if (!result || !await visible(result) || typeof result.click !== 'function') {
        throw new WebActionError('selector_missing', 'Creator search result was not found.');
      }
      await result.click();
    }
    const profile = locatorFor(this.page, this.locators.profileRoot);
    if (!await visible(profile)) throw new WebActionError('selector_missing', 'Creator profile could not be read back.');
    const identityLocator = locatorFor(this.page, this.locators.creatorIdentity);
    if (!await visible(identityLocator)) {
      throw new WebActionError('selector_missing', 'Creator identity read-back is missing.');
    }
    const observedUid = await attribute(identityLocator, 'data-creator-uid')
      ?? await attribute(identityLocator, 'data-user-id')
      ?? await attribute(profile, 'data-creator-uid')
      ?? await attribute(profile, 'data-user-id');
    const observedHandle = await attribute(identityLocator, 'data-creator-handle')
      ?? await attribute(identityLocator, 'data-username')
      ?? await attribute(profile, 'data-creator-handle')
      ?? await attribute(profile, 'data-username');
    if (creatorUid && observedUid !== creatorUid) {
      throw new WebActionError('unknown', 'Current profile identity does not match the requested creator.', {
        requested_uid: creatorUid,
        observed_uid: observedUid,
      });
    }
    if (creatorHandle) {
      if (!observedHandle || String(observedHandle).replace(/^@/, '').toLowerCase() !== String(creatorHandle).replace(/^@/, '').toLowerCase()) {
        throw new WebActionError('unknown', 'Current profile handle does not match the requested creator.', {
          requested_handle: creatorHandle,
          observed_handle: observedHandle,
        });
      }
    }
    if (!observedUid && !observedHandle) {
      throw new WebActionError('unknown', 'Current profile identity could not be verified.');
    }
    this.creatorUid = observedUid;
    this.observedCreator = { creator_uid: observedUid, handle: observedHandle };
    return { verification_source: `${LOCATOR_VERSION}:profile-identity` };
  }

  async like() {
    await checkGate(this.page, this.locators);
    const control = locatorFor(this.page, this.locators.likeButton);
    if (!await visible(control)) throw new WebActionError('selector_missing', 'Like control is missing.');
    const beforeActive = await isActive(control);
    if (beforeActive) throw new WebActionError('already_state', 'Like was already active before this action.');
    await click(control);
    if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    if (beforeActive || !await isActive(control)) {
      throw new WebActionError('unknown', 'Like click did not produce a verified state transition.');
    }
    return { action: 'like', evidence: `${LOCATOR_VERSION}:like-transition`, state: 'active', transition: { before: false, after: true } };
  }

  async comment(commentText) {
    if (typeof commentText !== 'string' || !commentText.trim()) {
      throw new WebActionError('provider_rejected', 'Comment text is required.');
    }
    await checkGate(this.page, this.locators);
    const input = locatorFor(this.page, this.locators.commentInput);
    const submit = locatorFor(this.page, this.locators.commentSubmit);
    const receipt = collectionFor(this.page, this.locators.commentReceipt);
    const before = await receiptSnapshot(receipt);
    await fill(input, commentText);
    await click(submit);
    if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    const after = await receiptSnapshot(receipt);
    const fresh = freshMatchingItem(before, after, commentText, this.observedSender, this.creatorUid);
    if (!fresh) {
      throw new WebActionError('unknown', 'Comment did not produce a fresh provider receipt.');
    }
    return { action: 'comment', evidence: `${LOCATOR_VERSION}:comment-receipt:new:${fresh.identity}`, state: 'visible', text: commentText, provider_receipt_id: fresh.identity, proof: fresh };
  }

  async follow() {
    await checkGate(this.page, this.locators);
    const control = locatorFor(this.page, this.locators.followButton);
    if (!await visible(control)) throw new WebActionError('selector_missing', 'Follow control is missing.');
    const beforeActive = await isActive(control);
    if (beforeActive) throw new WebActionError('already_state', 'Follow was already active before this action.');
    await click(control);
    if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    if (beforeActive || !await isActive(control)) {
      throw new WebActionError('unknown', 'Follow click did not produce a verified state transition.');
    }
    return { action: 'follow', evidence: `${LOCATOR_VERSION}:follow-transition`, state: 'active', transition: { before: false, after: true } };
  }

  async message(messageText) {
    if (typeof messageText !== 'string' || !messageText.trim()) {
      throw new WebActionError('provider_rejected', 'Message text is required.');
    }
    await checkGate(this.page, this.locators);
    const input = locatorFor(this.page, this.locators.messageInput);
    const submit = locatorFor(this.page, this.locators.messageSubmit);
    const receipt = collectionFor(this.page, this.locators.messageReceipt);
    const before = await receiptSnapshot(receipt);
    await fill(input, messageText);
    await click(submit);
    if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    const after = await receiptSnapshot(receipt);
    const fresh = freshMatchingItem(before, after, messageText, this.observedSender, this.creatorUid);
    if (!fresh) {
      throw new WebActionError('unknown', 'Message did not produce a fresh provider receipt.');
    }
    return { action: 'message', evidence: `${LOCATOR_VERSION}:message-receipt:new:${fresh.identity}`, state: 'visible', text: messageText, provider_receipt_id: fresh.identity, proof: fresh };
  }

  async run(action, payload = {}) {
    await this.prepareCreator(payload.creator ?? {});
    switch (action) {
      case 'like': return this.like();
      case 'comment': return this.comment(payload.comment ?? payload.comment_text ?? payload.text);
      case 'follow': return this.follow();
      case 'message': return this.message(payload.message ?? payload.message_text ?? payload.text);
      default: throw new WebActionError('provider_rejected', `Unsupported web action: ${action}`);
    }
  }
}

export function createTikTokPageObjects(options) {
  return new TikTokWebPageObjects(options);
}
