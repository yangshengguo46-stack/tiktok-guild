import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureGuildSoul } from '../src/guild-soul.mjs';

const LEGACY_BUSINESS_FIRST_SOUL = `# TikTok LIVE Guild Lead

Help the operator recruit and support suitable creators and improve the guild's durable LIVE results. Work across recruitment, creator development, activities, revenue and governance. Choose your own investigation, communication and follow-up strategy for the situation.

Use TKDesk for candidate identity and handoff facts. Use the Guild Operator MCP for current LIVE Backstage facts; obtain the current guild reference before guild-scoped reads. Keep source, time, units, visible scope and completeness when explaining a result. A prior case or memory is context, not proof of today's policy, quota or platform state.

Use DeerFlow's normal planning, tools, memory and delegation as needed. A draft is not a sent message. Respect an explicit request not to be contacted. Ask the operator for a missing fact or unavailable platform action when necessary; otherwise decide the next business step yourself.
`;

async function soulFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'guild-soul-'));
  await mkdir(path.join(fixtureRoot, 'config'));
  await writeFile(path.join(fixtureRoot, 'config', 'guild-soul.md'), 'new social kernel\n');
  return fixtureRoot;
}

test('installs the packaged social kernel when SOUL is missing', async () => {
  const fixtureRoot = await soulFixture();
  try {
    const result = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(result, {
      installed: true,
      migrated: false,
      path: path.join(fixtureRoot, '.runtime', 'deerflow-home', 'SOUL.md'),
    });
    assert.equal(await readFile(result.path, 'utf8'), 'new social kernel\n');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('migrates the exact previous packaged business-first SOUL', async () => {
  const fixtureRoot = await soulFixture();
  const target = path.join(fixtureRoot, '.runtime', 'deerflow-home', 'SOUL.md');
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, LEGACY_BUSINESS_FIRST_SOUL);
    const result = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(result, { installed: true, migrated: true, path: target });
    assert.equal(await readFile(target, 'utf8'), 'new social kernel\n');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('preserves a genuinely customized default Lead SOUL', async () => {
  const fixtureRoot = await soulFixture();
  const target = path.join(fixtureRoot, '.runtime', 'deerflow-home', 'SOUL.md');
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'operator customization\n');
    const result = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(result, { installed: false, migrated: false, path: target });
    assert.equal(await readFile(target, 'utf8'), 'operator customization\n');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('packaged SOUL uses the social kernel and cannot restore the obsolete business-first opening', async () => {
  const packaged = await readFile(new URL('../config/guild-soul.md', import.meta.url), 'utf8');
  assert.match(packaged, /默认社交内核/u);
  assert.match(packaged, /当前 DeerFlow 普通 Chat 中直接输出最终回复/u);
  assert.doesNotMatch(packaged, /Help the operator recruit and support suitable creators/u);
  assert.doesNotMatch(packaged, /输出 TurnResult/u);
});
