// In-memory projections from reviewed, read-only IM endpoints. No cookies,
// SDK globals, tokens, message bodies or raw responses are retained.
const HOST = 'https://im.live-backstage.tiktok.com';
const CONFIG = '/agency_im/agency_im_api/no_auth/im/getAgencyIMConfigV2';
const SEARCH = '/agency_im/agency_im_api/im/searchCreator/';
const CONVERSATIONS = '/agency_im/agency_im_api/im/unifyGetAgentConversations';
const observers = new WeakMap();
const string = value => typeof value === 'string' ? value.trim() : '';
const success = body => body?.BaseResp?.StatusCode === 0 || body?.BaseResp?.StatusCode === '0';

function projectAccounts(body) {
  if (!success(body) || !Array.isArray(body.AffiliateAccounts) || body.AffiliateAccounts.length > 100) return null;
  const sources = body.AffiliateAccounts.map(account => [account, 'affiliate']);
  if (body.OfficialAccount) sources.push([body.OfficialAccount, 'official']);
  const accounts = sources.map(([account, kind]) => ({ kind, handle: string(account?.DisplayId), nickname: string(account?.NickName), uid: string(account?.MainAccount?.AgentTTUserID) }));
  if (!accounts.length || accounts.some(account => !account.handle || !account.nickname || !account.uid)) return null;
  return accounts;
}
function projectConversations(body) {
  if (!success(body) || !Array.isArray(body.Conversations) || body.Conversations.length > 1000) return null;
  const conversations = new Map();
  for (const source of body.Conversations) {
    const id = string(source?.ConversationID), name = string(source?.ConversationName);
    if (!id || !name || conversations.has(id)) return null;
    conversations.set(id, { id, name });
  }
  return conversations;
}

export function observeNativeMessaging(page) {
  if (observers.has(page)) return observers.get(page);
  let epoch = 0, searchSequence = 0;
  const requestEpoch = new WeakMap();
  const state = { bootstrapAttempted: false, accounts: null, conversations: null, search: null, searchHandle: null, selection: null, selectedSender: null };
  const onRequest = request => requestEpoch.set(request, { epoch, searchSequence });
  const onNavigation = frame => {
    if (frame !== page.mainFrame()) return;
    epoch++;
    state.accounts = state.conversations = state.search = state.selection = state.selectedSender = null;
  };
  const onResponse = async response => {
    const observed = requestEpoch.get(response.request());
    if (!observed || observed.epoch !== epoch) return;
    let url;
    try { url = new URL(response.url()); } catch { return; }
    const config = url.origin === HOST && url.pathname === CONFIG && response.request().method() === 'GET';
    const conversations = url.origin === HOST && url.pathname === CONVERSATIONS && response.request().method() === 'POST';
    const search = url.origin === HOST && url.pathname === SEARCH && response.request().method() === 'GET' && observed.searchSequence === searchSequence && url.searchParams.get('Handle') === state.searchHandle;
    if ((!config && !conversations && !search) || response.status() !== 200) return;
    try {
      const headers = await response.headers();
      if (!String(headers['content-type'] ?? '').toLowerCase().includes('application/json')) return;
      const bytes = await response.body();
      if (bytes.length < 2 || bytes.length > 1024 * 1024 || observed.epoch !== epoch) return;
      const body = JSON.parse(bytes.toString('utf8'));
      if (config) state.accounts = projectAccounts(body);
      else if (conversations) state.conversations = projectConversations(body);
      else if (observed.searchSequence === searchSequence && success(body) && (body.BizCode === 0 || body.BizCode === '0') && Array.isArray(body.Creators) && body.Creators.length <= 100) {
        const creators = body.Creators.map(creator => ({ uid: string(creator?.CreatorUID), handle: string(creator?.Handle), nickname: string(creator?.NikName), qualified: creator?.HasAgencyQualification === true }));
        if (creators.every(creator => creator.uid && creator.handle && creator.nickname)) state.search = creators;
      }
    } catch { /* Missing native evidence fails closed at the caller. */ }
  };
  const observation = {
    state,
    beginSearch(handle) { searchSequence++; state.searchHandle = handle; state.search = state.selection = null; },
    async waitFor(field, timeoutMs = 4_000) {
      const deadline = Date.now() + timeoutMs;
      while (!state[field] && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      return state[field];
    }
  };
  observers.set(page, observation);
  page.on('request', onRequest);
  page.on('framenavigated', onNavigation);
  page.on('response', onResponse);
  page.once('close', () => {
    page.off('request', onRequest); page.off('framenavigated', onNavigation); page.off('response', onResponse);
    observers.delete(page);
  });
  return observation;
}
