import crypto from 'node:crypto';

import { createXcuitestSession, IosSessionError } from './xcuitest-session.mjs';

const ORDER = Object.freeze(['like', 'comment', 'follow']);
const MANUAL_CODES = new Set([
  'wda_unavailable',
  'device_locked',
  'device_offline',
  'app_launch_failed',
  'login_required',
  'challenge',
  'selector_missing',
  'locator_evidence_required',
  'provider_rejected',
  'unknown',
  'manual_required',
]);

export const IOS_LOCATORS = Object.freeze({
  loginRequired: { accessibility_id: 'login-button' },
  challenge: { accessibility_id: 'captcha-container' },
  profileRoot: { accessibility_id: 'user-profile' },
  creatorIdentity: { accessibility_id: 'user-profile' },
  likeButton: { accessibility_id: 'like-button' },
  commentInput: { accessibility_id: 'comment-input' },
  commentSubmit: { accessibility_id: 'comment-submit' },
  commentReceipt: { accessibility_id: 'comment-item' },
  followButton: { accessibility_id: 'follow-button' },
  messageInput: { accessibility_id: 'message-input' },
  messageSubmit: { accessibility_id: 'message-submit' },
  messageReceipt: { accessibility_id: 'message-item' },
});

function cancelled(signal) {
  return Boolean(signal?.aborted);
}

function safeId(value, fallback = 'unknown') {
  return typeof value === 'string' && value ? value : fallback;
}

function accountId(account) {
  return account?.sender_account_id ?? account?.account_id ?? account?.external_ref ?? null;
}

function creatorId(creator) {
  return creator?.creator_uid ?? creator?.uid ?? creator?.user_id ?? null;
}

async function invokeHook(account, names, ...args) {
  for (const name of names) {
    if (typeof account?.[name] === 'function') return account[name](...args);
  }
  return null;
}

async function manualTakeover(account, device, details) {
  if (!MANUAL_CODES.has(details.error_code)) return null;
  let pauseStatus = 'local_state_only';
  let taskStatus = 'manual_required';
  let task = null;
  let pauseError = null;
  let taskError = null;
  try {
    const paused = await invokeHook(account, ['pause', 'pauseAccount', 'markPaused'], details);
    if (paused !== null) pauseStatus = 'paused';
    else if (account && typeof account === 'object') {
      account.status = 'paused';
      pauseStatus = 'paused';
    }
  } catch (error) {
    pauseStatus = 'hook_failed';
    pauseError = error instanceof Error ? error.message : 'pause hook failed';
    try { account.status = 'paused'; } catch { /* native adapter remains authoritative */ }
  }
  try {
    task = await invokeHook(account, ['persistManualTakeover'], details);
    if (task !== null) taskStatus = 'created';
  } catch (error) {
    taskStatus = 'hook_failed';
    taskError = error instanceof Error ? error.message : 'manual takeover persistence failed';
  }
  try {
    const external = await invokeHook(account, ['createManualTakeover', 'requestManualTakeover', 'manualTakeover'], details);
    if (external !== null) {
      task = external;
      taskStatus = 'created';
    }
  } catch (error) {
    if (taskStatus !== 'created') taskStatus = 'hook_failed';
    taskError = error instanceof Error ? error.message : 'manual takeover hook failed';
  }
  if (device?.registry?.markManualRequired && device.device_ref) {
    try {
      await device.registry.markManualRequired(device.device_ref, details);
    } catch {
      // Manual takeover is still returned to the native control plane.
    }
  }
  return {
    status: 'manual_required',
    error_code: details.error_code,
    sender_account_id: accountId(account),
    device_ref: device?.device_ref ?? null,
    pause_status: pauseStatus,
    task_status: taskStatus,
    task,
    ...(pauseError ? { pause_error: pauseError } : {}),
    ...(taskError ? { task_error: taskError } : {}),
  };
}

function normalizeError(error) {
  if (error instanceof IosSessionError) {
    return { error_code: error.error_code, message: error.message, details: error.details };
  }
  const code = typeof error?.error_code === 'string' ? error.error_code : 'unknown';
  return { error_code: code, message: error instanceof Error ? error.message : 'Provider result is unknown.' };
}

function orderedActions(action) {
  return Array.isArray(action) ? action : [action];
}

