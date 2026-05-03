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
- The first runtime slice uses `AShuttleVisualTwinRuntimeActor` as a thin manager: it builds the default single-level static layout, connects to the API stream, and spawns/binds visible default shuttle actors by `VehicleId`.

## Bridge Binding

1. Run `pnpm unreal:setup` to generate a clean UE 5.7 project under `output/unreal/ShuttleVisualTwin`.
2. The setup script copies `unreal-bridge` into `Plugins/ShuttlePhase0Bridge`.
3. The setup script enables the `ShuttlePhase0Bridge` and `PixelStreaming` plugins in the generated `.uproject`.
4. Connect `UShuttleStateSubscriberSubsystem` to `ws://localhost:8791/shuttle-ws`.
5. Spawn or place one `AShuttleVisualTwinActor` per expected vehicle.
6. Assign each actor's `VehicleId`, then bind `OnVehicleState` to `ApplyAuthoritativeState`.
7. Use `connectionRecovered`, `simState`, and `vehicleState` as pose sources.
8. Ignore `kpiUpdate` and `taskEvent` for actor movement.

For the default Phase 0 scene, place `AShuttleVisualTwinRuntimeActor` at world origin instead of wiring these steps manually. It remains a visual subscriber only; it does not create tasks, reservations, KPI truth, or dispatch decisions.

`AShuttleVisualTwinRuntimeActor` exposes `ConnectToBridge` and `DisconnectFromBridge` so a placed runtime actor can be started explicitly from a level blueprint, automated smoke harness, or later Pixel Streaming startup flow. `BeginPlay` still calls `ConnectToBridge` when `bAutoConnect=true`.

## Coordinate Contract

SimCore units are meters. Unreal units are centimeters.

- `UE.X = sim.x * 100`
- `UE.Y = sim.z * 100`
- `UE.Z = sim.y * 100`
- `UE.Yaw = radiansToDegrees(sim.yaw)`

The Phase 0 yaw sign is preserved. If a mesh faces a different local forward axis, fix the component or mesh offset in Unreal instead of changing the WebSocket protocol.

## Validation Gates

Before Pixel Streaming soak:

- `pnpm unreal:setup`
- `pnpm unreal:build`
- `pnpm unreal:smoke`
- `pnpm shuttle:ws-smoke`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm shuttle:validate`
- Browser smoke: dashboard loads, 3D canvas renders, runtime advances, vehicles show moving/waiting states, no mount/unmount console errors.
- UE source bridge compile smoke.
- UE headless commandlet smoke.
- Long-run validation must meet explicit thresholds reported in `validation.longRun.thresholds`, not only positive throughput.
- Unreal setup/smoke must print machine-readable readiness diagnostics showing the generated project path, engine association, enabled `ShuttlePhase0Bridge` and `PixelStreaming` plugins, copied bridge source files, and compiled bridge binary.
- The UE smoke commandlet must instantiate `AShuttleVisualTwinRuntimeActor` headlessly, write a static-scene contract JSON summary, compare it against the SimCore default static-scene contract, verify the default single-level 6x8 dense storage block, right-side inbound lift ports, left-side outbound lift ports, orthogonal-only tracks, and compare item-level storage cell, track-bed, lift-pad, and parking-pad IDs/categories/coordinates/sizes/rows/sides/orientations where applicable. It also exercises the synthetic vehicle binding path: one actor spawned per `VehicleId`, subsequent updates reuse the actor, SimCore-to-Unreal coordinate/yaw conversion holds, and carried-pallet visibility follows `loaded`.
- The WebSocket smoke must start the API on an isolated local port, connect to `/shuttle-ws`, validate `connectionRecovered`, `simState`, `vehicleState`, and `kpiUpdate`, verify required vehicle pose/load fields, set 4x playback speed, and prove streamed simulation time advances.
- The UE live bridge smoke must start the local API on an isolated port, create a headless `UGameInstance`, spawn `AShuttleVisualTwinRuntimeActor`, connect it to the live `/shuttle-ws` stream, and prove the bridge saw `connectionRecovered`, `simState`, a root `vehicleState`, and `kpiUpdate`; simulation time advanced; the expected vehicle actor count exists; no duplicate owned actors were spawned; final target pose/load binding is within tolerance; and the commandlet wrote a JSON summary with message counts plus IE-facing KPI fields.

After the real UE scene exists:

- Standalone UE runtime connects to the local API stream.
- Shuttle actors move only on orthogonal tracks.
- Carried pallet visibility follows `loaded`.
- Inbound and outbound lift ports are visually distinct and dedicated.
- Pixel Streaming runs a 1080p single-user 30-minute soak.
- Record CPU/GPU/memory/network observations and any stream disconnects.

Current local smoke status: `pnpm unreal:setup` and `pnpm unreal:smoke` generate the UE project, verify bridge and Pixel Streaming plugin enablement, verify copied bridge source coverage, build `ShuttleVisualTwinEditor`, verify the compiled bridge plugin binary, run the `ShuttleVisualTwinSmoke` commandlet against the runtime actor scene scaffold, print and validate a JSON static-scene contract for the single-level dense storage block and dedicated lift-port layout, compare that contract against the SimCore default static-scene contract at both aggregate and item level, complete `CompileAllBlueprints` with 0 errors and 0 blueprint warnings, then run `ShuttleVisualTwinLiveSmoke` against a temporary live API stream. The live smoke prints and validates a JSON acceptance trace covering stream message counts, sim-time span, expected vehicle count, duplicate actor count, target pose/load checks, and KPI/IE telemetry captured from the SimCore stream. `pnpm shuttle:ws-smoke` separately proves the live API stream contract and 4x playback control from Node. Together these prove local UE bridge/runtime-scaffold readiness plus live stream readiness, not the final physical scene or Pixel Streaming soak. UE currently logs one host-toolchain warning: `Missing Mac Metal toolchain (macos SDK not found)`.

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
