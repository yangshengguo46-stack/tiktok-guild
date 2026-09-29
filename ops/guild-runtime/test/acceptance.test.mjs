import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { runAcceptance } from '../scripts/acceptance.mjs';

const OPS_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FORK_ROOT = path.resolve(OPS_ROOT, '../..');

async function offlinePackage(t, runtimeSoul) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deerflow-native-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opsRoot = path.join(root, 'ops', 'guild-runtime');
  await cp(path.join(OPS_ROOT, 'config'), path.join(opsRoot, 'config'), { recursive: true });
  await cp(path.join(OPS_ROOT, 'fixtures', 'mcp'), path.join(opsRoot, 'fixtures', 'mcp'), { recursive: true });
  if (runtimeSoul !== undefined) {
    const target = path.join(root, 'backend', '.deer-flow', 'SOUL.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, runtimeSoul);
  }
  return root;
}

async function runOfflineAcceptance(packageRoot) {
  return runAcceptance({
    packageRoot,
    doctor: async () => ({ ok: true, checks: [{ name: 'fixture', ok: true, detail: 'ok' }] }),
    runTests: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
}

test('the package leaves the active skills path to the start environment', async () => {
  const config = YAML.parse(await readFile(path.join(OPS_ROOT, 'config', 'config.yaml'), 'utf8'));
  assert.equal(Object.hasOwn(config.skills, 'path'), false);
});

test('the native runtime has one Lead, four direct MCPs, and no layered runtime', async () => {
  const extensions = JSON.parse(await readFile(path.join(OPS_ROOT, 'config', 'extensions_config.guild.json'), 'utf8'));
  const configText = await readFile(path.join(OPS_ROOT, 'config', 'config.yaml'), 'utf8');
  const manifestText = await readFile(path.join(OPS_ROOT, 'config', 'local-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const readme = await readFile(path.join(OPS_ROOT, 'README.md'), 'utf8');

  assert.equal(existsSync(path.join(FORK_ROOT, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
  assert.equal(extensions.skills?.['guild-recruitment-lead']?.enabled, undefined);
  assert.doesNotMatch(configText, /\/mnt\/guild-cases/u);
  assert.equal('cases_path' in manifest, false);
  assert.equal('product_patches' in manifest, false);
  assert.equal('runtime_root' in manifest, false);
  assert.deepEqual(Object.keys(extensions.mcpServers), [
    'guild_operator',
    'broker_operator',
    'tkdesk',
    'public_outreach_operator',
  ]);
  assert.deepEqual(extensions.mcpServers.guild_operator.enabled_tools, [
    'guild_workspace',
    'guild_creators',
    'guild_recruitment',
    'guild_messaging',
    'guild_operations',
    'guild_revenue',
    'guild_governance',
    'guild_intelligence',
    'guild_onboarding',
  ]);
  assert.deepEqual(extensions.mcpServers.broker_operator.enabled_tools, [
    'broker_workspace',
    'broker_messaging',
  ]);
  assert.deepEqual(extensions.mcpServers.public_outreach_operator.enabled_tools, [
    'public_outreach_accounts',
    'public_outreach_tasks',
  ]);
  const tkdeskCatalog = JSON.parse(await readFile(path.join(OPS_ROOT, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  assert.deepEqual(extensions.mcpServers.tkdesk.enabled_tools, tkdeskCatalog.tools.map(({ name }) => name));
  assert.equal(extensions.mcpServers.tkdesk.enabled_tools.includes('reopen_login'), true);
  assert.equal(extensions.mcpServers.tkdesk.enabled_tools.includes('initialize_collection_backstage'), true);
  assert.equal(extensions.mcpServers.tkdesk.enabled_tools.includes('prepare_discovery_live'), true);
  assert.deepEqual(extensions.mcpServers.tkdesk.enabled_tools.slice(-3), [
    'prepare_handoff',
    'commit_handoff',
    'audit_events',
  ]);
  assert.doesNotMatch(`${configText}\n${manifestText}`, /worker|rust|ledger/iu);
  assert.doesNotMatch(readme, /docker(?:\s|[-_])/iu);
});

test('catalog snapshots preserve handoff and forbid outreach tools', async () => {
  const guild = JSON.parse(await readFile(path.join(OPS_ROOT, 'fixtures', 'mcp', 'guild-tools.json'), 'utf8'));
  const broker = JSON.parse(await readFile(path.join(OPS_ROOT, 'fixtures', 'mcp', 'broker-tools.json'), 'utf8'));
  const tkdesk = JSON.parse(await readFile(path.join(OPS_ROOT, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));

  assert.equal(guild.tools.length, 9);
  assert.equal(broker.tools.length, 2);
  assert.equal(tkdesk.tools.some(({ name }) => name === 'prepare_handoff'), true);
  assert.equal(tkdesk.tools.some(({ name }) => name === 'commit_handoff'), true);
  assert.equal(tkdesk.tools.some(({ name }) => name === 'reopen_login'), true);
  assert.deepEqual(
    tkdesk.tools.filter(({ name }) => /send_message|send_invitation|follow|comment|gift|publish/iu.test(name)),
    [],
  );
  for (const item of [...guild.tools, ...broker.tools, ...tkdesk.tools]) {
    assert.match(item.input_schema_sha256, /^[0-9a-f]{64}$/u);
  }
});

test('offline acceptance rejects a missing installed Lead mission', async (t) => {
  const root = await offlinePackage(t);
  await assert.rejects(runOfflineAcceptance(root), /SOUL\.md/u);
});

test('offline acceptance rejects a blank installed Lead mission', async (t) => {
  const root = await offlinePackage(t, ' \n\t ');
  await assert.rejects(runOfflineAcceptance(root), /runtime guild mission is empty/u);
});

test('offline acceptance composes config, doctor, and catalog evidence with a customized mission', async (t) => {
  const customMission = 'Use my customized guild Lead mission.\n';
  const root = await offlinePackage(t, customMission);
  const broker = JSON.parse(await readFile(path.join(root, 'ops', 'guild-runtime', 'fixtures', 'mcp', 'broker-tools.json'), 'utf8'));
  const tkdesk = JSON.parse(await readFile(path.join(root, 'ops', 'guild-runtime', 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  const report = await runOfflineAcceptance(root);

  assert.deepEqual(report, {
    ok: true,
    mcpServers: 4,
    guildTools: 9,
    brokerTools: broker.tools.length,
    tkdeskTools: tkdesk.tools.length,
    publicOutreachTools: 2,
    publicOutreachCatalog: 2,
    publicOutreachFakeAdapter: 'verified-no-provider-writes',
    catalogEvidence: 'static-approved-snapshots',
    nativeGuildLead: true,
  });
  assert.equal(await readFile(path.join(root, 'backend', '.deer-flow', 'SOUL.md'), 'utf8'), customMission);
});

test('live acceptance requests runtime checks and preserves an unavailable catalog reason', async (t) => {
  const root = await offlinePackage(t, 'fixture mission');
  await assert.rejects(runAcceptance({ packageRoot: root, live: true,
    runTests: async () => ({ code: 0, stdout: '', stderr: '' }),
    doctor: async ({ live }) => ({ ok: live !== true,
      checks: [{ name: 'gateway_mcp_config', ok: false, evidence: 'gateway-config', detail: 'unavailable: HTTP 503' }] }),
  }), /gateway_mcp_config.*unavailable.*503/u);
});

test('standalone operations point to the unique CreatorAgent design', async () => {
  const readme = await readFile(path.join(OPS_ROOT, 'README.md'), 'utf8');
  const design = await readFile(path.join(FORK_ROOT, 'docs', 'superpowers', 'specs', '2026-09-24-deerflow-auto-persona-design.md'), 'utf8');
  assert.match(readme, /CreatorAgent_FINAL_PERSONA_REV1_20260924\.zip/u);
  assert.match(readme, /AI 自动切换/u);
  assert.match(design, /本轮唯一产品规格/u);
});
