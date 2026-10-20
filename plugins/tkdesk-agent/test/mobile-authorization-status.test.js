import assert from "node:assert/strict";
import test from "node:test";
import { projectMobileAuthorizationRuntime } from "../mcp/core/mobile-authorization-status.js";
const configured = { state: "ready", usable: true };
const observation = state => ({ state, reason: state === "rejected" ? "http_403" : null,
  observedAt: state === "unknown" ? null : "2026-09-28T00:00:00.000Z", verificationScope: "fixed_endpoint_authorization", persistsAcrossRestart: false });
test("configuration ready without online observations is unknown and permits the first read", () => {
  const result = projectMobileAuthorizationRuntime(configured);
  assert.equal(result.configurationState, "ready"); assert.equal(result.state, "ready");
  assert.equal(result.usable, true); assert.equal(result.onlineVerified, false); assert.equal(result.onlineAuthorization.state, "unknown");
});
test("public default mobile status exposes a rejected configured host while preserving configuration state", () => {
  const result = projectMobileAuthorizationRuntime(configured, [observation("unknown"), observation("rejected")]);
  assert.equal(result.configurationState, "ready"); assert.equal(result.state, "upstream_rejected"); assert.equal(result.usable, false);
  assert.equal(result.onlineAuthorization.reason, "http_403"); assert.equal(result.onlineVerified, false);
});
test("online readiness requires accepted authorization for every configured host", () => {
  assert.equal(projectMobileAuthorizationRuntime(configured, [observation("verified"), observation("unknown")]).onlineVerified, false);
  assert.equal(projectMobileAuthorizationRuntime(configured, [observation("verified")]).onlineVerified, true);
  assert.equal(projectMobileAuthorizationRuntime({ state: "expired", usable: false }, [observation("verified")]).onlineVerified, false);
});
