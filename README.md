# Four-Way Shuttle Sim

High-fidelity four-way shuttle simulation prototype.

Phase 0 separates deterministic simulation truth from Unreal rendering:

- `packages/shuttle-sim-core`: authoritative SimCore / WCS-lite state, task generation, routing, reservations, event logs, and KPI snapshots.
- `packages/shuttle-schemas`: shared protocol and scenario schemas.
- `apps/shuttle-api`: HTTP/WebSocket command and stream API.
- `apps/shuttle-dashboard`: React dashboard for parameters, KPI, event log, and Pixel Streaming readiness.
- `unreal-bridge`: source-only Unreal Engine plugin scaffold for visual twin subscription.

## Local Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm shuttle:prereq
pnpm dev:api
pnpm dev:dashboard
```

Default local URLs:

- API: `http://localhost:8791/api/shuttle/health`
- WebSocket: `ws://localhost:8791/shuttle-ws`
- Dashboard: `http://localhost:5179`

Unreal / Pixel Streaming validation is blocked until Unreal Engine 5.7.4 and full Xcode are installed on the Mac.
