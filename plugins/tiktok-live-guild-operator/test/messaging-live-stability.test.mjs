import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { sendCreatorMessage } from '../src/messaging/live-write.mjs';

const origin = 'https://live-backstage.tiktok.com';
async function localPage(t, { wrongFirst = false, wrongHeader = false, wrongSender = false, existing = false, addBubble = true, receipt = false, clickThrows = false, receiptMessageId = true, receiptCode = 0, responseConversation = "conv-exact", requestRecipient = null, legacyMarker = false, spoofSender = false, opaqueTarget = null } = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let requests = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/v1/message/send') {
      requests++;
      if (receipt) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status_code: receiptCode, conversation_id: responseConversation, ...(receiptMessageId ? {message_id:'msg-123'} : {}) }) });
      return route.abort();
    }
    if (url.pathname !== '/portal/anchor/instant-messages') return route.abort();
    const row = handle => `<button data-id="backstage_search_result_item" data-recipient-handle="${handle}" ${opaqueTarget ? `data-${opaqueTarget.field.replaceAll('_','-')}="${opaqueTarget.observed}"` : ''} onclick="document.querySelector('[data-id=backstage_IM_conversation_header]').dataset.recipientHandle='${wrongHeader ? 'wrong.creator' : handle}'; document.querySelector('[data-id=backstage_IM_conversation_header]').textContent='${wrongHeader ? 'wrong.creator' : handle}'">${handle}</button>`;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<body>
      <header data-id="backstage_account_identity" data-account-ref="affiliate:${wrongSender ? 'other.creator' : 'mira.creator_01'}">Mira<br>${wrongSender ? 'other.creator' : 'mira.creator_01'}</header>
      ${spoofSender ? '<div data-account-ref="affiliate:mira.creator_01">Mira<br>mira.creator_01</div>' : ''}
      <input placeholder="Creator username">${wrongFirst ? row('wrong.creator') : ''}${row('exact.creator')}
      <div data-id="backstage_IM_conversation_header" data-conversation-id="${opaqueTarget?.field === 'conversation_id' ? opaqueTarget.observed : 'conv-exact'}" ${opaqueTarget?.field === 'creator_id' ? `data-creator-id="${opaqueTarget.observed}"` : ''} data-recipient-handle="exact.creator">exact.creator</div>
      <textarea data-id="backstage_IM_input"></textarea><button data-id="backstage_IM_send_btn">Send</button>
      <div data-id="backstage_IM_messageList_container">${existing ? '<div class="im-message-item-right"><div class="im-message-layout-bubble">hello</div></div>' : ''}</div>
      <script>window.clicks=0; document.querySelector('[data-id=backstage_IM_send_btn]').onclick=()=>{
        window.clicks++; ${addBubble ? "document.querySelector('[data-id=backstage_IM_messageList_container]').insertAdjacentHTML('beforeend','<div class=im-message-item-right><div class=im-message-layout-bubble>hello</div></div>');" : ''}
        fetch('/v1/message/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:'conv-exact',recipient_handle:${requestRecipient ? JSON.stringify(requestRecipient) : "document.querySelector('[data-id=backstage_IM_conversation_header]').dataset.recipientHandle"},sender_account_ref:'affiliate:mira.creator_01',content:'hello'})}).catch(()=>{});
      };</script></body>` });
  });
  await page.goto(`${origin}/portal/anchor/instant-messages`);
  if (legacyMarker) await page.evaluate(() => localStorage.setItem('__tiktok_broker_message__:fixture', '{"state":"pending"}'));
  if (clickThrows) {
    const original = page.locator.bind(page);
    page.locator = selector => {
      const locator=original(selector);
      if (selector.includes('backstage_IM_send_btn')) {
        const click=locator.click.bind(locator);
        locator.click=async options=>{await click(options);throw new Error('trusted click reported a post-dispatch error');};
      }
      return locator;
    };
  }
  // Only the platform boundary is simulated; navigation, selectors, trusted click,
  // response observation, and read-back all execute in a real local browser.
  const invoke = async () => {
    const args = { page, senderAccountRef: 'affiliate:mira.creator_01', expectedIdentityText: 'Mira', ...(opaqueTarget ? { [opaqueTarget.field === 'conversation_id' ? 'conversationId' : 'creatorId']: opaqueTarget.target } : { recipientHandle: 'exact.creator' }), content: 'hello', idempotencyKey: 'fixture', responseTimeoutMs: 60, readBackTimeoutMs: 100 };
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { default: os } = await import('node:os');
    const { default: path } = await import('node:path');
    const { createOperationStore } = await import('../src/messaging/operation-store.mjs');
    const profile = await mkdtemp(path.join(os.tmpdir(), 'live-msg-'));
    t.after(() => rm(profile, { recursive: true, force: true }));
    return createOperationStore({ profileDir: profile }).execute({ guild_id:'103785', sender_account_ref:args.senderAccountRef, ...(args.conversationId ? { conversation_id:args.conversationId } : args.creatorId ? { creator_id:args.creatorId } : { recipient_handle:args.recipientHandle }), content:args.content, idempotency_key:args.idempotencyKey }, guard => sendCreatorMessage({ ...args, writeGuard:guard }));
  };
  return { page, invoke, requests: () => requests };
}

test('search selects the exact result even when the first creator differs', async t => {
  const f = await localPage(t, { wrongFirst: true, receipt: true });
  const result = await f.invoke();
  assert.equal(await f.page.locator('[data-id=backstage_IM_conversation_header]').getAttribute('data-recipient-handle'), 'exact.creator');
  assert.equal(result.status, 'verified');
});

test('a mismatched conversation header blocks dispatch', async t => {
  const f = await localPage(t, { wrongHeader: true });
  await assert.rejects(f.invoke(), e => e.code === 'authorization_required');
  assert.equal(await f.page.evaluate(() => window.clicks), 0);
});

test('a display name matching another authenticated account blocks dispatch', async t => {
  const f = await localPage(t, { wrongSender: true });
  await assert.rejects(f.invoke(), e => e.code === 'authorization_required');
  assert.equal(await f.page.evaluate(() => window.clicks), 0);
});

test('optimistic bubble without a bound receipt stays unknown with null provider status', async t => {
  const f = await localPage(t);
  const result = await f.invoke();
  assert.equal(result.status, 'unknown');
  assert.equal(result.provider_status, null);
  assert.equal(result.provider_receipt, null);
  assert.equal(result.read_back.visible, true);
});

test('an existing matching message cannot verify this write', async t => {
  const f = await localPage(t, { existing: true, addBubble: false, receipt: true });
  const result = await f.invoke();
  assert.equal(result.status, 'unknown');
  assert.equal(result.read_back.visible, false);
});


test('HTTP 200 without a provider message ID is visible but unknown', async t => {
  const f=await localPage(t,{receipt:true,receiptMessageId:false});
  const result=await f.invoke();
  assert.equal(result.status,'unknown'); assert.equal(result.provider_status,200);
  assert.equal(result.provider_receipt.provider_message_id,null); assert.equal(result.read_back.visible,true);
});

test('a response for a different recipient is not this operation receipt', async t => {
  const f=await localPage(t,{receipt:true,requestRecipient:'other.creator'});
  const result=await f.invoke();
  assert.equal(result.status,'unknown'); assert.equal(result.provider_receipt,null);
});

test('a returned conversation mismatch cannot verify a new bubble', async t => {
  const f=await localPage(t,{receipt:true,responseConversation:'other-conversation'});
  const result=await f.invoke(); assert.equal(result.status,'unknown');
});

test('a bound provider rejection remains a rejected write', async t => {
  const f=await localPage(t,{receipt:true,receiptCode:17});
  await assert.rejects(f.invoke(),e=>e.code==='provider_write_failed');
  assert.equal(await f.page.evaluate(()=>window.clicks),1);
});

test('trusted click uncertainty never triggers a fallback dispatch', async t => {
  const f=await localPage(t,{receipt:true,clickThrows:true});
  const result=await f.invoke(); assert.equal(result.status,'unknown');
  assert.equal(await f.page.evaluate(()=>window.clicks),1);
});

test('a legacy browser reservation is never clicked again', async t => {
  const f=await localPage(t,{legacyMarker:true,receipt:true});
  await assert.rejects(f.invoke(),e=>e.code==='duplicate_write');
  assert.equal(await f.page.evaluate(()=>window.clicks),0);
});


test('an account attribute in conversation content is not authenticated sender evidence', async t => {
  const f=await localPage(t,{wrongSender:true,spoofSender:true,receipt:true});
  await assert.rejects(f.invoke(),e=>e.code==='authorization_required');
  assert.equal(await f.page.evaluate(()=>window.clicks),0);
});

for (const [label, receiptCode] of [['null', null], ['empty string', ''], ['false', false]]) {
  test(`invalid provider status code ${label} remains unknown`, async t => {
    const f=await localPage(t,{receipt:true,receiptCode});
    const result=await f.invoke();
    assert.equal(result.status,'unknown');
    assert.equal(result.provider_receipt.verified,false);
    assert.equal(result.provider_receipt.status_code,null);
    assert.equal(result.provider_status,200); // an observed HTTP status, not success inference
    assert.equal(result.read_back.visible,true);
  });
}

test('canonical string zero status explicitly confirms the bound provider receipt', async t => {
  const f=await localPage(t,{receipt:true,receiptCode:'0'});
  const result=await f.invoke();
  assert.equal(result.status,'verified');
  assert.equal(result.provider_receipt.status_code,0);
});


for (const field of ['conversation_id','creator_id']) {
  test(`opaque ${field} case mismatch blocks the send before dispatch`, async t => {
    const f=await localPage(t,{receipt:true,opaqueTarget:{field,target:'opaque-id',observed:'OPAQUE-ID'}});
    await assert.rejects(f.invoke(),e=>e.code==='authorization_required');
    assert.equal(await f.page.evaluate(()=>window.clicks),0);
  });
}

async function nativePage(t, { missingConfig=false, duplicateNickname=false, wrongHeader=false, wrongSelection=false, wrongHandle=false, targetField='conversation_id', lookupHandle=null, searchQualified=true, searchWrongUID=false, rowTag=false, foreignSender=false }={}) {
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  const conversation=foreignSender?'0:1:6829613916365538310:9999999999999999999':'0:1:6829613916365538310:7689498531132539911';
  const newUID='7667651908912448533', searchHandle='exact.creator';
  let navigations=0;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='im.live-backstage.tiktok.com' && url.pathname==='/agency_im/agency_im_api/no_auth/im/getAgencyIMConfigV2') {
      if(missingConfig)return route.abort();
      return route.fulfill({contentType:'application/json',body:JSON.stringify({BaseResp:{StatusCode:0},AffiliateAccounts:[{DisplayId:wrongHandle?'other.creator':'mira.creator_01',NickName:'Mira',MainAccount:{AgentTTUserID:'7689498531132539911'}},...(duplicateNickname?[{DisplayId:'another.creator',NickName:'Mira',MainAccount:{AgentTTUserID:'9999999999999999999'}}]:[])],OfficialAccount:{DisplayId:'official.creator',NickName:'Official',MainAccount:{AgentTTUserID:'7412946710832679685'}}})});
    }
    if(url.hostname==='im.live-backstage.tiktok.com' && url.pathname==='/agency_im/agency_im_api/im/unifyGetAgentConversations')return route.fulfill({contentType:'application/json',body:JSON.stringify({BaseResp:{StatusCode:0},Conversations:[{ConversationID:conversation,ConversationName:'Native nickname'}]})});
    if(url.hostname==='im.live-backstage.tiktok.com' && url.pathname==='/agency_im/agency_im_api/im/searchCreator/')return route.fulfill({contentType:'application/json',body:JSON.stringify({BaseResp:{StatusCode:0},BizCode:0,Creators:[{CreatorUID:searchWrongUID?'9999999999999999999':newUID,Handle:searchHandle,NikName:'Search nickname',HasAgencyQualification:searchQualified}]})});
    if(url.origin!==origin || url.pathname!=='/portal/anchor/instant-messages')return route.abort();
    navigations++;
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div class=im-layout-account><h2 class=profile-name--BV8Xn>Mira</h2><button data-id=backstage_switch_account>Switch</button></div>
      <div class=im-layout-conversation-list><div role=gridcell class=im-conversation-list-item data-id="backstage_instantMessage_conversationItem_${conversation}" onclick="document.querySelector('.im-conversation-item').classList.add('${wrongSelection?'wrong-selected':'im-conversation-item-selected'}');document.querySelector('.conversationName--_tv38').textContent='${wrongHeader?'Other creator':'Native nickname'}'"><div class=im-conversation-item><div class=im-conversation-item-detail-header-name><div class=name--xzY_P><span class=semi-typography>Native nickname</span></div>${rowTag?'<div class=semi-tag>Rank tag</div>':''}</div></div></div></div>
      <div class=im-layout-header><div class=conversationName--_tv38></div></div><textarea data-id=backstage_IM_input></textarea><button data-id=backstage_IM_send_btn onclick="window.clicks++">Send</button><div data-id=backstage_IM_messageList_container></div>
      <div class=im-layout-search><input placeholder="主播用户名" onkeydown="if(event.key==='Enter')fetch('https://im.live-backstage.tiktok.com/agency_im/agency_im_api/im/searchCreator/?Handle='+encodeURIComponent(this.value)).then(r=>r.json()).then(b=>{const popup=document.createElement('button');popup.dataset.id='backstage_search_result_item';popup.innerHTML='<div class=nickName--abc>'+b.Creators[0].NikName+'</div>';popup.onclick=()=>{window.selectionClicks++;document.querySelector('.im-conversation-list-item').dataset.id='backstage_instantMessage_conversationItem_0:1:'+b.Creators[0].CreatorUID+':7689498531132539911';document.querySelector('.im-conversation-item').classList.add('im-conversation-item-selected');document.querySelector('.name--xzY_P .semi-typography').textContent=b.Creators[0].NikName;document.querySelector('.conversationName--_tv38').textContent=b.Creators[0].NikName;};document.body.append(popup);});"></div><script>window.selectionClicks=0;window.clicks=0;fetch('https://im.live-backstage.tiktok.com/agency_im/agency_im_api/no_auth/im/getAgencyIMConfigV2').catch(()=>{});fetch('https://im.live-backstage.tiktok.com/agency_im/agency_im_api/im/unifyGetAgentConversations',{method:'POST'}).catch(()=>{});</script>`});
  });
  // Deliberately leave the initial page blank: the adapter must observe its own
  // official native read-only response rather than injected SDK/global state.
  const invoke=async()=>{
    const {mkdtemp,rm}=await import('node:fs/promises');const {default:os}=await import('node:os');const {default:path}=await import('node:path');const {createOperationStore}=await import('../src/messaging/operation-store.mjs');
    const profile=await mkdtemp(path.join(os.tmpdir(),'native-msg-'));t.after(()=>rm(profile,{recursive:true,force:true}));
    const args={page,senderAccountRef:'affiliate:mira.creator_01',expectedIdentityText:'Mira',...(targetField==='conversation_id'?{conversationId:conversation}:targetField==='creator_id'?{creatorId:newUID,...(lookupHandle?{lookupHandle}: {})}:{recipientHandle:searchHandle}),content:'hello',idempotencyKey:'native',responseTimeoutMs:60,readBackTimeoutMs:80};
    return createOperationStore({profileDir:profile}).execute({guild_id:'103785',sender_account_ref:args.senderAccountRef,...(args.conversationId?{conversation_id:args.conversationId}:args.creatorId?{creator_id:args.creatorId,...(lookupHandle?{lookup_handle:lookupHandle}: {})}:{recipient_handle:args.recipientHandle}),content:'hello',idempotency_key:'native'},writeGuard=>sendCreatorMessage({...args,writeGuard}));
  };
  return {page,invoke,navigations:()=>navigations};
}

