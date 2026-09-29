#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPublicOutreachRouter } from './router.mjs';

function adapterSpecifier() {
  return process.env.DEERFLOW_OUTREACH_ADAPTER?.trim() || './native-adapter.mjs';
}

async function loadNativeAdapter() {
  const specifier = adapterSpecifier();
  if (!specifier) {
    return {
      configured: false,
      adapter: null,
      configurationError: new Error('Public outreach operator is not configured.'),
    };
  }
  try {
    const resolved = path.isAbsolute(specifier)
      ? pathToFileURL(specifier).href
      : specifier;
    const imported = await import(resolved);
    const factory = imported.createDeerflowOutreachAdapter ?? imported.default;
    if (typeof factory !== 'function') {
      throw new Error('Native DeerFlow adapter must export createDeerflowOutreachAdapter().');
    }
    const adapter = await factory({
      ownerUserId: process.env.DEERFLOW_OUTREACH_OWNER_USER_ID?.trim() || null,
    });
    if (!adapter || typeof adapter !== 'object') {
      throw new Error('Native DeerFlow adapter did not return an object.');
    }
    return { configured: true, adapter, configurationError: null };
  } catch {
    return {
      configured: false,
      adapter: null,
      configurationError: new Error('Public outreach operator configuration could not be loaded.'),
    };
  }
}

function send(message) {
  if (message !== null) process.stdout.write(`${JSON.stringify(message)}\n`);
}

const { configured, adapter, configurationError } = await loadNativeAdapter();
const route = createPublicOutreachRouter({ adapter, configured, configurationError });
let buffer = '';
let closing = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    void Promise.resolve()
      .then(() => route(JSON.parse(line)))
      .then(send)
      .catch(() => send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error.' },
      }));
  }
});

async function close() {
  if (closing) return;
  closing = true;
  await adapter?.close?.();
}

process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.stdin.once('end', () => { void close(); });
