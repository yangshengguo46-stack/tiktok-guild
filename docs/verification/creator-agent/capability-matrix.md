# CreatorAgent capability matrix (Task 10)

This matrix records evidence boundaries as of 2026-09-24. Deterministic tests
prove local contracts and invariants only; they do not prove conversational
naturalness, model quality, TikTok behavior, or business results.

| Capability | Status | Evidence and boundary |
| --- | --- | --- |
| Native default-Lead social turn assembly | `verified-local` | Focused backend tests execute the native Lead path with deterministic model/channel fixtures. |
| Six immutable `1.0.1` expression personas | `verified-local` | The imported 76-file package is SHA-256 verified; the runtime loader exposes only the six bounded expression assets. |
| Automatic evidence-scoped persona adaptation | `verified-local` | Deterministic selector and runtime tests cover hold/switch, scope, provenance, and stale-fingerprint fencing. |
| Persistent social events, bindings, outbox, CAS and restart semantics | `verified-local` | SQLite-focused repository/runtime tests pass; PostgreSQL has not been exercised against a live server. |
| Authenticated social channel gate | `verified-local` | Synthetic providers cover authenticated envelopes, dedupe, no-contact, takeover, and delivery-state branches. This is not TikTok evidence. |
| Authenticated operator profile management | `verified-local` | Deterministic Gateway/tool tests cover authorization, candidate/activation, binding, clear, and rollback. |
| Development evaluation loading | `verified-local` | Offline loaders read exactly 72 social, 12 persona-profile, and 60 legacy-business inputs; grader/scenario data is a separate API and never becomes generation context. |
| Approved Guild Operator and TKDesk tool contracts | `verified-local` | Doctor validates committed ordered name/schema-digest fixtures statically and rejects forbidden outreach tool names. It does not start either MCP server. |
| Local database at migration `0026_social_runtime` | `verified-local` | Formal `init_engine('sqlite') -> bootstrap_schema` bootstrapped the isolated LangGraph-only four-table shared DB to current native head while preserving all four schemas and row counts. This was not a blind Alembic stamp. |
| Custom local `SOUL.md` preservation | `verified-local` | Restored file SHA-256 remains `3cd8a4d11d8d3cdbeb8df21f305d654926145e97f57b750316a42c9cb5798b02`, equal to the untouched backup. |
| Configured model transport | `verified-model` | Four calls diagnosed unsupported `gpt-5.4`; after the ignored start config changed to host-supported `gpt-6-sol`, the sixth call returned a real top-level response with usage. The seventh and final call reached the 30.003-second generator timeout. No platform tool was available or invoked. |
| Configured real-model profile generation and conversation quality | `blocked` | The sixth response was rejected by the strict parser because nested `style`/`response_format` overrides are not expression fields; the prompt was repaired with a flat whitelist and scalar/array contract, then the seventh and final call timed out with `invalid generator response`. No candidate was activated; the sixth raw/usage evidence is preserved and WP1 multi-turn remains unrun. See `2026-09-24-task8-configured-model-probe.json`. |
| PostgreSQL transaction/locking behavior | `blocked` | SQL branches are covered deterministically, but no live PostgreSQL integration was available. |
| Real TikTok inbound identity and message receipt | `unverified-external` | No authenticated TikTok provider, stable sender identity, or real inbound event evidence exists. |
| Real TikTok outbound message sending | `unverified-external` | No authorized production sender or provider acceptance evidence exists. Drafts and synthetic sends are not sends. |
| Real TikTok formal invitation | `unverified-external` | No authenticated invitation channel, authorization, dedupe, or platform result exists. |
| Real TikTok delivery/read receipt | `unverified-external` | No provider receipt contract has been verified; unknown delivery state must not be retried blindly. |

The retained guild workbench remains a UI surface and honest placeholder. It is
not evidence that any external TikTok action occurred.
