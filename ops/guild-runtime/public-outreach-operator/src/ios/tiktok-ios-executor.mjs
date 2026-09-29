import { freshMatchingItem, readIdentity, receiptItem, senderMatches } from '../provider-proof.mjs';
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
  'pilot_required',
  'already_state',
  'sender_identity_missing',
  'sender_identity_mismatch',
]);

export const IOS_LOCATORS = Object.freeze({
  loggedInSender: { accessibility_id: 'current-user' },
  loginRequired: { accessibility_id: 'login-button' },
  challenge: { accessibility_id: 'captcha-container' },
  creatorSearch: { accessibility_id: 'creator-search' },
  creatorResult: { accessibility_id: 'creator-search-result' },
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

function normalizeHandle(value) {
  return typeof value === 'string' ? value.replace(/^@/, '').toLowerCase() : null;
}

function pilotAllowed(explicit) {
  if (explicit === true) return true;
  return ['1', 'true', 'yes'].includes(String(process.env.PUBLIC_OUTREACH_TIKTOK_PILOT ?? '').toLowerCase());
}

function locatorDescription(locator) {
  if (typeof locator === 'string') return `accessibility_id=${locator}`;
  if (!locator || typeof locator !== 'object') return 'unknown';
  const key = ['accessibility_id', 'accessibilityId', 'text', 'label', 'predicate', 'class_chain']
    .find((candidate) => locator[candidate] !== undefined);
  return key ? `${key}=${String(locator[key])}` : 'coordinate-only';
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

async function receiptSnapshot(session, locator) {
  let elements;
  if (typeof session.findAll === 'function') elements = await session.findAll(locator);
  else { try { elements = [await session.find(locator)]; } catch { elements = []; } }
  const items = [];
  for (const element of elements) if (await visible(element)) items.push(await receiptItem(element));
  return items;
}

function transitionEvidence(locatorVersion, action, locator, before, after) {
  return `${locatorVersion}:${action}:${locatorDescription(locator)}:transition:${String(before)}->${String(after)}`;
}

function receiptFor({ account, creator, action, evidence, payload, locatorVersion, result }) {
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
      observed_sender: account.observed_sender,
      observed_creator: account.observed_creator,
      transition: result.transition ?? null,
      provider_receipt_id: result.provider_receipt_id ?? null,
      readback_proof: result.proof ?? null,
      locator_version: locatorVersion,
      payload: action === 'comment' || action === 'message'
        ? { text: action === 'comment' ? payload.comment ?? payload.comment_text ?? payload.text ?? null : payload.message ?? payload.message_text ?? payload.text ?? null }
        : {},
      observed_at: new Date().toISOString(),
    },
    verification_source: evidence,
    verified: true,
  };
}

async function prepareCreator(session, creator, locators) {
  let observed = null;
  const hasSearchTarget = creator.profile_url || creator.profileUrl || creator.handle || creator.username;
  if (typeof session.navigateToCreator === 'function' && hasSearchTarget) {
    observed = await session.navigateToCreator({ creator, locators });
  } else if (typeof session.readCreatorIdentity === 'function') {
    observed = await session.readCreatorIdentity(locators.creatorIdentity);
  } else if (typeof session.prepareCreator === 'function') {
    observed = await session.prepareCreator(creator);
  } else {
    const profile = await session.find(locators.profileRoot);
    if (!await visible(profile)) throw new IosSessionError('selector_missing', 'Creator profile is not visible.');
    const identity = await session.find(locators.creatorIdentity);
    observed = {
      creator_uid: await attribute(identity, 'data-creator-uid')
        ?? await attribute(identity, 'creator_uid')
        ?? await attribute(identity, 'name')
        ?? await attribute(identity, 'label'),
      handle: await attribute(identity, 'data-creator-handle')
        ?? await attribute(identity, 'data-username')
        ?? await attribute(identity, 'username')
        ?? await attribute(identity, 'name')
        ?? await attribute(identity, 'label'),
    };
  }
  const observedUid = observed?.creator_uid ?? null;
  const observedHandle = observed?.handle ?? null;
  const requestedUid = creatorId(creator);
  const requestedHandle = creator.handle ?? creator.username ?? null;
  if (requestedUid && (!observedUid || String(observedUid) !== String(requestedUid))) {
    throw new IosSessionError('unknown', 'Current profile identity does not match the requested creator.', {
      requested_uid: requestedUid,
      observed_uid: observedUid,
    });
  }
  if (requestedHandle && (!observedHandle || normalizeHandle(observedHandle) !== normalizeHandle(requestedHandle))) {
    throw new IosSessionError('unknown', 'Current profile handle does not match the requested creator.', {
      requested_handle: requestedHandle,
      observed_handle: observedHandle,
    });
  }
  if (!requestedUid && !requestedHandle) {
    throw new IosSessionError('provider_rejected', 'A canonical creator UID or handle is required.');
  }
  if (!observedUid && !observedHandle) {
    throw new IosSessionError('unknown', 'Creator identity could not be verified.');
  }
  return {
    creator_uid: observedUid,
    handle: observedHandle,
    verification_source: observed?.verification_source ?? 'tiktok-ios@1:profile-identity',
  };
}

async function runAction(session, action, payload, locators, locatorVersion, observedSender, creatorUid) {
  switch (action) {
    case 'like': {
      const control = await session.find(locators.likeButton);
      if (!await visible(control)) throw new IosSessionError('selector_missing', 'Like control is missing.');
      const beforeActive = await active(control);
      if (beforeActive) {
        throw new IosSessionError('already_state', 'Like was already active before this task.', {
          action,
          state: 'active',
        });
      }
      await session.tap(locators.likeButton);
      const readBack = await session.find(locators.likeButton);
      const afterActive = await active(readBack);
      if (!afterActive) throw new IosSessionError('unknown', 'Like did not produce an inactive-to-active transition.');
      return {
        action,
        evidence: transitionEvidence(locatorVersion, action, locators.likeButton, beforeActive, afterActive),
        transition: { before: beforeActive, after: afterActive },
      };
    }
    case 'follow': {
      const control = await session.find(locators.followButton);
      if (!await visible(control)) throw new IosSessionError('selector_missing', 'Follow control is missing.');
      const beforeActive = await active(control);
      if (beforeActive) {
        throw new IosSessionError('already_state', 'Follow was already active before this task.', {
          action,
          state: 'active',
        });
      }
      await session.tap(locators.followButton);
      const readBack = await session.find(locators.followButton);
      const afterActive = await active(readBack);
      if (!afterActive) throw new IosSessionError('unknown', 'Follow did not produce an inactive-to-active transition.');
      return {
        action,
        evidence: transitionEvidence(locatorVersion, action, locators.followButton, beforeActive, afterActive),
        transition: { before: beforeActive, after: afterActive },
      };
    }
    case 'comment': {
      const value = payload.comment ?? payload.comment_text ?? payload.text;
      if (typeof value !== 'string' || !value.trim()) throw new IosSessionError('provider_rejected', 'Comment text is required.');
      const before = await receiptSnapshot(session, locators.commentReceipt);
      await session.type(locators.commentInput, value);
      await session.tap(locators.commentSubmit);
      const after = await receiptSnapshot(session, locators.commentReceipt);
      const fresh = freshMatchingItem(before, after, value, observedSender, creatorUid);
      if (!fresh) throw new IosSessionError('unknown', 'Comment did not produce fresh provider receipt evidence.', {
        before,
        after,
      });
      return {
        action,
        evidence: `${locatorVersion}:${action}:${locatorDescription(locators.commentReceipt)}:fresh-item:new:${fresh.identity}`,
        provider_receipt_id: fresh.identity,
        proof: fresh,
      };
    }
    case 'message': {
      const value = payload.message ?? payload.message_text ?? payload.text;
      if (typeof value !== 'string' || !value.trim()) throw new IosSessionError('provider_rejected', 'Message text is required.');
      const before = await receiptSnapshot(session, locators.messageReceipt);
      await session.type(locators.messageInput, value);
      await session.tap(locators.messageSubmit);
      const after = await receiptSnapshot(session, locators.messageReceipt);
      const fresh = freshMatchingItem(before, after, value, observedSender, creatorUid);
      if (!fresh) throw new IosSessionError('unknown', 'Message did not produce fresh provider receipt evidence.', {
        before,
        after,
      });
      return {
        action,
        evidence: `${locatorVersion}:${action}:${locatorDescription(locators.messageReceipt)}:fresh-item:new:${fresh.identity}`,
        provider_receipt_id: fresh.identity,
        proof: fresh,
      };
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
  try {
    if (!actions.length || actions.some((item) => typeof item !== 'string')) {
      throw new IosSessionError('provider_rejected', 'An iOS action is required.');
    }
    validateOrder(actions);
    if (cancelled(signal)) return { verified: false, error_code: 'cancelled' };
    const fakeOnly = payload.testOnly === true && process.env.PUBLIC_OUTREACH_FAKE_BROWSER === '1';
    if (!pilotAllowed(payload.pilotEnabled ?? resolvedAccount.pilot_enabled) && !fakeOnly) {
      throw new IosSessionError('pilot_required', 'iOS external actions require the authorized pilot gate.');
    }
    const customLocators = payload.locators ?? resolvedAccount.locators ?? null;
    if (customLocators && !pilotAllowed(payload.pilotEnabled ?? resolvedAccount.pilot_enabled)) {
      throw new IosSessionError('pilot_required', 'Custom iOS locators require the authorized pilot flag.');
    }
    const locatorVersion = customLocators ? 'tiktok-ios@1:pilot-custom' : 'tiktok-ios@1';
    const locators = Object.freeze({ ...IOS_LOCATORS, ...(customLocators ?? {}) });
    if (!session) {
      session = createXcuitestSession({
        device,
        driver: account?.driver ?? resolvedAccount.driver ?? device.driver,
        driverFactory: account?.driverFactory ?? resolvedAccount.driverFactory ?? device.driverFactory,
        registry: device.registry,
        healthCheck: device.healthCheck,
        navigationAdapter: account?.navigationAdapter
          ?? resolvedAccount.navigationAdapter
          ?? device.navigationAdapter,
        evidenceRoot: payload.evidenceRoot ?? device.evidenceRoot,
      });
      ownedSession = true;
    }
    if (typeof session.launch === 'function') await session.launch();
    let senderElement;
    try { senderElement = await session.find(locators.loggedInSender); } catch { throw new IosSessionError('sender_identity_missing', 'Logged-in sender identity is unavailable.'); }
    const observedSender = await readIdentity(senderElement, 'sender');
    if (!senderMatches(observedSender, resolvedAccount.external_ref)) throw new IosSessionError('sender_identity_mismatch', 'Logged-in sender differs from registered account.');
    const receiptAccount = { ...resolvedAccount, observed_sender: observedSender };
    const resolvedCreator = await prepareCreator(session, creator, locators);
    receiptAccount.observed_creator = { creator_uid: resolvedCreator.creator_uid, handle: resolvedCreator.handle };
    const receiptCreator = { ...creator, ...resolvedCreator };
    const receipts = [];
    for (const currentAction of actions) {
      if (cancelled(signal)) return { verified: false, error_code: 'cancelled' };
      const result = await runAction(session, currentAction, payload, locators, locatorVersion, observedSender, receiptCreator.creator_uid);
      receipts.push(receiptFor({
        account: receiptAccount,
        creator: receiptCreator,
        action: currentAction,
        evidence: result.evidence,
        payload,
        result,
        locatorVersion,
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
