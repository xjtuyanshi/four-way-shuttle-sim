# Review Hardening Report

Branch: `codex/phase1-validation-traffic-demo`  
Base commit: `15f185a Add Phase 0 validation gate`  
Hardening scope: branch commits after the base commit through this report.

## Verdict Addressed

The external review verdict was: merge after fixes. This report maps those required fixes to the implementation now on the branch.

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
- at least one parking node per vehicle
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

## Final External Review Verdict

Final review was run against commit `28d6aeb112440998e8d6a603ab35065b73ccde52`.

The first full public-branch review attempt stalled on remote access/truncation. A second no-network merge-blocker review from the final packet returned:

- Must-fix findings before merge: none verified.
- Verdict: merge now.

Non-blocking follow-ups were moved to Phase 1:

- multi-capacity reservation semantics after Phase 0
- packaged Pixel Streaming runtime soak after the real Unreal scene exists
- same-node/zero-distance traffic-transition coverage if future route generation can produce it
- more dashboard stream reducer ordering/removal cases
- positive-control validator fixtures for every violation code

## Latest Verification

Last full verification on this branch passed:

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
physicalViolationCount=0
```

Browser smoke:

- dashboard loads
- 3D canvas appears
- runtime advances
- vehicle table shows moving/waiting states
- localhost console errors/warnings: none observed

Artifacts are intentionally ignored by git:

- `output/browser/shuttle-3d-scene.png`
- `output/browser/shuttle-dashboard-demo.png`
- `output/browser/shuttle-demo.mov`
- `output/browser/shuttle-3d-canvas-round4.png`
- `output/browser/shuttle-smoke-round4.mov`
- `output/browser/shuttle-vehicle-rows-round5.png`
- `output/browser/shuttle-demo-round5.gif`

## Remaining Gate

Unreal Engine 5.7.4 and full Xcode are now installed. The bridge has passed compile/headless smoke in a temporary UE project; packaged Pixel Streaming soak remains gated on assembling the real visual scene.
