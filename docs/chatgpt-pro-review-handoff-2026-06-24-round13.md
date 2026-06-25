# ChatGPT Pro Review Handoff - 2026-06-24 Round 13

Created: 2026-06-24T22:04:08Z

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Current HEAD: `c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0`
- Working tree: dirty WIP, not committed.
- Important warning: GitHub HEAD likely does not include the newest local WIP. Treat this handoff as the source of truth for the latest changes and validation.

Tracked dirty files:

- `packages/shuttle-schemas/src/index.ts`
- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `scripts/run-physical-24h-amr-audit.ts`

New local evidence:

- `docs/chatgpt-pro-review-response-2026-06-24-round12.md`
- `output/review/core-gate-after-critical-section-p0q2.json`
- `output/review/sim-run-rolling-log.html` run 112

## User Goal

The user needs a high-fidelity 3D tick four-way shuttle simulation that can be trusted for customer review.

Hard behavioral requirements:

- Shuttles must stay on the yellow feasible grid.
- Collision avoidance must prevent visible overlap/pass-through in 2D and 3D.
- Lift/station behavior should be simple and resource-oriented: lift requests shuttle resources, shuttles queue FIFO/orderly, station ownership is explicit, and vehicles should not ping-pong near lift areas.
- Long validation must report hourly PPH, 10-minute per-AMR task counts, stuck/loop metrics, and every run must update the same rolling log with reason/change/result.

The user explicitly asked Codex not to keep blindly patching. If a scoped change creates unclassified failures, stop and ask ChatGPT Pro Extended.

## Round 12 External Review Summary

Round 12 asked about a failed local attempt to protect the full outbound station route as a spatial lease.

ChatGPT Pro response: `docs/chatgpt-pro-review-response-2026-06-24-round12.md`

Key conclusion:

- Request changes.
- Keep the idea of drain-before-grant and block new conflicting entry.
- Reject making dynamic full `routeNodeIds` a station-exclusive spatial lease.
- Correct contract should be topology-defined `station critical section = service envelope + ingress conflict segment/fence + clear-through footprint`.
- Full route can be an authorized path, but not an exclusive lease.
- Before any 30m/12h/24h run, pass:
  - static/typecheck,
  - deterministic station tests,
  - the three previously failed isolation tests,
  - full core suite,
  - replay determinism,
  - paired 10m physical run.

## What I Changed After Round 12

I rewrote the outbound station lease from full-route protection to a narrower critical-section candidate.

Main code paths in `packages/shuttle-sim-core/src/index.ts`:

- Added `outboundStationCriticalSectionNodeIds(stationId, routeNodeIds, envelopeNodeIds)`.
  - Critical nodes currently include:
    - the route node immediately before the first envelope node,
    - the service envelope nodes,
    - `topLiftOutboundServiceEntryBottomNodeId(stationId)` as clear-through footprint.
- Added `outboundStationCriticalSectionEdgeIds(routeNodeIds, criticalNodeIds)`.
- Added `outboundStationCriticalSectionClaimingVehicleIds(...)`.
  - It currently checks:
    - `nodeClaimedByOtherVehicle` for critical nodes,
    - active reservations for critical nodes,
    - active reservations for critical edges,
    - active reservations for zones touched by critical edges.
- `chooseNextOutboundStationTransition()` uses this check before starting drain/grant.
- `grantOutboundStationEnvelopePass()` repeats this check before grant.
- `outboundStationDrainProtectedNodeIds()` uses `passNodeId + criticalSectionNodeIds`, not full route.
- `stationCoordinatorOutboundProtectedMoveBlocker()` uses critical section nodes for active pass.

Updated tests in `packages/shuttle-sim-core/src/index.test.ts`:

- `drains foreign vehicles occupying an outbound station critical section before granting ownership`
- `protects the outbound station active critical section from foreign entry`

## Validation After Critical-Section Candidate

