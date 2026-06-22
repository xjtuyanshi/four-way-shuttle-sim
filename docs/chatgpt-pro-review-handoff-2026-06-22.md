# ChatGPT Pro Review Handoff - 2026-06-22

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Branch: `codex/traffic-v2-flow-debug`
- Commit: `6e053670637542cd377b07bb9e0bb23dd9d6affc`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Primary implementation file: `packages/shuttle-sim-core/src/index.ts`
- Main evidence doc: `docs/shadow-resource-ledger-step-1.md`

## User Goal

Prepare a high-fidelity 3D tick four-way shuttle simulation for customer review. The final deliverable must remain the physical 3D tick model, not a pure DES replacement. DES concepts are only acceptable as a system contract for queue, resource, lease, and event semantics inside the 3D model.

The system must be able to run long windows and explain:

- hourly inbound/outbound/total PPH,
- each AMR/shuttle's completed task count per 10-minute bucket,
- stuck, low-output, and small-loop behavior,
- collision/physical overlap violations,
- lift queue waiting and reserve behavior,
- pickup/dropoff visual synchronization in the 3D viewer.

## Core Problem

The current 3D tick simulation is stable enough to run short windows, but the station/lift queue behavior is still not architecturally clean.

Observed symptom cluster:

- AMRs can spend too much time away from the inbound lift queue.
- When an inbound lift has ready demand and no head reservation, all useful AMRs are often busy or far from the station.
- Naive "send taskless AMR to queue reserve" changes add relocation travel and hurt throughput.
- We need a principled station-owned queue/resource contract, not more one-off route patches.

## Current Baseline

Latest pushed source baseline:

- Branch: `codex/traffic-v2-flow-debug`
- Commit: `6e053670637542cd377b07bb9e0bb23dd9d6affc`
- 600s station-owned diagnostic:
  - total PPH `570`
  - inbound PPH `258`
  - physical violations `0`
  - `zeroReserveDuringHeadGapPct = 1`
  - `averageReserveEligibleVehicleCount = 0`
  - `outboundWhileReserveEligible = 0`
  - `outboundAssignedReserveEligible = 0`
- 600s bounded near-station diagnostic:
  - total PPH `570`
  - inbound PPH `258`
  - physical violations `0`
  - `dispatchableReserveRouteQuality.total = 0`
  - `dispatchableReserveRouteQuality.boundedNearStation = 0`
  - `stationReleaseOpportunitySummary.totalStationGaps = 56`
  - `stationReleaseOpportunitySummary.withStationSpecificReleaseRoute = 0`
  - `stationReleaseOpportunitySummary.withBoundedNearStationRoute = 0`
  - `releasedStandbyRouteSummary.total = 16`
  - `releasedStandbyRouteSummary.originAllowed = 0`
  - `releasedStandbyRouteSummary.boundedNearStation = 0`

Important interpretation:

When head reservation is missing, there are no true near-station reserve candidates. The apparent releaseable routes are long paths from bottom/middle/storage back to top queue:

- `bottom-a>middle>top-b>top-a`: `11`
- `bottom-b>bottom-a>middle>top-b>top-a`: `2`
- `middle>top-b>top-a`: `2`
- `storage>middle>top-b>top-a`: `1`

## Rejected Experiments

1. Broader outbound gate / available-pool reserve gate.
   - Result: no useful improvement; head-gap samples still had no routeable reserve candidate.

2. Direct `tryAssignQueuedTaskToVehicle` reserve gate.
   - Result: worse 600s window:
     - before total PPH `570`, inbound PPH `258`
     - after total PPH `552`, inbound PPH `228`
     - physical violations stayed `0`
   - Decision: rejected.

3. Planned reserve depth 2 without concrete demand.
   - Result: failed the guard `does not pre-stage taskless mixed-flow shuttles without concrete inbound work`.
   - Decision: rejected because it recreates random queue occupation.

4. Demand-aware station-owned dispatch from middle routes.
   - Typecheck and targeted tests passed, but behavior regressed:
     - station diagnostic total PPH `570 -> 552`
     - inbound PPH `258 -> 228`
     - queue-reserve efficiency total PPH `486 -> 444`
     - inbound PPH `288 -> 270`
     - demand outbound PPH `198 -> 174`
     - `outboundWhileReserveEligible` regressed `0 -> 1`
     - `averageCoveredDepth` only improved `0.817 -> 0.833`
     - `averageStandbyDepth` stayed `0`
   - Decision: rejected and reverted.

## Current Hypothesis

This is a system contract problem, not a single shortest-path bug.

The next behavior-changing cut should probably introduce a station-owned bounded lease:

- physical queue slot,
- immediate top-a/top-b approach target,
- FIFO/TTL ownership,
- no middle/bottom/storage admission unless the vehicle first becomes a bounded near-station candidate,
- source-of-truth state separate from route-wide planned claims,
- diagnostics that prove no PPH regression, no AMR low-output windows, and no physical violations.

## Validation Commands Already Used

```bash
git diff --check
pnpm --filter @four-way-shuttle/sim-core typecheck
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "shadow resource ledger|stale local-route|blocked waiters|reservation-blocked|waiting route fields"
./node_modules/.bin/tsx scripts/diagnose-idle-reserve-pool.ts --duration-sec 600 --dt-sec 0.2 --sample-sec 10 --out output/review/idle-reserve-pool-600s-station-owned-diagnostic.json
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --dt-sec 0.2 --sample-sec 10 --out output/review/station-queue-contract-600s-station-owned-diagnostic.json
./node_modules/.bin/tsx scripts/diagnose-assignment-admission.ts --duration-sec 600 --dt-sec 0.2 --out output/review/assignment-admission-600s-station-owned-diagnostic.json
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --dt-sec 0.2 --sample-sec 10 --near-route-max-nodes 4 --progress-sec 300 --out output/review/station-queue-contract-600s-bounded-near-station.json
```

## Questions For ChatGPT Pro

Please review the repo, branch, and this handoff as an external senior reviewer.

1. Is the current problem best understood as a station/lift resource contract problem rather than a path-planning bug?
2. What is the minimal viable architecture change to make the 3D tick simulation robust without rewriting it as pure DES?
3. How should the abstractions be defined for AMR resource, lift demand, queue reservation, physical slot occupancy/lease, active inbound service, and outbound assignment?
4. How should station-owned FIFO/TTL queue leases be implemented so they do not create random pre-staging or long relocation travel?
5. Which current logic should be preserved, and which patch pattern should be stopped?
6. What exact validation gates should pass before committing a behavior-changing source cut?
7. Based on the metrics above, what should the next source change be?
