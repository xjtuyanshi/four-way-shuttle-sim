# ChatGPT Pro Review Packet: P1-P5 Shuttle SimCore / 3D / Unreal Bridge

Use this packet to review the current branch:

- Repository: `https://github.com/xjtuyanshi/four-way-shuttle-sim` (public)
- Base branch: `main`
- Base commit: `15f185a Add Phase 0 validation gate`
- Review branch: `codex/phase1-validation-traffic-demo`
- Review branch head: latest pushed commit on `codex/phase1-validation-traffic-demo`

If GitHub clone or browsing fails, use `docs/chatgpt-pro-stable-review.md` instead. It contains direct raw/patch URLs and a no-network fallback prompt.

## Product Direction

This project is a four-way shuttle simulation prototype. The core architecture decision is:

- `SimCore` is the authoritative simulation and KPI source.
- The browser 3D view is a local visual twin for fast validation.
- Unreal / Pixel Streaming should be a visual twin that consumes the same state stream, not the source of truth.

Epic Games Launcher is installed, but Unreal Engine 5.7.x and full Xcode are not installed yet, so Unreal runtime validation is still blocked by environment. The TypeScript API/dashboard/SimCore path is fully testable locally.

## What Changed In This Branch

### P1: Traffic Control Core

- Extended vehicle state with current edge, route index, leg timing, remaining distance, blocking reservation, and blocking vehicle.
- Added traffic diagnostics to the simulation state:
  - active reservation count
  - waiting vehicles
  - deadlock candidate vehicle ids
  - minimum vehicle separation
  - max observed speed
  - physical violation count
- Added node reservations and zone reservations around edge reservations.
- Added target-node occupancy checks so one shuttle cannot enter a node already occupied by another shuttle.
- Added direct return-to-main routes from parking nodes to reduce default-layout head-on deadlock.

