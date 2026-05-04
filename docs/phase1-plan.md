# Phase 1 Plan

Current baseline: public `main` after Phase 0 merge-hardening, real-layout calibration, staged Unreal runtime smoke, and targeted congestion regression coverage.

## Goal

Build on the merged Phase 0 hardening without changing the SimCore authority model. Phase 1 should make failures easier to prove, traffic pressure easier to understand, and the demo easier to judge from a user perspective.

## Current Priorities

1. Keep SimCore as the WCS-lite source of truth and keep Unreal/dashboard as visual subscribers.
2. Calibrate the default layout from CAD/vendor dimensions before treating throughput as an industrial claim.
3. Expand traffic pressure coverage around lift queues, portal zones, near-full storage, empty outbound, and repeated same-row retrieval.
4. Improve diagnostics so engineering, mechanical, and IE review can identify whether bottlenecks come from lifts, portals, side aisles, or dense storage lanes.
5. Keep Unreal and Pixel Streaming validation gated by installed UE/Xcode tools and by whether the visual scene is calibrated enough to review.

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
- Replaced the default demo layout with an orthogonal four-way shuttle grid based on public four-way pallet-shuttle references and CAD-style assumptions: no diagonal edges, upper/lower storage banks, four column islands, a two-lane main aisle, distributed dedicated lift ports, and FIFO storage/retrieval policy on storage-lane rails.
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
- Replaced the sparse 2x3 storage demo with a 16x24 multi-bank storage matrix so each storage island reads as a dense block of adjacent drivable cells.
- Hardened the browser visual twin toward an engineering rack view: continuous storage rack block, cross-track cell rails, side-aisle rail beds, roller conveyors at inbound/outbound, parking pads, dedicated single-level black-box lift ports for inbound/outbound, and a cleaner CAD floor without oversized explanatory labels.
- Added lift-port resource diagnostics: dedicated inbound/outbound ports now expose active task, queue length, waiting task ids, and utilization so lift bottlenecks can be reviewed from an IE/operations perspective.
- Made storage-cell pass-through explicit: occupied storage cells are blocked for routing unless that cell is the current task endpoint.
- Changed live playback speed to substep internally at `scenario.timeStepSec`, so `10x` playback does not skip the same motion/reservation checks used by validation.
- Added same-row multi-cycle outbound regression coverage so FIFO draining cannot reintroduce hidden pallet compaction.
- Tightened safety validation to use oriented rectangular shuttle footprints plus configured clearance; center-to-center separation remains diagnostic only.
- Added a 600-second long-run validation sweep with queue, waiting vehicle, lift-port queue, deadlock, physical safety, and reservation coverage gates.
- Added schema enforcement for the temporary FIFO storage naming contract: `storage-rNN-cNN` cells plus matching `left-row-NN` / `right-row-NN` access nodes.
- Fixed route planning so future queued inbound slots reserve logical destinations without becoming physical obstacles before work is assigned.
- Validated and clamped playback speed input, including `SHUTTLE_SPEED`.
- Built the first Unreal visual twin scene foundation in `AShuttleVisualTwinRuntimeActor`: one single-level 16x24 multi-bank storage field with per-cell four-way rail detail, rack posts, roller-transfer lift pads, dedicated inbound/outbound black-box lift housings, load placeholders from streamed SimCore load snapshots, and smoke-contract counts for those visual details.
- Exposed the row-contiguous lane-fill storage policy in the shared static-scene contract with `storagePolicy: "rowContiguousLaneFill"`, `inboundStorageFlow: "rightToLeft"`, and `outboundStorageFlow: "leftPick"` so SimCore, dashboard, Unreal smoke, and review notes use the same wording.
- Added targeted congestion regression coverage for a near-full storage grid, four-vehicle mixed lift/FIFO pressure, inbound-only pressure, and outbound-only pressure. These tests assert positive throughput where applicable plus no deadlocks, livelocks, or physical safety failures.
- Verified the local Unreal path through setup, source bridge smoke, live bridge smoke, staged Mac runtime generation, and browser Pixel Streaming smoke evidence. This proves the local runtime scaffold, not a final signed/notarized production package.

## Next TODO

- Track the current public `main` ChatGPT Pro follow-up and fold in only concrete blockers; the previous verdict was merge now with no must-fix.
- Replace the assumption-grade `phase0-cad-assumption-v1` layout profile with CAD/vendor/site dimensions before making stronger throughput claims: storage pitch, aisle widths, shuttle footprint, pallet/load envelope, lift pad envelope, roller-transfer envelope, and blocked/structural cells.
- Keep the configurable layout profile as the calibration boundary while preserving the current deterministic default as a regression fixture.
- Add true push-lane or multi-axis storage-grid mechanics only after the FIFO lane policy is explicitly modeled against the target physical layout.
- Replace remaining Unreal placeholder geometry with calibrated meshes/materials once CAD or vendor dimensions are available; keep SimCore authoritative.
- Run a 30-minute 1080p single-user Pixel Streaming soak only after the calibrated Unreal scene foundation is visually reviewed and the browser/API validation gate is green.
