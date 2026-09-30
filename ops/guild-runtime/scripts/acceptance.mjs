#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCommand } from '../src/process.mjs';
import { GUILD_EXTENSIONS_CONFIG } from '../src/constants.mjs';
import {
  formatDoctorReport,
  inspectDatabaseRevision,
  inspectApprovedCatalogs,
  runDoctor,
} from './doctor.mjs';
import { inspectDeploymentContract, probeRuntimeHealth } from './deployment.mjs';
import { inspectPublicOutreachCatalog } from '../src/mcp-catalog.mjs';

export async function runAcceptance({
  packageRoot,
  doctor = (options) => runDoctor(options),
  runTests = runCommand,
  live = false,
  deployment,
  probeHealth = probeRuntimeHealth,
} = {}) {
  const root = path.resolve(packageRoot);
  const opsRoot = path.join(root, 'ops', 'guild-runtime');
  const mission = await readFile(path.join(opsRoot, 'config', 'guild-soul.md'), 'utf8');
  assert.ok(mission.trim().length > 0, 'guild mission is empty');
  const runtimeMission = await readFile(path.join(root, 'backend', '.deer-flow', 'SOUL.md'), 'utf8');
  assert.ok(runtimeMission.trim().length > 0, 'runtime guild mission is empty');
  assert.equal(existsSync(path.join(root, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
  const extensions = JSON.parse(await readFile(path.join(opsRoot, 'config', GUILD_EXTENSIONS_CONFIG), 'utf8'));
  assert.deepEqual(Object.keys(extensions.mcpServers), [
    'guild_operator',
    'broker_operator',
    'tkdesk',
    'public_outreach_operator',
  ]);

  const testResult = await runTests(process.execPath, ['--test'], { cwd: opsRoot });
  if (testResult.code !== 0) throw new Error(`Package tests failed: ${testResult.stderr || testResult.stdout}`);

  const operatorRoot = path.resolve(extensions.mcpServers.public_outreach_operator.cwd);
  const operatorTests = await runTests('npm', ['test'], { cwd: operatorRoot });
  if (operatorTests.code !== 0) {
    throw new Error(`Public outreach operator tests failed: ${operatorTests.stderr || operatorTests.stdout}`);
  }

  const deploymentReport = await (deployment ?? ((options) => inspectDeploymentContract(options)))({
    packageRoot: root,
    environment: {
      ...process.env,
      // Static acceptance exercises the production auth decision even when the
      // caller has not started a service. An explicit production bypass still
      // fails the contract.
      DEER_FLOW_ENV: process.env.DEER_FLOW_ENV ?? 'production',
      DEER_FLOW_AUTH_DISABLED: process.env.DEER_FLOW_AUTH_DISABLED ?? '0',
    },
    inspectMigration: () => inspectDatabaseRevision({
      databasePath: path.join(root, 'backend', '.deer-flow', 'data', 'deerflow.db'),
    }),
  });
  if (!deploymentReport.ok) {
    const failed = deploymentReport.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Deployment contract failed: ${failed}.\n${deploymentReport.checks.map(({ name, detail }) => `${name}: ${detail}`).join('\n')}`);
  }
  const health = live ? await probeHealth() : { ok: true, status: 'static-routes-verified' };

  const fakeAdapterCalls = [];
  const { createPublicOutreachRouter } = await import(
    pathToFileURL(path.join(operatorRoot, 'src', 'router.mjs')),
  );
  const fakeAdapter = {
    listSenderAccounts: async () => {
      fakeAdapterCalls.push('listSenderAccounts');
      return [];
    },
    enqueueAction: async (params) => {
      assert.equal(params.channel, 'android', 'acceptance must exercise the active Android channel');
      fakeAdapterCalls.push('enqueueAction');
      return {
        task_id: params.task_id ?? 'acceptance-task',
        sender_account_id: params.sender_account_id ?? 'acceptance-account',
        channel: params.channel,
        creator_uid: params.creator_uid ?? 'acceptance-creator',
        action: params.action ?? 'like',
        idempotency_key: params.idempotency_key ?? 'acceptance-idempotency',
      };
    },
  };
  const fakeRouter = createPublicOutreachRouter({ adapter: fakeAdapter });
  const fakeList = await fakeRouter({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'public_outreach_accounts', arguments: { child: 'list' } },
  });
  assert.equal(fakeList.result.structuredContent.status, 'ok');
  const fakeEnqueue = await fakeRouter({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'public_outreach_tasks',
      arguments: {
        child: 'enqueue',
        params: {
          task_id: 'acceptance-task',
          sender_account_id: 'acceptance-account',
          channel: 'android',
          creator_uid: 'acceptance-creator',
          action: 'like',
          idempotency_key: 'acceptance-idempotency',
        },
      },
    },
  });
  assert.equal(fakeEnqueue.result.structuredContent.status, 'ok');
  assert.deepEqual(fakeAdapterCalls, ['listSenderAccounts', 'enqueueAction']);

  const doctorReport = await doctor({ packageRoot: root, live });
  if (!doctorReport.ok) {
    const failed = doctorReport.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}.\n${formatDoctorReport(doctorReport)}`);
  }

  await inspectApprovedCatalogs({ opsRoot });
  const guild = JSON.parse(await readFile(path.join(opsRoot, 'fixtures', 'mcp', 'guild-tools.json'), 'utf8'));
  const broker = JSON.parse(await readFile(path.join(opsRoot, 'fixtures', 'mcp', 'broker-tools.json'), 'utf8'));
  const tkdesk = JSON.parse(await readFile(path.join(opsRoot, 'fixtures', 'mcp', 'tkdesk-tools.json'), 'utf8'));
  const publicOutreach = await inspectPublicOutreachCatalog({
    server: extensions.mcpServers.public_outreach_operator,
    environment: process.env,
  });

  return {
    ok: true,
    mcpServers: 4,
    guildTools: guild.tools.length,
    brokerTools: broker.tools.length,
    tkdeskTools: tkdesk.tools.length,
    publicOutreachTools: publicOutreach.approvedToolCount,
    publicOutreachCatalog: publicOutreach.toolCount,
    publicOutreachFakeAdapter: 'verified-no-provider-writes',
    catalogEvidence: 'static-approved-snapshots',
    nativeGuildLead: true,
    deploymentContract: deploymentReport.checks.map(({ name }) => name),
    health: health.status ?? 'live',
    ...(live ? { runtimeEvidence: doctorReport.checks.filter(({ evidence }) => evidence && evidence !== 'static'),
      gatewayLoadedCatalog: doctorReport.gatewayLoadedCatalog ?? { status: 'unverified' } } : {}),
  };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !['--static', '--live'].includes(flag)) || (flags.includes('--static') && flags.includes('--live'))) {
    console.error('Usage: acceptance.mjs [--static|--live]');
    process.exit(1);
  }
  runAcceptance({ packageRoot, live: flags.includes('--live') })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
