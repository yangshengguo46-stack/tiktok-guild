import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import {
  IOS_DEVICE_STATES,
  createWdaHealthChecker,
  isVerifiedWdaHealth,
  stateFromPrerequisites,
} from './wda-health.mjs';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_ROOT = process.env.PUBLIC_OUTREACH_IOS_DEVICE_ROOT
  ?? path.join(process.cwd(), '.public-outreach', 'ios-devices');

function nowIso(clock) {
  return new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString();
}

function requireDeviceId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} must be a short filesystem-safe identifier.`);
  }
  return value;
}

function normalizeDevice(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Device must be an object.');
  const deviceRef = requireDeviceId(input.device_ref, 'device_ref');
  if (typeof input.udid !== 'string' || !input.udid.trim()) throw new TypeError('udid is required.');
  if (typeof input.platform_version !== 'string' || !input.platform_version.trim()) {
    throw new TypeError('platform_version is required.');
  }
  if (typeof input.wda_bundle_id !== 'string' || !input.wda_bundle_id.trim()) {
    throw new TypeError('wda_bundle_id is required.');
  }
  return {
    device_ref: deviceRef,
    udid: input.udid,
    platform_version: input.platform_version,
    wda_bundle_id: input.wda_bundle_id,
    paired: input.paired !== false,
    online: input.online !== false,
    locked: input.locked === true,
    state: input.state ?? null,
    health: input.health ?? null,
    active_session_id: input.active_session_id ?? null,
    metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function createDeviceRegistry({
  rootDir = DEFAULT_ROOT,
  clock = () => Date.now(),
  healthChecker = null,
  prerequisites = null,
  prerequisiteProbe = undefined,
  driverProbe = null,
  lockLeaseMs = 5_000,
  lockHeartbeatMs = Math.max(25, Math.floor(lockLeaseMs / 3)),
  lockAcquireTimeoutMs = 10_000,
  lockWriteHook = null,
} = {}) {
  if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('rootDir is required.');
  const root = path.resolve(rootDir);
  const file = path.join(root, 'devices.json');
  const lockFile = path.join(root, 'devices.lock');
  const hostName = os.hostname();
  const checker = healthChecker ?? createWdaHealthChecker({
    prerequisites,
    prerequisiteProbe,
    driverProbe,
  });
  const memory = new Map();
  let readyPromise;
  let writeTail = Promise.resolve();

  async function ensureRoot() {
    if (!readyPromise) readyPromise = mkdir(root, { recursive: true });
    await readyPromise;
  }

  async function load({ refresh = false } = {}) {
    await ensureRoot();
    if (memory.size && !refresh) return memory;
    if (refresh) memory.clear();
    const values = await readJson(file, []);
    for (const value of Array.isArray(values) ? values : []) {
      try {
        const device = normalizeDevice(value);
        memory.set(device.device_ref, device);
      } catch {
        // Ignore malformed records so one stale device cannot block the registry.
      }
    }
    return memory;
  }

  async function flush() {
    await ensureRoot();
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...memory.values()], null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  }

  async function writeLockRecord(record) {
    if (typeof lockWriteHook === 'function') await lockWriteHook(record);
    const temporary = `${lockFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8');
    await rename(temporary, lockFile);
  }

  function ownerDead(record) {
    if (record?.hostname !== hostName || !Number.isInteger(record?.pid)) return false;
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  }

  async function withFilesystemLock(work) {
    await ensureRoot();
    const token = crypto.randomUUID();
    const deadline = Date.now() + lockAcquireTimeoutMs;
    let acquired = false;
    while (!acquired) {
      try {
        const handle = await open(lockFile, 'wx');
        await handle.writeFile(`${JSON.stringify({
          token,
          pid: process.pid,
          hostname: hostName,
          acquired_at: Date.now(),
          lease_until: Date.now() + lockLeaseMs,
        })}\n`, 'utf8');
        await handle.close();
        acquired = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const current = await readJson(lockFile, null);
        if (current?.lease_until <= Date.now() && ownerDead(current)) {
          await rm(lockFile, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error('iOS device registry lock timeout.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const leaseState = {
      active: true,
      generation: 1,
      heartbeatLost: false,
      tail: Promise.resolve(),
    };
    const queueLeaseWrite = (work) => {
      const previous = leaseState.tail;
      let release;
      leaseState.tail = new Promise((resolve) => { release = resolve; });
      return (async () => {
        await previous;
        try {
          return await work();
        } finally {
          release();
        }
      })();
    };
    const heartbeat = setInterval(() => {
      const generation = leaseState.generation;
      void queueLeaseWrite(async () => {
        if (!leaseState.active || generation !== leaseState.generation) return;
        const current = await readJson(lockFile, null);
        if (current?.token !== token) {
          leaseState.heartbeatLost = true;
          return;
        }
        try {
          if (!leaseState.active || generation !== leaseState.generation) return;
          await writeLockRecord({
            ...current,
            heartbeat_at: Date.now(),
            lease_until: Date.now() + lockLeaseMs,
          });
        } catch {
          leaseState.heartbeatLost = true;
        }
      }).catch(() => {
        leaseState.heartbeatLost = true;
      });
    }, lockHeartbeatMs);
    heartbeat.unref?.();
    try {
      const result = await work();
      if (leaseState.heartbeatLost) throw new Error('iOS device registry lock was lost during the operation.');
      return result;
    } finally {
      leaseState.active = false;
      leaseState.generation += 1;
      clearInterval(heartbeat);
      await leaseState.tail;
      const current = await readJson(lockFile, null);
      if (current?.token === token) await rm(lockFile, { force: true });
    }
  }

  async function serialize(work) {
    const previous = writeTail;
    let release;
    writeTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await withFilesystemLock(work);
    } finally {
      release();
    }
  }

  async function evaluateHealth(device, driver = null) {
    let result;
    try {
      result = await checker({ device, driver });
    } catch (error) {
      return {
        ok: false,
        state: 'manual_required',
        error_code: 'wda_unavailable',
        message: error instanceof Error ? error.message : 'WebDriverAgent health check failed.',
      };
    }
    if (!isVerifiedWdaHealth(result)) {
      const knownNonReady = new Set([
        'device_offline',
        'device_locked',
        'device_unpaired',
        'wda_probe_required',
      ]);
      if (
        result
        && typeof result === 'object'
        && result.ok !== true
        && (
          (result.state === 'offline' && result.error_code === 'device_offline')
          || (result.state === 'manual_required' && knownNonReady.has(result.error_code))
        )
      ) {
        return result;
      }
      return {
        ...(result && typeof result === 'object' ? result : {}),
        ok: false,
        state: 'manual_required',
        error_code: 'wda_unavailable',
        message: 'Health checker did not satisfy the strict WDA health contract.',
      };
    }
    return result;
  }

  async function registerDevice(input) {
    const normalized = normalizeDevice(input);
    return serialize(async () => {
      await load({ refresh: true });
      const existing = memory.get(normalized.device_ref);
      const merged = {
        ...(existing ?? {}),
        ...normalized,
        active_session_id: existing?.active_session_id ?? normalized.active_session_id,
        registered_at: existing?.registered_at ?? nowIso(clock),
        updated_at: nowIso(clock),
      };
      const health = await evaluateHealth(merged, input.driver ?? null);
      const state = health.ok ? 'ready' : health.state;
      const result = {
        ...merged,
        state,
        health: health.ok ? 'healthy' : health.error_code,
        health_detail: health,
        active_session_id: existing?.active_session_id ?? null,
      };
      memory.set(result.device_ref, result);
      await flush();
      return { ok: true, device: { ...result } };
    });
  }

  async function get(deviceRef) {
    await load();
    return memory.get(deviceRef) ? { ...memory.get(deviceRef) } : null;
  }

  async function list({ state } = {}) {
    await load();
    return [...memory.values()]
      .filter((device) => !state || device.state === state)
      .map((device) => ({ ...device }))
      .sort((left, right) => left.device_ref.localeCompare(right.device_ref));
  }

  async function health(deviceRef, patch = {}) {
    return serialize(async () => {
      await load({ refresh: true });
      const current = memory.get(deviceRef);
      if (!current) return { ok: false, error_code: 'device_not_found' };
      const merged = { ...current, ...patch, device_ref: current.device_ref };
      const result = await evaluateHealth(merged, patch.driver ?? null);
      const updated = {
        ...merged,
        state: result.ok && current.state === 'busy' ? 'busy' : result.ok ? 'ready' : result.state,
        health: result.ok ? 'healthy' : result.error_code,
        health_detail: result,
        updated_at: nowIso(clock),
      };
      delete updated.driver;
      memory.set(deviceRef, updated);
      await flush();
      return { ok: result.ok, device: { ...updated }, ...(!result.ok ? { error_code: result.error_code } : {}) };
    });
  }

  async function claim(deviceRef, { sessionId = crypto.randomUUID() } = {}) {
    return serialize(async () => {
      await load({ refresh: true });
      const device = memory.get(deviceRef);
      if (!device) return { ok: false, error_code: 'device_not_found' };
      if (device.active_session_id) {
        return { ok: false, error_code: 'device_busy', device: { ...device } };
      }
      if (device.state === 'offline') return { ok: false, error_code: 'device_offline', device: { ...device } };
      if (device.state === 'manual_required') {
        return { ok: false, error_code: device.health ?? 'manual_required', device: { ...device } };
      }
      if (device.state !== 'ready' && device.state !== 'paired') {
        return { ok: false, error_code: 'device_unavailable', device: { ...device } };
      }
      const health = await evaluateHealth(device);
      if (!health.ok) {
        const blocked = {
          ...device,
          state: health.state,
          health: health.error_code,
          health_detail: health,
          updated_at: nowIso(clock),
        };
        memory.set(deviceRef, blocked);
        await flush();
        return { ok: false, error_code: health.error_code, device: { ...blocked } };
      }
      const claimed = {
        ...device,
        health: 'healthy',
        health_detail: health,
        state: 'busy',
        active_session_id: sessionId,
        updated_at: nowIso(clock),
      };
      memory.set(deviceRef, claimed);
      await flush();
      return { ok: true, session_id: sessionId, device: { ...claimed } };
    });
  }

  async function release(input) {
    if (!input || typeof input !== 'object') {
      return { ok: false, error_code: 'session_lease_required' };
    }
    const deviceRef = input.device_ref;
    const sessionId = input.session_id;
    if (typeof deviceRef !== 'string' || typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error_code: 'session_lease_required' };
    }
    return serialize(async () => {
      await load({ refresh: true });
      const device = memory.get(deviceRef);
      if (!device) return { ok: false, error_code: 'device_not_found' };
      if (!device.active_session_id) return { ok: false, error_code: 'session_not_found' };
      if (device.active_session_id !== sessionId) {
        return { ok: false, error_code: 'session_mismatch' };
      }
      const released = {
        ...device,
        state: device.manual_takeover
          ? 'manual_required'
          : device.online === false ? 'offline' : device.locked ? 'manual_required' : 'ready',
        active_session_id: null,
        updated_at: nowIso(clock),
      };
      memory.set(deviceRef, released);
      await flush();
      return { ok: true, device: { ...released } };
    });
  }

  async function markManualRequired(deviceRef, details = {}) {
    return serialize(async () => {
      await load({ refresh: true });
      const device = memory.get(deviceRef);
      if (!device) return { ok: false, error_code: 'device_not_found' };
      const updated = {
        ...device,
        state: 'manual_required',
        health: details.error_code ?? 'manual_required',
        manual_takeover: {
          status: 'manual_required',
          device_ref: deviceRef,
          error_code: details.error_code ?? 'manual_required',
          reason: details.message ?? details.error_code ?? 'Manual takeover required.',
          created_at: nowIso(clock),
        },
        updated_at: nowIso(clock),
      };
      memory.set(deviceRef, updated);
      await flush();
      return { ok: true, device: { ...updated } };
    });
  }

  return Object.freeze({
    rootDir: root,
    registerDevice,
    get,
    list,
    health,
    claim,
    release,
    markManualRequired,
    states: IOS_DEVICE_STATES,
  });
}

const defaultRegistry = createDeviceRegistry();

export async function registerDevice(input) {
  return defaultRegistry.registerDevice(input);
}

export { stateFromPrerequisites };
