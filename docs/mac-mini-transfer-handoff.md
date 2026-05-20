# Four-Way Shuttle Sim Mac Mini Handoff

Paste this into the new Codex/ChatGPT window on the Mac mini.

## Repo And Branch

Workspace/repo:

```bash
git clone https://github.com/xjtuyanshi/four-way-shuttle-sim.git
cd four-way-shuttle-sim
git checkout codex/traffic-v2-flow-debug
git pull
corepack enable
corepack pnpm install
```

Latest pushed commit to continue from:

```text
29ffb3a Harden inbound agent refresh audits
```

## Current Product Direction

We are building a four-way shuttle / AMR discrete-event simulator.

The current default demo control mode should stay `agent-refresh`, not the older mixed `agent-minimal` logic. The desired behavior is:

- Each shuttle is an individual agent.
- At task assignment, it creates one stable shortest planned route to pickup/dropoff.
- It does not constantly replan the main route while driving.
- It only performs local avoidance when another shuttle is actually near enough to conflict.
- Local avoidance should be short: side/pocket move, wait briefly if needed, then return to the planned route.
- Avoidance must not become a hidden long-horizon reservation system.
- Do not reintroduce old global reservation/wall/deadlock logic under a new name.

Important design rule from the user:

```text
不要提前很远避让。等真正快相遇或目标节点近场冲突时再处理。
空车优先让满车。
满车 vs 满车时低优先级车让，但要尽量用最近合法 pocket，不要长距离后退。
如果旁边/附近有合法空位，就近让，不要一路退回 lift。
```

## Current Layout Context

The latest layout direction is top-lift / column-fill style:

- All lifts are at the top.
- Each lift has an outbound side and inbound side.
- Inbound source buffers should stay full when source supply is active.
- Current MVP inbound is column-oriented rather than the older row-oriented layout.
- Storage cells are not arbitrary 2D free space. In the current graph, many legal moves are along storage columns and lift-column access nodes. Do not assume every adjacent visual cell has an edge.
- Before adding outbound, preserve inbound correctness and deterministic testability.

## What Was Fixed In Commit 29ffb3a

Files touched:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `scripts/audit-shuttle-behavior.ts`
- `scripts/audit-shuttle-replay-determinism.ts`
- `docs/inbound-mvp-baseline-test-rules.md`
- `package.json`

Implemented:

- Added short local-route node claim handling.
- If a shuttle has a temporary local route, other vehicles treat that route's remaining nodes as a short-lived claim.
- Reusing an active local route now checks that the remaining local route nodes are not occupied or claimed.
- Loaded storage swap clearance plans are filtered by full local-route node clear checks before install.
- Empty vehicles can no longer use their own future inbound dropoff as a temporary storage pocket.
- A loaded vehicle may enter its own active inbound dropoff cell.
- Behavior audit now checks local routes for occupied/claimed nodes.
- Added replay determinism audit script:

```bash
corepack pnpm shuttle:audit:replay -- --duration 1200 --split 600 --dt 0.25
```

## Verification Already Done On Windows

Passed:

```bash
corepack pnpm run typecheck
corepack pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts
corepack pnpm shuttle:audit:behavior -- --duration 600 --dt 0.25 --sample 5
corepack pnpm shuttle:audit:behavior -- --duration 1200 --dt 0.25 --sample 5
corepack pnpm shuttle:audit:replay -- --duration 1200 --split 600 --dt 0.25
```

Key results:

- Core tests: 133/133 passed.
- 600s behavior audit:
  - completedInbound: 77
  - inboundPph: 462
  - deadlocks: 0
  - livelocks: 0
  - physicalViolations: 0
  - anomalies: none
- 1200s behavior audit:
  - completedInbound: 143
  - inboundPph: 429
  - deadlocks: 0
  - livelocks: 0
  - physicalViolations: 0
  - anomalies: none
- 1200s replay determinism:
  - pass: true
  - direct and snapshot/restore `eventLogHash` match
  - direct and snapshot/restore `stateHash` match
  - completedInbound: 143 both ways
  - deadlocks/livelocks/physicalViolations: 0 both ways

## Known Remaining Problems

Do not claim final IE validation yet.

The 1800s behavior audit was not fully green:

```bash
corepack pnpm shuttle:audit:behavior -- --duration 1800 --dt 0.25 --sample 5
```

