# iPhone Public Outreach Pilot

This runbook is for one explicitly authorized real-device pilot. It is not a
batch activation guide. CI, doctor, acceptance, and fake-driver tests must not
write to TikTok or attach a real device.

## Preconditions

- Use a macOS host with Xcode and the Xcode command-line tools installed.
- Pair and trust one physical iPhone. Confirm the device appears in Xcode and
  that the device is unlocked.
- Build and sign WebDriverAgent with the team's Apple development signing
  identity. Record the signed `wda_bundle_id` in the native sender/device
  registration; credentials and signing material stay outside Git.
- Install Appium 3 and the XCUITest driver from the pinned operator package.
- Register exactly one device with `device_ref`, `udid`, `platform_version`, and
  `wda_bundle_id`. The expected initial health state is `ready`.
- Log into one ordinary TikTok account manually on the iPhone. Do not put
  credentials, cookies, screenshots, or profile data in the repository.

## Pilot procedure

1. Stop any previous iOS operator process and verify that the device registry
   has no active session lease for the device.
2. Start the operator with the iOS device root and failure-evidence root
   configured. Confirm the device health read-back is `ready`, WDA is reachable,
   and the device is not `locked` or `offline`.
3. From the existing DeerFlow claim, create one public outreach sequence with a
   fixed iOS sender identity. Do not mix a Web sender and an iOS sender in the
   same sequence.
4. Run one creator task in the required order: `like`, `comment`, `follow`.
   Each action must have a provider read-back. A tap, visible button, draft, or
   screenshot by itself is not a receipt.
5. Compare the returned receipt envelope with the Web channel contract:
   `provider_ref`, `receipt_payload`, `verification_source`, and `verified`.
   Only a verified `public_action_receipt` may advance `public_touched`.
6. Stop before the first message decision unless the pilot authorization
   explicitly includes the message action. If messaging is authorized, run it
   with the same fixed sender and require a verified `dm_receipt`.
7. Close the XCUITest session and confirm the registry returns to `ready` with
   no `active_session_id`.
8. Save the task id, sender id, device ref, receipt ids, verification sources,
   and any manual-takeover reason in the existing verification evidence and
   ledger. Keep raw screenshots and accessibility snapshots in the configured
   evidence store with restricted access.

## Stop conditions and recovery

- `wda_unavailable`, `device_locked`, `device_offline`, `app_launch_failed`,
  `selector_missing`, `locator_evidence_required`, `challenge`, or `unknown`
  pauses the sender/device path and creates a manual-takeover task.
- Unlock or re-pair the iPhone manually, repair/sign WDA, or inspect the
  accessibility tree before retrying. Never retry a verified action.
- Failure screenshots and accessibility snapshots are diagnostic evidence only;
  they cannot advance the creator state.
- If the device remains `busy`, close the owning session using its lease id.
  Do not force a second session for the same `device_ref`.
- If any provider read-back is missing, mark the action
  `unverified-external`, preserve the evidence, and stop the pilot.

## Exit checklist

- [ ] The pilot authorization, operator start/stop time, and operator host are recorded.
- [ ] One device and one ordinary account are identified without storing credentials.
- [ ] WDA and app launch health are `ready` before the task.
- [ ] Like, comment, and follow have separate verified read-back evidence.
- [ ] Any message has a verified `dm_receipt` from the same sender.
- [ ] The device session is closed and the registry state is `ready`.
- [ ] No real-device process remains running after evidence collection.
