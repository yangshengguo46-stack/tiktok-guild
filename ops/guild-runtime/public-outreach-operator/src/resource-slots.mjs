import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// Execution resource leases only; no business tasks, claims or receipts live here.
export async function acquireResourceSlot({ root, kind, maximum }) {
  const directory = path.join(root, 'slots', kind);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const identity = { token, pid: process.pid, host: os.hostname(), heartbeat_at: Date.now() };
  for (let index = 0; index < maximum; index += 1) {
    const file = path.join(directory, `${index}.lock`);
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try { current = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
      if (current.host !== os.hostname()) continue;
      try { process.kill(current.pid, 0); continue; } catch (probe) { if (probe.code !== 'ESRCH') continue; }
      if (kind === 'ios') continue; // A remote Appium session may outlive Node.
      // Rename-free stale cleanup is serialized by a separate exclusive guard.
      let guard;
      try { guard = await open(`${file}.reap`, 'wx', 0o600); } catch { continue; }
      try {
        const checked = JSON.parse(await readFile(file, 'utf8'));
        if (checked.token === current.token) await rm(file, { force: true });
      } finally { await guard.close(); await rm(`${file}.reap`, { force: true }); }
      index -= 1;
      continue;
    }
    await handle.writeFile(JSON.stringify(identity)); await handle.close();
    let heartbeatWrite = Promise.resolve();
    let released = false;
    const heartbeat = setInterval(() => {
      heartbeatWrite = heartbeatWrite.then(async () => {
        if (released) return;
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.token === token) await writeFile(file, JSON.stringify({ ...current, heartbeat_at: Date.now() }), { mode: 0o600 });
      }).catch(() => { /* Failed heartbeats never permit lease reclamation. */ });
    }, 1000);
    heartbeat.unref();
    return { ok: true, async release() {
      released = true; clearInterval(heartbeat); await heartbeatWrite;
      let current; try { current = JSON.parse(await readFile(file, 'utf8')); } catch { return; }
      if (current.token === token && current.pid === process.pid) await rm(file, { force: true });
    } };
  }
  return { ok: false, error_code: 'capacity_exhausted' };
}

export async function activeResourceSlots({ root, kind, maximum }) {
  let count = 0;
  for (let index = 0; index < maximum; index += 1) {
    try {
      const lock = JSON.parse(await readFile(path.join(root, 'slots', kind, `${index}.lock`), 'utf8'));
      if (lock.host !== os.hostname()) { count += 1; continue; }
      try { process.kill(lock.pid, 0); count += 1; } catch (error) { if (error.code !== 'ESRCH') count += 1; }
    } catch { /* An absent slot is idle. */ }
  }
  return count;
}
