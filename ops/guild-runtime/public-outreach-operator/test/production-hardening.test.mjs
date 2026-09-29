import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTikTokPageObjects, FAKE_LOCATORS } from '../src/web/page-objects.mjs';
import { executeWebAction } from '../src/web/tiktok-web-executor.mjs';
import { createPlaywrightPool } from '../src/web/playwright-pool.mjs';
import { createXcuitestSession } from '../src/ios/xcuitest-session.mjs';
process.env.PUBLIC_OUTREACH_FAKE_BROWSER = '1';
function item(text, attrs = {}, onClick = null) { return { isVisible: async () => true, textContent: async () => text, getAttribute: async (key) => attrs[key] ?? null, click: async () => onClick?.(), fill: async () => {} }; }
function page({ sender = '@alice', incomingOnly = false } = {}) {
  const rows = [item('hello', { 'data-receipt-id': 'old', 'data-sender-handle': '@alice', 'data-creator-uid': 'creator' })];
  const controls = new Map([
    [FAKE_LOCATORS.profileRoot, [item('')]],
    [FAKE_LOCATORS.creatorIdentity, [item('', { 'data-creator-uid': 'creator' })]],
    [FAKE_LOCATORS.loggedInSender, [item('', { 'data-sender-handle': sender })]],
    [FAKE_LOCATORS.messageReceipt, rows],
    [FAKE_LOCATORS.messageInput, [item('')]],
    [FAKE_LOCATORS.messageSubmit, [item('', {}, () => rows.push(item(incomingOnly ? 'unrelated' : 'hello', { 'data-receipt-id': 'new', 'data-sender-handle': incomingOnly ? '@someone' : '@alice', 'data-creator-uid': 'creator' }))) ]],
  ]);
  const invisible = { isVisible: async () => false, getAttribute: async () => null, textContent: async () => '' };
  return { locator(selector) { const list = controls.get(selector) ?? []; return { first: () => list[0] ?? invisible, last: () => list.at(-1) ?? invisible, nth: (n) => list[n] ?? invisible, count: async () => list.length }; }, waitForTimeout: async () => {} };
}
test('real Playwright method-shaped Locators prepare empty gates correctly', async () => {
 const objects = createTikTokPageObjects({ page: page(), testOnly: true });
 await objects.prepareCreator({ creator_uid: 'creator' });
});
test('logged-in Bob cannot produce a receipt for registered Alice', async () => {
 const result = await executeWebAction({ account: { sender_account_id: 'alice', external_ref: '@alice', page: page({ sender: '@bob' }) }, creator: { creator_uid: 'creator' }, action: 'message', payload: { testOnly: true, message: 'hello' } });
 assert.equal(result.verified, false); assert.equal(result.error_code, 'sender_identity_mismatch');
});
test('new unrelated incoming item cannot verify old matching message', async () => {
 const result = await executeWebAction({ account: { sender_account_id: 'alice', external_ref: '@alice', page: page({ incomingOnly: true }) }, creator: { creator_uid: 'creator' }, action: 'message', payload: { testOnly: true, message: 'hello' } });
 assert.equal(result.verified, false); assert.equal(result.error_code, 'unknown');
});
test('fresh matching item binds actual sender, target and provider item id', async () => {
 const result = await executeWebAction({ account: { sender_account_id: 'alice', external_ref: '@alice', page: page() }, creator: { creator_uid: 'creator' }, action: 'message', payload: { testOnly: true, message: 'hello' } });
 assert.equal(result.verified, true); assert.match(result.verification_source, /new/); assert.equal(result.receipt_payload.observed_sender.handle, '@alice');
});
test('launch failure releases the fenced profile lease', async () => {
 const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'launch-cleanup-'));
 const pool = createPlaywrightPool({ profileRoot, launchPersistentContext: async () => { throw new Error('offline failure'); } });
 await pool.register({ sender_account_id: 'alice', channel: 'web', status: 'enabled', health: 'healthy' });
 assert.equal((await pool.claim('alice')).error_code, 'browser_launch_failed');
 assert.equal((await pool.claim('alice')).error_code, 'browser_launch_failed');
 await pool.close();
});
test('iOS single and collection lookups convert all semantic strategies identically', async () => {
 const calls = [];
 const driver = { $: async (selector) => { calls.push(selector); return { isDisplayed: async () => true }; }, $$: async (selector) => { calls.push(selector); return []; } };
 const session = createXcuitestSession({ device: { device_ref: 'phone' }, driver });
 for (const locator of [{ accessibility_id: 'message' }, { text: 'hello' }, { predicate: 'label == "hello"' }, { class_chain: '**/XCUIElementTypeButton' }]) { await session.find(locator); await session.count(locator); assert.equal(calls.at(-1), calls.at(-2)); }
 assert.equal(calls[0], '~message'); await session.close();
});
test('message receipt retains message text when the task also has comment text', async () => {
 const result = await executeWebAction({ account: { sender_account_id: 'alice', external_ref: '@alice', page: page() }, creator: { creator_uid: 'creator' }, action: 'message', payload: { testOnly: true, comment: 'different comment', message: 'hello' } });
 assert.equal(result.verified,true);assert.equal(result.receipt_payload.payload.text,'hello');assert.equal(result.receipt_payload.provider_receipt_id,'new');
});
test('direct iOS executor also requires a pilot gate before launching a real session', async () => {
 const { executeIosAction } = await import('../src/ios/tiktok-ios-executor.mjs');
 let launched=false;
 const result=await executeIosAction({account:{sender_account_id:'alice',external_ref:'@alice',session:{launch:async()=>{launched=true;}}},device:{device_ref:'phone'},creator:{creator_uid:'creator'},action:'like'});
 assert.equal(result.error_code,'pilot_required');assert.equal(launched,false);
});
