export const LOCATOR_VERSION = 'tiktok-web@1';

// These semantic locators are used by the offline fake-browser tests. Provider
// selectors are intentionally only activated when the separately authorized
// pilot flag is set.
export const FAKE_LOCATORS = Object.freeze({
  loginRequired: '[data-outreach-login-required]',
  challenge: '[data-outreach-challenge]',
  creatorSearch: '[data-outreach-creator-search]',
  creatorResult: '[data-outreach-creator-result]',
  profileRoot: '[data-outreach-profile]',
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
  loginRequired: '[data-e2e="login-button"]',
  challenge: '[data-e2e="captcha-container"]',
  creatorSearch: '[data-e2e="search-input"]',
  creatorResult: '[data-e2e="search-user-container"]',
  profileRoot: '[data-e2e="user-page"]',
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
  return value?.first ?? value;
}

function locatorFor(page, selector) {
  if (!page || typeof page.locator !== 'function') return null;
  return first(page.locator(selector));
}

async function visible(locator) {
  if (!locator) return false;
  if (typeof locator.isVisible === 'function') return Boolean(await locator.isVisible());
  if (typeof locator.visible === 'boolean') return locator.visible;
  return true;
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

async function receiptVisible(page, selector, expectedText = null) {
  const locator = locatorFor(page, selector);
  if (!await visible(locator)) return false;
  if (!expectedText) return true;
  const content = (await text(locator)).trim();
  return content.includes(expectedText);
}

export class TikTokWebPageObjects {
  constructor({ page, locators = null, pilotEnabled = false } = {}) {
    if (!page) throw new TypeError('page is required.');
    this.page = page;
    this.pilotEnabled = pilotAllowed(pilotEnabled);
    if (locators) {
      this.locators = Object.freeze({ ...FAKE_LOCATORS, ...locators });
    } else if (this.pilotEnabled) {
      this.locators = PILOT_LOCATORS;
    } else {
      throw new WebActionError('pilot_required', 'Real provider selectors require the authorized pilot flag.');
    }
  }

  async prepareCreator(creator = {}) {
    await checkGate(this.page, this.locators);
    if (creator.profile_url && this.pilotEnabled && typeof this.page.goto === 'function') {
      await this.page.goto(creator.profile_url);
    } else if (creator.handle && typeof this.page.locator === 'function') {
      const search = locatorFor(this.page, this.locators.creatorSearch);
      if (search && await visible(search)) {
        await fill(search, creator.handle);
        if (typeof search.press === 'function') await search.press('Enter');
        const result = locatorFor(this.page, this.locators.creatorResult);
        if (await visible(result) && typeof result.click === 'function') await result.click();
      }
    }
    const profile = locatorFor(this.page, this.locators.profileRoot);
    if (!await visible(profile)) throw new WebActionError('selector_missing', 'Creator profile could not be read back.');
    return { verification_source: `${LOCATOR_VERSION}:profile` };
  }

  async like() {
    await checkGate(this.page, this.locators);
    const control = locatorFor(this.page, this.locators.likeButton);
    if (!await visible(control)) throw new WebActionError('selector_missing', 'Like control is missing.');
    if (!await isActive(control)) {
      await click(control);
      if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    }
    if (!await isActive(control)) throw new WebActionError('unknown', 'Like click did not produce a verified active state.');
    return { action: 'like', evidence: `${LOCATOR_VERSION}:like`, state: 'active' };
  }

  async comment(commentText) {
    if (typeof commentText !== 'string' || !commentText.trim()) {
      throw new WebActionError('provider_rejected', 'Comment text is required.');
    }
    await checkGate(this.page, this.locators);
    const input = locatorFor(this.page, this.locators.commentInput);
    const submit = locatorFor(this.page, this.locators.commentSubmit);
    await fill(input, commentText);
    await click(submit);
    if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    if (!await receiptVisible(this.page, this.locators.commentReceipt, commentText)) {
      throw new WebActionError('unknown', 'Comment was not verified by a provider read-back.');
    }
    return { action: 'comment', evidence: `${LOCATOR_VERSION}:comment`, state: 'visible', text: commentText };
  }

  async follow() {
    await checkGate(this.page, this.locators);
    const control = locatorFor(this.page, this.locators.followButton);
    if (!await visible(control)) throw new WebActionError('selector_missing', 'Follow control is missing.');
    if (!await isActive(control)) {
      await click(control);
      if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    }
    if (!await isActive(control)) throw new WebActionError('unknown', 'Follow click did not produce a verified active state.');
    return { action: 'follow', evidence: `${LOCATOR_VERSION}:follow`, state: 'active' };
  }

  async message(messageText) {
    if (typeof messageText !== 'string' || !messageText.trim()) {
      throw new WebActionError('provider_rejected', 'Message text is required.');
    }
    await checkGate(this.page, this.locators);
    const input = locatorFor(this.page, this.locators.messageInput);
    const submit = locatorFor(this.page, this.locators.messageSubmit);
    await fill(input, messageText);
    await click(submit);
    if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(0);
    if (!await receiptVisible(this.page, this.locators.messageReceipt, messageText)) {
      throw new WebActionError('unknown', 'Message was not verified by a provider read-back.');
    }
    return { action: 'message', evidence: `${LOCATOR_VERSION}:message`, state: 'visible', text: messageText };
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
