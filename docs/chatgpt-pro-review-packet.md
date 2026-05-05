# ChatGPT Pro Review Packet: P1-P5 Shuttle SimCore / 3D / Unreal Bridge

Use this packet to review the current public main branch:

- Repository: `https://github.com/xjtuyanshi/four-way-shuttle-sim` (public)
- Review branch: `main`
- Review commit: latest pushed `main` at the time of review. Use `git rev-parse HEAD` locally when sending the external review request.
- Recent commits to inspect first:
  - `1b274d0 Fix Pro review packet head commit`
  - `f5a8247 Refresh Pro review packet for current main`
  - `ff1269d Update Phase 1 roadmap after hardening`
  - `d1d34e1 Add targeted congestion regression tests`
  - `53c48f8 Expose storage policy in static scene contract`
  - `e0b4d62 Expose IE-focused dashboard diagnostics`
  - `652d428 Calibrate layout visuals from CAD reference`

If GitHub clone or browsing fails, use `docs/chatgpt-pro-stable-review.md` instead. It contains direct raw/patch URLs and a no-network fallback prompt.

## Product Direction

This project is a four-way shuttle simulation prototype. The core architecture decision is:

- `SimCore` is the authoritative simulation and KPI source.
- The browser 3D view is a local visual twin for fast validation.
- Unreal / Pixel Streaming should be a visual twin that consumes the same state stream, not the source of truth.

Unreal Engine 5.7.4, full Xcode, and Pixel Streaming infrastructure are now available on the local Mac. The TypeScript API/dashboard/SimCore path is fully testable locally. The Unreal bridge has passed source-plugin compile, static-scene commandlet smoke, live WebSocket bridge smoke, staged Mac runtime generation, and browser Pixel Streaming smoke against both `UnrealEditor -game` and the staged app.

The latest hardening pass also made the four-way shuttle storage interpretation explicit:

- The shared static-scene contract now exposes `storagePolicy: "rowContiguousLaneFill"`, `inboundStorageFlow: "rightToLeft"`, and `outboundStorageFlow: "leftPick"`.
- Dashboard and Unreal smoke compare those fields against the SimCore contract so review language cannot drift between software, visual twin, and IE notes.
- SimCore regression tests now include near-full storage, four-vehicle mixed lift/FIFO pressure, inbound-only pressure, and outbound-only pressure. These are not throughput proof tests; they are merge-regression tests for bounded behavior under congestion.
- `docs/phase1-plan.md` now separates current merge-hardening from next calibrated-layout work.

## What Changed In Current Main

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
  - rectangular vehicle footprint overlap under the configured clearance

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
- The bridge plugin metadata now treats `WebSockets` as a linked Unreal module, not as a separate UE 5.7 plugin dependency.

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

## Prior ChatGPT Pro Review Fixes

The prior public-branch ChatGPT Pro verdict was: merge after fixes. This local pass addresses those blockers without adding product features or redesigning architecture.

- Replaced center-point safety acceptance with oriented rectangular vehicle footprint overlap checks plus `vehicles.safetyRadiusM` clearance. `minVehicleSeparationM` remains a diagnostic only.
- Added a 600-second long-run seed sweep to `pnpm shuttle:validate` with queue, waiting vehicle, lift-port queue, deadlock, physical safety, and reservation coverage acceptance flags.
- Added long-run metrics to the validation report: `longRun.totalPphMean`, `maxQueuedTasks`, `maxWaitingVehicles`, and `maxLiftPortQueueLength`.
- Added schema validation for Phase 1 FIFO storage naming: storage cells must use `storage-rNN-cNN`, and each row must expose `left-row-NN` and `right-row-NN` side access nodes.
- Fixed route planning so future queued inbound storage slots reserve logical destinations but do not become physical transit obstacles before a shuttle is assigned or moving.
- Clamped and validated `SHUTTLE_SPEED` / playback speed input.
- Relabeled lift-port UI wording as diagnostics; Phase 0 utilization is allocation time, not measured mechanical lift service utilization.
- Reconciled docs around UE 5.7.4 readiness: source bridge compile/headless smoke, live bridge smoke, staged Mac runtime generation, and local browser Pixel Streaming smokes have passed; the 30-minute soak and release hardening remain Phase 1 work after calibrated scene review.

