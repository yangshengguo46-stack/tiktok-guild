// Optional public research. This cache and paid-attempt fence live in TKDesk's
// existing SQLite store; they never update discovery or official qualification.
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDirectory } from './runtime-paths.js';

const ORIGIN = 'https://api.tikhub.io';
const ENDPOINTS = Object.freeze({
  profile: '/api/v1/tiktok/app/v3/handler_user_profile',
  posts: '/api/v1/tiktok/app/v3/fetch_user_post_videos_v3'
});
const MAX_BYTES = 4 * 1024 * 1024;
const HANDLE = /^[a-z\d._]{1,64}$/i;
const ID = /^[1-9]\d{4,31}$/;
const TOKEN = /^[a-z\d._:-]{1,128}$/i;
const DAY = 86_400_000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && ID.test(value) ? value : Number.isSafeInteger(value) && ID.test(String(value)) ? String(value) : null;
const handle = value => typeof value === 'string' && HANDLE.test(value) ? value.toLowerCase() : null;
const secUid = value => typeof value === 'string' && /^[a-z\d_-]{16,256}$/i.test(value) ? value : null;
const fail = code => Object.assign(new Error(`TikHub research: ${code}`), { code });
const unavailable = (reason, extra = {}) => ({ state: 'unavailable', coreUsable: true, reason, paidRequests: 0, ...extra });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function text(value, key, max = 2000) {
  return typeof value === 'string' ? value.replaceAll(key, '[redacted]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, max) : null;
}
function withoutCredential(value, key) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).includes(key) ? null : value;
  if (Array.isArray(value)) return value.map(item => withoutCredential(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([name, item]) => [name, withoutCredential(item, key)]));
  return value;
}
function matches(user, candidate) {
  const actualHandle = handle(user?.unique_id ?? user?.uniqueId);
  const actualId = id(user?.uid ?? user?.id_str ?? user?.id);
  return actualHandle === handle(candidate.handle) && (!candidate.userId || (actualId !== null && id(candidate.userId) === actualId));
}
function project(part, wrapper, candidate, key, observedAt, boundSecUid) {
  if (wrapper?.code !== 200 || !wrapper.data || (wrapper.data.status_code !== undefined && wrapper.data.status_code !== 0)) throw fail('provider_rejected');
  const data = wrapper.data;
  let projected;
  if (part === 'profile') {
    const user = data.user ?? data.data?.user;
    if (!matches(user, candidate)) throw fail('identity_mismatch');
    projected = {
      handle: handle(user.unique_id ?? user.uniqueId), userId: id(user.uid ?? user.id_str ?? user.id), secUid: secUid(user.sec_uid ?? user.secUid),
      displayName: text(user.nickname, key, 200), bio: text(user.signature ?? user.bio, key),
      followerCount: integer(user.follower_count ?? user.stats?.followerCount),
      followingCount: integer(user.following_count ?? user.stats?.followingCount),
      totalLikes: integer(user.total_favorited ?? user.stats?.heartCount),
      postCount: integer(user.aweme_count ?? user.stats?.videoCount),
      reportedCountryCode: typeof user.region === 'string' && /^[a-z]{2}$/i.test(user.region) ? user.region.toUpperCase() : null,
      countryMeaning: 'provider_profile_region_not_verified_residency',
      qualification: 'not_assessed', liveRevenue: null
    };
  } else {
    const list = data.aweme_list ?? data.data?.aweme_list;
    if (!Array.isArray(list)) throw fail('posts_missing');
    const rows = list.slice(0, 10).map(row => {
      if (row?.author ? !matches(row.author, candidate) : !boundSecUid) throw fail('identity_mismatch');
      const postId = id(row.aweme_id ?? row.id);
      if (!postId) throw fail('post_identity_missing');
      const stat = row.statistics ?? {};
      const timestamp = integer(row.create_time);
      return {
        postId, caption: text(row.desc ?? row.description, key),
        publishedAt: timestamp !== null && timestamp > 0 && timestamp < 4_102_444_800 ? new Date(timestamp * 1000).toISOString() : null,
        durationSeconds: integer(row.video?.duration) === null ? null : row.video.duration / 1000,
        metrics: { views: integer(stat.play_count), likes: integer(stat.digg_count), comments: integer(stat.comment_count), shares: integer(stat.share_count) },
        identityBinding: row.author ? 'author_identity' : 'verified_profile_sec_uid_request',
        sourceUrl: `https://www.tiktok.com/@${encodeURIComponent(candidate.handle)}/video/${postId}`
      };
    });
    projected = { posts: rows, sort: 'latest', requestedCount: 10, returnedCount: rows.length,
      completeHistory: false, hasMore: data.has_more === 1 || data.has_more === true,
      metricUnits: { views: 'count', likes: 'count', comments: 'count', shares: 'count', durationSeconds: 'seconds' },
      revenueEstimate: null };
  }
  return withoutCredential({ source: 'tikhub_public_research', sourceUrl: ORIGIN + ENDPOINTS[part], observedAt,
    providerRequestId: typeof wrapper.request_id === 'string' && TOKEN.test(wrapper.request_id) ? wrapper.request_id : null,
    data: projected }, key);
}

