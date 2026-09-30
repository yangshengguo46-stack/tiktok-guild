import { createAndroidDeviceRuntime } from './android/device-runtime.mjs';
import { executeAndroidAction } from './android/tiktok-android-executor.mjs';
import { acquireResourceSlot } from './resource-slots.mjs';

export function createProductionExecutor({ runtimeRoot, config = {}, driverFactory, runAdb } = {}) {
  if (!runtimeRoot) throw new Error('Runtime root required.');
  const devices = Array.isArray(config.devices) ? config.devices : (config.sender?.device ? [{ ...config.sender.device, device_ref: config.sender.device_ref }] : []);
  for (const key of ['device_ref', 'udid', 'system_port']) {
    const values = devices.map((device) => device[key]);
    if (values.some((value) => value === undefined || value === null || value === '') || new Set(values).size !== values.length) {
      throw new Error(`Android devices require unique ${key} values.`);
    }
  }
  const runtime = createAndroidDeviceRuntime({ root: runtimeRoot, ...(driverFactory ? { driverFactory } : {}), ...(runAdb ? { runAdb } : {}) });
  const pilot = config.pilot ?? {};
  let closed = false;
  function deviceFor(ref) {
    const device = devices.find((item) => item.device_ref === ref);
    return device && {
      device_ref: device.device_ref, udid: device.udid, system_port: device.system_port,
      appium_url: device.appium_url, app_package: device.app_package, app_activity: device.app_activity,
    };
  }
  function admitted({ account, creator, action }) {
    return pilot.enabled === true && pilot.owner_user_id === account?.owner_user_id
      && pilot.sender_account_id === account?.sender_account_id && pilot.creator_uid === creator?.creator_uid
      && Array.isArray(pilot.actions) && pilot.actions.includes(action)
      && (action !== 'message' || pilot.message_enabled === true);
  }
  async function executeBusiness(request) {
    if (!admitted(request)) return { verified: false, error_code: 'pilot_required' };
    const { account, creator, action } = request;
    const sender = config.sender;
    if (!sender || sender.channel !== 'android' || account?.channel !== 'android'
      || sender.owner_user_id !== account.owner_user_id || sender.sender_account_id !== account.sender_account_id
      || sender.device_ref !== account.device_ref) return { verified: false, error_code: 'sender_unconfigured' };
    const device = deviceFor(account.device_ref);
    if (!device) return { verified: false, error_code: 'device_unconfigured' };
    const slot = await acquireResourceSlot({ root: runtimeRoot, kind: 'android', maximum: 1 });
    if (!slot.ok) return { verified: false, error_code: slot.error_code };
    let hold = false;
    try {
      const result = await runtime.run(device, (driver) => executeAndroidAction({
        driver, account, creator, action, payload: request.payload,
        locators: sender.locators, appPackage: device.app_package, signal: request.signal,
      }));
      if (result.error_code === 'cleanup_unknown') { await slot.markCleanupRequired(); hold = true; }
      return result;
    } finally { if (!hold) await slot.release(); }
  }
  async function execute(request) {
    if (closed) return { verified: false, error_code: 'operator_closed' };
    const operation = request.operation ?? 'business';
    if (operation === 'business') return executeBusiness(request);
    const device = deviceFor(request.device_ref);
    if (!device) return { ok: false, error_code: 'device_unconfigured' };
    if (operation === 'doctor') return runtime.doctor(device);
    if (operation === 'control') return runtime.control(device, request.commands);
    if (operation === 'takeover') return runtime.takeover(device);
    if (operation === 'resume') return runtime.resume(device);
    return { ok: false, error_code: 'unsupported_operation' };
  }
  async function close() { closed = true; }
  return { execute, close };
}
