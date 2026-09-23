import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

async function defaultPathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validatePatchList(patches) {
  if (!Array.isArray(patches)) {
    throw new Error('Product patches must be an array.');
  }
  if (patches.length > 1) {
    throw new Error('Only one cumulative product patch is supported.');
  }
}

async function resolveProductPatches({
  packageRoot,
  patches,
  pathExists,
  pathInfo,
}) {
  validatePatchList(patches);
  const root = path.resolve(packageRoot);
  const patchRoot = path.join(root, 'patches');
  const resolved = [];

  for (const patch of patches) {
    if (typeof patch !== 'string' || !/^patches\/[0-9]{4}-[a-z0-9-]+\.patch$/u.test(patch)) {
      throw new Error('Product patch path must stay inside patches/ and use a numbered patch filename.');
    }
    const patchPath = path.resolve(root, patch);
    if (!patchPath.startsWith(`${patchRoot}${path.sep}`)) {
      throw new Error('Product patch path must stay inside the package patch directory.');
    }
    if (!await pathExists(patchPath)) {
      throw new Error(`Product patch does not exist: ${patch}`);
    }
    const info = await pathInfo(patchPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Invalid product patch: ${patch}`);
    }
    resolved.push({ declaredPath: patch, patchPath });
  }

  return resolved;
}

export async function applyProductPatches({
  packageRoot,
  destination,
  patches = [],
  run,
  pathExists = defaultPathExists,
  pathInfo = lstat,
}) {
  const resolved = await resolveProductPatches({ packageRoot, patches, pathExists, pathInfo });

  for (const { declaredPath, patchPath } of resolved) {
    const reverseCheck = await run('git', [
      '-C', destination, 'apply', '--reverse', '--check', patchPath,
    ]);
    if (reverseCheck.code === 0) continue;

    const forwardCheck = await run('git', ['-C', destination, 'apply', '--check', patchPath]);
    if (forwardCheck.code !== 0) {
      const detail = forwardCheck.stderr?.trim() || forwardCheck.stdout?.trim() || `exit ${forwardCheck.code}`;
      throw new Error(`Product patch conflicts: ${declaredPath}: ${detail}`);
    }

    const applied = await run('git', ['-C', destination, 'apply', patchPath]);
    if (applied.code !== 0) {
      const detail = applied.stderr?.trim() || applied.stdout?.trim() || `exit ${applied.code}`;
      throw new Error(`Product patch failed: ${declaredPath}: ${detail}`);
    }
  }
}

export async function verifyProductPatches({
  packageRoot,
  destination,
  patches = [],
  run,
  pathExists = defaultPathExists,
  pathInfo = lstat,
}) {
  const resolved = await resolveProductPatches({ packageRoot, patches, pathExists, pathInfo });

  for (const { declaredPath, patchPath } of resolved) {
    const result = await run('git', [
      '-C', destination, 'apply', '--reverse', '--check', patchPath,
    ]);
    if (result.code !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.code}`;
      throw new Error(`Product patch is not applied: ${declaredPath}: ${detail}`);
    }
  }
}
