import { semanticLocator } from './device-runtime.mjs';
import { normalizeIdentity } from '../provider-proof.mjs';

const ACTIONS = new Set(['like', 'comment', 'follow', 'message']);

function failure(error_code, message = error_code, manual_required = false) {
  return { verified: false, error_code, message, manual_required };
}

function platformUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['tiktok.com', 'www.tiktok.com'].includes(url.hostname) ? url : null;
  } catch { return null; }
}

function requiredLocators(locators, action) {
  if (!locators || typeof locators.version !== 'string' || !locators.version.trim()
    || !locators.senderIdentity || !locators.creatorIdentity) return false;
  const fields = {
    like: ['videoIdentity', 'videoIdentityProof', 'likeButton', 'likeState'],
    follow: ['followButton', 'followState'],
    comment: ['videoIdentity', 'videoIdentityProof', 'commentInput', 'commentSubmit', 'commentReceipt', 'commentProof'],
    message: ['messageInput', 'messageSubmit', 'messageReceipt', 'messageProof'],
  }[action] ?? [];
  return fields.every((field) => locators[field]);
}

async function find(driver, locator) { return driver.findElement(...semanticLocator(locator)); }

async function identity(element, spec) {
  const attribute = spec?.attribute ?? 'content-desc';
  const value = await element.getAttribute(attribute);
  return normalizeIdentity(value);
}

async function items(driver, locator, proof) {
  if (!proof || !['id_attribute', 'sender_attribute', 'target_attribute'].every((field) => typeof proof[field] === 'string' && proof[field])) {
    throw Object.assign(new Error('Versioned provider receipt attributes are required.'), { error_code: 'locator_evidence_required' });
  }
  const elements = await driver.findElements(...semanticLocator(locator));
  if (elements.length > 100) throw Object.assign(new Error('Provider receipt baseline exceeds the readable bound.'), { error_code: 'receipt_baseline_unknown' });
  const rows = [];
  for (const element of elements) {
    const [id, sender, target, text] = await Promise.all([
      element.getAttribute(proof.id_attribute), element.getAttribute(proof.sender_attribute),
      element.getAttribute(proof.target_attribute), element.getText(),
    ]);
    const stableId = typeof id === 'string' && id.trim() ? id.trim() : null;
    rows.push({ id: stableId, sender: normalizeIdentity(sender), target: normalizeIdentity(target), text });
  }
  return rows;
}

