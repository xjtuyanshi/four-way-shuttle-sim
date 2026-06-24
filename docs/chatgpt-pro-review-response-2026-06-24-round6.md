# ChatGPT Pro Review Response - 2026-06-24 Round 6

Source: https://chatgpt.com/c/6a3b9b68-9560-83ea-9e50-83209655f900

Model/mode observed in Chrome: Pro Extended

## Review Boundary

ChatGPT Pro noted that GitHub remote `codex/traffic-v2-flow-debug` still points at base commit `d9bd1f36...`; Cut3, Round 6 handoff, and validation evidence are still local/uncommitted. Therefore this is an architecture and validation review, not a code-level approval of the current local diff.

The reviewer recommends committing/pushing a reproducible Cut3 review state before asking GitHub-backed reviewers to inspect exact code.

## Overall Decision

| Item | Decision |
| --- | --- |
| Cut3 revocation as a known-failure fix | Conditional pass |
| Claiming the whole outbound corridor deadlock class is eliminated | Not enough evidence |
| Enabling depth=2 now | No-go |
| Continuing to add corridor local blockers | Stop |
| Next implementation cut | Authoritative visit depth=1 + slot-0 lease |
| Next after that | Corridor mode draining, still depth=1 |
| Then | Enable slot-1 / depth=2 |
| 24h acceptance now | No-go |

## Key Conclusions

1. The 2h Cut3 run is enough to say the known SH-04/SH-07 reproduction chain was cut in that deterministic scenario, because it passed the old ~5150s failure time and ended at 7200s with no critical anomaly, physical violation, deadlock, or livelock.

2. The 2h Cut3 run is not enough to close the whole corridor-deadlock class. The revocation logic only covers a narrow state: taskless, unloaded, stopped, `inbound-queue-standby`. It does not prove safety for moving reserves, simultaneous sibling-station demand, restore during drain, active/loaded corridor occupants, route resets, or future depth=2 interactions.

3. Do not keep adding local blockers based on `localRouteReason + targetNodeId + plannedRouteNodeIds`. The correct direction is a station-owned controller that owns visits, FIFO, slot leases, and corridor mode.

4. The next cut should be `OutboundStationController` with authoritative `OutboundStationVisit` at depth=1 and a slot-0/head lease. Corridor mode should come after that, still at depth=1. Depth=2 should only come after both are stable.

5. The sampled shadow ledger violations should be classified before being treated as hard blockers:
   - Hard conflicts: duplicate authoritative owners, lease/occupancy mismatch, outbound service FIFO inversion.
   - Soft/watch conflicts: route intent overlaps in planned routes.
   - Actual outbound service-order inversion is P0 before depth=2. Projected route-intent inversion can remain watch-level.

## Recommended State Machine

```text
requested
  -> admitted
  -> at-head
  -> service-granted
  -> servicing
  -> clearing
  -> completed | cancelled
```

The public `outboundVisits` diagnostics should become a projection of the internal controller, not the controller itself.

Minimal atomic requirements for the next cut:

- Create exactly one visit when outbound task receives station work admission.
- Use visit as the only station capacity count.
- Give the visit a slot-0/head lease.
- Only the controller may authorize entry into head/pass/service envelope.
- Keep legacy admission only as a shadow comparison, not a second controller.

## Corridor Mode Recommendation

Implement after authoritative depth=1 visit/slot-0:

```text
shared -> draining -> outbound-queue -> shared
```

Requirements:

- Mode is persistent and has an `epochId`.
- Mode must survive snapshot/restore.
- Draining freezes a drain set.
- New incompatible inbound reserves cannot enter.
- Taskless reserves can be rerouted.
- Active/loaded occupants should naturally clear, not be forcibly revoked.
- Late visits must not join the same epoch indefinitely.
- Mode transitions only come from the controller, not from route fields inferred every tick.

## Depth=2 Requirements

Do not allow depth=2 until authoritative visit depth=1 and corridor mode are stable.

For depth=2:

