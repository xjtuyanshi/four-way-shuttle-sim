# ChatGPT Pro Review Handoff Round 2 - Outbound Station Coordinator Still Stuck

Date: 2026-06-24

## Repo State

- Repo: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Branch: `codex/traffic-v2-flow-debug`
- Last pushed/local HEAD before this handoff: `d9bd1f36b736fbbd77dab94622fc39b6dde53b6d`
- Local workspace: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Important limitation: the latest station-coordinator experiments are still local working-tree changes. If you cannot see them through GitHub, use this handoff and the listed file paths/snippets as the source of truth.

## User Goal

The goal is still a high-fidelity physical 3D tick simulation for customer review:

- 8 shuttles by default.
- AMRs must stay on the yellow feasible graph.
- No physical overlap or station throat crossing.
- Lift stations must behave like simple DES queues: station calls shuttles, shuttles queue in order, only the head enters service.
- The final product must pass 12h/24h runs with hourly inbound/outbound PPH and 10-minute per-AMR completed-task trends.

The user explicitly asked us not to keep blindly patching. If the same station failure persists, we should consult ChatGPT Pro Extended with clear evidence.

## Previous External Review Summary

Previous ChatGPT Pro Extended review was saved in:

- `docs/chatgpt-pro-review-response-2026-06-24.md`

Decision from that review: request changes.

Key recommendation:

- Add a narrow `StationPairCoordinator`.
- Stop adding outbound-lift-specific deadlock breakers.
- Stop rebuilding station FIFO from active task scans or `plannedGoalNodeId` route tails.
- Use a persistent station-owned contract:
  `work admission -> loaded-ready queue-slot lease -> head-only throat/service grant -> explicit release`.

## What Was Changed Locally After That Review

The local WIP attempted a minimal source-of-truth step for outbound stations.

Schema changes in `packages/shuttle-schemas/src/index.ts`:

- `StationKernelDemandToken.source` now includes `outbound-task`.
- Station contract demand now includes `outbound-task`.
- Vehicle commitment now includes `activeOutboundService`.
- Route lease now includes `protectedThroatLease`.
- Station snapshots can be `inbound` or `outbound`.
- Added station pair coordinator snapshot shape.

Core changes in `packages/shuttle-sim-core/src/index.ts`:

- Added outbound station demand tokens and outbound queue lease collection.
- Added outbound station shadow contracts and station pair coordinator diagnostics.
- Added movement-time gate:
  - non-head vehicles cannot enter station protected throat/slot1;
  - only FIFO head can request throat/service grant.
- Added dispatch-time gate:
  - head can move toward meter slot1;
  - follower vehicles should use follower meter slots or hold queue position;
  - followers should not be dispatched directly to slot1.
- Changed outbound active queue ordering to physical meter slot order first, then lease `fifoSeq`.

Focused tests added in `packages/shuttle-sim-core/src/index.test.ts`:

- outbound station shadow contract and pair coordinator state;
- station-owned outbound FIFO lease as throat source of truth;
- follower dispatch does not choose throat slot;
- physical outbound meter slot order beats lease age when selecting head;
- station route/kernel lease invariant checks.

## Validation Results After Local WIP

Focused tests:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "outbound station shadow|station-owned outbound FIFO|dispatches outbound FIFO followers|physical outbound meter slot order|station-owned shadow contracts|station kernel queue leases|station route leases" --reporter=dot
```

Result: passed, `8 passed | 505 skipped`.

Typecheck:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shuttle-schemas/tsconfig.json --noEmit
```

Result: both passed.

Full sim-core test file is not globally green from earlier WIP:

- Previous observed status: `482 passed / 28 failed`.
- Treat this branch as review/WIP, not release-ready.

## Physical-Tick Smoke Evidence

### v3 - Movement gate only

File:

- `output/review/physical-10m-after-outbound-station-source-gate-v3.json`

Result:

