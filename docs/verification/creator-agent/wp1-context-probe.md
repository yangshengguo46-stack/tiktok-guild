# WP1 social-context configured-model probe

Date: 2026-09-24 (Asia/Shanghai)

## Outcome

The actual fork-native start configuration loaded successfully from
`ops/guild-runtime/config/config.yaml`. It resolved configured name `codex`,
provider `CodexChatModel`, model `gpt-6-sol`, and an available Codex credential
after the unsupported `gpt-5.4` setting was corrected.

The first required non-sensitive probe used the real
`PersonaProfileGenerator.generate` path. It supplied only an operator request to
make expression warmer, clearer and more concise, explicitly forbidding changes
to identity, facts, relationship, commitments or permissions. It supplied no
creator facts, TikTok data or platform channel and performed zero platform
writes.

Seven authorized calls used the same non-sensitive input and made zero platform
writes:

1. `reasoning_effort=none`: HTTP 400 after 1.739 seconds.
2. Diagnostic repeat with bounded error extraction: HTTP 400 after 1.288
   seconds; `error.type`, `code`, `message`, and `param` were all null. No
   headers, token, account or arbitrary response body was recorded.
3. TDD hypothesis verification with `reasoning_effort=low`: HTTP 400 again.
   Provider duration was not captured, so it is recorded as unavailable. The
   hypothesis did not fix the request and the code/test change was reverted.
4. Final bounded-body diagnostic with the original request: HTTP 400 after
   1.384 seconds, `application/json`, 90 body bytes, body SHA-256
   `c9c572447408d4d70db3d3084ee56fea6f4f7cc2aac425919b86fb2acb222b12`.
   After generic credential redaction the complete body was:

   ```json
   {"detail":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}
   ```
5. The ignored start config was changed from unsupported `gpt-5.4` to the
   host-supported `gpt-6-sol` (SHA-256
   `7e1a78e3c758e28cf3a6b51a71e1e8fa865b83478a160f8ba2c6274f69b21fce`
   to `930020f8d924c0d4c4a94616ae1025a34f81d97c616664f30756b04e0f0001b5`).
   The provider/model call returned successfully to `PersonaProfileGenerator`,
   but the old probe harness did not capture its failed validation output.
6. After the first prompt-contract repair, a call returned a valid
   top-level JSON explanation from `gpt-6-sol` in 20.532 seconds. The strict
   parser then rejected nested `style`/`response_format` overrides with
   `ValueError: persona behavior contains non-expression fields`. The bounded
   raw output and usage were captured: input 221, output 147, total 368,
   reasoning 0.
7. After adding the flat override whitelist and scalar/array value contract to
   the system prompt, the final authorized call reached the
   `PersonaProfileGenerator` 30-second timeout in 30.003 seconds. The recorder
   had no reply, so raw output and usage were unavailable. No eighth request was
   sent.

The earlier unsupported-model exception text was:

```text
HTTPStatusError: Client error '400 Bad Request' for url
'https://chatgpt.com/backend-api/codex/responses'
```

The final prompt-contract probe ended with `ValueError: invalid generator
response` after the bounded 30.003-second generator timeout; no recorder reply
was available to save.

No accepted candidate was generated and no profile was activated. The
configuration/account incompatibility is fixed; the sixth call verified real
model transport plus a valid top-level response and its bounded raw output and
usage are preserved in the JSON evidence. After the flat contract repair, the
seventh and final call timed out before a reply. Therefore profile generation
quality and the two-topic multi-turn and occupation-replacement probes were not
sent; they remain `blocked` rather than being inferred from deterministic tests.

## Invocation boundary

The command ran from `backend/` with:

```bash
DEER_FLOW_CONFIG_PATH=../ops/guild-runtime/config/config.yaml uv run python <profile-probe>
```

The final probe instantiated `create_chat_model(name="codex", app_config=config,
attach_tracing=False, disable_streaming=True)` and passed it to
`PersonaProfileGenerator(timeout_seconds=30)`. The complete sanitized structured
result and per-attempt accounting are in
`2026-09-24-task8-configured-model-probe.json`.

The production default is now 45 seconds (raised from 15 after the measured
20.532-second successful response); the final evidence probe kept its explicit
30-second timeout to preserve the bounded-call budget.
