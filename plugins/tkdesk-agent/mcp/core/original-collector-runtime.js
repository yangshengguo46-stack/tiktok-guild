import {
  assertRegionalPipelineRoute,
  classifyOriginalDataProcessorResults,
  fetchOriginalCountryFeedLaneRound,
  fetchOriginalCountryTemplateLaneRound,
  mergeOriginalDiscoverySeeds,
  runOriginalDataProcessorWorkerPool
} from "./original-cascade-runtime.js";
import { listOriginalAutoQualificationProspects } from "./original-qualification-runtime.js";
import { safeContentType } from "./http-response-diagnostics.js";

export const ORIGINAL_COLLECTOR_PROFILE = Object.freeze({
  implementation: "tksoft-v10-continuous-processors-v1",
  dataWorkers: 4,
  feedQueueThreshold: 35,
  backpressureWaitMs: 500,
  // Keep each producer's backlog independent; Mobile admission is local policy.
  mobileBackpressureWaitMs: 3_000,
  mobileBackpressurePolicy: "local_source_queue",
  successPollDelayMs: 3_000,
  errorPollDelayMs: 60_000,
  mobileRefreshMs: 120_000,
  rankingRefreshMs: 300_000
});

const dependencyMissing = reason => /authorization_required|authorization_missing|template_missing|unsupported/.test(reason ?? "");
const pauseRequired = reason => /authentication_required|manual_verification|route_restart_required|proxy_mismatch|lane_evidence_mismatch|route_country_mismatch|session_run_closed|session_unavailable/.test(reason ?? "");

/**
 * Original-style autonomous processor lifetime. Transport adapters own fixed
 * requests; SQLite owns pending seeds and attempts. Model calls never drive
 * this loop. A finite source-round/candidate boundary is explicit diagnostics,
 * not the normal continuous mode.
 */
