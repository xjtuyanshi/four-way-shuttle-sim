# Phase 0 Final Merge Handoff

Branch: `main`
Head: latest pushed commit on `main`
Repository: `https://github.com/xjtuyanshi/four-way-shuttle-sim`

## Merge Verdict

- Local verdict after latest fixes: merge-ready.
- Latest ChatGPT Pro public-branch verdict for commit `9cd328659bd9a10a27e32cca12b9197544d4af9b`: Merge now.
- Verified must-fix findings remaining locally: none after this pass.
- Unreal Engine 5.7.4 and full Xcode are now installed; bridge compile/headless smoke, live bridge smoke, staged Mac runtime generation, and local browser Pixel Streaming smokes passed. The 30-minute soak and release hardening remain Phase 1 work after calibrated scene review.

## Verification

Passed on the branch head:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm shuttle:validate
```

Validation gate:

```text
acceptance.pass=true
sameSeedEventHashStable=true
noDeadlocksInSweep=true
eventLogsPresent=true
noPhysicalSafetyViolations=true
noReservationCoverageViolations=true
longRunEventLogsPresent=true
longRunThroughputPositive=true
longRunQueuesBounded=true
noLongRunDeadlocks=true
noLongRunPhysicalSafetyViolations=true
noLongRunReservationCoverageViolations=true
physicalViolationsByCode all zero
longRun.totalPphMean=18
longRun.maxQueuedTasks=2
longRun.maxWaitingVehicles=0
longRun.maxLiftPortQueueLength=1
```

Browser smoke:

```text
dashboard loads
3D canvas appears
runtime advances
vehicle table shows idle and moving-to-pickup states
Pixel Streaming prerequisite label reads as prerequisites, not release-soak readiness
latest screenshot evidence: output/playwright/dashboard-readiness-wording-smoke.png
```

## Non-Blocking Phase 1 Backlog

- Capacity-aware edge/node/zone reservations once capacities above `1` are reintroduced.
- Stronger wait-for graph and livelock analysis.
- Positive-control validator fixtures for every violation code.
- Additional dashboard stream reducer tests for out-of-order partial updates, reconnect replacement, and vehicle removal semantics.
- Same-node or zero-distance traffic-transition tests if future route generation can produce them.
- Calibrated Unreal scene assembly from CAD/vendor/site dimensions.
- Pixel Streaming 30-minute 1080p single-user soak after the calibrated scene is reviewed.
