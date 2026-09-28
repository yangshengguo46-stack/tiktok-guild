import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/process.mjs';

test('local nginx log directives use the launcher streams instead of opening unbounded files', async (t) => {
  try { await runCommand('nginx', ['-v']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('nginx is not installed'); return; } throw error; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'guild-nginx-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'logs'));
  const source = await readFile(fileURLToPath(new URL('../../../docker/nginx/nginx.local.conf', import.meta.url)), 'utf8');
  const directives = [...source.matchAll(/^\s*(?:error_log|access_log)\s+[^;]+;/gmu)].map(([value]) => value.trim());
  const config = path.join(root, 'nginx.conf');
  await writeFile(config, `${directives[0]}\nevents {}\nhttp {\n${directives.slice(1).join('\n')}\n}\n`, 'utf8');
  const result = await runCommand('nginx', ['-t', '-p', `${root}/`, '-c', config]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readdir(path.join(root, 'logs')), []);
  assert.match(result.stderr, /syntax is ok/u);
});