## Latest Fresh Main Review

The latest ChatGPT Pro review of current public `main` returned: `Merge now`.

No must-fix findings were reported. Non-blocking recommendations were captured as Phase 1 work: targeted pressure tests should eventually aggregate per-tick physical/reservation inspection, throughput should remain labeled as regression-smoke throughput until CAD/vendor calibration exists, validation violation counts are sampled observations rather than unique incident counts, and Pixel Streaming readiness wording should distinguish prerequisites from a 30-minute release soak. The dashboard/API/docs now use explicit prerequisite wording for that last point.

A narrow follow-up review against `e828741f7ada139a327a5c253fbc619faee60809` confirmed that the Pixel Streaming prerequisite wording did not introduce a blocker, closed the readiness ambiguity, and left the verdict at `Merge now`.

## Latest Pro Review Follow-Up

The ChatGPT Pro review against commit `717858e` returned `merge after fixes`. The current branch folds in the actionable merge-hardening items:

- Portal-node occupancy now has explicit `zone-main-portal-node-*` hold reservations for stopped/waiting shuttles at main-aisle portal nodes.
- Portal movement zones now include storage-row connector edges as well as main-lane, lift, and north/south transfer edges, so storage-to-main movements serialize against shuttles already leaving that same main-aisle portal.
- `switchDirectionSec` now affects simulation timing through an orthogonal-move dwell phase. Vehicle yaw remains `0` because Phase 0 models a four-way shuttle body that does not rotate.
- Stress validation requires all expected bottleneck prefixes per scenario and reports missing prefixes.
- Long-run acceptance requires inbound and outbound throughput separately when both demand streams are enabled.
- Unreal bridge parsing rejects unknown vehicle state strings instead of silently treating them as `Idle`.

The follow-up ChatGPT Pro re-review of commit `9cd328659bd9a10a27e32cca12b9197544d4af9b` returned: `Merge now`.

No must-fix findings were reported. Non-blocking Phase 1 recommendations were: strengthen by-side throughput floors from nonzero liveness to proportional service-balance targets, track direction-switch readiness by node plus axis if dynamic replanning at stopped nodes becomes common, add orthogonal-only validation for external custom layouts, calibrate geometry/timings from CAD/vendor/site data, model true push-lane mechanics only after the current FIFO abstraction is accepted, and run the 30-minute Pixel Streaming soak after the Unreal visual scene is calibrated.

## Phase 1 Demo Alignment Since Hardening

The browser demo has been adjusted toward the user's four-way shuttle reference:

- Default layout is a single-level orthogonal aisle grid: no diagonal vehicle movement.
- The storage area is now a 16x24 multi-bank field of adjacent drivable pallet cells, split into upper/lower banks and four column islands.
- The placeholder physical dimensions are exposed as the assumption-grade `phase0-cad-assumption-v1` layout calibration profile in `scenario.layout.calibrationProfile` and the shared static-scene contract.
- Static storage-cell footprints now match the calibrated storage pitch inside each island, so cells render as a contiguous grid instead of sparse individual boxes.
- FIFO storage behavior is modeled at row level as task policy, not one-way rail physics: lane edges are bidirectional for the four-way shuttle, inbound places from the right-side infeed direction into the deepest reachable empty cell, and outbound drains from the left-side outfeed direction.
- The simulator does not perform hidden row compaction. Stored pallet `nodeId` changes only through explicit vehicle/lift transfer in this branch; push-lane mechanics are deferred until they can be represented with time, reservations, and events.
- Stored pallet cells are blocked for route planning unless the occupied cell is the current task endpoint, so the model does not rely on free pass-through under stored pallets.
- Lift behavior is modeled only as black-box ports, not as multi-level lift physics.
- Dedicated lift semantics come from `lift-blackbox.liftKind`, not from ID prefixes. Current inbound instances are `inbound-lift-top-01`, `inbound-lift-top-02`, `inbound-lift-bottom-01`, and `inbound-lift-bottom-02`; current outbound instances are `outbound-lift-top-01`, `outbound-lift-top-02`, `outbound-lift-bottom-01`, and `outbound-lift-bottom-02`.
- Dedicated lift ports expose queue length, active task id, waiting task ids, and allocation/utilization diagnostics. In this phase, utilization means the black-box port is allocated by an active task; true lift-mechanism service utilization is a later split metric.
- The 3D view renders low black-box ports, dense track-cell storage, side aisles, and roller conveyor entry/exit pads.
- Runtime playback speed supports `1x`, `2x`, `4x`, and `10x`.
- Fast playback is internally substepped at `scenario.timeStepSec`; the API broadcasts the final state after the accumulated live interval instead of advancing the simulation in one large `10x` jump.
- The checked-in `config/shuttle/phase0-scenario.json` has been synced to the same current default dense-layout scenario so `loadScenario` and reviewers do not see the old sparse demo.
- The validation gate now includes a stress suite, not only deterministic smoke:
  - balanced 7200/7200 PPH empty-start surge
  - inbound-only saturation
  - outbound requested against an empty store
  - outbound preloaded pressure
  - near-full inbound pressure
