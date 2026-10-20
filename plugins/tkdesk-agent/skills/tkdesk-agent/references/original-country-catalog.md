# Original country and TopCode catalog

Read this reference when choosing a market, validating member-country lanes, or interpreting `TopCode`. The catalog is a sanitized functional projection of the 36 country records in the inspected TKsoft Core sample. The transport compiles each display variant's numeric fixed-list scope (`anchor_id` and `room_id`) internally, but the Agent-facing MCP catalog does not expose those values or the complete endpoint URL. Complete supplier URLs, headers, signatures, cookies, tokens, and decrypt material are deliberately absent.

## Source field normalization

The original record does not contain a separate broad `code` plus one member `CountryCode`. Its configuration-level `countryCode` becomes TKDesk `routeCode`; member ISO codes come from splitting every comma-separated `IncludeCode` element. All 36 sample records use a one-element array containing CSV text. TKDesk preserves source-defined membership even when it looks counterintuitive.

There are 36 display variants grouped into 27 route codes:

| Route | Original display variants | Source-defined member codes | TopCode |
|---|---|---|---:|
| MENA | MENA(中东) | AE BH DJ DZ EG IQ JO KM KW LB LY MA MR OM BL QA SA SD SO TN YE | 1 |
| VN | VN(越南) | VN | 2 |
| UK | UK(英国) | CD GB GG GI IE IM JE MT SJ | 2 |
| ID | ID(印尼) | ID | 2 |
| TR | TR(土耳其) | TR | 1 |
| TH | TH(泰国) | TH | 2 |
| JP | JP(日本) | JP | 2 |
| PH | PH(菲律宾) | PH | 2 |
| FR | FR(法国) | FR BE GF MC PF RE NC TF | 2 |
| DE | DE(德国) | DE CH AT LI LU | 2 |
| LATAM | LATAM(哥伦比亚/秘鲁); LATAM(墨西哥); LATAM(其他) | AR CL PE CO EC PA BO CR UY DO GT HN VE SV NI PY PR GN MX | 2 |
| CCA | CCA(阿塞拜疆-日榜); CCA(白俄罗斯-日榜); CCA(哈萨克斯坦-日榜); CCA(吉尔吉斯-日榜); CCA(亚美尼亚/格鲁吉亚/摩尔多瓦/土库曼/塔吉克-日榜) | AM AZ BY GE KG KZ MD TJ TM UA UZ | 2 |
| IT | IT(意大利) | IT SM | 2 |
| US | US(美国); US(加拿大) | US CA AS GU MP UM PR VI | 2 |
| MY | MY(马来西亚) | MY SG | 2 |
| AU | AU(澳洲) | AU CC CK CX FJ FM KI MH NF NR NU NZ PG PN PW SB TK TO TV VU WF WS | 2 |
| TW | TW(中国台湾) | TW | 2 |
| RO | RO(罗马尼亚) | RO | 2 |
| BR | BR(巴西) | BR | 2 |
| ES | ES(西班牙) | ES AD | 2 |
| KR | KR(韩国) | KR | 2 |
| SE | SE(瑞典); SE(丹麦/挪威/芬兰/冰岛) | SE FI NO DK IS GL FO | 2 |
| NL | NL(荷兰) | NL | 2 |
| PL | PL(波兰) | PL | 2 |
| BK | BK(巴尔干) | GR HR BA RS ME SI BG AL MK | 2 |
| PT | PT(葡萄牙) | AO CV GQ GW MZ PT ST | 2 |
| HU | HU(捷克); HU(匈牙利/斯洛伐克) | CZ HU SK | 2 |

`PR` belongs to both LATAM and US in the source sample. Market context is therefore required to resolve it. Do not silently choose one. MENA includes `BL`, UK includes `CD`, and LATAM includes `GN` in the source; TKDesk records these as `source_defined_include_code` instead of rewriting the supplier's semantics.

## PC-Web LIVE feed profiles

The executable feed catalog preserves the public, non-session portion of all 36 display variants. Expanding each route against its source-defined member countries yields 147 route-country profiles (146 unique ISO-like country codes because `PR` appears in two route groups). Every profile keeps the fixed `https://webcast.us.tiktok.com/webcast/feed/` host/path, the original public base query, and the variant-specific locale/region fields; callers cannot replace the endpoint or inject a free-form query. Display variants that share a route may still differ—for example LATAM Colombia/Peru, Mexico, and other; the five CCA day-list variants; US versus Canada; Nordic variants; and the two HU variants. Odd source locale choices for BK/PT/HU are preserved as source evidence rather than silently “corrected.”

This Web feed catalog contains no cookie, token, signature, authorization header, supplier credential, or signed ranking URL. Catalog membership proves only that a fixed request profile is compiled; it does not establish that a proxy, account, response shape, or mobile ranking authorization has passed a live run.

## TopCode request semantics

`TopCode` is country-configuration data, not a caller-supplied API parameter.

| TopCode | TopScore | HistoryRankScore |
|---:|---|---|
| 1 | rank type 0, region type 1, gap 0 | skipped entirely |
| 2 | rank type 8, region type 1, gap 0 | rank type 8, region type 1, gap -1 |
| 3 | rank type 1, region type 1, gap 0 | rank type 1, region type 1, gap -1 |
| other/default | rank type 0, region type 1, gap 0 | rank type 8, region type 1, gap -1 |

The current sample uses TopCode 1 for only MENA and TR (two records); the other 34 records use TopCode 2. The executable supports TopCode 3 even though this Core sample contains no such record.

The original `MobileProcessor.processRequests` uses the selected display variant's internally compiled non-credential fixed scope to request four logical discovery lists, labeled exactly `TopURL`, `HistoryRankURL`, `HotListURL`, and `RankRecordURL`. TopCode 1 has no History list and therefore makes three network requests. The scope is never exposed through MCP. The extracted `DisplayID` string is both `UserData`'s first field and the original four-list map key; each source score pre-fills `TopScore`, `HistoryRankScore`, `HotListScore`, or `RankRecordScore` before HMD/DataProcessor. TKDesk therefore merges on a normalized handle and uses stable user/room identifiers only as conflict-detecting aliases. A conflicting cross-link is discarded rather than joining two creators. TKDesk compiles this scope for all 36 display variants; authentication still comes only from the user's own opaque authorization lease.

`RankingScore` is different: DataProcessor dynamically requests rank type 16, region type 1, gap 0 with the candidate's own anchor/room identity. If Top/History is missing on a candidate, DataProcessor also dynamically fills it according to TopCode. It does not re-request HotList or RankRecord per candidate.

Use the `original_country_catalog` MCP tool for the machine-readable version. The current runtime may support fewer operational mobile-authorization profiles than the catalog contains; catalog membership is not proof that a country is currently runnable.
