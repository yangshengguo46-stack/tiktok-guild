# TikTok regional gift-ranking adapter

Read this reference when a `tiktok_live` run uses `regional_gift_ranking` or when interpreting its evidence.

## Purpose and boundary

`regional_gift_ranking` is the intended full-auto TikTok LIVE discovery method. It implements the active data flow confirmed from the original program rather than passively watching a visible ranking UI:

```text
one-to-three country-matched PC-Web LIVE feed workers plus each selected display variant's fixed MobileProcessor lists (WorkID 1/2/3)
  -> merged room/anchor seeds with Top/History/HotList/RankRecord source scores
  -> local HMD replacement and DataProcessor enrichment
  -> collection-sub-backend qualification (<=30 per request)
  -> only available / AnchorStatus=0
  -> fixed rank-list requests for gap 0 and -1
  -> new ranking seeds (WorkID 4)
  -> local HMD replacement and ranking-scope country-lane enrichment
  -> recursive qualification and ranking expansion
```

Normal regional collection is continuous. Explicit candidate/Feed-round bounds are diagnostic controls; the Agent does not run its internal loop. It is not a broad crawler, a guild-wide backend operator, or a public-LIVE-card fallback. It preserves projected candidate/ranking evidence and safe request semantics, but never persists a raw signed URL, complete query, authorization header, cookie, or token.

In original `semi_auto`, the Feed/fixed-four-list discovery and DataProcessor stages are the same, but the automatic collection-sub-backend and qualification-driven recursive-expansion stages are absent. TKDesk persists those discovered candidates as `not_queried`. After the user manually queries the official collection sub-backend, the existing high-level `check_candidate_qualifications` tool accepts `operation: manual_import` with 1–30 structured numeric result rows. It NFKC/case-normalizes each handle, requires one exact candidate in the same run, derives labels only from the fixed official code tables, and stores raw codes plus `official_collection_backstage_user_query` provenance. It creates no qualification-request reservation, changes budget usage by zero, performs no browser/network operation, never retries, and does not enqueue or sweep a ranking seed. Any unknown, ambiguous, cross-run, repeated, conflicting, or unknown-code row rejects the entire import.

## Current Feed compatibility (2026-09-26)

The archived V10 endpoint/source now returns business `10011 / Request params error`. A controlled SA-lane comparison preserved the original locale, country parameters, discovery session, and HTTP transport: changing the host alone still failed; the official current recommendation source (`webcast.tiktok.com`, channel `87`, `req_from=live_mt_pc_web_rec_tab_refresh`) returned code `0` and six rooms. Feed adapter v4 therefore fixes those runtime fields internally. The archived 36-variant catalog remains unchanged; the runtime profile reports current and original channel sets separately. This is an explicit platform compatibility change, not a claim that the original five-channel rotation still works. No signed URL or browser-generated token was copied. Country routing and the downstream V10 processing chain remain program-owned; the skill only selects settings, starts/stops, and reads results.

## Confirmed original schedule and deduplication

