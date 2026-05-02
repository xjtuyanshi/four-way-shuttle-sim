# ChatGPT Pro Stable Review Entry

Use this when ChatGPT Pro has trouble cloning or browsing the repository.

## Why Repo Review Can Fail

The repository and PR are public, so this is not a GitHub permission issue.

Verified public URLs:

- Repository: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- PR: `https://github.com/xjtuyanshi/four-way-shuttle-sim/pull/1`
- PR patch: `https://github.com/xjtuyanshi/four-way-shuttle-sim/pull/1.patch`
- Final handoff raw doc: `https://raw.githubusercontent.com/xjtuyanshi/four-way-shuttle-sim/codex/p1-p5-physics-traffic-3d/docs/phase0-final-merge-handoff.md`

ChatGPT Pro may still fail because its browsing/analysis environment can hit DNS failures, clone restrictions, GitHub API truncation, or context truncation on large diffs. The PR patch is several thousand lines, so the most reliable workflow is to avoid clone-based review.

## Preferred Prompt

```text
Review this public PR for merge blockers only.

Do not clone the repository. If browsing works, read these two URLs only:

1. Final handoff:
https://raw.githubusercontent.com/xjtuyanshi/four-way-shuttle-sim/codex/p1-p5-physics-traffic-3d/docs/phase0-final-merge-handoff.md

2. PR patch:
https://github.com/xjtuyanshi/four-way-shuttle-sim/pull/1.patch

If either URL fails, do not retry with clone. Return the best review from the handoff and the summary below.

Scope: merge-hardening only. Do not treat Phase 1 feature work or missing Unreal runtime tools as merge blockers.

Required output:
1. Must-fix findings before merge, ordered by severity.
2. Non-blocking Phase 1 recommendations.
3. Verdict: merge now, merge after fixes, or redesign needed.
```

## No-Network Fallback Prompt

```text
Final merge-blocker review. Do not browse, clone, or use network. Review only the summary below and return concrete findings. If an issue cannot be verified from the summary, mark it non-blocking/unknown.

Repo: https://github.com/xjtuyanshi/four-way-shuttle-sim
Branch: codex/p1-p5-physics-traffic-3d
Head: 53bfd2145c0c9f652cc884fbcb5ae38bff0ce8b0
Scope: merge-hardening only. No product features or architecture redesign.

Implemented hardening:
- SimCore has currentNodeOccupancy; reset occupies each starting parking/current node. Vehicles stopped/waiting at a node keep occupancy. Before departure they reserve next edge, target node, and every matching zone. Current node occupancy releases only after movement commit. Arrival atomically transfers target-node reservation into currentNodeOccupancy. Tests expose debug occupancy.
- Traffic tests cover opposite-direction same-edge conflict, target-node occupancy race, crossing zone serialization, deadlock sanity, motion profile triangular/trapezoid/boundary/zero distance, loaded speed lower than empty, reservation travel time equals movement arrival.
- Validation samples every tick and reports by-code cumulative aggregation plus first 20 examples. Codes: unreservedEdgeOccupancy, unreservedNodeOccupancy, unreservedZoneOccupancy, nodeOccupancyMismatch, edgeOccupancyMismatch, speedLimit, accelerationLimit, minSeparation, invalidCoordinate. Acceptance requires no physical safety violations and no reservation coverage violations. state.traffic.physicalViolationCount is documented as instantaneous; validation owns cumulative counts.
- Unreal bridge uses TryGetStringField for type, handles connectionRecovered.state.vehicles, simState.state.vehicles, vehicleState.vehicles, ignores kpiUpdate/taskEvent, parses optional nullable fields defensively, skips malformed vehicles and broadcasts concise status. README documents Sim meters to UE centimeters: X=x*100, Y=z*100, Z=y*100, yaw mapping.
- Phase 0 enforces all reservation capacities = 1 and layout node/zone capacity = 1; multi-capacity deferred to Phase 1. Schema requires one parking node per vehicle and rejects duplicate node ids.
- Dashboard merges incremental vehicleState and kpiUpdate WebSocket messages into existing state snapshot; tests added and dashboard tests are included in pnpm test.

Verification passed after latest commit:
pnpm typecheck; pnpm test (19 tests); pnpm build; pnpm shuttle:validate. Validation acceptance.pass=true, sameSeedEventHashStable=true, noDeadlocksInSweep=true, noPhysicalSafetyViolations=true, noReservationCoverageViolations=true, physicalViolationsByCode all zero. Browser smoke: dashboard loads, 3D canvas visible, runtime advances, vehicle table shows waiting-blocked and loaded-moving, localhost console errors/warnings none. Unreal runtime/Pixel Streaming blocked because Unreal 5.7.4 and full Xcode are not installed.

Return only:
1. Must-fix findings before merge, with file paths if possible.
2. Non-blocking Phase 1 recommendations.
3. Verdict: merge now, merge after fixes, or redesign needed.
```
