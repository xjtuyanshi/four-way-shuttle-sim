# ChatGPT Pro Review Response - Station Contract Direction

Date: 2026-06-24

ChatGPT conversation: https://chatgpt.com/c/6a3b54be-f470-83ea-9dcb-e3404b6f9fec

## Scope

ChatGPT Pro Extended reviewed:

- Repo: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Branch: `codex/traffic-v2-flow-debug`
- Commit: `d9bd1f36b736fbbd77dab94622fc39b6dde53b6d`
- Local handoff: `docs/chatgpt-pro-review-handoff-2026-06-24.md`

Important limitation from the review: it reviewed the GitHub commit and the pasted handoff evidence. It did not run local tests or inspect uncommitted local diffs directly.

## Reviewer Decision

Decision: request changes.

Do not continue to a 24h customer-review run yet. Do not add more outbound-lift-specific deadlock breakers.

The review agrees with the current working hypothesis:

- The earlier `module-01-spine-middle` five-vehicle failure was mainly a general traffic conflict-resolution issue. The bottom-a follower clearance fix can remain as an isolated traffic-layer fix.
- The new 34,800s outbound-lift failure is mainly a station/lift semantic ownership problem. FIFO, queue admission, queue slots, throat access, dock service, and physical movement are not currently owned as one coherent transaction.

## Root Cause Summary

The outbound flow has at least four competing truth sources:

- Task assignment decides whether an outbound queue is full.
- Queue-slot availability is inferred by scanning vehicle `currentNodeId`, `targetNodeId`, and `plannedGoalNodeId`.
- FIFO is dynamically inferred during movement from active tasks and physical positions.
- Dock corridor protection happens independently in physical movement and can roll back a tick.

Those checks do not form an atomic chain:

`station admission -> FIFO position -> queue slot -> throat turn -> dock service grant`

That allows locally legal states that contradict each other. For example, one shuttle can be logically FIFO head while another vehicle or route tail physically occupies the throat, and the generic traffic resolver then tries to side-yield or retreat inside an area where station order should be authoritative.

The reviewer called out `holdAtTopLiftQueueNode()` as especially suspicious because it can set a waiting vehicle route and target to its current node, effectively placing logical wait directly on the physical traffic graph. That matches the observed `SH-04` stationary wait at `column-bottom-b-c03` and `SH-01` / `SH-05` small-area ping-pong.

## Recommended Architecture

Add a narrow `StationPairCoordinator`, not a broad rewrite.

Authority split:

- `StationPairCoordinator`: station demand, FIFO, work-in-process admission, logical queue-slot ownership, throat turn, dock service grant.
- Physical occupancy: actual vehicle position at tick start.
- Existing traffic/reservation layer: edge, node, and zone movement reservations.
- Existing collision layer: swept footprint, minimum separation, and collision veto.
- Planner: route suggestion only; it should not own station resources.

Vehicles entering a protected station resource must satisfy all three:

- station semantic authorization;
- physical movement reservation;
- collision-safe movement.

## Admission Model

The station should own admission, but should not pre-lock an entire storage-to-dock route.

Use three stages:

- `work-admission`: before global dispatcher binds an outbound task, station approves the task entering station WIP. This controls how many vehicles can head toward the station.
- `queue-slot lease`: after AMR completes pickup, is loaded, and reaches a bounded station approach boundary, station grants a specific queue slot.
- `throat/service grant`: only the FIFO head at slot 1 can receive the bounded corridor turn from slot 1 through dock service to clear-through.

This prevents unlimited shuttles from being pushed toward the same dock without introducing route-wide hard claims that serialize the network.

## FIFO Rules

Do not rebuild FIFO each tick by scanning active tasks and positions.

Use persistent `fifoSeq` on station requests:

- Inbound FIFO: ordered when source arrival/release intent becomes ready.
- Outbound FIFO: ordered when pickup is complete, the AMR is loaded, and it is eligible to approach the station. Do not order outbound FIFO purely by task creation time, because a far-away old task can otherwise block a loaded vehicle already near the dock.

Physical queue movement:

- `slot N -> ... -> slot 2 -> slot 1 -> throat -> dock -> clear-through`
- No passing.
- Queue compression is dock-directed only.
- Slot-to-slot move is two-phase: reserve target slot, move, then release source slot.
- Only slot 1 FIFO head can request throat/service grant.
- Occupied slots cannot become logically free because of TTL expiry. TTL expiry should warn/fault, not silently reassign.
- Cancel/revoke/fault must create explicit terminal events.

