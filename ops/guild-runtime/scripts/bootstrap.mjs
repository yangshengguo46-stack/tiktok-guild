#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEERFLOW_COMMIT, DEERFLOW_PNPM_VERSION, DEERFLOW_REPOSITORY } from '../src/constants.mjs';
import { ensureGuildSoul } from '../src/guild-soul.mjs';
import { runCommand } from '../src/process.mjs';
import { loadRuntimeConfig } from '../src/runtime-config.mjs';

function isFullCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
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
  makeDirectory = (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
  run = runCommand,
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
  if (commit !== DEERFLOW_COMMIT) {
    throw new Error('DeerFlow commit must match the approved pinned commit.');
  }

  const root = path.resolve(loaded.packageRoot);
  const ancestry = await run('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root });
  if (ancestry.code !== 0) {
    throw new Error(`Pinned upstream commit ${commit} must be an ancestor of the current DeerFlow fork.`);
  }

  await installSoul({ packageRoot: root });

  const opsRoot = loaded.opsRoot ?? path.join(root, 'ops', 'guild-runtime');
  const runtimeRoot = path.join(opsRoot, '.runtime');
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
    cwd: root,
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
  return { repository, commit, destination: root };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  bootstrapRuntime({ packageRoot })
    .then(({ destination, commit }) => console.log(`DeerFlow ready at ${destination} (${commit}).`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
