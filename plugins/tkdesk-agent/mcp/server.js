import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { DaemonClient } from "./core/daemon-client.js";
import { DAEMON_VERSION, defaultDataDirectory } from "./core/runtime-paths.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = defaultDataDirectory();
const daemon = new DaemonClient({ pluginRoot, dataDirectory });

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

function stripPublicProxyDerivedFingerprints(value) {
  if (Array.isArray(value)) return value.map(stripPublicProxyDerivedFingerprints);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isProxyDerivedFingerprintKey(key))
    .map(([key, nested]) => [key, stripPublicProxyDerivedFingerprints(nested)]));
}

const server = new McpServer(
  { name: "tkdesk", version: DAEMON_VERSION },
  {
    instructions: [
      "TKDesk is a headless creator-list discovery and qualification service.",
      "The user completes login and security verification in isolated official-site Chrome profiles.",
      "Never request or expose passwords, cookies, tokens, or local-storage values.",
      "This server discovers and hands off candidates; it never messages creators, sends invitations, or publishes content."
    ].join(" ")
  }
);

function toolResult(value) {
  const publicValue = stripPublicProxyDerivedFingerprints(value);
  return {
    content: [{ type: "text", text: JSON.stringify(publicValue, null, 2) }],
    structuredContent: publicValue
  };
}

function registerTool(name, config, handler) {
  server.registerTool(name, config, async (input) => {
    try {
      return toolResult(await handler(input));
    } catch (error) {
      const detail = stripPublicProxyDerivedFingerprints({
        code: error?.code || "tkdesk_error",
        message: String(error?.message || error),
        details: error?.details ?? null
      });
      return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }], structuredContent: detail, isError: true };
    }
  });
}

function withPublicRouteCapabilities(value) {
  const existing = value?.capabilities?.routePolicy ?? {};
  const {
    originalFourNodeTopology: _originalFourNodeTopology,
    collectionLaneCount: _collectionLaneCount,
    collectionLanesMustShareRouteCountry: _collectionLanesMustShareRouteCountry,
    allFourExitsReprobedBeforeRunAndBatch: _allFourExitsReprobedBeforeRunAndBatch,
    multiCountryLaneExtension: _multiCountryLaneExtension,
    originalBinarySingleCountryThreeProxyRows: _originalBinarySingleCountryThreeProxyRows,
    ...routePolicy
  } = existing;
  return {
    ...value,
    capabilities: {
      ...value.capabilities,
      routePolicy: {
        ...routePolicy,
        oneProxyPerCountry: true,
        maxCollectionCountries: 3,
        originalBinaryThreeProxyRows: true,
        originalBinaryRowsShareMarketRegion: true,
        originalBinaryRowsMaySelectDifferentMemberCountries: true,
        allConfiguredExitsReprobedBeforeRunAndBatch: true
      }
    }
  };
}

const targetSchema = z.enum(["tiktok_discovery", "collection_backstage", "svip_legacy"]);
const discoveryRunSourceSchema = z.enum(["tiktok_live", "svip_legacy"]);
const sourceSchema = z.enum(["tiktok_live", "svip_legacy"]);
const modeSchema = z.enum(["semi_auto", "full_auto"]);
const isoCountryCodeSchema = z.string().regex(/^[A-Za-z]{2}$/);
const countryCodesSchema = z.array(isoCountryCodeSchema).min(1).max(3).superRefine((values, context) => {
  const seen = new Set();
  values.forEach((value, index) => {
    const normalized = value.toUpperCase();
    if (seen.has(normalized)) {
      context.addIssue({ code: "custom", message: "countryCodes must be unique", path: [index] });
    }
    seen.add(normalized);
  });
});
const collectionLanesSchema = z.array(z.object({
  countryCode: isoCountryCodeSchema,
  proxyServer: z.string().min(10).max(200)
})).min(1).max(3).superRefine((lanes, context) => {
  const countries = new Set();
  const proxies = new Set();
  lanes.forEach((lane, index) => {
    const countryCode = lane.countryCode.toUpperCase();
    if (countries.has(countryCode)) {
      context.addIssue({ code: "custom", message: "one proxy is allowed per country", path: [index, "countryCode"] });
    }
    if (proxies.has(lane.proxyServer)) {
      context.addIssue({ code: "custom", message: "collection lane proxies must be distinct", path: [index, "proxyServer"] });
    }
    countries.add(countryCode);
    proxies.add(lane.proxyServer);
  });
});
const legacyDateTimeSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .describe("svip 记录时间，格式 YYYY-MM-DD HH:mm:ss；用于可审计的时间窗口，不代表后台已验证为 newest-first 排序");
const collectionCleanupCutoffSchema = z.string().min(20).max(40).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "cutoff must be a valid ISO timestamp"
);
const mobileAuthorizationScopeSchema = z.object({
  marketRegion: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/).optional(),
  countryCode: isoCountryCodeSchema.optional()
}).superRefine((value, context) => {
  if ((value.marketRegion === undefined) === (value.countryCode === undefined)) return;
  context.addIssue({
    code: "custom",
    message: "marketRegion and countryCode must be supplied together"
  });
});

