import { createProfileRegistry } from './profile-registry.mjs';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createPlaywrightPool({
  maxActive = 10,
  profileRoot,
  launchPersistentContext,
  leaseTtlMs = 15 * 60 * 1000,
  registry = null,
} = {}) {
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 10) {
    throw new RangeError('maxActive must be between 1 and 10.');
  }
  if (typeof launchPersistentContext !== 'function') {
    throw new TypeError('launchPersistentContext is required.');
  }
  const profiles = registry ?? createProfileRegistry({ profileRoot, leaseTtlMs });
  const active = new Map();
  let closed = false;

  async function register(account) {
    if (closed) return { ok: false, error_code: 'pool_closed' };
    return profiles.register(account);
  }

  async function health(senderAccountId, patch = undefined) {
    if (closed) return { ok: false, error_code: 'pool_closed' };
    if (isRecord(senderAccountId)) {
      patch = senderAccountId;
      senderAccountId = patch.sender_account_id ?? patch.account_id;
    }
    if (senderAccountId === undefined) {
      return { ok: true, accounts: await profiles.list() };
    }
    const account = await profiles.get(senderAccountId);
    if (!account) return { ok: false, error_code: 'account_not_found' };
    if (patch && isRecord(patch)) {
      const result = await profiles.register({ ...account, ...patch, sender_account_id: senderAccountId });
      return result.ok ? { ok: true, account: result.account } : result;
    }
    return { ok: true, account };
  }

  async function claim(request = {}) {
    if (closed) return { ok: false, error_code: 'pool_closed' };
    const recovered = await profiles.recoverExpired();
    if (recovered.length) {
      await Promise.allSettled(recovered.map(async (senderAccountId) => {
        const stale = [...active.values()].find((lease) => lease.account.sender_account_id === senderAccountId);
        if (!stale) return;
        active.delete(stale.lease_id);
        await stale.context?.close?.();
      }));
    }
    if (active.size >= maxActive) return { ok: false, error_code: 'capacity_exhausted', max_active: maxActive };
    const requestedId = typeof request === 'string' ? request : request?.sender_account_id ?? request?.account_id;
    const accounts = requestedId
      ? [await profiles.get(requestedId)]
      : await profiles.list({ status: 'enabled', health: 'healthy' });
    for (const account of accounts) {
      if (!account || active.has(account.sender_account_id)) continue;
      const lease = await profiles.acquire(account.sender_account_id, {
        leaseTtlMs: typeof request === 'object' && request.leaseTtlMs ? request.leaseTtlMs : leaseTtlMs,
      });
      if (!lease.ok) {
        if (requestedId) return lease;
        continue;
      }
      try {
        const context = await launchPersistentContext(account.userDataDir, {
          sender_account_id: account.sender_account_id,
          channel: 'web',
        });
        const activeLease = {
          ...lease,
          account: { ...account },
          context,
          userDataDir: account.userDataDir,
        };
        active.set(lease.lease_id, activeLease);
        return { ...activeLease };
      } catch (error) {
        await profiles.release(lease.lease_id);
        return {
          ok: false,
          error_code: 'browser_launch_failed',
          message: error instanceof Error ? error.message : 'Browser launch failed.',
        };
      }
    }
    return requestedId
      ? { ok: false, error_code: 'profile_unavailable' }
      : { ok: false, error_code: 'capacity_exhausted', max_active: maxActive };
  }

  async function release(input) {
    const leaseId = typeof input === 'string' ? input : input?.lease_id;
    const lease = active.get(leaseId);
    if (!lease) {
      return profiles.release(input);
    }
    active.delete(leaseId);
    try {
      await lease.context?.close?.();
    } finally {
      return profiles.release({ lease_id: leaseId, sender_account_id: lease.account.sender_account_id });
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    const leases = [...active.values()];
    active.clear();
    await Promise.allSettled(leases.map(async (lease) => {
      try {
        await lease.context?.close?.();
      } finally {
        await profiles.release({ lease_id: lease.lease_id, sender_account_id: lease.account.sender_account_id });
      }
    }));
  }

  return Object.freeze({
    maxActive,
    register,
    health,
    claim,
    release,
    close,
    get activeCount() {
      return active.size;
    },
  });
}
