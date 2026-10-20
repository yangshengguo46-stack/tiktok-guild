import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DaemonClient } from "../mcp/core/daemon-client.js";
import { DatabaseStore } from "../mcp/core/database.js";
import { runtimePaths } from "../mcp/core/runtime-paths.js";

function semiAutoCandidate(handle, observedAt) {
  return {
    source: "tiktok_live",
    handle,
    observedAt,
    data: {
      workflowMode: "semi_auto",
      qualificationQueryState: "not_queried",
      automaticQualificationPerformed: false
    },
    observation: {
      source: "tiktok_live",
      observedAt,
      data: {
        workflowMode: "semi_auto",
        qualificationQueryState: "not_queried",
        automaticQualificationPerformed: false
      }
    }
  };
}

test("manual qualification import rolls back every qualification write when summary or audit fails, then retries", () => {
  for (const failure of [
    {
      stage: "run_summary",
      triggerName: "fail_manual_import_run_summary",
      createTrigger: `
        CREATE TEMP TRIGGER fail_manual_import_run_summary
        BEFORE UPDATE OF result_json ON collection_runs
        BEGIN
          SELECT RAISE(ABORT, 'injected manual import run summary failure');
        END;
      `,
      error: /injected manual import run summary failure/
    },
    {
      stage: "audit",
      triggerName: "fail_manual_import_audit",
      createTrigger: `
        CREATE TEMP TRIGGER fail_manual_import_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'manual_qualification_results_imported'
        BEGIN
          SELECT RAISE(ABORT, 'injected manual import audit failure');
        END;
      `,
      error: /injected manual import audit failure/
    }
  ]) {
    const store = new DatabaseStore(":memory:").init();
    try {
      const runId = crypto.randomUUID();
      store.createRun({
        runId,
        source: "tiktok_live",
        mode: "semi_auto",
        status: "completed",
        filters: { discoveryMethod: "regional_gift_ranking", countryCodes: ["SA"] }
      });
      const inserted = store.upsertProspect({
        runId,
        ...semiAutoCandidate("atomic.creator", "2026-08-23T03:00:00.000Z"),
        observation: {
          runId,
          ...semiAutoCandidate("atomic.creator", "2026-08-23T03:00:00.000Z").observation
        }
      });
      const importId = `manual-import:atomic:${failure.stage}`;
      const records = [{
        candidateId: inserted.prospect.candidateId,
        qualificationStatus: "available",
        observedAt: "2026-08-23T03:01:00.000Z",
        confidence: 1,
        data: {
          qualificationReason: {
            source: "collection_backstage_manual_import",
            importMode: "manual_import",
            provenance: "official_collection_backstage_user_query",
            anchorStatusCode: 0
          }
        },
        evidence: {
          importMode: "manual_import",
          officialManualQuery: true,
          automaticBackstageRequest: false,
          qualificationRequestConsumed: false,
          recursiveRankingExpansionTriggered: false
        }
      }];

      store.database.exec(failure.createTrigger);
      assert.throws(
        () => store.commitManualQualificationImport({
          importId,
          runId,
          records,
          reason: "fault injection must roll back the entire manual import"
        }),
        failure.error
      );
      assert.equal(store.database.prepare(`
        SELECT COUNT(*) AS count FROM prospect_observations
        WHERE run_id = ? AND source = 'collection_backstage'
      `).get(runId).count, 0);
      assert.equal(store.getProspect(inserted.prospect.candidateId).invitationEligibility, null);
      assert.equal(store.getRun(runId).result?.semiAutoManualQualification, undefined);
      assert.equal(store.listAuditEvents({ runId, limit: 10 }).length, 0);
      assert.equal(store.getQualificationUsage().hourlyUsed, 0);
      assert.equal(store.getQualificationUsage().dailyUsed, 0);

      store.database.exec(`DROP TRIGGER ${failure.triggerName}`);
      const retried = store.commitManualQualificationImport({
        importId,
        runId,
        records,
        reason: "retry the same atomic manual import after the injected failure"
      });
      assert.equal(retried.count, 1);
      assert.equal(retried.pendingCandidates, 0);
      assert.equal(retried.qualificationComplete, true);
      assert.deepEqual(retried.statusCounts, { available: 1 });
      assert.equal(store.database.prepare(`
        SELECT COUNT(*) AS count FROM prospect_observations
        WHERE run_id = ? AND source = 'collection_backstage'
      `).get(runId).count, 1);
      assert.equal(store.getProspect(inserted.prospect.candidateId).invitationEligibility, "available");
      assert.equal(store.getRun(runId).result.semiAutoManualQualification.creatorsClassified, 1);
      assert.equal(
        store.listAuditEvents({ runId, action: "manual_qualification_results_imported", limit: 10 }).length,
        1
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM qualification_batches").get().count,
        0
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM discovery_seed_queue").get().count,
        0
      );
      assert.equal(store.getQualificationUsage().hourlyUsed, 0);
      assert.equal(store.getQualificationUsage().dailyUsed, 0);
    } finally {
      store.close();
    }
  }
});

