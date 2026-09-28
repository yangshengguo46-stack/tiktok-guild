#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RotatingLog } from '../src/rotating-log.mjs';

export function logService({ command, args = [], logfile, maxBytes, backups }) {
  const log = new RotatingLog(logfile, { maxBytes, backups });
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let loggingFailed = false;
    let killTimer;
    const signalChild = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    const stop = (signal) => {
      signalChild(signal);
      killTimer ??= setTimeout(() => signalChild('SIGKILL'), 5000);
    };
    const onInterrupt = () => stop('SIGINT');
    const onTerminate = () => stop('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const write = (chunk) => {
      if (loggingFailed) return;
      try { log.write(chunk); }
      catch (error) {
        loggingFailed = true;
        console.error(`Runtime log write failed: ${error.message}`);
        stop('SIGTERM');
      }
    };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('error', (error) => {
      loggingFailed = true;
      console.error(`Runtime service could not start: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      log.close();
      resolve(loggingFailed ? 1 : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code ?? 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = process.argv.slice(2);
    const separator = flags.indexOf('--');
    const options = {};
    if (separator < 0 || separator % 2 !== 0) throw new Error('Usage: log-service.mjs --log PATH [--max-bytes N] [--backups N] -- COMMAND ARGS');
    for (let index = 0; index < separator; index += 2) {
      const name = { '--log': 'logfile', '--max-bytes': 'maxBytes', '--backups': 'backups' }[flags[index]];
      if (!name || !flags[index + 1]) throw new Error('Invalid runtime log option.');
      options[name] = name === 'logfile' ? flags[index + 1] : Number(flags[index + 1]);
    }
    const [command, ...args] = flags.slice(separator + 1);
    if (!command || !options.logfile) throw new Error('Runtime log requires a file and service command.');
    process.exitCode = await logService({ ...options, command, args });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