test('actual native config plus selected exact conversation and header permits one dispatch',async t=>{
  const f=await nativePage(t);const result=await f.invoke();assert.equal(result.status,'unknown');assert.equal(await f.page.evaluate(()=>window.clicks),1);
});
for(const [label,options] of [['ambiguous account nickname',{duplicateNickname:true}],['different official sender handle',{wrongHandle:true}],['mismatched scoped header',{wrongHeader:true}],['missing selected exact conversation',{wrongSelection:true}]]) {
  test(`native ${label} blocks dispatch`,async t=>{const f=await nativePage(t,options);await assert.rejects(f.invoke(),e=>e.code==='authorization_required');assert.equal(await f.page.evaluate(()=>window.clicks),0);});
}


test('native row rank tags do not replace the nickname used for header binding',async t=>{
 const f=await nativePage(t,{rowTag:true});const result=await f.invoke();assert.equal(result.status,'unknown');assert.equal(await f.page.evaluate(()=>window.clicks),1);
});
test('native handle search binds exact response and selected UID before dispatch',async t=>{
 const f=await nativePage(t,{targetField:'recipient_handle'});const result=await f.invoke();assert.equal(result.status,'unknown');assert.equal(await f.page.evaluate(()=>window.clicks),1);
});
test('native creator UID uses the sourced lookup handle and verifies the returned UID',async t=>{
 const f=await nativePage(t,{targetField:'creator_id',lookupHandle:'exact.creator'});const result=await f.invoke();assert.equal(result.status,'unknown');assert.equal(await f.page.evaluate(()=>window.clicks),1);
});
for(const [label,options] of [['unqualified handle',{targetField:'recipient_handle',searchQualified:false}],['different UID returned for lookup handle',{targetField:'creator_id',lookupHandle:'exact.creator',searchWrongUID:true}],['new UID without lookup handle',{targetField:'creator_id'}]]) {
 test(`native ${label} blocks before selecting a search result`,async t=>{const f=await nativePage(t,options);await assert.rejects(f.invoke(),e=>['authorization_required','capability_unavailable'].includes(e.code));assert.equal(await f.page.evaluate(()=>window.selectionClicks),0);assert.equal(await f.page.evaluate(()=>window.clicks),0);});
}


test('a stale exact conversation from another sender cannot dispatch as the current account',async t=>{
 const f=await nativePage(t,{foreignSender:true});await assert.rejects(f.invoke(),e=>e.code==='authorization_required');assert.equal(await f.page.evaluate(()=>window.clicks),0);
});


test('a retained native page bootstraps at most once after its config response is missing',async t=>{
 const f=await nativePage(t,{missingConfig:true});
 await assert.rejects(f.invoke(),e=>e.code==='authorization_required');
 await assert.rejects(f.invoke(),e=>e.code==='authorization_required');
 assert.equal(f.navigations(),1);assert.equal(await f.page.evaluate(()=>window.clicks),0);
});
test('a ready retained native page sends distinct operations without another bootstrap',async t=>{
 const f=await nativePage(t);await f.invoke();await f.invoke();assert.equal(f.navigations(),1);assert.equal(await f.page.evaluate(()=>window.clicks),2);
});
