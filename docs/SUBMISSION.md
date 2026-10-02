# ShowOnce submission draft

**Status:** LIVE UNVERIFIED; NOT SUBMISSION-READY. Actual VAST footage, successful NVIDIA Cosmos and W&B calls, and a recorded live result are release gates. This is a preparation draft. This file is not a contest submission and does not accept contest terms.

## Project name
ShowOnce

## One-line pitch
Teach a camera a narrow event with examples, test its boundaries, and publish an inspectable rule whose every replay decision keeps video evidence.

## Problem
Visual reasoning is easy to demo and difficult to operationalize. Operators need to define what counts, teach visually similar exceptions, inspect failure cases, reproduce a version, and explain a trigger with evidence.

## Solution
ShowOnce makes that workflow tangible: positive and hard-negative video teaching examples, an explicit rule, isolated human-labeled evaluation, TRAIN-only correction, a publication gate, and a deduplicated evidence ledger.

## What makes it distinctive
- The negative example is a first-class teaching tool
- The event rule is explicit and versioned
- Test failure blocks publication
- Data splitting is enforced by parent video, not just random segments
- Expected labels do not enter the prediction prompt
- Every decision records its execution source, exact rule, and video evidence
- Demo agreement is never represented as live model accuracy

## Sponsor usage
The repository contains documented server-side integration paths for VAST Data, NVIDIA Cosmos, and Weights & Biases Inference. The public browser demo uses authored fixtures and performs no sponsor calls. Replace this paragraph with a precise statement of completed live calls only after verifying the corresponding runtime evidence.

## Implementation
Original standalone JavaScript application, zero runtime dependencies, Node HTTP API, atomic durable state, server-side clients, browser-local public demo, synthetic fixture video generator, automated tests, and a browser-recording workflow.

## Impact hypothesis
Reduce the gap between an operator's practical event definition and an auditable camera rule. Potential domains include roadway operations and narrowly observable industrial events. This hypothesis requires user and field validation; no deployment or quantified impact is claimed.

## Links to verify before submission
- Repository: https://github.com/TurpoFIN/showonce
- Browser demo: https://turpofin.github.io/showonce/
- Demo video: add the verified completed recording link/file
- Genuine sponsor-run evidence: add only if live execution completed

## Final readiness checklist
- [ ] Public repository contains the tested final commit
- [ ] Public demo loads and completes the workflow
- [ ] Actual final video exists, plays correctly, and is at most three minutes
- [ ] Required sponsor usage is genuinely executed and evidenced, or the unmet requirement is explicitly acknowledged
- [ ] No keys, personal data, proprietary code, or unsupported performance claims
- [ ] Team identity and submission fields confirmed
- [ ] Contest IP/terms reviewed by the entrant; no acceptance delegated by this draft
- [ ] Entrant submits through the official contest flow before the deadline
