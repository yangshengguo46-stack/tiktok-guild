import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWdaHealthChecker, isVerifiedWdaHealth } from './wda-health.mjs';

const DEFAULT_BUNDLE_ID = 'com.zhiliaoapp.musically';
const SAFE_LOCATOR_KEYS = new Set(['accessibility_id', 'accessibilityId', 'text', 'label', 'predicate', 'class_chain']);
const ACTIVE_DEVICES = new Map();

export class IosSessionError extends Error {
  constructor(errorCode, message = errorCode, details = {}) {
    super(message);
    this.name = 'IosSessionError';
    this.error_code = errorCode;
    this.details = details;
  }
}

function locatorKind(locator) {
  if (typeof locator === 'string') return 'accessibility_id';
  if (!locator || typeof locator !== 'object') return null;
  return Object.keys(locator).find((key) => SAFE_LOCATOR_KEYS.has(key)) ?? null;
}

function hasCoordinateOnlyLocator(locator) {
  return Boolean(locator && typeof locator === 'object'
    && (locator.x !== undefined || locator.y !== undefined)
    && !locatorKind(locator));
}

function normalizeElement(element) {
  if (!element) return null;
  return {
    raw: element,
    async isVisible() {
      if (typeof element.isDisplayed === 'function') return Boolean(await element.isDisplayed());
      if (typeof element.isVisible === 'function') return Boolean(await element.isVisible());
      if (typeof element.visible === 'boolean') return element.visible;
      return true;
    },
    async getAttribute(name) {
      if (typeof element.getAttribute === 'function') return element.getAttribute(name);
      if (typeof element.attribute === 'function') return element.attribute(name);
      if (element.attributes) return element.attributes[name] ?? null;
      return element[name] ?? null;
    },
    async textContent() {
      if (typeof element.getText === 'function') return element.getText();
      if (typeof element.textContent === 'function') return element.textContent();
      return element.text ?? element.value ?? '';
    },
    async click() {
      if (typeof element.click !== 'function') throw new IosSessionError('selector_missing', 'Element cannot be tapped.');
      return element.click();
    },
    async clear() {
      if (typeof element.clear === 'function') return element.clear();
      return undefined;
    },
    async type(value) {
      if (typeof element.setValue === 'function') return element.setValue(value);
      if (typeof element.sendKeys === 'function') return element.sendKeys(value);
      if (typeof element.type === 'function') return element.type(value);
      throw new IosSessionError('selector_missing', 'Element cannot accept text.');
    },
    async press(key) {
      if (typeof element.press === 'function') return element.press(key);
      if (typeof element.sendKeys === 'function') return element.sendKeys(key);
      throw new IosSessionError('manual_required', 'Search control cannot submit Enter through the available driver API.');
    },
  };
}

