# Phase 1 Plan

Branch: `codex/phase1-validation-traffic-demo`

## Goal

Build on the merged Phase 0 hardening without changing the SimCore authority model. Phase 1 should make failures easier to prove, traffic pressure easier to understand, and the demo easier to judge from a user perspective.

## Current Priorities

1. Add positive-control validation fixtures for every reservation and physical violation code.
2. Align the default demo environment with the four-way shuttle reference: orthogonal aisle grid only, storage cells in the middle, right-side infeed, left-side outfeed, and FIFO lane direction.
3. Add more traffic pressure scenarios that expose queues, waits, and deadlock/livelock candidates.
4. Improve the demo's user-facing diagnostics so waiting, blocking, and movement are legible without reading logs.
5. Keep Unreal and Pixel Streaming runtime validation gated until Unreal Engine 5.7.4 and full Xcode are installed.

## Completed In This Branch

- Added `inspectPhase0StateSnapshot` so tests can inspect one authoritative state/debug snapshot without running a full scenario.
- Added positive-control tests for:
  - `unreservedEdgeOccupancy`
  - `unreservedNodeOccupancy`
  - `unreservedZoneOccupancy`
  - `nodeOccupancyMismatch`
  - `edgeOccupancyMismatch`
  - `speedLimit`
  - `accelerationLimit`
  - `minSeparation`
  - `invalidCoordinate`
- Replaced the default demo layout with an orthogonal four-way shuttle grid inspired by the reference video: no diagonal edges, two vertical side aisles, top/bottom cross aisles, center storage cells, right-side infeed, left-side outfeed, and one-way FIFO storage lanes.
- Added a regression test that fails if the default demo reintroduces diagonal edges or non-FIFO storage-lane directions.
- Added authoritative FIFO pallet occupancy in SimCore:
  - outbound tasks are deferred with `storage-empty` instead of creating phantom pallets;
  - inbound tasks reserve the next FIFO storage cell;
  - outbound tasks reuse existing stored loads from the left-side outlet;
  - stored pallets compact toward the outlet after an outbound pickup.
- Exposed `storageNodeOccupancy` in debug state for tests, and added regression coverage for empty-storage deferral plus FIFO fill/drain behavior.
- Surfaced FIFO row inventory in the dashboard, including per-cell stored/reserved/empty state and cumulative `storage-empty` / `storage-full` wait time.
- Added a high-pressure inbound regression test that fills or reserves every FIFO storage cell, then verifies new inbound work is deferred with `storage-full` instead of overbooking the storage grid.
- Replaced rack-like storage bay visuals with flat track-cell visuals so storage locations read as drivable grid positions, and added runtime playback speed control (`1x`, `2x`, `4x`, `10x`) through the API/dashboard.

## Next TODO

- Improve the 3D dashboard scene camera/framing so the FIFO lanes, pallets, and under-lift shuttles remain visible across desktop and mobile viewports.
- Prepare the Unreal bridge/scene plan after the browser demo shows the correct four-way shuttle behavior.
