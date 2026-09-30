import crypto from 'node:crypto';
import path from 'node:path';
import { createPlaywrightPool } from './web/playwright-pool.mjs';
import { executeWebAction } from './web/tiktok-web-executor.mjs';
import { createXcuitestSession } from './ios/xcuitest-session.mjs';
import { executeIosAction } from './ios/tiktok-ios-executor.mjs';
import { createAppiumDriver } from './ios/appium-driver.mjs';
import { acquireResourceSlot } from './resource-slots.mjs';
import { checkProxyEndpoint, parseWebRoute, probeBrowserEgress } from './web/network-route.mjs';

export function createProductionExecutor({ runtimeRoot, config = {}, chromium = null, driverFactory = createAppiumDriver }) {
  let pool;
  let closed = false;
  const sessions = new Set();
  const heldSlots = new Set();
  const prepared = new Map();
  const pilot = config.pilot ?? {};
  const binding = config.sender;
  function senderMatches(account) {
    return binding && binding.owner_user_id === account?.owner_user_id
      && binding.sender_account_id === account?.sender_account_id && binding.channel === account?.channel;
  }
  function admitted({ account, creator, action }) {
    return pilot.enabled === true && pilot.owner_user_id === account.owner_user_id
      && pilot.sender_account_id === account.sender_account_id && pilot.creator_uid === creator.creator_uid
      && Array.isArray(pilot.actions) && pilot.actions.includes(action)
      && (action !== 'message' || pilot.message_enabled === true);
  }
  async function webPool(route) {
    if (!pool) {
      const realChromium = chromium ?? (await import('playwright')).chromium;
      pool = createPlaywrightPool({
        profileRoot: path.join(runtimeRoot, 'web-profiles'),
        launchPersistentContext: (directory) => realChromium.launchPersistentContext(directory, {
          headless: binding.headless !== false,
          proxy: route.proxy,
        }),
      });
    }
    return pool;
  }
  async function releaseEntry(entry) {
    clearTimeout(entry.timer);
    entry.expired = true;
    try {
      await pool.release(entry.lease.lease_id);
      await entry.slot.release();
      heldSlots.delete(entry.slot);
      prepared.delete(entry.id);
    } catch (error) {
      heldSlots.add(entry.slot);
      throw error;
    }
  }
  async function prepareWeb({ account } = {}) {
    if (closed) return { ready: false, error_code: 'operator_closed' };
    if (!senderMatches(account) || account.channel !== 'web') return { ready: false, error_code: 'sender_unconfigured' };
    let route;
    try { route = parseWebRoute(binding.web_route); }
    catch (error) { return { ready: false, error_code: error.code ?? 'web_route_invalid' }; }
    const endpoint = await checkProxyEndpoint(route);
    if (!endpoint.ready) return endpoint;
    const slot = await acquireResourceSlot({ root: runtimeRoot, kind: 'web', maximum: 10 });
    if (!slot.ok) return { ready: false, error_code: slot.error_code };
    let lease;
    let browserMayExist = false;
    try {
      const targetPool = await webPool(route);
      const resourceId = crypto.createHash('sha256').update(`${account.owner_user_id}\0${account.sender_account_id}`).digest('hex');
      const existing = await targetPool.health(resourceId);
      if (existing.ok && (existing.account.status !== 'enabled' || existing.account.health !== 'healthy')) {
        await slot.release();
        return { ready: false, error_code: 'profile_unavailable' };
      }
      if (!existing.ok && existing.error_code !== 'account_not_found') {
        await slot.release();
        return { ready: false, error_code: existing.error_code };
      }
      if (!existing.ok) {
        const registered = await targetPool.register({ sender_account_id: resourceId, channel: 'web', status: 'enabled', health: 'healthy', external_ref: account.external_ref });
        if (!registered.ok) {
          await slot.release();
          return { ready: false, error_code: registered.error_code };
        }
      }
      await slot.markCleanupRequired();
      browserMayExist = true;
      lease = await targetPool.claim(resourceId);
      if (!lease.ok) {
        await slot.release();
        return { ready: false, error_code: lease.error_code };
      }
      const observation = await probeBrowserEgress(lease.context, route);
      if (!observation.ready) {
        await targetPool.release(lease.lease_id);
        await slot.release();
        return observation;
      }
      const id = crypto.randomUUID();
      const entry = { id, owner: account.owner_user_id, sender: account.sender_account_id, lease, slot, expired: false, timer: null };
      entry.timer = setTimeout(() => { void releaseEntry(entry).catch(() => {}); }, 90_000);
      entry.timer.unref?.();
      prepared.set(id, entry);
      return { ready: true, preparation_id: id, observed_country: observation.observedCountry };
    } catch (error) {
      if (lease?.ok) {
        try { await pool.release(lease.lease_id); await slot.release(); }
        catch { heldSlots.add(slot); return { ready: false, error_code: 'browser_cleanup_failed' }; }
      } else if (browserMayExist) {
        heldSlots.add(slot);
      } else {
        await slot.release().catch(() => heldSlots.add(slot));
      }
      return { ready: false, error_code: error?.code ?? 'browser_launch_failed' };
    }
  }
  async function releaseWeb({ preparation_id } = {}) {
    const entry = prepared.get(preparation_id);
    if (!entry) return { released: false, error_code: 'preparation_not_found' };
    await releaseEntry(entry);
    return { released: true };
  }
  async function execute(request) {
    if (closed) return { verified: false, error_code: 'operator_closed' };
    if (!admitted(request)) return { verified: false, error_code: 'pilot_required' };
    const { account, creator, action } = request;
    if (!senderMatches(account)) {
      return { verified: false, error_code: 'sender_unconfigured' };
    }
    const payload = { comment: request.payload?.comment, message: request.payload?.message, pilotEnabled: true, locators: binding.locators };
    if (account.channel === 'web') {
      if (!request.preparation_id) return { verified: false, error_code: 'web_preparation_required' };
      const entry = prepared.get(request.preparation_id);
      if (!entry) return { verified: false, error_code: 'preparation_not_found' };
      if (entry.owner !== account.owner_user_id || entry.sender !== account.sender_account_id) return { verified: false, error_code: 'preparation_mismatch' };
      if (entry.expired) return { verified: false, error_code: 'preparation_expired' };
      clearTimeout(entry.timer);
      prepared.delete(entry.id);
      try {
        const browserPage = await entry.lease.context.newPage();
        await browserPage.goto('https://www.tiktok.com/');
        // Keep the resource id private. Receipts identify the native sender.
        return await executeWebAction({ account: { ...entry.lease, account: { ...entry.lease.account, sender_account_id: account.sender_account_id, page: browserPage } }, creator, action, payload, signal: request.signal });
      } finally {
        await releaseEntry(entry);
      }
    }
    if (account.channel !== 'ios') return { verified: false, error_code: 'channel_mismatch' };
    const slot = await acquireResourceSlot({ root: runtimeRoot, kind: 'ios', maximum: 1 });
    if (!slot.ok) return { verified: false, error_code: slot.error_code };
    let cleanupSucceeded = true;
    try {
      const device = { ...binding.device, device_ref: account.device_ref };
      const session = createXcuitestSession({ device,
        driverFactory: () => driverFactory({ ...binding.device, appiumUrl: binding.appium_url, wdaUrl: binding.wda_url, wdaBundleId: binding.device.wda_bundle_id, platformVersion: binding.device.platform_version, bundleId: binding.bundle_id ?? 'com.zhiliaoapp.musically' }),
        healthCheck: ({ driver }) => driver.verifyHealth(),
        navigationAdapter: ({ driver, profile_url }) => driver.openProfile(profile_url, binding.bundle_id ?? 'com.zhiliaoapp.musically'),
      });
      sessions.add(session);
      try { return await executeIosAction({ device, account: { ...account, session }, creator, action, payload, signal: request.signal }); }
      finally {
        try { await session.close(); sessions.delete(session); } catch (error) { cleanupSucceeded = false; throw error; }
      }
    } finally { if (cleanupSucceeded) await slot.release(); else heldSlots.add(slot); }
  }
  async function close() {
    closed = true;
    const releases = await Promise.allSettled([...prepared.values()].map((entry) => releaseEntry(entry)));
    for (const result of releases) if (result.status === 'rejected') { /* Pool close below retries confirmed cleanup. */ }
    const results = await Promise.allSettled([...sessions].map((session) => session.close()));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), 'Device cleanup remains unconfirmed');
    await pool?.close();
    for (const entry of prepared.values()) heldSlots.add(entry.slot);
    prepared.clear();
    await Promise.all([...heldSlots].map(async (slot) => { await slot.release(); heldSlots.delete(slot); }));
  }
  return { prepareWeb, releaseWeb, execute, close };
}
