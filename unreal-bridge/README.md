# Shuttle Phase 0 Unreal Bridge

This is a source-only Unreal plugin scaffold for Phase 0. It is intentionally thin:

- `SimCore / WCS-lite` remains the authoritative state source.
- Unreal subscribes to `/shuttle-ws`, interpolates vehicle actors, and renders the visual twin.
- Unreal may report visual/collision anomalies later, but it must not create KPI truth or mutate dispatch state.
- The dashboard's Three.js preview is a local browser twin of the same stream, useful before Pixel Streaming prerequisites are ready.

## Use

1. Install Unreal Engine 5.7.4 and full Xcode.
2. Copy `unreal-bridge` into an Unreal project's `Plugins/ShuttlePhase0Bridge` directory.
3. Enable the `WebSockets` and `Pixel Streaming` plugins.
4. Add one `AShuttleVisualTwinActor` per expected shuttle or spawn them from Blueprint.
5. Use `UShuttleStateSubscriberSubsystem::Connect("ws://localhost:8791/shuttle-ws")`.
6. Bind `OnVehicleState` to `AShuttleVisualTwinActor::ApplyAuthoritativeState`.

The placeholder actor converts meters from SimCore into centimeters for Unreal.

## Coordinate Contract

SimCore publishes positions in meters with `x` as line direction, `y` as vertical height, and `z` as floor-depth. Unreal uses centimeters with `Z` as vertical:

- `UE.X = sim.x * 100`
- `UE.Y = sim.z * 100`
- `UE.Z = sim.y * 100`
- `UE.Yaw = radiansToDegrees(sim.yaw)`

The Phase 0 actor keeps the yaw sign as published by SimCore. If a future Unreal mesh faces a different local forward axis, adjust the mesh/component offset rather than changing the protocol.

## State Contract

The bridge consumes `connectionRecovered`, `simState`, and `vehicleState` WebSocket messages. It ignores `kpiUpdate` and `taskEvent` for actor movement. For each `vehicles[*]` entry it parses:

- pose: `x`, `y`, `z`, `yaw`, `speedMps`
- work state: `state`, `loaded`, `taskId`, `currentNodeId`, `targetNodeId`, `currentEdgeId`
- route timing: `routeNodeIds`, `routeIndex`, `legRemainingM`, `legElapsedSec`, `legTravelSec`, `phaseRemainingSec`
- blocking diagnostics: `waitReason`, `blockingReservationId`, `blockingVehicleId`

`AShuttleVisualTwinActor` filters by `VehicleId` when it is preassigned, so multiple actors can safely bind to the same `OnVehicleState` multicast delegate.

SimCore remains authoritative for event logs, KPIs, task assignment, reservations, and traffic diagnostics. Unreal should only interpolate and render the state stream during Phase 0.
