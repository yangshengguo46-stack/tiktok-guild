import assert from "node:assert/strict";
import test from "node:test";
import { originalCountryCatalog } from "../mcp/core/original-country-config.js";
import { selectedOriginalCountryLanes, runOriginalCollectorWithSessions, originalCollectorFailureState } from "../mcp/core/original-collector-settings.js";

test("safe collector boundaries retain actionable login and paused state", () => {
  assert.equal(originalCollectorFailureState("feed_authentication_required"), "authentication_required");
  assert.equal(originalCollectorFailureState("enrichment_authentication_required"), "authentication_required");
  for (const code of ["feed_route_country_mismatch", "enrichment_session_run_closed", "feed_session_unavailable", "backend_quota_limit"]) assert.equal(originalCollectorFailureState(code), "paused");
  assert.equal(originalCollectorFailureState("feed_transport_failed"), null);
});

test("all original country/display selections survive high-level settings", () => {
  let rows = 0;
  for (const group of originalCountryCatalog().configurations) {
    for (const variant of group.displayVariants) {
      for (const countryCode of variant.selectionCountryCodes) {
        const route = { collectionLanes: [{ workId: 1, countryCode, proxyExitCountry: countryCode }] };
        const filters = { marketRegion: group.routeCode, countryCodes: [countryCode], countryDisplayNames: [{ countryCode, displayName: variant.displayName }] };
        assert.equal(selectedOriginalCountryLanes({ route, filters })[0].displayName, variant.displayName);
        rows += 1;
      }
    }
  }
  assert.ok(rows >= 147);
});

test("display settings reject unrelated, duplicate and arbitrary variants", () => {
  const route = { collectionLanes: [{ workId: 1, countryCode: "SA", proxyExitCountry: "SA" }] };
  const filters = { marketRegion: "MENA", countryCodes: ["SA"] };
  for (const countryDisplayNames of [
    [{ countryCode: "SA", displayName: "US(美国)" }],
    [{ countryCode: "QA", displayName: "MENA(中东)" }],
    [{ countryCode: "SA", displayName: "https://arbitrary.invalid" }],
    [{ countryCode: "SA", displayName: "MENA(中东)" }, { countryCode: "SA", displayName: "MENA(中东)" }]
  ]) assert.throws(() => selectedOriginalCountryLanes({ route, filters: { ...filters, countryDisplayNames } }), { code: "collection_display_variant_invalid" });
});

test("worker session scope closes on successful, failed and cancelled engine exits", async () => {
  const ids = [];
  for (const outcome of ["success", "failed", "cancelled"]) {
    const calls = [];
    const sessions = {
      beginCountryWorkerRun: id => { ids.push(id); calls.push("begin"); },
      endCountryWorkerRun: async id => { assert.equal(id, ids.at(-1)); calls.push("end"); }
    };
    const engine = async options => {
      assert.equal(options.runId, "same-durable-run");
      calls.push("engine");
      if (outcome === "failed") throw new Error("engine failed");
      return { status: outcome };
    };
    const execution = runOriginalCollectorWithSessions({ sessions, collector: engine, runId: "same-durable-run" });
    if (outcome === "failed") await assert.rejects(execution, /engine failed/);
    else assert.equal((await execution).status, outcome);
    assert.deepEqual(calls, ["begin", "engine", "end"]);
  }
  assert.equal(new Set(ids).size, 3, "resuming a durable run must use a fresh execution lease identity");
});
