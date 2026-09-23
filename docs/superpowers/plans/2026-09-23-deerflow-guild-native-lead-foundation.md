# DeerFlow Guild Native Lead Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeerFlow's default Lead carry the TikTok LIVE guild mission and use the existing Guild Operator and TKDesk MCPs without the old fixed recruitment Skill or case workflow.

**Architecture:** Use the default Lead's native `SOUL.md` support for a short guild mission. Keep its normal planner, memory, subagents and tool assembly intact. Remove the old Skill and case path from the active runtime, then update acceptance to prove the two MCP servers are still available. This is the first independently testable slice; trusted external-channel context, live Workbench data and TikTok messaging each need separate plans.

**Tech Stack:** Node.js 22.16+, DeerFlow at `769589e8daee14c2587a634b6b43bd96471a41a1`, Python backend, stdio MCP, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-23-tiktok-guild-deerflow-product-design.md`

## Global Constraints

- Preserve the default DeerFlow Lead, its graph, planning, memory, subagent and tool interfaces.
- The mission names business goals and fact sources; it must not require stages, scores, an invitation threshold, scripted replies or per-action approval.
- Guild Operator remains read-only. This plan does not send a TikTok message, invitation or appeal.
- Keep the `guild_operator` and `tkdesk` MCP servers direct; do not add a Worker, Rust bridge, ledger, projection store, container or custom Agent.
- Preserve any existing `.runtime/cases` and `.runtime/deerflow-home/SOUL.md` user data. Do not stage `.agents/coordination.md` or `outputs/`.
- Do not replace the current cumulative product patch in this slice. Its safe upgrade is part of the later source-change plan.

## File Structure

- `ops/deerflow-native-guild/config/guild-soul.md`: tracked initial mission for the default Lead.
- `ops/deerflow-native-guild/src/guild-soul.mjs`: install that mission only when `DEER_FLOW_HOME/SOUL.md` does not exist.
- `ops/deerflow-native-guild/scripts/bootstrap.mjs`: invoke the installer during bootstrap.
- `ops/deerflow-native-guild/config/extensions_config.json`: stop enabling the legacy recruitment Skill; leave both MCP server entries unchanged.
- `ops/deerflow-native-guild/skills/public/guild-recruitment-lead/`: remove the obsolete Skill from the active discovery path. Git history preserves the material.
- `ops/deerflow-native-guild/config/config.yaml`: remove the obsolete `/mnt/guild-cases` mount. Keep the current file tools and MCP access; later channel-authority work decides which additional host tools can safely be exposed.
- `ops/deerflow-native-guild/scripts/acceptance.mjs`, `scripts/doctor.mjs`, `test/acceptance.test.mjs`, `test/doctor.test.mjs`, `test/skill-contract.test.mjs`, `test/case-files.test.mjs`: replace tests that require the old Skill or case record with tests for the native mission and direct MCP catalogs.
- `ops/deerflow-native-guild/README.md`: explain the default Lead and a read-only first-use prompt.

---

### Task 1: Install a Guild Mission in the Default Lead

**Files:**
- Create: `ops/deerflow-native-guild/config/guild-soul.md`
- Create: `ops/deerflow-native-guild/src/guild-soul.mjs`
- Create: `ops/deerflow-native-guild/test/guild-soul.test.mjs`
- Modify: `ops/deerflow-native-guild/scripts/bootstrap.mjs`
- Modify: `ops/deerflow-native-guild/test/bootstrap.test.mjs`

**Interfaces:**
- Consumes: `packageRoot`, `DEER_FLOW_HOME` layout in `scripts/start.mjs`, and DeerFlow's native `load_agent_soul(None)` from `backend/packages/harness/deerflow/config/agents_config.py`.
- Produces: `ensureGuildSoul({ packageRoot }) -> Promise<{ installed: boolean, path: string }>`; `bootstrapRuntime` invokes it after verifying the pinned checkout and before dependency installation. The installer uses `fs/promises.mkdir` and `copyFile(..., constants.COPYFILE_EXCL)`; `bootstrapRuntime` has an injectable `installSoul` option for its offline tests.

- [ ] **Step 1: Write the installer tests.** Test initial creation in a temporary package root, second-run idempotency, and preservation of a user-edited `SOUL.md`. Compare the complete file contents after the second run.

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureGuildSoul } from '../src/guild-soul.mjs';

test('installs once and preserves a customized default Lead mission', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'guild-soul-'));
  try {
    await mkdir(path.join(fixtureRoot, 'config'));
    await writeFile(path.join(fixtureRoot, 'config', 'guild-soul.md'), 'initial mission\n');
    const first = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(first, {
      installed: true,
      path: path.join(fixtureRoot, '.runtime', 'deerflow-home', 'SOUL.md'),
    });
    assert.equal(await readFile(first.path, 'utf8'), 'initial mission\n');
    await writeFile(first.path, 'operator customization\n');
    const second = await ensureGuildSoul({ packageRoot: fixtureRoot });
    assert.deepEqual(second, { installed: false, path: first.path });
    assert.equal(await readFile(first.path, 'utf8'), 'operator customization\n');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run `node --test test/guild-soul.test.mjs` from `ops/deerflow-native-guild`.** Expected: module-not-found failure before implementation.

- [ ] **Step 3: Implement the exclusive installer and wire bootstrap.** The only swallowed error is `EEXIST`; missing template, permissions and I/O errors propagate. Keep `bootstrapRuntime`'s dependency-injected tests offline by adding an `installSoul` option defaulting to `ensureGuildSoul`.

```js
import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function ensureGuildSoul({ packageRoot }) {
  const home = path.join(packageRoot, '.runtime', 'deerflow-home');
  const target = path.join(home, 'SOUL.md');
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await copyFile(path.join(packageRoot, 'config', 'guild-soul.md'), target, constants.COPYFILE_EXCL);
    return { installed: true, path: target };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { installed: false, path: target };
  }
}
```

  Use this short mission text in `config/guild-soul.md`:

```md
# TikTok LIVE Guild Lead