Primary files:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-schemas/src/index.ts`
- `config/shuttle/phase0-scenario.json`

### P2: Motion / Physical Simulation

- Replaced constant-speed movement with triangular/trapezoidal acceleration profiles.
- Reservation travel time now uses the same acceleration-aware travel-time estimate as movement.
- Validation now samples per tick for:
  - speed limit violations
  - acceleration limit violations
  - invalid coordinates
  - minimum center separation under the configured vehicle safety radius

Primary files:

- `packages/shuttle-sim-core/src/index.ts`
- `apps/shuttle-api/src/validation.ts`
- `apps/shuttle-api/src/validation.test.ts`

### P3: 3D Debug Workbench

- Added a lazy-loaded Three.js scene driven by the same `ShuttleSimState`.
- Added scene layers for traffic reservations, physical safety rings, loads, and routes.
- Selecting a vehicle in the table highlights its route/safety ring in the 3D view.
- Dashboard now shows a traffic diagnostics strip.

Primary files:

- `apps/shuttle-dashboard/src/ShuttleScene3D.tsx`
- `apps/shuttle-dashboard/src/App.tsx`
- `apps/shuttle-dashboard/src/styles.css`
- `apps/shuttle-dashboard/package.json`

### P4: Validation Gate

- `pnpm shuttle:validate` now reports:
  - `maxObservedSpeedMps`
  - `maxObservedAccelerationMps2`
  - `minVehicleSeparationM`
  - `physicalViolationCount`
  - deterministic same-seed hash stability
  - seed sweep deadlock status
- Acceptance now requires no physical safety violations.

Primary files:

- `apps/shuttle-api/src/validation.ts`
- `apps/shuttle-api/src/validation.test.ts`

### P5: Unreal / Pixel Streaming Contract

- Extended Unreal bridge vehicle state types to match the new WebSocket vehicle state fields.
- The Unreal subscriber parses route/timing/blocking fields.
- `AShuttleVisualTwinActor` can filter updates by `VehicleId`.
- Documentation clarifies that Unreal consumes authoritative state and does not write KPI truth.

Primary files:

- `unreal-bridge/Source/ShuttlePhase0Bridge/Public/ShuttleVisualStateTypes.h`
- `unreal-bridge/Source/ShuttlePhase0Bridge/Public/ShuttleStateSubscriberSubsystem.h`
- `unreal-bridge/Source/ShuttlePhase0Bridge/Private/ShuttleStateSubscriberSubsystem.cpp`
- `unreal-bridge/Source/ShuttlePhase0Bridge/Private/ShuttleVisualTwinActor.cpp`
- `unreal-bridge/README.md`
- `docs/shuttle-phase0.md`

## Merge-Hardening Pass Applied After Prior Review

The prior external verdict was: merge after fixes. The required traffic-control, validation, and Unreal bridge fixes have now been applied.

Detailed mapping: `docs/review-hardening-report.md`.
Merge TODO and follow-up split: `docs/phase0-merge-todo.md`.

Hardening highlights:

- Added authoritative `currentNodeOccupancy` in `SimCore`.
- Vehicles waiting at a node continue occupying that node.
- Before departure, vehicles must reserve the next edge, target node, and every matching zone.
- Arrival transfers target-node reservation into current-node occupancy atomically.
- Added test/debug hooks so tests and validation can assert occupancy state directly.
- Added regression tests for opposite-direction same-edge conflict, target-node occupancy race, crossing-zone serialization, deadlock sanity, motion profiles, and Phase 0 capacity enforcement.
- Added schema validation requiring at least one parking node per vehicle for Phase 0 reset ownership.
- Added schema validation rejecting duplicate node ids before reset occupancy is initialized.
- Added validation-owned reservation coverage diagnostics with by-code counts and first 20 examples.
- Added violation codes for unreserved edge/node/zone occupancy, node/edge mismatch, speed, acceleration, separation, and invalid coordinates.
- Clarified instantaneous `state.traffic.physicalViolationCount` versus cumulative validation aggregation.
- Hardened Unreal WebSocket parsing for `connectionRecovered`, `simState`, and `vehicleState` messages.
- Documented SimCore meters to Unreal centimeters coordinate mapping.
- Enforced capacity `= 1` for Phase 0 instead of partially supporting multi-capacity reservations.
- Dashboard now merges incremental `vehicleState` and `kpiUpdate` WebSocket messages into the current state snapshot.

## Phase 1 Demo Alignment Since Hardening

The browser demo has been adjusted toward the user's four-way shuttle reference:

- Default layout is a single-level orthogonal aisle grid: no diagonal vehicle movement.
- The middle storage area is a contiguous 6x8 block of adjacent drivable pallet cells.
- FIFO storage behavior is modeled at row level as task policy, not one-way rail physics: lane edges are bidirectional for the four-way shuttle, inbound places from the right-side infeed direction into the deepest reachable empty cell, and outbound drains from the left-side outfeed direction.
- The simulator does not perform hidden row compaction. Stored pallet `nodeId` changes only through explicit vehicle/lift transfer in this branch; push-lane mechanics are deferred until they can be represented with time, reservations, and events.
- Stored pallet cells are blocked for route planning unless the occupied cell is the current task endpoint, so the model does not rely on free pass-through under stored pallets.
- Lift behavior is modeled only as black-box ports, not as multi-level lift physics.
- Dedicated inbound ports: `inbound-lift-a`, `inbound-lift-b`.
- Dedicated outbound ports: `outbound-lift-a`, `outbound-lift-b`.
- Dedicated lift ports expose queue length, active task id, waiting task ids, and port allocation/utilization in traffic diagnostics. In this phase, utilization means the black-box port is allocated by an active task; true lift-mechanism service utilization is a later split metric.
- The 3D view renders low black-box ports, dense track-cell storage, side aisles, and roller conveyor entry/exit pads.
- Runtime playback speed supports `1x`, `2x`, `4x`, and `10x`.
- Fast playback is internally substepped at `scenario.timeStepSec`; the API broadcasts the final state after the accumulated live interval instead of advancing the simulation in one large `10x` jump.
- The checked-in `config/shuttle/phase0-scenario.json` has been synced to the same current default dense-layout scenario so `loadScenario` and reviewers do not see the old sparse demo.

Current branch files that matter for this alignment:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `apps/shuttle-dashboard/src/ShuttleScene3D.tsx`
- `config/shuttle/phase0-scenario.json`
- `docs/layout-reference.md`
- `docs/phase1-plan.md`

## Verification Already Run

All passed locally after the hardening pass:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm shuttle:validate
```

