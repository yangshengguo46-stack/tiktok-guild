#!/usr/bin/env node

const [{ createBrokerComposition }, { createBrokerHandlers }, { createBrokerRouter }] = await Promise.all([
  import("./composition.mjs"),
  import("./handlers.mjs"),
  import("./router.mjs"),
]);

const profileDir = process.env.TIKTOK_BROKER_PROFILE_DIR?.trim();
const accountRef = process.env.TIKTOK_BROKER_ACCOUNT_REF?.trim();
const identityText = process.env.TIKTOK_BROKER_IDENTITY_TEXT?.trim();
let composition;
if (profileDir && accountRef && identityText) {
  composition = createBrokerComposition({ profileDir, accountRef, identityText });
} else {
  const { GuildError } = await import("./errors.mjs");
  const sessionOwner = {
    getStatus: () => ({ state: "unconfigured", visible: false }),
    async ensureActive() {
      throw new GuildError("session_owner_unverified", "Broker profile is not configured for this process.");
    },
    async close() {},
  };
  composition = {
    sessionOwner,
    brokerAccountRef: null,
    brokerIdentityText: null,
    resolveMessagingSession: () => null,
    resolveMessagingIdentity: () => null,
    liveReader: async () => { throw new GuildError("session_owner_unverified", "Broker profile is not configured for this process."); },
  };
}
const handlers = createBrokerHandlers({ composition });
const route = createBrokerRouter({ handlers });

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
