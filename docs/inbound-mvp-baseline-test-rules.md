# Inbound MVP Baseline Test Rules

This note is the working checklist for the current inbound MVP baseline before outbound work.

Baseline branch:

- `codex/traffic-v2-flow-debug`

Baseline commits:

- `902cd47 Harden inbound agent refresh baseline`
- `dcb3e12 Address inbound agent refresh review blockers`

Latest ChatGPT Pro conclusion for `dcb3e12`:

- `agent-refresh` is acceptable as the inbound MVP baseline for outbound planning.
- No new PBLOCKER/P0 blocks the inbound baseline.
- Remaining items are P1 hardening: snapshot/restore replay determinism, route-internal occupied/claimed invariant, and tighter own-dropoff pocket semantics.

## Why This Note Exists

We should not patch one visual oddity at a time and call the model correct.

Every traffic change should be checked against global DES and AGV-style invariants:

- source/load generation is deterministic and not tied to vehicle WIP artifacts;
- task assignment creates exactly one active owner for each load;
- route plans are physically adjacent graph paths;
- stored pallets are static obstacles for load placement and cannot be crossed by a loaded shuttle;
- dynamic shuttle avoidance is local and near-field;
- local avoidance routes are short, intentional, and cleared after the conflict;
- a fixed seed plus fixed command sequence can be replayed.

## Required Commands Before A Baseline Commit

Run these before calling a version stable:

```powershell
corepack pnpm run typecheck
corepack pnpm test -- --runInBand
corepack pnpm shuttle:audit:behavior -- --duration 1800 --dt 0.25 --sample 5
corepack pnpm shuttle:audit:replay -- --duration 1800 --split 600 --dt 0.25
```

Expected for the inbound MVP baseline:

- tests pass;
- `deadlocks=0`;
- `livelocks=0`;
- `physicalViolations=0`;
- `anomalyCounts={}`;
- `inboundPph > 0`;
- no route horizon / clear-through legacy leakage in `agent-refresh`.

For quick iteration after a local avoidance patch:

```powershell
corepack pnpm test:shuttle -- packages/shuttle-sim-core/src/index.test.ts -t "agent-refresh|source buffer|same-column|stored load|dropoff"
corepack pnpm shuttle:audit:behavior -- --duration 600 --dt 0.25 --sample 5
```

Do not treat the 600s audit as a final pass. It is only a fast smoke.

## Core Invariants To Keep

### DES / Replay

- Simulation time advances by fixed ticks, not wall clock.
- Same scenario JSON, seed, command history, and tick length must produce the same event/state hash.
- Dashboard playback speed must not change SimCore truth.
- A live abnormality must be reproducible from a saved snapshot plus command/event log.

Implemented hardening:

- Run A: `0 -> 1800s`.
- Run B: `0 -> 600s`, snapshot/restore, then `600 -> 1800s`.
- Assert equal `eventLogHash`, `stateHash`, completed inbound count, deadlocks, livelocks, and physical violations.
- Command: `corepack pnpm shuttle:audit:replay -- --duration 1800 --split 600 --dt 0.25`.

### Source / Lift Buffer

- Inbound source is a DES source, not a side effect of task creation.
- Each inbound lift should maintain up to `sourceBufferCapacity` waiting loads while storage is not full.
- A source load may have at most one active inbound task.
- Underfilled source buffers before storage is full are a critical audit failure.
- Overfilled source buffers are a critical audit failure.

Future outbound note:

- Keep inbound source pressure and outbound demand pressure separate in diagnostics. Do not collapse them into one ambiguous "source" metric.

### Task Ownership

- A vehicle with an active task must have a visible planned route unless it is already at its expected goal or in a lift phase.
- A loaded vehicle must have exactly one carried load.
- An empty vehicle must not carry a load.
- A load cannot be assigned to multiple active tasks.
- Task `vehicleId` and vehicle `taskId` must agree.

### Route Shape

For every generated path:

- every adjacent pair in `routeNodeIds` must have a real graph edge;
- every adjacent pair in `plannedRouteNodeIds` must have a real graph edge;
- every adjacent pair in `localRouteNodeIds` must have a real graph edge;
- no diagonal visual line may represent a real movement path;
- no planned route should repeatedly update unless the task changes;
- local routes should only appear during avoidance or explicit clearance.

Implemented hardening:

- A permanent route-internal invariant that every `localRouteNodeIds.slice(1)` node is not occupied or claimed by another vehicle, including top-lift `column-*` access nodes.

### Static Storage Rules