1. The original starts one PC-Web worker for each of its three proxy slots and assigns `WorkID=1/2/3`. Every worker uses the fixed `https://webcast.us.tiktok.com/webcast/feed/` endpoint plus the selected original display variant's fixed public query profile, and varies `channel_id` only within `21`, `1`, `2`, `3`, or `44`. TKDesk preserves all 36 display variants, 27 route groups, and the source-defined locale/region differences instead of reusing the MENA query everywhere. Each slot resolves its selected country `DisplayName` to a `CountryData` record. `StartButtonHandler` requires the three records' broad-group `Code` values (for example MENA/CCA) to match; it does not require their member-country `CountryCode` values to be identical. The slots can therefore be SA, QA, and EG simultaneously, with one country-matched proxy per slot, because all three belong to MENA.
2. The feed projects room ID, anchor/user ID, handle, `secUid`, follower count, viewer count, and any creator-country evidence. Feed seeds are identity-deduplicated for exactly 300 seconds before the HMD/DataProcessor/qualification chain.
3. Qualification uses the dedicated collection sub-backend in batches of at most 30 creators. Every submitted batch consumes one persisted rolling-budget request. Only rows mapped to `qualificationStatus=available` with raw `AnchorStatus=0` may become ranking-expansion seeds; unresolved or ineligible rows do not enter the rank loop.
4. Each eligible seed is queried against the fixed rank-list endpoint profile selected from its original route/country configuration, with `anchor_id` and `room_id`. For WorkID 1–3, the request returns to `ProxySettings[WorkID-1]`, and both gap requests remain on that same lane. The request semantics are fixed internally to `rank_type=16`, `region_type=1`, and the pair `gap_interval=0` then `gap_interval=-1`.
5. A ranking result produces additional creator seeds. Original `RankingProcessor.processRankingDataWithGap` creates these rows from a template whose `UserData.WorkID@0xd8` is `4`; it does not inherit the parent row's WorkID. They re-enter Extra/HMD -> DataProcessor, where original WorkID 4 selects `MobileSettings[0]`. Static evidence does not prove that this fallback is a US node. TKDesk therefore preserves the ranking-scope country and binds WorkID 4 to that country's verified lane, failing closed if the mapping is absent or ambiguous, before qualification and recursive ranking. Its first eligible expansion is immediately ready for the next scan. The positive countdown (otherwise 180 seconds) controls eligibility-cache lifetime, not a delay until first expansion. The local independent duplicate fence is at least 600 seconds and extends to a longer countdown. This is a separate key and TTL from the feed's 300-second seed deduplication.
6. The durable ranking queue is scanned every five minutes. Unseen seeds re-enter the same local HMD replacement -> DataProcessor enrichment -> qualification -> ranking path until the configured candidate bound, quota, stop state, authentication boundary, or another real terminal condition is reached.

TKDesk preserves the original ordered WorkID affinity: a run selects one to three unique `countryCodes`, every selected country belongs to the configured broad `marketRegion`, and each country maps to exactly one `collectionLanes` proxy in the same order. WorkID 1–3 are ordered member-country lanes inside one shared market group.

The independent US TikTok-login browser and the country network lanes remain distinct. Static inspection of the user-provided TKsoft 9.9 executable confirms that `GetTaskSettings` reads discovery browser cookies and `PcWebProcessor.worker` installs them into its HTTP cookie jar. PC Feed therefore declares `requiresAuthenticatedSession=true`, `sessionTarget=tiktok_discovery`, and `sessionBinding=discovery_cookie_country_http_lease`. SessionManager privately reads only discovery-owned TikTok cookies and creates an execution-owned HTTP jar on the exact verified WorkID country proxy. It checks authenticated session ownership, the US discovery route fingerprint, the country slot, and its observed exit before reading cookies or dispatching. Cookies remain in memory; PC and Data have independent jars per physical country lane, response cookies survive subsequent requests, every response buffer is disposed, and the jars drain and close at the execution boundary. No persistent browser/profile, credential file, database, log, or MCP response receives them. Cookies from collection_backstage, guild-owner, broker, or supplier sessions are never used. Missing login, route drift, redirect, or challenge fails closed; no cookie-free browser or US-page fallback is permitted.

Basic, Country, RoomEnter, and Level still use the earlier unauthenticated country-worker transport and are not yet revalidated against 9.9's session behavior. Do not describe them as fully original-equivalent. This Feed correction does not substitute Web cookies for mobile authorization, prove the complete ranking chain, or authorize arbitrary URL/header requests. The generic authenticated page request path continues to require the exact browser proxy; only the fixed PC Feed has the explicit internal country-HTTP lease above. The backend owns collection and filtering; Skill/MCP controls settings, start/stop and status, not per-creator model decisions.

The original also placed a 20-handle `HmdProcessor` before TikTok enrichment. Reverse inspection shows that it POSTs `{region,hmd:[DisplayID...]}` to the supplier account's relative `/update` endpoint and treats the returned `bmd` list as a vendor allowlist. A handle omitted from `bmd` is written to a 48-hour suppression key. This is the supplier's private gate, not a TikTok or collection-sub-backend requirement, and the later batch-check request needs only `DisplayIDList`. TKDesk therefore replaces that gate with local durable deduplication/pass-through rather than copying the supplier login. This intentionally drops the supplier's private denylist/quality signal while preserving every field required by the authorized collection sub-backend.

## Confirmed original `DataProcessor` order

