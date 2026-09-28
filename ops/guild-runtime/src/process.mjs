import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function runCommand(command, args = [], {
  cwd,
  env = process.env,
  timeoutMs = 15 * 60 * 1000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGTERM');
        finish(() => reject(new Error(`${command} exceeded the bounded output limit.`)));
        return target;
      }
      return target + chunk;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signal) => finish(() => resolve({
      code: code ?? 1,
      signal,
      stdout,
      stderr,
    })));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs} ms.`)));
    }, timeoutMs);
  });
}

export function spawnForeground(command, args = [], { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    const forwardSignal = (signal) => child.kill(signal);
    const onInterrupt = () => forwardSignal('SIGINT');
    const onTerminate = () => forwardSignal('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);

    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (signal === 'SIGINT') resolve(130);
      else if (signal === 'SIGTERM') resolve(143);
      else resolve(code ?? 1);
    });
  });
}

export function probeMcpServer({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = 10_000,
  maxOutputBytes = 1024 * 1024,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let outputBytes = 0;
    let nextId = 1;
    let settled = false;
    let closed = false;
    const pending = new Map();

    const stop = () => new Promise((done) => {
      if (closed || !child.pid) { done(); return; }
      const signal = (value) => {
        try {
          if (process.platform === 'win32') child.kill(value);
          else process.kill(-child.pid, value);
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill(value);
        }
      };
      const termTimer = setTimeout(() => signal('SIGTERM'), 250);
      const killTimer = setTimeout(() => signal('SIGKILL'), 500);
      child.once('close', () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        done();
      });
      child.stdin.end();
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      for (const { reject: rejectCall, timer } of pending.values()) {
        clearTimeout(timer);
        rejectCall(new Error('MCP probe ended before a response arrived.'));
      }
      pending.clear();
      void stop().then(callback);
    };
    const fail = (message) => {
      const redact = (value) => {
        let text = value;
        for (const [name, secret] of Object.entries(env)) {
          if (/key|token|secret|password|authorization|cookie/iu.test(name) && secret) {
            text = text.split(String(secret)).join('[redacted]');
          }
        }
        return text;
      };
      const diagnostic = redact(stderr.trim()).slice(-2048);
      const reason = redact(message).slice(0, 2048);
      finish(() => reject(new Error(`${reason}${diagnostic ? ` Stderr: ${diagnostic}` : ''}`)));
    };
    const addBytes = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        fail('MCP probe exceeded the bounded output limit.');
        return false;
      }
      return true;
    };
    const call = (method, params) => new Promise((resolveCall, rejectCall) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`MCP ${method} timed out.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`);
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (addBytes(chunk)) stderr += chunk;
    });
    child.stdin.on('error', (error) => fail(`MCP stdin failed: ${error.code ?? error.message}`));
    child.stdout.on('data', (chunk) => {
      if (!addBytes(chunk)) return;
      buffer += chunk;
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail('MCP server returned invalid JSON.');
          return;
        }
        if (message.id === undefined || !pending.has(message.id)) continue;
        const request = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`MCP error: ${message.error.message ?? 'unknown error'}`));
        else request.resolve(message.result);
      }
    });
    child.on('error', (error) => fail(`Could not start MCP server: ${error.message}`));
    child.on('close', (code, signal) => {
      closed = true;
      if (!settled) fail(`MCP server exited before the probe completed (code ${code}, signal ${signal ?? 'none'}).`);
    });

    const overallTimer = setTimeout(() => fail('MCP probe timed out.'), timeoutMs * 3);

    (async () => {
      try {
        const initialize = await call('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'deerflow-native-guild-doctor', version: '0.1.0' },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const tools = [];
        const cursors = new Set();
        let cursor;
        do {
          const listed = await call('tools/list', cursor ? { cursor } : {});
          if (!Array.isArray(listed?.tools)) throw new Error('MCP tools/list returned an invalid catalog.');
          tools.push(...listed.tools);
          cursor = listed.nextCursor;
          if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 100)) {
            throw new Error('MCP tools/list returned invalid or unbounded pagination.');
          }
          if (cursor) cursors.add(cursor);
        } while (cursor);
        finish(() => resolve({ initialize, tools }));
      } catch (error) {
        fail(error.message);
      }
    })();
  });
}