Help the operator recruit and support suitable creators and improve the guild's durable LIVE results. Work across recruitment, creator development, activities, revenue and governance. Choose your own investigation, communication and follow-up strategy for the situation.

Use TKDesk for candidate identity and handoff facts. Use the Guild Operator MCP for current LIVE Backstage facts; obtain the current guild reference before guild-scoped reads. Keep source, time, units, visible scope and completeness when explaining a result. A prior case or memory is context, not proof of today's policy, quota or platform state.

Use DeerFlow's normal planning, tools, memory and delegation as needed. A draft is not a sent message. Respect an explicit request not to be contacted. Ask the operator for a missing fact or unavailable platform action when necessary; otherwise decide the next business step yourself.
```

  In `test/bootstrap.test.mjs`, inject `installSoul: async ({ packageRoot }) => { events.push(['soul', packageRoot]); }` into the patch-order test and expect `['remote', 'head', 'patch', 'soul', 'npm']`. Inject an async no-op in other successful bootstrap tests that use `/tmp/deerflow-native-guild`.

- [ ] **Step 4: Run the focused installer and bootstrap tests, then `npm test`.** Expected: all pass without accessing TikTok or altering an existing SOUL.
- [ ] **Step 5: Commit only this task's files.** Suggested message: `feat(deerflow): seed native guild lead mission`.

### Task 2: Retire the Fixed Skill and Case Runtime

**Files:**
- Modify: `ops/deerflow-native-guild/config/extensions_config.json`
- Modify: `ops/deerflow-native-guild/config/config.yaml`
- Modify: `ops/deerflow-native-guild/config/local-manifest.json`
- Modify: `ops/deerflow-native-guild/scripts/doctor.mjs`
- Modify: `ops/deerflow-native-guild/test/doctor.test.mjs`
- Modify: `ops/deerflow-native-guild/test/acceptance.test.mjs`
- Delete: `ops/deerflow-native-guild/skills/public/guild-recruitment-lead/SKILL.md`, `references/source-lock.json`, `references/case-record.md`, and `references/conversation-methods.json`.
- Delete: `ops/deerflow-native-guild/test/skill-contract.test.mjs`
- Preserve untouched: `ops/deerflow-native-guild/.runtime/cases/**`.

**Interfaces:**
- Consumes: Task 1's default Lead mission; DeerFlow's `SkillStorage.load_skills` scans the active skills directory, while MCP tools load independently from `mcpServers`.
- Produces: zero active package recruitment Skills, unchanged eight Guild Operator tool names, unchanged TKDesk server, no case mount or `cases_path` manifest entry.

- [ ] **Step 1: Change the runtime contract test first.** Assert that the old Skill file is absent from the active skills path, that the extensions config does not enable it, that the obsolete case mount and manifest key are absent, and that both MCP server entries and their tool names remain unchanged. Run `node --test test/acceptance.test.mjs` and observe failure against the old configuration.

```js
assert.equal(existsSync(path.join(PACKAGE_ROOT, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
assert.equal(extensions.skills?.['guild-recruitment-lead']?.enabled, undefined);
assert.doesNotMatch(configText, /\/mnt\/guild-cases/u);
assert.equal('cases_path' in JSON.parse(manifestText), false);
assert.deepEqual(Object.keys(extensions.mcpServers), ['guild_operator', 'tkdesk']);
```

- [ ] **Step 2: Remove the old Skill files and active case mount.** Remove only tracked Skill/reference files and the obsolete config keys. Do not remove any ignored runtime case files. In `doctor.mjs`, remove `cases_permissions` from `REQUIRED_DOCTOR_CHECKS` and its adapter; update the test's check list accordingly.
- [ ] **Step 3: Run `node --test test/acceptance.test.mjs test/doctor.test.mjs`, then `npm test`.** Expected: the new runtime contract passes; the old case utility tests remain until Task 3 removes their implementation and tests together.
- [ ] **Step 4: Commit only this task's files.** Suggested message: `refactor(deerflow): retire fixed recruitment skill`.

### Task 3: Make Acceptance Reflect the Native Product

**Files:**
- Modify: `ops/deerflow-native-guild/scripts/acceptance.mjs`
- Modify: `ops/deerflow-native-guild/test/acceptance.test.mjs`
- Modify: `ops/deerflow-native-guild/README.md`
- Delete: `ops/deerflow-native-guild/src/case-schema.mjs`, `src/case-files.mjs`, `scripts/case.mjs`, `test/case-files.test.mjs`, `fixtures/cases/active-creator.json` and `fixtures/conversation-cases.json` after their imports are removed.

**Interfaces:**
- Consumes: Task 1's installed default Lead SOUL and Task 2's two direct MCP servers.
- Produces: `runAcceptance()` returns `{ ok, mcpServers, guildTools, tkdeskTools, nativeGuildLead: true }` after package tests, doctor and MCP catalog checks. It does not claim live TikTok read, send or business outcome validation.

- [ ] **Step 1: Replace the acceptance fixture expectation first.** The focused offline test should expect the return shape below; run `node --test test/acceptance.test.mjs` and observe failure before changing the script.

```js
assert.deepEqual(report, {
  ok: true,
  mcpServers: 2,
  guildTools: 8,
  tkdeskTools: tkdesk.tools.length,
  nativeGuildLead: true,
});
```

- [ ] **Step 2: Remove `syntheticCaseRestart` and the exact-one-Skill requirement from `runAcceptance`.** Check that `config/guild-soul.md` is nonempty and that `skills/public/guild-recruitment-lead/SKILL.md` is absent. Keep existing doctor, package-test and two-MCP catalog assertions. In `test/acceptance.test.mjs`, remove the `a synthetic case survives a storage restart` test and its `readCase`, `writeCase`, `mkdtemp` and `os` imports. Delete the now-unused case implementation and fixture files listed above using tracked-file edits only. Update README's first safe prompt to ask the default Lead for a read-only diagnosis using current Guild Operator and TKDesk facts; describe `.runtime/cases` as legacy local data that remains untouched. Add `import { existsSync } from 'node:fs'` to the acceptance script and remove imports made unused by the case removal.

```js
export async function runAcceptance({
  packageRoot,
  doctor = (options) => runDoctor(options),
  probeCatalogs = () => defaultProbeCatalogs(packageRoot),
  runTests = runCommand,
} = {}) {
  const root = path.resolve(packageRoot);
  const mission = await readFile(path.join(root, 'config', 'guild-soul.md'), 'utf8');
  assert.ok(mission.trim().length > 0, 'guild mission is empty');
  assert.equal(existsSync(path.join(root, 'skills/public/guild-recruitment-lead/SKILL.md')), false);
  const extensions = JSON.parse(await readFile(path.join(root, 'config', 'extensions_config.json'), 'utf8'));
  assert.deepEqual(Object.keys(extensions.mcpServers), ['guild_operator', 'tkdesk']);

  const testResult = await runTests(process.execPath, ['--test'], { cwd: root });
  if (testResult.code !== 0) throw new Error(`Package tests failed: ${testResult.stderr || testResult.stdout}`);
  const doctorReport = await doctor({ packageRoot: root });
  if (!doctorReport.ok) {
    const failed = doctorReport.checks.filter(({ ok }) => !ok).map(({ name }) => name).join(', ');
    throw new Error(`Doctor failed: ${failed}`);
  }

  const expectedGuild = JSON.parse(await readFile(path.join(root, 'fixtures/mcp/guild-tools.json'), 'utf8'));
  const expectedTkdesk = JSON.parse(await readFile(path.join(root, 'fixtures/mcp/tkdesk-tools.json'), 'utf8'));
  const actual = await probeCatalogs();
  const guild = snapshotCatalog(actual.guild);
  const tkdesk = snapshotCatalog(actual.tkdesk);
  assert.deepEqual(guild, expectedGuild, 'Guild Operator tool catalog or schema changed');
  assert.deepEqual(tkdesk, expectedTkdesk, 'TKDesk tool catalog or schema changed');
  return {
    ok: true,
    mcpServers: 2,
    guildTools: guild.tools.length,
    tkdeskTools: tkdesk.tools.length,
    nativeGuildLead: true,
  };
}
```

- [ ] **Step 3: Run `npm test`, `npm run doctor` and `npm run acceptance`.** Expected: all three pass; `doctor` proves direct MCP catalog access, not live data correctness. Run bootstrap once to install `SOUL.md` in an existing runtime; it must preserve a pre-existing file. Then use one read-only DeerFlow conversation to verify the default Lead can call both MCPs without requesting the removed Skill. Record actual tool calls and data completeness; do not trigger any external write.
- [ ] **Step 4: Commit only this task's files.** Suggested message: `test(deerflow): accept native guild lead`.

## Subsequent Separate Plans

1. **Trusted external-channel provenance:** carry a server-owned channel source through ChannelManager → Gateway → Lead, reject forged source from HTTP/config, and test the real cross-layer path. This is a prerequisite for TikTok creator messages because channel runs currently use the connection owner's DeerFlow identity and role.
2. **Native TikTok Channel:** after current message protocol, sender identity, connection and receipt evidence is captured, reuse DeerFlow's existing external-conversation-to-thread mapping. Keep channel threads out of primary web history; do not add creator accounts or a second mapping store.
3. **Workbench facts:** replace the current unavailable state with direct, dated Guild Operator overview reads once field and pagination contracts are proven. Keep it read-only and free of creator chat mirrors.
4. **Real outbound actions:** implement only after reliable send/invite permissions, idempotency and receipt contracts exist; the Agent chooses timing and content itself.

Current live audit is deliberately not checked into this plan: account metrics and creator identifiers can change and should remain in the operator's live tools, not become product fixtures.