After the HMD gate, the original starts four `DataProcessor` consumers. These are concurrency workers, not proxy slots. Feed rows carry WorkID 1–3 and select `ProxySettings[WorkID-1]`; ranking-derived rows carry WorkID 4 and select original `MobileSettings[0]`, whose country meaning is not proven. TKDesk maps that fallback by the preserved ranking-scope country. A consumer processes one copied `UserData` row in this order:

1. Fetch basic room/user data.
2. Apply the configured follower minimum/maximum filter.
3. Fetch the room's country code.
4. Require the returned country to match the country declared by that row's WorkID lane.
5. If missing, run the three candidate-specific ranking enrichments: Ranking, Top, and conditional History. Preserve HotList/RankRecord values prefilled by the earlier MobileProcessor list merge; do not request those lists again per candidate.
6. Fetch room-enter data only when the row entered the worker with `RoomID != "0"`.
7. Fetch anchor level for every surviving row.
8. Apply the local seller/high-quality filters, then emit the row into the next LIVE/qualification stage.

The recovered internal `UserData` layout corroborates the ordering and assignments: `DisplayID@0x00`, `RoomID@0x10`, `UserID@0x20`, `SecUID@0x30`, `Region@0x40`, `Host@0x50`, `TopCode@0x60`, `Tag@0x68`, `CurrentScore@0x70`, `TopScore@0x78`, `HistoryRankScore@0x80`, `HotListScore@0x88`, `RankRecordScore@0x90`, `RankingScore@0x98`, `Ranking@0xa0`, `Follower@0xb0`, `UserCount@0xb8`, `LiveTime@0xc0`, `AnchorLevel@0xc8`, `WorkID@0xd8`, and `Countdown@0xe0`.

### Dynamic request inputs and response mappings

- Basic data is `GET https://www.tiktok.com/api-live/user/room/` with the original fixed Web query profile and dynamic `uniqueId=DisplayID`. It maps `data.user.roomId -> RoomID`, `data.user.id -> UserID`, `data.user.secUid -> SecUID`, and `data.stats.followerCount -> Follower`. If and only if the input row's pre-request `RoomID` was not `"0"`, it also maps `data.liveRoom.startTime -> LiveTime`.
- Country data is `GET https://webcast.us.tiktok.com/webcast/gift/list/` with dynamic `room_id=RoomID`. It maps `data.pages[0].region -> Region`. An empty `pages` array is not treated as a request/decode error, but leaves no matching country evidence; the immediately following country-match filter therefore rejects the row.
- Before HMD/DataProcessor, `MobileProcessor.processRequests` makes the four logical country-level requests labeled exactly `TopURL`, `HistoryRankURL`, `HotListURL`, and `RankRecordURL` (History is absent for TopCode 1, so that variant makes three network requests). These requests use the selected display variant's internally compiled non-credential numeric scope and the user's opaque authorization lease; the scope is never exposed through MCP. The original stores the extracted `DisplayID` at `UserData@0x00` and uses that same string as the four-list map key; the label determines which of `TopScore`, `HistoryRankScore`, `HotListScore`, or `RankRecordScore` is prefilled. TKDesk normalizes that handle as the primary merge key and treats stable user/room identifiers only as conflict-detecting aliases. A missing source row remains unknown, and a conflicting identity link fails closed.
- Inside DataProcessor, `fetchRanking` runs when `Ranking` is empty and maps the decoded rank row into `Ranking` and `RankingScore`, plus response `Countdown`. A missing response title retains the original `未知` sentinel with explicit `original_unknown_sentinel` evidence; it is never presented as a source-supplied title. `fetchTopScore` runs when `TopScore == 0`; `fetchHistoryRank` runs only when `HistoryRankScore == 0 && TopCode != 1`. Thus a fixed-list Top/History prefill is preserved and not requested again, while zero remains the original missing sentinel. These three use the candidate's own anchor/room identity. DataProcessor contains no HotList/RankRecord fetch. The later RoomEnter stage separately produces `CurrentScore`, for six score fields in total.
- `TopCode` comes from the selected original country configuration. It is not sent as a query parameter. TopCode 1 selects Top rank type 0/gap 0 and skips History; TopCode 2 selects rank type 8 with Top gap 0 and History gap -1; TopCode 3 selects rank type 1 with those same gaps. In the inspected sample MENA and TR are TopCode 1, the other 34 display records are TopCode 2, and the executable TopCode 3 branch is retained although the sample contains no such record. See [original-country-catalog.md](original-country-catalog.md) for all 36 display variants and 27 route groups.
- Room-enter data is `GET https://webcast.us.tiktok.com/webcast/ranklist/online_audience/` with `aid=1988`, dynamic `anchor_id=UserID`, and dynamic `room_id=RoomID`. It sums every `data.ranks[].score` into `CurrentScore`. It maps `data.total -> UserCount` only when the input `UserCount <= 0`.
- Anchor level is always requested from `GET https://webcast.us.tiktok.com/webcast/user/` with the fixed Web query profile and dynamic `target_uid=UserID`. Among the returned badges, the original selects a badge with `priority_type == 20 && scene_type == 8` and maps `privilege_log_extra.level -> AnchorLevel`. If no badge matches, `AnchorLevel` is the string `"0"`, not missing evidence.

