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
5. Set its `VehicleActorClass` only if you want to use a custom shuttle mesh actor; otherwise it spawns `AShuttleVisualTwinActor`.
6. The runtime actor auto-connects to `ws://localhost:8791/shuttle-ws`, spawns vehicles by `VehicleId`, and creates a simple one-level scene with dense 6x8 storage cells, side aisles, cross aisles, dedicated inbound/outbound lift pads, and parking pads.
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

`AShuttleVisualTwinActor` filters by `VehicleId` when it is preassigned, so multiple actors can safely bind to the same `OnVehicleState` multicast delegate.

SimCore remains authoritative for event logs, KPIs, task assignment, reservations, and traffic diagnostics. Unreal should only interpolate and render the state stream during Phase 0.

## Smoke Commandlet

`UShuttleVisualTwinSmokeCommandlet` runs in headless Unreal smoke tests. It creates a temporary world, spawns `AShuttleVisualTwinRuntimeActor`, rebuilds the static scene, and verifies the default scaffold counts:

- 48 storage cells
- 16 track beds
- 2 inbound lift pads
- 2 outbound lift pads
- 2 parking pads
