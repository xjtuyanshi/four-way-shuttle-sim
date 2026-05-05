# Shuttle Phase 0 Implementation

Phase 0 validates the architecture before high-fidelity warehouse production work:

- SimCore / WCS-lite is the authoritative state source.
- Dashboard commands use HTTP and state streaming uses WebSocket.
- Unreal is a visual twin that subscribes to state and interpolates actors.
- Pixel Streaming is only the browser video channel.

## Implemented Structure

- `packages/shuttle-schemas`: zod schemas for scenarios, vehicle state, reservations, event logs, commands, and stream messages.
- `packages/shuttle-sim-core`: deterministic SimCore with seed/reset/pause/resume, task generation, routing, reservations, event logs, and KPI snapshots.
- `apps/shuttle-api`: HTTP/WebSocket server for dashboard and Unreal bridge consumers.
- `apps/shuttle-dashboard`: React/Vite dashboard for command control, KPI display, vehicle state, event log, traffic diagnostics, local Three.js visual twin preview, and Pixel Streaming readiness.
- `unreal-bridge`: source-only Unreal plugin scaffold for WebSocket subscription and placeholder actor interpolation.

## Commands

From the repo root:

```bash
pnpm install
pnpm test:shuttle
pnpm shuttle:prereq
pnpm shuttle:validate
pnpm dev:api
pnpm dev:dashboard
```

Default local URLs:

- API: `http://localhost:8791/api/shuttle/health`
- WebSocket: `ws://localhost:8791/shuttle-ws`
- Dashboard: `http://localhost:5179`

## Protocol

HTTP commands:

- `POST /api/shuttle/loadScenario`
- `POST /api/shuttle/reset`
- `POST /api/shuttle/pause`
- `POST /api/shuttle/resume`
- `POST /api/shuttle/setParam`
- `POST /api/shuttle/startRun`
- `POST /api/shuttle/validatePhase0`
- `GET /api/shuttle/exportLog`

Runtime state now includes `traffic` diagnostics alongside vehicles, tasks, loads, reservations, and KPIs. The dashboard and Unreal bridge should treat `vehicles[*]` as the actor pose stream, and `traffic` / `reservations` as debug overlays:

- `vehicles[*].currentEdgeId`, `routeNodeIds`, `routeIndex`, `legRemainingM`, `legElapsedSec`, and `legTravelSec`
- `vehicles[*].waitReason`, `blockingReservationId`, and `blockingVehicleId`
- `traffic.activeReservationCount`, `waitingVehicles`, `deadlockCandidateVehicleIds`, `minVehicleSeparationM`, `maxObservedSpeedMps`, and `physicalViolationCount`

`traffic.physicalViolationCount` is an instantaneous count for the current state snapshot. The validation gate owns cumulative aggregation and reports `physicalViolationsByCode` plus the first `physicalViolationExamples`.

`traffic.minVehicleSeparationM` remains a center-to-center diagnostic. Safety acceptance uses each shuttle's oriented rectangular footprint plus the configured `vehicles.safetyRadiusM` clearance, so it is not limited to a center-point disk approximation.

WebSocket stream messages:

- `connectionRecovered`
- `simState`
- `vehicleState`
- `taskEvent`
- `kpiUpdate`
- `error`

## Traffic Baseline

The Phase 0 traffic model includes the data structure needed for the harder Phase 3 work:

- edge reservations
- node reservations
- zone/intersection reservations
- explicit current-node occupancy ownership for stopped vehicles
- time windows
- priorities with aging hook
- conflict groups
- no-stop/no-parking flags
- wait reason codes
- deadlock/livelock counters and detector placeholders

Phase 0 enforces edge, node, and zone reservation capacity as `1`. It also requires at least one parkable non-aisle node per vehicle so reset can initialize one authoritative current-node occupant per shuttle. Dedicated parking pads are preferred first; storage cells may also be used as temporary under-load shuttle parking because pallet/load occupancy and shuttle node occupancy are separate invariants. Storage nodes must use `storage-rNN-cNN` ids and each storage row must expose `left-row-NN` and `right-row-NN` side access nodes until explicit row/column metadata is added. Storage-area traversal is row-horizontal only: a shuttle may move left/right along one FIFO storage row, while cross-row movement must use side or main aisles. Inbound placement spreads across FIFO rows while preserving contiguous fill inside each row; shuttles leaving a storage parking cell choose the nearest row-side exit, and inbound dropoff routes back out toward the right/infeed side instead of crossing to the outbound side. Outbound work on the left FIFO network is serialized conservatively until Phase 1 models calibrated passing or escape positions. `maxTasks` is an active backlog cap rather than a lifetime run cap. Multi-capacity reservation accounting is intentionally deferred to Phase 1.

This is still a smoke implementation. It validates deterministic blocking and wait reason logging; it is not the final multi-agent traffic controller.

## Current Prerequisite Status

Local inspection found:

- Host: Mac mini, Apple M4, 10-core CPU, 16 GB memory, Metal 4.
- Epic Games Launcher: installed under `/Applications`.
- Unreal Engine 5.7.4: ready under `/Users/Shared/Epic Games/UE_5.7`.
- Xcode: ready with full Xcode 26.4.1 toolchain.
- Pixel Streaming: local browser smoke passed with the generated `PixelStreaming2` render-target scene.

The Unreal bridge has been compiled inside a generated UE 5.7 project with Pixel Streaming enabled. The headless commandlet smoke, live bridge smoke, staged Mac runtime generation, and local browser Pixel Streaming smokes against both `UnrealEditor -game` and the staged app completed with zero bridge errors.

## Phase 0 Acceptance Mapping

- Deterministic SimCore: implemented and covered by `test:shuttle`.
- Event log hash: implemented with SHA-256 over stable event fields.
- Reset without UE process restart: implemented at API/SimCore level.
- Dashboard control path: implemented for resume, pause, reset, and parameter updates.
- Validation gate: implemented for same-seed hash stability, seed sweep health, 600-second long-run queue/lift/deadlock health, reservation coverage, and physical safety checks.
- Local 3D preview: implemented in the dashboard as a browser-side visual twin driven by the same SimCore state stream that Unreal consumes.
- WebSocket reconnect: dashboard reconnects and consumes `connectionRecovered`.
- Unreal visual twin: source scaffold implemented, compile-smoked, live-smoked, staged, and browser-smoked in UE 5.7.
- 30-minute Pixel Streaming soak / signed release hardening: deferred to Phase 1 after the calibrated visual scene is reviewed.

## Next Step After Phase 0

The execution checklist is tracked in `docs/unreal-visual-twin-plan.md`.

1. Extract CAD/vendor/site dimensions for pallet pitch, shuttle envelope, track gauge, lift-port spacing, and aisle clearances.
2. Convert the default 16x24 multi-bank storage field into a configurable calibrated layout profile.
3. Replace placeholder visual geometry with calibrated Unreal meshes/materials while keeping SimCore as the source of truth.
4. Keep Pixel Streaming as the presentation channel and rerun browser smoke after each visual-scene calibration pass.
5. Run the 30-minute 1080p single-user Pixel Streaming soak only after the calibrated visual scene is ready for review.
