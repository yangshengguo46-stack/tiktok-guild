# Collection business policy

Read this reference when configuring automatic creator collection, local query budgets, region routing, or business-facing qualification labels. These are user-confirmed operating rules for this deployment. They are not claims about TikTok's public platform limits, payout contract, or undocumented qualification thresholds.

## Workflow mode

- The selected operating mode is `full_auto`: discover candidates, deduplicate them, submit bounded batches to the dedicated creator-collection sub-backend, and classify the returned qualification evidence.
- For `tiktok_live`, the default full-auto discovery method is `regional_gift_ranking`. It may be called operational only after this installation has captured a real, non-empty, trusted list-producing response; before that, status is `calibration_required`.
- When explicitly requested, `public_live_cards` may run as a separate `full_auto` candidate source: bounded public LIVE-card capture, deduplication, then official collection-sub-backend qualification. This does not need mobile ranking authorization, does not expand gift rankings, and never counts as regional-chain parity. It is never an automatic downgrade when `regional_gift_ranking` is unavailable, incomplete, challenged, or incompatible. Preserve the actual card source and observation time on each row. After a market-matched backend preflight, official `AnchorStatus=0` (`available`) is the invitable decision; a public card's creator-country field may remain unknown and must not be invented or treated as a separate mandatory proof.
- `full_auto` ends at qualification and list preparation. It never sends an invitation, contacts a creator, operates the guild-wide backend, or bypasses a CAPTCHA or other security check.
- Use the user-selected mode. Authorized regional full-auto can run the available PC pipeline when `regionalGiftRanking.pcAutomationAvailable` is true and route, official sessions and backstage preflight are ready. `modes.full_auto` / `operationalReady` retain stricter complete-chain evidence and do not globally block available PC collection. A calibration probe is an optional bounded diagnostic, never a mandatory permission gate. Missing Mobile access stays an explicit branch gap. The separate public-card source is selected explicitly; queued tasks and fixtures are not live capture evidence.
- When the user explicitly chooses the original `semi_auto` workflow, discovery stops before automatic qualification and recursive ranking expansion. The user may manually query the official collection sub-backend and locally import 1–30 structured official result rows. This import is run-scoped, handle-exact, atomic, budget-free, and never authorizes an invitation or expansion request.

## Batch size and local query budgets

- One qualification request contains `1` to `30` unique creator handles. A partial batch still consumes one batch-query allowance.
- A semi-auto `manual_import` is not a qualification request: it records results of the user's already-completed official manual query, inserts no qualification-attempt row, and consumes zero hourly or rolling-24-hour allowance.
- Count attempted batch requests, not creators. A timeout, transport ambiguity, or manual-verification response may already have consumed an allowance and must not be retried automatically.
- Hourly operating target: use `50` to `55` batch requests during an active hour. The hard local ceiling is `55` requests in any locally enforced hourly window.
- 24-hour operating target: use `145` to `150` batch requests. The hard local ceiling is `150` requests in any locally enforced rolling 24-hour window.
- The 24-hour ceiling always dominates. The hourly range is a burst ceiling for an active collection period, not a target to repeat every hour.
- Keep each request `60` to `80` seconds apart. Select a ceiling/target inside the stated ranges and vary only downward; never add capacity above that selected amount or either hard ceiling. Pacing variation is ordinary rate control; it must not rotate accounts, evade verification, or bypass a backend restriction.
- The official reset boundary is not proven. Until the active sub-backend exposes an authoritative window, treat these as conservative local rolling-window guards and persist every attempted batch with its timestamp and outcome.

## Market, country, and proxy routing

Keep these routing concepts separate:

1. `marketRegion`: the broad guild market, such as `MENA` or `CCA`; one market can contain multiple countries.
2. `discoveryCountry` and the discovery-browser proxy endpoint: the independent TikTok account route. In this deployment its exit remains `US` while MENA countries are collected.
3. `countryCodes`: the one-to-three target countries selected for the current collection run. Legacy `countryCode` is accepted only as a single-country alias.
4. `collectionLanes`: one-to-three atomic `{countryCode, proxyServer}` route items. Array order assigns WorkID 1–3. A country may occur only once, proxy endpoints must be distinct, and each observed exit must equal its own declared `countryCode`.
5. `backstageCountry`: a legacy route alias for `collectionLanes[0].countryCode`. The collection-backstage browser uses that first lane's endpoint. The broad market selected or observed inside the sub-backend remains separate evidence.
6. `creatorCountryCode`: source-returned evidence about an individual creator; never copy it from route configuration.

