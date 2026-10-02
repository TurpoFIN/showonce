# Verified live run: release gate

The public fixture build is not submission-ready. Complete this checklist with real evidence before describing ShowOnce as a working sponsor-integrated submission.

## 1. Use the authorized team environment

Use the team's existing workshop environment and credentials. Do not paste secrets into chat, source files, screenshots, the browser, or GitHub. If the workshop already exports its authorized config, use those variables directly. Otherwise the environment owner can source the team's existing config locally without printing it.

```sh
# In the assigned, authorized workshop shell only:
set -a
. /config/<your-team>.config
set +a
npm run live:check
npm start
```

Replace the placeholder with the exact assigned file; do not guess another team's path. The app binds to loopback by default. Use `HOST=0.0.0.0` only behind an existing, verified authenticated access gate. An unauthenticated public backend is not acceptable. A public live URL is not needed to record a genuine live result.

The readiness probe performs read-only connectivity/model-catalog calls. A green check here does not prove inference succeeded.

## 2. Prove scenario availability

Open Live providers → Connections. Search the VAST corpus for a narrow observable scenario. Watch the returned footage. Do not assume warehouse, roadway, or another scenario exists based on a caption or a search score.

- Verify the video actually plays
- Verify its original parent-video identity resolves from documented metadata
- Verify the positive action and meaningful negative are visibly distinguishable
- Verify any temporal criterion fits the actual segment duration
- Choose a scenario supported by the corpus; do not relabel unrelated footage to fit the pitch

If a parent cannot be resolved, the clip must not enter a split. Do not guess a parent from a filename.

## 3. Human-label independent evidence

Use the UI's video preview before assigning a label. Choose:

- TRAIN: at least one visible positive and one meaningful negative, with sufficient footage for the requested event
- HOLDOUT: separate parent videos, with both positive and negative labels
- REPLAY: a further parent video for the final ledger demonstration

Labels must be independently reviewed by a human. If unclear, leave the clip unassigned. Neighboring segments from the same original video do not create an independent holdout. Record limitations when the available corpus is small.

## 4. Execute real sponsor calls

1. Generate the event rule in Live providers mode
2. Confirm successful Cosmos TRAIN observations and W&B rule-generation provenance
3. Inspect the explicit rule and verify it matches the observed event
4. Run the frozen HOLDOUT evaluation
5. Inspect each prediction and its evidence. Uncertainty must abstain, not silently become a negative
6. If correction is needed, use only TRAIN counterexamples and an observable correction criterion
7. Treat later checks of the same holdout as regression comparisons. Never claim unseen generalization from them
8. Publish only a fully agreeing exact-version check
9. Replay genuine new corpus evidence and open its ledger entry

If the chosen event cannot pass honestly, preserve the failure evidence. Do not change human labels to match the model, remove failing cases after seeing predictions, or substitute fixture results.

## 5. Save actual evidence and record

- Export the real run JSON from the audit trail
- Retain provider model/response receipts when available, rule/evidence hashes, labels, and split provenance
- Record the actual live UI end to end in no more than three minutes
- Keep provider sources and the real evidence visible
- State the number of examples and the limits of the evaluation
- No fictional real-world accuracy, impact metric, deployment, or operational alert

The synthetic GitHub Actions recording is a separate QA artifact. It must not replace this live demo.

## Release sign-off

- [ ] Actual VAST indexed video retrieval and playback succeeded
- [ ] Real Cosmos observation and held-out prediction succeeded
- [ ] Real W&B rule generation succeeded with an identified model
- [ ] Human labels and whole-parent splits are documented
- [ ] Exact-version holdout gate passed without abstentions
- [ ] Genuine replay produced linked evidence and deduplicated correctly
- [ ] Export and live recording inspected for correctness and secrets
- [ ] Repository includes final verified source; final video exists and plays

Until these are established, the correct status is **live unverified, not submission-ready**.

## Read-only capture of a completed genuine run

After all release gates pass, `scripts/record-live.mjs` inspects the stored genuine run. It refuses browser fixtures, missing provider receipts, unreviewed labels, parent leakage, failed evaluation, or a missing detected replay. It makes no mutation requests and never resets the workspace. It explicitly captions results as completed provider calls rather than new inference.

```sh
# In an environment where browser recording is permitted:
npm install --no-save --package-lock=false playwright
npx playwright install chromium
LIVE_BASE_URL=http://127.0.0.1:3000 node scripts/record-live.mjs
ffmpeg -i artifacts/live/showonce-live.webm \
  -vf "pad=1440:1200:0:0:black,subtitles=artifacts/live/live-captions.srt:force_style='FontSize=19,MarginV=20'" \
  -c:v libx264 -crf 22 -pix_fmt yuv420p -movflags +faststart \
  artifacts/live/showonce-live.mp4
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 artifacts/live/showonce-live.mp4
```

Inspect the completed MP4, ensure it stays under 180 seconds, and review the evidence JSON for private corpus context before sharing. The consistency gate does not cryptographically attest that an external provider ran; the operator must also verify the actual authorized environment and provider execution.
