import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDirectory } from './runtime-paths.js';

export const TIKHUB_RANKING_PROFILE = Object.freeze({
  adapterEvidenceVersion: 'tkdesk.tikhub-ranking.v1',
  source: 'tikhub_live_rankings',
  endpoint: 'https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_live_daily_rank',
  rankingKinds: Object.freeze(['daily', 'league']),
  rankingPeriods: Object.freeze(['current', 'previous', 'both']),
  originalParity: false,
  thirdPartyPaidRequests: true,
  automaticRetry: false,
  countryCoverageVerified: false,
  sendsTikTokCredentials: false
});
const TYPES = Object.freeze({ daily: 8, league: 16 });
const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^[1-9]\d{4,31}$/;
const HANDLE = /^[a-z\d._]{1,64}$/i;
const KEY_PATTERN = /^[\x21-\x7e]{16,4096}$/;

function fail(code, details = null) {
  // Provider errors echo request headers, including the API key. Never return
  // their text, params, headers, cache URLs or raw payload in an error.
  const e = new Error(`TikHub 榜单请求未完成：${code}`);
  e.code = code;
  e.details = details;
  return e;
}
const safeText = (v, max = 160) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : null;
const safeId = v => typeof v === 'string' && ID.test(v) ? v : Number.isSafeInteger(v) && ID.test(String(v)) ? String(v) : null;
const country = v => typeof v === 'string' && /^[A-Z]{2}$/.test(v.toUpperCase()) ? v.toUpperCase() : null;
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const score = v => typeof v === 'string' && /^\d{1,64}$/.test(v) ? v : integer(v) === null ? null : String(v);

function validateRequest({ seed, rankingKind = 'league', rankingPeriod = 'current' }) {
  if (!Object.hasOwn(TYPES, rankingKind) || !['current', 'previous'].includes(rankingPeriod)
    || !safeId(seed?.anchorId) || !safeId(seed?.roomId) || !country(seed?.countryCode)) throw fail('tikhub_request_invalid');
  return { rankingKind, rankingPeriod, rankTypeCode: TYPES[rankingKind], gapInterval: rankingPeriod === 'previous' ? -1 : 0 };
}

