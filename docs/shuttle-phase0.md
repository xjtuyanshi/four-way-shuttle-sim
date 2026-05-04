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

Phase 0 enforces edge, node, and zone reservation capacity as `1`. It also requires at least one parking node per vehicle so reset can initialize one authoritative current-node occupant per shuttle. Storage nodes must use `storage-rNN-cNN` ids and each storage row must expose `left-row-NN` and `right-row-NN` side access nodes until explicit row/column metadata is added. Multi-capacity reservation accounting is intentionally deferred to Phase 1.

This is still a smoke implementation. It validates deterministic blocking and wait reason logging; it is not the final multi-agent traffic controller.

## Current Prerequisite Status

Local inspection found:

- Host: Mac mini, Apple M4, 10-core CPU, 16 GB memory, Metal 4.
- Epic Games Launcher: installed under `/Applications`.
- Unreal Engine 5.7.4: ready under `/Users/Shared/Epic Games/UE_5.7`.
- Xcode: ready with full Xcode 26.4.1 toolchain.
- Pixel Streaming: ready for project-level validation.

The Unreal bridge has been compiled inside a temporary UE 5.7 project with Pixel Streaming enabled, and a headless editor commandlet smoke completed with zero bridge errors.

## Phase 0 Acceptance Mapping

- Deterministic SimCore: implemented and covered by `test:shuttle`.
- Event log hash: implemented with SHA-256 over stable event fields.
- Reset without UE process restart: implemented at API/SimCore level.
- Dashboard control path: implemented for resume, pause, reset, and parameter updates.
- Validation gate: implemented for same-seed hash stability, seed sweep health, 600-second long-run queue/lift/deadlock health, reservation coverage, and physical safety checks.
- Local 3D preview: implemented in the dashboard as a browser-side visual twin driven by the same SimCore state stream that Unreal consumes.
- WebSocket reconnect: dashboard reconnects and consumes `connectionRecovered`.
- Unreal visual twin: source scaffold implemented and compile-smoked in UE 5.7.
- 30-minute Pixel Streaming validation: pending a packaged or Standalone Unreal runtime run.

## Next Step After Prerequisites

The execution checklist is tracked in `docs/unreal-visual-twin-plan.md`.

1. Create the real Unreal visual-twin project and copy `unreal-bridge` into `Plugins/ShuttlePhase0Bridge`.
2. Build a single-level scene with a 16x24 multi-bank storage field, dedicated inbound/outbound lift ports, and orthogonal track-only shuttle movement.
3. Enable Pixel Streaming for runtime streaming. `WebSockets` is linked as an Unreal module by the bridge.
4. Bind placeholder actors to `UShuttleStateSubscriberSubsystem`; each `AShuttleVisualTwinActor` can be preassigned a `VehicleId` and will ignore other vehicle states.
5. Use the route, blocker, and timing fields on `FShuttleVisualVehicleState` for Blueprint debug overlays.
6. Run the 30-minute 1080p single-user Pixel Streaming test and record resource metrics after the real UE scene exists.
