# Shuttle Phase 0 Unreal Bridge

This is a source-only Unreal plugin scaffold for Phase 0. It is intentionally thin:

- `SimCore / WCS-lite` remains the authoritative state source.
- Unreal subscribes to `/shuttle-ws`, interpolates vehicle actors, and renders the visual twin.
- Unreal may report visual/collision anomalies later, but it must not create KPI truth or mutate dispatch state.
- The dashboard's Three.js preview is a local browser twin of the same stream, useful before Pixel Streaming prerequisites are ready.

## Use

1. Install Unreal Engine 5.7.4 and full Xcode.
2. Copy `unreal-bridge` into an Unreal project's `Plugins/ShuttlePhase0Bridge` directory.
3. Enable the `Pixel Streaming` plugin for runtime streaming. `WebSockets` is linked as an Unreal module by this bridge; it is not enabled as a separate engine plugin in UE 5.7.
4. For the default Phase 0 scene, place one `AShuttleVisualTwinRuntimeActor` at world origin.
5. Set its `VehicleActorClass` only if you want to use a custom shuttle mesh actor; otherwise it spawns `AShuttleVisualTwinActor` with a basic visible shuttle body and carried-pallet placeholder.
6. The runtime actor auto-connects to `ws://localhost:8791/shuttle-ws`, spawns vehicles by `VehicleId`, and creates a one-level scene with dense 6x8 storage cells, low four-way rail detail in every storage cell, side aisles, cross aisles, roller transfer detail on dedicated inbound/outbound lift pads, black-box lift housings, and parking pads.
7. For manual Blueprint wiring, use `UShuttleStateSubscriberSubsystem::Connect("ws://localhost:8791/shuttle-ws")` and bind `OnVehicleState` to `AShuttleVisualTwinActor::ApplyAuthoritativeState`.

The placeholder actor converts meters from SimCore into centimeters for Unreal. `AShuttleVisualTwinRuntimeActor` passes its world location as `WorldOffsetCm` when spawning shuttle actors, so the generated static scene and vehicles share the same local origin.

## Coordinate Contract

SimCore publishes positions in meters with `x` as line direction, `y` as vertical height, and `z` as floor-depth. Unreal uses centimeters with `Z` as vertical:

- `UE.X = sim.x * 100`
- `UE.Y = sim.z * 100`
- `UE.Z = sim.y * 100`
- `UE.Yaw = radiansToDegrees(sim.yaw)`

The Phase 0 actor keeps the yaw sign as published by SimCore. If a future Unreal mesh faces a different local forward axis, adjust the mesh/component offset rather than changing the protocol.

## State Contract

The bridge consumes `connectionRecovered`, `simState`, and `vehicleState` WebSocket messages through Unreal's `WebSockets` module. It ignores `kpiUpdate` and `taskEvent` for actor movement. For each `vehicles[*]` entry it parses:

- pose: `x`, `y`, `z`, `yaw`, `speedMps`
- work state: `state`, `loaded`, `taskId`, `currentNodeId`, `targetNodeId`, `currentEdgeId`
- route timing: `routeNodeIds`, `routeIndex`, `legRemainingM`, `legElapsedSec`, `legTravelSec`, `phaseRemainingSec`
- blocking diagnostics: `waitReason`, `blockingReservationId`, `blockingVehicleId`

For `connectionRecovered.state.loads` and `simState.state.loads`, the bridge also parses `loads[*]` and broadcasts load snapshots. `AShuttleVisualTwinRuntimeActor` renders non-carried loads as pallet placeholders at known storage cells or lift pads. Carried loads remain attached to the vehicle placeholder through the existing `loaded` flag. Older or partial streams that omit `state.loads` are treated as `state.loads unavailable` instead of a bridge failure, so vehicle visualization can remain healthy while load visualization is absent.

`AShuttleVisualTwinActor` filters by `VehicleId` when it is preassigned, so multiple actors can safely bind to the same `OnVehicleState` multicast delegate.

SimCore remains authoritative for event logs, KPIs, task assignment, reservations, and traffic diagnostics. Unreal should only interpolate and render the state stream during Phase 0.

## Smoke Commandlet

`UShuttleVisualTwinSmokeCommandlet` runs in headless Unreal smoke tests. It creates a temporary world, spawns `AShuttleVisualTwinRuntimeActor`, rebuilds the static scene, and verifies the default scaffold counts and item-level topology:

- 48 storage cells
- 16 track beds
- 2 inbound lift pads
- 2 outbound lift pads
- 2 parking pads
- visual detail counts: 1 floor plate, 192 storage rail segments, 63 rack posts, 24 transfer rollers, and 4 black-box lift housings
- stable IDs, categories, coordinates, orientations, and sizes for every storage cell, track bed, lift pad, and parking pad

It also applies synthetic vehicle and load states through the runtime actor, verifies that exactly one visible default vehicle actor is spawned and reused, checks SimCore-to-Unreal position/yaw conversion, checks that the carried-pallet placeholder follows the streamed `loaded` flag, checks that stored/waiting/delivered loads render as static pallet placeholders while carried loads do not duplicate, and exercises a waiting -> stored -> carried -> delivered lifecycle for one pallet placeholder. The smoke script writes JSON static-scene and live-bridge summaries under `/tmp` during each run for visual-review evidence. This proves the default actor binding path in headless UE. It does not prove packaged runtime or Pixel Streaming soak readiness.

## Placeholder Dimensions

The generated geometry uses deterministic placeholder dimensions so smoke tests can compare Unreal and SimCore contracts. These values are not a mechanical release. Before using the visual twin for equipment or layout approval, replace or calibrate them with CAD/vendor inputs for pallet length/width/height, shuttle footprint and lift envelope, storage pitch, rail gauge, transfer-roller spacing, rack upright/baseplate envelope, and lift/conveyor pad envelope.
