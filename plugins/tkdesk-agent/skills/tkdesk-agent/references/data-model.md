# TKDesk candidate and run model

Read this reference when interpreting exact candidates, field coverage, qualification, or completion claims.

## Stable identity

`candidateId` is local and durable. Identity resolution prefers TikTok `userId`, then `secUid`, then a normalized handle. A nickname, region, follower count, or room ID must never be part of the stable key.

`handle`, `displayName`, `profileUrl`, and `roomId` can change. Treat them as observed attributes, not primary keys.

## Observation fields

Candidate fields can include:

- `userId`, `secUid`, `handle`, `displayName`, `profileUrl`
- `marketRegion`: selected broad market such as MENA/CCA; it is not a country
- `discoveryCountry` and `discoveryProxyExitCountry`: public evidence for the fixed TikTok discovery route (US in this deployment). Proxy-derived fingerprints remain internal and are never returned by public tools.
- `countryCodes`: the run's ordered set of one-to-three requested collection countries. Legacy run filter `countryCode` is a single-country alias.
- `routeCountry`: the individual candidate observation's WorkID-lane country. It remains singular because one row travels on one lane; it must not be used as the whole run's country set.
- `backstageCountry`: a compatibility alias for route lane 1 in route records, and lane-scoped qualification evidence on candidate observations. The backend's broad-market evidence remains separate from individual creator country.
- `workId` and `collectionLaneEvidence`: `1..3` identify the ordered TKDesk country lane used for the row; `4` identifies a ranking-derived row whose preserved ranking-scope country selects a matching verified lane. A ranking-derived child does not inherit its parent's WorkID.
- `collectionLanes`, `collectionProxyExitCountries`, `routeProfileId`, and `routeVerifiedAt`: safe route evidence when a verified full-auto route was used. Each public lane records WorkID, declared country, observed exit country, and verification state but never returns its raw proxy URL or proxy-derived fingerprints. Legacy `proxyExitCountry` is only a first-lane alias; it is also the collection-sub-backend browser exit in the current route topology.
- `creatorCountryCode`: creator-country evidence returned by a source; never copied from the proxy
- `region`, `countryCode`: backward-compatible creator-observation aliases
- `roomId`, `live`, `viewerCount`, `liveTag`
- supplemental live-sample fields: `sampleRound`, `sampleStatus`, `liveTime`, `currentScore`, and `giftDetailState`. `giftEventCount` and `giftValue` remain `null` when the public sampler cannot observe them; null is not zero.
- `followerCount`, `seller`, `highQuality`, `rank`
- `rankScoreRaw`, `rankScoreType`, `rankScoreUnit`, `rankingPeriod`, `rankingSubtab`, `rankingCountdown`, `rankingSource`, and `rankingObservedAt`: bounded TikTok ranking evidence. `rankTypeCode`, `regionTypeCode`, `gapInterval`, `rankingViewKind`, and `adapterEvidenceVersion` preserve the parsed non-secret request semantics without retaining a signed URL/query. The ranking scope (`rankingScopeMarketRegion`, `rankingScopeCountryCode`, `rankingScopeCountryEvidence`) is separate from a creator's country.
- the six original raw leaderboard fields: `currentScore`, `topScore`, `historyRankScore`, `hotListScore`, `rankRecordScore`, and `rankingScore`, plus `scoreFieldUnits`. Their compatibility aliases are `diamondCurrent <- currentScore`, `diamondPeriod <- topScore`, `diamondRankingRecord <- historyRankScore`, and `diamondHistoricalMax <- max(hotListScore, rankRecordScore, rankingScore)` only when all three inputs are known. Legacy TKsoft leaderboard scores are tagged `unknown_rank_score` and never receive a USD projection.
- `expectedInvitationLane`: advisory `regular`, `advanced`, or `backend_required` from the one-million-follower boundary; never final eligibility
- `qualificationStatus` and `qualificationReason`
- `qualificationObservedAt` and `qualificationSource`
- `legacyQualification` and `backstageQualification`, retained independently
- `source`, `sourceUrl`, `observedAt`, `confidence`, `firstSeenAt`, `lastSeenAt`
- `discoveryMethod`: the actual `tiktok_live` method (`public_live_cards`, `regional_gift_ranking`, or `tikhub_rankings`) on the discovery observation and candidate projection. This is not a creator-country claim. Handoff retains it with a sanitized `sourceUrl` for per-person provenance.

Every missing value remains `null`. In particular, `followerCount: 0` means an observed zero; `followerCount: null` means unknown.

## Qualification

The legacy source maps known vendor values to:

- `regular_invitation`
- `advanced_invitation`
- `associated_account`
- `insufficient_duration`
- `not_queried`
- `unknown` or `unknown_code`

`not_queried` is not a negative decision. On an original semi-auto run it means no qualification result has yet been associated with that run. After the user queries the official collection sub-backend themselves and imports a structured result, the candidate projection becomes `manual_imported`; `automaticQualificationPerformed` remains `false`.