export async function executeAndroidAction({ driver, account, creator, action, payload = {}, locators, appPackage, signal, onWrite = () => {} } = {}) {
  if (!ACTIONS.has(action)) return failure('unsupported_action');
  if (!requiredLocators(locators, action)) return failure('locator_evidence_required');
  if (!driver || !account?.external_ref || !creator?.creator_uid || !appPackage) return failure('pilot_configuration_required');
  if (signal?.aborted) return failure('cancelled');
  const videoUrl = action === 'like' || action === 'comment' ? platformUrl(payload.video_url) : null;
  const profileUrl = action === 'follow' || action === 'message' ? platformUrl(creator.profile_url) : null;
  const targetUrl = videoUrl ?? profileUrl;
  if (!targetUrl) return failure('target_url_required');
  const videoId = videoUrl?.pathname.match(/\/video\/(\d+)/)?.[1] ?? null;
  if (videoUrl && !videoId) return failure('video_id_required');
  let wrote = false;
  try {
    await driver.activateApp(appPackage);
    const observedSender = await identity(await find(driver, locators.senderIdentity), locators.senderIdentityProof);
    if (!observedSender || observedSender !== normalizeIdentity(account.external_ref)) return failure('sender_identity_mismatch', 'Current account does not match the registered sender.', true);
    await driver.openDeepLink(targetUrl.href, appPackage);
    const observedCreator = await identity(await find(driver, locators.creatorIdentity), locators.creatorIdentityProof);
    if (!creator.handle || observedCreator !== normalizeIdentity(creator.handle)) return failure('creator_identity_mismatch', 'Target creator is not confirmed on screen.', true);
    if (videoId) {
      const attribute = locators.videoIdentityProof?.attribute;
      if (typeof attribute !== 'string' || !attribute) return failure('locator_evidence_required');
      const observedVideoId = await (await find(driver, locators.videoIdentity)).getAttribute(attribute);
      if (String(observedVideoId ?? '') !== videoId) return failure('video_identity_mismatch', 'The opened video does not match the task target.', true);
    }
    const receiptBase = {
      receipt_type: action === 'message' ? 'dm_receipt' : 'public_action_receipt', action,
      sender_account_id: account.sender_account_id, creator_uid: creator.creator_uid,
      observed_sender: observedSender, observed_creator: observedCreator,
      locator_version: locators.version, target_url: targetUrl.href, observed_at: new Date().toISOString(),
    };
    if (action === 'like' || action === 'follow') {
      const control = action === 'like' ? locators.likeButton : locators.followButton;
      const state = action === 'like' ? locators.likeState : locators.followState;
      if (!state || typeof state.attribute !== 'string' || !state.attribute || typeof state.active !== 'string' || !state.active
        || typeof state.inactive !== 'string' || !state.inactive || state.inactive === state.active) return failure('locator_evidence_required');
      const before = await (await find(driver, control)).getAttribute(state.attribute);
      if (before === state.active) return failure('already_state', 'The action was already active before this task.', true);
      if (before !== state.inactive) return failure('state_baseline_unknown', 'No recognized inactive state was observed.', true);
      const button = await find(driver, control);
      if (signal?.aborted) return failure('cancelled');
      onWrite(); wrote = true;
      await button.click();
      const after = await (await find(driver, control)).getAttribute(state.attribute);
      if (after !== state.active) return failure('write_unknown', 'No verified state transition was observed.', true);
      const providerRef = action === 'like' ? videoId : creator.creator_uid;
      return { verified: true, provider_ref: providerRef, verification_source: `${locators.version}:android-state-readback`,
        receipt_payload: { ...receiptBase, provider_ref: providerRef, transition: { before, after }, evidence: [`${state.attribute}:${before}->${after}`] } };
    }
    const value = action === 'comment' ? payload.comment : payload.message;
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) return failure('text_required');
    const prefix = action === 'comment' ? 'comment' : 'message';
    const proof = locators[`${prefix}Proof`];
    const receiptLocator = locators[`${prefix}Receipt`];
    const before = await items(driver, receiptLocator, proof);
    if (before.some((item) => !item.id)) return failure('receipt_baseline_unknown', 'Existing items lack stable platform IDs.', true);
    const input = await find(driver, locators[`${prefix}Input`]);
    if (signal?.aborted) return failure('cancelled');
    onWrite(); wrote = true;
    await input.clear(); await input.setValue(value);
    const submit = await find(driver, locators[`${prefix}Submit`]);
    if (signal?.aborted) return failure('cancelled', 'Cancelled with an unsubmitted draft.', true);
    await submit.click();
    const after = await items(driver, receiptLocator, proof);
    const priorIds = new Set(before.map((item) => item.id));
    const target = normalizeIdentity(creator.handle);
    const fresh = after.find((item) => item.id && !priorIds.has(item.id) && item.text?.trim() === value.trim()
      && item.sender === observedSender && item.target === target);
    if (!fresh) return failure('write_unknown', 'No fresh platform item matched sender, target and exact text.', true);
    return { verified: true, provider_ref: String(fresh.id), verification_source: `${locators.version}:android-fresh-item`,
      receipt_payload: { ...receiptBase, provider_ref: String(fresh.id), text: value, evidence: ['fresh-platform-item'], readback_proof: fresh } };
  } catch (error) {
    return failure(wrote ? 'write_unknown' : (error.error_code ?? 'provider_unknown'), error.message, true);
  }
}