function projectSnapshot(wrapper, seed, request, fetchedAt) {
  const upstream = wrapper?.data;
  if (wrapper?.code !== 200) throw fail('tikhub_provider_rejected');
  if (upstream?.status_code !== 0) throw fail('tikhub_upstream_rejected');
  const view = upstream?.data?.rank_view;
  if (!view || !Array.isArray(view.ranks)) throw fail('tikhub_rank_view_missing');
  if (view.rank_type !== request.rankTypeCode) throw fail('tikhub_rank_type_mismatch');
  const requestId = typeof wrapper.request_id === 'string' && /^[a-z\d-]{1,80}$/i.test(wrapper.request_id) ? wrapper.request_id : null;
  const observedDate = integer(wrapper.time_stamp) !== null ? new Date(wrapper.time_stamp * 1000) : new Date(fetchedAt);
  const observedAt = Number.isFinite(observedDate.getTime()) ? observedDate.toISOString() : fetchedAt;
  const rankingClassType = integer(view.rank_extra_info?.class_extra?.class_type);
  const seen = new Set();
  const candidates = [];
  for (const raw of view.ranks) {
    const user = raw?.rank_user;
    const handle = typeof user?.display_id === 'string' && HANDLE.test(user.display_id) ? user.display_id : null;
    if (!handle || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    const userId = safeId(user.id_str) ?? safeId(user.id);
    const rawRoomId = typeof raw.room_id_str === 'string' ? raw.room_id_str : Number.isSafeInteger(raw.room_id) ? String(raw.room_id) : null;
    const roomId = safeId(rawRoomId);
    const creatorCountryCode = country(user.country_code ?? raw.country_code);
    const rankScoreRaw = score(raw.score);
    const rank = integer(raw.rank) > 0 ? raw.rank : null;
    const candidate = {
      handle, displayName: safeText(user.nickname), userId, roomId,
      profileUrl: `https://www.tiktok.com/@${encodeURIComponent(handle)}`,
      followerCount: integer(user.follow_info?.follower_count),
      live: roomId ? true : rawRoomId === '0' ? false : null,
      seller: null, highQuality: null, creatorCountryCode, countryCode: creatorCountryCode,
      rank, rankScoreRaw, rankScoreType: 'unknown', rankScoreUnit: 'unknown_rank_score',
      rankingPeriod: request.rankingPeriod,
      rankTypeCode: request.rankTypeCode, regionTypeCode: 1, gapInterval: request.gapInterval,
      rankingViewKind: request.rankingKind, rankingClassType,
      rankingScopeMarketRegion: null, rankingScopeCountryCode: null, rankingScopeCountryEvidence: null,
      rankingContextCountryCode: country(seed.countryCode),
      rankingProvider: 'tikhub', rankingRequestId: requestId,
      rankingCountdownSeconds: integer(view.countdown),
      source: TIKHUB_RANKING_PROFILE.source, sourceUrl: TIKHUB_RANKING_PROFILE.endpoint,
      observedAt, discoverySourceKinds: [TIKHUB_RANKING_PROFILE.source],
      dataProcessorStatus: 'not_performed', dataProcessorComplete: false,
      rankEvidence: { source: TIKHUB_RANKING_PROFILE.source, observedAt, scoreRaw: rankScoreRaw, scoreType: 'unknown',
        period: request.rankingPeriod, rankTypeCode: request.rankTypeCode, regionTypeCode: 1,
        gapInterval: request.gapInterval, adapterEvidenceVersion: TIKHUB_RANKING_PROFILE.adapterEvidenceVersion }
    };
    candidate.rankingObservations = [{ provider: 'tikhub', requestId, rank, scoreRaw: rankScoreRaw, scoreType: 'unknown',
      period: request.rankingPeriod, rankTypeCode: request.rankTypeCode, gapInterval: request.gapInterval,
      rankingClassType, contextCountryCode: country(seed.countryCode), observedAt }];
    candidates.push(candidate);
  }
  if (view.ranks.length && !candidates.length) throw fail('tikhub_creator_identities_missing');
  return { status: 'ready', ...TIKHUB_RANKING_PROFILE, ...request,
    requestId, observedAt, fetchedAt, rankingClassType, title: safeText(view.title),
    totalRanks: view.ranks.length, fullBoardVerified: false,
    rankingContextCountryCode: country(seed.countryCode), candidates };
}

export function createTikHubRankingTransport({ dataDirectory = defaultDataDirectory(), fetchImpl = globalThis.fetch } = {}) {
  const configPath = path.join(dataDirectory, 'providers', 'tikhub.json');
  async function readConfig() {
    let info;
    try { info = await lstat(configPath); } catch (e) { throw fail(e.code === 'ENOENT' ? 'tikhub_configuration_missing' : 'tikhub_configuration_invalid'); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) throw fail('tikhub_configuration_invalid');
    let value;
    try { value = JSON.parse(await readFile(configPath, 'utf8')); } catch { throw fail('tikhub_configuration_invalid'); }
    if (typeof value?.apiKey !== 'string' || !KEY_PATTERN.test(value.apiKey)) throw fail('tikhub_configuration_invalid');
    if (value.ranking?.enabled !== true) throw fail('tikhub_ranking_disabled');
    return value.apiKey;
  }
  return Object.freeze({
    async status() {
      try { await readConfig(); return { state: 'configured', configured: true, ...TIKHUB_RANKING_PROFILE }; }
      catch (e) { return { state: e.code === 'tikhub_ranking_disabled' ? 'disabled' : e.code === 'tikhub_configuration_missing' ? 'missing' : 'configuration_invalid',
        configured: e.code === 'tikhub_ranking_disabled', enabled: false, ...TIKHUB_RANKING_PROFILE }; }
    },
    async fetchSnapshot(input = {}) {
      const request = validateRequest(input);
      const key = await readConfig();
      const url = new URL(TIKHUB_RANKING_PROFILE.endpoint);
      for (const [k, v] of Object.entries({ anchor_id: safeId(input.seed.anchorId), room_id: safeId(input.seed.roomId),
        rank_type: request.rankTypeCode, region_type: 1, gap_interval: request.gapInterval })) url.searchParams.set(k, String(v));
      let response;
      try { response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json',
        'User-Agent': 'tkdesk-agent/0.9.0' }, redirect: 'error', signal: AbortSignal.timeout(45_000) }); }
      catch { throw fail('tikhub_transport_failed'); }
      const status = response.status;
      if (status >= 300 && status < 400) throw fail('tikhub_redirect_rejected');
      if (!response.ok) throw fail(({ 401: 'tikhub_key_rejected', 403: 'tikhub_permission_required', 402: 'tikhub_balance_required', 429: 'tikhub_rate_limited' })[status] ?? 'tikhub_http_rejected', { httpStatus: status });
      let text;
      try {
        const reader = response.body?.getReader(); const chunks = []; let bytes = 0;
        if (!reader) throw fail('tikhub_response_not_json');
        while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length;
          if (bytes > MAX_BYTES) { await reader.cancel(); throw fail('tikhub_response_too_large'); } chunks.push(Buffer.from(r.value)); }
        text = Buffer.concat(chunks).toString('utf8');
      } catch (e) { throw fail(e.code?.startsWith('tikhub_') ? e.code : 'tikhub_transport_failed'); }
      let wrapper;
      try { wrapper = JSON.parse(text); } catch { throw fail('tikhub_response_not_json'); }
      return projectSnapshot(wrapper, input.seed, request, new Date().toISOString());
    }
  });
}

