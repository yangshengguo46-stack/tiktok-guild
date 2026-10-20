#!/usr/bin/env node

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHandlers } from "./handlers.mjs";
import { readView } from "./live/read-view.mjs";
import { getView } from "./live/view-registry.mjs";
import { createRouter } from "./router.mjs";
import { createSessionOwner } from "./session/session-owner.mjs";

async function productionComposition() {
  const launchPersistentContext = async (profileDir, options) => {
    const { chromium } = await import("playwright");
    return chromium.launchPersistentContext(profileDir, options);
  };
  const sessionOwner = createSessionOwner({ launchPersistentContext });
  return {
    sessionOwner,
    senderAccountRef: process.env.TIKTOK_GUILD_SENDER_ACCOUNT_REF?.trim() || null,
    senderIdentityText: process.env.TIKTOK_GUILD_SENDER_IDENTITY_TEXT?.trim() || null,
    liveReader: ({ page, domain, child, params, clock }) => readView({
      page,
      view: getView(domain, child),
      params,
      clock
    })
  };
}

async function selectComposition() {
  const configured = process.env.TIKTOK_GUILD_TEST_DRIVER;
  if (configured === undefined) return productionComposition();
  if (process.env.NODE_ENV !== "test") throw new TypeError("Test composition is forbidden outside NODE_ENV=test.");
  const expected = fileURLToPath(new URL("../test/fixtures/acceptance-driver.mjs", import.meta.url));
  const resolved = path.resolve(configured);
  if (!path.isAbsolute(configured) || resolved !== expected) throw new TypeError("Untrusted test composition path.");
  const [stats, actual] = await Promise.all([lstat(resolved), realpath(resolved)]);
  if (!stats.isFile() || stats.isSymbolicLink() || actual !== expected) {
    throw new TypeError("Untrusted test composition file.");
  }
  const fixture = await import(new URL("../test/fixtures/acceptance-driver.mjs", import.meta.url));
  if (typeof fixture.createAcceptanceComposition !== "function") {
    throw new TypeError("Test composition factory is unavailable.");
  }
  return fixture.createAcceptanceComposition();
}

const composition = await selectComposition();
const handlers = createHandlers(composition);
const route = createRouter({ handlers });

function send(message) {
  if (message !== null) process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    void Promise.resolve()
      .then(() => route(JSON.parse(line)))
      .then(send)
      .catch(() => send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }));
  }
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await composition.sessionOwner.close?.();
}
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.stdin.once("end", () => { void close(); });