- Stored load cells are static obstacles for loaded dropoff placement.
- A loaded shuttle must not pass through an already stored load while carrying another load to dropoff.
- FIFO contiguous fill must be preserved.
- A row/column target allocation must not assign the same dropoff to two active inbound tasks.
- Temporary storage pockets must reject:
  - other vehicle current occupancy;
  - other vehicle claims;
  - stored loads;
  - another active inbound dropoff.

Implemented hardening:

- Only a loaded vehicle should be allowed to enter its own active inbound dropoff cell. Empty vehicles should not use their future dropoff as a temporary pocket.

### Dynamic Avoidance

Default principle:

- Do not solve dynamic conflicts far ahead.
- Drive the planned shortest route until near-field conflict.
- Resolve the conflict with a short local action.
- Return to the planned route.

Priority:

- loaded over empty;
- earlier task/load over later;
- smaller shuttle id as deterministic final tiebreaker.

Yield strategy:

1. Side-yield to the nearest legal storage/pocket or column access.
2. Wait only while the immediate next move is blocked.
3. Return to the nearest viable future planned waypoint.
4. Use reverse only when no side-yield or access escape exists.

Special loaded same-column swap:

- If two loaded shuttles face each other in the same storage column and no side pocket is legal, a `loaded-storage-swap-clearance` route may move one shuttle to the nearest legal column access.
- Current limit: up to 6 nodes.
- This is allowed because it is a hard same-column reciprocal conflict, not ordinary local yielding.
- It must not become a general long-retreat mechanism.

### Visual / Dashboard

- 2D and 3D must use the same coordinate orientation.
- All shuttles should show stable planned routes.
- Local avoidance routes should be visually distinct and short.
- Shuttle labels must stay visible.
- KPI wording must distinguish requested total PPH from inbound source pressure.
- Dashboard is a subscriber only; it must not drive scheduling or traffic logic.

## Pro Review Workflow

Every important traffic/control baseline should get an external ChatGPT Pro review after local tests pass.

Review packet should include:

- branch URL;
- commit URL;
- summary of changed control logic;
- explicit list of invariants protected by the patch;
- exact test commands and results;
- known P1 residuals;
- direct question: "Can this be accepted as baseline, or is there any PBLOCKER/P0?"

Use this template:

```text
Please review the latest GitHub code for the shuttle simulator.

Branch:
<branch URL>

Commit:
<commit URL>

Goal:
Decide whether this version can be accepted as the inbound MVP baseline before outbound work.

Scope:
- SimCore traffic/control logic.
- DES source/task semantics.
- Route and avoidance invariants.
- Static storage/load collision rules.
- Dynamic shuttle conflict behavior.
- Do not review Unreal or final industrial throughput claims.

Changed logic:
<short bullet list of actual code changes>

Local verification:
- corepack pnpm run typecheck: <PASS/FAIL>
- corepack pnpm test -- --runInBand: <PASS/FAIL and counts>
- corepack pnpm shuttle:audit:behavior -- --duration 1800 --dt 0.25 --sample 5:
  <summary JSON or key metrics>

Known residual P1s:
<list>

Please output:
1. Go/no-go for inbound MVP baseline.
2. PBLOCKER/P0/P1 findings.
3. Whether any logic looks like a one-off patch instead of a globally valid rule.
4. Tests or audit invariants that must be added before the next baseline commit.
```

## Mac Mini Handoff Prompt

Use this when opening a fresh Codex window on the Mac mini:

```text
We are continuing the four-way shuttle simulator work.

Repo: four-way-shuttle-sim
Branch: codex/traffic-v2-flow-debug
Important baseline commits:
- 902cd47 Harden inbound agent refresh baseline
- dcb3e12 Address inbound agent refresh review blockers

Current accepted state:
- ChatGPT Pro approved dcb3e12 as inbound MVP baseline for outbound planning.
- 1800s audit passed: deadlocks=0, livelocks=0, physicalViolations=0, anomalyCounts={}, inboundPph=400, totalPph=400.
- agent-refresh is the demo baseline.

Do not restart from old traffic-v2/long-horizon reservation logic.
Do not expand old agent-minimal.
Keep inbound source/lift buffer semantics: each inbound lift has sourceBufferCapacity waiting loads while storage is not full, and one source load can have only one active task.

Before making outbound changes, read:
- docs/inbound-mvp-baseline-test-rules.md
- docs/agent-refresh-des-repro-pro-review.md
- README.md

Current P1 hardening to keep in mind:
- add snapshot/restore determinism test;
- add route-internal occupied/claimed invariant for local routes, including column access nodes;
- tighten own-dropoff temporary pocket so only loaded vehicle can enter its own active inbound dropoff cell.

Next phase:
Start outbound planning against the new top-lift layout. First explain assumptions, then implement in small commits with tests and Pro review after logic changes.
```
