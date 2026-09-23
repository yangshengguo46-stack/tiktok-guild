#!/usr/bin/env node
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEERFLOW_PNPM_VERSION, DEERFLOW_REPOSITORY } from '../src/constants.mjs';
import { ensureGuildSoul } from '../src/guild-soul.mjs';
import { runCommand } from '../src/process.mjs';
import { applyProductPatches } from '../src/product-patches.mjs';
import { loadRuntimeConfig } from '../src/runtime-config.mjs';

function isFullCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}

async function defaultPathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function checkedRun(run, command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.code}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

export async function bootstrapRuntime({
  packageRoot,
  config,
  pathExists = defaultPathExists,
  makeDirectory = (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
  run = runCommand,
  applyPatches = applyProductPatches,
  installSoul = ensureGuildSoul,
} = {}) {
  const loaded = config ?? await loadRuntimeConfig({ packageRoot });
  const repository = loaded.manifest?.deerflow?.repository;
  const commit = loaded.manifest?.deerflow?.commit;
  if (repository !== DEERFLOW_REPOSITORY) {
    throw new Error('DeerFlow source must be the official upstream repository.');
  }
  if (!isFullCommit(commit)) {
    throw new Error('DeerFlow requires a full 40-character commit; floating refs are forbidden.');
  }

  const root = path.resolve(loaded.packageRoot);
  const runtimeRoot = path.resolve(root, loaded.manifest.runtime_root);
  if (!runtimeRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error('Runtime root must stay inside the native package.');
  }
  const destination = path.join(runtimeRoot, 'deer-flow');
  const checkoutExists = await pathExists(destination);
  if (checkoutExists && !await pathExists(path.join(destination, '.git'))) {
    throw new Error(`Existing DeerFlow destination is not a managed Git checkout: ${destination}`);
  }

  await makeDirectory(runtimeRoot);
  if (!checkoutExists) {
    await checkedRun(run, 'git', ['clone', '--filter=blob:none', '--no-checkout', repository, destination], {
      cwd: runtimeRoot,
    });
    await checkedRun(run, 'git', ['-C', destination, 'checkout', '--detach', commit], { cwd: runtimeRoot });
  }

  const remote = await checkedRun(run, 'git', ['-C', destination, 'config', '--get', 'remote.origin.url'], {
    cwd: runtimeRoot,
  });
  if (remote.stdout.trim() !== DEERFLOW_REPOSITORY) {
    throw new Error('Existing DeerFlow checkout must use the official upstream repository.');
  }
  const head = await checkedRun(run, 'git', ['-C', destination, 'rev-parse', 'HEAD'], { cwd: runtimeRoot });
  if (head.stdout.trim().toLowerCase() !== commit.toLowerCase()) {
    throw new Error(`Expected pinned HEAD ${commit}. Move the checkout aside, then rerun: mv '${destination}' '${destination}.backup'`);
  }

  await applyPatches({
    packageRoot: root,
    destination,
    patches: loaded.manifest.product_patches ?? [],
    run,
  });
  await installSoul({ packageRoot: root });

  const cacheRoot = path.join(runtimeRoot, 'cache');
  const binRoot = path.join(runtimeRoot, 'bin');
  const pnpmRoot = path.join(runtimeRoot, 'tools', 'pnpm');
  const pnpmBinRoot = path.join(pnpmRoot, 'node_modules', '.bin');
  await makeDirectory(cacheRoot);
  await makeDirectory(binRoot);
  await checkedRun(run, 'npm', [
    'install',
    '--prefix',
    pnpmRoot,
    '--no-save',
    '--no-package-lock',
    '--ignore-scripts',
    `pnpm@${DEERFLOW_PNPM_VERSION}`,
  ], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      CI: 'true',
      npm_config_cache: path.join(cacheRoot, 'npm'),
    },
  });
  await checkedRun(run, 'make', ['install'], {
    cwd: destination,
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${pnpmBinRoot}${path.delimiter}${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      npm_config_cache: path.join(cacheRoot, 'npm'),
      XDG_CACHE_HOME: cacheRoot,
      XDG_DATA_HOME: path.join(runtimeRoot, 'data'),
      XDG_STATE_HOME: path.join(runtimeRoot, 'state'),
      UV_CACHE_DIR: path.join(cacheRoot, 'uv'),
      UV_TOOL_DIR: path.join(runtimeRoot, 'tools', 'uv'),
      UV_TOOL_BIN_DIR: binRoot,
      PRE_COMMIT_HOME: path.join(cacheRoot, 'pre-commit'),
      COREPACK_HOME: path.join(cacheRoot, 'corepack'),
    },
  });
  return { repository, commit, destination };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  bootstrapRuntime({ packageRoot })
    .then(({ destination, commit }) => console.log(`DeerFlow ready at ${destination} (${commit}).`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
