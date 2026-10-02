# ShowOnce backend

Zero runtime dependencies; Node.js 22 or newer. The root `npm start` runs `server/index.mjs`. It serves `public/`, or `dist/` when `dist/index.html` exists. No frontend build is required.

## Local operation

```sh
npm start
npm test
# Optional: after you configure your own existing authorized server variables:
node --env-file=.env server/index.mjs
```

The default bind address is `127.0.0.1:3000`. Set `PORT` and, only when needed, `HOST`. Use `HOST=0.0.0.0` only behind a confirmed authenticated workshop ingress/access gate, never generic public ingress. The app has no user-account/session layer: keep a credentialed instance on loopback or behind an authenticated reverse proxy. Do not expose a live credentialed instance as an unauthenticated public service. `SHOWONCE_ALLOWED_ORIGINS` accepts a comma-separated list of explicit frontend origins; localhost development origins and same-origin calls are allowed.

An existing authenticated workshop preview may mount the UI under a path prefix; real media URLs follow that same mount. Keep loopback binding. If its HTTPS proxy forwards an origin that is rejected, set `SHOWONCE_ALLOWED_ORIGINS` only to the exact verified authenticated preview origin (scheme and host, no path or wildcard). This is not permission to expose the service publicly or create a new access grant. Using the VM desktop browser at `http://127.0.0.1:3000` requires no proxy-origin change.

The HTTP host guard accepts loopback/listener addresses and hostnames from those explicitly configured origins. Unknown hosts are rejected even when their `Origin` matches, preventing a DNS-rebinding site from treating the credentialed loopback service as its own origin. This guard supplements the origin check; it does not replace authentication for a network-accessible deployment.

Local experiment state is atomically written to `server/.data/state.json`, with owner-only permissions and git exclusion. `SHOWONCE_DATA_FILE` may override it. Malformed or structurally corrupt state (including missing collections, invalid counters and duplicate record IDs) causes a visible startup failure rather than silently discarding the experiment. Reset changes only this local experiment; it never removes VAST footage or cancels provider jobs. Durable re-ingest attempts survive reset so an uncertain provider submission cannot be accidentally repeated.

## Provenance and evaluation boundaries

- Demo clips are authored synthetic fixtures. Their decisions are computed by a deterministic rule over authored features. A `4/6` to `6/6` change is **fixture agreement**, not a model benchmark or measured sponsor accuracy.
- Generation starts from the positive TRAIN clip. Shoulder and crawling-traffic hard negatives explicitly tighten the corrected rule. No model or external provider executes in demo mode.
- Live clips originate in VAST search results, require explicit human labels, and remain split by whole `original_video` parent identity. If the segment hit omits its parent, the server uses an exact `chunk_results.preview_source` match, then the documented segment-metadata lookup with the exact indexed source. Missing or conflicting parents are reported and excluded; paths are never guessed. Similarity is retrieval relevance, not event probability.
- Live generation supports a user-defined observable video event, including non-roadway actions. Cosmos TRAIN observation receives the event name; W&B produces a generic definition, inclusion/exclusion criteria, and an observable minimum duration. Roadway-specific speed/lane thresholds remain confined to synthetic fixtures. Live generation uses NVIDIA Cosmos video observations and W&B inference to produce a structured rule. Only TRAIN observations and labels enter rule generation/correction. Live labels must carry explicit `labelSource:human-reviewed`, `reviewed:true`, and the exact 2–100-character `eventName` criterion before training or HOLDOUT evaluation. The server stores `labelEventName`; generation, correction, and evaluation require an exact match with the rule event name. Changed intent requires independently re-reviewing labels; a frozen holdout cannot be silently reused for another event. AI proposals may omit intent, and REPLAY keeps ground truth null. `ai-proposed` labels remain proposals and cannot pass these gates until a person independently reviews and confirms them. This is a user review attestation, not automatic proof of identity or playback.
- At first live generation, HOLDOUT labels, membership, parent identity, and video-content SHA-256 digests are frozen. Video bytes that change are rejected. Expected HOLDOUT labels never enter inference prompts.
- Evaluations are pinned to the rule and frozen holdout digests. Reusing the holdout across versions is an exploratory regression comparison; it must never be presented as a fresh unseen estimate.
- Uncertain Cosmos observations are explicit `null` predictions, counted as `unknown`. A positive model decision whose evidence interval is shorter than the rule minimum (50 ms tolerance) becomes an explicit abstention, preserving the reported decision in its receipt. Evidence outside a known clip duration is rejected (100 ms tolerance). Any false positive, false negative, or unknown holdout decision blocks publication. Every labeled case must agree for the exact version to publish. No fake confidence scores are generated.
- Publication is a local registry state change (`local-demo-only` or `local-replay-only`), not deployment to a camera or an external system. Actual rule content is rehashed before evaluation, correction, publication and replay, including idempotent calls. Publication and replay revalidate frozen membership, event-specific human review, exactly one decision per holdout clip, and metrics recomputed from those decisions. Corrupt or stale saved summaries fail closed. These local integrity checks detect inconsistency; they are not signatures or tamper-proof attestation.
- Replay writes evidence-linked observations, including the published rule snapshot and content digest for live clips. Replaying the same version/clip pair is idempotent. Replay may abstain; ledger decisions distinguish `detected`, `not_detected`, and `uncertain`. No operational alert is sent.

