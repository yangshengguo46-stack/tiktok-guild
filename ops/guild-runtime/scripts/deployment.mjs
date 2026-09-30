#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_FILES = Object.freeze({
  nginx: (root) => path.join(root, 'docker', 'nginx', 'nginx.local.conf'),
  compose: (root) => path.join(root, 'docker', 'docker-compose.yaml'),
  health: (root) => path.join(root, 'backend', 'app', 'gateway', 'app.py'),
  serve: (root) => path.join(root, 'scripts', 'serve.sh'),
});

async function defaultReadSource(packageRoot, name) {
  return readFile(SOURCE_FILES[name](packageRoot), 'utf8');
}

function check(name, ok, detail) {
  return { name, ok, evidence: 'static', detail };
}

function productionMarker(environment) {
  return [environment?.DEER_FLOW_ENV, environment?.ENVIRONMENT]
    .some((value) => ['prod', 'production'].includes(String(value ?? '').trim().toLowerCase()));
}

export async function inspectDeploymentContract({
  packageRoot,
  environment = process.env,
  readSource = (name) => defaultReadSource(path.resolve(packageRoot), name),
  inspectMigration = async () => ({ detail: 'migration inspection not supplied' }),
} = {}) {
  const checks = [];
  const production = productionMarker(environment);
  const authDisabled = String(environment?.DEER_FLOW_AUTH_DISABLED ?? (production ? '0' : '1')) === '1';
  checks.push(check(
    'production_auth',
    production && !authDisabled,
    production && !authDisabled
      ? 'production marker is set and authentication bypass is disabled'
      : production ? 'DEER_FLOW_AUTH_DISABLED=1 is forbidden in production' : 'a production marker is required for deployment acceptance',
  ));

  try {
    const nginx = await readSource('nginx');
    const compose = await readSource('compose');
    const localListeners = [...nginx.matchAll(/^\s*listen\s+([^\s;]+)/gmu)].map((match) => match[1]);
    const localOk = localListeners.length > 0
      && localListeners.every((value) => value === '127.0.0.1:2026' || value === '[::1]:2026');
    const published = [...compose.matchAll(/(?:ports:\s*\n)?[^\n]*["']?([^\s"']*2026:2026)["']?/gimu)]
      .map((match) => match[1]);
    const publicBind = published.some((value) => !value.startsWith('${BIND_HOST:-127.0.0.1}:') && !value.startsWith('127.0.0.1:'));
    checks.push(check(
      'published_bind',
      localOk && !publicBind,
      localOk && !publicBind
        ? 'local nginx is loopback-only and published ports have an explicit bind default'
        : `unsafe listener or published bind detected; loopback-only listener required (listeners=${localListeners.join(',') || 'none'}; ports=${published.join(',') || 'none'})`,
    ));
  } catch (error) {
    checks.push(check('published_bind', false, `deployment bind sources unavailable: ${error.message}`));
  }

  try {
    const migration = await inspectMigration();
    checks.push(check('migration', true, migration?.detail ?? 'database migration passed'));
  } catch (error) {
    checks.push(check('migration', false, error.message));
  }

  try {
    const health = await readSource('health');
    const hasLiveness = /@app\.get\(["']\/health["'][^)]*\)/u.test(health);
    const hasReadiness = /@app\.get\(["']\/health\/ready["'][^)]*\)/u.test(health);
    checks.push(check(
      'health_routes',
      hasLiveness && hasReadiness,
      hasLiveness && hasReadiness ? 'liveness and persistence readiness routes are present' : 'both /health and /health/ready routes are required',
    ));
  } catch (error) {
    checks.push(check('health_routes', false, `health source unavailable: ${error.message}`));
  }

  try {
    const serve = await readSource('serve');
    const bounded = /log-service\.mjs/u.test(serve)
      && /run_service\s+"Gateway"/u.test(serve)
      && /run_service\s+"Frontend"/u.test(serve)
      && /run_service\s+"Nginx"/u.test(serve)
      && /DEER_FLOW_LOG_MAX_BYTES/u.test(serve)
      && /DEER_FLOW_LOG_BACKUPS/u.test(serve);
    checks.push(check('bounded_logs', bounded, bounded
      ? 'gateway, frontend and nginx logs use the bounded rotating logger'
      : 'all service logs must use log-service with size and backup limits'));
  } catch (error) {
    checks.push(check('bounded_logs', false, `service launcher unavailable: ${error.message}`));
  }

  return { ok: checks.every(({ ok }) => ok), checks };
}

export async function probeRuntimeHealth({
  gatewayUrl = 'http://127.0.0.1:2026',
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for live health acceptance');
  const base = gatewayUrl.replace(/\/$/u, '');
  const endpoints = ['/health', '/health/ready'];
  const responses = [];
  for (const endpoint of endpoints) {
    let response;
    try {
      response = await fetchImpl(`${base}${endpoint}`, { redirect: 'error' });
    } catch (error) {
      throw new Error(`${endpoint} health probe failed: ${error.message}`);
    }
    if (!response?.ok) throw new Error(`${endpoint} health probe returned HTTP ${response?.status ?? 'unknown'}`);
    let payload = {};
    if (typeof response.json === 'function') payload = await response.json();
    const expected = endpoint === '/health' ? 'healthy' : 'ready';
    if (payload.status !== expected) throw new Error(`${endpoint} health probe returned status ${payload.status ?? 'unknown'}`);
    responses.push({ endpoint, status: payload.status });
  }
  return { ok: true, responses };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !['--static', '--live'].includes(flag)) || (flags.includes('--static') && flags.includes('--live'))) {
    console.error('Usage: deployment.mjs [--static|--live]');
    process.exit(1);
  }
  const live = flags.includes('--live');
  const { inspectDatabaseRevision } = await import('./doctor.mjs');
  inspectDeploymentContract({
    packageRoot,
    environment: {
      ...process.env,
      DEER_FLOW_ENV: process.env.DEER_FLOW_ENV ?? 'production',
      DEER_FLOW_AUTH_DISABLED: process.env.DEER_FLOW_AUTH_DISABLED ?? '0',
    },
    inspectMigration: () => inspectDatabaseRevision({
      databasePath: path.join(packageRoot, 'backend', '.deer-flow', 'data', 'deerflow.db'),
    }),
  }).then(async (report) => {
    if (!report.ok) {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }
    const health = live ? await probeRuntimeHealth() : { ok: true, status: 'static-routes-verified' };
    console.log(JSON.stringify({ ...report, health }, null, 2));
    if (!health.ok) process.exitCode = 1;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