export function createTikHubEnrichment({ store, dataDirectory = defaultDataDirectory(), fetchImpl = globalThis.fetch,
  clock = () => Date.now(), timeoutMs = 30_000 } = {}) {
  if (!store?.database || typeof store.getProspect !== 'function') throw new TypeError('initialized TKDesk store required');
  const db = store.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS tikhub_research_cache (
      candidate_key TEXT NOT NULL, part TEXT NOT NULL, result_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL, PRIMARY KEY(candidate_key, part)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tikhub_research_operations (
      request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, candidate_key TEXT NOT NULL,
      state TEXT NOT NULL, owner_pid INTEGER NOT NULL, created_at INTEGER NOT NULL, result_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tikhub_research_attempts (
      request_id TEXT NOT NULL, part TEXT NOT NULL, candidate_key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(request_id, part)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_tikhub_attempt_budget ON tikhub_research_attempts(attempted_at);
    CREATE INDEX IF NOT EXISTS idx_tikhub_attempt_candidate ON tikhub_research_attempts(candidate_key, part, blocked_until);
  `);
  async function readConfig() {
    let file;
    try { file = await open(path.join(dataDirectory, 'providers', 'tikhub.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { throw fail(error.code === 'ENOENT' ? 'configuration_missing' : 'configuration_invalid'); }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16_384 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) throw fail('configuration_invalid');
      const config = JSON.parse(await file.readFile('utf8'));
      if (typeof config.apiKey !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(config.apiKey)) throw fail('configuration_invalid');
      const r = config.research ?? {};
      if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw fail('configuration_invalid');
      const dailyRequestLimit = r.dailyRequestLimit ?? 10;
      const cacheTtlSeconds = r.cacheTtlSeconds ?? 86_400;
      if (!Number.isInteger(dailyRequestLimit) || dailyRequestLimit < 1 || dailyRequestLimit > 100
        || !Number.isInteger(cacheTtlSeconds) || cacheTtlSeconds < 300 || cacheTtlSeconds > 604_800) throw fail('configuration_invalid');
      return { key: config.apiKey, enabled: r.enabled === true, dailyRequestLimit, ttlMs: cacheTtlSeconds * 1000 };
    } catch (error) { throw fail(error.code?.startsWith('configuration_') ? error.code : 'configuration_invalid'); }
    finally { await file.close(); }
  }
  const today = now => Math.floor(now / DAY) * DAY;
  const attemptsToday = now => Number(db.prepare('SELECT COUNT(*) AS n FROM tikhub_research_attempts WHERE attempted_at >= ?').get(today(now)).n);
  function cached(candidateKey, part, now) {
    const row = db.prepare('SELECT result_json FROM tikhub_research_cache WHERE candidate_key = ? AND part = ? AND expires_at > ?').get(candidateKey, part, now);
    return row ? JSON.parse(row.result_json) : null;
  }
  async function fetchPart(part, candidate, config, profileResult) {
    const url = new URL(ORIGIN + ENDPOINTS[part]);
    const bound = secUid(profileResult?.data?.secUid);
    if (part === 'profile') url.searchParams.set('unique_id', candidate.handle);
    else {
      url.searchParams.set(bound ? 'sec_user_id' : 'unique_id', bound ?? candidate.handle);
      url.searchParams.set('max_cursor', '0'); url.searchParams.set('count', '10'); url.searchParams.set('sort_type', '0');
    }
    const controller = new AbortController(); let timer; let reader;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('transport_timeout')); }, timeoutMs); });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
        if (response.status >= 300 && response.status < 400) throw fail('redirect_rejected');
        if (!response.ok) throw fail(({ 401: 'key_rejected', 402: 'balance_required', 403: 'permission_required', 429: 'rate_limited' })[response.status] ?? 'http_rejected');
        reader = response.body?.getReader(); if (!reader) throw fail('response_not_json');
        const chunks = []; let bytes = 0;
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length; if (bytes > MAX_BYTES) throw fail('response_too_large');
          chunks.push(Buffer.from(chunk.value));
        }
        let wrapper;
        try { wrapper = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('response_not_json'); }
        return project(part, wrapper, candidate, config.key, new Date(clock()).toISOString(), bound);
      })(), timeout]);
    } catch (error) {
      // Never propagate provider, URL, header, body or fetch error text.
      const safeCodes = new Set(['transport_timeout', 'redirect_rejected', 'key_rejected', 'balance_required', 'permission_required', 'rate_limited', 'http_rejected', 'response_not_json', 'response_too_large', 'provider_rejected', 'identity_mismatch', 'posts_missing', 'post_identity_missing']);
      throw fail(safeCodes.has(error.code) ? error.code : 'transport_failed');
    } finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  }
  async function status() {
    let config;
    try { config = await readConfig(); }
    catch (error) { return { configured: false, enabled: false, coreUsable: true, reason: error.code,
      rankingCollection: false, automaticPaidRequests: false }; }
    const now = clock();
    return { configured: true, enabled: config.enabled, coreUsable: true, rankingCollection: false,
      automaticPaidRequests: false, automaticRetry: false, maxRequestsPerResearch: 2,
      cacheTtlSeconds: config.ttlMs / 1000, endpoints: { ...ENDPOINTS },
      budget: { unit: 'attempted_requests_not_dollars', dailyRequestLimit: config.dailyRequestLimit,
        attemptedToday: attemptsToday(now), resetsAt: new Date(today(now) + DAY).toISOString(), timezone: 'UTC' } };
  }
  async function research({ candidateId, includePosts = false, allowPaid = false, requestId } = {}) {
    const candidate = typeof candidateId === 'string' ? store.getProspect(candidateId) : null;
    if (!candidate || !handle(candidate.handle)) return unavailable('candidate_missing');
    if (typeof includePosts !== 'boolean' || typeof allowPaid !== 'boolean') return unavailable('request_invalid');
    const candidateKey = hash([candidateId, handle(candidate.handle), id(candidate.userId)]);
    const requestHash = hash([candidateKey, includePosts]);
    const now = clock(); const requested = includePosts ? ['profile', 'posts'] : ['profile'];
    const parts = Object.fromEntries(requested.map(part => [part, cached(candidateKey, part, now)]));
    let paidRequests = 0; let reason = null;
    function result() {
      const ready = requested.every(part => parts[part]);
      const some = requested.some(part => parts[part]);
      return { state: ready ? 'ready' : some ? 'partial' : 'unavailable', coreUsable: true, candidateId,
        paidRequests, cacheHit: ready && paidRequests === 0, ...(reason ? { reason } : {}),
        profile: parts.profile, ...(includePosts ? { posts: parts.posts } : {}),
        languageAssessment: parts.profile?.data?.bio || parts.posts?.data?.posts?.some(p => p.caption) ? 'requires_text_assessment' : 'unknown',
        useFor: ['language_text_evidence', 'content_topics', 'recent_post_activity', 'public_engagement'],
        officialQualificationSource: 'collection_backstage', financialReliability: 'no_live_income_estimate' };
    }
    if (!allowPaid) { if (!requested.every(part => parts[part])) reason = 'paid_lookup_not_authorized'; return result(); }
    if (typeof requestId !== 'string' || !TOKEN.test(requestId)) return unavailable('request_id_required');
    let config;
    try { config = await readConfig(); } catch (error) { reason = error.code; return result(); }
    if (!config.enabled) { reason = 'research_disabled'; return result(); }
    const claim = store.transaction(() => {
      const previous = db.prepare('SELECT * FROM tikhub_research_operations WHERE request_id = ?').get(requestId);
      if (previous) return { previous };
      const busy = db.prepare("SELECT owner_pid, created_at FROM tikhub_research_operations WHERE candidate_key = ? AND state = 'in_progress' LIMIT 1").get(candidateKey);
      if (busy) return { reason: alive(busy.owner_pid) && busy.created_at > now - timeoutMs * 3 ? 'research_in_progress' : 'paid_attempt_unresolved' };
      db.prepare("INSERT INTO tikhub_research_operations VALUES (?, ?, ?, 'in_progress', ?, ?, NULL)").run(requestId, requestHash, candidateKey, process.pid, now);
      return null;
    });
    if (claim?.previous) {
      const previous = claim.previous;
      if (previous.request_hash !== requestHash) return unavailable('request_id_conflict');
      if (previous.result_json) return { ...JSON.parse(previous.result_json), paidRequests: 0, idempotentReplay: true };
      return unavailable(alive(previous.owner_pid) && previous.created_at > now - timeoutMs * 3 ? 'research_in_progress' : 'paid_attempt_unresolved');
    }
    if (claim?.reason) return unavailable(claim.reason);
    try {
      for (const part of requested) {
        if (parts[part]) continue;
        const reserved = store.transaction(() => {
          if (db.prepare("SELECT 1 FROM tikhub_research_attempts WHERE candidate_key = ? AND part = ? AND state <> 'completed' AND blocked_until > ? LIMIT 1").get(candidateKey, part, clock())) return 'paid_attempt_unresolved';
          if (attemptsToday(clock()) >= config.dailyRequestLimit) return 'daily_budget_exhausted';
          db.prepare("INSERT INTO tikhub_research_attempts VALUES (?, ?, ?, ?, ?, 'attempted')").run(requestId, part, candidateKey, clock(), clock() + config.ttlMs);
          return null;
        });
        if (reserved) { reason = reserved; break; }
        paidRequests++;
        try {
          const value = await fetchPart(part, candidate, config, parts.profile);
          store.transaction(() => {
            db.prepare('INSERT INTO tikhub_research_cache VALUES (?, ?, ?, ?) ON CONFLICT(candidate_key, part) DO UPDATE SET result_json=excluded.result_json, expires_at=excluded.expires_at')
              .run(candidateKey, part, JSON.stringify(value), clock() + config.ttlMs);
            db.prepare("UPDATE tikhub_research_attempts SET state = 'completed' WHERE request_id = ? AND part = ?").run(requestId, part);
          });
          parts[part] = value;
        } catch (error) { reason = error.code; break; }
      }
      const value = result();
      db.prepare("UPDATE tikhub_research_operations SET state = 'finished', result_json = ? WHERE request_id = ?").run(JSON.stringify(value), requestId);
      // At <=100 attempts/day this limits retained diagnostic history to 90 days.
      // Recent unresolved attempts remain fenced through their cache TTL.
      store.transaction(() => {
        db.prepare('DELETE FROM tikhub_research_cache WHERE expires_at < ?').run(clock() - DAY * 7);
        db.prepare('DELETE FROM tikhub_research_operations WHERE created_at < ?').run(clock() - DAY * 90);
        db.prepare('DELETE FROM tikhub_research_attempts WHERE attempted_at < ? AND blocked_until < ?').run(clock() - DAY * 90, clock());
      });
      return value;
    } catch { return unavailable('research_storage_error', { paidRequests }); }
  }
  return Object.freeze({ status, research });
}
