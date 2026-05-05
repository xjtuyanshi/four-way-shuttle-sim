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
- Added high-pressure inbound regression tests: one fills or reserves every FIFO storage cell and verifies `storage-full`; another runs 7200 inbound PPH with 12 shuttles for 180 simulated seconds and verifies the sim keeps running, uses at least 10 shuttles, maintains at least 8 active tasks, and reports no deadlock or physical safety failure.
- Replaced rack-like storage bay visuals with flat track-cell visuals so storage locations read as drivable grid positions, and added runtime playback speed control (`1x`, `2x`, `4x`, `10x`) through the API/dashboard.
- Added a CAD-style generated floor texture for the 3D view so the visual background comes from meter-based SimCore nodes/edges instead of a decorative scene; references and dimensional assumptions are tracked in `docs/layout-reference.md`.
- Replaced the sparse 2x3 storage demo with a 16x24 multi-bank storage matrix so each storage island reads as a dense block of adjacent drivable cells.
- Hardened the browser visual twin toward an engineering rack view: continuous storage rack block, cross-track cell rails, side-aisle rail beds, roller conveyors at inbound/outbound, parking pads, dedicated single-level black-box lift ports for inbound/outbound, and a cleaner CAD floor without oversized explanatory labels.
- Added lift-port resource diagnostics: dedicated inbound/outbound ports now expose active task, queue length, waiting task ids, and utilization so lift bottlenecks can be reviewed from an IE/operations perspective.
- Made storage-cell pass-through explicit: stored pallets occupy inventory but are not physical routing obstacles, so a shuttle can travel underneath stored loads on the same horizontal row; shuttle node occupancy remains the physical blocker.
- Changed live playback speed to substep internally at `scenario.timeStepSec`, so `10x` playback does not skip the same motion/reservation checks used by validation.
- Added same-row multi-cycle outbound regression coverage so FIFO draining cannot reintroduce hidden pallet compaction.
- Tightened safety validation to use oriented rectangular shuttle footprints plus configured clearance; center-to-center separation remains diagnostic only.
- Added a 600-second long-run validation sweep with queue, waiting vehicle, lift-port queue, deadlock, physical safety, and reservation coverage gates.
- Added schema enforcement for the temporary FIFO storage naming contract: `storage-rNN-cNN` cells plus matching `left-row-NN` / `right-row-NN` access nodes.
- Fixed route planning so future queued inbound slots reserve logical destinations without becoming physical obstacles before work is assigned.
- Validated and clamped playback speed input, including `SHUTTLE_SPEED`.
- Built the first Unreal visual twin scene foundation in `AShuttleVisualTwinRuntimeActor`: one single-level 16x24 multi-bank storage field with per-cell four-way rail detail, rack posts, roller-transfer lift pads, dedicated inbound/outbound black-box lift housings, load placeholders from streamed SimCore load snapshots, and smoke-contract counts for those visual details.
- Exposed the row-contiguous lane-fill storage policy in the shared static-scene contract with `storagePolicy: "rowContiguousLaneFill"`, `inboundStorageFlow: "rightToLeft"`, and `outboundStorageFlow: "leftPick"` so SimCore, dashboard, Unreal smoke, and review notes use the same wording.
- Added `config/shuttle/static-scene-contract.golden.json` as the default static-scene regression fixture. SimCore and dashboard tests compare the full contract against it, and the Unreal smoke path checks item-level parity against the same fixture.
- Added explicit `layoutCalibrationProfile.blockedCells` metadata and static-scene `blockedCells` parity so CAD-visible blocked/structural cells can be represented without pretending they are storage nodes.
- Added targeted congestion regression coverage for a near-full storage grid, four-vehicle mixed lift/FIFO pressure, inbound-only pressure, and outbound-only pressure. These tests assert positive throughput where applicable plus no deadlocks, livelocks, or physical safety failures.
- Added a validation-owned stress suite covering balanced 7200/7200 PPH surge, inbound-only saturation, outbound on empty store, preloaded outbound pressure, and near-full inbound pressure. The suite reports requested versus achieved PPH, queue high water, stress pass/fail, and observed bottleneck reasons.
- The stress/review loop exposed real portal conflicts. Default layout portal movement zones now include lift, main-lane, north/south transfer, and storage-row connector edges touching the portal; stopped portal-node occupants also hold explicit node-zone reservations.
- Verified the local Unreal path through setup, source bridge smoke, live bridge smoke, staged Mac runtime generation, and browser Pixel Streaming smoke evidence. This proves the local runtime scaffold, not a final signed/notarized production package.
- Added schema validation for external/custom layout inputs: every node must stay on the single simulated floor, every edge must be an orthogonal X/Z track segment, zero-length edges are rejected, and zones cannot reference missing nodes or edges.
- Strengthened long-run by-side throughput acceptance from nonzero liveness to proportional floors. The default 18 inbound / 18 outbound PPH demand now requires at least 6 inbound PPH and 6 outbound PPH per long-run seed, while total throughput still has its separate 50% floor. These are regression-smoke floors until CAD/vendor/site calibration exists.
- Added validation-owned bottleneck category aggregation for `storageInventory`, `fifoLane`, `sideAisleNetwork`, `liftPort`, `reservationControl`, and `other`, and surfaced the top long-run/stress class in the dashboard.
- Added a static-scene calibration readiness gate that lists required CAD/vendor/site dimensions, separates missing dimensions from assumed or low-confidence values, and keeps industrial throughput claims blocked until the profile is fully verified. The dashboard and API validation report now surface the same gate beside Mac/UE and validation status.
- Expanded the default single-level demo from four parking positions to eight one-capacity staged parking positions. The extra positions sit behind the direct main-lane parking pads so an 8-shuttle smoke run creates realistic staging-queue pressure without violating the Phase 0 capacity=1 reservation policy.
- Set the default four-way shuttle direction-switch dwell to `0` so the visible demo models a body that never turns or rotates at right-angle moves. The parameter remains available for a future calibrated wheel-actuation timing study, but it is not part of the default demo behavior.
- Split pallet/load storage occupancy from shuttle node occupancy for storage cells. Beyond the eight dedicated pads, idle shuttles may now use storage cells as temporary under-load parking; inbound slot allocation skips cells currently occupied by a shuttle.
- Harden storage-area traversal to row-horizontal movement only: storage-to-storage graph edges may not cross FIFO rows, and cross-row moves must route through side/main aisles. Task assignment now selects the nearest idle executable shuttle resource instead of letting the first idle vehicle claim the first queued task.
- Reworked pressure behavior after the 7200 inbound / 0 outbound / 12-shuttle stress failure: `maxTasks` is now an active backlog cap, the default demo duration is 7200 simulated seconds, inbound storage allocation spreads work across FIFO rows, right-side row-spine movement is constrained to the inbound feed direction, and outbound left-FIFO work is serialized until calibrated passing/escape logic exists.
- Tightened the row movement contract for under-load parking: a shuttle parked in a storage cell exits by the nearest left/right row-side access, while an inbound dropoff route backs out toward the right/infeed side rather than crossing the whole FIFO row to the outbound side.

## Next TODO

- Replace the assumption-grade `phase0-cad-assumption-v1` layout profile with CAD/vendor/site dimensions until the calibration readiness gate reports `readyForIndustrialThroughputClaims=true`: storage pitch, aisle widths, shuttle footprint, pallet/load envelope, lift pad envelope, roller-transfer envelope, parking pad envelope, and blocked/structural cells.
- Keep the configurable layout profile as the calibration boundary; when CAD/vendor/site dimensions deliberately change the default scene, regenerate and review the golden static-scene fixture in the same commit.
- Replace the staged parking placeholder geometry with calibrated parking/charging/staging positions before using high-shuttle-count output for industrial sizing. Phase 0 now enforces one parkable non-aisle node per vehicle, with storage-cell under-load parking allowed when the cell is not currently occupied by another shuttle.
- Add true push-lane or multi-axis storage-grid mechanics only after the FIFO lane policy is explicitly modeled against the target physical layout.
- Replace remaining Unreal placeholder geometry with calibrated meshes/materials once CAD or vendor dimensions are available; keep SimCore authoritative.
- Run a 30-minute 1080p single-user Pixel Streaming soak only after the calibrated Unreal scene foundation is visually reviewed and the browser/API validation gate is green.
