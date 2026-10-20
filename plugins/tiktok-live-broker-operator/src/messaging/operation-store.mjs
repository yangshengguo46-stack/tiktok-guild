import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GuildError } from '../errors.mjs';

const guards = new WeakSet();
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export function createMutex() {
  let tail = Promise.resolve();
  return action => {
    const next = tail.then(action, action);
    tail = next.catch(() => {});
    return next;
  };
}
export function assertWriteGuard(guard) {
  if (!guards.has(guard)) throw new GuildError('session_owner_unverified', 'Message writes require a durable owner reservation.');
}
function normalizeStoreError(error) {
  if (error.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 0xff)) {
    return new GuildError('profile_busy', 'The profile operation store is owned by another writer; no dispatch was attempted.');
  }
  return error;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function identity(payload) {
  const targets = ['conversation_id', 'creator_id', 'recipient_handle'].filter(k => typeof payload[k] === 'string' && payload[k].trim());
  if (targets.length !== 1 || typeof payload.guild_id !== 'string' || !payload.guild_id.trim()
    || typeof payload.sender_account_ref !== 'string' || !payload.sender_account_ref.trim()
    || typeof payload.content !== 'string' || !payload.content.trim()
    || typeof payload.idempotency_key !== 'string' || !payload.idempotency_key.trim()) {
    throw new GuildError('capability_unavailable', 'A bound guild, sender, recipient, content and idempotency key are required.');
  }
  if (payload.lookup_handle !== undefined && (targets[0] !== 'creator_id' || typeof payload.lookup_handle !== 'string' || !payload.lookup_handle.trim() || payload.lookup_handle.trim().length > 128)) throw new GuildError('capability_unavailable', 'lookup_handle is only valid with creator_id and must be a sourced username.');
  const key = payload.idempotency_key.trim();
  if (key.length > 128) throw new GuildError('capability_unavailable', 'The idempotency key is invalid.');
  const recipient = { [targets[0]]: payload[targets[0]].trim() };
  const contentHash = hash(payload.content);
  // lookup_handle is only a UI search locator. Durable idempotency is keyed
  // by the canonical recipient (creator_id/conversation_id/handle), sender,
  // guild and message body; changing the locator cannot authorize a second
  // send to the same UID.
  const binding = { guild_id: payload.guild_id.trim(), sender_account_ref: payload.sender_account_ref.trim(), recipient, message_fingerprint: contentHash };
  return { key, binding, payloadHash: hash(JSON.stringify(binding)) };
}