registerTool("status", {
  title: "TKDesk discovery status",
  description: "Show daemon health, supported sources, active runs, session states, local storage location, and the restart-safe startupInventory decision. Read startupInventory before creating fresh collection work; it prioritizes persisted handoffs and candidates already qualified by collection_backstage. When it reports pendingHandoffs, read one with get_handoff; when it selects existing candidates, use candidateQuery then prepare_handoff. Both paths carry the not_contacted marker and direct profileUrl.",
  inputSchema: z.object({})
}, async () => withPublicRouteCapabilities(await daemon.call("status")));

registerTool("core_configuration_status", {
  title: "Read TKDesk core configuration status",
  description: "Return only the fixed country-bundle schema, supported scopes, encryption metadata, and redacted mobile-access readiness. It never returns request headers or secret values.",
  inputSchema: z.object({})
}, () => daemon.call("core_configuration_status"));

registerTool("original_country_catalog", {
  title: "Read the original country and TopCode catalog",
  description: "Return the complete sanitized 36-display/27-route original country catalog, IncludeCode membership, TopCode, and fixed score-request semantics. Optional filters select one route code or member country. It never returns complete URLs, headers, tokens, cookies, signatures, or opaque template values.",
  inputSchema: z.object({
    routeCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,31}$/).optional(),
    countryCode: isoCountryCodeSchema.optional()
  }).default({})
}, (input) => daemon.call("original_country_catalog", input));

registerTool("mobile_authorization_status", {
  title: "Read mobile ranking access status",
  description: "Return readiness metadata for the user-owned mobile ranking access. Supply both marketRegion and countryCode to check a specific fixed country profile, or neither for the stored summary. No secret material is returned.",
  inputSchema: mobileAuthorizationScopeSchema
}, (input) => daemon.call("mobile_authorization_status", input));

registerTool("clear_mobile_authorization", {
  title: "Clear user-owned mobile ranking access",
  description: "Remove the locally stored user-owned mobile ranking access after explicit confirmation. This is rejected while a run or qualification batch is active and never returns the removed value.",
  inputSchema: z.object({ userConfirmed: z.literal(true) })
}, (input) => daemon.call("clear_mobile_authorization", input));

registerTool("session_status", {
  title: "Check login sessions",
  description: "Inspect one isolated official-site browser session without reading credentials or cookies.",
  inputSchema: z.object({ target: targetSchema.optional() })
}, (input) => daemon.call("session_status", input));

registerTool("start_login", {
  title: "Open an official login session",
  description: "Open the selected site in a dedicated normal Chrome profile for manual login. On macOS, keep that window open: credentials and QR contents stay in Chrome, and an explicit check_login connects to the same running browser without restarting it.",
  inputSchema: z.object({
    target: targetSchema,
    routeProfileId: z.string().uuid().optional()
  })
}, (input) => daemon.call("start_login", input));

registerTool("reopen_login", {
  title: "Safely reopen the collection backstage official page",
  description: "After explicit approval, attach only to the exact verified TKDesk collection-backstage Chrome process and open a new official recovery tab on its verified route. Preserve the process, profile, login material, and human tabs. Reject unknown process ownership or an Agent-connected session; never reset the profile.",
  inputSchema: z.object({
    target: z.literal("collection_backstage"),
    routeProfileId: z.string().uuid().optional(),
    userConfirmed: z.literal(true)
  })
}, (input) => daemon.call("reopen_login", input));