- A new regression found and fixed an engineering-relevant portal conflict: lift connector edges crossing the main aisle now share the corresponding portal zone with adjacent main-lane edge segments, so a shuttle cannot cross vertically through a main-lane vehicle path.

Current branch files that matter for this alignment:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `apps/shuttle-api/src/validation.ts`
- `apps/shuttle-api/src/validation.test.ts`
- `apps/shuttle-dashboard/src/App.tsx`
- `apps/shuttle-dashboard/src/ShuttleScene3D.tsx`
- `config/shuttle/phase0-scenario.json`
- `docs/layout-reference.md`
- `docs/phase1-plan.md`

## Latest Pro Merge Blockers Closed

This pass closes the latest Pro "merge after fixes" blockers and follow-up realism gaps:

- Default Phase 0 demand is aligned with the validation acceptance floor: 18 inbound PPH + 18 outbound PPH, with long-run acceptance requiring 50% of requested throughput and no vehicle-count cap.
- The UI sliders now represent 18 PPH exactly instead of snapping the browser control to a 10-PPH step.
- The 600-second validation gate still passes at `longRun.totalPphMean=18`, `longRunThroughputFloorMet=true`, and bounded queues.
- Public docs no longer depend on or mention the private customer screenshot. The DNG/PNG reference stayed local and is not committed.
- The static-scene contract now exposes `storageIslandCount` and `denseStorageIslands` so Unreal/dashboard consumers can distinguish a multi-bank dense layout from a single solid storage block.
- Added default-layout contention coverage for portal/lift/main-lane behavior so the dedicated lift approach does not create artificial deadlocks.
- FIFO assignment now opens one row contiguously from outfeed toward infeed, blocks conflicting row/network assignments, and prevents unrelated storage rows from becoming AMR-like transit shortcuts.
- Browser/Unreal visuals use purple dense pallet-cell islands and yellow aisle tracks, matching the single-level four-way shuttle layout direction.
- Static-scene storage-policy wording is now part of the SimCore contract and Unreal smoke parity, not only dashboard prose.
- Targeted congestion tests now cover near-full inbound, four-vehicle mixed pressure, inbound-only pressure, and outbound-only pressure.
- `pnpm shuttle:validate` now runs a pressure suite with expected bottleneck assertions. Acceptance fails if stress runs create deadlocks, physical safety violations, reservation coverage violations, or if expected bottleneck reasons such as `storage-empty`, `storage-full`, `fifo-*`, lift-busy, or `zone-reserved` do not appear.
- Dashboard validation output now surfaces the stress suite status, stress scenario pass count, stress queue high water, and observed bottleneck reasons.

## Verification Already Run

All passed locally after the latest merge-blocker fixes and current-main hardening:

```bash
pnpm test:shuttle
pnpm typecheck
pnpm test  # 52 tests
pnpm build
pnpm shuttle:validate
pnpm shuttle:ws-smoke
pnpm unreal:setup
pnpm unreal:smoke
pnpm unreal:stage
```

