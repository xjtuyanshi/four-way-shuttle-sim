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

## Next TODO

- Model pallet occupancy separately from shuttle occupancy so the shuttle can lift from underneath, carry, lower, and leave the pallet in a storage cell.
- Add lane-level FIFO inventory rules: fill each row from the right-side infeed, drain from the left-side outfeed, and expose blocked/full/empty reasons in the dashboard.
- Upgrade the 3D dashboard scene to make racks, pallets, under-lift shuttles, and FIFO lane state visually obvious before starting Unreal runtime work.
- Prepare the Unreal bridge/scene plan after the browser demo shows the correct four-way shuttle behavior.