registerTool("check_login", {
  title: "Verify a login session",
  description: "Explicitly verify login by connecting over a loopback-only endpoint to the exact dedicated normal Chrome process. It never restarts the profile or reads raw cookies, passwords, tokens, or QR contents.",
  inputSchema: z.object({
    target: targetSchema,
    routeProfileId: z.string().uuid().optional()
  })
}, (input) => daemon.call("check_login", input));

registerTool("reset_session", {
  title: "Reset one isolated session",
  description: "Close and archive the selected local browser profile after the user explicitly asks to reset that login.",
  inputSchema: z.object({ target: targetSchema, userConfirmed: z.literal(true) })
}, (input) => daemon.call("reset_session", input));

registerTool("create_discovery_run", {
  title: "Create a creator discovery run",
  description: "Create a real creator-list execution plan; this is not a passive health check. For a check, use status, session_status, collection_route_status, and collection_backstage_preflight instead. Default TikTok LIVE full-auto uses the fixed regional feed → enrichment → backstage qualification → ranking-expansion pipeline and runs continuously unless explicit bounds are set. Available PC automation can start while missing Mobile authorization remains a named incomplete branch. Explicit discoveryMethod tikhub_rankings uses the user-owned provider configuration and existing frozen country context seeds for a finite paid daily/league snapshot plan with tikHubRankingKind and tikHubRankingPeriod. It preserves unknown country and score units, reuses official qualification, performs no original recursion and never replays an uncertain paid fetch. Explicit discoveryMethod public_live_cards instead collects bounded public LIVE cards and uses the same official backstage qualification without ranking expansion or mobile authorization; it is not regional-ranking parity or an automatic fallback. Use countryCodes for one to three verified country-matched lanes. Callers cannot supply URLs, proxies, headers, or ranking request semantics. It never sends invitations.",
  inputSchema: z.object({
    source: discoveryRunSourceSchema,
    mode: modeSchema.default("full_auto"),
    filters: z.object({
      region: z.string().max(80).optional(),
      marketRegion: z.string().max(32).optional(),
      countryCode: isoCountryCodeSchema.optional(),
      countryCodes: countryCodesSchema.optional(),
      countryDisplayNames: z.array(z.object({ countryCode: isoCountryCodeSchema, displayName: z.string().min(1).max(120) })).max(3).optional(),
      query: z.string().max(160).optional(),
      minFollowers: z.number().int().nonnegative().optional(),
      maxFollowers: z.number().int().nonnegative().optional(),
      excludeSellers: z.boolean().optional(),
      highQualityMode: z.boolean().optional(),
      liveTag: z.union([z.string(), z.number()]).optional(),
      qualificationStatuses: z.array(z.string().max(40)).max(10).optional(),
      discoveryMethod: z.enum(["regional_gift_ranking", "public_live_cards", "tikhub_rankings"]).optional(),
      tikHubRankingKind: z.enum(['daily', 'league']).optional(),
      tikHubRankingPeriod: z.enum(['current', 'previous', 'both']).optional(),
      calibrationProbe: z.literal(true).optional(),
      recordedAfter: legacyDateTimeSchema.optional(),
      recordedBefore: legacyDateTimeSchema.optional(),
      maxCandidates: z.number().int().min(1).max(5_000).optional(),
      maxFeedRounds: z.number().int().min(1).max(1_000).optional(),
      maxPages: z.number().int().min(1).max(200).optional(),
      maxScrolls: z.number().int().min(1).max(100).optional()
    }).superRefine((filters, context) => {
      if (filters.countryCode === undefined || filters.countryCodes === undefined) return;
      const singular = filters.countryCode.toUpperCase();
      const plural = filters.countryCodes.map((value) => value.toUpperCase());
      if (plural.length !== 1 || plural[0] !== singular) {
        context.addIssue({
          code: "custom",
          message: "countryCode and countryCodes conflict; use countryCodes for multi-country runs",
          path: ["countryCodes"]
        });
      }
    }).default({}),
    label: z.string().max(120).optional(),
    routeProfileId: z.string().uuid().optional()
  })
}, (input) => daemon.call("create_discovery_run", input));

