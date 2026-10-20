import { createHash } from 'node:crypto';
import { GuildError } from '../errors.mjs';
import { assertWriteGuard } from './operation-store.mjs';
import { observeNativeMessaging } from './native-evidence.mjs';

const ORIGIN = 'https://live-backstage.tiktok.com';
const MESSAGING_ROUTE = '/portal/anchor/instant-messages';
const SEND_MESSAGE_PATHS = Object.freeze(['/v1/message/send', '/agency_im/agency_im_api/im/agentSendMessageToCreator']);
const SENDER_SELECTOR = '[data-id="backstage_account_identity"], [data-id="backstage_account_menu"], [data-testid="account-identity"]';
const HEADER_SELECTOR = '[data-id="backstage_IM_conversation_header"], [data-id="backstage_IM_chat_header"], [data-testid="conversation-header"]';
const BUBBLE_SELECTOR = '[data-id="backstage_IM_messageList_container"] .im-message-item-right .im-message-layout-bubble, [data-id="backstage_IM_messageList_container"] .im-message-type-text-right';
const normalized = value => String(value ?? '').trim().replace(/^@/, '').toLocaleLowerCase();
const same = (a, b) => normalized(a) === normalized(b);
const sameTarget = (field, a, b) => field === 'recipient_handle'
  ? same(a, b) : String(a ?? '').trim() === String(b ?? '').trim();
const exactTargetLine = (text, target, field) => String(text ?? '').split(/[\n\r]/u).some(line => sameTarget(field, line, target));
const fingerprint = content => createHash('sha256').update(content, 'utf8').digest('hex');
const exactLine = (text, target) => String(text ?? '').split(/[\n\r]/u).some(line => same(line, target));

