import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { runAcceptance } from '../scripts/acceptance.mjs';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function offlinePackage(t, runtimeSoul) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deerflow-native-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(PACKAGE_ROOT, 'config'), path.join(root, 'config'), { recursive: true });
  await cp(path.join(PACKAGE_ROOT, 'fixtures', 'mcp'), path.join(root, 'fixtures', 'mcp'), { recursive: true });
  if (runtimeSoul !== undefined) {
    const target = path.join(root, '.runtime', 'deerflow-home', 'SOUL.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, runtimeSoul);
  }
  return root;
}

async function runOfflineAcceptance(packageRoot) {
  const guild = JSON.parse(await readFile(path.join(packageRoot, 'fixtures', 'mcp', 'guild-tools.json'), 'utf8'));
  const tkdesk = JSON.parse(await readFile(path.join(packageRoot, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  return runAcceptance({
    packageRoot,
    doctor: async () => ({ ok: true, checks: [{ name: 'fixture', ok: true, detail: 'ok' }] }),
    probeCatalogs: async () => ({ guild, tkdesk }),
    runTests: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
}

test('the package leaves the active skills path to the start environment', async () => {
  const config = YAML.parse(await readFile(path.join(PACKAGE_ROOT, 'config', 'config.yaml'), 'utf8'));
  assert.equal(Object.hasOwn(config.skills, 'path'), false);
});

test('the native runtime has one Lead, two direct MCPs, and no layered runtime', async () => {
  const extensions = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'config', 'extensions_config.json'), 'utf8'));
  const configText = await readFile(path.join(PACKAGE_ROOT, 'config', 'config.yaml'), 'utf8');
  const manifestText = await readFile(path.join(PACKAGE_ROOT, 'config', 'local-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const readme = await readFile(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');

  assert.equal(existsSync(path.join(PACKAGE_ROOT, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
  assert.equal(extensions.skills?.['guild-recruitment-lead']?.enabled, undefined);
  assert.doesNotMatch(configText, /\/mnt\/guild-cases/u);
  assert.equal('cases_path' in manifest, false);
  assert.deepEqual(Object.keys(extensions.mcpServers), ['guild_operator', 'tkdesk']);
  assert.deepEqual(extensions.mcpServers.guild_operator.enabled_tools, [
    'guild_workspace',
    'guild_creators',
    'guild_recruitment',
    'guild_messaging',
    'guild_operations',
    'guild_revenue',
    'guild_governance',
    'guild_intelligence',
  ]);
  assert.deepEqual(extensions.mcpServers.tkdesk, {
    enabled: true,
    required: true,
    type: 'stdio',
    command: '/Users/yangyucheng/plugins/tkdesk-agent/scripts/launch_mcp',
    args: [],
    cwd: '/Users/yangyucheng/plugins/tkdesk-agent',
    tool_name_prefix: false,
  });
  assert.doesNotMatch(`${configText}\n${manifestText}`, /worker|rust|ledger/iu);
  assert.doesNotMatch(readme, /docker(?:\s|[-_])/iu);
});

test('catalog snapshots preserve handoff and forbid outreach tools', async () => {
  const guild = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'fixtures', 'mcp', 'guild-tools.json'), 'utf8'));
  const tkdesk = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));

  assert.equal(guild.tools.length, 8);
  assert.equal(tkdesk.tools.some(({ name }) => name === 'prepare_handoff'), true);
  assert.equal(tkdesk.tools.some(({ name }) => name === 'commit_handoff'), true);
  assert.deepEqual(
    tkdesk.tools.filter(({ name }) => /send_message|send_invitation|follow|comment|gift|publish/iu.test(name)),
    [],
  );
  for (const item of [...guild.tools, ...tkdesk.tools]) {
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
  const tkdesk = JSON.parse(await readFile(path.join(root, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  const report = await runOfflineAcceptance(root);

  assert.deepEqual(report, {
    ok: true,
    mcpServers: 2,
    guildTools: 8,
    tkdeskTools: tkdesk.tools.length,
    nativeGuildLead: true,
  });
  assert.equal(await readFile(path.join(root, '.runtime', 'deerflow-home', 'SOUL.md'), 'utf8'), customMission);
});

test('standalone project points to the unique CreatorAgent design and current audit', async () => {
  const readme = await readFile(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
  const design = await readFile(path.join(PACKAGE_ROOT, 'docs', 'superpowers', 'specs', '2026-09-24-deerflow-auto-persona-design.md'), 'utf8');
  const audit = await readFile(path.join(PACKAGE_ROOT, 'docs', 'audits', '2026-09-23-deerflow-guild-migration-audit.md'), 'utf8');
  assert.match(readme, /CreatorAgent_FINAL_PERSONA_REV1_20260924\.zip/u);
  assert.match(readme, /AI 自动切换/u);
  assert.match(design, /本轮唯一产品规格/u);
  assert.match(audit, /唯一生效规格/u);
});
