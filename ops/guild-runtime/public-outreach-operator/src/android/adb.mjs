import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runAdb(args, { adb = 'adb', timeout = 5000 } = {}) {
  return execFileAsync(adb, args, { timeout, maxBuffer: 64 * 1024 });
}

export async function checkAndroidDevice(udid, runner = runAdb) {
  if (typeof udid !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(udid)) {
    return { ok: false, error_code: 'invalid_device_serial' };
  }
  try {
    const { stdout } = await runner(['devices', '-l']);
    const row = String(stdout).split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).find(([serial]) => serial === udid);
    if (!row || row[1] !== 'device') {
      return { ok: false, error_code: row?.[1] === 'unauthorized' ? 'usb_authorization_required' : 'device_offline' };
    }
    return { ok: true, udid };
  } catch {
    return { ok: false, error_code: 'adb_unavailable' };
  }
}