registerTool("configure_collection_route", {
  title: "Configure country-matched collection lanes",
  description: "Save one independent US TikTok-discovery route plus one to three collection lanes. The collection-backstage browser shares lane 1. Each collectionLanes item atomically binds one ISO country code to one unauthenticated loopback proxy; array order assigns WorkID 1-3. This reproduces the original lane semantics: its three rows could select different member countries and country-matched nodes, while all selected countries had to belong to the same broad market region such as MENA or CCA.",
  inputSchema: z.object({
    routeProfileId: z.string().uuid().optional(),
    marketRegion: z.string().min(2).max(32),
    marketCountryCodes: z.array(z.string().length(2)).min(1).max(80),
    discoveryCountry: z.literal("US"),
    discoveryProxyServer: z.string().min(10).max(200),
    collectionLanes: collectionLanesSchema,
    activate: z.boolean().default(true),
    userConfirmed: z.literal(true)
  })
}, (input) => daemon.call("configure_collection_route", input));

registerTool("verify_collection_route", {
  title: "Verify the main route and collection lanes",
  description: "Probe the configured local endpoints in isolated temporary browsers. The independent main exit must be US and each collection lane must match that lane's declared country. Does not read login sessions.",
  inputSchema: z.object({
    routeProfileId: z.string().uuid(),
    userConfirmed: z.literal(true)
  })
}, (input) => daemon.call("verify_collection_route", input, 60_000));

registerTool("collection_route_status", {
  title: "Read collection route status",
  description: "Show the US main exit, every configured country lane and its verification state, and whether either browser session must be reopened. Proxy-derived route fingerprints remain internal.",
  inputSchema: z.object({ routeProfileId: z.string().uuid().optional() })
}, (input) => daemon.call("collection_route_status", input));

registerTool("collection_backstage_preflight", {
  title: "Check the collection sub-backend account and market",
  description: "Read the fixed official startup state from the authenticated collection sub-backend and fail closed unless its account identity is ready and its broad market matches the selected verified route. The expected market is derived only from that route; this never performs or consumes a creator qualification query.",
  inputSchema: z.object({ routeProfileId: z.string().uuid().optional() })
}, (input) => daemon.call("collection_backstage_preflight", input));

registerTool("initialize_collection_backstage", {
  title: "Initialize the collection invitation lookup UI",
  description: "Initialize the existing invitation lookup using one generated random letter-only test identity. No real invitation or candidate is created. Any actual lookup consumes the same durable rolling qualification budget. Human security verification remains manual; after explicit user completion call with userConfirmedVerification:true without replaying the test. Requires idle verified sessions.",
  inputSchema: z.object({routeProfileId:z.string().uuid().optional(),inspectOnly:z.boolean().optional(),userConfirmedVerification:z.literal(true).optional()}).strict()
}, (input)=>daemon.call("initialize_collection_backstage",input));

registerTool("prepare_discovery_live", {
  title: "Enter LIVE and pause discovery playback",
  description: "Use the authenticated dedicated TikTok discovery profile's existing recommendation/LIVE tabs, enter LIVE, pause video and prevent autoplay resumes, then verify pause after 3 seconds. Retains login and windows; no profile or network settings are changed. Requires idle verified sessions.",
  inputSchema: z.object({routeProfileId:z.string().uuid().optional()}).strict()
}, (input)=>daemon.call("prepare_discovery_live",input));

registerTool("start_run", {
  title: "Start a discovery run",
  description: "Start or queue real Feed/Data discovery requests for a durable run; this is not a passive health check and may change session readiness when TikTok rejects a request. For a check, use status, session_status, collection_route_status, and collection_backstage_preflight instead. Returns immediately; use get_run for progress.",
  inputSchema: z.object({ runId: z.string().uuid() })
}, (input) => daemon.call("start_run", input));

registerTool("pause_run", {
  title: "Pause a discovery run",
  description: "Request a running job to stop at its next safe checkpoint.",
  inputSchema: z.object({ runId: z.string().uuid() })
}, (input) => daemon.call("pause_run", input));

