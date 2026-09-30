import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectDeploymentContract,
  probeRuntimeHealth,
} from '../scripts/deployment.mjs';

const ROOT = '/tmp/guild';

function files(overrides = {}) {
  return {
    nginx: 'listen 127.0.0.1:2026;\nlisten [::1]:2026;\n',
    compose: '"${BIND_HOST:-127.0.0.1}:${PORT:-2026}:2026"\n',
    health: '@app.get("/health")\n@app.get("/health/ready")',
    serve: 'run_service "Gateway" run_service "Frontend" run_service "Nginx" ops/guild-runtime/scripts/log-service.mjs DEER_FLOW_LOG_MAX_BYTES DEER_FLOW_LOG_BACKUPS',
    ...overrides,
  };
}

test('deployment contract accepts production auth, loopback publishing, migrations and bounded logs', async () => {
  const report = await inspectDeploymentContract({
    packageRoot: ROOT,
    environment: { DEER_FLOW_ENV: 'production', DEER_FLOW_AUTH_DISABLED: '0' },
    readSource: async (name) => files()[name],
    inspectMigration: async () => ({ detail: 'database at 0032_android_outreach_sender' }),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(({ name }) => name), [
    'production_auth', 'published_bind', 'migration', 'health_routes', 'bounded_logs',
  ]);
});

test('deployment acceptance rejects production auth bypass and public default bind', async () => {
  const report = await inspectDeploymentContract({
    packageRoot: ROOT,
    environment: { DEER_FLOW_ENV: 'production', DEER_FLOW_AUTH_DISABLED: '1' },
    readSource: async (name) => files({ compose: '"${PORT}:2026"', nginx: 'listen 0.0.0.0:2026;' })[name],
    inspectMigration: async () => ({ detail: 'database at 0032_android_outreach_sender' }),
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(({ name }) => name === 'production_auth').detail, /disabled/iu);
  assert.match(report.checks.find(({ name }) => name === 'published_bind').detail, /loopback|public/iu);
});

test('deployment acceptance does not treat static checks as a live health probe', async () => {
  await assert.rejects(
    probeRuntimeHealth({ gatewayUrl: 'http://127.0.0.1:9', fetch: async () => ({ ok: false, status: 503 }) }),
    /health|503/u,
  );
});

test('runtime health requires both liveness and readiness endpoints', async () => {
  const requests = [];
  const result = await probeRuntimeHealth({
    gatewayUrl: 'http://127.0.0.1:2026',
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true, status: 200, json: async () => ({ status: String(url).endsWith('/ready') ? 'ready' : 'healthy' }) };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, ['http://127.0.0.1:2026/health', 'http://127.0.0.1:2026/health/ready']);
});
