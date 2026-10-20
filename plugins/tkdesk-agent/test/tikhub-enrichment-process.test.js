import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const databaseModule = pathToFileURL(path.join(pluginRoot, 'mcp/core/database.js')).href;
const researchModule = pathToFileURL(path.join(pluginRoot, 'mcp/core/tikhub-enrichment.js')).href;
const { createDatabase } = await import(databaseModule);
const { createTikHubEnrichment } = await import(researchModule);

async function fixture(dailyRequestLimit, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tkdesk-independent-review-'));
  let store;
  try {
    await mkdir(path.join(directory, 'providers'), { mode: 0o700 });
    await writeFile(path.join(directory, 'providers', 'tikhub.json'), JSON.stringify({
      apiKey: 'SYNTHETIC_OFFLINE_FIXTURE_CREDENTIAL',
      research: { enabled: true, dailyRequestLimit }
    }), { mode: 0o600 });
    store = createDatabase(path.join(directory, 'store.sqlite3'));
    for (let i = 0; i < 4; i++) store.upsertProspect({
      candidateId: 'fixture-' + i, source: 'tiktok_live', handle: 'fixture.creator' + i,
      userId: '691423792388584345' + i, invitationEligibility: 'available'
    });
    const before = store.getProspect('fixture-0');
    createTikHubEnrichment({ store, dataDirectory: directory, fetchImpl: async () => { throw Error('fixture setup cannot fetch'); } });
    store.close(); store = null;
    return await run(directory, before);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const childCode = [
  "import { writeFileSync, existsSync } from 'node:fs';",
  'import { createDatabase } from ' + JSON.stringify(databaseModule) + ';',
  'import { createTikHubEnrichment } from ' + JSON.stringify(researchModule) + ';',
  "const directory = process.env.REVIEW_TEMP_DIR;",
  "const i = Number(process.env.REVIEW_INDEX);",
  "const scenario = process.env.REVIEW_SCENARIO;",
  "const candidateIndex = scenario === 'same_candidate_payload' || scenario === 'crash' ? 0 : i;",
  "const store = createDatabase(directory + '/store.sqlite3');",
  // With the old version, both SELECT snapshots were outside the transaction.
  // This bounded barrier forced both to see no operation before either claim.
  // With the fix, BEGIN IMMEDIATE serializes those snapshots; one barrier times
  // out after 600ms, then the second process observes the committed operation.
  "if (scenario === 'different_candidates' || scenario === 'same_candidate_payload') {",
  " const db = store.database;",
  " store.database = new Proxy(db, { get(target, prop) {",
  "  if (prop === 'prepare') return sql => {",
  "   const statement = target.prepare(sql);",
  "   if (sql === 'SELECT * FROM tikhub_research_operations WHERE request_id = ?') return { get(...args) {",
  "    const row = statement.get(...args);",
  "    writeFileSync(directory + '/barrier-' + i, 'ready');",
  "    const start = Date.now();",
  "    while (!existsSync(directory + '/barrier-' + (1-i)) && Date.now() - start < 600)",
  "     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
  "    return row;",
  "   } };",
  "   return statement;",
  "  };",
  "  const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;",
  " } });",
  "}",
  "let calls = 0;",
  "const user = { unique_id: 'fixture.creator' + candidateIndex, uid: '691423792388584345' + candidateIndex, sec_uid: 'MS4wLjAB_OFFLINE_PUBLIC_FIXTURE' };",
  "const api = createTikHubEnrichment({ store, dataDirectory: directory, fetchImpl: async url => {",
  " calls++; if (scenario === 'crash') process.exit(0);",
  " await new Promise(resolve => setTimeout(resolve, 30));",
  " return Response.json(String(url).includes('handler_user_profile') ? { code: 200, data: { user } }",
  "  : { code: 200, data: { aweme_list: [{ aweme_id: '7689848338484579093', author: user, desc: 'offline fixture' }] } });",
  "} });",
  "try {",
  " const result = await api.research({ candidateId: 'fixture-' + candidateIndex,",
  "  includePosts: scenario === 'same_candidate_payload' && i === 1, allowPaid: true,",
  "  requestId: scenario === 'budget' ? 'budget-' + i : scenario === 'crash' ? 'crashed-operation' : 'same-request' });",
  " console.log(JSON.stringify({ i, calls, state: result.state, reason: result.reason ?? null }));",
  "} catch (error) { console.log(JSON.stringify({ i, calls, threw: true, code: error.code, message: error.message })); }",
  "finally { store.close(); }"
].join('\n');

function child(directory, i, scenario) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      env: { ...process.env, REVIEW_TEMP_DIR: directory, REVIEW_INDEX: String(i), REVIEW_SCENARIO: scenario },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { processHandle.kill('SIGKILL'); reject(Error('offline child timed out')); }, 8000);
    processHandle.stdout.on('data', value => { stdout += value; });
    processHandle.stderr.on('data', value => { stderr += value; });
    processHandle.on('error', error => { clearTimeout(timeout); reject(error); });
    processHandle.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(Error(stderr || 'child exit ' + code));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch (error) { reject(error); }
    });
  });
}

test('durable paid daily budget is shared across four independent processes', async () => {
  await fixture(1, async directory => {
    const children = await Promise.all([0, 1, 2, 3].map(i => child(directory, i, 'budget')));
    assert.equal(children.reduce((n, value) => n + value.calls, 0), 1);
    assert.equal(children.filter(value => value.reason === 'daily_budget_exhausted').length, 3);
  });
});

for (const scenario of ['different_candidates', 'same_candidate_payload']) {
  test('request id conflicts stay classified across processes: ' + scenario, async () => {
    await fixture(10, async directory => {
      const children = await Promise.all([0, 1].map(i => child(directory, i, scenario)));
      assert.equal(children.filter(value => value.threw).length, 0);
      assert.equal(children.filter(value => value.reason === 'request_id_conflict').length, 1);
      assert.equal(children.filter(value => value.state === 'ready').length, 1);
      const calls = children.reduce((n, value) => n + value.calls, 0);
      assert.ok(calls >= 1 && calls <= (scenario === 'different_candidates' ? 1 : 2));
    });
  });
}

test('crash after paid reservation never replays or changes official qualification', async () => {
  await fixture(10, async (directory, before) => {
    assert.equal(await child(directory, 0, 'crash'), null);
    const store = createDatabase(path.join(directory, 'store.sqlite3'));
    try {
      let calls = 0;
      const api = createTikHubEnrichment({ store, dataDirectory: directory, fetchImpl: async () => { calls++; throw Error('crash must not retry'); } });
      const same = await api.research({ candidateId: 'fixture-0', allowPaid: true, requestId: 'crashed-operation' });
      const fresh = await api.research({ candidateId: 'fixture-0', allowPaid: true, requestId: 'fresh-operation' });
      assert.equal(same.reason, 'paid_attempt_unresolved');
      assert.equal(fresh.reason, 'paid_attempt_unresolved');
      assert.equal(calls, 0);
      assert.equal((await api.status()).budget.attemptedToday, 1);
      assert.deepEqual(store.getProspect('fixture-0'), before);
    } finally { store.close(); }
  });
});