export async function runOriginalCollector({
  database, runId, selectedLanes, verifiedRoute, marketRegion, filters = {},
  maxCandidates = null, maxFeedRounds = null, receivedCount = null,
  shouldStop = () => false, fetchFeedOnce, fetchCountryTemplatesOnce = null,
  laneForCandidate, enrichOnce, onBatch = () => {}, onProgress = async () => {},
  qualifyReady = null, expandReady = null,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  clock = () => Date.now()
} = {}) {
  if (!database?.getRun(runId)) throw new TypeError("a durable collection run is required");
  for (const [name, value] of Object.entries({ shouldStop, fetchFeedOnce, laneForCandidate, enrichOnce, onBatch, onProgress, sleep, clock })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }
  if (!Array.isArray(selectedLanes) || selectedLanes.length < 1 || selectedLanes.length > 3) {
    throw new TypeError("one to three country lanes are required");
  }
  assertRegionalPipelineRoute({ verifiedRoute, selectedLanes, marketRegion });
  if (receivedCount !== null && typeof receivedCount !== "function") throw new TypeError("receivedCount must be a function or null");
  const cap = maxCandidates === null ? Infinity : Number(maxCandidates);
  const roundCap = maxFeedRounds === null ? Infinity : Number(maxFeedRounds);
  if (!(cap === Infinity || (Number.isSafeInteger(cap) && cap > 0))
    || !(roundCap === Infinity || (Number.isSafeInteger(roundCap) && roundCap > 0))) {
    throw new TypeError("collection boundaries must be positive integers or null");
  }
  let fatal = null;
  let sourcesDone = false;
  let dataDone = false;
  let executionFinished = false;
  let qualificationIdle = true;
  let rankingDone = typeof expandReady !== "function";
  let acceptedGeneration = 0;
  let qualificationGeneration = -1;
  let rankingGeneration = -1;
  let reservations = 0;
  let dataActive = 0;
  let completedSourceWorkers = 0;
  let dataClaimTurn = 0;
  const acceptedIdentities = new Set();
  const knownCountries = new Map();
  const identityProcessing = new Map();
  const countryEvidenceTtlMs = 300_000;
  const stableIdentityKey = seed => {
    const handle = String(seed.handle ?? seed.displayId ?? "").replace(/^@/, "").toLowerCase();
    const userId = String(seed.userId ?? "");
    const roomId = String(seed.roomId ?? "");
    return /^[a-z\d._]{1,64}$/i.test(handle) && /^\d{5,32}$/.test(userId) && /^\d{5,32}$/.test(roomId)
      && !/^0+$/.test(userId) && !/^0+$/.test(roomId) ? `${handle}:${userId}:${roomId}` : null;
  };
  const sourceWorkerCount = selectedLanes.length * (typeof fetchCountryTemplatesOnce === "function" ? 2 : 1);
  const summary = {
    implementation: ORIGINAL_COLLECTOR_PROFILE.implementation,
    source: "tiktok_original_country_discovery_union", sourceType: "tiktok_original_country_discovery_union",
    found: 0, receivedRooms: 0, feedAttempts: 0, feedRounds: 0,
    feedAttemptsByWorkId: Object.fromEntries(selectedLanes.map(lane => [lane.workId, 0])),
    channelIdsByWorkId: Object.fromEntries(selectedLanes.map(lane => [lane.workId, []])),
    channelIdSampleLimit: 64,
    filteredCounts: {}, partialCounts: {}, enrichmentUnresolved: 0,
    mobileTemplateAttempts: 0, mobileTemplateComplete: false,
    qualification: null, ranking: null,
    countryEvidenceReuse: { skipped: 0, ttlMs: countryEvidenceTtlMs, scope: "execution_only_negative_admission" },
    processors: {
      pc: selectedLanes.map(lane => ({ workId: lane.workId, countryCode: lane.countryCode, state: "starting", attempts: 0, successfulResponses: 0, nonEmptyResponses: 0, receivedRooms: 0, ordinaryErrors: 0 })),
      mobile: typeof fetchCountryTemplatesOnce === "function"
        ? selectedLanes.map(lane => ({ workId: lane.workId, countryCode: lane.countryCode, state: "starting", attempts: 0, complete: false,
          backpressurePolicy: ORIGINAL_COLLECTOR_PROFILE.mobileBackpressurePolicy,
          backpressureThreshold: ORIGINAL_COLLECTOR_PROFILE.feedQueueThreshold,
          backpressureWaitMs: ORIGINAL_COLLECTOR_PROFILE.mobileBackpressureWaitMs }))
        : [],
      data: { state: "starting", workers: 4, active: 0 },
      live: { state: typeof qualifyReady === "function" ? "starting" : "disabled" },
      ranking: { state: rankingDone ? "disabled" : "starting" }
    }
  };
  // Round limits belong to the durable run, including pause/restart. Older
  // checkpoints stored processor counters without the complete summary.
  const checkpoint = database.getCheckpoint(runId, "original_collectors", { adapter: "tiktok_original_cascade" })?.value;
  const savedRun = database.getRun(runId);
  const savedResult = savedRun.result;
  const previous = checkpoint?.summary ?? (savedResult?.implementation === summary.implementation ? savedResult : checkpoint);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const resuming = checkpoint?.executionFinished !== true
    || ["running", "paused", "partial", "interrupted", "awaiting_verification"].includes(savedRun.status);
  if (resuming && previous?.implementation === summary.implementation) {
    for (const family of ["pc", "mobile"]) {
      for (const processor of summary.processors[family]) {
        const saved = previous.processors?.[family]?.find(item => item.workId === processor.workId && item.countryCode === processor.countryCode);
        if (!saved) continue;
        processor.lastFailure = saved.lastFailure ?? null;
        processor.lastResponseDiagnostics = saved.lastResponseDiagnostics ?? null;
        for (const key of ["attempts", "successfulResponses", "nonEmptyResponses", "receivedRooms", "ordinaryErrors"]) {
          if (Object.hasOwn(processor, key)) processor[key] = count(saved[key]);
        }
        if (family === "mobile") {
          processor.complete = saved.complete === true;
          processor.templateLabels = saved.templateLabels ?? [];
          processor.templateRowCounts = saved.templateRowCounts ?? null;
        }
      }
    }
    summary.found = count(previous.found);
    summary.feedAttempts = summary.processors.pc.reduce((total, item) => total + item.attempts, 0);
    summary.receivedRooms = summary.processors.pc.reduce((total, item) => total + item.receivedRooms, 0);
    summary.feedAttemptsByWorkId = Object.fromEntries(summary.processors.pc.map(item => [item.workId, item.attempts]));
    summary.feedRounds = Math.max(...Object.values(summary.feedAttemptsByWorkId));
    summary.mobileTemplateAttempts = summary.processors.mobile.reduce((total, item) => total + item.attempts, 0);
    summary.mobileTemplateComplete = summary.processors.mobile.length > 0 && summary.processors.mobile.every(item => item.complete);
    summary.channelIdsByWorkId = Object.fromEntries(selectedLanes.map(lane => [lane.workId,
      (Array.isArray(previous.channelIdsByWorkId?.[lane.workId]) ? previous.channelIdsByWorkId[lane.workId] : []).slice(-64)]));
    summary.filteredCounts = previous.filteredCounts ?? {};
    summary.partialCounts = previous.partialCounts ?? {};
    summary.enrichmentUnresolved = count(previous.enrichmentUnresolved);
  }
  const stopped = () => Boolean(fatal || shouldStop());
  const admittedCount = () => receivedCount ? Number(receivedCount()) : summary.found;
  const bounded = () => admittedCount() >= cap;
  const queue = (sourceKind = null) => database.originalDiscoveryQueueStatus(runId, { seedKind: "feed", sourceKind });
  const sourceKinds = ["original_pc_web_feed", "original_mobile_processor_fixed_country_lists"];
  const countReason = (target, reason, count = 1) => {
    const key = typeof reason === "string" ? reason : "source_not_ready";
    target[key] = (target[key] ?? 0) + count;
  };
  const progress = async () => {
    await onProgress({ ...structuredClone(summary), phase: "original_continuous_processors", feedQueue: queue() });
    database.saveCheckpoint(runId, "original_collectors", {
      implementation: summary.implementation, summary: structuredClone(summary), processors: summary.processors,
      feedAttemptsByWorkId: summary.feedAttemptsByWorkId, found: summary.found,
      executionFinished, sourceComplete: sourcesDone, dataComplete: dataDone, updatedAt: new Date(clock()).toISOString()
    }, { adapter: "tiktok_original_cascade" });
  };
  // Slice waits so pause/cancel does not wait for a 60-second timer to expire.
  const wait = async (milliseconds, owner, endEarly = () => false) => {
    let remaining = milliseconds;
    while (remaining > 0 && !stopped() && !endEarly()) {
      const slice = Math.min(250, remaining);
      await sleep(slice, owner);
      remaining -= slice;
    }
  };
  const sourceFinished = () => {
    completedSourceWorkers += 1;
    sourcesDone = completedSourceWorkers === sourceWorkerCount;
  };
  const enqueue = (candidates, sourceKind) => {
    for (const candidate of candidates ?? []) {
      const handle = String(candidate.handle ?? candidate.displayId ?? "").replace(/^@/, "").toLowerCase();
      if (!handle) continue;
      // Guard the durable union before the country/DisplayID key lookup.
      // This synchronous transaction covers independent sources and restart.
      database.transaction(() => {
        const active = database.listActiveOriginalDiscoverySeeds({
          runId, seedKind: "feed", countryCode: candidate.rankingScopeCountryCode
        });
        const conflicts = active.filter(existing => mergeOriginalDiscoverySeeds([
          { sourceKind: existing.payload.discoverySourceKinds?.[0] ?? "original_pc_web_feed", candidates: [existing.payload] },
          { sourceKind, candidates: [candidate] }
        ]).identityConflicts > 0);
        if (conflicts.length) {
          countReason(summary.partialCounts, "discovery_identity_conflict");
          const provenance = row => ({
            handle: row.handle ?? row.displayId ?? null, userId: row.userId ?? null,
            secUid: row.secUid ?? null, roomId: row.roomId ?? null,
            discoverySourceKinds: row.discoverySourceKinds ?? [sourceKind]
          });
          const previous = database.getCheckpoint(runId, "original_discovery_identity_conflicts", { adapter: "tiktok_original_cascade" })?.value;
          database.saveCheckpoint(runId, "original_discovery_identity_conflicts", {
            totalCount: Number(previous?.totalCount ?? 0) + 1,
            observations: [...(previous?.observations ?? []).slice(-99), {
              countryCode: candidate.rankingScopeCountryCode, observedAt: database.now(),
              incoming: provenance(candidate),
              existing: conflicts.map(existing => ({ queueId: existing.queueId, ...provenance(existing.payload) }))
            }]
          }, { adapter: "tiktok_original_cascade" });
          return;
        }
        database.enqueueOriginalDiscoverySeed({
          runId, seedKind: "feed", identityKey: `${candidate.rankingScopeCountryCode}:${handle}`,
          payload: { ...candidate, discoverySourceKinds: candidate.discoverySourceKinds ?? [sourceKind] },
          mergePayload: (existing, incoming) => {
            const previousKinds = existing.discoverySourceKinds ?? [];
            if (previousKinds.includes(sourceKind)) return existing;
            const merged = mergeOriginalDiscoverySeeds([
              { sourceKind: previousKinds[0] ?? "original_pc_web_feed", candidates: [existing] },
              { sourceKind, candidates: [incoming] }
            ]);
            if (merged.identityConflicts) {
              countReason(summary.partialCounts, "discovery_identity_conflict", merged.identityConflicts);
              return existing;
            }
            return { ...merged.candidates[0], discoverySourceKinds: [...new Set([...previousKinds, sourceKind])] };
          }
        });
      });
    }
  };
  const sourceWorker = async (lane, mobile = false) => {
    const processor = (mobile ? summary.processors.mobile : summary.processors.pc).find(item => item.workId === lane.workId);
    const owner = { processor: mobile ? "mobile" : "pc", workId: lane.workId };
    try {
      // Bounded diagnostics sample one Mobile bundle; continuous mode uses
      // V10's 120-second refresh independently of PC polling.
      const workerRoundCap = mobile && Number.isFinite(roundCap) ? 1 : roundCap;
      // An explicit Feed sample finishes its requested rounds; the candidate
      // cap independently stops Data admission and additional seed enqueue.
      const sourceBounded = () => bounded() && (mobile || !Number.isFinite(roundCap));
      while (!stopped() && !sourceBounded() && processor.attempts < workerRoundCap) {
        if (!bounded() && Number(queue(sourceKinds[mobile ? 1 : 0]).counts.pending ?? 0) >= ORIGINAL_COLLECTOR_PROFILE.feedQueueThreshold) {
          processor.state = "backpressure";
          processor.nextDelayMs = mobile ? ORIGINAL_COLLECTOR_PROFILE.mobileBackpressureWaitMs : ORIGINAL_COLLECTOR_PROFILE.backpressureWaitMs;
          await wait(processor.nextDelayMs, owner, sourceBounded);
          continue;
        }
        processor.state = "requesting";
        let result;
        try {
          const [entry] = mobile
            ? await fetchOriginalCountryTemplateLaneRound({ selectedLanes: [lane], verifiedRoute, marketRegion, shouldStop: stopped, fetchOnce: fetchCountryTemplatesOnce })
            : await fetchOriginalCountryFeedLaneRound({ selectedLanes: [lane], verifiedRoute, marketRegion, limit: 100, shouldStop: stopped, fetchOnce: fetchFeedOnce });
          result = entry.result;
        } catch (error) {
          if (pauseRequired(String(error?.code).toLowerCase())) throw error;
          result = { status: "capability_not_ready", reason: mobile ? "mobile_transport_failed" : "feed_transport_failed" };
        }
        processor.attempts += 1;
        if (mobile) summary.mobileTemplateAttempts += 1;
        else {
          summary.feedAttempts += 1;
          summary.feedAttemptsByWorkId[lane.workId] += 1;
          summary.feedRounds = Math.max(...Object.values(summary.feedAttemptsByWorkId));
        }
        if (result.status === "ready") {
          processor.state = "running"; processor.reason = null;
          processor.lastResponseDiagnostics = result.diagnostics ?? null;
          if (mobile) {
            processor.complete = true;
            processor.templateLabels = result.templateLabels ?? [];
            processor.templateRowCounts = result.templateRowCounts ?? null;
            summary.mobileTemplateComplete = summary.processors.mobile.every(item => item.complete);
          } else {
            processor.successfulResponses += 1;
            if ((result.candidates ?? []).length > 0) processor.nonEmptyResponses += 1;
            processor.receivedRooms += Number(result.receivedRooms ?? 0);
            summary.receivedRooms += Number(result.receivedRooms ?? 0);
            if (Number.isInteger(result.channelId)) {
              const sample = summary.channelIdsByWorkId[lane.workId];
              sample.push(result.channelId);
              if (sample.length > summary.channelIdSampleLimit) sample.splice(0, sample.length - summary.channelIdSampleLimit);
            }
          }
          if (!bounded()) enqueue((result.candidates ?? []).map(candidate => ({ ...candidate,
            rankingDisplayName: candidate.rankingDisplayName ?? result.sourceDisplayName ?? lane.displayName ?? null })), mobile ? "original_mobile_processor_fixed_country_lists" : "original_pc_web_feed");
        } else {
          processor.reason = result.reason ?? "source_not_ready";
          processor.lastFailure = { reason: processor.reason, diagnostics: result.diagnostics ?? null,
            httpStatus: result.httpStatus ?? null, businessStatusCode: result.businessStatusCode ?? null };
          processor.state = dependencyMissing(processor.reason) ? "dependency_missing" : "error_backoff";
          countReason(summary.partialCounts, processor.reason);
          if (!mobile && !dependencyMissing(processor.reason) && !pauseRequired(processor.reason)) processor.ordinaryErrors += 1;
          if (pauseRequired(processor.reason)) {
            const error = new Error("collector session or lane requires attention"); error.code = processor.reason; throw error;
          }
        }
        await progress();
        if (mobile && processor.state === "dependency_missing") return;
        if (stopped() || sourceBounded() || processor.attempts >= workerRoundCap) break;
        const delay = result.status !== "ready" ? ORIGINAL_COLLECTOR_PROFILE.errorPollDelayMs
          : mobile ? ORIGINAL_COLLECTOR_PROFILE.mobileRefreshMs : ORIGINAL_COLLECTOR_PROFILE.successPollDelayMs;
        processor.nextDelayMs = delay;
        await wait(delay, owner, sourceBounded);
      }
    } finally {
      if (processor.state !== "dependency_missing") processor.state = stopped() ? "stopped" : "bounded";
      sourceFinished();
    }
  };
  const dataWorker = async () => {
    while (!stopped() && !bounded()) {
      if (admittedCount() + reservations >= cap) { await wait(250, { processor: "data" }); continue; }
      const countryTurn = dataClaimTurn % selectedLanes.length;
      const [claim] = database.claimDueOriginalDiscoverySeeds({
        runId, seedKind: "feed", limit: 1,
        preferredSourceKind: sourceKinds[dataClaimTurn % sourceKinds.length],
        preferredCountryCodes: [...selectedLanes.slice(countryTurn), ...selectedLanes.slice(0, countryTurn)].map(lane => lane.countryCode)
      });
      if (claim) dataClaimTurn += 1;
      if (!claim) {
        if (sourcesDone && Number(queue().counts.pending ?? 0) === 0) return;
        await wait(250, { processor: "data" }); continue;
      }
      reservations += 1; dataActive += 1;
      summary.processors.data.state = "running"; summary.processors.data.active = dataActive;
      let settled = false;
      const identity = stableIdentityKey(claim.payload);
      let releaseIdentity = null;
      try {
        if (identity) {
          // Only identical stable user/room/handle observations share this
          // gate. Matching countries still perform their own full verification.
          while (identityProcessing.has(identity)) await identityProcessing.get(identity);
          if (stopped()) continue;
          const known = knownCountries.get(identity);
          const age = known ? clock() - known.observedAtMs : null;
          if (known && age >= 0 && age < countryEvidenceTtlMs
            && known.countryCode !== claim.payload.rankingScopeCountryCode) {
            countReason(summary.filteredCounts, "creator_country_mismatch");
            summary.countryEvidenceReuse.skipped += 1;
            database.completeOriginalDiscoverySeed(claim.queueId, {
              claimToken: claim.claimToken, status: "skipped",
              result: { stage: "original_data_processor", accepted: 0, unresolved: 0,
                reason: "creator_country_mismatch", countryEvidenceReused: true,
                countryEvidenceAgeMs: age }
            });
            settled = true;
            await progress();
            continue;
          }
          identityProcessing.set(identity, new Promise(resolve => { releaseIdentity = resolve; }));
        }
        const results = await runOriginalDataProcessorWorkerPool({
          seeds: [claim.payload], verifiedRoute, filters, shouldStop: stopped, laneForCandidate, enrichOnce, nowMs: clock()
        });
        const latest = database.getDiscoverySeed(claim.queueId)?.payload ?? claim.payload;
        const enriched = classifyOriginalDataProcessorResults(results.map(entry => entry && { ...entry, seed: latest }), { filters, nowMs: clock() });
        const attention = results.find(entry => pauseRequired(entry?.result?.reason));
        if (attention) {
          const error = new Error("Data session or lane requires attention"); error.code = attention.result.reason; throw error;
        }
        if (stopped()) continue;
        const countryResult = results[0]?.result;
        const failedStages = (countryResult?.stageEvidence ?? []).filter(entry => entry.state === "failed")
          .map(entry => {
            const raw = entry.diagnostics;
            const diagnostics = raw ? {
              ...(Number.isSafeInteger(raw.httpStatus) ? { httpStatus: raw.httpStatus } : {}),
              ...(Object.hasOwn(raw, "contentType") ? { contentType: safeContentType(raw.contentType) } : {}),
              ...(Number.isSafeInteger(raw.bodyBytes) && raw.bodyBytes >= 0 ? { bodyBytes: Math.min(16 * 1024 * 1024, raw.bodyBytes) } : {}),
              ...(["empty", "html", "json_like", "other"].includes(raw.bodyKind) ? { bodyKind: raw.bodyKind } : {}),
              ...(Number.isSafeInteger(raw.elapsedMs) ? { elapsedMs: Math.max(0, Math.min(3_600_000, raw.elapsedMs)) } : {}),
              ...(["timeout", "network_or_transport"].includes(raw.category) ? { category: raw.category } : {})
            } : null;
            return { stage: entry.stage, reason: entry.reason, diagnostics,
              httpStatus: entry.httpStatus ?? null, businessStatusCode: entry.businessStatusCode ?? null };
          });
        const facts = countryResult?.enrichment;
        if (identity && countryResult?.completedStages?.includes("country")
          && String(facts?.userId) === String(claim.payload.userId)
          && String(facts?.roomId) === String(claim.payload.roomId)
          && /^[A-Z]{2}$/.test(facts?.creatorCountryCode ?? "")) {
          knownCountries.set(identity, { countryCode: facts.creatorCountryCode, observedAtMs: clock() });
          // Continuous collectors retain bounded projected facts, never raw
          // responses or credentials, and discard them on execution end.
          while (knownCountries.size > 5_000) knownCountries.delete(knownCountries.keys().next().value);
        }
        for (const [reason, count] of Object.entries(enriched.filteredCounts)) countReason(summary.filteredCounts, reason, count);
        for (const [reason, count] of Object.entries(enriched.partialCounts)) countReason(summary.partialCounts, reason, count);
        summary.enrichmentUnresolved += enriched.unresolved;
        if (enriched.accepted.length && bounded()) continue;
        const candidates = enriched.accepted.slice(0, Math.max(0, cap - admittedCount()));
        database.transaction(() => {
          if (candidates.length) {
            const output = onBatch(candidates);
            if (output && typeof output.then === "function") {
              output.catch(() => {});
              throw new TypeError("collector onBatch must persist synchronously inside the queue transaction");
            }
          }
          database.completeOriginalDiscoverySeed(claim.queueId, {
            claimToken: claim.claimToken,
            status: enriched.unresolved ? "failed" : candidates.length ? "completed" : "skipped",
            result: { stage: "original_data_processor", accepted: candidates.length, unresolved: enriched.unresolved,
              ...(failedStages.length ? { failedStages } : {}) }
          });
        });
        settled = true;
        for (const candidate of candidates) {
          const identity = `${candidate.rankingScopeCountryCode}:${String(candidate.handle).replace(/^@/, "").toLowerCase()}`;
          if (!acceptedIdentities.has(identity)) { acceptedIdentities.add(identity); summary.found += 1; }
        }
        if (candidates.length) acceptedGeneration += 1;
        await progress();
      } finally {
        if (releaseIdentity) {
          identityProcessing.delete(identity);
          releaseIdentity();
        }
        if (!settled) database.releaseOriginalDiscoverySeed(claim.queueId, {
          claimToken: claim.claimToken, error: { code: stopped() ? "paused_or_cancelled" : bounded() ? "configured_candidate_limit" : "data_processing_failed" }
        });
        reservations -= 1; dataActive -= 1;
        summary.processors.data.active = dataActive;
      }
    }
  };
  const liveWorker = async () => {
    if (typeof qualifyReady !== "function") return;
    while (!stopped()) {
      const prospects = listOriginalAutoQualificationProspects({ database, runId, limit: 30 });
      const tailReady = dataDone && prospects.length > 0 && qualificationGeneration !== acceptedGeneration;
      if ((prospects.length >= 30 && qualificationGeneration !== acceptedGeneration) || tailReady) {
        qualificationIdle = false;
        summary.processors.live.state = "qualifying";
        try {
          const handledGeneration = acceptedGeneration;
          summary.qualification = await qualifyReady({ sourceComplete: dataDone });
          qualificationGeneration = handledGeneration;
          if (summary.qualification?.stoppedReason === "backend_quota_limit") {
            const error = new Error("official qualification quota requires attention");
            error.code = "backend_quota_limit"; throw error;
          }
        } finally { qualificationIdle = true; }
        await progress();
      } else {
        summary.processors.live.state = "waiting_batch";
        if (dataDone && rankingDone) return;
        await wait(250, { processor: "live" });
      }
    }
  };
  const rankingWorker = async () => {
    if (typeof expandReady !== "function") return;
    let nextScanAt = 0;
    while (!stopped()) {
      if (!qualificationIdle) { await wait(250, { processor: "ranking" }); continue; }
      const newlyQualified = qualificationGeneration > rankingGeneration;
      if (newlyQualified || clock() >= nextScanAt) {
        summary.processors.ranking.state = "expanding";
        const before = admittedCount();
        summary.ranking = await expandReady();
        if (admittedCount() > before || (!receivedCount && Number(summary.ranking?.found ?? 0) > 0)) acceptedGeneration += 1;
        rankingGeneration = qualificationGeneration;
        nextScanAt = clock() + ORIGINAL_COLLECTOR_PROFILE.rankingRefreshMs;
        summary.processors.ranking.state = summary.ranking?.mobileSessionRequired ? "dependency_missing" : "waiting_scan";
        await progress();
      }
      if (dataDone && qualificationIdle
        && (qualificationGeneration >= acceptedGeneration
          || listOriginalAutoQualificationProspects({ database, runId, limit: 1 }).length === 0)) { rankingDone = true; return; }
      await wait(250, { processor: "ranking" });
    }
    rankingDone = true;
  };
  const protect = async operation => {
    try { return await operation(); } catch (error) { fatal ??= error; }
  };
  const sourceTasks = selectedLanes.flatMap(lane => [
    protect(() => sourceWorker(lane)),
    ...(typeof fetchCountryTemplatesOnce === "function" ? [protect(() => sourceWorker(lane, true))] : [])
  ]);
  const dataTask = protect(async () => {
    await Promise.all(Array.from({ length: 4 }, () => protect(dataWorker)));
    dataDone = true;
    summary.processors.data.state = stopped() ? "stopped" : "drained";
  });
  await Promise.all([...sourceTasks, dataTask, protect(liveWorker), protect(rankingWorker)]);
  if (fatal) throw fatal;
  executionFinished = !shouldStop();
  await progress();
  return {
    ...summary, status: shouldStop() ? "stopped" : "partial",
    complete: false, exhaustive: false, selectionComplete: bounded(),
    sourceComplete: sourcesDone, dataComplete: dataDone,
    configuredCandidateLimit: cap === Infinity ? null : cap,
    completionScope: shouldStop() ? "paused_or_cancelled" : bounded() ? "configured_candidate_limit" : "bounded_original_processors",
    originalDiscoveryParityComplete: summary.mobileTemplateComplete && summary.feedAttempts > 0
      && Object.keys(summary.partialCounts).length === 0
      && summary.processors.mobile.every(processor => processor.backpressurePolicy === "verified_original"),
    feedQueue: queue()
  };
}