test("MCP imports official manual semi-auto qualification rows without requests, budget, or ranking replay", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-manual-import-"));
  const pluginRoot = process.cwd();
  const paths = runtimePaths(dataDirectory);
  const runId = crypto.randomUUID();
  const outsideRunId = crypto.randomUUID();
  const store = new DatabaseStore(paths.databasePath).init();
  store.createRun({
    runId,
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { discoveryMethod: "regional_gift_ranking", countryCodes: ["SA", "QA", "EG"] }
  });
  store.updateRun(runId, {
    status: "completed",
    result: {
      workflow: {
        workflowMode: "semi_auto",
        qualificationQueryState: "not_queried",
        automaticQualificationPerformed: false,
        recursiveRankingExpansionPerformed: false
      }
    }
  });
  for (const [handle, observedAt] of [
    ["Saudi.Creator", "2026-08-23T01:00:00.000Z"],
    ["qata_r.live", "2026-08-23T01:01:00.000Z"],
    ["egypt.creator", "2026-08-23T01:02:00.000Z"]
  ]) {
    store.upsertProspect({
      runId,
      ...semiAutoCandidate(handle, observedAt),
      observation: {
        runId,
        ...semiAutoCandidate(handle, observedAt).observation
      }
    });
  }
  store.createRun({
    runId: outsideRunId,
    source: "tiktok_live",
    mode: "semi_auto",
    filters: { discoveryMethod: "regional_gift_ranking", countryCodes: ["SA"] }
  });
  store.upsertProspect({
    runId: outsideRunId,
    ...semiAutoCandidate("outside.creator", "2026-08-23T01:03:00.000Z"),
    observation: {
      runId: outsideRunId,
      ...semiAutoCandidate("outside.creator", "2026-08-23T01:03:00.000Z").observation
    }
  });
  assert.equal(store.getQualificationUsage().hourlyUsed, 0);
  assert.equal(store.getQualificationUsage().dailyUsed, 0);
  store.close();

  const mcpConfig = JSON.parse(
    await readFile(path.join(pluginRoot, ".mcp.json"), "utf8")
  ).mcpServers.tkdesk;
  const transport = new StdioClientTransport({
    command: mcpConfig.command,
    args: mcpConfig.args,
    cwd: mcpConfig.cwd,
    env: {
      ...process.env,
      TKDESK_AGENT_DATA_DIR: dataDirectory,
      TKDESK_AGENT_SOURCE_ROOT: pluginRoot
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "tkdesk-manual-import-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    const daemon = new DaemonClient({ pluginRoot, dataDirectory });
    await daemon.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 34);
  const tool = listed.tools.find((entry) => entry.name === "check_candidate_qualifications");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.operation.enum, ["automatic_query", "manual_import"]);
  assert.equal(tool.inputSchema.properties.results.minItems, 1);
  assert.equal(tool.inputSchema.properties.results.maxItems, 30);
  assert.doesNotMatch(
    JSON.stringify(tool.inputSchema),
    /cookie|token|password|credential|proxy|header|selector|script|(?:^|["_])url(?:["_]|$)/i
  );

  const imported = await client.callTool({
    name: "check_candidate_qualifications",
    arguments: {
      operation: "manual_import",
      runId,
      observedAt: "2026-08-23T02:00:00.000Z",
      results: [{
        handle: "＠Ｓａｕｄｉ．Ｃｒｅａｔｏｒ",
        anchorStatusCode: 0,
        canUseInvitationTypeCodes: [3, 5]
      }, {
        handle: "@QATA_R.LIVE",
        anchorStatusCode: 3,
        displayReasonCode: 2,
        popupInvitationTypeCodes: [4]
      }],
      reason: "import two results manually queried in the official collection sub-backend"
    }
  });
  assert.equal(imported.isError, undefined);
  assert.equal(imported.structuredContent.operation, "manual_import");
  assert.equal(imported.structuredContent.imported, 2);
  assert.equal(imported.structuredContent.batchRequestsUsed, 0);
  assert.equal(imported.structuredContent.qualificationBudgetRequestsConsumed, 0);
  assert.equal(imported.structuredContent.automaticBackstageRequest, false);
  assert.equal(imported.structuredContent.automaticRetry, false);
  assert.equal(imported.structuredContent.recursiveRankingExpansionTriggered, false);
  assert.equal(imported.structuredContent.usageBefore.hourlyUsed, 0);
  assert.equal(imported.structuredContent.usageAfter.hourlyUsed, 0);
  assert.deepEqual(imported.structuredContent.statusCounts, { available: 1, ineligible: 1 });

  const queried = await client.callTool({
    name: "query_candidates",
    arguments: { runId, limit: 10, reason: "verify manual qualification import persistence" }
  });
  assert.equal(queried.isError, undefined);
  const byHandle = new Map(queried.structuredContent.candidates.map((row) => [row.handle, row]));
  assert.equal(byHandle.get("Saudi.Creator").qualificationStatus, "available");
  assert.equal(byHandle.get("Saudi.Creator").qualificationQueryState, "manual_imported");
  assert.equal(byHandle.get("Saudi.Creator").automaticQualificationPerformed, false);
  assert.equal(byHandle.get("Saudi.Creator").qualificationReason.anchorStatusCode, 0);
  assert.deepEqual(byHandle.get("Saudi.Creator").qualificationReason.canUseInvitationTypeCodes, [3, 5]);
  assert.equal(
    byHandle.get("Saudi.Creator").qualificationProvenance,
    "official_collection_backstage_user_query"
  );
  assert.equal(byHandle.get("qata_r.live").qualificationStatus, "ineligible");
  assert.equal(byHandle.get("qata_r.live").qualificationReason.displayReasonCode, 2);
  assert.equal(byHandle.get("egypt.creator").qualificationStatus, null);
  assert.equal(byHandle.get("egypt.creator").qualificationQueryState, "not_queried");

  const duplicate = await client.callTool({
    name: "check_candidate_qualifications",
    arguments: {
      operation: "manual_import",
      runId,
      results: [{ handle: "saudi.creator", anchorStatusCode: 2 }],
      reason: "duplicate result must be rejected without overwrite"
    }
  });
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.code, "manual_qualification_identity_mismatch");

  const mixedUnknown = await client.callTool({
    name: "check_candidate_qualifications",
    arguments: {
      operation: "manual_import",
      runId,
      results: [
        { handle: "egypt.creator", anchorStatusCode: 0 },
        { handle: "outside.creator", anchorStatusCode: 0 }
      ],
      reason: "cross-run identity must fail the whole import atomically"
    }
  });
  assert.equal(mixedUnknown.isError, true);
  assert.equal(mixedUnknown.structuredContent.code, "manual_qualification_identity_mismatch");

  const automaticSemiAuto = await client.callTool({
    name: "check_candidate_qualifications",
    arguments: {
      operation: "automatic_query",
      runId,
      limit: 1,
      reason: "automatic query must stay disabled for original semi auto"
    }
  });
  assert.equal(automaticSemiAuto.isError, true);
  assert.equal(automaticSemiAuto.structuredContent.code, "semi_auto_automatic_qualification_forbidden");

  const verifier = new DatabaseStore(paths.databasePath).init();
  assert.equal(
    verifier.database.prepare("SELECT COUNT(*) AS count FROM qualification_batches").get().count,
    0
  );
  assert.equal(
    verifier.database.prepare(`
      SELECT COUNT(*) AS count FROM prospect_observations
      WHERE run_id = ? AND source = 'collection_backstage'
    `).get(runId).count,
    2
  );
  assert.equal(
    verifier.database.prepare("SELECT COUNT(*) AS count FROM discovery_seed_queue").get().count,
    0
  );
  const persistedRows = verifier.database.prepare(`
    SELECT data_json, evidence_json FROM prospect_observations
    WHERE run_id = ? AND source = 'collection_backstage'
    ORDER BY observation_id
  `).all(runId).map((row) => ({
    data: JSON.parse(row.data_json),
    evidence: JSON.parse(row.evidence_json)
  }));
  assert.equal(persistedRows[0].data.qualificationReason.importMode, "manual_import");
  assert.equal(
    persistedRows[0].data.qualificationReason.provenance,
    "official_collection_backstage_user_query"
  );
  assert.equal(persistedRows[0].evidence.automaticBackstageRequest, false);
  assert.equal(persistedRows[0].evidence.qualificationRequestConsumed, false);
  assert.equal(persistedRows[0].evidence.recursiveRankingExpansionTriggered, false);
  assert.equal(verifier.getQualificationUsage().hourlyUsed, 0);
  assert.equal(verifier.getQualificationUsage().dailyUsed, 0);
  const storedRun = verifier.getRun(runId);
  assert.equal(storedRun.result.semiAutoManualQualification.creatorsClassified, 2);
  assert.equal(storedRun.result.semiAutoManualQualification.pendingCandidates, 1);
  assert.equal(storedRun.result.semiAutoManualQualification.qualificationBudgetRequestsConsumed, 0);
  assert.equal(storedRun.result.semiAutoManualQualification.recursiveRankingExpansionTriggered, false);
  const auditRows = verifier.listAuditEvents({ runId, limit: 100 });
  assert.equal(auditRows.some((event) => event.action === "manual_qualification_results_imported"), true);
  verifier.close();
});
