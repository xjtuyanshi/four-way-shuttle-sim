# Review Hardening Report

Branch: `main`
Base commit: `15f185a Add Phase 0 validation gate`  
Hardening scope: branch commits after the base commit through this report.

## Verdict Addressed

An earlier external review verdict was: merge after fixes. This report maps those required fixes to the implementation now on `main`.

## Required Fix Mapping

### 1. Node Occupancy Ownership

Implemented in `packages/shuttle-sim-core/src/index.ts`.

- `currentNodeOccupancy` is initialized on reset.
- Stopped and waiting vehicles keep occupying their current node.
- A vehicle reserves the next edge, target node, and matching zone before movement starts.
- If an edge and target node match multiple zones, every matching zone is reserved.
- Current node occupancy is released only after movement is committed.
- Arrival atomically transfers ownership into `currentNodeOccupancy`.
- `getDebugState()` exposes node occupancy for tests and validation.

Regression coverage:

- `keeps explicit node occupancy ownership while vehicles wait and move`
- `prevents a target-node occupancy race while the current occupant waits`

### 2. Traffic-Control Regression Tests

Implemented in `packages/shuttle-sim-core/src/index.test.ts`.

- Opposite-direction same-edge conflict.
- Target node occupancy race.
- Crossing zone conflict.
- Deadlock sanity: linear wait chain is not a candidate; synthetic wait-for cycle is a candidate.

### 3. Reservation Coverage Validation

Implemented in `apps/shuttle-api/src/validation.ts`.

Validation samples every tick and checks:

- moving vehicle has an active edge reservation
- moving vehicle has an active target-node reservation
- zone occupancy has an active zone reservation or node-zone hold
- stopped vehicle is registered in current node occupancy
- node/edge reported state matches physical position within tolerance

Violation codes:

- `unreservedEdgeOccupancy`
- `unreservedNodeOccupancy`
- `unreservedZoneOccupancy`
- `nodeOccupancyMismatch`
- `edgeOccupancyMismatch`
- `speedLimit`
- `accelerationLimit`
- `minSeparation`
- `invalidCoordinate`

### 4. Validation Report

Implemented in `apps/shuttle-api/src/validation.ts`.

The report now includes:

- `physicalViolationCount`
- `physicalViolationsByCode`
- `physicalViolationExamples` with first 20 examples
- `acceptance.noReservationCoverageViolations`

`docs/shuttle-phase0.md` clarifies that `state.traffic.physicalViolationCount` is instantaneous, while the validation gate owns cumulative aggregation.

### 5. Motion Profile Tests

Implemented in `packages/shuttle-sim-core/src/index.test.ts`.

Covered:

- triangular profile
- trapezoidal profile
- boundary distance
- zero distance
- loaded speed slower than empty speed
- reservation travel time matching movement arrival time within tolerance

### 6. Unreal Bridge Schema Alignment

Implemented in `unreal-bridge/Source/ShuttlePhase0Bridge/Private/ShuttleStateSubscriberSubsystem.cpp`.

- Uses `TryGetStringField` for `type`.
- Handles `connectionRecovered.state.vehicles`.
- Handles `simState.state.vehicles`.
- Handles `vehicleState.vehicles`.
- Ignores `kpiUpdate` and `taskEvent`.
- Skips malformed vehicles and broadcasts concise bridge status.
- Parses nullable/optional fields defensively.

### 7. Unreal Coordinate Contract

Documented in `unreal-bridge/README.md`.

- SimCore units: meters.
- Unreal units: centimeters.
- `UE.X = sim.x * 100`
- `UE.Y = sim.z * 100`
- `UE.Z = sim.y * 100`
- `UE.Yaw = radiansToDegrees(sim.yaw)`

### 8. Phase 0 Capacity Policy

Implemented in `packages/shuttle-schemas/src/index.ts` and documented in `README.md` / `docs/shuttle-phase0.md`.