export function createXcuitestSession({
  device,
  bundle_id: bundleId = DEFAULT_BUNDLE_ID,
  noReset = true,
  driver = null,
  driverFactory = null,
  registry = null,
  healthCheck = null,
  navigationAdapter = null,
  evidenceRoot = null,
  sessionId = crypto.randomUUID(),
} = {}) {
  if (!device || typeof device !== 'object') throw new TypeError('device is required.');
  if (typeof device.device_ref !== 'string' || !device.device_ref) throw new TypeError('device.device_ref is required.');
  if (!bundleId) throw new TypeError('bundle_id is required.');
  if (noReset !== true) throw new TypeError('XCUITest sessions require noReset=true.');

  let resolvedDriver = driver;
  let claimed = false;
  let closed = false;
  let launched = false;
  let lease = null;
  const actualEvidenceRoot = evidenceRoot ? path.resolve(evidenceRoot) : null;
  const defaultHealthCheck = createWdaHealthChecker({
    driverProbe: async ({ driver: activeDriver }) => {
      if (!activeDriver) return false;
      if (typeof activeDriver.getStatus === 'function') {
        const status = await activeDriver.getStatus();
        return {
          ready: status?.ready === true,
          device_verified: status?.device_verified === true,
          wda_verified: status?.wda_verified === true,
        };
      }
      if (typeof activeDriver.isWdaHealthy === 'function') {
        const result = await activeDriver.isWdaHealthy();
        return result;
      }
      if (typeof activeDriver.status === 'function') {
        const status = await activeDriver.status();
        return {
          ready: status?.ready === true,
          device_verified: status?.device_verified === true,
          wda_verified: status?.wda_verified === true,
        };
      }
      return false;
    },
  });

  async function ensureHealth() {
    const result = await (healthCheck ?? defaultHealthCheck)({ device, driver: resolvedDriver });
    if (!isVerifiedWdaHealth(result)) {
      throw new IosSessionError(
        result?.error_code ?? 'wda_unavailable',
        result?.message ?? 'The WDA health contract was not verified.',
        result,
      );
    }
    return result;
  }

  async function ensureDriver() {
    if (resolvedDriver) return resolvedDriver;
    if (typeof driverFactory !== 'function') {
      throw new IosSessionError('wda_unavailable', 'No Appium/XCUITest driver was supplied.');
    }
    try {
      resolvedDriver = await driverFactory({
        udid: device.udid,
        platformVersion: device.platform_version,
        bundleId,
        wdaLocalPort: device.wda_local_port,
        noReset,
      });
      return resolvedDriver;
    } catch (error) {
      throw new IosSessionError('wda_unavailable', error instanceof Error ? error.message : 'WebDriverAgent session could not start.');
    }
  }

  async function claimDevice() {
    if (claimed) return;
    if (registry) {
      const result = await registry.claim(device.device_ref, { sessionId });
      if (!result.ok) throw new IosSessionError(result.error_code, `Device session could not be claimed: ${result.error_code}`, result);
      lease = result;
      claimed = true;
      return;
    }
    if (ACTIVE_DEVICES.has(device.device_ref)) {
      throw new IosSessionError('device_busy', 'Only one active XCUITest session is allowed per device.', {
        device_ref: device.device_ref,
      });
    }
    ACTIVE_DEVICES.set(device.device_ref, sessionId);
    claimed = true;
  }

  async function launch() {
    if (closed) throw new IosSessionError('session_closed', 'The XCUITest session is closed.');
    const activeDriver = await ensureDriver();
    await ensureHealth();
    await claimDevice();
    try {
      if (typeof activeDriver.activateApp === 'function') await activeDriver.activateApp(bundleId);
      else if (typeof activeDriver.launchApp === 'function') await activeDriver.launchApp();
      else if (typeof activeDriver.startActivity === 'function') await activeDriver.startActivity({ appPackage: bundleId });
      else throw new IosSessionError('app_launch_failed', 'The driver has no app launch method.');
      launched = true;
      return { ok: true, bundle_id: bundleId, noReset };
    } catch (error) {
      if (error instanceof IosSessionError) throw error;
      throw new IosSessionError('app_launch_failed', error instanceof Error ? error.message : 'TikTok could not be launched.');
    }
  }

  async function find(locator, { coordinateEvidence = null } = {}) {
    coordinateEvidence ??= locator?.evidence ?? null;
    if (hasCoordinateOnlyLocator(locator)) {
      if (!coordinateEvidence) {
        throw new IosSessionError('locator_evidence_required', 'Coordinate-only actions require an attached locator evidence record.');
      }
      throw new IosSessionError('manual_required', 'Coordinate-only fallback is disabled; use an accessibility locator or manual takeover.', {
        coordinate_evidence: coordinateEvidence,
      });
    }
    const kind = locatorKind(locator);
    if (!kind) throw new IosSessionError('selector_missing', 'An accessibility id, visible text, or predicate locator is required.');
    const activeDriver = await ensureDriver();
    let element = null;
    try {
      if (typeof activeDriver.find === 'function') {
        element = await activeDriver.find(locator);
      } else if (typeof activeDriver.$ === 'function') {
        const value = typeof locator === 'string' ? locator : locator[kind];
        element = await activeDriver.$(kind === 'accessibility_id' || kind === 'accessibilityId'
          ? `~${value}`
          : kind === 'text' || kind === 'label'
            ? `//XCUIElementTypeAny[@label="${String(value).replaceAll('"', '\\"')}"]`
            : String(value));
      } else if (typeof activeDriver.findElement === 'function') {
        const strategy = kind === 'accessibility_id' || kind === 'accessibilityId'
          ? 'accessibility id'
          : kind === 'text' || kind === 'label' ? 'xpath' : kind;
        const value = strategy === 'xpath'
          ? `//XCUIElementTypeAny[@label="${String(locator[kind]).replaceAll('"', '\\"')}"]`
          : locator[kind] ?? locator;
        element = await activeDriver.findElement(strategy, value);
      }
    } catch (error) {
      throw new IosSessionError('selector_missing', error instanceof Error ? error.message : 'Accessibility locator lookup failed.');
    }
    const normalized = normalizeElement(element);
    if (!normalized || !await normalized.isVisible()) {
      throw new IosSessionError('selector_missing', 'The accessibility control is missing or not visible.', { locator });
    }
    return normalized;
  }

  async function tap(locator, options = {}) {
    const element = await find(locator, options);
    await element.click();
    return { ok: true, locator };
  }

  async function type(locator, value, options = {}) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new IosSessionError('provider_rejected', 'Text input is required.');
    }
    const element = await find(locator, options);
    await element.clear();
    await element.type(value);
    return { ok: true, locator, text: value };
  }

  async function count(locator) {
    const activeDriver = await ensureDriver();
    if (typeof activeDriver.count === 'function') {
      const value = await activeDriver.count(locator);
      return Number.isFinite(Number(value)) ? Number(value) : null;
    }
    if (typeof activeDriver.$$ === 'function') {
      const elements = await activeDriver.$$(typeof locator === 'string' ? locator : locator?.accessibility_id ?? locator);
      return Array.isArray(elements) ? elements.length : null;
    }
    if (typeof activeDriver.findElements === 'function') {
      const kind = locatorKind(locator);
      const strategy = kind === 'accessibility_id' || kind === 'accessibilityId'
        ? 'accessibility id'
        : kind === 'text' || kind === 'label' ? 'xpath' : kind;
      const value = strategy === 'xpath'
        ? `//XCUIElementTypeAny[@label="${String(locator[kind]).replaceAll('"', '\\"')}"]`
        : locator?.[kind] ?? locator;
      const elements = await activeDriver.findElements(strategy, value);
      return Array.isArray(elements) ? elements.length : null;
    }
    return null;
  }

  async function readCreatorIdentity(locator) {
    const identity = await find(locator);
    return {
      creator_uid: await identity.getAttribute('data-creator-uid')
        ?? await identity.getAttribute('creator_uid')
        ?? await identity.getAttribute('data-user-id')
        ?? await identity.getAttribute('user_id'),
      handle: await identity.getAttribute('data-creator-handle')
        ?? await identity.getAttribute('data-username')
        ?? await identity.getAttribute('username')
        ?? await identity.getAttribute('label')
        ?? await identity.getAttribute('name'),
      verification_source: 'tiktok-ios@1:profile-identity',
    };
  }

  async function navigateToCreator({ creator = {}, locators = {} } = {}) {
    const profileUrl = creator.profile_url ?? creator.profileUrl ?? null;
    if (profileUrl) {
      if (typeof navigationAdapter !== 'function') {
        throw new IosSessionError('manual_required', 'Profile URL navigation requires an explicit app-level navigation adapter.');
      }
      const navigation = await navigationAdapter({ creator, profile_url: profileUrl, driver: await ensureDriver() });
      if (!navigation || navigation.ok !== true) {
        throw new IosSessionError('manual_required', 'The app-level profile navigation adapter did not verify navigation.', {
          navigation,
        });
      }
      return readCreatorIdentity(locators.creatorIdentity);
    }
    const handle = creator.handle ?? creator.username ?? null;
    if (!handle) throw new IosSessionError('provider_rejected', 'A creator profile URL or canonical handle is required.');
    await type(locators.creatorSearch, String(handle));
    const search = await find(locators.creatorSearch);
    await search.press('Enter');
    await tap(locators.creatorResult);
    return readCreatorIdentity(locators.creatorIdentity);
  }

  async function screenshot() {
    const activeDriver = await ensureDriver();
    if (typeof activeDriver.takeScreenshot !== 'function') {
      throw new IosSessionError('unknown', 'The driver cannot capture a screenshot.');
    }
    return activeDriver.takeScreenshot();
  }

  async function accessibilitySnapshot() {
    const activeDriver = await ensureDriver();
    if (typeof activeDriver.getPageSource === 'function') return activeDriver.getPageSource();
    if (typeof activeDriver.getAccessibilityTree === 'function') return activeDriver.getAccessibilityTree();
    if (typeof activeDriver.accessibilitySnapshot === 'function') return activeDriver.accessibilitySnapshot();
    throw new IosSessionError('unknown', 'The driver cannot capture an accessibility snapshot.');
  }

  async function captureFailureEvidence({ errorCode = 'unknown' } = {}) {
    const evidence = [];
    try {
      const image = await screenshot();
      if (actualEvidenceRoot) {
        await mkdir(actualEvidenceRoot, { recursive: true });
        const screenshotPath = path.join(actualEvidenceRoot, `${sessionId}-${errorCode}.png`);
        const bytes = Buffer.from(String(image).replace(/^data:image\/png;base64,/, ''), 'base64');
        await writeFile(screenshotPath, bytes);
        evidence.push({ type: 'screenshot', path: screenshotPath, source: 'failure_evidence' });
      } else {
        evidence.push({ type: 'screenshot', value: image, source: 'failure_evidence' });
      }
    } catch (error) {
      evidence.push({ type: 'screenshot_unavailable', message: error instanceof Error ? error.message : 'Screenshot unavailable.' });
    }
    try {
      const snapshot = await accessibilitySnapshot();
      if (actualEvidenceRoot) {
        await mkdir(actualEvidenceRoot, { recursive: true });
        const snapshotPath = path.join(actualEvidenceRoot, `${sessionId}-${errorCode}.xml`);
        await writeFile(snapshotPath, String(snapshot), 'utf8');
        evidence.push({ type: 'accessibility_snapshot', path: snapshotPath, source: 'failure_evidence' });
      } else {
        evidence.push({ type: 'accessibility_snapshot', value: snapshot, source: 'failure_evidence' });
      }
    } catch (error) {
      evidence.push({ type: 'accessibility_snapshot_unavailable', message: error instanceof Error ? error.message : 'Accessibility snapshot unavailable.' });
    }
    return evidence;
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (resolvedDriver) {
        if (typeof resolvedDriver.deleteSession === 'function') await resolvedDriver.deleteSession();
        else if (typeof resolvedDriver.quit === 'function') await resolvedDriver.quit();
      }
    } finally {
      if (claimed && registry) {
        await registry.release({ device_ref: device.device_ref, session_id: sessionId });
      } else if (claimed && ACTIVE_DEVICES.get(device.device_ref) === sessionId) {
        ACTIVE_DEVICES.delete(device.device_ref);
      }
      claimed = false;
    }
  }

  return Object.freeze({
    session_id: sessionId,
    device_ref: device.device_ref,
    bundle_id: bundleId,
    noReset,
    get launched() { return launched; },
    get lease() { return lease; },
    launch,
    find,
    tap,
    type,
    count,
    navigateToCreator,
    readCreatorIdentity,
    screenshot,
    accessibilitySnapshot,
    captureFailureEvidence,
    close,
  });
}
