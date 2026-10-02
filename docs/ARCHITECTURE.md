# Architecture

**Release gate:** genuine live VAST, Cosmos, and W&B execution with real corpus evidence must be verified before this is described as submission-ready. The synthetic local build is an internal workflow/QA milestone. Public hosting and GitHub Actions are not enabled.

## Two execution paths, one visible product

### Browser-local fixture mode

`public/index.html → public/app.js → public/browser-demo.js → browser localStorage`

All evidence is bundled synthetic media. The adapter only accepts demo actions and rejects live-provider actions. State is isolated to the visitor's browser. It never has server keys, provider access, or shared operational state. No public deployment is active. Only `public/` would be eligible for any separately authorized static deployment.

### Real integration server

`Browser → Node HTTP API → Application state machine → Integrations → sponsor endpoints`

- `server/index.mjs`: HTTP boundaries, security headers, local origin validation, JSON/body limits, static assets, byte-range media
- `server/lib/application.mjs`: allowed workflow transitions, split isolation, frozen evaluations, version publication, evidence ledger
- `server/lib/integrations.mjs`: documented VAST, NVIDIA Cosmos, and W&B clients, timeouts, structured output validation, safe errors
- `server/lib/store.mjs`: serialized transactions and atomic private-file persistence
- `server/lib/fixtures.mjs`: authored deterministic scenarios, explicit rule comparison, confusion counts

## Flow

1. VAST search retrieves existing indexed segments. Search score is retrieval relevance, not event probability
2. A human views footage and assigns TRAIN/HOLDOUT/REPLAY and positive/negative labels
3. Original parent videos cannot straddle splits. Holdout membership and labels freeze at generation
4. Cosmos observes TRAIN clips. W&B receives TRAIN observations and labels to generate an explicit rule
5. Cosmos predicts separately on frozen HOLDOUT video. Expected labels are never sent in prediction prompts
6. A correction uses selected TRAIN negatives, the previous rule, and optional observable user feedback. It never consumes HOLDOUT labels or evaluation rows
7. Publication requires a completed evaluation of the exact version, all labeled cases agreeing, and no abstentions
8. A new REPLAY clip is evaluated under the published rule. Its decision, evidence, source, timestamp, and immutable rule snapshot enter the ledger

Live evidence bytes are pinned with SHA-256 to detect upstream replacement. A repeated holdout evaluation after correction is explicitly a regression comparison. It is not an unbiased estimate of generalization.

## Publication does not dispatch an alert

“Publish” activates a version in this local prototype's replay workflow. It does not install a production camera rule, send a Slack message, open a ticket, or trigger a safety-critical response. The ledger can hold `detected`, `not_detected`, and `uncertain` decisions. An uncertain observation is not silently coerced into an event.

## VAST reingestion constraints

Only an already discovered existing TRAIN parent video can be reingested. The request is one chunk and a prompt of at most 800 characters. Frozen HOLDOUT video is protected. Reingestion is asynchronous, may take minutes, and may atomically replace indexed captions; a completed job must be followed by fresh discovery and caption inspection. Arbitrary video upload through this pipeline is not supported.

## Security boundaries

- No credentials in frontend code, repository, source responses, evidence export, or ordinary logs
- Existing provider credentials are supplied by environment variables only
- Server-side video retrieval is restricted to normalized, discovered corpus evidence
- Failed providers do not fall back to demo predictions
- Published version/evaluation links are immutable
- Repeated replay is deduplicated by version and evidence clip
- State is stored atomically with restricted file permissions
- Any future authorized public hosting must use the isolated static fixture adapter, not a credentialed shared backend
- The backend is not multi-tenant; a real deployment requires authentication, role separation, isolation, and rate limits

## Validation

`npm run check` performs JavaScript syntax checks and Node test suites covering:

- Baseline/correction scoring and exact-version publication
- Invalid state transitions and holdout/replay leakage
- Parent-video label freezing and TRAIN-only prompts
- Abstention and event deduplication
- Mocked documented provider request contracts
- Secret redaction, safe errors, media hashes, session refresh
- Durable persistence, HTTP boundaries, CORS, hidden-file protection, video byte ranges
- Browser-local demo parity and refusal of live actions

The local browser-recording scripts are prepared to run the actual UI in Chromium in an authorized environment; their execution is still unverified. GitHub Actions is disabled. Unit tests, mocked provider tests, browser tests, and real provider execution are distinct verification categories.

## Known limitations

Synthetic fixture observations are authored metadata, not extracted from the video by a model. Fixed motion thresholds are illustrative and uncalibrated. The small scenario set does not cover perspective, occlusion, night, weather, lens changes, or adversarial examples. Human label quality and real model behavior need independent measurement. No privacy, safety, or production reliability claim is made.