## Traffic Resolver Boundary

Inside a station protected throat:

- Generic traffic resolver may veto unsafe movement.
- It must not reorder vehicles, choose station winners, insert side-yields, create temporary refuge routes, or retreat vehicles in a way that changes station order.
- Generic deadlock breakers must not rewrite station-owned routes.
- Only vehicles with an active station transition grant may enter protected node/edge/conflict groups.
- Non-station traffic must not use the protected throat as a generic shortest path.

Topology invariant:

Any node that can hold a long station wait must either be a declared queue/staging slot, or the whole corridor must be station-only. A shared through node cannot also be a casual waiting point.

## Minimal Migration Plan

1. Behavior-preserving mirror:
   Extract `StationTopology` and let a new coordinator mirror current outbound station state. Record old-vs-new diff but do not control movement.

2. Single behavior cut for outbound:
   Enable outbound station coordinator for work admission, loaded-ready queue-slot lease, head-only throat/service grant, and no local side-yield inside protected throat.

3. Remove double control under the feature flag:
   Old dynamic station ownership checks must become coordinator queries or be disabled. Specifically stop relying on dynamic active-task FIFO scans, `plannedGoalNodeId` / route-tail queue ownership, movement-time outbound FIFO holds, station-order inference inside dock corridor protection, and station-specific deadlock breakers.

4. After outbound passes 12h, migrate inbound to the same coordinator contract.

## Validation Plan

First create deterministic reproduction around the 34,800s failure. The reviewer recommends a fuller snapshot 60-120 seconds before first critical, including RNG, vehicles, tasks, loads, reservations, conflict sessions, station leases/sequences, and event sequence.

New implementation should pass:

- snapshot replay: old code reproduces the wait cycle; new code runs at least 600s without station invariant violation, stationary/long-wait, FIFO inversion, or ping-pong;
- unit/contract gates: one station transition lease per vehicle, one owner per queue slot, one owner per throat/dock, no grantless throat entry, no non-head dock service, occupied slots not reclaimed by TTL, explicit release events, deterministic snapshot restore;
- 1h smoke: physical violations 0, station invariants 0, no >300s station wait, no zero-task-moving/small-area-loop/node-ping-pong;
- 6h: no critical, no AMR with two consecutive zero-completion 10m windows, and PPH within 1-2% of current 6h baseline;
- 12h: complete to 43,200s and cross 34,800s, last 4h PPH no more than 5% below first stable 4h, no orphan lease/monotonic lease-age growth;
- 24h: no physical/station critical, no sustained hourly PPH degradation, each AMR has positive 10m p10 task completions, no continuous zero-output AMR, snapshot resume/replay hash consistent, and load/event ownership conserved.

The reviewer also recommends two extra 6h stress variants before customer-readiness: outbound-heavy and queue-full with sibling inbound active.

## Keep / Stop

Keep:

- fixed-step 3D tick;
- yellow feasible graph and orthogonal routing;
- edge/node/zone reservations;
- swept-footprint and minimum-separation checks;
- pickup/lift/lower physical event ordering;
- snapshot/hash/replay;
- 10-minute AMR audit and hourly PPH;
- existing station demand/lease schema fields as a base;
- bottom-a follower clearance, as long as it remains a traffic-layer fix outside protected station throat.

Stop:

- inferring station ownership from `plannedGoalNodeId`, route tail, or local route reason;
- rebuilding FIFO head by scanning active tasks each tick;
- assigning outbound tasks before station admission;
- implementing queues by rewriting routes on the shared bottom lane;
- generic side-yield inside protected station throat;
- adding more station-specific `tryBreak...` / `tryClear...` deadlock breakers;
- silently dropping leases in reconcile or route mutation;
- using short-window PPH as proof that station contracts are correct.

## Additional Readiness Risk

The reviewer also flagged a separate customer-readiness risk: the checked-in `phase0-scenario.json` appears to use a 2-shuttle scenario while long-window audit scripts default to 8 shuttles. CAD/obstacle calibration is also still marked as assumption/low confidence in places. This is separate from the station contract blocker, but matters for high-fidelity customer-review claims.