Phase 0 enforces:

- `trafficPolicy.edgeCapacity = 1`
- `trafficPolicy.nodeCapacity = 1`
- `trafficPolicy.zoneCapacity = 1`
- node layout `capacity = 1`
- zone layout `capacity = 1`
- at least one parkable non-aisle node per vehicle
- unique node ids before reset occupancy is initialized

Multi-capacity reservation accounting is explicitly deferred to Phase 1.

## ChatGPT Pro Follow-Up Fixes

After the review packet was submitted to ChatGPT Pro, it returned two actionable follow-ups before its network-based review stalled:

- Dashboard incremental stream messages could leave React/3D state stale if only `vehicleState` or `kpiUpdate` messages are consumed.
- Schema validation should reject duplicate parking node ids.

Follow-up fixes:

- `apps/shuttle-dashboard/src/App.tsx` now merges `vehicleState` messages into the current state snapshot and applies `kpiUpdate` snapshots.
- `apps/shuttle-dashboard/src/App.test.ts` covers both stream reducers, and `vitest.config.ts` includes dashboard tests in the default test run.
- `packages/shuttle-schemas/src/index.ts` rejects duplicate node ids, and `packages/shuttle-sim-core/src/index.test.ts` covers duplicate parking node ids before reset occupancy is initialized.

## External Review Status

An earlier no-network merge-blocker review against commit `28d6aeb112440998e8d6a603ab35065b73ccde52` returned `merge now`.

The earlier public-branch ChatGPT Pro review against the UE-ready branch returned: `merge after fixes`. This local pass addresses those must-fix findings:

- Safety validation now uses oriented rectangular vehicle footprints plus configured clearance, not a center-point disk proxy.
- `pnpm shuttle:validate` now includes a 600-second long-run sweep with queue, waiting vehicle, lift-port queue, deadlock, physical safety, and reservation coverage acceptance flags.
- FIFO storage schema now requires `storage-rNN-cNN` cell ids and matching `left-row-NN` / `right-row-NN` side access nodes until explicit row/column metadata exists.
- Route planning no longer treats future queued inbound slot assignments as physical storage obstacles.
- Playback speed input is validated/clamped, including `SHUTTLE_SPEED`.
- UE readiness docs now distinguish local compile/headless/live/staged/browser Pixel Streaming smoke coverage from the later 30-minute soak and release hardening.
- Lift-port wording is documented as diagnostics/allocation time, not true mechanical service utilization.

The follow-up ChatGPT Pro review against commit `717858e` returned `merge after fixes`. This pass addresses the concrete blockers and small contract issues it raised:

- Stopped vehicles on portal nodes now keep an explicit `zone-main-portal-node-*` hold while waiting, so a shuttle blocked at a lift/main-aisle portal still serializes conflicting lift/transfer moves.
- Main-aisle portal movement zones now include all movement edges touching that portal node, including storage-row connector edges, closing the collision window between a shuttle exiting storage and another shuttle leaving the same main-aisle node.
- Orthogonal moves now consume `switchDirectionSec` as a dwell phase while keeping `yaw=0`, matching the four-way shuttle assumption that the body does not rotate for right-angle moves.
- Stress validation now requires every expected bottleneck prefix for a scenario, not just any one of them.
- Long-run acceptance now checks inbound and outbound throughput separately when both sides have requested demand.
- Unreal bridge vehicle parsing now rejects unknown operational states with a concise bridge status instead of silently mapping them to `Idle`.

The re-review against commit `9cd328659bd9a10a27e32cca12b9197544d4af9b` returned `Merge now`.

No must-fix findings remained. The reviewer explicitly treated the remaining items as Phase 1: proportional by-side throughput floors, node-plus-axis direction-switch readiness for future dynamic replanning, orthogonal-only validation for externally supplied layouts, CAD/vendor calibration, true push-lane mechanics, and the 30-minute Pixel Streaming soak.

