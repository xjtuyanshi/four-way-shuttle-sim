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
- Replaced the default demo layout with an orthogonal four-way shuttle grid inspired by the reference video: no diagonal edges, two vertical side aisles, top/bottom cross aisles, center storage cells, right-side infeed, left-side outfeed, and FIFO storage/retrieval policy on bidirectional lane rails.
- Added a regression test that fails if the default demo reintroduces diagonal edges, sparse storage cells, generic I/O nodes, or non-bidirectional four-way storage-lane rails.
- Added authoritative FIFO pallet occupancy in SimCore:
  - outbound tasks are deferred with `storage-empty` instead of creating phantom pallets;
  - inbound tasks reserve the next FIFO storage cell;
  - outbound tasks reuse existing stored loads from the left-side outlet;
  - stored pallet `nodeId` changes only through explicit vehicle/lift transfer, so the simulator no longer performs hidden row compaction after an outbound pickup.
- Exposed `storageNodeOccupancy` in debug state for tests, and added regression coverage for empty-storage deferral plus FIFO fill/drain behavior.
- Surfaced FIFO row inventory in the dashboard, including per-cell stored/reserved/empty state and cumulative `storage-empty` / `storage-full` wait time.
- Added a high-pressure inbound regression test that fills or reserves every FIFO storage cell, then verifies new inbound work is deferred with `storage-full` instead of overbooking the storage grid.
- Replaced rack-like storage bay visuals with flat track-cell visuals so storage locations read as drivable grid positions, and added runtime playback speed control (`1x`, `2x`, `4x`, `10x`) through the API/dashboard.
- Added a CAD-style generated floor texture for the 3D view so the visual background comes from meter-based SimCore nodes/edges instead of a decorative scene; references and dimensional assumptions are tracked in `docs/layout-reference.md`.
- Replaced the sparse 2x3 storage demo with a contiguous 6x8 storage matrix so the center storage field reads as a dense block of adjacent drivable cells.
- Hardened the browser visual twin toward an engineering rack view: continuous storage rack block, cross-track cell rails, side-aisle rail beds, roller conveyors at inbound/outbound, parking pads, dedicated single-level black-box lift ports for inbound/outbound, and a cleaner CAD floor without oversized explanatory labels.
- Added lift-port resource diagnostics: dedicated inbound/outbound ports now expose active task, queue length, waiting task ids, and utilization so lift bottlenecks can be reviewed from an IE/operations perspective.
- Made storage-cell pass-through explicit: occupied storage cells are blocked for routing unless that cell is the current task endpoint.
- Changed live playback speed to substep internally at `scenario.timeStepSec`, so `10x` playback does not skip the same motion/reservation checks used by validation.

## Next TODO

- Add true multi-axis storage-grid routing or push-lane mechanics only after the FIFO lane policy is explicitly modeled against the target physical layout.
- Prepare the Unreal bridge/scene plan after the browser demo shows the correct four-way shuttle behavior.
