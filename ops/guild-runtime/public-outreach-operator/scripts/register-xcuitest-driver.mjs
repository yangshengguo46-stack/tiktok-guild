#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = 'appium-xcuitest-driver';
const DRIVER_NAME = 'xcuitest';
const VERSION = '12.13.3';

function appiumBinary() {
  const defaultName = process.platform === 'win32' ? 'appium.cmd' : 'appium';
  return process.env.APPIUM_BIN ?? path.join(process.cwd(), 'node_modules', '.bin', defaultName);
}

function parseDriverList(stdout) {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Appium driver list did not return JSON.');
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new Error('Appium driver list returned invalid JSON.');
  }
}

async function listDrivers(binary) {
  const result = await execFileAsync(binary, ['driver', 'list', '--json'], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseDriverList(result.stdout);
}

async function installDriver(binary) {
  await execFileAsync(binary, [
    'driver',
    'install',
    '--source=npm',
    `${PACKAGE_NAME}@${VERSION}`,
  ], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
}

const binary = appiumBinary();
try {
  const current = await listDrivers(binary);
  const driver = current?.[DRIVER_NAME];
  if (driver?.installed === true && driver.version === VERSION) {
    console.log(`Appium driver ${DRIVER_NAME}@${VERSION} is already registered.`);
    process.exit(0);
  }
  if (driver?.installed === true && driver.version !== VERSION) {
    throw new Error(`Appium driver ${DRIVER_NAME} is registered at ${driver.version ?? 'unknown'}; expected ${VERSION}.`);
  }
  await installDriver(binary);
  const verified = await listDrivers(binary);
  const installed = verified?.[DRIVER_NAME];
  if (installed?.installed !== true || installed.version !== VERSION) {
    throw new Error(`Appium driver ${DRIVER_NAME}@${VERSION} did not appear in the registered driver list.`);
  }
  console.log(`Registered Appium driver ${DRIVER_NAME}@${VERSION}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
