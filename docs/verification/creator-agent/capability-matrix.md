# CreatorAgent capability matrix (Task 9)

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
| Local database at migration `0026_social_runtime` | `blocked-local` | Task 9 doctor is read-only and reports the missing/unmigrated fork database. State copy and migration belong to Task 10. |
| Configured real-model profile generation and conversation quality | `blocked-local` | The configured-model probe found no usable root/backend `config.yaml`; no model call ran. See `2026-09-24-task8-configured-model-probe.json`. |
| PostgreSQL transaction/locking behavior | `blocked-local` | SQL branches are covered deterministically, but no live PostgreSQL integration was available. |
| Real TikTok inbound identity and message receipt | `unverified-external` | No authenticated TikTok provider, stable sender identity, or real inbound event evidence exists. |
| Real TikTok outbound message sending | `unverified-external` | No authorized production sender or provider acceptance evidence exists. Drafts and synthetic sends are not sends. |
| Real TikTok formal invitation | `unverified-external` | No authenticated invitation channel, authorization, dedupe, or platform result exists. |
| Real TikTok delivery/read receipt | `unverified-external` | No provider receipt contract has been verified; unknown delivery state must not be retried blindly. |

The retained guild workbench remains a UI surface and honest placeholder. It is
not evidence that any external TikTok action occurred.