The stage placement of follower-range, country-match, seller, and high-quality filtering is confirmed. Their business meanings remain those in [original-field-semantics.md](original-field-semantics.md); this reverse pass does not invent any additional condition. In particular, seller filtering excludes the source `has_commerce_goods` signal when enabled, and high-quality mode evaluates its documented five score fields after enrichment.

The original worker retries more aggressively than TKDesk: `sendRequest` has three transport attempts, while a returned enrichment error causes the worker to wait two seconds and process the same row again, making the row-level loop effectively unbounded. TKDesk deliberately does not reproduce that availability hazard. It uses a single or explicitly bounded attempt, keeps non-required missing enrichment as `null` where safe, and otherwise records a real partial/authentication/route/shape failure. It never silently loops a row forever or replays a qualification allowance.

These TikTok calls are enrichment, not a prerequisite for `batch_check_anchor`. TKDesk keeps fields already present in the Web feed (IDs, handle, followers, viewers, commerce flag, hashtag, and observed creator-country evidence); only the supplier-independent qualification request determines availability.

The derived ranking view is always `top` for this adapter. Callers do not choose or pass `rankingViewKind`, ranking period, subtab, rank type, region type, gap interval, endpoint, headers, or proxy. Unknown/partial request semantics and an incomplete `0/-1` pair fail closed. The original bundle's separate `TopCode` selects the Top/History request contracts above; it does not replace the independent rank-type-16 expansion request.

## Fixed route and country evidence

The active TKDesk run requires one independent US TikTok-discovery endpoint and one verified endpoint per selected country, up to three country lanes. Its fields must remain distinct:

- The isolated TikTok account browser remains on the independent US discovery route. The collection-sub-backend browser shares WorkID 1's country-matched endpoint.
- `collectionLanes` atomically binds each unique lane `countryCode` to one proxy. Array order assigns WorkID 1–3, and a run's `countryCodes` selects one to three of those configured countries.
- Feed rows remain bound to their WorkID country lane through their first enrichment and rank pair. Ranking-derived rows reset to WorkID 4 and use the verified lane matching their preserved ranking-scope country. The collection-sub-backend qualification call uses its authenticated browser on WorkID 1's endpoint.
- SA, QA, and EG therefore require four endpoints total: US plus one SA, one QA, and one EG endpoint. This reproduces the original three-slot country topology: every slot has its own member-country code and node, while all three countries share the MENA broad-group `Code`.
- `marketRegion` is the selected original route-group scope (for example MENA or CCA). `region_type=1` is TikTok's scope enum, not an ISO country code.
- A verified target-country exit proves request routing, not an individual creator's country.
- Creator country is populated only from creator/row evidence returned by TikTok; otherwise it remains `null`.
- The sub-backend's broad-market selection/evidence is separate from browser egress. Do not turn WorkID 1's network route into creator-country evidence.

Operational validation is bound to the active route profile, market, selected `countryCodes`, ordered lane-country fingerprints, fixed endpoint profile, complete `gap_interval=0,-1` pair, and current adapter-evidence version. Changing any of those invalidates the prior complete-chain sample. Available PC automation can still start after route/session/preflight validation; complete-chain readiness stays separate. Unit fixtures and static reverse engineering alone do not establish a trusted live sample.