For SA, QA, and EG, keep four endpoints online: one independent US TikTok-discovery endpoint plus one country-matched endpoint for each of SA, QA, and EG. Feed rows with `WorkID=1/2/3` stay on the correspondingly ordered country lane through initial enrichment and ranking. Ranking-derived `WorkID=4` rows preserve their ranking-scope country and use its matching verified lane; original `MobileSettings[0]` is not assumed to be US. Qualification uses the authenticated collection-sub-backend browser on WorkID 1's endpoint. Recheck the US discovery exit and every selected country lane before a full-auto run and before each qualification batch. A route/creator/backend market mismatch is real evidence and must not be hidden by relabeling a proxy.

This routing reproduces the original three-lane meaning. Static reverse evidence from TKsoft 10.0 shows that `GetTaskSettings` constructs exactly three proxy rows and `loadCountryData` resolves each row's country `DisplayName` into a `CountryData` record. `StartButtonHandler` compares the records' `Code` field, which is the broad market/group code such as MENA or CCA—not the member-country ISO code. `选择国家不一致` therefore means the three selected countries do not belong to the same broad market; it does not require all three rows to select the same country. Each row retains its own member-country `CountryCode` and proxy, so SA, QA, and EG are valid together when their `Code` is MENA and each proxy exits through its declared country. The separate `后台国家与选择国家不一致` check compares the collection backend's selected broad market with that shared group code. Keep broad-market compatibility and per-lane country/exit matching as two distinct validations.

## Diamond signals and USD estimate

- Preserve every TikTok LIVE leaderboard value as raw score evidence, including its score type, period, source, ranking scope, and observation time. Its unit remains unknown unless the source explicitly identifies it as a diamond-denominated field.
- For this deployment, `100` diamonds is treated as approximately `1 USD` for business estimation only. An optional estimate may be calculated as `estimatedUsd = diamondValue / 100` only for an explicit diamond-denominated source field.
- Mark the result as approximate and record the policy basis (`diamondsPerUsd: 100`). Never overwrite the raw value or describe the estimate as wallet balance, payout, settlement income, or an official TikTok conversion guarantee.
- A leaderboard `score` with unknown unit must not get a USD calculation, even if its original UI label says “钻石”.

## Invitation lane and final qualification

- Fewer than `1,000,000` observed followers gives a business expectation of the ordinary/regular invitation lane.
- More than `1,000,000` observed followers gives a business expectation of the advanced invitation lane.
- Exactly `1,000,000` followers is an intentional boundary case. Do not infer ordinary or advanced; keep the lane unresolved until the dedicated collection sub-backend returns its decision.
- Missing follower count is also unresolved. A follower-based expected lane is advisory metadata, never a replacement for `AnchorStatus`, `DisplayReason`, or the backend's allowed invitation-type codes.
- TikTok LIVE also applies a diamond-income ceiling. A creator above the applicable ceiling may be treated as a platform creator and unavailable for agency signing, but the threshold and applicable period are not hard-coded here. The collection sub-backend is authoritative.
- “Insufficient duration” means the creator has not met the required live-duration condition. The duration threshold is likewise unknown locally and must be decided by the collection sub-backend.
- Do not infer `platform_creator`, `diamond_limit_exceeded`, or `insufficient_duration` from leaderboard scores or locally observed minutes unless the backend returns an explicit corresponding decision. Preserve an unknown or generic ineligible result when no specific reason is exposed.

Keep business expectations, legacy vendor labels, and current collection-sub-backend qualification observations in separate fields. The latest backend observation may refine a candidate's status, but it must not erase the discovery evidence or the raw values used to form an earlier expectation.

## Continuous core and original catalog (2026-09-26)

Normal regional full-auto may start the available PC pipeline after verified routes, authenticated discovery/backstage and official preflight. Missing Mobile authorization does not block that pipeline; complete-chain live validation stays separate. The Agent selects settings and start/stop/status, while the program owns queues and timers. Omitting maxCandidates/maxFeedRounds means continuous operation; explicit bounds identify diagnostics. Preserve all 36 display configurations, 27 groups and 146 countries/territories; one to three lanes limit concurrency only. Use original_country_catalog and the optional countryDisplayNames whitelist. Stop never flushes the fewer-than-30 unattempted qualification tail; a deliberate bounded source completion may do so.
