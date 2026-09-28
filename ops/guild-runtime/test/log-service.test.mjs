import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../src/process.mjs';

const LOGGER = fileURLToPath(new URL('../scripts/log-service.mjs', import.meta.url));

async function temporaryLog(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guild-log-rotation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'gateway.log');
}

function logChild(logfile, source, extra = []) {
  return runCommand(process.execPath, [LOGGER, '--log', logfile, '--max-bytes', '8', '--backups', '2',
    '--', process.execPath, '-e', source, ...extra], { timeoutMs: 5000 });
}

test('service logs rotate during one continuous process and keep bounded files', async (t) => {
  const logfile = await temporaryLog(t);
  const result = await logChild(logfile, "process.stdout.write('abcdefghijklmnopqrstuvwxyz012345');");
  assert.equal(result.code, 0, result.stderr);
  const names = (await readdir(path.dirname(logfile))).sort();
  assert.deepEqual(names, ['gateway.log', 'gateway.log.1', 'gateway.log.2']);
  for (const name of names) assert.ok((await stat(path.join(path.dirname(logfile), name))).size <= 8);
  const retained = await Promise.all(['.2', '.1', ''].map((suffix) => readFile(`${logfile}${suffix}`, 'utf8')));
  assert.equal(retained.join(''), 'ijklmnopqrstuvwxyz012345');
});

test('service logs preserve recent output across restart and return the child exit code', async (t) => {
  const logfile = await temporaryLog(t);
  await writeFile(logfile, 'previous');
  const result = await logChild(logfile, "process.stderr.write('failed'); process.exitCode=17;");
  assert.equal(result.code, 17, result.stderr);
  assert.equal(await readFile(`${logfile}.1`, 'utf8'), 'previous');
  assert.equal(await readFile(logfile, 'utf8'), 'failed');
});

test('log rotation bounds oversized files from earlier launches and prunes excess backups', async (t) => {
  const logfile = await temporaryLog(t);
  await writeFile(logfile, 'old-output-is-too-big');
  await writeFile(`${logfile}.1`, 'older-output-is-too-big');
  await writeFile(`${logfile}.9`, 'expired backup');
  const result = await logChild(logfile, "process.stdout.write('new');");
  assert.equal(result.code, 0, result.stderr);
  const files = await readdir(path.dirname(logfile));
  assert.ok(!files.includes('gateway.log.9'));
  for (const file of files) assert.ok((await stat(path.join(path.dirname(logfile), file))).size <= 8);
  assert.equal(await readFile(`${logfile}.1`, 'utf8'), '-too-big');
  assert.equal(await readFile(logfile, 'utf8'), 'new');
});