Observed 1800s result after current fixes:

- completedInbound: 207
- inboundPph: 414
- deadlocks: 1
- livelocks: 0
- physicalViolations: 0
- final run did not hard-deadlock
- trafficHoldVehicles at final: 0
- anomalyCounts included:
  - `local-route-node-claimed`: 2
  - `deadlock-count`: 48 repeated reports of the same cumulative count

Important nuance:

- The `deadlockCount=1` appears to be a recovered smoke-detector event, not a final stuck state.
- But it should still be investigated because the user wants DES-quality reproducibility and clean behavior.
- The two `local-route-node-claimed` cases appear around:
  - ~1245s: SH-08 temporary yield route through `module-02-spine-middle` while SH-07 is also traversing/claiming that module spine.
  - ~1620s: SH-08 local route `column-top-b-c18 > column-top-b-c17` while SH-03 wants/claims `column-top-b-c17`.

Likely next debugging targets:

- Local-route audit may need to distinguish:
  - true competing claim that will cause collision/deadlock
  - blocker/winner waiting because the local yielder is already clearing the path
  - moving vehicle already committed through the same edge with physical separation
- Avoid turning this into far-ahead route reservation. Fix only local, near-field claim semantics.
- Investigate whether conflict sessions are stale or whether the smoke detector is counting recovered cycles as permanent deadlocks.
- If adding a breaker, make it a near-field/top-column queue breaker, not a long global controller.

## Commands For Mac Mini Smoke Verification

Run these after checkout:

```bash
corepack pnpm run typecheck
corepack pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts
corepack pnpm shuttle:audit:behavior -- --duration 600 --dt 0.25 --sample 5
corepack pnpm shuttle:audit:behavior -- --duration 1200 --dt 0.25 --sample 5
corepack pnpm shuttle:audit:replay -- --duration 1200 --split 600 --dt 0.25
```

Optional diagnostic command:

```bash
corepack pnpm shuttle:audit:behavior -- --duration 1800 --dt 0.25 --sample 5
```

Expected current state:

- 600s and 1200s should pass cleanly.
- 1800s may still show the known recovered smoke deadlock / local-route diagnostic cases above.

## Start The Demo

Use two terminals:

```bash
corepack pnpm dev:api
```

```bash
corepack pnpm dev:dashboard
```

Open:

```text
http://localhost:5180
```

## Immediate Next Prompt For Codex On Mac Mini

```text
You are continuing the four-way-shuttle-sim project from branch codex/traffic-v2-flow-debug, commit 29ffb3a Harden inbound agent refresh audits.

First pull the latest code and run:

corepack pnpm run typecheck
corepack pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts
corepack pnpm shuttle:audit:behavior -- --duration 1200 --dt 0.25 --sample 5
corepack pnpm shuttle:audit:replay -- --duration 1200 --split 600 --dt 0.25

Context:
- Current control mode is agent-refresh.
- Keep the model as individual shuttle agents with one stable planned route and short local near-field avoidance.
- Do not reintroduce long-horizon reservations, far-ahead pre-yielding, or a global brain that controls every route detail.
- Empty vehicles should yield to loaded vehicles.
- Loaded-vs-loaded conflicts should use the nearest legal local pocket or queue-clearing move.
- Avoidance must happen near conflict, not far in advance.
- Do not treat visually adjacent storage cells as connected unless the graph has an edge.

Current verified baseline:
- typecheck passes.
- core SimCore tests 133/133 pass.
- 600s behavior audit passes: 77 inbound, about 462 PPH, deadlocks/livelocks/physical/anomalies all 0.
- 1200s behavior audit passes: 143 inbound, about 429 PPH, deadlocks/livelocks/physical/anomalies all 0.
- 1200s replay determinism passes: direct and snapshot/restore hashes match.

Known unresolved issue:
- 1800s behavior audit is not fully green yet.
- It finishes without final hard-deadlock and physicalViolations=0, but reports 1 recovered smoke deadlock count and 2 local-route-node-claimed diagnostics.
- Investigate the 1800s cases around 1245s and 1620s without overfitting or reintroducing far-ahead reservation.
- Goal: make 1800s clean, then commit and push. After inbound is stable, start outbound planning.

Please continue from this state, preserve the user's design intent, and report PPH/utilization/deadlock/physical safety results after each version.
```
