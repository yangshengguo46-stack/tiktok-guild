import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Versions used by the customer installer.  Changing one requires a new audit. */
export const CUSTOMER_TOOLCHAIN = Object.freeze({
  node: '22.16.0',
  java: '17',
  androidPlatformTools: '35.0.2',
  androidPlatform: '35',
  androidBuildTools: '35.0.0',
  appium: '3.1.0',
  uiautomator2: '8.7.0',
});

function candidate(home, platform, relative) {
  return path.join(home, relative.split('/').join(path.sep));
}

export function resolveCustomerToolchain({
  packageRoot,
  home = os.homedir(),
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const root = path.resolve(packageRoot);
  const runtimeRoot = path.join(root, 'ops', 'guild-runtime', '.runtime');
  const toolchainRoot = path.join(runtimeRoot, 'toolchain');
  const androidSdkRoot = path.join(toolchainRoot, 'android-sdk');
  const javaHome = path.join(toolchainRoot, 'jdk-17');
  const nodeRoot = path.join(toolchainRoot, 'node-22');
  const sdkCandidates = platform === 'darwin'
    ? [candidate(home, platform, 'Library/Android/sdk')]
    : platform === 'win32'
      ? [process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '']
      : [candidate(home, platform, 'Android/Sdk')];
  const javaCandidates = platform === 'darwin'
    ? [candidate(home, platform, 'Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home')]
    : platform === 'win32'
      ? [path.join(process.env.PROGRAMFILES ?? '', 'Java', 'jdk-17')]
      : [candidate(home, platform, '.sdkman/candidates/java/17')];
  const selectedSdk = sdkCandidates.find((value) => value && exists(value)) ?? androidSdkRoot;
  const selectedJava = javaCandidates.find((value) => value && exists(value)) ?? javaHome;
  const executable = (base, name) => path.join(base, 'bin', platform === 'win32' ? `${name}.exe` : name);
  return Object.freeze({
    runtimeRoot,
    toolchainRoot,
    androidSdkRoot,
    selectedSdkRoot: selectedSdk,
    javaHome,
    selectedJavaHome: selectedJava,
    nodeRoot,
    adb: path.join(selectedSdk, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb'),
    sdkmanager: path.join(selectedSdk, 'cmdline-tools', 'latest', 'bin', platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'),
    java: executable(selectedJava, 'java'),
    node: executable(nodeRoot, 'node'),
    npm: executable(nodeRoot, platform === 'win32' ? 'npm.cmd' : 'npm'),
    operatorRoot: path.join(root, 'ops', 'guild-runtime', 'public-outreach-operator'),
  });
}

export function buildCustomerToolchainEnvironment({ packageRoot, environment = process.env, exists = existsSync, platform = process.platform } = {}) {
  const toolchain = resolveCustomerToolchain({
    packageRoot,
    home: environment.HOME ?? environment.USERPROFILE ?? os.homedir(),
    platform,
    exists,
  });
  const sdkRoot = environment.ANDROID_SDK_ROOT ?? environment.ANDROID_HOME ?? toolchain.selectedSdkRoot;
  const javaHome = environment.JAVA_HOME ?? toolchain.selectedJavaHome;
  const sdkBins = [
    path.join(sdkRoot, 'platform-tools'),
    path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin'),
    path.join(sdkRoot, 'tools', 'bin'),
  ];
  const javaBin = path.join(javaHome, 'bin');
  const nodeBin = path.join(toolchain.nodeRoot, 'bin');
  return {
    toolchain,
    ANDROID_SDK_ROOT: sdkRoot,
    ANDROID_HOME: environment.ANDROID_HOME ?? sdkRoot,
    JAVA_HOME: javaHome,
    PATH: [...sdkBins, javaBin, nodeBin, environment.PATH ?? ''].filter(Boolean).join(path.delimiter),
  };
}
