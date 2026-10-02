# Verified live run: release gate

The local fixture build is not submission-ready. Public hosting and GitHub Actions are not enabled. Complete this checklist with real evidence before describing ShowOnce as a working sponsor-integrated submission.

## 1. Use the authorized team environment

Use the team's existing workshop environment and credentials. Do not paste secrets into chat, source files, screenshots, the browser, or GitHub. If the workshop already exports its authorized config, use those variables directly. Otherwise the environment owner can source the team's existing config locally without printing it.

```sh
# From the ShowOnce directory in the assigned workshop VM shell:
npm run workshop
```

This is the one-command path when the workshop environment is already exported. It needs Node.js 22 or later, installs no packages, starts the server on loopback, opens live mode via the printed URL, and checks existing provider configuration without running model inference. It never loads or writes `.env`, creates credentials, or starts GitHub Actions. Missing configuration leaves the UI available and reports only provider names.

If the assigned shell has not loaded the team's existing config, the environment owner can load its exact known path locally first. The official GPU instructions require the single `/config/*.config` file; never search the repository's `team-configs/`, load another team's file, or print its contents:

```sh
set -a
. /config/<your-team>.config
set +a
npm run workshop
```

For a port collision, keep the previous server or choose a free loopback port with `SHOWONCE_WORKSHOP_PORT=3001 npm run workshop`. Do not run both processes against the same state file. `npm run live:check` remains a separate readiness-only command, while `npm start` uses the ordinary `.env`-enabled server entry point.

Replace the placeholder with the exact assigned file; do not guess another team's path. The workshop launcher requires an existing `GPU_BEARER_TOKEN` for a successful workshop readiness result. It also needs `COSMOS3_REASON_URL` from the assigned workshop setup; loading a config that lacks that endpoint is not sufficient. Use the endpoint given by the workshop's GPU instructions, without guessing an alternative or printing credentials. Both a root Cosmos URL and one ending in `/v1` are supported. The app binds to loopback by default. Use `HOST=0.0.0.0` only behind an existing, verified authenticated access gate. An unauthenticated public backend is not acceptable. A public live URL is not needed to record a genuine live result.

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

Any synthetic local recording is a separate QA artifact. It must not replace this live demo.

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

After all release gates pass, `scripts/record-live.mjs` inspects the stored genuine run. It recomputes the published rule digest, frozen holdout digest and evaluation metrics, requires complete unique TRAIN/HOLDOUT evidence, checks event-specific human review, and matches video hashes and decisions to provider receipts. It also checks replay split isolation, deduplication, the exact rule snapshot, and evidence duration. Browser fixtures, missing or inconsistent evidence, failed evaluation, and a missing detected replay are refused. It refuses active operations, makes only same-origin GET requests, blocks service workers and external browser traffic, and never resets the workspace. The evidence must remain unchanged through the capture. Each attempt uses a fresh `capture-*` directory, so it cannot overwrite an earlier completed recording. Failed attempts are labeled `failed-capture.webm` and `failure.json`. The planned scenes total 125 seconds; a 170-second capture deadline leaves room under the contest limit, and FFprobe verifies the actual final file is at most 180 seconds before it is named `showonce-live.webm`. It explicitly captions results as completed provider calls rather than new inference.

```sh
# In the authorized workshop/local recording environment, with Node 22+
# and FFmpeg/ffprobe already installed. This installs recording-only tools:
npm install --no-save --package-lock=false playwright
npx playwright install chromium
LIVE_BASE_URL=http://127.0.0.1:3000 node scripts/record-live.mjs
# The script prints the exact successful capture directory. Use that path:
cd artifacts/live/capture-<printed-suffix>
ffmpeg -n -i showonce-live.webm \
  -vf "pad=1440:1200:0:0:black,subtitles=live-captions.srt:force_style='FontSize=19,MarginV=20'" \
  -c:v libx264 -crf 22 -pix_fmt yuv420p -movflags +faststart \
  showonce-live.mp4
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 showonce-live.mp4
```

The recorder is an inspection of stored execution evidence, not a film of fresh model calls. For a live-on-camera execution, record the actual authorized workflow manually and shorten only waiting time with a disclosed edit. Do not claim either recording exists until it has been created and checked.

Inspect the completed MP4, ensure it stays under 180 seconds, and review the evidence JSON for private corpus context before sharing. The consistency gate does not cryptographically attest that an external provider ran; the operator must also verify the actual authorized environment and provider execution.

## Existing authenticated previews

The UI supports a path-prefixed mount such as an existing workshop `/proxy/3000/` route, including real `/api/media/` playback. Keep the backend bound to loopback. If an already authenticated HTTPS preview forwards its origin and the API rejects it, set `SHOWONCE_ALLOWED_ORIGINS` only to that exact verified origin, without a path or wildcard. Do not guess an origin, enable a new public port, or relax authentication. A VM desktop browser at `http://127.0.0.1:3000` avoids this proxy configuration entirely.


## Provider contract and safe diagnostics

The official workshop retrieval guide documents backend login and `/auth/me`, search results plus parent `chunk_results`, segment metadata, and token-authenticated stream playback. The GPU guide documents Cosmos model discovery, bearer authentication, chat completions, and `video_url` with a base64 MP4 data URI. The adapter follows these contracts. NVIDIA's [Cosmos3 NIM reasoning cookbook](https://github.com/NVIDIA/cosmos/blob/main/cookbooks/cosmos3/nim/reasoning.md) documents structured JSON output and video frame sampling. Compatibility still needs a genuine call against the assigned deployed service; mocked HTTP tests cannot establish that deployment's feature support.

- Missing configuration: use the assigned VM's existing team environment. Never guess another team's config or copy its credentials.
- HTTP 401/403: inspect the assigned access/configuration through the workshop owner; do not infer a service outage. The official GPU deployment requires its existing `GPU_BEARER_TOKEN`.
- HTTP 400/422 from Cosmos: inspect supported structured-output/video options in that deployment before manually retrying. Do not substitute a caption or fake receipt for video inference.
- Timeout: `SHOWONCE_PROVIDER_TIMEOUT_MS` accepts 5000–300000 ms, with a default of 120000. A timeout is an unknown remote outcome; the provider may still finish and charge. No inference is automatically retried.
- Unresolved original parent: the result stays out of the experiment. Check documented metadata rather than deriving an identity from a filename.
- Empty search: inspect the actual corpus and change the observable event if necessary. The build-day guide describes roadway/intersection, highway, and neighborhood-camera footage; it does not promise warehouse or package footage.

The recording export uses the same evidence schema as the UI, including reviewed clip labels, original parent identities, frozen holdout, provider receipts, and audit entries. An explicit `LIVE_VERSION_ID` must exist and pass its own checks; the recorder never substitutes a different published version.

Reference material: [official workshop guide](https://github.com/vast-data/vast-builders-challenge), [retrieval search](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/retrieval/search/SKILL.md), [GPU models](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/gpu/README.md). Cached documentation was used for the contract review; actual workshop reachability and provider execution remain unverified until tested in the authorized team environment.
