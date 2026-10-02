# Fixture walkthrough and final live demo requirements

**NOT A FINAL CONTEST DEMO:** the current synthetic fixture recording is workflow QA only. The final submission video must use real VAST footage and verified successful Cosmos and W&B execution. Do not submit the fixture recording as proof of sponsor usage.

Target: 2:15–2:45. The recorded footage should show the real UI, not a pre-rendered product mockup. Keep the synthetic-fixture badge visible throughout.

## 0:00–0:20 · The problem

“Cameras can describe a scene. Operations teams need a testable definition of what matters. ShowOnce teaches a camera an event and keeps the proof behind every decision.”

Open the studio. Play the positive clip. Explain: a vehicle is stationary in a travel lane for at least eight seconds.

## 0:20–0:45 · Teach

Show the two TRAIN hard negatives: a car on the shoulder and slow traffic. Generate the positive-only first rule. Read the explicit definition and thresholds. Point out that rules are inspectable, not hidden inside a chatbot conversation.

## 0:45–1:10 · Test the boundary

Run the frozen fixture check. Show 4/6 agreement and two false alerts. Show that publication is blocked.

“This is a deterministic demonstration on authored synthetic footage, not a model accuracy result. The baseline is intentionally too permissive.”

## 1:10–1:40 · Correct from TRAIN

Choose Teach the boundary. The correction modal includes only the two TRAIN negatives. Generate version 2, inspect the new travel-lane and stationary exclusions, and run its regression check.

“Those six frozen cases now agree. This repeated set is a regression comparison, not a new unseen test. Real deployment needs broader independently labeled footage.”

## 1:40–2:05 · Publish and act with evidence

Publish version 2. Replay new footage. Open the ledger evidence. Show the clip, exact rule, version, and provenance. Replay again to demonstrate deduplication.

“The unit of deployment is a versioned event definition. Every event has receipts.”

## 2:05–2:30 · Sponsor architecture and honest limits

Open Connections. Describe the actual adapters:

- VAST: find existing indexed evidence and optionally reingest a TRAIN video
- Cosmos: observe video and predict on isolated holdout/replay clips
- W&B Inference: generate and correct the explicit rule from TRAIN observations

“Keys stay server-side. Demo execution and real provider execution are shown separately. Configured is not the same as verified.”

If real provider runs have been completed, show their genuine audit evidence and state which calls actually ran. Otherwise say they remain unverified. Never splice a mock into apparent live evidence.

## 2:30–2:45 · Close

“Teach once. Challenge the boundary. Ship a rule you can inspect, and keep the proof.”

Show the repository and public demo. No operational alerts were dispatched.

## Recording workflow

GitHub Actions `demo.yml` runs the app, drives Chromium using `scripts/record-demo.mjs`, records the actual workflow, produces captions, and uploads MP4/screenshots/evidence JSON. Download the artifact from the successful run and inspect the resulting video before submission. A workflow file alone is not proof that a video has been generated.

## Rehearsal checklist

- Reset the demo workspace and use a desktop viewport
- Confirm every video plays and the text remains readable
- Confirm v1 publication is blocked; v2 can publish after evaluation
- Keep the fixture/model distinction visible and audible
- Stop under three minutes
- Verify final video playback and include the actual link or file in the submission
