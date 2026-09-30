import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../src/process.mjs';

const FORK_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('the local nginx entry only accepts loopback connections', async () => {
  const config = await readFile(new URL('../../../docker/nginx/nginx.local.conf', import.meta.url), 'utf8');
  const addresses = [...config.matchAll(/^\s*listen\s+([^\s;]+)[^\n;]*;/gmu)].map((match) => match[1]);
  assert.deepEqual(addresses.sort(), ['127.0.0.1:2026', '[::1]:2026']);
});

test('the launcher passes a loopback host to the local Gateway', async () => {
  const source = await readFile(new URL('../../../scripts/serve.sh', import.meta.url), 'utf8');
  const calls = source.slice(source.indexOf('# 1. Gateway API'), source.indexOf('# ── Ready'));
  const result = await runCommand('bash', ['-c', `run_service() { printf '%s\\n' \"$1:$2\"; }\n${calls}`], { cwd: FORK_ROOT });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.split('\n').find((line) => line.startsWith('Gateway:')), /--host 127\.0\.0\.1(?:\s|$)/u);
});

for (const [dev, skipBuild] of [[true, false], [false, false], [false, true]]) {
  test(`the local frontend receives a loopback hostname (dev=${dev}, skipBuild=${skipBuild})`, async () => {
    const source = await readFile(new URL('../../../scripts/serve.sh', import.meta.url), 'utf8');
    const selection = source.slice(source.indexOf('# Frontend command'), source.indexOf('# Runtime path defaults.'));
    const result = await runCommand('bash', ['-c', `${selection}\nprintf '%s' \"$FRONTEND_CMD\"`], {
      cwd: FORK_ROOT,
      env: { ...process.env, DEV_MODE: String(dev), SKIP_FRONTEND_BUILD: String(skipBuild), DEERFLOW_PNPM_PYTHON: 'true' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /--hostname 127\.0\.0\.1(?:\s|$)/u);
  });
}
