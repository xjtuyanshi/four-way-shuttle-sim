# ChatGPT Pro Review Handoff - 2026-06-25 Deadline Pass

Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`

Branch: `codex/traffic-v2-flow-debug`

Current base commit before this handoff checkpoint: `8a86470df02baf08a9e94e47c8cccd7d8f46ae11`

Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`

## User Goal

The user needs the high-fidelity physical / 3D tick shuttle simulator to be stable, explainable, and believable for customer review. The final answer should not be a pure DES replacement. DES-style resource contracts are acceptable as the organizing principle, but the visual 3D tick model must remain the high-fidelity simulator.

The user set a hard local deadline: **2026-06-25 12:30 PDT**. If not solved by then, stop feature/debug work and commit the best usable code, docs, and known issues to GitHub for another AI.

## Current Best Usable Code State

The current code checkpoint keeps a targeted fix for a c01/c02 adjacent faceoff deadlock classifier/recovery issue:

- `packages/shuttle-sim-core/src/index.ts`
  - `deadlockCandidateHasActiveRecovery` now treats an unexpired conflict session involving the candidate pair as active recovery.
  - It also recognizes a third-party yielder that is actively clearing an escape side for a candidate.
  - Top-lift adjacent faceoff recovery tries loaded-inbound retarget or proactive third-party escape-blocker clearance.
- `packages/shuttle-sim-core/src/index.test.ts`
  - Adds regression tests for loaded-inbound retarget, third-party yielder recognition, unexpired pair conflict session handling, and proactive escape-blocker clearance.

Validation passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "(deadlock recovery|third-party middle-aisle yielder|third-party escape blocker|pair conflict session has not timed out|outbound station envelope|outbound station)" \
  --maxWorkers=1

