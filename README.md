# Four-Way Shuttle Sim

High-fidelity four-way shuttle simulation prototype.

Phase 0 separates deterministic simulation truth from Unreal rendering:

- `packages/shuttle-sim-core`: authoritative SimCore / WCS-lite state, task generation, routing, reservations, event logs, and KPI snapshots.
- `packages/shuttle-schemas`: shared protocol and scenario schemas.
- `apps/shuttle-api`: HTTP/WebSocket command and stream API.
- `apps/shuttle-dashboard`: React dashboard with parameters, KPI, event log, traffic diagnostics, and a local Three.js 3D SimCore preview.
- `unreal-bridge`: source-only Unreal Engine plugin scaffold for visual twin subscription.

## Local Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm shuttle:prereq
pnpm shuttle:validate
pnpm dev:api
pnpm dev:dashboard
```

Default local URLs:

- API: `http://localhost:8791/api/shuttle/health`
- WebSocket: `ws://localhost:8791/shuttle-ws`
- Dashboard: `http://localhost:5179`

Unreal Engine 5.7.4 and full Xcode are installed on the local Mac. Local macOS browser smoke has passed with a generated `PixelStreaming2` render-target capture scene plus the source bridge compile/headless smoke path. Packaged runtime soak and release hardening remain out of scope for Phase 0.

Phase 0 storage policy is a conservative row-level contract, not a full industrial throughput proof: inbound placement spreads work across FIFO rows while preserving contiguous fill inside each row, outbound drains without hidden compaction, stored pallets do not block shuttle pass-through under the load, and all reservation capacities remain fixed at `1`.

The default physical layout is generated from the assumption-grade calibration profile `phase0-cad-assumption-v1`. That profile is exposed as `scenario.layout.calibrationProfile` and in the static-scene contract so CAD/vendor/site dimensions can replace the placeholder pitch, aisle, lift, and clearance values without moving authority out of SimCore.

The checked-in golden fixture `config/shuttle/static-scene-contract.golden.json` freezes the current default static-scene contract. SimCore, the dashboard, and the Unreal smoke path compare against it so layout, unit, storage-cell, track, lift, and calibration metadata drift is explicit.

CAD-visible blocked or structural cells are represented as non-routable `layoutCalibrationProfile.blockedCells` metadata and mirrored into the static-scene contract as `blockedCells`. The default profile keeps that list empty until exact CAD/site coordinates are available, so the simulator does not invent unusable storage positions.

`pnpm shuttle:validate` runs the Phase 0 acceptance gate without rendering: same-seed event-log hash stability, a small seed sweep, a 600-second long-run sweep, prerequisite inspection, KPI summary, deadlock checks, reservation coverage checks, and physical safety checks for speed, acceleration, finite coordinates, and rectangular vehicle footprint clearance.

Phase 0 enforces edge, node, and zone capacity as `1`, and requires at least one parking node per vehicle so reset can assign one authoritative current-node occupant per shuttle. Multi-capacity reservation accounting is reserved for Phase 1.
