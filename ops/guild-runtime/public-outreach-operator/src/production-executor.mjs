import crypto from 'node:crypto';
import path from 'node:path';
import { createPlaywrightPool } from './web/playwright-pool.mjs';
import { executeWebAction } from './web/tiktok-web-executor.mjs';
import { createXcuitestSession } from './ios/xcuitest-session.mjs';
import { executeIosAction } from './ios/tiktok-ios-executor.mjs';
import { createAppiumDriver } from './ios/appium-driver.mjs';
import { acquireResourceSlot } from './resource-slots.mjs';

export function createProductionExecutor({ runtimeRoot, config = {}, chromium = null, driverFactory = createAppiumDriver }) {
  let pool;
  let closed = false;
  const sessions = new Set();
  const pilot = config.pilot ?? {};
  function admitted({ account, creator, action }) {
    return pilot.enabled === true && pilot.owner_user_id === account.owner_user_id
      && pilot.sender_account_id === account.sender_account_id && pilot.creator_uid === creator.creator_uid
      && Array.isArray(pilot.actions) && pilot.actions.includes(action)
      && (action !== 'message' || pilot.message_enabled === true);
  }
  async function execute(request) {
    if (closed) return { verified: false, error_code: 'operator_closed' };
    if (!admitted(request)) return { verified: false, error_code: 'pilot_required' };
    const { account, creator, action } = request;
    const binding = config.sender;
    if (!binding || binding.owner_user_id !== account.owner_user_id || binding.sender_account_id !== account.sender_account_id || binding.channel !== account.channel) {
      return { verified: false, error_code: 'sender_unconfigured' };
    }
    const slot = await acquireResourceSlot({ root: runtimeRoot, kind: account.channel, maximum: account.channel === 'web' ? 10 : 1 });
    if (!slot.ok) return { verified: false, error_code: slot.error_code };
    let cleanupSucceeded = true;
    try {
      const payload = { comment: request.payload?.comment, message: request.payload?.message, pilotEnabled: true, locators: binding.locators };
      if (account.channel === 'web') {
        if (!pool) {
          const realChromium = chromium ?? (await import('playwright')).chromium;
          pool = createPlaywrightPool({ profileRoot: path.join(runtimeRoot, 'web-profiles'), launchPersistentContext: (directory) => realChromium.launchPersistentContext(directory, { headless: binding.headless !== false }) });
        }
        const resourceId = crypto.createHash('sha256').update(`${account.owner_user_id}\0${account.sender_account_id}`).digest('hex');
        const registered = await pool.register({ sender_account_id: resourceId, channel: 'web', status: 'enabled', health: 'healthy', external_ref: account.external_ref });
        if (!registered.ok) return { verified: false, error_code: registered.error_code };
        const lease = await pool.claim(resourceId);
        if (!lease.ok) return { verified: false, error_code: lease.error_code };
        try {
          const browserPage = await lease.context.newPage();
          await browserPage.goto('https://www.tiktok.com/');
          // Keep the resource id private. Receipts identify the native sender.
          return await executeWebAction({ account: { ...lease, account: { ...lease.account, sender_account_id: account.sender_account_id, page: browserPage } }, creator, action, payload, signal: request.signal });
        } finally {
          try { await pool.release(lease.lease_id); } catch (error) { cleanupSucceeded = false; throw error; }
        }
      }
      if (account.channel !== 'ios') return { verified: false, error_code: 'channel_mismatch' };
      const device = { ...binding.device, device_ref: account.device_ref };
      const session = createXcuitestSession({ device,
        driverFactory: () => driverFactory({ ...binding.device, appiumUrl: binding.appium_url, wdaUrl: binding.wda_url, wdaBundleId: binding.device.wda_bundle_id, platformVersion: binding.device.platform_version, bundleId: binding.bundle_id ?? 'com.zhiliaoapp.musically' }),
        healthCheck: ({ driver }) => driver.verifyHealth(),
        navigationAdapter: ({ driver, profile_url }) => driver.openProfile(profile_url, binding.bundle_id ?? 'com.zhiliaoapp.musically'),
      });
      sessions.add(session);
      try { return await executeIosAction({ device, account: { ...account, session }, creator, action, payload, signal: request.signal }); }
      finally {
        try { await session.close(); } catch (error) { cleanupSucceeded = false; throw error; }
        finally { sessions.delete(session); }
      }
    } finally { if (cleanupSucceeded) await slot.release(); }
  }
  async function close() {
    closed = true;
    await Promise.allSettled([...sessions].map((session) => session.close()));
    await pool?.close();
  }
  return { execute, close };
}
