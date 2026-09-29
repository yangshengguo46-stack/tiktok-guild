import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const IOS_DEVICE_STATES = Object.freeze([
  'paired',
  'ready',
  'busy',
  'offline',
  'manual_required',
]);

function bool(value) {
  return value === true || value === 'true' || value === 1;
}

function prerequisiteResult(input = {}) {
  return {
    platform: bool(input.platform),
    xcode: bool(input.xcode),
    wda: bool(input.wda),
    paired: input.paired !== false,
    online: input.online !== false,
    locked: input.locked === true,
    reason: input.reason ?? null,
  };
}

export async function detectMacPrerequisites({
  platform = process.platform,
  xcodeSelect = null,
  wdaBundleId = null,
  paired = true,
  online = true,
  locked = false,
} = {}) {
  if (platform !== 'darwin') {
    return prerequisiteResult({
      platform: false,
      xcode: false,
      wda: false,
      paired,
      online,
      locked,
      reason: 'iPhone XCUITest requires macOS.',
    });
  }

  let xcode = Boolean(xcodeSelect);
  let reason = null;
  if (!xcode) {
    try {
      await execFileAsync('xcode-select', ['-p'], { timeout: 5_000 });
      xcode = true;
    } catch {
      reason = 'Xcode command line tools are unavailable.';
    }
  }
  const wda = Boolean(wdaBundleId);
  if (!wda && !reason) reason = 'A signed WebDriverAgent bundle id is required.';
  return prerequisiteResult({
    platform: true,
    xcode,
    wda,
    paired,
    online,
    locked,
    reason,
  });
}

export function stateFromPrerequisites(prerequisites = {}) {
  const result = prerequisiteResult(prerequisites);
  if (!result.paired) return 'manual_required';
  if (result.locked) return 'manual_required';
  if (!result.online) return 'offline';
  if (!result.platform || !result.xcode || !result.wda) return 'manual_required';
  return 'ready';
}

export function createWdaHealthChecker({
  prerequisites = null,
  prerequisiteProbe = detectMacPrerequisites,
  driverProbe = null,
  requireProbe = true,
} = {}) {
  return async function checkWdaHealth({ device = {}, driver = null } = {}) {
    const checked = prerequisites
      ? await (typeof prerequisites === 'function' ? prerequisites({ device }) : prerequisites)
      : await prerequisiteProbe({
        platform: device.platform ?? process.platform,
        wdaBundleId: device.wda_bundle_id,
        paired: device.paired,
        online: device.online,
        locked: device.locked,
      });
    const normalized = prerequisiteResult({
      ...checked,
      ...(device.paired === false ? { paired: false } : {}),
      ...(device.online === false ? { online: false } : {}),
      ...(device.locked === true ? { locked: true } : {}),
    });
    if (normalized.locked) {
      return {
        ok: false,
        state: 'manual_required',
        error_code: 'device_locked',
        prerequisites: normalized,
        message: 'Unlock and trust the iPhone before starting XCUITest.',
      };
    }
    if (!normalized.paired) {
      return {
        ok: false,
        state: 'manual_required',
        error_code: 'device_unpaired',
        prerequisites: normalized,
        message: 'Pair and trust the iPhone before starting XCUITest.',
      };
    }
    if (!normalized.online) {
      return {
        ok: false,
        state: 'offline',
        error_code: 'device_offline',
        prerequisites: normalized,
        message: 'The iPhone is offline or disconnected.',
      };
    }
    if (!normalized.platform || !normalized.xcode || !normalized.wda) {
      return {
        ok: false,
        state: 'manual_required',
        error_code: 'wda_unavailable',
        prerequisites: normalized,
        message: normalized.reason ?? 'macOS, Xcode, and a signed WebDriverAgent are required.',
      };
    }
    if (requireProbe && typeof driverProbe !== 'function') {
      return {
        ok: false,
        state: 'manual_required',
        error_code: 'wda_probe_required',
        prerequisites: normalized,
        message: 'A live WebDriverAgent health probe is required before marking the device ready.',
      };
    }
    if (typeof driverProbe === 'function') {
      try {
        const probe = await driverProbe({ device, driver });
        if (probe === false) {
          return {
            ok: false,
            state: 'offline',
            error_code: 'wda_unavailable',
            prerequisites: normalized,
            message: 'WebDriverAgent did not answer its health probe.',
          };
        }
      } catch (error) {
        return {
          ok: false,
          state: 'offline',
          error_code: 'wda_unavailable',
          prerequisites: normalized,
          message: error instanceof Error ? error.message : 'WebDriverAgent health probe failed.',
        };
      }
    }
    return { ok: true, state: 'ready', prerequisites: normalized };
  };
}

export async function checkWdaHealth(options = {}) {
  return createWdaHealthChecker()(options);
}