export function selectTikHubRankingSeeds(prospects, countryCodes) {
  const seeds = [];
  for (const code of countryCodes) {
    const p = prospects.find(p => (p.source ?? p.latestDiscoveryObservation?.source ?? p.latestSource) === 'tiktok_live'
      && p.creatorCountryCode === code && safeId(p.userId) && safeId(p.roomId));
    if (!p) throw fail('tikhub_context_seed_missing', { countryCode: code });
    seeds.push({ anchorId: safeId(p.userId), roomId: safeId(p.roomId), countryCode: code });
  }
  return seeds;
}

/** One finite snapshot plan, owned by the daemon. An uncertain paid attempt is
 * never replayed by resume. Only projected fields are checkpointed. */
export async function collectTikHubRankingSnapshots({ transport, seeds, rankingKind = 'league', rankingPeriod = 'current',
  maxCandidates = 100, filters = {}, checkpoint = {}, saveCheckpoint, onBatch,
  shouldStop = () => false, onProgress = () => {} } = {}) {
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 3
    || !TIKHUB_RANKING_PROFILE.rankingPeriods.includes(rankingPeriod)
    || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 5000
    || typeof saveCheckpoint !== 'function' || typeof onBatch !== 'function') throw fail('tikhub_request_invalid');
  const periods = rankingPeriod === 'both' ? ['current', 'previous'] : [rankingPeriod];
  const plan = seeds.flatMap(seed => periods.map(period => ({ seed, rankingKind, rankingPeriod: period })));
  plan.forEach(validateRequest);
  const planKey = JSON.stringify(plan);
  if (checkpoint.planKey && checkpoint.planKey !== planKey) throw fail('tikhub_checkpoint_plan_mismatch');
  const state = { planKey, snapshots: structuredClone(checkpoint.snapshots ?? []) };
  const seen = new Map();
  for (const s of state.snapshots) if (s?.state === 'committed') for (const c of s.candidates ?? []) seen.set(c.handle.toLowerCase(),c);
  let found = seen.size;
  for (let i = 0; i < plan.length; i++) {
    if (state.snapshots[i]?.state === 'committed') continue;
    if (state.snapshots[i]) throw fail('tikhub_paid_attempt_unresolved', { snapshotIndex: i });
    if (shouldStop() || found >= maxCandidates) break;
    state.snapshots[i] = { state: 'attempted' };
    await saveCheckpoint(state);
    const snapshot = await transport.fetchSnapshot(plan[i]);
    const candidates = [];
    for (const c of snapshot.candidates) {
      const identity = c.handle.toLowerCase();
      const prior = seen.get(identity);
      if (prior) {
        const merged = { ...prior, rankingObservations: [...prior.rankingObservations, ...c.rankingObservations] };
        seen.set(identity,merged); candidates.push(merged); continue;
      }
      if (seen.size >= maxCandidates) break;
      if ((filters.minFollowers !== undefined && (c.followerCount === null || c.followerCount < filters.minFollowers))
        || (filters.maxFollowers !== undefined && (c.followerCount === null || c.followerCount > filters.maxFollowers))) continue;
      seen.set(identity,c); candidates.push(c);
    }
    await onBatch({ items: candidates }); found = seen.size;
    state.snapshots[i] = { state: 'committed', requestId: snapshot.requestId, observedAt: snapshot.observedAt,
      totalRanks: snapshot.totalRanks, rankingClassType: snapshot.rankingClassType, candidates };
    await saveCheckpoint(state);
    await onProgress({ stage: 'tikhub_ranking_snapshot', snapshotsFetched: state.snapshots.filter(s => s?.state === 'committed').length,
      snapshotPlanSize: plan.length, found });
  }
  const complete = state.snapshots.filter(s => s?.state === 'committed').length === plan.length && found < maxCandidates;
  return { ...TIKHUB_RANKING_PROFILE, complete, selectionComplete: found >= maxCandidates, found,
    snapshotsFetched: state.snapshots.filter(s => s?.state === 'committed').length, snapshotPlanSize: plan.length,
    returnedRanks: state.snapshots.reduce((n,s) => n + (s.totalRanks ?? 0),0),
    completionScope: complete ? 'tikhub_snapshot_plan' : found >= maxCandidates ? 'configured_candidate_limit' : 'partial_source',
    dataProcessorComplete: false, fullBoardVerified: false };
}