export function assertSenderIdentity(surface, expectedIdentityText) {
  if (!String(expectedIdentityText ?? '').trim() || !exactLine(surface, expectedIdentityText)) {
    throw new GuildError('authorization_required', 'The authenticated Backstage identity does not match the requested sender account.');
  }
}
async function verifySender(page, senderAccountRef, expectedIdentityText) {
  const profile = page.locator('.im-layout-account h2[class*="profile-name"]');
  if (await profile.count()) {
    if (await profile.count() !== 1 || !await profile.isVisible()) throw new GuildError('authorization_required', 'The selected IM account is missing or ambiguous.');
    const native = observeNativeMessaging(page);
    const accounts = await native.waitFor('accounts');
    const nickname = (await profile.innerText()).trim();
    const matches = accounts?.filter(account => account.nickname === nickname) ?? [];
    const separator = senderAccountRef.indexOf(':');
    const kind = senderAccountRef.slice(0, separator), handle = senderAccountRef.slice(separator + 1);
    if (separator < 1 || matches.length !== 1 || matches[0].kind !== kind || !same(matches[0].handle, handle)) throw new GuildError('authorization_required', 'The selected IM account does not uniquely match the official sender configuration.');
    if (expectedIdentityText) assertSenderIdentity(await page.locator('.im-layout-account').innerText(), expectedIdentityText);
    native.state.selectedSender = { ...matches[0], sender_account_ref: senderAccountRef };
    return { sender_account_ref: senderAccountRef, sender_uid: matches[0].uid, identity_verified: true };
  }
  const accounts = page.locator(SENDER_SELECTOR);
  const handle = senderAccountRef.includes(':') ? senderAccountRef.slice(senderAccountRef.indexOf(':') + 1) : senderAccountRef;
  for (let i = 0; i < await accounts.count(); i++) {
    const account = accounts.nth(i);
    if (!await account.isVisible()) continue;
    const ref = await account.getAttribute('data-account-ref');
    const username = await account.getAttribute('data-username');
    const text = await account.innerText();
    if ((ref ? ref === senderAccountRef : (username ? same(username, handle) : exactLine(text, handle)))) {
      if (expectedIdentityText) assertSenderIdentity(text, expectedIdentityText);
      return { sender_account_ref: senderAccountRef, identity_verified: true };
    }
  }
  throw new GuildError('authorization_required', 'No scoped authenticated account identity matches this sender.');
}
async function click(locator) {
  if (await locator.count() !== 1) throw new GuildError('capability_unavailable', 'The messaging control is missing or ambiguous.');
  // A trusted click is the sole dispatch. An error is never followed by a
  // synthetic click, since the first attempt may have reached the provider.
  await locator.click({ force: true, noWaitAfter: true, timeout: 10_000 });
}
const nativePair = (conversation, creator, sender) => {
  const parts = String(conversation).split(':');
  return parts.length === 4 && parts[0] === '0' && parts[1] === '1'
    && ((parts[2] === creator && parts[3] === sender) || (parts[3] === creator && parts[2] === sender));
};
const nativeSenderMember = (conversation, sender) => {
  const parts = String(conversation).split(':');
  return parts.length === 4 && parts[0] === '0' && parts[1] === '1' && Boolean(sender) && (parts[2] === sender || parts[3] === sender);
};
async function nativeRowName(row) {
  const name = row.locator('.im-conversation-item-detail-header-name [class^="name--"] .semi-typography');
  if (await name.count() !== 1) throw new GuildError('authorization_required', 'The native conversation nickname is missing or ambiguous.');
  return (await name.innerText()).trim();
}
async function currentHeader(page, targetField, target) {
  const nativeHeader = page.locator('.im-layout-header [class^="conversationName"]');
  if (await nativeHeader.count()) {
    const native = observeNativeMessaging(page);
    const rows = page.locator('.im-layout-conversation-list .im-conversation-list-item[role="gridcell"]');
    const selected = [];
    for (let i=0; i<await rows.count(); i++) if (await rows.nth(i).locator('.im-conversation-item-selected').count()) selected.push(rows.nth(i));
    if (selected.length !== 1 || await nativeHeader.count() !== 1 || !await nativeHeader.isVisible()) throw new GuildError('authorization_required', 'The selected native conversation is missing or ambiguous.');
    const dataId = await selected[0].getAttribute('data-id') ?? '', prefix = 'backstage_instantMessage_conversationItem_';
    if (!dataId.startsWith(prefix)) throw new GuildError('authorization_required', 'The selected native conversation ID is unavailable.');
    const id = dataId.slice(prefix.length), name = await nativeRowName(selected[0]);
    const metadata = (await native.waitFor('conversations'))?.get(id);
    const sender = native.state.selectedSender;
    const profileName = (await page.locator('.im-layout-account h2[class*="profile-name"]').innerText()).trim();
    const currentAccounts = (await native.waitFor('accounts'))?.filter(account => account.nickname === profileName) ?? [];
    const currentSenderMatches = currentAccounts.length === 1 && currentAccounts[0].uid === sender?.uid && currentAccounts[0].kind === sender?.kind && same(currentAccounts[0].handle, sender?.handle);
    const proof = native.state.selection;
    const targetMatches = targetField === 'conversation_id' ? sameTarget(targetField, id, target) && nativeSenderMember(id, sender?.uid)
      : targetField === 'creator_id' ? nativePair(id, target, sender?.uid)
      : proof && same(proof.handle, target) && nativePair(id, proof.uid, sender?.uid);
    const expectedName = metadata?.name ?? (proof && nativePair(id, proof.uid, sender?.uid) ? proof.nickname : null);
    if (!sender || !currentSenderMatches || sender.nickname !== profileName || !targetMatches || !expectedName || expectedName !== name || (await nativeHeader.innerText()).trim() !== name) throw new GuildError('authorization_required', 'The native header and selected exact conversation do not match the planned recipient.');
    return { conversation_id: id, creator_id: targetField === 'creator_id' ? target : proof?.uid ?? null, recipient_handle: targetField === 'recipient_handle' ? target : proof?.handle ?? null };
  }
  const headers = page.locator(HEADER_SELECTOR);
  const visible = [];
  for (let i = 0; i < await headers.count(); i++) if (await headers.nth(i).isVisible()) visible.push(headers.nth(i));
  if (visible.length !== 1) throw new GuildError('authorization_required', 'The active conversation header is missing or ambiguous.');
  const header = visible[0];
  const fields = { conversation_id: await header.getAttribute('data-conversation-id'), creator_id: await header.getAttribute('data-creator-id'), recipient_handle: await header.getAttribute('data-recipient-handle') };
  const text = await header.innerText();
  if (fields[targetField] ? !sameTarget(targetField, fields[targetField], target) : !exactTargetLine(text, target, targetField)) {
    throw new GuildError('authorization_required', 'The active conversation header does not match the exact planned recipient.');
  }
  return { ...fields, [targetField]: target };
}
async function selectConversation(page, targetField, target, lookupHandle) {
  const nativeRows = page.locator('.im-layout-conversation-list .im-conversation-list-item[role="gridcell"]');
  if (await page.locator('.im-layout-account').count()) {
    const native = observeNativeMessaging(page), sender = native.state.selectedSender;
    await native.waitFor('conversations');
    const matches=[];
    for (let i=0; i<await nativeRows.count(); i++) {
      const dataId = await nativeRows.nth(i).getAttribute('data-id') ?? '';
      const id = dataId.startsWith('backstage_instantMessage_conversationItem_') ? dataId.slice('backstage_instantMessage_conversationItem_'.length) : '';
      if ((targetField === 'conversation_id' && sameTarget(targetField, id, target)) || (targetField === 'creator_id' && nativePair(id, target, sender?.uid))) matches.push(nativeRows.nth(i));
    }
    if (matches.length > 1) throw new GuildError('authorization_required', 'The exact native conversation is ambiguous.');
    if (matches.length === 1) {
      native.state.selection = null;
      await click(matches[0]);
      return currentHeader(page, targetField, target);
    }
    if (targetField === 'conversation_id') throw new GuildError('authorization_required', 'No unique native row matches the exact conversation ID.');
    const handle = targetField === 'recipient_handle' ? target : lookupHandle;
    if (!handle) throw new GuildError('capability_unavailable', 'A new creator_id needs a sourced lookup_handle; native search accepts usernames, not numeric IDs. No search result was selected.');
    const search = page.locator('.im-layout-search input[placeholder="主播用户名"], .im-layout-search input[placeholder="Creator username"]');
    if (await search.count() !== 1) throw new GuildError('capability_unavailable', 'The scoped native username search is unavailable.');
    native.beginSearch(handle);
    await search.fill(handle); await search.press('Enter');
    const creators = await native.waitFor('search');
    const exact = creators?.filter(creator => targetField === 'creator_id' ? sameTarget('creator_id', creator.uid, target) && same(creator.handle, handle) : same(creator.handle, target)) ?? [];
    if (exact.length !== 1 || !exact[0].qualified || creators.filter(creator => creator.nickname === exact[0].nickname).length !== 1) throw new GuildError('authorization_required', 'Native search did not return one qualified exact creator identity.');
    const popup = page.locator('[data-id="backstage_search_result_item"]');
    await popup.first().waitFor({state:'visible',timeout:10_000});
    const rows=[];
    for (let i=0;i<await popup.count();i++) {
      const nickname = popup.nth(i).locator('[class^="nickName"]');
      if (await popup.nth(i).isVisible() && await nickname.count() === 1 && (await nickname.innerText()).trim() === exact[0].nickname) rows.push(popup.nth(i));
    }
    if (rows.length !== 1 || (await search.inputValue()).trim() !== handle) throw new GuildError('authorization_required', 'The native popup does not uniquely match the exact search response.');
    native.state.selection = exact[0];
    await click(rows[0]);
    return currentHeader(page, targetField, target);
  }
  const search = page.locator('input[placeholder="Creator username"], input[placeholder="主播用户名"], input[placeholder*="search" i], input[placeholder*="搜索"], input[aria-label*="search" i], input[aria-label*="搜索"]').first();
  if (await search.count()) {
    await search.waitFor({ state: 'visible', timeout: 10_000 });
    await search.fill(target);
    await search.press('Enter');
  }
  const candidates = page.locator('[data-id="backstage_search_result_item"], [data-conversation-id], [role="option"], [role="listitem"], tr');
  const matches = [];
  for (let i = 0; i < await candidates.count(); i++) {
    const row = candidates.nth(i);
    if (!await row.isVisible()) continue;
    if ((await row.getAttribute('data-id') ?? '').includes('header')) continue;
    const attr = await row.getAttribute(`data-${targetField.replaceAll('_', '-')}`);
    if (attr ? sameTarget(targetField, attr, target) : exactTargetLine(await row.innerText(), target, targetField)) matches.push(row);
  }
  if (matches.length !== 1) throw new GuildError('authorization_required', 'Search did not return one exact recipient; no message was dispatched.');
  await click(matches[0]);
  return currentHeader(page, targetField, target);
}
async function snapshot(page) {
  const bubbles = page.locator(BUBBLE_SELECTOR), items = [];
  for (let i = 0; i < await bubbles.count(); i++) {
    const bubble = bubbles.nth(i);
    items.push({ text: (await bubble.innerText()).trim(), message_id: await bubble.getAttribute('data-message-id') });
  }
  return items;
}
async function readBack(page, content, before, targetField, target, timeoutMs) {
  const beforeMatches = before.filter(x => x.text === content).length;
  const deadline = Date.now() + timeoutMs;
  do {
    const header = await currentHeader(page, targetField, target);
    const after = await snapshot(page);
    if (after.length > before.length && after.filter(x => x.text === content).length > beforeMatches) {
      const newMatch = after.find(x => x.text === content && x.message_id && !before.some(old => old.message_id === x.message_id));
      return { visible: true, matched: true, message_id: newMatch?.message_id ?? null, conversation_id: header.conversation_id ?? null };
    }
    await page.waitForTimeout(25);
  } while (Date.now() < deadline);
  return { visible: false, matched: false, message_id: null, conversation_id: (await currentHeader(page, targetField, target)).conversation_id ?? null };
}
function requestBinding(response, targetField, target, header, content, senderAccountRef) {
  try {
    const url = new URL(response.url());
    if (url.protocol !== 'https:' || !(url.hostname === 'live-backstage.tiktok.com' || /\.(?:tiktok|tiktokv)\.com$/u.test(url.hostname))) return null;
    const endpoint = url.pathname.replace(/\/+$/, '');
    if (!SEND_MESSAGE_PATHS.includes(endpoint)) return null;
    const request = response.request();
    if (request.method() !== 'POST') return null;
    const json = request.postDataJSON(), payload = json?.data ?? json;
    if (!payload || typeof payload !== 'object') return null;
    const bodyContent = payload.content ?? payload.Content ?? payload.message?.content;
    if (bodyContent !== content) return null;
    const sender = payload.sender_account_ref ?? payload.SenderAccountRef;
    if (sender !== undefined && sender !== senderAccountRef) return null;
    const conversation = payload.conversation_id ?? payload.ConversationID;
    const recipient = payload[targetField] ?? (targetField === 'recipient_handle' ? payload.RecipientHandle : targetField === 'creator_id' ? payload.CreatorID : payload.ConversationID);
    if (!(recipient !== undefined && sameTarget(targetField, recipient, target)) && !(header.conversation_id && sameTarget('conversation_id', conversation, header.conversation_id))) return null;
    // An explicit mismatching target cannot be rescued by a matching convo ID.
    if (recipient !== undefined && !sameTarget(targetField, recipient, target)) return null;
    if (header.conversation_id && conversation !== undefined && !sameTarget('conversation_id', conversation, header.conversation_id)) return null;
    return { endpoint_path: endpoint, conversation_id: conversation ? String(conversation) : header.conversation_id ?? null };
  } catch { return null; }
}
async function providerReceipt(response, binding) {
  if (!response) return null;
  const status = response.status();
  if (status < 200 || status >= 300) throw new GuildError('provider_write_failed', 'The bound provider request was rejected.', undefined, { ...binding, provider_status: status });
  let body;
  try { body = await response.json(); } catch { return { ...binding, provider_status: status, status_code: null, provider_message_id: null, verified: false }; }
  const rawCode = body?.BaseResp && Object.hasOwn(body.BaseResp, 'StatusCode') ? body.BaseResp.StatusCode : body?.status_code;
  // Only explicit integer statuses and the canonical string "0" are parsed.
  // Missing, null, empty-string and boolean values are not success evidence.
  const code = Number.isSafeInteger(rawCode) ? rawCode : rawCode === '0' ? 0 : null;
  if (code !== null && code !== 0) throw new GuildError('provider_write_failed', 'The bound provider request was rejected.', undefined, { ...binding, provider_status: status, status_code: code });
  const data = body?.data ?? body;
  const messageId = data?.message_id ?? data?.MessageID ?? data?.server_message_id;
  const conversation = data?.conversation_id ?? data?.ConversationID;
  const matches = conversation === undefined || binding.conversation_id === null || sameTarget('conversation_id', conversation, binding.conversation_id);
  return { ...binding, conversation_id: conversation ? String(conversation) : binding.conversation_id,
    provider_status: status, status_code: code, provider_message_id: messageId ? String(messageId) : null,
    verified: code === 0 && Boolean(messageId) && matches && Boolean(conversation ?? binding.conversation_id) };
}

