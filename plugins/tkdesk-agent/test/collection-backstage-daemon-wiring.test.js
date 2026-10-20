import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const daemonSource = await readFile(new URL("../daemon/server.js", import.meta.url), "utf8");

function sourceBlock(startMarker, endMarker) {
  const start = daemonSource.indexOf(startMarker);
  const end = daemonSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return daemonSource.slice(start, end);
}

test("full-auto start and resume preflight after backstage auth and before executeRun", () => {
  assert.match(
    daemonSource,
    /import\s*\{[^}]*inspectCollectionBackstageStartup[^}]*\}\s*from\s*"\.\.\/mcp\/adapters\/collection-backstage\.js"/s
  );
  const startRun = sourceBlock("async function startRun(runId)", "function publicQueueSweepState");
  const backstageAuthentication = startRun.indexOf(
    'const backstageLogin = await inspectSession("collection_backstage")'
  );
  const preflight = startRun.indexOf("await requireCollectionBackstagePreflight({");
  const execute = startRun.indexOf("control.promise = executeRun(runId, control)");
  assert.ok(backstageAuthentication >= 0);
  assert.ok(preflight > backstageAuthentication);
  assert.ok(execute > preflight);
  assert.match(startRun.slice(preflight, execute), /runId[\s\S]*sessionAuthenticated:\s*true/);
});

test("qualification preflight precedes policy usage and batch reservation", () => {
  const qualification = sourceBlock(
    "async function performQualificationBatch({",
    "async function checkCandidateQualifications("
  );
  const preflight = qualification.indexOf("await requireCollectionBackstagePreflight({");
  const policyUsage = qualification.indexOf("ensureQualificationPolicyState()");
  const reservation = qualification.indexOf("reservation = database.reserveQualificationBatch({");
  const attemptedAudit = qualification.indexOf('action: "qualification_request_attempted"');
  assert.ok(preflight >= 0);
  assert.ok(policyUsage > preflight);
  assert.ok(reservation > preflight);
  assert.ok(attemptedAudit > reservation);
});

test("collection preflight checks qualification compatibility before reserving a batch", () => {
  const preflight = sourceBlock(
    "async function requireCollectionBackstagePreflight({",
    "async function readSession(target)"
  );
  assert.match(preflight, /inspectCollectionBackstageCompatibility\(/);
  assert.match(preflight, /qualificationAdapterReady/);
  assert.match(preflight, /failureStage/);
  assert.match(preflight, /verificationExportShape/);
  assert.match(preflight, /verificationPresentationReady/);
  const qualification = sourceBlock(
    "async function performQualificationBatch({",
    "async function checkCandidateQualifications("
  );
  assert.ok(qualification.indexOf("await requireCollectionBackstagePreflight({")
    < qualification.indexOf("reservation = database.reserveQualificationBatch({"));
});

test("preflight persistence is a fixed safe checkpoint and audit projection", () => {
  const persistence = sourceBlock(
    "function persistCollectionBackstagePreflight({",
    "async function requireCollectionBackstagePreflight({"
  );
  assert.match(persistence, /database\.saveCheckpoint\(/);
  assert.match(persistence, /collection_backstage_preflight_checked/);

  const preflight = sourceBlock(
    "async function requireCollectionBackstagePreflight({",
    "async function readSession(target)"
  );
  for (const safeField of [
    "expectedMarketRegion",
    "observedMarketRegion",
    "regionMatched",
    "accountAvailable",
    "accountIdentityPresent",
    "unionIdentityPresent",
    "appIdentityPresent",
    "qualificationRequestConsumed",
    "routeFingerprint"
  ]) {
    assert.match(preflight, new RegExp(`\\b${safeField}\\b`));
  }
  assert.doesNotMatch(preflight, /\.email\b|\.id\b|\.appId\b|rawResponse|response\.data/);
});

test("regional ranking rejects liveTag and qualificationStatuses while generic filters retain them", () => {
  const regionalFilters = sourceBlock(
    "const REGIONAL_DISCOVERY_FILTERS = new Set([",
    "const DISCOVERY_FILTERS = new Set(["
  );
  assert.doesNotMatch(regionalFilters, /"liveTag"|"qualificationStatuses"/);
  const genericFilters = sourceBlock(
    "const DISCOVERY_FILTERS = new Set([",
    "const secret = crypto.randomBytes"
  );
  assert.match(genericFilters, /"liveTag"/);
  assert.match(genericFilters, /"qualificationStatuses"/);
});
