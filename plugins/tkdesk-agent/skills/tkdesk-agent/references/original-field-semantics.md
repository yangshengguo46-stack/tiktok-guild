# Original TKsoft field semantics

Use these meanings when translating the original desktop labels into agent inputs and evidence. They were recovered from the unpacked TKsoft 10.0 client and checked against the current LIVE Backstage frontend. Do not invent values that the current source did not return.

## Query limits and batching

- The original client forms a fixed batch of at most 30 creator handles.
- `每小时最大查询次数` (`hourly_query_limit`) is the maximum number of batch qualification queries in the hourly window. It is not a number of creators and is not a delay in seconds.
- `24小时最大查询次数` (`daily_query_limit`) is the equivalent batch-query allowance over 24 hours. Static client evidence does not prove whether the server uses a rolling window or a fixed reset boundary.
- `Time` in a limited response is the cooldown/wait duration in seconds; it is a separate field from both maximum-query counts.
- The original client checks the limit once before a 30-handle batch and records one `/sum` event after the batch. `/sum` carries only the region, not the number of creators. Therefore one batch request is the client-observable accounting unit.
- TKDesk `check_candidate_qualifications` with `operation: automatic_query` makes at most one child-backend request, accepts at most 30 stored candidates, and never retries automatically, including after a manual verification succeeds. A challenged request may still consume an allowance, so require another explicit user-requested call rather than assuming it was free. With `operation: manual_import`, it instead associates 1–30 structured official results that the user already queried themselves to a regional semi-auto run; this local write performs no child-backend request and consumes zero allowance. The current official startup response does not expose the old vendor's numeric hourly/daily maxima, so those maxima remain unknown rather than being fabricated locally.

## Rank scores called “diamonds”

The original UI's “钻石” labels carry TikTok LIVE leaderboard `score` values. They are not a wallet balance, cash amount, or demonstrated one-to-one payout unit; the client performs no score-to-diamond conversion. TKDesk stores this source class as `unknown_rank_score` unless an independent source explicitly proves a diamond-denominated value.

- `当前钻石` / `zb_zuanshi` = `CurrentScore` exactly as returned.
- `zb_zhoubang` = `TopScore`. Its visible label changes by region and may mean an hourly, daily, or weekly period score; it is not universally a weekly score.
- `zb_pm` = `HistoryRankScore` in the desktop pipeline.
- `zb_bak` = the maximum of `HotListScore`, `RankRecordScore`, and `RankingScore`.

Store these as raw rank-score evidence with an observation time, source, ranking period/subtab when present, and a ranking scope kept separate from creator country. If the active source did not return the score, preserve `null`. Do not apply the deployment's 100-diamonds-per-USD estimate to these raw scores.

## Original filters and modes

- `粉丝限制` uses the creator account's follower count (`follower_count`) and applies the configured minimum/maximum range.
- `带货过滤` / `FilterSeller` means exclude creators whose source signal has `has_commerce_goods`; it does not mean “keep only sellers.”
- `优质模式` is a score threshold, not a DOM label. A creator passes when at least one of `CurrentScore`, `HistoryRankScore`, `HotListScore`, `RankRecordScore`, or `RankingScore` is `>= 10`; all five below 10 are filtered. `TopScore` does not participate.
- `半自动模式` is a workflow switch. In the original client it bypasses automatic guild-backend orchestration and processes a selected-region list; it is not a creator attribute or qualification result. TKDesk therefore leaves candidates `not_queried` until the user manually checks the official collection sub-backend. A structured result import changes only the run-scoped qualification projection to `manual_imported`, preserves raw numeric codes and fixed provenance, consumes no query budget, and stops before qualification-driven ranking expansion.

## Other original desktop controls

- `使用代理登录` is a login/network routing switch, not a creator filter.
- The original desktop exposes three `代理地址` / `端口` / `选择国家` rows. `DisplayName` is the country label selected in one row. `loadCountryData` resolves it with `GetCountryByDisplayName` into a `CountryData` record. In that record, `Code` is the broad grouping/market code such as MENA or CCA, while `CountryCode` is the selected member-country code used by that lane. `StartButtonHandler` compares the three records' `Code` values—not their `CountryCode` values—and emits `选择国家不一致` only when the rows cross broad-market groups. Thus SA, QA, and EG may occupy the three rows together because they share MENA, while each row still uses its own country-matched proxy. The separate `后台国家与选择国家不一致` branch validates the collection backend's selected broad market against that shared `Code`.
- `IncludeCode` is a separate field in the recovered country-data structure. It is not the equality operand in `StartButtonHandler` and must not be substituted for either the broad-group `Code` or the per-lane `CountryCode`. The three-way meaning is therefore: `DisplayName` selects a country, `CountryCode` preserves that country for the lane, and `Code` proves that all three countries belong to the same broad market.
- Consequently, the original binary already has three simultaneous member-country proxy lanes within one broad region. TKDesk's `collectionLanes` contract reproduces that meaning as one atomic `{countryCode, proxyServer}` item per target country, ordered as WorkID 1–3. SA, QA, and EG use one independent US TikTok-discovery endpoint plus those three target-country endpoints; the collection sub-backend shares WorkID 1. Keep broad market (MENA/CCA), TikTok discovery egress, sub-backend/WorkID-1 egress, every lane's country/exit, and source-returned creator country separate.
- `开始` / `停止` control the collection workflow.
- `采集数` is a running output counter, not a target-count input. The automatic qualification batch size is the hard-coded maximum of 30.
- The date/time controls belong to `清理数据` and select a deletion cutoff. They are not a “recent N hours/days” discovery window.
- The original desktop task settings do not expose creator keywords, gender, language, maximum scrolls, concurrency, a configurable score threshold, or an invitation/message-send toggle.

Username, password, and remember-password belong only to the legacy vendor login. TKDesk never asks an Agent to collect or expose them.

## Current collection-sub-backend qualification codes

The current official LIVE Backstage frontend maps `AnchorStatus` as follows:

- `0`: `available`
- `1`: `not_found`
- `2`: `region_mismatch`
- `3`: `ineligible`
- `4`: `not_access_live`
- `5`: `unavailable`
- `6`: `invitation_type_not_available`
- `7`: `quota_limit`

`quota_limit` is not a negative creator decision. Store it with `eligible: null` and mark the qualification batch incomplete; do not discard the creator as ineligible.

For status `3`, `DisplayReason` refines the reason:

- `0`: unknown reason
- `1`: follower limit exceeded
- `2`: already signed with another agency
- `3`: other reason
- `4`: multiple-account risk
- `5`: unsupported location
- `6`: inappropriate content
- `7`: insufficient historical content
- `8`: BRIC/multiple-account risk
- `9`: already in an invitation process
- `10`: content violation

Invitation-type codes are preserved separately: `0 standard`, `1 classic`, `2 premium`, `3 regular`, `4 elite`, `5 high-follower`, `6 premium-ticket`.

These official `AnchorStatus` values are not the same schema as legacy svip `zb_yqType` values. Always retain the raw code alongside the mapped label and the qualification observation time.
