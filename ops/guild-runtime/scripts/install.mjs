#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEERFLOW_PNPM_VERSION } from '../src/constants.mjs';
import { ensureGuildSoul } from '../src/guild-soul.mjs';
import { runCommand } from '../src/process.mjs';
import { buildCustomerToolchainEnvironment, CUSTOMER_TOOLCHAIN, resolveCustomerToolchain } from '../src/toolchain.mjs';
import { loadRuntimeConfig } from '../src/runtime-config.mjs';

export { CUSTOMER_TOOLCHAIN, resolveCustomerToolchain };

async function checkedRun(run, command, args, options, label = command) {
  let result;
  try {
    result = await run(command, args, options);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.code}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

async function probe(run, command, args, options) {
  try {
    return await run(command, args, options);
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

function assertNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version ?? '');
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 16)) {
    throw new Error(`Node.js 22.16 or newer is required (found ${version ?? 'unknown'}).`);
  }
}

/**
 * Prepare host-level tools through a package manager when they are absent.
 * The package manager is invoked by this controlled entry point; customers do
 * not need to copy/paste brew/sdkmanager commands. Unsupported hosts fail
 * closed with the exact missing dependency.
 */
export async function prepareExternalDependencies({ platform = process.platform, run = runCommand, environment = process.env, toolchain } = {}) {
  const options = { cwd: toolchain?.runtimeRoot, env: environment };
  if (platform === 'win32') {
    const java = await probe(run, 'java', ['-version'], options);
    if (java.code !== 0) {
      await checkedRun(run, 'winget', ['install', '--exact', '--id', 'EclipseAdoptium.Temurin.17.JDK', '--accept-source-agreements', '--accept-package-agreements'], options, 'Java 17 installation');
    }
    const sdk = await probe(run, 'sdkmanager', ['--version'], options);
    if (sdk.code !== 0) {
      await checkedRun(run, 'winget', ['install', '--exact', '--id', 'Google.AndroidStudio', '--accept-source-agreements', '--accept-package-agreements'], options, 'Android SDK installation');
    }
    return;
  }
  if (platform === 'darwin') {
    const java = await probe(run, 'java', ['-version'], options);
    if (java.code !== 0) await checkedRun(run, 'brew', ['install', '--cask', 'temurin@17'], options, 'Java 17 installation');
    const sdk = await probe(run, 'sdkmanager', ['--version'], options);
    if (sdk.code !== 0) await checkedRun(run, 'brew', ['install', '--cask', 'android-commandlinetools'], options, 'Android SDK command-line tools installation');
    return;
  }
  const java = await probe(run, 'java', ['-version'], options);
  const sdk = await probe(run, 'sdkmanager', ['--version'], options);
  if (java.code !== 0 || sdk.code !== 0) {
    throw new Error('Java 17 and Android command-line tools are required; install them with the host package manager, then rerun this controlled installer.');
  }
}

export async function installCustomerRuntime({
  packageRoot,
  platform = process.platform,
  home,
  config,
  makeDirectory = (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
  run = runCommand,
  writeState = (file, state) => writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }),
  installSoul = ensureGuildSoul,
  environment = process.env,
  prepareDependencies = prepareExternalDependencies,
} = {}) {
  assertNodeVersion(process.versions.node);
  const loaded = config ?? await loadRuntimeConfig({ packageRoot });
  const root = path.resolve(loaded.packageRoot ?? packageRoot);
  const opsRoot = loaded.opsRoot ?? path.join(root, 'ops', 'guild-runtime');
  const toolchain = resolveCustomerToolchain({ packageRoot: root, home, platform });
  const customerEnv = {
    ...environment,
    ...buildCustomerToolchainEnvironment({ packageRoot: root, platform, environment: { ...environment, ...(home ? { HOME: home } : {}) } }),
    CI: 'true',
    npm_config_cache: path.join(toolchain.runtimeRoot, 'cache', 'npm'),
    XDG_CACHE_HOME: path.join(toolchain.runtimeRoot, 'cache'),
    COREPACK_HOME: path.join(toolchain.runtimeRoot, 'cache', 'corepack'),
  };
  const pnpmBinRoot = path.join(toolchain.runtimeRoot, 'tools', 'pnpm', 'node_modules', '.bin');
  customerEnv.PATH = `${pnpmBinRoot}${path.delimiter}${customerEnv.PATH}`;
  await makeDirectory(toolchain.runtimeRoot);
  await makeDirectory(toolchain.toolchainRoot);
  await makeDirectory(path.join(toolchain.runtimeRoot, 'cache'));
  await installSoul({ packageRoot: root });
  await prepareDependencies({ platform, run, environment: customerEnv, toolchain });

  await checkedRun(run, 'npm', ['ci', '--ignore-scripts'], { cwd: opsRoot, env: customerEnv }, 'guild runtime npm dependencies');
  await checkedRun(run, 'npm', ['ci', '--ignore-scripts'], {
    cwd: toolchain.operatorRoot,
    env: customerEnv,
  }, 'Android operator npm dependencies');
  const pnpmRoot = path.join(toolchain.runtimeRoot, 'tools', 'pnpm');
  await makeDirectory(pnpmRoot);
  await checkedRun(run, 'npm', [
    'install', '--prefix', pnpmRoot, '--no-save', '--no-package-lock', '--ignore-scripts', `pnpm@${DEERFLOW_PNPM_VERSION}`,
  ], { cwd: toolchain.runtimeRoot, env: customerEnv }, 'pinned pnpm bootstrap');
  await checkedRun(run, 'make', ['install'], { cwd: root, env: customerEnv }, 'DeerFlow dependency installation');
  await checkedRun(run, 'sdkmanager', [
    '--sdk_root', toolchain.androidSdkRoot,
    'platform-tools', `platforms;android-${CUSTOMER_TOOLCHAIN.androidPlatform}`, `build-tools;${CUSTOMER_TOOLCHAIN.androidBuildTools}`,
  ], { cwd: toolchain.runtimeRoot, env: customerEnv }, 'Android SDK component installation');
  await checkedRun(run, 'java', ['-version'], { cwd: root, env: customerEnv }, 'Java runtime');
  await checkedRun(run, 'adb', ['version'], { cwd: root, env: customerEnv }, 'Android platform tools');

  const state = {
    schema: 1,
    installedAt: new Date().toISOString(),
    platform,
    toolchain: CUSTOMER_TOOLCHAIN,
    paths: {
      runtimeRoot: toolchain.runtimeRoot,
      androidSdkRoot: toolchain.androidSdkRoot,
      javaHome: toolchain.javaHome,
      nodeRoot: toolchain.nodeRoot,
    },
    externalWrites: false,
    messageEnabled: false,
    next: 'Run npm run doctor -- --static, then configure one authorized Android pilot device.',
  };
  await writeState(path.join(toolchain.runtimeRoot, 'install-state.json'), state);
  return { status: 'ready', toolchain, state };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  installCustomerRuntime({ packageRoot })
    .then(({ toolchain }) => console.log(`Customer runtime ready at ${toolchain.runtimeRoot}.`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