Key validation output:

```text
acceptance.pass=true
sameSeedEventHashStable=true
noDeadlocksInSweep=true
eventLogsPresent=true
noPhysicalSafetyViolations=true
noReservationCoverageViolations=true
totalPphMean=120
maxObservedSpeedMps=2
maxObservedAccelerationMps2=1
minVehicleSeparationM=3
physicalViolationCount=0
physicalViolationsByCode all zero
deadlockCount=0
```

Browser smoke also passed:

```text
Dashboard loaded at http://localhost:5179
3D canvas count: 1
3D canvas data URL length: 10178
Runtime advanced to 00:01:09
Vehicle table showed active moving/waiting states
Console errors: none observed
```

Environment gate output:

```text
Epic Games Launcher: installed
Unreal 5.7.4: blocked, no UE_5.7 / UnrealEditor installation found yet
Xcode: blocked, active developer dir is Command Line Tools only
Pixel Streaming: pending-unreal
```

## Review Request

Please review this latest branch head as a multidisciplinary reviewer. Prioritize correctness and engineering realism over style. This is no longer only a software review: also challenge whether the modeled warehouse behavior makes sense as a four-way shuttle / pallet storage system.

Focus areas:

1. Software engineering / simulation correctness
   - Are edge/node/zone reservation lifetimes coherent?
   - Can two vehicles still overlap or enter opposite directions on the same edge?
   - Does the current `node-occupied` logic leave any race between arrival and next reservation?
   - Is the deadlock detector useful enough, or does it over/under-count?
   - Is the triangular/trapezoidal profile implemented correctly?
   - Are reservation travel times aligned with actual movement?
   - Are speed and acceleration validation checks meaningful with the current `timeStepSec`?
   - Are the new reservation coverage checks complete enough for Phase 0?
   - Are `physicalViolationsByCode` and `physicalViolationExamples` aggregated without double-counting?
   - Are the seed sweep and acceptance criteria too weak for Phase 0?

2. Mechanical / manufacturing realism
   - Does the single-level four-way shuttle assumption match a pallet-underlift vehicle moving on orthogonal track cells?
   - Does the center dense storage block look and behave like adjacent pallet locations, not sparse shelves or AMR free-space navigation?
   - Are inbound/outbound black-box lift ports represented at the right abstraction level?
   - Are the track spacing, vehicle envelope, pallet cell size, and safety separation assumptions plausible enough for a prototype?
   - What mechanical constraints are still missing before this can be called a credible equipment simulation?

3. Industrial engineering / operations realism
   - Does the FIFO lane policy match the described right-side infeed and left-side outfeed behavior?
   - Are throughput, queueing, blocking, storage-full, and storage-empty metrics meaningful enough for layout comparison?
   - Are dedicated inbound and outbound lifts modeled in a way that can expose bottlenecks?
   - What IE KPIs are missing before this can support decisions about lift count, row count, shuttle count, or cycle time?
   - Are the current seed sweep, duration, and demand rates enough to reveal congestion patterns?

4. Frontend / 3D debug view
   - Is the lazy-loaded Three.js component safe from leaks across rerenders/unmounts?
   - Are route/reservation layers driven from authoritative state without stale state problems?
   - Does the browser preview remain clearly separate from Unreal truth?
   - Does the rendered layout communicate the physical system, or does it still look toy-like or misleading?

5. Unreal bridge contract
   - Are the C++ JSON parsing choices safe for nullable fields?
   - Is the coordinate mapping from SimCore meters to Unreal centimeters correct?
   - What is missing before a real Pixel Streaming smoke test?
   - Is the environment gate correct now that Epic Launcher can exist without Unreal Engine being installed?

Please return:

- Findings ordered by severity, with file paths and line references where possible.
- Any must-fix issues before this branch is merged to `main`.
- Any Phase 1 recommendations that should not block the current branch.
- Separate notes for software, mechanical/manufacturing, and IE/operations.
- A short verdict: merge now, merge after fixes, or redesign needed.
