# TikHub leaderboard source

TikHub is a separate paid discovery provider, selected explicitly through the existing durable TKDesk tools. It does not replace or unlock the original four-list MobileProcessor. Existing original regions and their default workflow remain available.

## Start a bounded snapshot job

1. Read `status.capabilities.discovery.tikhubRankings`. `state: configured` means the private local provider configuration is readable; it does not prove live API permission, balance, freshness or country coverage. Missing/invalid configuration is a named dependency. The normal Agent never reads its key or sends TikTok session material to the provider.
2. Reuse the verified collection route and logged-in profiles. Follow the two existing startup skills before an actual full-auto qualification query. Their zero-query readiness check can reuse a successful initialization for the same route and current page; do not replay the random-letter lookup unnecessarily.
3. Create a run with the following shape, then use `start_run`, `get_run`, `preview_candidates`, and audited `query_candidates`. There is no custom frontend and no model-driven polling loop.

```json
{
  "source": "tiktok_live",
  "mode": "full_auto",
  "filters": {
    "discoveryMethod": "tikhub_rankings",
    "marketRegion": "MENA",
    "countryCodes": ["SA"],
    "tikHubRankingKind": "league",
    "tikHubRankingPeriod": "current",
    "maxCandidates": 10
  }
}
```

Use the actual active route's market and countries. The daemon chooses one previously collected creator with a confirmed creator country and nonzero anchor/room IDs per selected country, then freezes those context seeds in this run. Missing context returns `tikhub_context_seed_missing`; collect an ordinary regional Feed sample to obtain a seed after explicit user selection of that source. Never silently use TikHub's default sample anchor/room.

`full_auto` discovers, deduplicates and performs the same official collection-backstage qualification. `semi_auto` discovers and stores only. Neither mode performs original Mobile ranking recursion or claims original DataProcessor completion. The provider fetch itself sends only the user's provider API key, and the same existing Chrome login/verification requirements still govern official qualification.

## Selectors and scope

| Setting | Fixed provider request |
|---|---|
| `tikHubRankingKind: daily` | `rank_type=8` |
| `tikHubRankingKind: league` (default) | `rank_type=16` |
| `tikHubRankingPeriod: current` (default) | `gap_interval=0` |
| `tikHubRankingPeriod: previous` | `gap_interval=-1`, provider ranking record |
| `tikHubRankingPeriod: both` | one current and one previous request per context seed |

`region_type=1` and the API endpoint are fixed internally. `previous` is the provider's ranking-record parameter, not proof of a particular calendar date or an exact original history score. League class comes from the response and is retained as `rankingClassType`; the Agent cannot select arbitrary class codes. Each job fetches at most six snapshots (three context seeds × two periods). It stops when its local candidate cap is met. It does not refresh forever.

`maxCandidates` defaults to 100. It limits the local unique selection, not how many rows TikHub returns or its per-request charge. The backend preserves response rank/order for its selection, but the returned rows do not prove full-board or all-country coverage. Apply only supported `minFollowers`/`maxFollowers` filters; unavailable follower evidence cannot pass a requested bound. Original high-quality and seller filters are unavailable on this source. No paid profile-enrichment calls are added automatically.

## Results and recovery

- Read `rankingProvider`, `rankingRequestId`, `rankingContextCountryCode`, `rankingClassType`, `rankingSource`, rank, raw score, ranking period, timestamps and `rankingObservations`. Current/history observations of an overlapping handle remain separate. Numeric IDs use exact string fields; unsafe numeric scores stay unknown. Scores never become diamonds, USD, quality or invitation eligibility without additional evidence.
- A context country is the seed's confirmed country. It is not board scope or every listed creator's country. Missing row country remains unknown. The official backend's `available` decision remains necessary for a handoff; provider rankings alone do not grant eligibility.
- Every potentially paid fetch is checkpointed before dispatch. Resume uses committed snapshots without repeating their requests. An `attempted` snapshot has an uncertain or failed outcome and stops with `tikhub_paid_attempt_unresolved`; it never automatically replays. Report it and obtain fresh user authorization before creating a new paid attempt.
- Permission, rejected key, balance, rate-limit, transport, upstream-business, wrong-board and malformed-response failures remain explicit errors. A nonempty board with unusable/masked identities is a failure, not an empty successful list. Provider error bodies may echo credentials; only fixed safe errors reach tools, audit and logs.

Source contract: [TikHub daily rank endpoint](https://docs.tikhub.io/186826138e0), [official SDK and OpenAPI](https://github.com/TikHub/TikHub-API-Python-SDK).
