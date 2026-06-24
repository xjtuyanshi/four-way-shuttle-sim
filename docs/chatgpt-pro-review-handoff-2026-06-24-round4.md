# ChatGPT Pro Review Handoff - Round 4

## Project State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Base commit: `d9bd1f36b736fbbd77dab94622fc39b6dde53b6d`
- Current tree is dirty. Do not assume GitHub can see the local experiments unless this handoff is pasted.
- User goal: make the 3D tick high-fidelity four-way shuttle simulation stable and believable for customer review, not replace it with a pure DES. Must record every run in the rolling log with reason, changes, runtime, PPH, and failures.

## User-Level Requirements

- AMRs/shuttles must stay on the yellow-grid feasible area.
- Lift pickup/dropoff targets must be the closest yellow-grid intersection to the lift service point, not inside the lift geometry.
- Collision avoidance must prevent visual and logical overlap.
- Queue behavior should be simple and DES-like at resource boundaries: lift calls resources, AMRs queue in order, and station/resource ownership should be explicit.
- Validation gates: 10m smoke, 30m stability, then 24h with hourly PPH and per-AMR 10-minute task-count lines.

## Recent Architecture Direction

We are trying to move from scattered path/blocking rules toward station-owned resource contracts:

- inbound demand token
- AMR queueReservation
- physical queue slot occupancy/lease
- activeInboundService
- outbound station request/pass/envelope ownership

Round 3 Pro advice was interpreted as: do not add generic deadlock breakers; instead make outbound station ownership continuous from pre-gate -> service -> clear-through.

## Validation Commands

Recently passing:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "outbound station envelope passes|grants only the boundary vehicle|orphaned outbound station interior|holds outbound station envelope|stale taskless inbound queue reserve|taskless inbound queue reserve parked" --reporter=dot
```

The focused tests pass after the local R3.3 attempt, but the 10-minute simulation fails badly, so the implementation should not be accepted as-is.

## Run Evidence

Rolling log:

- `output/review/sim-run-rolling-log.html`
- `output/review/sim-run-rolling-log.json`

### R3.1b - station envelope pass baseline

10m:

- File: `output/review/physical-10m-after-station-envelope-pass-r3-1b.json`
- Result: total 498 PPH, inbound 342, outbound 156
- Final waiting: none
- Anomalies: 0

30m:

- File: `output/review/physical-30m-after-station-envelope-pass-r3-1b.json`
- Result: total 362 PPH, inbound 252, outbound 110
- Final 5m window: 0 PPH
- Final waiting: 6 vehicles
- Main failure: top inbound station queue over-target. A taskless `inbound-queue-standby` reserve stayed parked in a queue slot while active inbound service also needed the station slots.
- Evidence: SH-07 taskless reserve at `column-top-a-c23`; SH-02 active inbound task targeting `column-top-a-c23`; other active inbound vehicles stacked behind. Physical depth exceeded target.

### R3.2 - stale inbound queue reserve release

Change:

- Added a narrow release contract for taskless `inbound-queue-standby`: if active inbound service directly claims its occupied queue slot, the reserve yields out instead of holding forever.
- Added focused tests:
  - releases a stale taskless inbound queue reserve when active inbound service needs its slot
  - keeps a taskless inbound queue reserve parked when no active service claims the slot

10m:

- File: `output/review/physical-10m-after-inbound-reserve-release-r3-2.json`
- Result: total 468 PPH, inbound 318, outbound 150
- Final waiting: one transient `node-clearing` wait of 1.4s
- Anomalies: 0

30m:

- File: `output/review/physical-30m-after-inbound-reserve-release-r3-2.json`
- Result: total 408 PPH, inbound 298, outbound 110
- Final 5m window: total 84 PPH, outbound 0
- Final waiting:
  - SH-02 loaded outbound at `column-bottom-a-c07`, wait `outbound-station-await-transition`, currentWait 466.6s, task dropoff `column-bottom-b-c08`
  - SH-08 loaded outbound at `column-bottom-a-c21`, wait `outbound-station-await-transition`, currentWait 286.8s, task dropoff `column-bottom-b-c22`
  - SH-01 and SH-07 inbound empty vehicles blocked behind them in bottom-a corridor
- No physical violations and no station shadow violations.
- Diagnosis: inbound reserve problem improved, but loaded outbound vehicles reached what looks like the human-correct closest yellow-grid pre-gate (`c07` / `c21`) and then waited forever because the outbound station runtime still believed the grant boundary was somewhere else.

### R3.3 - attempted task-specific outbound boundary

Change attempted:

- Make outbound station boundary use `task.dropoffNodeId`: dropoff `column-bottom-b-c08` -> boundary `column-bottom-a-c07`; dropoff `column-bottom-b-c22` -> boundary `column-bottom-a-c21`.
- This matches the user-visible "closest yellow-grid intersection to out lift" concept.

Focused tests:

- Typecheck passed.
- Focused tests passed after correcting `columnAccessNodeId` zero-based indexing.

10m:

- File: `output/review/physical-10m-after-task-specific-outbound-boundary-r3-3.json`
- Result: total 90 PPH, inbound 90, outbound 0
- Wall clock: 172.8s for only 10m sim, much slower than previous 10m runs
- Final waiting:
  - SH-07 loaded outbound at `column-bottom-a-c04`, wait `outbound-station-await-transition`, currentWait 589.4s, task dropoff `column-bottom-b-c08`
  - SH-01 loaded outbound at `column-bottom-a-c18`, wait `outbound-station-await-transition`, currentWait 555.8s, task dropoff `column-bottom-b-c22`
  - Followers blocked behind them
- Diagnosis: direct task-specific boundary made the move blocker stop loaded outbound too early, before it can traverse the approach/meter corridor to the intended closest yellow point. This attempt should be rejected or heavily revised.

## Current Local Code Situation

The working tree currently includes both:

- R3.2 stale inbound reserve release, which appears directionally useful.
- R3.3 task-specific outbound boundary attempt, which failed 10m badly.

Recommendation before implementation: treat R3.3 as a failed experiment. Either revert it or replace it with a better outbound approach resource model.

## Key Question For Review

We need a clean resource abstraction for outbound station approach.

Observed contradiction:

- Station-level boundary / envelope pass can let a loaded outbound reach `column-bottom-a-c07` / `c21`, then wait forever because the runtime does not grant a pass there.
- Naive task-specific boundary makes the blocker stop vehicles too early (`c04` / `c18`) and outbound PPH becomes 0.

Please review the likely correct design:

1. Should outbound station be split into at least two resource zones?
   - approach/meter corridor that loaded outbound may enter in FIFO order
   - service envelope from closest yellow pre-gate through dropoff/clear-through
2. Where should the "grant pass" point be for each outbound dropoff task?
3. Which nodes should be allowed before pass, and which nodes should require pass?
4. How should station runtime handle a loaded outbound already inside the approach corridor but not yet at the exact pass point?
5. Should the outbound station runtime store task-specific boundary/pass node on the request when the task becomes loaded-ready?
6. What minimal code change should be done next, avoiding generic deadlock breakers?
7. What validation gates should decide whether the change is accepted?

## Please Avoid

- Do not recommend a full rewrite.
- Do not recommend disabling collision avoidance.
- Do not recommend a generic priority/deadlock breaker as the main fix.
- Do not recommend accepting R3.3 as-is; it failed the 10m gate.

## Desired Output

Please provide:

- Root-cause explanation.
- Minimal architecture change.
- Concrete invariants for outbound approach/pass/service/clear-through.
- Implementation order.
- Tests to add.
- 10m/30m/24h validation criteria.