Non-blocking follow-ups were moved to Phase 1:

- multi-capacity reservation semantics after Phase 0
- 30-minute Pixel Streaming runtime soak after calibrated scene review
- same-node/zero-distance traffic-transition coverage if future route generation can produce it
- more dashboard stream reducer ordering/removal cases
- positive-control validator fixtures for every violation code
- CAD/dimension audit for the browser visual layout versus a real vendor drawing
- release-grade Pixel Streaming soak after calibrated scene review

## Latest Verification

Last full verification on this branch passed locally after the latest public-branch review fixes:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm shuttle:validate
```

Key validation result:

```text
acceptance.pass=true
sameSeedEventHashStable=true
noDeadlocksInSweep=true
eventLogsPresent=true
noPhysicalSafetyViolations=true
noReservationCoverageViolations=true
longRunEventLogsPresent=true
longRunThroughputPositive=true
longRunThroughputFloorMet=true
longRunThroughputBySideMet=true
longRunQueuesBounded=true
noLongRunDeadlocks=true
noLongRunPhysicalSafetyViolations=true
noLongRunReservationCoverageViolations=true
stressPass=true
noStressDeadlocks=true
noStressPhysicalSafetyViolations=true
noStressReservationCoverageViolations=true
expectedStressBottlenecksObserved=true
positiveStressThroughputWhereRequired=true
longRun.totalPphMean=18
longRun.maxQueuedTasks=3
longRun.maxWaitingVehicles=1
longRun.maxLiftPortQueueLength=1
stress.durationSec=180
stress.scenarios=balanced-high-load,inbound-only-saturation,outbound-empty-store,outbound-preloaded-pressure,near-full-inbound-pressure
stress.maxQueuedTasks=79
physicalViolationCount=0
```

Current stress coverage is validation-owned rather than visual-only. The suite intentionally overloads the model with 7200 PPH request rates and checks that overload produces explicit bottleneck reasons instead of unsafe motion:

- empty-start balanced high load: `storage-empty`, lift-busy, FIFO network/lane waits
- inbound-only saturation: inbound lift and FIFO waits
- empty-store outbound: `storage-empty`, zero phantom tasks
- preloaded outbound pressure: outbound lift/FIFO waits plus `zone-reserved`
- near-full inbound pressure: `storage-full` after the last FIFO slots are allocated

Two portal bugs were found by the stress/review loop and fixed in `packages/shuttle-sim-core/src/index.ts`: lift connector edges and storage-row connector edges now share portal movement zones with adjacent main-lane edge segments, and stopped portal-node occupants keep explicit node-hold zone reservations.

Browser smoke:

- dashboard loads
- 3D canvas appears
- runtime advances at 4x
- vehicle table shows idle and moving/returning states
- Shuttle count, inbound PPH, and outbound PPH controls update the running scenario
- Pixel Streaming prerequisite label reads as prerequisites, not release-soak readiness
- latest screenshot evidence: `output/playwright/dashboard-pro-review-smoke.png`

Artifacts are intentionally ignored by git:

- `output/browser/shuttle-3d-scene.png`
- `output/browser/shuttle-dashboard-demo.png`
- `output/browser/shuttle-demo.mov`
- `output/browser/shuttle-3d-canvas-round4.png`
- `output/browser/shuttle-smoke-round4.mov`
- `output/browser/shuttle-vehicle-rows-round5.png`
- `output/browser/shuttle-demo-round5.gif`
- `output/playwright/shuttle-smoke-20260503.png`
- `output/playwright/shuttle-smoke-20260503.webm`
- `output/playwright/shuttle-smoke-20260503-final.png`

## Remaining Gate

Unreal Engine 5.7.4 and full Xcode are now installed. The bridge has passed compile/headless smoke, live bridge smoke, staged Mac runtime generation, and local browser Pixel Streaming smokes. A 30-minute soak and release-grade Pixel Streaming hardening remain gated on calibrated scene review.
