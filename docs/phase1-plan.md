# Phase 1 Plan

Branch: `codex/phase1-validation-traffic-demo`

## Goal

Build on the merged Phase 0 hardening without changing the SimCore authority model. Phase 1 should make failures easier to prove, traffic pressure easier to understand, and the demo easier to judge from a user perspective.

## Current Priorities

1. Add positive-control validation fixtures for every reservation and physical violation code.
2. Add more traffic pressure scenarios that expose queues, waits, and deadlock/livelock candidates.
3. Improve the demo's user-facing diagnostics so waiting, blocking, and movement are legible without reading logs.
4. Keep Unreal and Pixel Streaming runtime validation gated until Unreal Engine 5.7.4 and full Xcode are installed.

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
