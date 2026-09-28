import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeMcpServer } from '../src/process.mjs';

async function serverFixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guild-mcp-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'server.mjs');
  await writeFile(file, source, 'utf8');
  return { root, file };
}

test('MCP discovery surfaces bounded stderr when a request times out', async (t) => {
  const { file } = await serverFixture(t, `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', (line) => {
      const x = JSON.parse(line);
      if (x.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: x.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      }) + '\\n');
      if (x.method === 'tools/list') process.stderr.write('broker identity is unavailable\\n');
    });
  `);
  await assert.rejects(
    probeMcpServer({ command: process.execPath, args: [file], timeoutMs: 1000 }),
    /tools\/list timed out[\s\S]*broker identity is unavailable/u,
  );
});

test('MCP discovery does not leave a subprocess that ignores graceful shutdown', async (t) => {
  const { root, file } = await serverFixture(t, `
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    writeFileSync(process.argv[2], String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    createInterface({ input: process.stdin }).on('line', (line) => {
      const x = JSON.parse(line);
      if (x.id) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: x.id,
        result: x.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      }) + '\\n');
    });
  `);
  const pidPath = path.join(root, 'pid');
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await probeMcpServer({ command: process.execPath, args: [file, pidPath], timeoutMs: 1000 });
  pid = Number(await readFile(pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('MCP discovery rejects malformed tools results instead of reporting an empty catalog', async (t) => {
  const { file } = await serverFixture(t, `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', (line) => {
      const x = JSON.parse(line);
      if (x.id) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: x.id, result: {} }) + '\\n');
    });
  `);
  await assert.rejects(
    probeMcpServer({ command: process.execPath, args: [file], timeoutMs: 1000 }),
    /tools\/list.*invalid catalog/u,
  );
});

test('MCP discovery follows catalog pagination without dropping tools from later pages', async (t) => {
  const { file } = await serverFixture(t, `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', (line) => {
      const x = JSON.parse(line);
      if (!x.id) return;
      let result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
      if (x.method === 'tools/list') result = x.params.cursor
        ? { tools: [{ name: 'broker_messaging', inputSchema: { type: 'object' } }] }
        : { tools: [{ name: 'broker_workspace', inputSchema: { type: 'object' } }], nextCursor: 'page2' };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: x.id, result }) + '\\n');
    });
  `);
  const result = await probeMcpServer({ command: process.execPath, args: [file], timeoutMs: 1000 });
  assert.deepEqual(result.tools.map(({ name }) => name), ['broker_workspace', 'broker_messaging']);
});

test('MCP diagnostics redact environment credentials before bounding server errors', async (t) => {
  const { file } = await serverFixture(t, `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', (line) => {
      const x = JSON.parse(line);
      if (!x.id) return;
      process.stderr.write('credential=' + process.env.GUILD_API_TOKEN + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: x.id,
        error: { code: -32000, message: 'authentication failed: ' + process.env.GUILD_API_TOKEN }
      }) + '\\n');
    });
  `);
  await assert.rejects(probeMcpServer({ command: process.execPath, args: [file], timeoutMs: 1000,
    env: { ...process.env, GUILD_API_TOKEN: `credential-prefix-${'X'.repeat(3000)}-suffix` } }), (error) => {
      assert.match(error.message, /authentication failed.*\[redacted\]/u);
      assert.doesNotMatch(error.message, /credential-prefix|X{50}|-suffix/u);
      assert.ok(error.message.length < 4096);
      return true;
    });
});