- lift-01 persistent leases: `column-bottom-a-c07`, `column-bottom-a-c08`.
- lift-02 persistent leases: `column-bottom-a-c21`, `column-bottom-a-c20`.
- `column-bottom-a-c09` / `column-bottom-a-c19` must not become waiting slots in depth=2, or depth=2 has silently become depth=3.
- Admission edges must atomically acquire the next slot before entry.
- FIFO followers may only advance, not bypass the head visit.

## Acceptance Criteria For Depth=2

Hard invariants, every tick, immediate failure if nonzero:

- duplicate authoritative owner
- outbound service FIFO inversion
- more than one visit per task
- more than one visit per vehicle
- slot lease owner mismatch
- service entry without head grant
- admission edge without slot authorization
- illegal corridor mode transition
- orphan visit/lease after cancel/reset
- waiting at `c09`/`c19` in depth=2

Timing thresholds should be based on route physics, not a blanket 300s wait:

```text
T_clear =
  3 * freeFlow(clearanceRoute)
  + 2 * directionSwitchSec
  + 5s

T_visit_no_progress =
  T_clear
  + 2 * stationServiceCycle
```

Depth=2 coverage:

- At least 20 depth2 episodes per outbound station in 2h.
- At least 20 slot1-to-head transitions per outbound station.
- Every visit completes or ends through explicit cancellation.

Run gates:

- physical violations: 0
- deadlocks/livelocks: 0/0
- critical AMR windows: 0
- corridor mode timeout: 0
- visit progress timeout: 0
- normal run fallback `inbound-reserve-revoked-for-outbound-corridor`: 0 after the new controller is active

Performance A/B against frozen workload:

- 30m total PPH >= 98% of depth=1
- 30m inbound PPH >= 95% of depth=1
- outbound PPH >= depth=1
- old `outbound-station-work-admission-full` path disappears, replaced by visit/slot capacity reasons
- normalized admission-wait task-seconds per completed outbound drops by at least 25%

Add quiescence drain after 2h:

- Stop new task generation at 7200s.
- Run up to 300s more.
- Require active outbound visits 0, slot/service/corridor leases 0, both corridor modes `shared`, and no corridor-related waiting vehicles.
- Snapshot/restore result should match uninterrupted run.

## Preserve

- High-fidelity tick simulation.
- Yellow-grid topology.
- Physical separation and reservation logic.
- Cut3 explicit outbound approach topology.
- Shadow outboundVisits as controller projection.
- Existing station demand token, lease lifecycle, release event, and snapshot direction.
- Exact-node occupancy/hard reservation semantics.
- Cut3 runtime revocation as temporary emergency fallback.
- Deadlock detector, checkpointing, 10m AMR matrix, hourly PPH, and rolling log.
- `getState()` as pure read.

## Stop

- Adding new blockers inferred from `localRouteReason`, `targetNodeId`, and `plannedRouteNodeIds`.
- Turning full `plannedRouteNodeIds` into a hard lock.
- Static outbound active-task caps unrelated to station/slot.
- Repeated preempt/reassign of already-assigned outbound tasks.
- Multiple functions reconstructing queue-slot ownership.
- Priority penalties, hold timers, or reverse detours to squeeze through corridor.
- Treating final invariant count 0 as enough; running hard-invariant episodes matter.
- Patching loopiness directly before visit/mode progress is authoritative.

## Final Priority

P0:

- Push a Cut3 review commit with complete audit evidence binding.
- Add deterministic regression/replay for the original SH-04/SH-07 chain.
- Implement internal authoritative `OutboundStationController`: depth=1 + slot-0 lease.
- Split ledger into authoritative conflicts versus intent overlap.

P1:

- Implement corridor mode while keeping depth=1.
- After 10m and 30m pass, enable slot-1/depth=2.
- Complete 2h + quiescence gates.

P2:

- Clean actual inbound/outbound service FIFO inversions.
- Validate depth=3 step by step.
- Only then run 24h customer acceptance.

## One-Line Takeaway

Cut3 closes the reproduced case, not the broader corridor-deadlock class. The next minimal correct cut is authoritative depth=1 outbound visits with slot-0 ownership, followed by corridor mode, then depth=2.