## API contract

`GET /api/state` returns `app`, `mode`, `fixtures`, `clips`, `versions`, `evaluations`, `ledger`, `audit`, `liveHoldout`, `reingestJobs`, `readiness`, `readinessChecking`, `operation`, and `busy`. `readinessChecking` stays true while startup or explicit read-only provider checks are running. `fixtures` contains `clips`, `holdoutDigest`, `source`, and `warning`. `clips` combines demo fixtures and any discovered live clips.

Mutations accept JSON and return `{ "state": { ... }, "result": ... }`. Errors return `{ "error": { "code": "...", "message": "..." } }` with a suitable HTTP status. Concurrent mutations are rejected with 409 instead of applying against stale state.

| Method | Path | Body / purpose |
|---|---|---|
| GET | `/api/health` | Local server health only |
| POST | `/api/generate` | `{mode, eventName, trainingClipIds?}`; mode is `demo` or `live` |
| POST | `/api/evaluate` | `{mode, versionId}`; exact version, frozen holdout |
| POST | `/api/correct` | `{mode, versionId, trainingClipIds, feedback?}`; evaluated parent, TRAIN hard negatives, and optional observable correction criterion (max 1,000 characters) only |
| POST | `/api/publish` | `{versionId}`; evaluated version, matching hashes, every labeled holdout case agrees, no unresolved abstentions |
| POST | `/api/replay` | `{versionId}`; published version only |
| POST | `/api/reset` | `{mode?}`; local experiment reset |
| POST | `/api/cancel` | `{operationId}`; cancel only the current cancellable operation; rolls back its uncommitted local changes |
| POST | `/api/reingest/reconcile` | `{attemptId, confirmedStatus, confirmed:true, jobId?}`; explicit VAST-dashboard reconciliation; statuses: `not_started`, `failed`, `completed`, `running` (running requires exact jobId) |
| POST | `/api/check` | `{}`; real read-only connectivity/catalog checks, no benchmark claim |
| POST | `/api/discover` | `{query}`; search existing VAST archive, no automatic labels |
| POST | `/api/label` | `{clipId, split, label, labelSource, reviewed?, eventName?}`; explicit human-reviewed + reviewed:true, or ai-proposed; TRAIN/HOLDOUT require a boolean label; REPLAY label optional |
| GET | `/api/media/:clipId` | Server-proxied media for a previously discovered clip; no browser token |
| POST | `/api/reingest` | `{clipId, customPrompt, confirm:true}`; selected indexed TRAIN video, one chunk, custom prompt 1–800 characters, original metadata preserved |
| GET | `/api/reingest/:jobId` | Poll a known workspace job; use a 4-second interval until completed/failed |

Version fields: `id`, `name`, `eventName`, `revision`, `parentId`, `mode`, `source`, `status` (`draft`, `evaluated`, `published`), `rule`, `ruleDigest`, `trainingClipIds`, `trainingEvidence`, `evaluationId`, `holdoutDigest`, `createdAt`, `disclaimer`. A rule contains `definition`, `include[]`, `exclude[]`, `thresholds`, and `limitation`.

