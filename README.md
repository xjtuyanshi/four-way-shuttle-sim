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

Unreal / Pixel Streaming validation is blocked until Unreal Engine 5.7.4 and full Xcode are installed on the Mac.

`pnpm shuttle:validate` runs the Phase 0 acceptance gate without rendering: same-seed event-log hash stability, a small seed sweep, prerequisite inspection, KPI summary, deadlock checks, and physical safety checks for speed, acceleration, finite coordinates, and vehicle separation.
