import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { acquireResourceSlot } from '../resource-slots.mjs';
import { checkAndroidDevice, runAdb as defaultRunAdb } from './adb.mjs';
import { createAndroidDriver } from './appium-driver.mjs';

function decodeXml(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (match, numeric, named) => {
    if (numeric) { try { return String.fromCodePoint(numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric)); } catch { return match; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()] ?? match;
  });
}

export function compactHierarchy(xml, { maxNodes = 120, maxText = 100 } = {}) {
  if (typeof xml !== 'string') return [];
  const result = [];
  for (const tag of xml.matchAll(/<node\b([^>]*)\/?\s*>/g)) {
    if (result.length >= maxNodes) break;
    const attrs = {};
    for (const match of tag[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[match[1]] = decodeXml(match[2]);
    if (attrs.password === 'true') continue;
    const item = {};
    if (attrs.text) item.text = attrs.text.slice(0, maxText);
    if (attrs['resource-id']) item.resource_id = attrs['resource-id'].slice(0, 160);
    if (attrs['content-desc']) item.description = attrs['content-desc'].slice(0, maxText);
    if (attrs['class']) item.class = attrs.class.slice(0, 100);
    if (attrs.clickable === 'true') item.clickable = true;
    if (attrs.selected === 'true') item.selected = true;
    if (attrs.checked === 'true') item.checked = true;
    if (Object.keys(item).length) result.push(item);
  }
  return result;
}

export function semanticLocator(locator) {
  if (!locator || typeof locator !== 'object') throw Object.assign(new Error('Semantic locator required.'), { error_code: 'selector_missing' });
  const entries = Object.entries(locator);
  if (entries.length !== 1 || typeof entries[0][1] !== 'string' || !entries[0][1]) throw Object.assign(new Error('Exactly one semantic locator required.'), { error_code: 'selector_missing' });
  const [kind, value] = entries[0];
  const strategies = { resource_id: 'id', accessibility_id: 'accessibility id', ui_automator: '-android uiautomator', xpath: 'xpath' };
  if (!strategies[kind]) throw Object.assign(new Error('Unsupported locator.'), { error_code: 'selector_missing' });
  return [strategies[kind], value];
}

function validateDevice(device) {
  if (!device || typeof device !== 'object' || !device.device_ref || !device.udid || !device.appium_url || !Number.isInteger(device.system_port)) {
    throw new Error('Explicit device_ref, udid, appium_url and system_port are required.');
  }
  return device;
}

function deviceKey(device) { return crypto.createHash('sha256').update(device.device_ref).digest('hex'); }
function unavailable(device, error_code) { return { ok: false, error_code, device_ref: device.device_ref }; }

export function createAndroidDeviceRuntime({ root, runAdb = defaultRunAdb, driverFactory = createAndroidDriver } = {}) {
  if (!root) throw new Error('Runtime root required.');
  async function doctor(device) {
    validateDevice(device);
    const probe = await checkAndroidDevice(device.udid, runAdb);
    return probe.ok ? { ok: true, device_ref: device.device_ref, udid: device.udid } : unavailable(device, probe.error_code);
  }
  async function locked(device, operation) {
    validateDevice(device);
    const slot = await acquireResourceSlot({ root, kind: `android-device-${deviceKey(device)}`, maximum: 1 });
    if (!slot.ok) return unavailable(device, 'device_busy');
    let hold = false;
    try {
      const result = await operation();
      if (result?.hold_lock) {
        await slot.markCleanupRequired();
        hold = true;
        const { hold_lock: ignored, ...publicResult } = result;
        return publicResult;
      }
      return result;
    } finally { if (!hold) await slot.release(); }
  }
  function marker(device) { return path.join(root, 'manual', `${deviceKey(device)}.json`); }
  async function manuallyHeld(device) { try { await readFile(marker(device)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  async function takeover(device) {
    return locked(device, async () => {
      await mkdir(path.dirname(marker(device)), { recursive: true, mode: 0o700 });
      const handle = await open(marker(device), 'w', 0o600);
      try { await handle.writeFile(JSON.stringify({ device_ref: device.device_ref, udid: device.udid, requested_at: new Date().toISOString() })); }
      finally { await handle.close(); }
      return { ok: true, device_ref: device.device_ref, scrcpy: ['scrcpy', '-s', device.udid] };
    });
  }
  async function resume(device) { return locked(device, async () => { await rm(marker(device), { force: true }); return { ok: true, device_ref: device.device_ref }; }); }
  async function control(device, commands) {
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20) throw new Error('Provide 1–20 device commands.');
    return locked(device, async () => {
      if (await manuallyHeld(device)) return unavailable(device, 'manual_takeover');
      const health = await doctor(device);
      if (!health.ok) return health;
      let driver;
      let wrote = false;
      let result;
      try {
        driver = await driverFactory({ appiumUrl: device.appium_url, udid: device.udid, systemPort: device.system_port, appPackage: device.app_package, appActivity: device.app_activity });
        const results = [];
        for (const command of commands) {
          if (command.type === 'observe') results.push({ nodes: compactHierarchy(await driver.getPageSource()) });
          else if (command.type === 'tap' || command.type === 'type') {
            const [using, value] = semanticLocator(command.locator);
            const element = await driver.findElement(using, value);
            wrote = true;
            if (command.type === 'tap') await element.click();
            else {
              if (typeof command.text !== 'string' || command.text.length > 2000) throw new Error('Bounded text required.');
              await element.clear(); await element.setValue(command.text);
            }
            results.push({ ok: true });
          } else if (command.type === 'back') { wrote = true; await driver.back(); results.push({ ok: true }); }
          else if (command.type === 'swipe') {
            const valid = (point) => point && Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.y >= 0;
            if (!valid(command.from) || !valid(command.to)) throw new Error('Valid swipe points required.');
            wrote = true; await driver.swipe(command.from, command.to); results.push({ ok: true });
          } else if (command.type === 'launch') {
            if (!device.app_package) throw new Error('Configured app package required.');
            wrote = true; await driver.activateApp(device.app_package); results.push({ ok: true });
          } else throw new Error('Unsupported device command.');
        }
        result = { ok: true, device_ref: device.device_ref, results };
      } catch (error) {
        if (wrote) await takeoverMarker(device);
        result = unavailable(device, wrote ? 'write_unknown' : (error.error_code ?? 'device_command_failed'));
      } finally {
        try { await driver?.deleteSession(); }
        catch {
          await takeoverMarker(device);
          result = { ...unavailable(device, 'cleanup_unknown'), hold_lock: true };
        }
      }
      return result;
    });
  }
  async function run(device, callback) {
    if (typeof callback !== 'function') throw new Error('Device operation callback required.');
    return locked(device, async () => {
      if (await manuallyHeld(device)) return { verified: false, error_code: 'manual_takeover' };
      const health = await doctor(device);
      if (!health.ok) return { verified: false, error_code: health.error_code };
      let driver;
      let result;
      try {
        driver = await driverFactory({ appiumUrl: device.appium_url, udid: device.udid, systemPort: device.system_port, appPackage: device.app_package, appActivity: device.app_activity });
        result = await callback(driver);
        if (!result || typeof result !== 'object') result = { verified: false, error_code: 'provider_unknown', manual_required: true };
        if (result.manual_required) await takeoverMarker(device);
      } catch (error) {
        await takeoverMarker(device);
        result = { verified: false, error_code: 'provider_unknown', manual_required: true, message: error.message };
      } finally {
        try { await driver?.deleteSession(); }
        catch {
          await takeoverMarker(device);
          result = { verified: false, error_code: 'cleanup_unknown', manual_required: true, hold_lock: true };
        }
      }
      return result;
    });
  }
  async function takeoverMarker(device) {
    await mkdir(path.dirname(marker(device)), { recursive: true, mode: 0o700 });
    const handle = await open(marker(device), 'w', 0o600);
    try { await handle.writeFile(JSON.stringify({ device_ref: device.device_ref, udid: device.udid, reason: 'uncertain_device_write' })); } finally { await handle.close(); }
  }
  return { doctor, control, takeover, resume, run };
}
