#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN = /(?:^|[\/_-])(?:company(?:_data)?|sqlite|scheduler|collector|bootstrap|publication|patrol|migration|onboarding|legacy)(?:$|[\/_-])|node:sqlite/iu;
// Native onboarding is an existing live capability. Message reservations are
// the sole allowed persistent execution record, scoped to their owner module.
const NATIVE_ONBOARDING = new Set([
  "src/onboarding/affiliate-evidence.mjs",
  "src/onboarding/workflow.mjs",
  "src/onboarding/live-write.mjs"
]);
const MESSAGE_RESERVATION_OWNER = "src/messaging/operation-store.mjs";
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\()(["'])([^"']+)\1/gu;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(target);
  }
  return files;
}

export async function verifyCleanCore(root) {
  const violations = [];
  const sourceRoot = path.join(root, "src");
  for (const file of await sourceFiles(sourceRoot)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (FORBIDDEN.test(relative) && !NATIVE_ONBOARDING.has(relative)) violations.push(`${relative}: forbidden production path`);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const nativeTarget = match[2].startsWith(".")
        ? path.normalize(path.join(path.dirname(relative), match[2])).split(path.sep).join("/") : null;
      const permitted = NATIVE_ONBOARDING.has(nativeTarget)
        || (relative === MESSAGE_RESERVATION_OWNER && match[2] === "node:sqlite");
      if (FORBIDDEN.test(match[2]) && !permitted) violations.push(`${relative}: forbidden import ${match[2]}`);
    }
  }

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {})
  };
  for (const dependency of Object.keys(dependencies)) {
    if (FORBIDDEN.test(dependency)) violations.push(`package.json: forbidden dependency ${dependency}`);
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] ?? ".");
  const violations = await verifyCleanCore(root);
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`${violation}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Clean core verification passed.\n");
  }
}
