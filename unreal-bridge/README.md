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

## State Contract

The bridge consumes `connectionRecovered` and `simState` WebSocket messages. For each `vehicles[*]` entry it parses:

- pose: `x`, `y`, `z`, `yaw`, `speedMps`
- work state: `state`, `loaded`, `taskId`, `currentNodeId`, `targetNodeId`, `currentEdgeId`
- route timing: `routeNodeIds`, `routeIndex`, `legRemainingM`, `legElapsedSec`, `legTravelSec`, `phaseRemainingSec`
- blocking diagnostics: `waitReason`, `blockingReservationId`, `blockingVehicleId`

`AShuttleVisualTwinActor` filters by `VehicleId` when it is preassigned, so multiple actors can safely bind to the same `OnVehicleState` multicast delegate.

SimCore remains authoritative for event logs, KPIs, task assignment, reservations, and traffic diagnostics. Unreal should only interpolate and render the state stream during Phase 0.