- Stopped at 540s due to critical.
- Total PPH: `326.667`
- Inbound PPH: `306.667`
- Outbound PPH: `20`
- Critical: `deadlock-count-increased`
- Active candidates: `SH-01, SH-02, SH-07, SH-08`
- Final waits:
  - `SH-01`: `outbound-station-fifo-head-wait`, blocker `SH-07`
  - `SH-02`: `outbound-station-fifo-head-wait`, blocker `SH-07`
  - `SH-07`: `node-occupied`, blocker `SH-08`
  - `SH-08`: `outbound-station-lease-missing`, blocker `SH-07`

Interpretation:

- Movement gate restored a little outbound throughput but created a station FIFO deadlock.
- The dispatch layer was still sending non-head vehicles toward slot1/protected throat.

### v4 - Dispatch gate added

File:

- `output/review/physical-10m-after-outbound-station-dispatch-gate-v4.json`

Result:

- Completed 600s.
- Total PPH: `276`
- Inbound PPH: `276`
- Outbound PPH: `0`
- Critical anomalies: `0`
- Final waiting vehicles: `0`
- AMR anomaly:
  - `SH-07` `node-ping-pong`
  - path `67.13m`
  - net `2.556m`
  - bbox `4m`
  - loopiness `26.267`

Interpretation:

- The critical station FIFO deadlock chain was not reproduced.
- But outbound was fully suppressed in the first 10 minutes.
- Evidence suggested slot1 could remain empty while slot2/slot3 vehicles did not compress, because head selection was still affected by lease age.

### v5 - Physical slot order first

File:

- `output/review/physical-10m-after-outbound-slot-order-v5.json`

Result:

- Completed 600s.
- Total PPH: `276`
- Inbound PPH: `276`
- Outbound PPH: `0`
- Critical anomalies: `0`
- Final waiting vehicles: `1`
- Waiting vehicle:
  - `SH-08`
  - current `column-bottom-a-c03`
  - target `column-bottom-b-c03`
  - wait reason `node-occupied`
  - blocker `SH-07`
  - current wait about `407.6s`
- AMR anomaly:
  - `SH-08` `long-wait-window`
  - blocked `410s`
  - end wait reason `node-occupied`
  - end blocker `SH-07`

Interpretation:

- Sorting queue head by physical slot order was not sufficient.
- Outbound is still 0 after 10 minutes.
- We are still mixing station service/queue/throat route ownership. Some loaded outbound vehicles enter/occupy bottom nodes but are not completing dropoff service.

## Current Working Hypothesis

The local WIP is still only a partial coordinator. It added tokens and gates, but it did not complete the source-of-truth cut recommended by the prior review.

Likely broken boundary:

- Queue leases are still derived from vehicle `currentNodeId`, `targetNodeId`, and `plannedGoalNodeId`.
- Dispatch can still return current-node self-goals for followers, which can produce loaded assigned vehicles with no useful route.
- The same bottom-b/bottom-a nodes are sometimes interpreted as meter slots, service-entry, protected throat, and general traffic nodes.
- The station coordinator is not yet issuing an atomic transition:
  `reserve target slot -> move -> release source slot`.
- The protected throat can still be occupied or blocked by a vehicle that is not making a station service transition.

## Question For ChatGPT Pro Extended

Please review this second-round evidence and answer:

1. Is the current WIP still violating your previous recommendation because leases are derived from physical route state instead of issued by the coordinator?
2. What is the smallest next architecture cut that will make outbound station behavior correct?
3. Should we pause all dispatch to the outbound station unless a coordinator-issued `workAdmission` and `queueSlotLease` exists?
4. How should the station represent slot compression (`slot3 -> slot2 -> slot1`) without returning self-goal routes or using generic traffic deadlock breakers?
5. Should bottom-b/bottom-a station nodes be made station-exclusive while serving outbound, so non-station traffic cannot use or wait in the protected throat?
6. What should the exact invariant be for one outbound lift station at every tick?
7. Which local WIP changes should be kept, reverted, or replaced before the next 10m/30m/1h gate?

Please give a concrete implementation plan with stop conditions. Avoid broad rewrite advice; we need a minimal path back to a 3D physical-tick model that can pass 12h/24h.

