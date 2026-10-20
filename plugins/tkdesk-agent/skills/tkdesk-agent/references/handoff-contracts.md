# Digital-employee handoff contract

Read this before preparing or committing an identity-bearing candidate batch.

## `tkdesk.candidate-handoff.v4`

`prepare_handoff` freezes the selected candidates into an immutable dataset with:

- stable `batchId` and source `runId`
- SHA-256 `datasetHash`
- destination, purpose, filters, generated time, and candidate count
- stable candidate IDs, identities, latest operational signals, qualification, provenance, freshness, and `outreachStatus: not_contacted`
- the six original raw score fields (`currentScore`, `topScore`, `historyRankScore`, `hotListScore`, `rankRecordScore`, `rankingScore`) with `unknown_rank_score` units where observed; legacy diamond aliases remain compatibility projections and never invent USD
- `status: pending_review` and `sendAuthorized: false`

Preparing a batch never authorizes communication.

## Approval and outbox

`commit_handoff` requires the exact `batchId` and `datasetHash` returned by preparation plus explicit user confirmation. A hash mismatch is a hard stop because it means the reviewed dataset is not the dataset being committed.

Commit writes an idempotent local outbox event and an immutable JSON file. Repeating the same commit must not create a second downstream batch. Until a real digital-employee adapter is configured, `pending` means ready for that adapter—not delivered and not contacted.

## Downstream responsibilities

The digital employee, not TKDesk, owns:

- contact-channel and specific-batch approval
- prior-contact and duplicate suppression
- quiet hours and send limits
- opt-out, refusal, and do-not-contact state
- review of earnings, rewards, contract, or performance claims
- message, response, and outcome records

When integration is added, it should acknowledge `batchId + datasetHash`, support partial failure and retry, and return contacted/refused/opted-out results so later discovery runs can suppress unsuitable candidates.

The official-account marketing system may consume anonymous aggregate trends through a separate adapter. It is not part of this candidate handoff contract.