registerTool("resume_run", {
  title: "Resume a discovery run",
  description: "Resume a paused, partial, or interrupted job from its stored checkpoint.",
  inputSchema: z.object({ runId: z.string().uuid() })
}, (input) => daemon.call("resume_run", input));

registerTool("cancel_run", {
  title: "Cancel a discovery run",
  description: "Cancel a specific job without deleting collected candidates or its audit history.",
  inputSchema: z.object({ runId: z.string().uuid(), reason: z.string().min(3).max(300) })
}, (input) => daemon.call("cancel_run", input));

registerTool("get_run", {
  title: "Get discovery progress",
  description: "Return state, counters, checkpoint, errors, and completion reason for one run.",
  inputSchema: z.object({ runId: z.string().uuid() })
}, (input) => daemon.call("get_run", input));

registerTool("list_runs", {
  title: "List discovery runs",
  description: "List recent durable jobs, optionally filtered by state or source.",
  inputSchema: z.object({
    status: z.string().max(40).optional(),
    source: sourceSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50)
  })
}, (input) => daemon.call("list_runs", input));

registerTool("preview_collection_cleanup", {
  title: "Preview collection-data cleanup",
  description: "Preview an irreversible local cleanup before the supplied cutoff. It changes nothing and reports exact per-table deletion/protection counts plus a short-lived confirmation proof. Audit events, committed handoffs, outbox, login materials, routes, and configuration are always protected.",
  inputSchema: z.object({ cutoff: collectionCleanupCutoffSchema })
}, (input) => daemon.call("preview_collection_cleanup", input));

registerTool("commit_collection_cleanup", {
  title: "Commit collection-data cleanup",
  description: "Irreversibly delete only the exact collection-data snapshot returned by preview_collection_cleanup in one SQLite transaction. Requires the identical cutoff, preview hash, short-lived confirmation proof, and explicit user confirmation; stale previews are rejected. No backup is created.",
  inputSchema: z.object({
    cutoff: collectionCleanupCutoffSchema,
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmationProof: z.string().regex(/^[a-f0-9]{64}$/),
    userConfirmed: z.literal(true)
  })
}, (input) => daemon.call("commit_collection_cleanup", input));

const candidateFilterShape = {
  runId: z.string().uuid().optional(),
  source: sourceSchema.optional(),
  region: z.string().max(80).optional(),
  marketRegion: z.string().max(32).optional(),
  routeCountry: z.string().max(16).optional(),
  creatorCountryCode: z.string().max(16).optional(),
  countryCode: z.string().max(16).optional(),
  minFollowers: z.number().int().nonnegative().optional(),
  maxFollowers: z.number().int().nonnegative().optional(),
  qualificationStatus: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().nonnegative().default(0)
};

registerTool("preview_candidates", {
  title: "Preview a candidate set",
  description: "Return counts, field coverage, source freshness, and anonymized examples before revealing or handing off identities.",
  inputSchema: z.object(candidateFilterShape)
}, (input) => daemon.call("preview_candidates", input));

registerTool("query_candidates", {
  title: "Read exact creator candidates",
  description: "Return exact handles and evidence for the requested candidate set. Requires an audit reason tied to the user's request.",
  inputSchema: z.object({ ...candidateFilterShape, reason: z.string().min(5).max(300) })
}, (input) => daemon.call("query_candidates", input));

registerTool("get_handoff", {
  title: "Read a persisted handoff batch",
  description: "Read an existing immutable handoff batch by ID, including its outreach marker and direct profile links. Requires an audit reason; does not contact creators or modify the batch.",
  inputSchema: z.object({
    batchId: z.string().uuid(),
    reason: z.string().min(5).max(300)
  })
}, (input) => daemon.call("get_handoff", input));

registerTool("creator_research_status", {
  title: "Optional public creator research status",
  description: "Show optional TikHub public research configuration, cache policy and durable daily attempted-request budget. Never fetches paid data, rankings or official qualification.",
  inputSchema: z.object({})
}, () => daemon.call("creator_research_status"));