Focused tests passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "drains foreign vehicles occupying an outbound station critical section|protects the outbound station active critical section"
```

Result: 2 passed.

Outbound station group passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "outbound station"
```

Result: 10 passed.

Typechecks passed:

```bash
./node_modules/.bin/tsc -p packages/shuttle-schemas/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

Isolation gates still failed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/high-inbound.test.ts -t "keeps a 12-shuttle high-inbound stress run active" --maxWorkers=1
```

Failed: `utilizedVehicleCount=9`, expected `>=10`.

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/lift-approach.test.ts --maxWorkers=1
```

Failed: `max approachOccupancy=1`, expected `>1`.

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "keeps unready top-lift inbound work" --maxWorkers=1
```

Failed: `maxWaitSec=202`, expected `<20`. This is worse than the previous full-route attempt, where the observed failure was `completedOutbound=14` vs `>=15`.

Therefore this candidate is not safe to expand to full core, 10m physical, 30m, or 24h.

## Short-Window Diagnostic

I ran the mixed demo in 20s simulation-time segments to see whether the failure is late-run only:

```text
20s: 323ms wall, in=0, out=0, waiting=4
40s: 539ms wall, in=2, out=2, waiting=2
60s: 979ms wall, in=4, out=2, waiting=0
80s: 625ms wall, in=6, out=2, waiting=0
100s: 456ms wall, in=9, out=4, waiting=0
120s: 553ms wall, in=11, out=4, waiting=0
140s: 2870ms wall, in=12, out=5, waiting=0
160s: 1017ms wall, in=14, out=5, waiting=2
180s: 3935ms wall, in=15, out=6, waiting=0
200s: 9368ms wall, in=16, out=6, waiting=1
```

At 200s:

- `deadlockCount=0`
- `physicalViolationCount=0`
- only waiting vehicle: `SH-01`, reason `inbound-column-predecessor-wait`, wait about `14.2s`
- `reservationConflictCount=454`
- `replanCount=13`
- last notable station event around 195.2s:
  - `station-pass-granted`
  - vehicle `SH-03`
  - station `lift-02-outbound`
  - route `column-bottom-a-c21>column-bottom-b-c21>module-02-spine-bottom-b>column-bottom-b-c22`

This suggests current candidate may be adding expensive or over-broad claim checks before obvious station deadlock appears.

## Current Hypothesis

The new `outboundStationCriticalSectionClaimingVehicleIds()` may still be too broad or too expensive because it treats node/edge/zone reservations on the critical-section edge set as station claim blockers. This might:

- over-block unrelated traffic because zone reservations are shared at a broader conflict-group granularity than the station critical section;
- repeatedly create drain epochs or station-pass-blocked checks;
- increase route recomputation/path search;
- leak station-specific ownership semantics into pure inbound tests, explaining why high-inbound and lift-approach isolation tests are still red.

But this is a hypothesis, not proven.

## Questions For ChatGPT Pro

Please review Round 13 specifically. Do not just repeat the Round 12 advice.

1. Does this critical-section implementation still violate the intended resource contract?
2. Should `outboundStationCriticalSectionClaimingVehicleIds()` check active `zone` reservations, or should it be limited to current node, target node, active edge, and explicit station leases?
3. Is it wrong that this station-specific runtime can affect the two pure-inbound isolation tests? If yes, what code boundary should prevent leakage?
4. What is the smallest safe next change?
   - Option A: remove reservation/zone checks and only consider current/target/local route claims for critical nodes;
   - Option B: introduce an explicit `PhysicalLease` / station FSM resource table and stop inferring station claims from generic reservations;
   - Option C: roll back this candidate and first add deterministic two-car tests around SH-07/SH-08 with no runtime-wide behavior change;
   - Option D: another narrower step.
5. How should I profile/diagnose the 180-200s wall-time spike without patching blindly?
6. Which validation gates must be green before the next physical 10m run?

Please give a concrete reviewer decision: accept candidate, request changes, or reject candidate. Include the next 2-3 commands/tests to run and what result would prove the fix.