Key validation output:

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
totalPphMean=15
longRun.totalPphMean=18
longRun.maxQueuedTasks=3
longRun.maxWaitingVehicles=1
longRun.maxLiftPortQueueLength=1
stress.durationSec=180
stress.seeds=20260502,20260513
stress.scenarios=balanced-high-load,inbound-only-saturation,outbound-empty-store,outbound-preloaded-pressure,near-full-inbound-pressure
stress.maxQueuedTasks=79
stress.observedBottlenecks include storage-empty, storage-full, fifo-lane-busy, fifo-left/right-network-busy, inbound/outbound-lift-busy, zone-reserved
maxObservedSpeedMps=2
maxObservedAccelerationMps2=1
minVehicleSeparationM=1.6001
physicalViolationCount=0
physicalViolationsByCode all zero
deadlockCount=0
```

Browser smoke also passed:

```text
Dashboard loaded at http://127.0.0.1:5179
Dense 384-cell layout appears with purple pallet-cell islands and yellow aisle tracks
Current SimCore dashboard screenshot captured at output/playwright/static-contract-dashboard-smoke.png
FIFO policy panel screenshot captured at output/playwright/static-contract-fifo-policy-smoke.png
Runtime completed to 00:10:00 at 4x
Vehicle table/state stream showed idle and moving-to-pickup states
Latest dashboard smoke at output/playwright/dashboard-pro-review-smoke.png showed the 3D canvas, 4x runtime advance, moving/returning vehicle state, and 0 console errors
Shuttle count, inbound PPH, and outbound PPH sliders updated the running scenario; setting 4 shuttles produced 4 vehicle rows and 120/90 PPH labels
```

Environment gate output:

```text
Epic Games Launcher: installed
Unreal 5.7.4: ready, UnrealEditor executable found under /Users/Shared/Epic Games/UE_5.7
Xcode: ready, full Xcode 26.4.1 toolchain available
Pixel Streaming: ready
Unreal bridge compile smoke: passed
Unreal static commandlet smoke: passed with 384 storage cells, 474 track beds, 8 lift pads, storageIslandCount=8, denseStorageIslands=true, and denseStorageBlock=false
Unreal live bridge smoke: passed with vehicleState/kpiUpdate parsing, 2 vehicle actors, no duplicate actors, and max target pose error 0cm
Latest Unreal live bridge smoke: pass=true, vehicleActors=2, receivedVehicleStates=6, maxTargetPoseErrorCm=0
Unreal staged Mac runtime: passed, staged app exists under output/unreal/ShuttleVisualTwin/Saved/StagedBuilds/Mac/ShuttleVisualTwin.app
WebSocket smoke: passed with connectionRecovered, simState, vehicleState, kpiUpdate, and taskEvent message coverage
Browser Pixel Streaming smoke: passed against both UnrealEditor -game and staged app; screenshot/video evidence is under output/playwright/
CompileAllBlueprints reported 0 blueprint errors / 0 blueprint warnings
```

## Review Request

Please review the current public `main` head as a multidisciplinary reviewer. Prioritize correctness and engineering realism over style. This is no longer only a software review: also challenge whether the modeled warehouse behavior makes sense as a four-way shuttle / pallet storage system.

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
   - Do the dense storage islands look and behave like adjacent pallet locations, not sparse shelves or AMR free-space navigation?
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
   - Is the plugin metadata correct for UE 5.7 now that WebSockets is linked as a module rather than enabled as a separate plugin?
   - What is missing before a packaged or 30-minute Pixel Streaming smoke test?
   - Is the environment gate strict enough now that Epic Launcher can exist without Unreal Engine being installed?

Please return:

- Findings ordered by severity, with file paths and line references where possible.
- Any must-fix issues before this branch is merged to `main`.
- Any Phase 1 recommendations that should not block the current branch.
- Separate notes for software, mechanical/manufacturing, and IE/operations.
- A short verdict: merge now, merge after fixes, or redesign needed.
