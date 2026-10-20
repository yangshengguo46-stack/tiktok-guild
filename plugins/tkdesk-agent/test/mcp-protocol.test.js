import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DaemonClient } from "../mcp/core/daemon-client.js";
import { fingerprintDiscoverySessionRoute } from "../mcp/core/route-policy.js";

function isProxyDerivedFingerprintKey(key) {
  const normalized = String(key ?? "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return normalized.endsWith("route_fingerprint")
    || normalized.endsWith("route_fingerprints")
    || normalized.endsWith("proxy_fingerprint")
    || normalized.endsWith("configuration_fingerprint");
}

function proxyDerivedFingerprintPaths(value, path = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => proxyDerivedFingerprintPaths(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (isProxyDerivedFingerprintKey(key)) found.push(`${path}.${key}`);
    proxyDerivedFingerprintPaths(nested, `${path}.${key}`, found);
  }
  return found;
}

function assertNoProxyDerivedFingerprints(value) {
  assert.deepEqual(proxyDerivedFingerprintPaths(value), []);
}

test("MCP exposes durable discovery tools through the shared daemon", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-agent-mcp-"));
  const pluginRoot = process.cwd();
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
  const client = new Client({ name: "tkdesk-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    const daemon = new DaemonClient({ pluginRoot, dataDirectory });
    await daemon.call("shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dataDirectory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  const exactHighLevelToolAllowlist = [
    "status", "core_configuration_status", "original_country_catalog", "mobile_authorization_status",
    "clear_mobile_authorization", "session_status", "start_login", "check_login", "reopen_login",
    "reset_session",
    "configure_collection_route", "verify_collection_route", "collection_route_status",
    "collection_backstage_preflight", "initialize_collection_backstage", "prepare_discovery_live",
    "create_discovery_run", "start_run", "pause_run", "resume_run", "cancel_run",
    "get_run", "list_runs", "preview_collection_cleanup", "commit_collection_cleanup",
    "preview_candidates", "query_candidates", "get_handoff", "creator_research_status", "research_candidate",
    "check_candidate_qualifications", "prepare_handoff", "commit_handoff", "audit_events"
  ];
  assert.equal(exactHighLevelToolAllowlist.length, 34);
  assert.deepEqual(
    [...names].sort(),
    [...exactHighLevelToolAllowlist].sort(),
    "MCP must expose exactly the reviewed high-level business allowlist"
  );
  const researchStatus = await client.callTool({ name: "creator_research_status", arguments: {} });
  assert.equal(researchStatus.structuredContent.configured, false);
  assert.equal(researchStatus.structuredContent.coreUsable, true);
  const researchMissing = await client.callTool({ name: "research_candidate", arguments: {
    candidateId: "00000000-0000-4000-8000-000000000000", reason: "User requested optional creator research"
  } });
  assert.equal(researchMissing.structuredContent.coreUsable, true);
  assert.equal(researchMissing.structuredContent.paidRequests, 0);
  const paidWithoutId = await client.callTool({ name: "research_candidate", arguments: {
    candidateId: "00000000-0000-4000-8000-000000000000", allowPaid: true, reason: "User requested optional creator research"
  } });
  assert.equal(paidWithoutId.isError, true);
  const arbitraryPrimitiveName = /(?:^|_)(?:navigate|click|evaluate|fetch|http|request|script|selector|cookie|token|message|invite|publish|captcha)(?:_|$)/i;
  assert.deepEqual(
    names.filter((name) => arbitraryPrimitiveName.test(name)),
    [],
    "MCP must not expose arbitrary browser, network, script, credential, outreach, or CAPTCHA primitives"
  );
  for (const toolName of [
    "core_configuration_status",
    "original_country_catalog",
    "mobile_authorization_status",
    "clear_mobile_authorization"
  ]) {
    const tool = listed.tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `missing MCP tool schema ${toolName}`);
    assert.doesNotMatch(
      JSON.stringify(tool.inputSchema?.properties ?? {}),
      /token|cookie|header|secret|password|credential/i,
      `${toolName} must not accept secret-shaped input`
    );
  }
  for (const toolName of ["initialize_collection_backstage", "prepare_discovery_live"]) {
    const tool = listed.tools.find(candidate => candidate.name === toolName);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema.properties), /cookie|token|url|selector|script|handle/i);
    const invalid = await client.callTool({name:toolName, arguments:{handle:"realcreator"}});
    assert.equal(invalid.isError,true);
    const missingRoute = await client.callTool({name:toolName, arguments:{}});
    assert.equal(missingRoute.isError,true);
  }
  const configureRouteTool = listed.tools.find((tool) => tool.name === "configure_collection_route");
  assert.equal(configureRouteTool.inputSchema.required.includes("discoveryCountry"), true);
  assert.equal(configureRouteTool.inputSchema.required.includes("discoveryProxyServer"), true);
  assert.equal(configureRouteTool.inputSchema.required.includes("collectionLanes"), true);
  assert.equal(configureRouteTool.inputSchema.properties.collectionLanes.minItems, 1);
  assert.equal(configureRouteTool.inputSchema.properties.collectionLanes.maxItems, 3);
  assert.deepEqual(
    configureRouteTool.inputSchema.properties.collectionLanes.items.required.sort(),
    ["countryCode", "proxyServer"]
  );
  assert.equal(configureRouteTool.inputSchema.properties.collectionProxyServers, undefined);
  assert.equal(configureRouteTool.inputSchema.properties.collectionProxyServer, undefined);
  assert.equal(configureRouteTool.inputSchema.properties.routeCountry, undefined);
  assert.equal(configureRouteTool.inputSchema.properties.backstageCountry, undefined);
  assert.equal(configureRouteTool.inputSchema.properties.proxyServer, undefined);
  const reopenLoginTool = listed.tools.find((tool) => tool.name === "reopen_login");
  assert.deepEqual(
    [...reopenLoginTool.inputSchema.required].sort(),
    ["target", "userConfirmed"].sort()
  );
  assert.equal(reopenLoginTool.inputSchema.properties.target.const, "collection_backstage");
  assert.equal(reopenLoginTool.inputSchema.properties.userConfirmed.const, true);
  assert.equal(reopenLoginTool.inputSchema.properties.proxyServer, undefined);
  assert.equal(reopenLoginTool.inputSchema.properties.url, undefined);
  const backstagePreflightTool = listed.tools.find(
    (tool) => tool.name === "collection_backstage_preflight"
  );
  assert.deepEqual(
    Object.keys(backstagePreflightTool.inputSchema.properties),
    ["routeProfileId"]
  );
  assert.equal(backstagePreflightTool.inputSchema.properties.expectedMarketRegion, undefined);
  assert.doesNotMatch(
    JSON.stringify(backstagePreflightTool.inputSchema),
    /email|cookie|token|header|url|method|body|selector|script/i
  );
  const missingRoutePreflight = await client.callTool({
    name: "collection_backstage_preflight",
    arguments: {}
  });
  assert.equal(missingRoutePreflight.isError, true);
  assert.equal(missingRoutePreflight.structuredContent.code, "collection_route_required");
  const createRunTool = listed.tools.find((tool) => tool.name === "create_discovery_run");
  const startRunTool = listed.tools.find((tool) => tool.name === "start_run");
  assert.match(
    createRunTool.description,
    /real execution|真实.*请求|health check|健康检查/i,
    "creating a run must state that it is real execution, not a passive health check"
  );
  assert.match(
    startRunTool.description,
    /real execution|真实.*请求|health check|健康检查/i,
    "starting a run must state that it is real execution, not a passive health check"
  );
  assert.equal(createRunTool.inputSchema.properties.filters.properties.startUrl, undefined);
  assert.equal(createRunTool.inputSchema.properties.filters.properties.countryCodes.minItems, 1);
  assert.equal(createRunTool.inputSchema.properties.filters.properties.countryCodes.maxItems, 3);
  assert.notEqual(createRunTool.inputSchema.properties.filters.properties.countryCode, undefined);
  assert.equal(
    createRunTool.inputSchema.properties.filters.properties.highQualityMode.type,
    "boolean"
  );
  assert.equal(createRunTool.inputSchema.properties.filters.properties.maxPages.default, undefined);
  assert.equal(createRunTool.inputSchema.properties.filters.properties.maxScrolls.default, undefined);
  assert.deepEqual(createRunTool.inputSchema.properties.source.enum, ["tiktok_live", "svip_legacy"]);
  for (const obsoleteRankingField of [
    "rankingViewKind",
    "rankingPeriod",
    "rankingSubtab",
    "rankingMaxRooms",
    "rankingResponseWaitMs"
  ]) {
    assert.equal(
      createRunTool.inputSchema.properties.filters.properties[obsoleteRankingField],
      undefined,
      `create_discovery_run must not expose ${obsoleteRankingField}`
    );
  }
  const cleanupPreviewTool = listed.tools.find(
    (tool) => tool.name === "preview_collection_cleanup"
  );
  const cleanupCommitTool = listed.tools.find(
    (tool) => tool.name === "commit_collection_cleanup"
  );
  assert.deepEqual(cleanupPreviewTool.inputSchema.required, ["cutoff"]);
  assert.deepEqual(
    [...cleanupCommitTool.inputSchema.required].sort(),
    ["confirmationProof", "cutoff", "previewHash", "userConfirmed"].sort()
  );
  assert.match(cleanupCommitTool.description, /irreversibly/i);
  assert.equal(cleanupCommitTool.inputSchema.properties.userConfirmed.const, true);
  assert.equal(names.includes("scan_current_page"), false);

  const status = await client.callTool({ name: "status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.capabilities.sharedDaemon, true);
  assert.equal(status.structuredContent.capabilities.customDesktopUi, false);
  assert.equal(status.structuredContent.capabilities.sendsMessages, false);
  assert.equal(status.structuredContent.capabilities.qualification.collectionBackstage, true);
  assert.equal(status.structuredContent.capabilities.qualification.maximumCreatorsPerRequest, 30);
  assert.equal(status.structuredContent.capabilities.qualification.automaticRetry, false);
  assert.equal(status.structuredContent.capabilities.qualification.sendsInvitations, false);
  assert.equal(status.structuredContent.capabilities.modes.full_auto, false);
  assert.equal(status.structuredContent.capabilities.modes.full_autoCalibration, true);
  assert.equal(status.structuredContent.capabilities.modes.desiredDefault, "full_auto");
  assert.equal(status.structuredContent.capabilities.modes.default, "calibration_required");
  assert.equal(status.structuredContent.capabilities.discovery.default, "regional_gift_ranking");
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.ordinaryLiveCardsUsedAsFallback,
    false
  );
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.liveSampleValidated, false);
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.authorizationReady, false);
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.operationalReady, false);
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.adapterEvidenceVersion,
    "regional-ranking-request-semantics-v2"
  );
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.productionReady, false);
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.implemented, undefined);
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.codePresent, true);
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.codePresentCountries.includes("SA"),
    true
  );
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.codePresentCountries.includes("GB"),
    true
  );
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.liveValidated, false);
  assert.deepEqual(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.liveValidatedCountries,
    []
  );
  assert.deepEqual(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.operationalCountries,
    []
  );
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.countryFeedOperational,
    false
  );
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.rankingTransportImplemented,
    undefined
  );
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.rankingTransportCodePresent,
    true
  );
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.implementationStatus,
    "code_present_live_validation_required"
  );
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.requiresOfficialUiTriggeredResponse,
    false
  );
  assert.equal(status.structuredContent.capabilities.discovery.regionalGiftRanking.passiveCaptureOnly, false);
  assert.equal(
    status.structuredContent.capabilities.discovery.regionalGiftRanking.runtimeValidationRequiredPerEnvironment,
    true
  );
  assert.equal(status.structuredContent.capabilities.discovery.publicLiveCards.allowedInFullAuto, true);
  assert.equal(status.structuredContent.capabilities.discovery.publicLiveCards.automaticQualification, true);
  assert.equal(status.structuredContent.capabilities.discovery.publicLiveCards.rankingExpansion, false);
  assert.deepEqual(status.structuredContent.capabilities.qualification.hourlyTargetRange, [50, 55]);
  assert.equal(status.structuredContent.capabilities.qualification.oneHourWindowType, "rolling_60m");
  assert.equal(status.structuredContent.capabilities.qualification.hourlyHardLimit, 55);
  assert.deepEqual(status.structuredContent.capabilities.qualification.dailyTargetRange, [145, 150]);
  assert.equal(status.structuredContent.capabilities.qualification.dailyWindowType, "rolling_24h");
  assert.equal(status.structuredContent.capabilities.qualification.dailyHardLimit, 150);
  assert.equal(status.structuredContent.capabilities.businessPolicy.followerInvitationBoundary, 1_000_000);
  assert.equal(status.structuredContent.capabilities.businessPolicy.diamondsPerUsdEstimate, 100);
  assert.equal(status.structuredContent.capabilities.businessPolicy.explicitDiamondUnitRequired, true);
  assert.equal(
    status.structuredContent.capabilities.businessPolicy.platformCreatorDiamondCapBackendAuthoritative,
    true
  );
  assert.equal(status.structuredContent.capabilities.scope.operatesGuildBackend, false);
  assert.equal(status.structuredContent.capabilities.scope.creatorListDiscoveryOnly, true);

  let cleanupStatus = status;
  for (let attempt = 0; attempt < 30 && cleanupStatus.structuredContent.durableQueueSweep.running; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    cleanupStatus = await client.callTool({ name: "status", arguments: {} });
  }
  const cleanupCutoff = new Date(Date.now() - 1_000).toISOString();
  const cleanupPreview = await client.callTool({
    name: "preview_collection_cleanup",
    arguments: { cutoff: cleanupCutoff }
  });
  assert.equal(cleanupPreview.isError, undefined);
  assert.equal(cleanupPreview.structuredContent.cutoff, cleanupCutoff);
  assert.equal(cleanupPreview.structuredContent.commitRequired, true);
  assert.equal(cleanupPreview.structuredContent.irreversible, true);
  assert.match(cleanupPreview.structuredContent.previewHash, /^[a-f0-9]{64}$/);
  assert.match(cleanupPreview.structuredContent.confirmationProof, /^[a-f0-9]{64}$/);
  assert.equal(cleanupPreview.structuredContent.deleteCounts.sessions, 0);
  assert.equal(cleanupPreview.structuredContent.protectedCounts.sessions, 3);
  assert.equal(cleanupPreview.structuredContent.recoverability.recoverable, false);
  assert.equal(cleanupPreview.structuredContent.recoverability.backupCreated, false);

  const rejectedCleanup = await client.callTool({
    name: "commit_collection_cleanup",
    arguments: {
      cutoff: cleanupCutoff,
      previewHash: cleanupPreview.structuredContent.previewHash,
      confirmationProof: "0".repeat(64),
      userConfirmed: true
    }
  });
  assert.equal(rejectedCleanup.isError, true);
  assert.equal(
    rejectedCleanup.structuredContent.code,
    "collection_cleanup_confirmation_expired"
  );

  const committedCleanup = await client.callTool({
    name: "commit_collection_cleanup",
    arguments: {
      cutoff: cleanupCutoff,
      previewHash: cleanupPreview.structuredContent.previewHash,
      confirmationProof: cleanupPreview.structuredContent.confirmationProof,
      userConfirmed: true
    }
  });
  assert.equal(committedCleanup.isError, undefined);
  assert.equal(committedCleanup.structuredContent.committed, true);
  assert.equal(committedCleanup.structuredContent.cutoff, cleanupCutoff);
  assert.equal(committedCleanup.structuredContent.recoverability.recoverable, false);

  const replayedCleanup = await client.callTool({
    name: "commit_collection_cleanup",
    arguments: {
      cutoff: cleanupCutoff,
      previewHash: cleanupPreview.structuredContent.previewHash,
      confirmationProof: cleanupPreview.structuredContent.confirmationProof,
      userConfirmed: true
    }
  });
  assert.equal(replayedCleanup.isError, true);
  assert.equal(
    replayedCleanup.structuredContent.code,
    "collection_cleanup_confirmation_expired"
  );

  const coreStatus = await client.callTool({ name: "core_configuration_status", arguments: {} });
  assert.equal(coreStatus.isError, undefined);
  assert.equal(coreStatus.structuredContent.state, "uninitialized");
  assert.equal(coreStatus.structuredContent.countries.countryCodes.includes("EG"), true);
  assert.equal(coreStatus.structuredContent.countries.countryCodes.includes("GB"), true);
  assert.equal(coreStatus.structuredContent.countries.marketRegions.length, 27);
  assert.equal(coreStatus.structuredContent.countries.count, 147);
  assert.equal(coreStatus.structuredContent.mobileAccess.state, "missing");
  assert.equal(coreStatus.structuredContent.mobileAccess.usable, false);
  assert.equal(coreStatus.structuredContent.secretValuesExposed, false);
  assert.equal(coreStatus.structuredContent.supplierCredentialsCopied, false);

  const originalCatalog = await client.callTool({
    name: "original_country_catalog",
    arguments: { countryCode: "PR" }
  });
  assert.equal(originalCatalog.isError, undefined);
  assert.equal(originalCatalog.structuredContent.sourceRecordCount, 36);
  assert.deepEqual(originalCatalog.structuredContent.configurations.map(
    (configuration) => configuration.routeCode
  ), ["LATAM", "US"]);
  assert.equal(originalCatalog.structuredContent.secretValuesExposed, false);
  assert.equal(originalCatalog.structuredContent.compiledMobileProfileCountries.includes("GB"), true);
  assert.deepEqual(originalCatalog.structuredContent.liveValidatedMobileProfileCountries, []);
  assert.doesNotMatch(
    JSON.stringify(originalCatalog.structuredContent),
    /token|cookie|authorization|[?&](?:anchor_id|room_id)=/i
  );

  const mobileStatus = await client.callTool({ name: "mobile_authorization_status", arguments: {} });
  assert.equal(mobileStatus.isError, undefined);
  assert.equal(mobileStatus.structuredContent.state, "missing");
  assert.equal(mobileStatus.structuredContent.usable, false);
  assert.equal(mobileStatus.structuredContent.secretValuesExposed, false);

  const scopedMobileStatus = await client.callTool({
    name: "mobile_authorization_status",
    arguments: { marketRegion: "MENA", countryCode: "SA" }
  });
  assert.equal(scopedMobileStatus.isError, undefined);
  assert.equal(scopedMobileStatus.structuredContent.state, "missing");
  assert.equal(scopedMobileStatus.structuredContent.usable, false);

  const clearedMobileStatus = await client.callTool({
    name: "clear_mobile_authorization",
    arguments: { userConfirmed: true }
  });
  assert.equal(clearedMobileStatus.isError, undefined);
  assert.equal(clearedMobileStatus.structuredContent.cleared, true);
  assert.equal(clearedMobileStatus.structuredContent.state, "missing");
  assert.equal(status.structuredContent.capabilities.routePolicy.discoveryBrowserProfile, "tiktok_discovery");
  assert.equal(status.structuredContent.capabilities.routePolicy.discoveryBrowserCountry, "US");
  assert.equal(status.structuredContent.capabilities.routePolicy.discoveryProxyExitCountryRequired, "US");
  assert.equal(status.structuredContent.capabilities.routePolicy.collectionBackstageProfile, "collection_backstage");
  assert.equal(status.structuredContent.capabilities.routePolicy.collectionBackstageUsesFirstCountryLane, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.mainBrowserCountry, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.mainBrowserProfiles, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.mainProxyExitCountryRequired, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.oneProxyPerCountry, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.maxCollectionCountries, 3);
  assert.equal(status.structuredContent.capabilities.routePolicy.multiCountryLaneExtension, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.originalBinarySingleCountryThreeProxyRows, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.originalBinaryThreeProxyRows, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.originalBinaryRowsShareMarketRegion, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.originalBinaryRowsMaySelectDifferentMemberCountries, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.collectionLanesMustShareRouteCountry, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.workIdLaneAffinity, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.allConfiguredExitsReprobedBeforeRunAndBatch, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.qualificationUsesFirstCountryLane, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.qualificationUsesMainBrowser, undefined);
  assert.equal(status.structuredContent.capabilities.routePolicy.backstageMarketRegionExplicitlyConfigured, true);
  assert.equal(status.structuredContent.capabilities.routePolicy.backstageCountryMustBeExplicitlyConfirmed, undefined);

  const sessions = await client.callTool({ name: "session_status", arguments: {} });
  assertNoProxyDerivedFingerprints(sessions);
  assert.equal(sessions.structuredContent.tiktok_discovery.state, "stopped");
  assert.equal(sessions.structuredContent.collection_backstage.state, "stopped");
  assert.equal(sessions.structuredContent.svip_legacy.state, "stopped");

  const routeBefore = await client.callTool({ name: "collection_route_status", arguments: {} });
  assert.equal(routeBefore.structuredContent.configured, false);
  const missingCollectionLanes = await client.callTool({
    name: "configure_collection_route",
    arguments: {
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "EG"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:7891",
      activate: true,
      userConfirmed: true
    }
  });
  assert.equal(missingCollectionLanes.isError, true);
  const nonUsDiscoveryRoute = await client.callTool({
    name: "configure_collection_route",
    arguments: {
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "EG"],
      discoveryCountry: "CA",
      discoveryProxyServer: "http://127.0.0.1:7891",
      collectionLanes: [
        { countryCode: "SA", proxyServer: "http://127.0.0.1:7890" },
        { countryCode: "QA", proxyServer: "http://127.0.0.1:7892" },
        { countryCode: "EG", proxyServer: "http://127.0.0.1:7893" }
      ],
      activate: true,
      userConfirmed: true
    }
  });
  assert.equal(nonUsDiscoveryRoute.isError, true);
  const duplicateCountryLane = await client.callTool({
    name: "configure_collection_route",
    arguments: {
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "EG"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:7891",
      collectionLanes: [
        { countryCode: "SA", proxyServer: "http://127.0.0.1:7890" },
        { countryCode: "sa", proxyServer: "http://127.0.0.1:7892" }
      ],
      activate: true,
      userConfirmed: true
    }
  });
  assert.equal(duplicateCountryLane.isError, true);
  const configuredRoute = await client.callTool({
    name: "configure_collection_route",
    arguments: {
      marketRegion: "MENA",
      marketCountryCodes: ["SA", "QA", "EG"],
      discoveryCountry: "US",
      discoveryProxyServer: "http://127.0.0.1:7891",
      collectionLanes: [
        { countryCode: "SA", proxyServer: "http://127.0.0.1:7890" },
        { countryCode: "QA", proxyServer: "http://127.0.0.1:7892" },
        { countryCode: "EG", proxyServer: "http://127.0.0.1:7893" }
      ],
      activate: true,
      userConfirmed: true
    }
  });
  assert.equal(configuredRoute.isError, undefined);
  assert.equal(configuredRoute.structuredContent.route.marketRegion, "MENA");
  assert.equal(configuredRoute.structuredContent.route.discoveryCountry, "US");
  assert.equal(configuredRoute.structuredContent.route.discoveryProxyExitCountry, null);
  assert.deepEqual(configuredRoute.structuredContent.route.collectionProxyExitCountries, [null, null, null]);
  assert.equal(configuredRoute.structuredContent.route.collectionProxyLaneCount, 3);
  assert.equal(configuredRoute.structuredContent.route.collectionProxyLaneMode, "country_lanes");
  assert.deepEqual(configuredRoute.structuredContent.route.collectionLanes.map((lane) => lane.workId), [1, 2, 3]);
  assert.deepEqual(
    configuredRoute.structuredContent.route.collectionLanes.map((lane) => lane.countryCode),
    ["SA", "QA", "EG"]
  );
  assert.equal(configuredRoute.structuredContent.route.discoveryProxyServer, undefined);
  assert.equal(configuredRoute.structuredContent.route.collectionProxyServer, undefined);
  assert.equal(configuredRoute.structuredContent.route.proxyServer, undefined);
  assertNoProxyDerivedFingerprints(configuredRoute);
  const enumerableDiscoveryFingerprint = fingerprintDiscoverySessionRoute({
    discoveryCountry: "US",
    discoveryProxyServer: "http://127.0.0.1:7891"
  });
  assert.equal(JSON.stringify(configuredRoute).includes(enumerableDiscoveryFingerprint), false);
  assert.equal(JSON.stringify(configuredRoute).includes("127.0.0.1"), false);
  assert.equal(/7890|7892|7893/.test(JSON.stringify(configuredRoute)), false);
  assert.equal(JSON.stringify(configuredRoute).includes("7891"), false);
  assert.equal(configuredRoute.structuredContent.verificationRequired, true);
  const routeAfter = await client.callTool({
    name: "collection_route_status",
    arguments: { routeProfileId: configuredRoute.structuredContent.route.routeProfileId }
  });
  assert.equal(routeAfter.structuredContent.configured, true);
  assert.equal(routeAfter.structuredContent.verified, false);
  assert.equal(JSON.stringify(routeAfter).includes("127.0.0.1"), false);
  assert.equal(routeAfter.structuredContent.sessions.tiktok_discovery.expectedRouteCountry, "US");
  assert.equal(routeAfter.structuredContent.sessions.collection_backstage.expectedRouteCountry, "SA");
  assertNoProxyDerivedFingerprints(routeAfter);
  assert.equal(JSON.stringify(routeAfter).includes(enumerableDiscoveryFingerprint), false);

  const created = await client.callTool({
    name: "create_discovery_run",
    arguments: {
      source: "svip_legacy",
      mode: "semi_auto",
      filters: { countryCode: "SA", recordedAfter: "2026-08-01 00:00:00", maxCandidates: 20, maxPages: 2 }
    }
  });
  assert.equal(created.isError, undefined);
  assert.match(created.structuredContent.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.structuredContent.filters.countryCode, "SA");
  assert.equal(created.structuredContent.filters.recordedAfter, "2026-08-01 00:00:00");
  assertNoProxyDerivedFingerprints(created);

  const fetchedRun = await client.callTool({
    name: "get_run",
    arguments: { runId: created.structuredContent.runId }
  });
  assertNoProxyDerivedFingerprints(fetchedRun);

  const createdMultiCountry = await client.callTool({
    name: "create_discovery_run",
    arguments: {
      source: "svip_legacy",
      mode: "semi_auto",
      filters: { countryCodes: ["SA", "QA", "EG"], maxCandidates: 5, maxPages: 1 }
    }
  });
  assert.equal(createdMultiCountry.isError, undefined);
  assert.deepEqual(createdMultiCountry.structuredContent.filters.countryCodes, ["SA", "QA", "EG"]);

  for (const forbiddenRegionalFilter of [
    { liveTag: "LIVE" },
    { qualificationStatuses: ["available"] }
  ]) {
    const rejectedRegionalFilter = await client.callTool({
      name: "create_discovery_run",
      arguments: {
        source: "tiktok_live",
        mode: "semi_auto",
        filters: {
          discoveryMethod: "regional_gift_ranking",
          marketRegion: "MENA",
          countryCodes: ["SA"],
          maxCandidates: 5,
          ...forbiddenRegionalFilter
        }
      }
    });
    assert.equal(rejectedRegionalFilter.isError, true);
    assert.equal(
      rejectedRegionalFilter.structuredContent.code,
      "unsupported_regional_filter"
    );
  }

  const duplicateRunCountry = await client.callTool({
    name: "create_discovery_run",
    arguments: {
      source: "svip_legacy",
      mode: "semi_auto",
      filters: { countryCodes: ["SA", "sa"], maxCandidates: 5, maxPages: 1 }
    }
  });
  assert.equal(duplicateRunCountry.isError, true);

  const conflictingRunCountries = await client.callTool({
    name: "create_discovery_run",
    arguments: {
      source: "svip_legacy",
      mode: "semi_auto",
      filters: { countryCode: "SA", countryCodes: ["SA", "QA"], maxCandidates: 5, maxPages: 1 }
    }
  });
  assert.equal(conflictingRunCountries.isError, true);

  const started = await client.callTool({ name: "start_run", arguments: { runId: created.structuredContent.runId } });
  assert.equal(started.isError, undefined);
  assert.equal(started.structuredContent.status, "awaiting_svip_login");

  const preview = await client.callTool({ name: "preview_candidates", arguments: { runId: created.structuredContent.runId } });
  assert.equal(preview.structuredContent.total, 0);
});