export async function sendCreatorMessage({ page, senderAccountRef, conversationId, creatorId, recipientHandle, lookupHandle, content, expectedIdentityText, idempotencyKey, writeGuard, responseTimeoutMs = 4_000, readBackTimeoutMs = 10_000 }) {
  assertWriteGuard(writeGuard);
  if (!page || typeof page.goto !== 'function') throw new GuildError('session_owner_unverified', 'The owned Backstage page is unavailable.');
  const targets = [['conversation_id', conversationId], ['creator_id', creatorId], ['recipient_handle', recipientHandle]].filter(([,v]) => typeof v === 'string' && v.trim());
  if (targets.length !== 1 || typeof content !== 'string' || !content.trim()) throw new GuildError('capability_unavailable', 'One exact recipient and message content are required.');
  if (typeof senderAccountRef !== 'string' || !senderAccountRef.trim()) throw new GuildError('authorization_required', 'An exact sender account is required.');
  const [targetField, target] = targets[0];
  if (lookupHandle !== undefined && (targetField !== 'creator_id' || typeof lookupHandle !== 'string' || !lookupHandle.trim())) throw new GuildError('capability_unavailable', 'lookup_handle is only valid with creator_id.');
  writeGuard.assertMessage({ ...(lookupHandle ? {lookup_handle:lookupHandle} : {}), sender_account_ref: senderAccountRef, [targetField]: target, content, idempotency_key: idempotencyKey });
  const native = observeNativeMessaging(page);
  let url;
  try { url = new URL(page.url()); } catch {}
  if (url?.origin !== ORIGIN || url?.pathname !== MESSAGING_ROUTE || (!native.state.bootstrapAttempted && !native.state.accounts && await page.locator('.im-layout-account').count())) {
    // Only the first native bootstrap may refresh missing evidence. Retained
    // pages remain blocked afterwards; new recipients never trigger a reload.
    native.state.bootstrapAttempted = true;
    await page.goto(`${ORIGIN}${MESSAGING_ROUTE}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  const surface = await page.locator('body').innerText();
  if (/\/(?:login|signup|oauth|auth|challenge|captcha|verification|security-check)(?:\/|$)/iu.test(new URL(page.url()).pathname) || /please (?:log|sign) in|登录后(?:继续|操作)|请输入验证码/iu.test(surface)) throw new GuildError('login_required', 'TikTok LIVE Backstage login is required.');
  if (/not authorized to send instant messages|即时消息不可用|无权发送即时消息/iu.test(surface)) throw new GuildError('authorization_required', 'The authenticated account cannot send instant messages.');
  await page.locator(`${SENDER_SELECTOR}, .im-layout-account h2[class*="profile-name"]`).first().waitFor({ state: 'visible', timeout: 10_000 });
  await verifySender(page, senderAccountRef, expectedIdentityText);
  // Honor keys reserved by the previous Broker runtime. Browser storage is
  // read only and never used as the new durable/atomic permission mechanism.
  let legacyReservation;
  try { legacyReservation = await page.evaluate(key => window.localStorage.getItem(`__tiktok_broker_message__:${key}`), idempotencyKey); }
  catch { throw new GuildError('session_owner_unverified', 'Legacy browser reservations cannot be inspected safely.'); }
  if (legacyReservation) throw new GuildError('duplicate_write', 'A previous browser operation reserved this key; only read-only reconciliation is allowed.', undefined, { legacy_reservation: true });
  const header = await selectConversation(page, targetField, target, lookupHandle);
  const input = await page.locator('.im-layout-input textarea').count() ? page.locator('.im-layout-input textarea') : page.locator('[data-id="backstage_IM_input"], textarea[aria-label*="message" i], textarea').last();
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  const before = await snapshot(page);
  await input.fill(content);
  await verifySender(page, senderAccountRef, expectedIdentityText);
  await currentHeader(page, targetField, target);
  const button = page.locator('button[data-id="backstage_IM_send_btn"], button[aria-label="Send"], button[aria-label="发送"]');
  if (await button.count() !== 1) throw new GuildError('capability_unavailable', 'The send button is missing or ambiguous.');
  let responseBinding = null, dispatchStarted = false;
  const dispatchedRequests = new Set();
  const observeRequest = request => { if (dispatchStarted) dispatchedRequests.add(request); };
  page.on('request', observeRequest);
  const responsePromise = page.waitForResponse(response => {
    if (!dispatchedRequests.has(response.request())) return false;
    const binding = requestBinding(response, targetField, target, header, content, senderAccountRef);
    if (!binding) return false;
    responseBinding = binding; return true;
  }, { timeout: responseTimeoutMs }).catch(() => null);
  try { writeGuard.markDispatched(); } catch (error) { page.off('request', observeRequest); throw error; }
  dispatchStarted = true;
  try { await click(button); } catch {
    page.off('request', observeRequest);
    return { status: 'unknown', endpoint_path: null, provider_status: null, provider_receipt: null, sender_account_ref: senderAccountRef,
      recipient: { [targetField]: target }, message_fingerprint: fingerprint(content), read_back: { visible: false, matched: false, message_id: null }, reason: 'dispatch_outcome_unknown' };
  }
  let receipt;
  try { receipt = await providerReceipt(await responsePromise, responseBinding); }
  finally { page.off('request', observeRequest); dispatchedRequests.clear(); }
  let read;
  try { read = await readBack(page, content, before, targetField, target, readBackTimeoutMs); }
  catch { read = { visible: false, matched: false, message_id: null, conversation_id: null, reason: 'conversation_read_back_unverified' }; }
  const idMatches = !read.message_id || !receipt?.provider_message_id || read.message_id === receipt.provider_message_id;
  const conversationMatches = !read.conversation_id || !receipt?.conversation_id || sameTarget('conversation_id', read.conversation_id, receipt.conversation_id);
  const verified = Boolean(receipt?.verified && read.visible && idMatches && conversationMatches);
  return { status: verified ? 'verified' : 'unknown', endpoint_path: receipt?.endpoint_path ?? null, provider_status: receipt?.provider_status ?? null,
    provider_receipt: receipt, sender_account_ref: senderAccountRef, recipient: { [targetField]: target }, message_fingerprint: fingerprint(content), read_back: read,
    ...(verified ? {} : { reason: receipt?.verified ? 'read_back_not_verified' : 'provider_receipt_not_verified' }) };
}

export async function reconcileCreatorMessage({ page, operation }) {
  // No navigation, search, composer, or click: this is only an observation of
  // the retained page. It never promotes an old optimistic bubble to verified.
  if (!page || page.isClosed?.()) return { ...operation, reconciliation: { status: 'unknown', reason: 'retained_page_unavailable' } };
  const [field, target] = Object.entries(operation.recipient)[0];
  try {
    const header = await currentHeader(page, field, target);
    const items = await snapshot(page);
    const receipt = operation.provider_receipt;
    const exactId = receipt?.provider_message_id ? items.find(x => x.message_id === receipt.provider_message_id) : null;
    return { ...operation, reconciliation: { status: exactId && fingerprint(exactId.text) === operation.message_fingerprint && sameTarget('conversation_id', header.conversation_id, receipt.conversation_id) ? 'visible' : 'unknown', message_id: exactId?.message_id ?? null, conversation_id: header.conversation_id ?? null } };
  } catch { return { ...operation, reconciliation: { status: 'unknown', reason: 'conversation_not_bound' } }; }
}
export const MESSAGE_WRITE_EVIDENCE = Object.freeze({ route: MESSAGING_ROUTE, endpoint_paths: SEND_MESSAGE_PATHS, receipt: 'bound provider response with provider message ID and a new outgoing read-back; bubbles alone remain unknown' });

// Read-only preflight for an already-observed page and currently selected row.
// No navigation, search, composer fill, reservation, click or dispatch occurs.
export async function inspectMessagingBinding({page,senderAccountRef,expectedIdentityText,conversationId,creatorId,recipientHandle}) {
  const targets=[['conversation_id',conversationId],['creator_id',creatorId],['recipient_handle',recipientHandle]].filter(([,value])=>typeof value==='string'&&value.trim());
  if(targets.length!==1)throw new GuildError('capability_unavailable','One exact recipient is required for read-only preflight.');
  const sender=await verifySender(page,senderAccountRef,expectedIdentityText);
  const conversation=await currentHeader(page,...targets[0]);
  return {sender,conversation};
}