function validateOrder(actions) {
  const publicActions = actions.filter((item) => ORDER.includes(item));
  const expected = [...publicActions].sort((left, right) => ORDER.indexOf(left) - ORDER.indexOf(right));
  if (publicActions.some((item, index) => item !== expected[index])) {
    throw new IosSessionError('provider_rejected', 'Public outreach actions must run in like → comment → follow order.');
  }
}

async function visible(element) {
  return Boolean(element && (typeof element.isVisible !== 'function' || await element.isVisible()));
}

async function attribute(element, name) {
  if (!element || typeof element.getAttribute !== 'function') return null;
  return element.getAttribute(name);
}

async function text(element) {
  if (!element) return '';
  if (typeof element.textContent === 'function') return (await element.textContent()) ?? '';
  return '';
}

async function active(element) {
  if (!element) return false;
  const values = await Promise.all(['aria-pressed', 'aria-checked', 'value', 'label', 'name'].map((name) => attribute(element, name)));
  if (values.some((value) => ['true', 'active', 'liked', 'following', 'selected'].includes(String(value).toLowerCase()))) return true;
  return /\b(liked|following|已点赞|已关注)\b/i.test(values.join(' '));
}

function receiptFor({ account, creator, action, evidence, payload }) {
  const senderAccountId = accountId(account);
  const creatorUid = creatorId(creator);
  return {
    provider_ref: `tiktok-ios:${safeId(senderAccountId)}:${safeId(creatorUid)}:${action}:${crypto.randomUUID()}`,
    receipt_payload: {
      receipt_type: action === 'message' ? 'dm_receipt' : 'public_action_receipt',
      action,
      sender_account_id: senderAccountId,
      creator_uid: creatorUid,
      evidence: [evidence],
      payload: action === 'comment' || action === 'message'
        ? { text: payload.comment ?? payload.comment_text ?? payload.message ?? payload.message_text ?? payload.text ?? null }
        : {},
      observed_at: new Date().toISOString(),
    },
    verification_source: evidence,
    verified: true,
  };
}

async function prepareCreator(session, creator, locators) {
  if (typeof session.prepareCreator === 'function') return session.prepareCreator(creator);
  const profile = await session.find(locators.profileRoot);
  if (!await visible(profile)) throw new IosSessionError('selector_missing', 'Creator profile is not visible.');
  const identity = await session.find(locators.creatorIdentity);
  const observedUid = await attribute(identity, 'data-creator-uid')
    ?? await attribute(identity, 'creator_uid')
    ?? await attribute(identity, 'name')
    ?? await attribute(identity, 'label');
  const requestedUid = creatorId(creator);
  if (requestedUid && observedUid && String(observedUid) !== String(requestedUid)) {
    throw new IosSessionError('unknown', 'Current profile identity does not match the requested creator.', {
      requested_uid: requestedUid,
      observed_uid: observedUid,
    });
  }
  if (!observedUid && !requestedUid && !creator.handle) {
    throw new IosSessionError('unknown', 'Creator identity could not be verified.');
  }
  return { verification_source: 'tiktok-ios@1:profile-identity' };
}

async function runAction(session, action, payload, locators) {
  switch (action) {
    case 'like': {
      const control = await session.find(locators.likeButton);
      if (!await visible(control)) throw new IosSessionError('selector_missing', 'Like control is missing.');
      if (!await active(control)) await session.tap(locators.likeButton);
      const readBack = await session.find(locators.likeButton);
      if (!await active(readBack)) throw new IosSessionError('unknown', 'Like did not produce a verified active state.');
      return { action, evidence: 'tiktok-ios@1:accessibility_id:like-button' };
    }
    case 'follow': {
      const control = await session.find(locators.followButton);
      if (!await visible(control)) throw new IosSessionError('selector_missing', 'Follow control is missing.');
      if (!await active(control)) await session.tap(locators.followButton);
      const readBack = await session.find(locators.followButton);
      if (!await active(readBack)) throw new IosSessionError('unknown', 'Follow did not produce a verified active state.');
      return { action, evidence: 'tiktok-ios@1:accessibility_id:follow-button' };
    }
    case 'comment': {
      const value = payload.comment ?? payload.comment_text ?? payload.text;
      if (typeof value !== 'string' || !value.trim()) throw new IosSessionError('provider_rejected', 'Comment text is required.');
      await session.type(locators.commentInput, value);
      await session.tap(locators.commentSubmit);
      const receipt = await session.find(locators.commentReceipt);
      if (!await visible(receipt) || !(await text(receipt)).includes(value)) {
        throw new IosSessionError('unknown', 'Comment was not verified by a provider read-back.');
      }
      return { action, evidence: 'tiktok-ios@1:accessibility_id:comment-item' };
    }
    case 'message': {
      const value = payload.message ?? payload.message_text ?? payload.text;
      if (typeof value !== 'string' || !value.trim()) throw new IosSessionError('provider_rejected', 'Message text is required.');
      await session.type(locators.messageInput, value);
      await session.tap(locators.messageSubmit);
      const receipt = await session.find(locators.messageReceipt);
      if (!await visible(receipt) || !(await text(receipt)).includes(value)) {
        throw new IosSessionError('unknown', 'Message was not verified by a provider read-back.');
      }
      return { action, evidence: 'tiktok-ios@1:accessibility_id:message-item' };
    }
    default:
      throw new IosSessionError('provider_rejected', `Unsupported iOS action: ${action}`);
  }
}