Evaluation fields include `id`, `versionId`, `mode`, `source`, `status`, `createdAt`, `holdoutDigest`, `ruleDigest`, `metrics`, `results[]`, `previouslyEvaluatedHoldout`, and `disclaimer`. Metrics include `total`, `correct`, `falsePositives`, `falseNegatives`, `unknown`, `agreement`, `precision`, and `recall`. Results preserve separate `expected` human/fixture labels and `predicted` model/rule decisions.

Ledger fields include `id`, `versionId`, `clipId`, `eventName`, `decision`, `timestamp`, `source`, `evidence`, `ruleSnapshot`, `ruleDigest`, and `disclaimer`. Evidence contains `clipId`, `url`, `startSec`, `endSec`, `summary`, and a `contentDigest` for live media.

Live media supports single byte ranges (`206` with `Content-Range`) and `HEAD` so video players can seek to evidence windows. Invalid or unsatisfiable ranges return `416`. The server still downloads and verifies the complete pinned video before returning any range; requesting a small range cannot bypass frozen-content integrity checks. Media responses remain private and uncached.

## Existing provider configuration

Copy only the empty template from root `.env.example`, then configure your existing authorized environment locally. No credentials are accepted through the browser, returned in state, persisted in experiment JSON, or logged. The backend does not create accounts, API keys, access grants, or uploads.

On your already-authorized workshop VM, prefer its existing exported environment rather than copying any key:

```sh
# Only on your assigned team VM, with your exact existing authorized team file.
set -a
source /config/<your-team>.config
set +a
npm start
```

Do not print or commit that file. Do not search other teams or copy credentials into this repository. Existing exported `WANDB_` values may be present even when absent from that file. If a value is missing, resolve it through the workshop operator. Model discovery works without a `WANDB_MODEL` value. Keep the default loopback bind unless the workshop operator confirms an authenticated access gate.

- **VAST**: `INGRESS_URL` plus `VAST_API_TOKEN`, or `USERNAME` and `PASSWORD`. Username/password auth caches a session token and refreshes it once after an authenticated API or media-stream 401. A static `VAST_API_TOKEN` is never automatically retried/refreshed; a second 401 is surfaced without another retry. The browser receives only same-origin media URLs. Searches use `POST /api/v1/search` with `top_k:30` and `llm_top_n:0`.
- **NVIDIA Cosmos**: `COSMOS3_REASON_URL`; optional `COSMOS3_REASON_MODEL` (otherwise `/v1/models` discovery); `GPU_BEARER_TOKEN` is required by the assigned workshop deployment. It is optional only for a separately verified deployment that does not require authentication, such as a local NIM. Uses `/v1/chat/completions` with video-first `video_url` content containing a server-side base64 video data URI, standard `response_format: json_schema` guided output, and `media_io_kwargs.video.fps:4`. These fields follow the NVIDIA Cosmos3 NIM cookbook. An incompatible deployment fails explicitly; the app never silently substitutes heuristic predictions or retries with weaker output guarantees. Only final structured `message.content` is consumed; raw reasoning is neither returned nor stored. Read limits are 32 MiB per clip. Each upstream request defaults to a 120-second deadline; `SHOWONCE_PROVIDER_TIMEOUT_MS` accepts an integer from 5000 through 300000. A timeout is explicit and redacted, and does not trigger an automatic inference/mutation retry or imply that upstream work/billing stopped.
- **W&B**: `WANDB_API_KEY`; optional `WANDB_MODEL` override. Optional `WANDB_BASE_URL` defaults to the documented `https://api.inference.wandb.ai/v1`; `WANDB_TEAM` + `WANDB_PROJECT` set the `OpenAI-Project` attribution header. The server reads `/models` and chooses deterministically from actual catalog IDs with declared text/chat capability or conservatively recognized documented text-model identities. An explicit override must exist in that catalog. Unknown capability catalogs fail with actual candidate IDs and a request for a confirmed text model; embeddings/vision-only models are not selected arbitrarily. The selected ID is visible in readiness. Uses OpenAI-compatible `/chat/completions`; response JSON and rule schema are validated. No Weave run or externally logged benchmark is claimed.