registerTool("research_candidate", {
  title: "Research one collected creator",
  description: "Read cached public profile and up to 10 recent posts for one existing TKDesk candidate. The default is cache-only. Paid reads require explicit user authorization, allowPaid=true and a unique requestId; at most two fixed reads, a durable daily budget, cache and no automatic retry. Missing provider does not block collection, official qualification or messaging. Public text supports language/content assessment; country does not prove language, and public engagement does not prove LIVE income.",
  inputSchema: z.object({
    candidateId: z.string().uuid(), includePosts: z.boolean().default(false),
    allowPaid: z.boolean().default(false), requestId: z.string().regex(/^[a-z\d._:-]{1,128}$/i).optional(),
    reason: z.string().min(5).max(300)
  }).superRefine((input, context) => {
    if (input.allowPaid && !input.requestId) context.addIssue({ code: "custom", message: "paid lookup requires requestId", path: ["requestId"] });
  })
}, input => daemon.call("research_candidate", input));

registerTool("check_candidate_qualifications", {
  title: "Check or import creator qualifications",
  description: "Use automatic_query only for an explicit 1-30 creator recheck through the dedicated TikTok collection sub-backend; it consumes the rolling qualification budget. For an original semi-auto run, use manual_import after the user queried the official sub-backend themselves: numeric official status/reason/invitation-type codes are associated to that run by normalized handle, persisted without any sub-backend request or budget use, and never start ranking expansion or invitations.",
  inputSchema: z.object({
    operation: z.enum(["automatic_query", "manual_import"]).default("automatic_query"),
    runId: z.string().uuid(),
    candidateIds: z.array(z.string().uuid()).min(1).max(30).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    offset: z.number().int().nonnegative().optional(),
    observedAt: z.string().min(20).max(40).refine(
      (value) => Number.isFinite(Date.parse(value)),
      "observedAt must be a valid ISO timestamp"
    ).optional(),
    results: z.array(z.object({
      handle: z.string().min(1).max(70),
      anchorStatusCode: z.number().int().min(0).max(7),
      displayReasonCode: z.number().int().min(0).max(10).nullable().optional(),
      canUseInvitationTypeCodes: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
      popupInvitationTypeCodes: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
      observedAt: z.string().min(20).max(40).refine(
        (value) => Number.isFinite(Date.parse(value)),
        "observedAt must be a valid ISO timestamp"
      ).optional()
    })).min(1).max(30).optional(),
    reason: z.string().min(5).max(300)
  }).superRefine((input, context) => {
    if (input.operation === "manual_import") {
      if (!input.results) {
        context.addIssue({ code: "custom", message: "manual_import requires results", path: ["results"] });
      }
      for (const field of ["candidateIds", "limit", "offset"]) {
        if (input[field] !== undefined) {
          context.addIssue({ code: "custom", message: `manual_import does not accept ${field}`, path: [field] });
        }
      }
      return;
    }
    for (const field of ["results", "observedAt"]) {
      if (input[field] !== undefined) {
        context.addIssue({ code: "custom", message: `automatic_query does not accept ${field}`, path: [field] });
      }
    }
  })
}, (input) => daemon.call("check_candidate_qualifications", input));

registerTool("prepare_handoff", {
  title: "Prepare a digital-employee handoff",
  description: "Freeze a versioned candidate dataset and create a pending-review batch. Does not contact creators.",
  inputSchema: z.object({
    ...candidateFilterShape,
    destination: z.string().min(2).max(120).default("digital-employee"),
    purpose: z.string().min(3).max(300)
  })
}, (input) => daemon.call("prepare_handoff", input));

registerTool("commit_handoff", {
  title: "Commit an approved handoff",
  description: "Write an approved immutable batch to the local outbox. Requires the exact batch ID and dataset hash returned by prepare_handoff; still never sends messages.",
  inputSchema: z.object({
    batchId: z.string().uuid(),
    datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
    userConfirmed: z.literal(true)
  })
}, (input) => daemon.call("commit_handoff", input));

registerTool("audit_events", {
  title: "Read TKDesk audit events",
  description: "Read recent login, run, identity access, handoff, and error events.",
  inputSchema: z.object({ runId: z.string().uuid().optional(), limit: z.number().int().min(1).max(500).default(100) })
}, (input) => daemon.call("audit_events", input));

await daemon.call("ping", {}, 20_000);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[TKDesk] MCP ${DAEMON_VERSION} ready; shared daemon data: ${dataDirectory}`);