The production discovery summary separately records the four fixed-list labels and each list's safe row count for every WorkID lane. It reports original discovery parity only when all selected PC workers and all selected MobileProcessor bundles completed and no DisplayID/stable-ID conflict occurred. A ready PC Feed cannot hide a missing mobile authorization, route mismatch, template failure, or identity conflict; the run remains partial and cannot validate a live sample.

Operational readiness has two independent gates. `liveSampleValidated` records the route-bound successful ranking sample described above. `authorizationReady` records whether user-owned mobile ranking access is currently usable for every selected country. `operationalReady` describes the complete chain only when both gates are true. Normal `full_auto` may run available PC discovery/enrichment/qualification after route, login and official preflight checks even while those gates remain false. Missing Mobile access stops only that branch and cannot mark the ranking sample validated. `calibrationProbe` is an optional diagnostic.

## Mobile authorization boundary

TKDesk's `Core.tkd` encryption key is generated randomly on this Mac and stored by macOS Keychain. It is not recovered from TKsoft and is unrelated to any TKsoft username, password, decryption passphrase, or supplier credential.

The original downloaded country bundle contains a mobile `X-Tt-Token`. It is supplier authentication material: TKDesk must never copy, persist, log, expose, or replay it. A browser login cookie is a different authorization context and must not be relabeled or injected as the mobile header.

The fixed rank-list transport therefore succeeds only when a legitimate user-owned mobile authorization path is available. If it is absent and TikTok returns a login-required business status such as `20003` or `10011`, ranking expansion reports `capability_not_ready` with `ranking_mobile_authorization_required` and stops at that boundary. It must not replay supplier credentials, fabricate authorization, downgrade to a public scrape, or misreport feed/qualification rows as completed ranking expansion.

The Agent-facing surface exposes only `core_configuration_status`, `mobile_authorization_status`, and explicitly confirmed `clear_mobile_authorization`. Their schemas contain no token, cookie, header, password, credential, or arbitrary request field. User-owned access is provisioned outside the MCP transcript through the local secure-terminal path; status responses, SQLite, audit events, daemon state, and logs contain metadata only. Clearing is rejected while a collection run or qualification batch is active.

## Rank score and diamonds

The ranking result establishes that a creator appears in a gift/diamond-oriented leaderboard. Its raw `score` unit is `unknown` unless TikTok explicitly exposes a diamond-denominated value. Preserve `rankScoreRaw` and related evidence as-is. Do not calculate USD from that score.

Only a separately explicit diamond field can use this deployment's internal approximate conversion of `100 diamonds ≈ 1 USD`. That estimate is business-planning metadata, not TikTok payout, wallet, or settlement evidence.

## Failure behavior

If the fixed feed or rank response shape changes, a required country lane is unavailable, qualification is unresolved, the ranking pair is incomplete, mobile authorization is unavailable, or any fixed request semantic does not match, report `capability_not_ready` or the actual route/login/challenge/quota state. Do not silently switch to `public_live_cards`, `semi_auto`, a different country's lane, or caller-supplied request parameters.

`public_live_cards` is available only as an explicitly selected diagnostic method. Its rows are ordinary public LIVE-card observations and must not be labeled as regional gift-ranking results.

## V10 continuous core (2026-09-26 rewrite)

The fixed transport/catalog/field/filter/qualification/TTL components are retained after verification. Independent PC lane producers, Mobile120-second whole-list producers, four durable Data consumers, thirty-person Live qualification and five-minute ranking scans now run inside one daemon execution. PC queue threshold35 pauses producers in500ms cancellable slices; ordinary errors wait60seconds and success waits3seconds. Runs omit bounds normally; pause/cancel preserves the unattempted tail. Optional countryDisplayNames selects only original catalog variants and propagates through PC/Mobile/Data/Ranking. All36 configurations and147 expanded rows (146unique codes, PR overlap) have offline boundary coverage; this does not establish live success in every country. Missing user-owned Mobile access and vendor-private HMD/upload/license/Coreupdate remain explicit gaps.

The shared durable discovery queue also protects against Mobile producer overload. Its shared 35-item threshold is a local policy; original binary evidence confirms PC 35/500ms and Mobile backpressure wait3seconds, but does not yet establish the Mobile queue threshold. That remaining timing detail must not be described as verified original parity.
