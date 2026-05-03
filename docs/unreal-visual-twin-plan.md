# Unreal Visual Twin Execution Plan

This plan starts after the merged Phase 0 hardening. It keeps SimCore / WCS-lite authoritative and treats Unreal as a visual twin only.

## Source Of Truth

- SimCore owns task generation, FIFO inventory, routing, reservations, traffic blocking, KPI truth, event logs, and validation.
- The API streams state through `ws://localhost:8791/shuttle-ws`.
- Unreal subscribes to the stream, interpolates actor transforms, and renders the scene.
- Unreal may surface visual or collision anomalies later, but it must not mutate dispatch state or create KPI truth.

## Target Scene Scope

Build one single-level four-way pallet shuttle scene first. Lifts are black-box input/output ports for this level.

Static scene:

- Meter-based floor grid generated from the default SimCore layout.
- Dense storage block matching the current Phase 0 scenario: 6 rows x 8 columns of adjacent drivable storage cells.
- Left-side outbound aisle and right-side inbound aisle.
- Top and bottom cross aisles.
- Low rail/track beds through every storage cell and side aisle.
- Pallet placeholders in stored/reserved cells.
- Roller conveyor or transfer pads at infeed/outfeed nodes.
- Dedicated inbound lift ports for feeding pallets into this level.
- Dedicated outbound lift ports for receiving pallets out of this level.
- Parking pads for initial shuttle positions.

Dynamic scene:

- One shuttle actor per SimCore vehicle.
- Optional carried pallet mesh parented to the shuttle while `loaded=true`.
- Optional debug overlays for route, reservation, wait reason, and blocking vehicle.
- No diagonal travel; actors should only follow streamed orthogonal x/z motion.

## Bridge Binding

1. Create a UE 5.7 project for the visual twin.
2. Copy `unreal-bridge` into `Plugins/ShuttlePhase0Bridge`.
3. Enable Pixel Streaming at the project level.
4. Connect `UShuttleStateSubscriberSubsystem` to `ws://localhost:8791/shuttle-ws`.
5. Spawn or place one `AShuttleVisualTwinActor` per expected vehicle.
6. Assign each actor's `VehicleId`, then bind `OnVehicleState` to `ApplyAuthoritativeState`.
7. Use `connectionRecovered`, `simState`, and `vehicleState` as pose sources.
8. Ignore `kpiUpdate` and `taskEvent` for actor movement.

## Coordinate Contract

SimCore units are meters. Unreal units are centimeters.

- `UE.X = sim.x * 100`
- `UE.Y = sim.z * 100`
- `UE.Z = sim.y * 100`
- `UE.Yaw = radiansToDegrees(sim.yaw)`

The Phase 0 yaw sign is preserved. If a mesh faces a different local forward axis, fix the component or mesh offset in Unreal instead of changing the WebSocket protocol.

## Validation Gates

Before Pixel Streaming soak:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm shuttle:validate`
- Browser smoke: dashboard loads, 3D canvas renders, runtime advances, vehicles show moving/waiting states, no mount/unmount console errors.
- UE source bridge compile smoke.
- UE headless commandlet smoke.

After the real UE scene exists:

- Standalone UE runtime connects to the local API stream.
- Shuttle actors move only on orthogonal tracks.
- Carried pallet visibility follows `loaded`.
- Inbound and outbound lift ports are visually distinct and dedicated.
- Pixel Streaming runs a 1080p single-user 30-minute soak.
- Record CPU/GPU/memory/network observations and any stream disconnects.

## Calibration Inputs Needed

These inputs should come from CAD, vendor data, or site layout before the visual twin is treated as more than a Phase 0 demo:

- Real pallet size and orientation.
- Shuttle body envelope, lift height, and carried-load clearance.
- Track gauge and row pitch.
- Storage cell pitch and exact row/column count.
- Lift/conveyor node positions and dwell-time assumptions.
- Whether later push-lane mechanics are required, and how they reserve space/time.

## Non-Goals For This Pass

- Do not move dispatch authority into Unreal.
- Do not add multi-level lift routing yet.
- Do not implement multi-capacity reservation semantics in Unreal.
- Do not treat the browser Three.js preview as final visual fidelity.