export async function executeIosAction({
  device,
  account,
  creator = {},
  action,
  payload = {},
  signal,
} = {}) {
  const resolvedAccount = account?.account ?? account;
  if (!resolvedAccount || typeof resolvedAccount !== 'object') {
    return { verified: false, error_code: 'unknown', message: 'Sender account is required.' };
  }
  if (!device || typeof device !== 'object') {
    return { verified: false, error_code: 'unknown', message: 'iPhone device is required.' };
  }
  const actions = orderedActions(action);
  let session = account?.session ?? resolvedAccount.session ?? device.session ?? null;
  let ownedSession = false;
  const locators = Object.freeze({ ...IOS_LOCATORS, ...(payload.locators ?? resolvedAccount.locators ?? {}) });
  try {
    if (!actions.length || actions.some((item) => typeof item !== 'string')) {
      throw new IosSessionError('provider_rejected', 'An iOS action is required.');
    }
    validateOrder(actions);
    if (cancelled(signal)) return { verified: false, error_code: 'cancelled' };
    if (!session) {
      session = createXcuitestSession({
        device,
        driver: account?.driver ?? resolvedAccount.driver ?? device.driver,
        driverFactory: account?.driverFactory ?? resolvedAccount.driverFactory ?? device.driverFactory,
        registry: device.registry,
        healthCheck: device.healthCheck,
        evidenceRoot: payload.evidenceRoot ?? device.evidenceRoot,
      });
      ownedSession = true;
    }
    if (typeof session.launch === 'function') await session.launch();
    await prepareCreator(session, creator, locators);
    const receipts = [];
    for (const currentAction of actions) {
      if (cancelled(signal)) return { verified: false, error_code: 'cancelled' };
      const result = await runAction(session, currentAction, payload, locators);
      receipts.push(receiptFor({
        account: resolvedAccount,
        creator,
        action: currentAction,
        evidence: result.evidence,
        payload,
      }));
    }
    const final = receipts.at(-1);
    return actions.length === 1
      ? final
      : {
        provider_ref: final.provider_ref,
        receipt_payload: {
          receipt_type: 'public_action_receipt',
          sender_account_id: final.receipt_payload.sender_account_id,
          creator_uid: final.receipt_payload.creator_uid,
          actions: receipts.map((receipt) => receipt.receipt_payload),
          observed_at: new Date().toISOString(),
        },
        verification_source: receipts.map((receipt) => receipt.verification_source),
        verified: receipts.every((receipt) => receipt.verified),
      };
  } catch (error) {
    const details = normalizeError(error);
    let evidence = [];
    if (session?.captureFailureEvidence) {
      try {
        evidence = await session.captureFailureEvidence({ errorCode: details.error_code });
      } catch {
        evidence = [];
      }
    }
    const takeover = await manualTakeover(resolvedAccount, device, details);
    return {
      verified: false,
      ...details,
      evidence,
      manual_takeover: takeover,
    };
  } finally {
    if (ownedSession) {
      try {
        await session?.close?.();
      } catch {
        // Closing a failed session must not change its explicit failure result.
      }
    }
  }
}
