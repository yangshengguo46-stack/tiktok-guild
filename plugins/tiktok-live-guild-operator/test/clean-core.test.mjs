import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCleanCore } from "../scripts/verify-clean-core.mjs";

async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "guild-clean-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "entry.mjs"), source);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { playwright: "1.59.1" } }));
  return root;
}

test("clean production imports pass", async (t) => {
  const root = await fixture(t, 'import { createHash } from "node:crypto";\nexport { createHash };\n');
  assert.deepEqual(await verifyCleanCore(root), []);
});

test("forbidden storage imports fail with their source path", async (t) => {
  const root = await fixture(t, 'import sqlite from "node:sqlite";\nexport { sqlite };\n');
  const violations = await verifyCleanCore(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /src\/entry\.mjs/);
  assert.match(violations[0], /node:sqlite/);
});

test('only the native message reservation owner may import built-in SQLite', async t => {
  const root=await fixture(t,'export const clean=true;');
  await mkdir(path.join(root,'src','messaging'));
  await writeFile(path.join(root,'src','messaging','operation-store.mjs'),'import { DatabaseSync } from "node:sqlite";\nexport { DatabaseSync };\n');
  assert.deepEqual(await verifyCleanCore(root),[]);
  await writeFile(path.join(root,'src','messaging','other-ledger.mjs'),'import { DatabaseSync } from "node:sqlite";\nexport { DatabaseSync };\n');
  const violations=await verifyCleanCore(root);
  assert.equal(violations.length,1);assert.match(violations[0],/other-ledger/);
});

test('existing native onboarding files pass while an unrelated legacy module is rejected', async t => {
  const root=await fixture(t,'import { plan } from "./onboarding/workflow.mjs"; export {plan};');
  await mkdir(path.join(root,'src','onboarding'));
  await writeFile(path.join(root,'src','onboarding','workflow.mjs'),'export const plan = {};');
  assert.deepEqual(await verifyCleanCore(root),[]);
  await writeFile(path.join(root,'src','onboarding','legacy-ledger.mjs'),'export const ledger = {};');
  const violations=await verifyCleanCore(root);assert.equal(violations.length,1);assert.match(violations[0],/legacy-ledger/);
});
