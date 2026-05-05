# ChatGPT Pro Stable Review Entry

Use this when ChatGPT Pro has trouble cloning or browsing the repository.

## Why Repo Review Can Fail

The repository and PR are public, so this is not a GitHub permission issue.

Verified public URLs:

- Repository: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Main branch: `https://github.com/xjtuyanshi/four-way-shuttle-sim/tree/main`
- Final handoff raw doc: `https://raw.githubusercontent.com/xjtuyanshi/four-way-shuttle-sim/main/docs/phase0-final-merge-handoff.md`
- Review packet raw doc: `https://raw.githubusercontent.com/xjtuyanshi/four-way-shuttle-sim/main/docs/chatgpt-pro-review-packet.md`

ChatGPT Pro may still fail because its browsing/analysis environment can hit DNS failures, clone restrictions, GitHub API truncation, or context truncation on large diffs. The most reliable workflow is to avoid clone-based review and use the raw handoff/review packet.

## Preferred Prompt

```text
Review the current public main branch for merge blockers only.

Do not clone the repository. If browsing works, read these two URLs first:

1. Final handoff:
https://raw.githubusercontent.com/xjtuyanshi/four-way-shuttle-sim/main/docs/phase0-final-merge-handoff.md

2. Review packet:
https://raw.githubusercontent.com/xjtuyanshi/four-way-shuttle-sim/main/docs/chatgpt-pro-review-packet.md

If either URL fails, do not retry with clone. Return the best review from the handoff, review packet, and the summary below.

Scope: merge-hardening only. Do not treat Phase 1 feature work or the missing 30-minute Pixel Streaming soak as a merge blocker.

Required output:
1. Must-fix findings before merge, ordered by severity.
2. Non-blocking Phase 1 recommendations.
3. Verdict: merge now, merge after fixes, or redesign needed.
```

## No-Network Fallback Prompt

```text
Final merge-blocker review. Do not browse, clone, or use network. Review only the summary below and return concrete findings. If an issue cannot be verified from the summary, mark it non-blocking/unknown.

Repo: https://github.com/xjtuyanshi/four-way-shuttle-sim
Branch: main
Head: latest pushed commit on main
Scope: merge-hardening only. No product features or architecture redesign.

Implemented hardening:
- SimCore has currentNodeOccupancy; reset occupies each starting parking/current node. Vehicles stopped/waiting at a node keep occupancy. Before departure they reserve next edge, target node, and every matching zone. Current node occupancy releases only after movement commit. Arrival atomically transfers target-node reservation into currentNodeOccupancy. Tests expose debug occupancy.
- Stopped vehicles on main-aisle portal nodes hold explicit `zone-main-portal-node-*` reservations. Portal movement zones include storage-row connector edges as well as main-lane, lift, and north/south transfer edges touching the portal.
- Orthogonal moves consume `switchDirectionSec` as a dwell phase while vehicle yaw stays 0, matching the four-way shuttle no-body-rotation assumption.
- Traffic tests cover opposite-direction same-edge conflict, target-node occupancy race, crossing zone serialization, deadlock sanity, motion profile triangular/trapezoid/boundary/zero distance, loaded speed lower than empty, reservation travel time equals movement arrival.
- Validation samples every tick and reports by-code cumulative aggregation plus first 20 examples. Codes: unreservedEdgeOccupancy, unreservedNodeOccupancy, unreservedZoneOccupancy, nodeOccupancyMismatch, edgeOccupancyMismatch, speedLimit, accelerationLimit, minSeparation, invalidCoordinate. Acceptance requires no physical safety violations and no reservation coverage violations. `minVehicleSeparationM` is diagnostic; safety acceptance uses oriented rectangular vehicle footprints plus configured clearance. state.traffic.physicalViolationCount is documented as instantaneous; validation owns cumulative counts.
- Unreal bridge uses TryGetStringField for type, handles connectionRecovered.state.vehicles, simState.state.vehicles, vehicleState.vehicles, ignores kpiUpdate/taskEvent, parses optional nullable fields defensively, skips malformed vehicles and broadcasts concise status. Unknown vehicle state strings are rejected instead of silently mapped to Idle. README documents Sim meters to UE centimeters: X=x*100, Y=z*100, Z=y*100, yaw mapping. The plugin metadata treats WebSockets as a linked UE module, not a separate UE 5.7 plugin dependency.
- Phase 0 enforces all reservation capacities = 1 and layout node/zone capacity = 1; multi-capacity deferred to Phase 1. Schema requires one parkable non-aisle node per vehicle and rejects duplicate node ids.
- FIFO storage cells must use `storage-rNN-cNN` ids, and each storage row must expose `left-row-NN` and `right-row-NN` side access nodes until explicit row/column metadata exists. Future queued inbound slots reserve logical destinations but are not treated as physical transit obstacles.
- The default dense layout exposes an assumption-grade `phase0-cad-assumption-v1` layout calibration profile through `scenario.layout.calibrationProfile` and the shared static-scene contract. Storage-cell visual footprints match storage pitch inside each dense island so cells render as contiguous grid positions, not sparse boxes.
- Dashboard merges incremental vehicleState and kpiUpdate WebSocket messages into existing state snapshot; tests added and dashboard tests are included in pnpm test.
- `pnpm shuttle:validate` includes a 600-second long-run seed sweep with by-side throughput, queue, waiting vehicle, lift-port queue, deadlock, physical safety, and reservation coverage flags. Stress scenarios require every expected bottleneck prefix, not just one matching reason.
- Playback speed input is validated/clamped, including `SHUTTLE_SPEED`.

Verification passed after latest commit:
pnpm typecheck; pnpm test (55 tests); pnpm build; pnpm shuttle:validate. Validation acceptance.pass=true, sameSeedEventHashStable=true, noDeadlocksInSweep=true, noPhysicalSafetyViolations=true, noReservationCoverageViolations=true, longRunThroughputPositive=true, longRunThroughputFloorMet=true, longRunThroughputBySideMet=true, longRunQueuesBounded=true, noLongRunDeadlocks=true, noLongRunPhysicalSafetyViolations=true, noLongRunReservationCoverageViolations=true, stressPass=true, expectedStressBottlenecksObserved=true, positiveStressThroughputWhereRequired=true, physicalViolationsByCode all zero, longRun.totalPphMean=18, longRun.maxQueuedTasks=3, longRun.maxWaitingVehicles=1, longRun.maxLiftPortQueueLength=1. WebSocket smoke passed. Browser smoke: dashboard loads, 3D canvas visible, runtime advances at 4x, vehicle table shows moving/returning states, Shuttle count and PPH sliders update the scenario, console errors=0, screenshot evidence at `output/playwright/dashboard-pro-review-smoke.png`. Unreal 5.7.4 and full Xcode are ready; compile/headless smoke and live bridge smoke passed with vehicleActors=2, receivedVehicleStates=6, maxTargetPoseErrorCm=0; staged Mac runtime generation and local browser Pixel Streaming smokes against both `UnrealEditor -game` and the staged app passed. The 30-minute soak and release hardening remain Phase 1 work after calibrated scene review.

Return only:
1. Must-fix findings before merge, with file paths if possible.
2. Non-blocking Phase 1 recommendations.
3. Verdict: merge now, merge after fixes, or redesign needed.
```
