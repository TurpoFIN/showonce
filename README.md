<div align="center">

<img src="public/favicon.svg" width="64" alt="ShowOnce mark">

# ShowOnce
### Teach a camera what matters. Test the boundary. Keep the proof.

A video-first event studio for turning a few examples into an explicit, evaluated, versioned visual rule.

[Run locally](#run-locally) · [Demo walkthrough](docs/DEMO.md) · [Architecture](docs/ARCHITECTURE.md) · [Server setup](server/README.md) · [Live release gate](docs/LIVE_RUN.md)

</div>

---

> **LIVE INTEGRATIONS UNVERIFIED — NOT SUBMISSION-READY.** The current source and synthetic fixture mode are a workflow/QA milestone only. No hosted demo, GitHub Actions run, or completed live recording is available. Final release requires actual VAST corpus footage, successful NVIDIA Cosmos and W&B calls, a genuine evaluated rule, and a recorded live end-to-end result. Mock tests and fixture agreement do not satisfy that release gate.

## The idea

A camera can describe what it sees. An operations team needs something more specific: **does this moment meet our definition of an event, and can we prove why?**

ShowOnce lets an operator teach an event with a positive clip and a few hard negatives. It turns that lesson into an inspectable rule, checks the rule against separately labeled footage, and publishes only a passing version. A replay produces a ledger entry with the exact rule and linked video evidence.

The example is deliberately narrow: **a vehicle stationary in an active travel lane for at least eight seconds.** A car on the shoulder and slow traffic are visually similar, but operationally different. Those boundaries are the product.

## Try it in two minutes

Run the app locally using the instructions below. Open `http://127.0.0.1:3000/?demo=local` for the isolated browser-local fixture mode. That mode needs no account, API key, runtime package installation, or paid provider. Each browser gets its own local workspace. Public hosting is not deployed and GitHub Actions is disabled.

1. Play the positive teaching clip, then choose **Generate rule**
2. **Test on holdout**: the deliberately permissive baseline agrees with 4 of 6 authored fixtures; two false alerts block publication
3. **Teach the boundary** using the shoulder and slow-traffic **TRAIN** examples
4. Test the corrected version: 6 of 6 authored fixtures agree
5. **Publish this version**, then **Replay & detect**
6. Open **View clip** in the ledger. The event retains its evidence, rule snapshot, and provenance
7. Replay again. The same rule/clip pair is deduplicated

> **Honest demo boundary:** the bundled videos are authored synthetic traffic scenes. Demo decisions are deterministic comparisons against authored feature values. “4/6 → 6/6” is fixture agreement, **not measured model accuracy**. The browser demo never calls VAST, NVIDIA, or W&B. Reusing a frozen holdout after correction is a regression comparison, not a fresh unseen test.

## What is implemented

- A responsive, keyboard-accessible video studio with playable evidence, training examples, rule inspection, dataset separation, version history, readiness status, and an operations ledger
- Explicit include/exclude criteria and temporal/motion thresholds
- Separate TRAIN, HOLDOUT, and REPLAY splits; live splits are enforced by original parent video
- Human labels isolated from model prediction requests; corrections consume TRAIN examples only
- Frozen holdout labels, membership, and evidence hashes
- Publication blocked until every labeled holdout case agrees and none are uncertain
- Immutable published versions, rule snapshots, evidence windows, event deduplication, and a downloadable JSON audit bundle
- A durable, zero-runtime-dependency Node server with real server-side sponsor clients
- A portable browser-local fixture adapter for local workflow QA
- Automated backend, adapter-contract, static-demo, security, persistence, and release-gate checks, plus prepared browser-recording scripts

## Three sponsor integration paths

| Tool | Real application role | Implementation | Verification boundary |
|---|---|---|---|
| **VAST Data** | Discover indexed video evidence; optionally reingest one existing TRAIN video with a focused caption prompt | Documented search, authenticated media, queued reingest and job polling | Contract tested with mocks; needs the assigned workshop endpoint and authorized credentials |
| **NVIDIA Cosmos** | Observe TRAIN video and predict an event from HOLDOUT/REPLAY video | Server-side video bytes, model discovery, structured reasoning response and abstention | Contract tested with mocks; needs the assigned Cosmos endpoint |
| **Weights & Biases Inference** | Generate and revise the explicit rule from TRAIN observations and labels | OpenAI-compatible inference endpoint, explicit configured model, structured output validation | Contract tested with mocks; needs an authorized API key and model |

Readiness distinguishes **not configured**, **configured but unverified**, **ready**, and **error**. A mock passing test is never presented as a successful live sponsor call. Real live execution is not claimed until corresponding provenance is recorded.

## Run locally

Requires **Node 22 or later**. No npm install is needed for the app or unit tests.

```bash
git clone https://github.com/TurpoFIN/showonce.git
cd showonce
npm start
```

Open http://127.0.0.1:3000. To exercise the isolated browser adapter with the local server, open `http://127.0.0.1:3000/?demo=local`.

```bash
npm run check
```

For real providers, copy `.env.example` to `.env` and configure the authorized workshop environment on your own machine. Never commit credentials. See [server/README.md](server/README.md) for the exact setup, API, and trust boundaries.

**Do not expose a credentialed Node server directly to the public internet.** It is a single-workspace prototype without an account/authentication layer. Keep it on loopback or use an authenticated reverse proxy. The browser-local fixture adapter has no provider credentials, remote calls, or shared mutable server state. It is not currently deployed to a public host.

## Fixture QA recording and required live video

`scripts/record-demo.mjs` prepares local Chromium workflow QA using synthetic fixtures. `scripts/record-live.mjs` separately records inspection of an already completed, verified live run and refuses fixture-only evidence. Neither script has produced a completed recording in the current verification state.

Run recording only in the authorized workshop/local environment. No GitHub Actions workflows are included or enabled, and no paid CI or new hosting service is required. A synthetic recording is QA evidence, not the final contest demo. The final video must show genuine provider execution and real corpus evidence, and stay under three minutes.

- [Three-minute storyboard](docs/DEMO.md)
- [Submission draft and readiness checklist](docs/SUBMISSION.md)
- [Architecture and limitations](docs/ARCHITECTURE.md)
- [Fixture generator](scripts/generate-fixtures.py): reproducible MP4/JPG assets using Python, Pillow, and FFmpeg

## Why this is useful

The unit of deployment is an **event definition with evidence**, not an opaque prompt. That makes it possible to ask practical questions: what examples taught this rule, what cases failed, what changed, which version generated an event, and which clip supports it?

Potential applications include roadway operations, loading zones, workcell handoffs, and other narrow, visually observable events. These are use cases to validate, not production deployments or performance claims. This prototype does not infer identity, intent, illegality, or a crash, and it does not dispatch operational alerts.

## Scope and next steps

Real sponsor execution, broader independently labeled evaluation, calibration under camera motion/occlusion/night conditions, secure multi-user access, and production alert integrations remain work to validate. Six engineered fixtures cannot establish operational reliability.

Original standalone implementation. No proprietary project code is included. No project license or contest agreement is accepted by this repository.