pnpm -r --if-present typecheck
```

## Runs And Evidence

### Baseline 6h Before Current Fix

File: `output/review/physical-6h-after-shadow-intent-cleanup.json`

- Final simulated time: `21600s`
- Run status: `completed`
- Total PPH: `441.333`
- Inbound PPH: `224.333`
- Outbound PPH: `217`
- Physical violations: `0`
- Critical AMR anomalies: `0`
- Deadlocks: `1`

Known deadlock:

- Around `11185s`, `SH-02` loaded inbound at `column-middle-c02` wanted `column-middle-c01`.
- `SH-08` empty outbound at `column-middle-c01` wanted `column-middle-c02`.
- The pair eventually recovered, but the smoke detector counted it as a confirmed deadlock while conflict arbitration was still inside its timeout window.

### Targeted 12000s Gate After Current Fix

File: `output/review/physical-12000s-after-conflict-session-recovery-window.json`

- Final simulated time: `12000s`
- Run status: `completed`
- Total PPH: `435.9`
- Inbound PPH: `228.3`
- Outbound PPH: `207.6`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `0`
- Critical AMR anomalies: `0`

Interpretation:

- The known c01/c02 faceoff did not become a confirmed deadlock in this target window.
- This is useful, but it is **not** proof of 6h or 24h stability.

### 6h Gate After Current Fix

File: `output/review/physical-6h-after-conflict-session-recovery-window.json`

- Intended duration: `21600s`
- Actual final simulated time: `16200s`
- Run status: `stopped-critical`
- Stop reason: `critical-evidence`
- Total PPH at stop: `422.889`
- Inbound PPH at stop: `218.222`
- Outbound PPH at stop: `204.667`
- Physical violations: `0`
- Deadlocks: `0`
- Station contract critical violations: `2`
- AMR anomalies: `15`
- Critical AMR anomalies: `9`

What improved:

- The prior `11185s` c01/c02 deadlock did not recur.

What failed:

- At `16200s`, station/throat behavior near `lift-02-outbound` froze multiple AMRs.
- `SH-01`: `column-bottom-a-c21`, waiting `node-occupied`, blocker `SH-05`.
- `SH-02`: `column-bottom-b-c19`, waiting `outbound-station-await-transition`.
- `SH-05`: `module-02-spine-bottom-a`, `state=loaded-moving`, target `column-bottom-a-c22`, but `currentEdgeId=null`, `legRemainingM=0`, `waitReason=null`, zero movement.
- `SH-07`: `column-bottom-b-c21`, waiting `node-occupied`, blocker `SH-08`.
- `SH-08`: `module-02-spine-bottom-b`, waiting `node-occupied`, blocker `SH-05`.

Station contract critical violations:

- `station-exclusive-lease-has-foreign-occupant`: active pass for `SH-07` includes `module-02-spine-bottom-b`, but `SH-08` occupies it.
- `station-lease-progress-timeout`: active pass for `SH-07` exceeded `expectedCompleteBySec=15122.8`.

## Rejected Experiments

### Rejected Attempt 1: Fully Authoritative Outbound Station Goal

File: `output/review/physical-16500s-after-station-controlled-outbound-goal.json`

Idea:

- For loaded outbound station-controlled tasks, make the outbound station coordinator the only source of truth.
- If it returned no goal, hold at `outbound-station-await-transition` instead of falling back to ordinary dropoff routing.

Result:

- Intended duration: `16500s`
- Actual final simulated time: `3000s`
- Run status: `stopped-critical`
- Total PPH at stop: `397.2`
- Critical anomalies: `8`

Why rejected:

- It failed much earlier than the previous best usable version.
- It over-constrained early flow and created stationary windows around inbound queue and middle/storage nodes.
- Code and test changes from this attempt were reverted.

### Rejected Attempt 2: Honor `outbound-station-await-transition-clearance` Local Route As Goal

File: `output/review/physical-16500s-after-outbound-clearance-goal.json`

Idea:

- Treat `localRouteReason=outbound-station-await-transition-clearance` like `bottom-lane-meter-clearance` inside `agentGoalNodeId`, so the local clearance route can actually start moving.

Result:

- Intended duration: `16500s`
- Actual final simulated time: `3600s`
- Run status: `stopped-critical`
- Total PPH at stop: `361`
- Critical anomalies: `11`

Why rejected:

- It also failed earlier than the current best usable version.
- It made early bottom/middle queue behavior worse.
- Code and test changes from this attempt were reverted.

## Current Hypothesis

The remaining problem is not a single pathfinding bug. It appears to be a station/throat ownership and arbitration problem:

- `lift-02-outbound` active service/envelope ownership can overlap with inbound approach / foreign occupant movement.
- Vehicles can enter a state where the logical state says `loaded-moving`, but no edge is active and no wait reason is recorded.
- Recovery routines can install local clearance routes, but without a unified station-pair traffic contract, those local clearances can make other station queues worse.
- The simulator needs a clearer contract for station pair throat ownership, not more ad hoc node-swap patches.

## Questions For ChatGPT Pro

Please review the current branch and this handoff. Focus on architecture and failure modes, not just one-line patches.

1. Is the remaining failure best understood as a station/throat resource-contract bug rather than pathfinding?
2. What is the minimal refactor that preserves the physical 3D tick simulator but introduces a cleaner DES-like station pair coordinator?
3. How should ownership be modeled for:
   - outbound station active pass / service envelope
   - inbound queue approach through the same module throat
   - bottom-a / bottom-b queue slots
   - temporary local clearance / drain routes
   - active service vs requested visit vs queued demand
4. What should be the invariant checks that prevent a vehicle from being `loaded-moving` with no edge, no wait reason, and no progress?
5. Which existing logic should be preserved, and which recovery helpers should be deprecated or quarantined behind a new coordinator?
6. What is the validation ladder? The user requires hourly PPH, every-10-minute per-AMR task counts, stuck/no-task windows, physical collision checks, station contract critical counts, and eventually 24h.

Please give a concrete priority plan with pass/fail gates and the smallest safe implementation sequence.
