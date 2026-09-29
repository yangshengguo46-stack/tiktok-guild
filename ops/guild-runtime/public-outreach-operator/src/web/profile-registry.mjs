import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_PROFILES = 50;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function nowMs(clock) {
  return typeof clock === 'function' ? clock() : Date.now();
}

function normalizeAccount(input) {
  const source = typeof input === 'string' ? { sender_account_id: input } : input;
  if (!source || typeof source !== 'object') throw new TypeError('Account must be an object.');
  const senderAccountId = source.sender_account_id ?? source.account_id;
  if (typeof senderAccountId !== 'string' || !SAFE_ID.test(senderAccountId)) {
    throw new TypeError('sender_account_id must be a short filesystem-safe identifier.');
  }
  const status = source.status ?? (source.enabled === false ? 'disabled' : 'enabled');
  const health = source.health ?? source.health_status ?? 'healthy';
  if (!['enabled', 'disabled', 'paused'].includes(status)) throw new TypeError(`Unknown account status: ${status}`);
  if (!['healthy', 'unhealthy', 'unknown'].includes(health)) throw new TypeError(`Unknown account health: ${health}`);
  return {
    sender_account_id: senderAccountId,
    external_ref: source.external_ref ?? null,
    profile_ref: source.profile_ref ?? senderAccountId,
    channel: source.channel ?? 'web',
    status,
    health,
    capabilities: Array.isArray(source.capabilities) ? [...source.capabilities] : [],
    metadata: source.metadata && typeof source.metadata === 'object' ? { ...source.metadata } : {},
    updated_at: source.updated_at ?? new Date().toISOString(),
  };
}

function profilePath(profileRoot, accountId) {
  return path.join(profileRoot, 'profiles', accountId);
}

function metadataPath(profileRoot, accountId) {
  return path.join(profilePath(profileRoot, accountId), 'registry.json');
}

function lockPath(profileRoot, accountId) {
  return path.join(profileRoot, 'locks', `${accountId}.lock`);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function createProfileRegistry({
  profileRoot,
  maxProfiles = MAX_PROFILES,
  leaseTtlMs = 15 * 60 * 1000,
  clock = () => Date.now(),
} = {}) {
  if (typeof profileRoot !== 'string' || !profileRoot) throw new TypeError('profileRoot is required.');
  if (!Number.isInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > MAX_PROFILES) {
    throw new RangeError(`maxProfiles must be between 1 and ${MAX_PROFILES}.`);
  }

  const root = path.resolve(profileRoot);
  const memory = new Map();
  let readyPromise;

  async function ensureRoot() {
    if (!readyPromise) {
      readyPromise = Promise.all([
        mkdir(path.join(root, 'profiles'), { recursive: true }),
        mkdir(path.join(root, 'locks'), { recursive: true }),
      ]);
    }
    await readyPromise;
  }

  async function load(accountId) {
    if (memory.has(accountId)) return memory.get(accountId);
    const value = await readJson(metadataPath(root, accountId));
    if (!value) return null;
    const account = { ...normalizeAccount(value), userDataDir: profilePath(root, accountId) };
    memory.set(accountId, account);
    return account;
  }

  async function list({ status, health } = {}) {
    await ensureRoot();
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(path.join(root, 'profiles'), { withFileTypes: true }));
    const accounts = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const account = await load(entry.name);
      if (!account) continue;
      if (status && account.status !== status) continue;
      if (health && account.health !== health) continue;
      accounts.push({ ...account });
    }
    accounts.sort((left, right) => left.sender_account_id.localeCompare(right.sender_account_id));
    return accounts;
  }

  async function register(input) {
    await ensureRoot();
    const account = normalizeAccount(input);
    const existing = await load(account.sender_account_id);
    if (!existing && (await list()).length >= maxProfiles) {
      return { ok: false, error_code: 'profile_limit_exceeded', max_profiles: maxProfiles };
    }
    const merged = {
      ...(existing ?? {}),
      ...account,
      userDataDir: profilePath(root, account.sender_account_id),
      registered_at: existing?.registered_at ?? new Date(nowMs(clock)).toISOString(),
      updated_at: new Date(nowMs(clock)).toISOString(),
    };
    await mkdir(merged.userDataDir, { recursive: true });
    await writeFile(metadataPath(root, account.sender_account_id), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    memory.set(account.sender_account_id, merged);
    return { ok: true, account: { ...merged } };
  }

  async function recoverExpired() {
    await ensureRoot();
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.join(root, 'locks'), { withFileTypes: true });
    const recovered = [];
    const now = nowMs(clock);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
      const file = path.join(root, 'locks', entry.name);
      const lock = await readJson(file);
      if (lock?.lease_until && lock.lease_until <= now) {
        await rm(file, { force: true });
        recovered.push(entry.name.slice(0, -5));
      }
    }
    return recovered;
  }

  async function acquire(input, { leaseTtlMs: requestedTtlMs = leaseTtlMs } = {}) {
    await ensureRoot();
    const accountId = typeof input === 'string' ? input : input?.sender_account_id ?? input?.account_id;
    const account = await load(accountId);
    if (!account) return { ok: false, error_code: 'account_not_found' };
    if (account.status !== 'enabled') return { ok: false, error_code: 'account_disabled', account };
    if (account.health !== 'healthy') return { ok: false, error_code: 'account_unhealthy', account };
    const token = crypto.randomUUID();
    const acquiredAt = nowMs(clock);
    const leaseUntil = acquiredAt + Math.max(1, requestedTtlMs);
    const lock = { token, sender_account_id: account.sender_account_id, acquired_at: acquiredAt, lease_until: leaseUntil };
    try {
      const handle = await open(lockPath(root, account.sender_account_id), 'wx');
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
      await handle.close();
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const current = await readJson(lockPath(root, account.sender_account_id));
        if (current?.lease_until && current.lease_until <= acquiredAt) {
          await rm(lockPath(root, account.sender_account_id), { force: true });
          return acquire(account.sender_account_id, { leaseTtlMs: requestedTtlMs });
        }
        return { ok: false, error_code: 'profile_in_use', account, lease: current };
      }
      throw error;
    }
    return { ok: true, lease_id: token, lease_until: leaseUntil, account: { ...account } };
  }

  async function release(input) {
    await ensureRoot();
    const leaseId = typeof input === 'string' ? input : input?.lease_id;
    const accountId = typeof input === 'object' ? input?.sender_account_id ?? input?.account_id : null;
    const entries = accountId ? [accountId] : (await list()).map((account) => account.sender_account_id);
    for (const id of entries) {
      const file = lockPath(root, id);
      const lock = await readJson(file);
      if (!lock || (leaseId && lock.token !== leaseId)) continue;
      await rm(file, { force: true });
      return { ok: true, sender_account_id: id };
    }
    return { ok: false, error_code: 'lease_not_found' };
  }

  async function get(senderAccountId) {
    await ensureRoot();
    return load(senderAccountId);
  }

  return Object.freeze({
    profileRoot: root,
    register,
    list,
    get,
    acquire,
    release,
    recoverExpired,
  });
}

export { MAX_PROFILES };