// Only the execution owner stores this minimal reservation/receipt data. No
// message bodies, credentials, CRM, queue, or downstream projection are stored.
export function createOperationStore({ profileDir } = {}) {
  let db = null;
  const deferredReleases = new Map();
  const open = () => {
    if (db) return db;
    if (typeof profileDir !== 'string' || !profileDir.trim()) throw new GuildError('session_owner_unverified', 'The owned profile directory is required for durable message writes.');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const directory = path.join(realpathSync(profileDir), '.message-operations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const filename = path.join(directory, 'operations.sqlite');
    const candidate = new DatabaseSync(filename);
    try {
      chmodSync(filename, 0o600);
      candidate.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (kind TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);`);
      for (const suffix of ['-wal', '-shm']) { try { chmodSync(filename + suffix, 0o600); } catch {} }
      db = candidate;
      return db;
    } catch (error) { candidate.close(); throw normalizeStoreError(error); }
  };
  const transaction = action => {
    const conn = open();
    try { conn.exec('BEGIN IMMEDIATE'); } catch (error) { throw normalizeStoreError(error); }
    try { const result = action(conn); conn.exec('COMMIT'); return result; }
    catch (error) { try { conn.exec('ROLLBACK'); } catch {} throw normalizeStoreError(error); }
  };
  const get = key => {
    if (typeof key !== 'string' || !key.trim() || key.length > 128) throw new GuildError('capability_unavailable', 'An idempotency key is required.');
    const row = open().prepare('SELECT * FROM operations WHERE key=?').get(key.trim());
    if (!row) return null;
    return { idempotency_key: row.key, ...JSON.parse(row.binding), state: row.state === 'pending' ? 'unknown' : row.state,
      provider_receipt: row.receipt ? JSON.parse(row.receipt) : null, error_code: row.error_code, created_at: row.created_at, updated_at: row.updated_at };
  };
  const releaseSettledLease = entry => {
    try {
      // Only this store's settled execution token may be cleaned up. A live
      // same-PID lease from another execution/store is never reclaimed.
      open().prepare('DELETE FROM leases WHERE kind=? AND pid=? AND token=?').run(entry.kind, process.pid, entry.token);
      clearTimeout(entry.timer);
      deferredReleases.delete(entry.token);
      return true;
    } catch (error) {
      deferredReleases.set(entry.token, entry);
      if (normalizeStoreError(error).code === 'profile_busy' && !entry.timer && entry.retries < 3) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          entry.retries++;
          if (deferredReleases.has(entry.token)) releaseSettledLease(entry);
        }, 25);
        entry.timer.unref();
      }
      return false; // The durable lease continues to fence writes until cleanup succeeds.
    }
  };
  const acquireLease = kind => {
    // A later distinct operation may retry token-fenced cleanup after the
    // external SQLite writer settled; it never retries a message dispatch.
    for (const entry of deferredReleases.values()) if (entry.kind === kind) releaseSettledLease(entry);
    return transaction(conn => {
      const previous = conn.prepare('SELECT * FROM leases WHERE kind=?').get(kind);
      if (previous && alive(previous.pid)) throw new GuildError('profile_busy', 'Another execution owns this browser profile; no overlapping context or write is permitted.');
      const token = randomUUID();
      conn.prepare('INSERT INTO leases(kind,pid,token) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(kind, process.pid, token);
      const entry = { kind, token, retries: 0, timer: null };
      return { release() { return releaseSettledLease(entry); } };
    });
  };
  const execute = async (payload, write) => {
    const { key, binding, payloadHash } = identity(payload);
    const lease = acquireLease('message-write');
    let reserved = false, dispatched = false;
    const update = (state, receipt = null, errorCode = null) => open().prepare('UPDATE operations SET state=?, receipt=?, error_code=?, updated_at=? WHERE key=?').run(state, receipt ? JSON.stringify(receipt) : null, errorCode, new Date().toISOString(), key);
    const uncertainPersistence = result => ({ ...result, status: 'unknown', sender_account_ref: binding.sender_account_ref,
      recipient: binding.recipient, message_fingerprint: binding.message_fingerprint,
      provider_status: result?.provider_status ?? null, provider_receipt: result?.provider_receipt ?? null,
      reason: 'operation_persistence_unavailable' });
    try {
      transaction(conn => {
        const existing = conn.prepare('SELECT payload_hash FROM operations WHERE key=?').get(key);
        if (existing) {
          if (existing.payload_hash !== payloadHash) throw new GuildError('idempotency_conflict', 'This idempotency key is already bound to a different sender, recipient or message.');
          throw new GuildError('duplicate_write', 'This operation is durably reserved; inspect its status or reconcile it without sending again.', undefined, { operation: get(key) });
        }
        const now = new Date().toISOString();
        conn.prepare('INSERT INTO operations(key,payload_hash,binding,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(key, payloadHash, JSON.stringify(binding), 'pending', now, now);
        reserved = true;
      });
      const guard = Object.freeze({
        assertMessage(message) {
          const requested = identity({ ...message, guild_id: binding.guild_id });
          if (requested.key !== key || requested.payloadHash !== payloadHash) throw new GuildError('authorization_required', 'The dispatched sender, recipient, body or key differs from its durable reservation.');
        },
        markDispatched() {
          if (dispatched) throw new GuildError('duplicate_write', 'This operation has already attempted its single dispatch.');
          // Commit uncertainty BEFORE the click. A crash cannot clear permission
          // to write again, even if the provider acted before returning an error.
          update('unknown');
          dispatched = true;
        }
      });
      guards.add(guard);
      try {
        const result = await write(guard);
        const state = result?.status === 'verified' ? 'verified' : 'unknown';
        try { update(state, result?.provider_receipt ?? null); }
        catch (error) {
          if (dispatched) return uncertainPersistence(result);
          throw normalizeStoreError(error);
        }
        return result;
      } finally { guards.delete(guard); }
    } catch (error) {
      if (reserved) {
        try { update(error.details?.legacy_reservation ? 'unknown' : dispatched ? (error.code === 'provider_write_failed' ? 'rejected' : 'unknown') : 'not_executed', error.code === 'provider_write_failed' ? { ...error.details, provider_message_id: null, verified: false } : null, error.code ?? 'execution_failed'); }
        catch { if (dispatched) return uncertainPersistence(null); }
      }
      throw normalizeStoreError(error);
    } finally { lease.release(); }
  };
  return Object.freeze({ get, execute, acquireLease });
}
