import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { SKILL_BEHAVIOR_SCENARIOS } from "./skill-fixtures.mjs";

const EXPECTED_SKILLS = [
  "govern-guild-backstage",
  "model-guild-task-economics",
  "operate-guild-activities",
  "operate-guild-creators",
  "operate-guild-onboarding",
  "operate-guild-recruitment-messaging",
  "operate-guild-revenue",
  "plan-audit-guild-business",
  "plan-three-month-guild-economics",
  "produce-guild-manager-report",
  "tiktok-live-guild-operator"
];

function frontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  assert.ok(match, "SKILL.md must begin with YAML frontmatter");
  const fields = Object.fromEntries(match[1].split("\n").map((line) => {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `Invalid frontmatter line: ${line}`);
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  return fields;
}

test("the plugin ships eleven uniquely discoverable skills", async () => {
  const root = new URL("../skills/", import.meta.url);
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directories, EXPECTED_SKILLS);

  const names = [];
  for (const directory of directories) {
    const markdown = await readFile(new URL(`${directory}/SKILL.md`, root), "utf8");
    const fields = frontmatter(markdown);
    assert.equal(fields.name, directory);
    assert.match(fields.description, /^Use when\b/u);
    names.push(fields.name);
  }
  assert.equal(new Set(names).size, 11);
});

test("fresh-task behavioral acceptance has six concrete scenarios", () => {
  assert.deepEqual(SKILL_BEHAVIOR_SCENARIOS.map(({ id }) => id), [
    "scoped-governance-failure",
    "single-visible-login",
    "partial-list",
    "large-guild",
    "authorized-identity-output",
    "data-before-tasks"
  ]);
});