The current collection sub-backend uses a separate official `AnchorStatus` schema. TKDesk stores its mapped status, raw numeric codes, safe reason flags, qualification source, fixed provenance, and qualification observation time in a separate observation. A qualification check or manual import must never replace the original discovery source, discovery observation time, follower evidence, or live state. Manual import is accepted only for a regional `semi_auto` run, matches 1–30 normalized handles exactly to that run, and rejects the complete import if any handle/code is unknown, ambiguous, duplicated, cross-run, or already classified.

`quota_limit` means the backend did not complete a creator-eligibility decision. Its boolean eligibility is `null`, not `false`, and the batch is reported as incomplete. A CAPTCHA or other manual verification is also an unresolved request state, never a negative creator decision.

The local scheduler stores every attempted automatic qualification batch before dispatch. It enforces a persisted hourly working target in `50..55` (hard ceiling `55`), a rolling-24-hour target in `145..150` (hard ceiling `150`), and a `60..80` second batch interval. Any variability is downward-only from the selected target/ceiling. These counts are requests, not creators; one request contains at most 30 creators. A `manual_import` writes qualification observations and audit provenance but no `qualification_batches` row, consumes zero request allowance, and cannot trigger automatic replay or qualification-driven ranking expansion.

## Runs and coverage

A collection run stores its filters, configured bounds, status, counters, checkpoint, adapter result, and error separately from candidates.

Original feed/ranking seeds also live in the durable `discovery_seed_queue`, with separate identity key spaces. Feed identities deduplicate for 300 seconds. Native qualified ranking seeds are ready for the first scan immediately. The countdown is an eligibility-cache TTL (180 seconds when absent), not an initial delay; the existing local 600-second duplicate minimum is extended by a longer countdown. Older pending delays are repaired only when an eligible candidate is reobserved in its own run, never by waking paused jobs or stealing active claims. Claim, lease, release, and recovery state survives daemon restarts, and a single-flight sweep scans due ranking work every five minutes. Queue counts and checkpoints prove persisted scheduling only; they do not prove a country passed real TikTok E2E.

For TikTok multi-country discovery, `filters.countryCodes` contains one to three unique ISO country codes and preserves their requested order. `filters.countryCode` remains accepted for old single-country callers; a normalized run stores the equivalent one-item `countryCodes` set. Supplying conflicting plural and singular values is invalid rather than silently choosing one. Each country must belong to the configured broad `marketRegion` and resolve to exactly one verified `collectionLanes` entry. This reproduces the original distinction: its three proxy rows could carry different member-country `CountryCode` values, while all three rows' `CountryData.Code` broad-region values had to match.

Important result fields include:

- `received`: source rows processed, including rows already known locally.
- `new`: newly created stable candidates.
- `duplicate`: rows resolved to an existing stable candidate.
- `expected`: source-reported total when available.
- `result.reason`: configured limit, source exhaustion, cancellation, no results, or another explicit completion reason.
- `result.selectionComplete`: the configured bounded selection was filled (or the filtered source ended first).
- `result.sourceReconciled`: every row in the filtered svip result was returned and its count reconciled; this is stricter than a bounded selection.
- `result.completionScope`: `source_reconciled`, `configured_candidate_limit`, `partial_source`, or the bounded TikTok discovery scope.
- `reconciliation`: expected-versus-fetched comparison for paginated legacy imports.

Normal regional jobs are continuous when both `maxCandidates` and `maxFeedRounds` are omitted. Their per-processor status and durable progress remain observable until stop or an actionable boundary; pause/cancel preserves the unattempted short qualification tail. `completed` means the configured bounded run completed, not that every creator on TikTok was enumerated. A completed `regional_gift_ranking` run is a bounded ranking snapshot, not a globally exhaustive TikTok census. If the ranking adapter reports `capability_not_ready`, the run is partial/unavailable; it must not silently become a `public_live_cards` run.

For a TikTok candidate handoff, every selected row must have a same-run official collection-backstage `available` result under a market-matched preflight. An unresolved, region-mismatch, or other ineligible row makes the whole handoff fail; it is not silently dropped or relabeled. A source URL or the run's selected `marketRegion` alone does not prove creator-market eligibility. The official status `0` is sufficient for that decision even when an independently observed `creatorCountryCode` remains null.

The svip API exposes a record-time range (`recordedAfter`/`recordedBefore`) but no independently verified newest-first ordering contract. For “latest N”, reconcile the whole time-window result before sorting locally by `observedAt`; otherwise describe the output as N candidates from the window.

## Privacy and evidence

`preview_candidates` returns anonymous operational examples. `query_candidates` returns exact identities and records the supplied audit reason. Neither tool returns browser credentials, cookies, tokens, or local-storage values.

## TikHub leaderboard observations

`discoveryMethod: tikhub_rankings` is a separate paid snapshot source. Its high-level selectors are `tikHubRankingKind` and `tikHubRankingPeriod`; see [tikhub-ranking-adapter.md](tikhub-ranking-adapter.md). Each row retains `rankingProvider`, `rankingRequestId`, `rankingContextCountryCode`, `rankingClassType` and per-view `rankingObservations`. Context country is not creator country or board coverage. Original Mobile authorization, DataProcessor completion and recursive ranking parity remain separate.
