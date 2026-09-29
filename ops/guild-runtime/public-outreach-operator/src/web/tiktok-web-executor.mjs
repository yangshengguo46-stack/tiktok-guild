import crypto from 'node:crypto';

import { createTikTokPageObjects, WebActionError } from './page-objects.mjs';

const ORDER = Object.freeze(['like', 'comment', 'follow']);
const MANUAL_CODES = new Set([
  'login_required',
  'challenge',
  'selector_missing',
  'provider_rejected',
  'unknown',
  'pilot_required',
]);

function safeId(value, fallback = 'unknown') {
  return typeof value === 'string' && value ? value : fallback;
}

function cancelled(signal) {
  return Boolean(signal?.aborted);
}

async function invokeHook(account, names, ...args) {
  for (const name of names) {
    if (typeof account?.[name] === 'function') return account[name](...args);
  }
  return null;
}

async function manualTakeover(account, details) {
  if (!MANUAL_CODES.has(details.error_code)) return null;
  await invokeHook(account, ['pause', 'pauseAccount', 'markPaused'], details);
  return invokeHook(account, ['createManualTakeover', 'requestManualTakeover', 'manualTakeover'], details);
}

function normalizeError(error) {
  if (error instanceof WebActionError) {
    return { error_code: error.error_code, message: error.message, details: error.details };
  }
  const code = typeof error?.error_code === 'string' ? error.error_code : 'unknown';
  return { error_code: code, message: error instanceof Error ? error.message : 'Provider result is unknown.' };
}

function orderedActions(action) {
  if (Array.isArray(action)) return action;
  return [action];
}

function validateOrder(actions) {
  const publicActions = actions.filter((item) => ORDER.includes(item));
  const expected = [...publicActions].sort((left, right) => ORDER.indexOf(left) - ORDER.indexOf(right));
  if (publicActions.some((item, index) => item !== expected[index])) {
    throw new WebActionError('provider_rejected', 'Public outreach actions must run in like → comment → follow order.');
  }
}

function receiptFor({ account, creator, action, evidence, payload }) {
  const senderAccountId = account.sender_account_id ?? account.account_id ?? account.external_ref;
  const creatorUid = creator.creator_uid ?? creator.uid ?? creator.user_id;
  const providerRef = `tiktok-web:${safeId(senderAccountId)}:${safeId(creatorUid)}:${action}:${crypto.randomUUID()}`;
  return {
    provider_ref: providerRef,
    receipt_payload: {
      receipt_type: action === 'message' ? 'dm_receipt' : 'public_action_receipt',
      action,
      sender_account_id: senderAccountId ?? null,
      creator_uid: creatorUid ?? null,
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

async function pageFor(account) {
  if (account.page) return { page: account.page, owned: false };
  const context = account.context ?? account.browser_context;
  if (context && typeof context.newPage === 'function') {
    return { page: await context.newPage(), owned: true };
  }
  throw new WebActionError('unknown', 'No browser page or persistent context is available.');
}

export async function executeWebAction({
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
  const actions = orderedActions(action);
  if (!actions.length || actions.some((item) => typeof item !== 'string')) {
    return { verified: false, error_code: 'provider_rejected', message: 'A web action is required.' };
  }
  try {
    validateOrder(actions);
  } catch (error) {
    const details = normalizeError(error);
    const takeover = await manualTakeover(resolvedAccount, details);
    return { verified: false, ...details, ...(takeover ? { manual_takeover: takeover } : {}) };
  }
  if (cancelled(signal)) return { verified: false, error_code: 'cancelled' };

  let browserPage;
  let ownedPage = false;
  try {
    ({ page: browserPage, owned: ownedPage } = await pageFor(resolvedAccount));
    const pageObjects = createTikTokPageObjects({
      page: browserPage,
      locators: payload.locators ?? resolvedAccount.locators,
      pilotEnabled: payload.pilotEnabled ?? resolvedAccount.pilot_enabled,
    });
    const receipts = [];
    for (const currentAction of actions) {
      if (cancelled(signal)) return { verified: false, error_code: 'cancelled' };
      const result = await pageObjects.run(currentAction, { ...payload, creator });
      if (!result || !result.evidence) throw new WebActionError('unknown', 'Action completed without read-back evidence.');
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
    const takeover = await manualTakeover(resolvedAccount, details);
    return {
      verified: false,
      ...details,
      ...(takeover ? { manual_takeover: takeover } : {}),
    };
  } finally {
    if (ownedPage) {
      try {
        await browserPage?.close?.();
      } catch {
        // Closing a page must not turn a verified provider receipt into a retry.
      }
    }
  }
}
