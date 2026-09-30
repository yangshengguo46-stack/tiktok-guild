import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CUSTOMER_TOOLCHAIN,
  installCustomerRuntime,
  prepareExternalDependencies,
  resolveCustomerToolchain,
} from '../scripts/install.mjs';
import { buildRuntimeEnvironment } from '../src/runtime-environment.mjs';

const ROOT = '/tmp/customer-guild';
const CONFIG = { packageRoot: ROOT, opsRoot: path.join(ROOT, 'ops', 'guild-runtime') };

 test('customer toolchain is portable and pins the Android/Appium contract', () => {
  const toolchain = resolveCustomerToolchain({ packageRoot: ROOT, home: '/Users/customer', platform: 'darwin' });
  assert.equal(toolchain.runtimeRoot, path.join(ROOT, 'ops', 'guild-runtime', '.runtime'));
  assert.equal(toolchain.androidSdkRoot, path.join(toolchain.toolchainRoot, 'android-sdk'));
  assert.equal(toolchain.javaHome, path.join(toolchain.toolchainRoot, 'jdk-17'));
  assert.equal(toolchain.nodeRoot, path.join(toolchain.toolchainRoot, 'node-22'));
  assert.deepEqual(CUSTOMER_TOOLCHAIN, {
    node: '22.16.0',
    java: '17',
    androidPlatformTools: '35.0.2',
    androidPlatform: '35',
    androidBuildTools: '35.0.0',
    appium: '3.1.0',
    uiautomator2: '8.7.0',
  });
  for (const value of Object.values(toolchain)) assert.equal(value.includes('/Users/yangyucheng/'), false);
});

test('runtime environment can use customer toolchain paths without shell exports', () => {
  const environment = buildRuntimeEnvironment({
    packageRoot: ROOT,
    config: CONFIG,
    environment: { HOME: '/Users/customer', PATH: '/usr/bin' },
    exists: () => false,
  });
  assert.equal(environment.ANDROID_SDK_ROOT, path.join(ROOT, 'ops', 'guild-runtime', '.runtime', 'toolchain', 'android-sdk'));
  assert.equal(environment.JAVA_HOME, path.join(ROOT, 'ops', 'guild-runtime', '.runtime', 'toolchain', 'jdk-17'));
  assert.match(environment.PATH, /android-sdk[\\/]platform-tools/u);
  assert.match(environment.PATH, /jdk-17[\\/]bin/u);
});

test('customer installer runs fixed dependency steps and writes durable state', async () => {
  const calls = [];
  const writes = [];
  const result = await installCustomerRuntime({
    packageRoot: ROOT,
    config: CONFIG,
    platform: 'darwin',
    home: '/Users/customer',
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
    makeDirectory: async () => {},
    writeState: async (file, state) => writes.push({ file, state }),
    installSoul: async () => {},
    prepareDependencies: async () => {},
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['npm', ['ci', '--ignore-scripts']],
    ['npm', ['ci', '--ignore-scripts']],
    ['npm', ['install', '--prefix', path.join(result.toolchain.runtimeRoot, 'tools', 'pnpm'), '--no-save', '--no-package-lock', '--ignore-scripts', 'pnpm@10.26.2']],
    ['make', ['install']],
    ['sdkmanager', ['--sdk_root', result.toolchain.androidSdkRoot, 'platform-tools', 'platforms;android-35', 'build-tools;35.0.0']],
    ['java', ['-version']],
    ['adb', ['version']],
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, path.join(result.toolchain.runtimeRoot, 'install-state.json'));
  assert.equal(writes[0].state.toolchain.appium, '3.1.0');
  assert.equal(writes[0].state.externalWrites, false);
  assert.equal(calls[0].options.env.CI, 'true');
  assert.match(calls[0].options.env.PATH, /platform-tools/u);
});

test('customer installer never enables provider writes while preparing dependencies', async () => {
  const writes = [];
  await installCustomerRuntime({
    packageRoot: ROOT,
    config: CONFIG,
    platform: 'linux',
    home: '/home/customer',
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    makeDirectory: async () => {},
    writeState: async (_file, state) => writes.push(state),
    installSoul: async () => {},
    prepareDependencies: async () => {},
  });
  assert.equal(writes[0].externalWrites, false);
});

test('macOS preparation owns missing Java and SDK package-manager steps', async () => {
  const calls = [];
  await prepareExternalDependencies({
    platform: 'darwin',
    toolchain: resolveCustomerToolchain({ packageRoot: ROOT, home: '/Users/customer', platform: 'darwin' }),
    environment: {},
    run: async (command, args) => {
      calls.push([command, args]);
      return { code: command === 'java' || command === 'sdkmanager' ? 127 : 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls, [
    ['java', ['-version']],
    ['brew', ['install', '--cask', 'temurin@17']],
    ['sdkmanager', ['--version']],
    ['brew', ['install', '--cask', 'android-commandlinetools']],
  ]);
});

test('unsupported hosts fail closed when Java or SDK tools are missing', async () => {
  await assert.rejects(
    prepareExternalDependencies({
      platform: 'linux',
      toolchain: resolveCustomerToolchain({ packageRoot: ROOT, home: '/home/customer', platform: 'linux' }),
      environment: {},
      run: async () => ({ code: 127, stdout: '', stderr: '' }),
    }),
    /Java 17 and Android command-line tools are required/u,
  );
});