Provider readiness distinguishes `not_configured`, `configured_unverified`, `ready`, and `error`. A passing read-only check verifies connectivity, not inference quality. Model availability and endpoint compatibility must be verified in the actual workshop environment. Mocked adapter contract tests are not live sponsor verification. The actual release gate remains a successfully executed authorized VAST → Cosmos → W&B → evaluation → replay loop in the workshop environment; synthetic QA alone does not satisfy it.

Successful model responses preserve nonsecret receipts: provider, response ID when supplied, requested and reported model, receive timestamp, token usage when supplied, and SHA-256 video-content digests. These flow through training evidence, version-generation receipts, evaluation rows, replay entries, and/or audit records. Receipts omit credentials, provider URLs, raw media and raw reasoning. They are traceability records, not cryptographic attestations or proof of model accuracy.

Re-ingest is deliberately explicit: only a discovered indexed TRAIN parent, one chunk, user-confirmed custom prompt, and unchanged metadata. No new video is uploaded. A provider status of completed is reported accurately; refreshed discovery and caption inspection are still required to verify the replacement is searchable. A lost/unknown job record is not treated as success or proof that processing stopped. Re-ingest is noncancellable from operation start. A durable attempt is recorded before the provider POST. A timeout, broken response, or other uncertain submission preserves an `unknown`/pending attempt, blocks another submission for that parent, and survives reset. Use the VAST dashboard to verify the outcome, then explicitly reconcile the recorded attempt. Running reconciliations attach the actual provider job ID for further polling; no job ID or success is guessed.

## Official contracts consulted

- [Build day](https://github.com/vast-data/vast-builders-challenge/blob/main/BUILD_DAY.md)
- [Architecture reference](https://github.com/vast-data/vast-builders-challenge/blob/main/ARCHITECTURE_REFERENCE.md)
- [VAST search](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/retrieval/search/SKILL.md)
- [VAST auth](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/retrieval/login/SKILL.md)
- [VAST video playback](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/retrieval/videos/SKILL.md)
- [Re-ingest existing videos](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/ingest/reingest-videos/SKILL.md)
- [Cosmos video inference](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/gpu/README.md)
- [W&B serverless inference](https://wandb.ai/site/inference/)

- [NVIDIA Cosmos3 structured output and video sampling](https://github.com/NVIDIA/cosmos/blob/main/cookbooks/cosmos3/nim/reasoning.md)

## Operation lifecycle and safe cancellation

`GET /api/state` exposes `operation:null` before the first mutation, or the latest in-memory operation:

```json
{
  "id": "op-<opaque-id>",
  "type": "generate",
  "status": "running",
  "phase": "Observing TRAIN clip 1 of 2",
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "finishedAt": null,
  "cancellable": true
}
```

Statuses are `running`, `cancelling`, `succeeded`, `failed`, and `cancelled`. A failed/cancelled operation includes safe `error:{code,message}`. Phase strings are fixed descriptions plus numeric progress; event names, queries, media URLs, and credentials are never interpolated. `busy` remains true during running/cancelling work, including when `/api/check` returns while another operation is active. Polling state recovers the final result after a lost browser response. A client disconnect does not cancel a provider request.

`POST /api/cancel {operationId}` responds with `{state,result:{operationId,status:"cancelling",message}}`. A stale ID, finished operation, or noncancellable phase is rejected. A cancellation aborts only that operation's in-flight fetches through an AsyncLocalStorage signal context; concurrent readiness checks are unaffected. Cancellation is checked before every upstream request, between clips, and immediately before the atomic store commit. `cancellable` becomes false before commit starts, closing the cancel/commit race. The original request then returns `OPERATION_CANCELLED` and its local transaction is discarded. This does not prove upstream processing stopped or promise a billing refund.

Provider inference and mutation requests are never automatically retried after uncertain failures. The only retry is a single VAST session refresh after a definite 401, when username/password authentication is in use.

The first successfully consumed TRAIN/REPLAY observation also pins its SHA-256 digest onto the stored clip. Corrections and cross-version replay pass that pin into media fetching, rejecting changed bytes before new Cosmos or W&B inference. TRAIN playback is pinned to all recorded training-evidence content hashes, as well as any HOLDOUT/replay hashes. If versions record conflicting bytes for the same clip, playback fails explicitly instead of selecting an arbitrary version's evidence.
