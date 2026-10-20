import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DaemonClient, isTransportRetryAllowed } from "../mcp/core/daemon-client.js";
import { DAEMON_VERSION, PROTOCOL_VERSION } from "../mcp/core/runtime-paths.js";

test("qualification RPC is never replayed after a transport failure", () => {
  assert.equal(isTransportRetryAllowed("check_candidate_qualifications"), false);
  assert.equal(isTransportRetryAllowed("create_discovery_run"), false);
  assert.equal(isTransportRetryAllowed("configure_collection_route"), false);
  assert.equal(isTransportRetryAllowed("verify_collection_route"), false);
  assert.equal(isTransportRetryAllowed("start_run"), false);
  assert.equal(isTransportRetryAllowed("initialize_collection_backstage"), false);
  assert.equal(isTransportRetryAllowed("prepare_discovery_live"), false);
  assert.equal(isTransportRetryAllowed("resume_run"), false);
  assert.equal(isTransportRetryAllowed("collection_backstage_preflight"), false);
  assert.equal(isTransportRetryAllowed("clear_mobile_authorization"), false);
  assert.equal(isTransportRetryAllowed("research_candidate"), false);
  assert.equal(isTransportRetryAllowed("creator_research_status"), true);
  assert.equal(isTransportRetryAllowed("status"), true);
  assert.equal(isTransportRetryAllowed("core_configuration_status"), true);
  assert.equal(isTransportRetryAllowed("mobile_authorization_status"), true);
});

test("qualification transport failure reaches the daemon at most once", async () => {
  let qualificationCalls = 0;
  const pluginVersion = "transport-retry-test";
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.method === "ping") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          result: { protocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION, pluginVersion }
        }));
        return;
      }
      if (body.method === "check_candidate_qualifications") {
        qualificationCalls += 1;
        request.socket.destroy();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory: process.cwd() });
    client.pluginVersion = pluginVersion;
    client.state = { port: address.port, secret: "test-secret" };
    await assert.rejects(
      client.call("check_candidate_qualifications", { runId: "test" }, 2_000),
      (error) => error.code === "ECONNRESET" || error.code === "EPIPE"
    );
    assert.equal(qualificationCalls, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
