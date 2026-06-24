# ChatGPT Pro Review Handoff - Four-Way Shuttle 3D Tick

Date: 2026-06-24

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Branch: `codex/traffic-v2-flow-debug`
- HEAD at handoff time: `d9bd1f36b736fbbd77dab94622fc39b6dde53b6d`
- Local workspace: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Note: the working tree has uncommitted local changes in the simulation core, audit/report scripts, and tests. If reviewing through GitHub only, ask for a fresh pushed commit or use the evidence paths below.

## User Goal

The customer-review target is a high-fidelity 3D tick simulation of a four-way shuttle system, not a simplified spreadsheet/DES-only model. The model must:

- Keep AMRs strictly on the yellow feasible-area graph.
- Use 8 shuttles by default.
- Enforce collision avoidance without vehicle overlap.
- Treat lifts/stations as FIFO queue resources with simple, understandable contracts.
- Produce stable 12h/24h results with hourly PPH and 10-minute per-AMR task-count trends.
- Detect and report long waits, stationary active windows, small-area loops, and AMR dropouts.

## Recent Baseline And Validation

### Focused tests after local fix

Command:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "bottom-a follower first|cross-spine|module boundary|empty middle access no-stop cycle|reciprocal empty no-stop faceoff|loaded inbound top-b spine|loaded middle access" --reporter=dot
```

Result: passed, 6 tests executed and 503 skipped.

Command:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

Result: passed.

### 6h gate after latest local fix

Command:

```bash
npx tsx scripts/run-physical-24h-amr-audit.ts --duration-sec 21600 --out output/review/physical-6h-after-bottom-a-follower-clearance-audit.json --checkpoint-dir output/review/physical-6h-after-bottom-a-follower-clearance-checkpoints --stop-on-critical
```

Result:

- Completed 21,600 simulated seconds.
- Total PPH: 482.167.
- Inbound PPH: 243.667.
- Outbound PPH: 238.5.
- Critical anomalies: 0.
- Physical violations: 0.
- Watch anomalies: 6.

The 6h run crossed the previous 18,210s failure point.

### 12h gate after same fix

Command:

```bash
npx tsx scripts/run-physical-24h-amr-audit.ts --duration-sec 43200 --out output/review/physical-12h-after-bottom-a-follower-clearance-audit.json --checkpoint-dir output/review/physical-12h-after-bottom-a-follower-clearance-checkpoints --stop-on-critical
```

Result:

- Stopped at 34,800 simulated seconds, i.e. 9h40m.
- Total PPH at stop: 476.172.
- Inbound PPH at stop: 239.379.
- Outbound PPH at stop: 236.793.
- Critical anomalies: 4.
- Physical violations: 0.

The first 8h stayed stable and did not reproduce the earlier three-AMR dropout. The failure emerged later around the bottom outbound lift queues.

## Current Failure Evidence

Primary files:

- `output/review/physical-12h-after-bottom-a-follower-clearance-audit.json`
- `output/review/physical-12h-after-bottom-a-follower-clearance-checkpoints/0041-34800s.json`
- `output/review/sim-run-rolling-log.html`
- `output/review/sim-run-rolling-log.json`

At 34,800s, critical AMR windows:

- `SH-04`: `stationary-active-window`, `long-wait-window`
  - Current node: `column-bottom-b-c03`
  - Target node: `column-bottom-b-c03`
  - Wait reason: `outbound-lift-fifo-wait`
  - Path in last 10m: 0m
  - Blocked in last 10m: 600s
  - Current wait: about 1,009s

- `SH-06`: `stationary-active-window`, `long-wait-window`
  - Current node: `column-bottom-b-c08`
  - Target node: `module-01-spine-bottom-b`
  - Wait reason: `outbound-lift-dock-protected`
  - Blocking vehicle: `SH-01`
  - Path in last 10m: 0m
  - Blocked in last 10m: 600s
  - Current wait: about 1,076s

Related warnings in the same 10-minute window:

- `SH-01`: zero completed tasks, `small-area-loop`, `node-ping-pong`, `zero-task-moving-window`
  - Path: 31.346m
  - Net displacement: 0.367m
  - BBox: 1.6m
  - Loopiness: 85.51

- `SH-05`: zero completed tasks, `small-area-loop`, `node-ping-pong`, `zero-task-moving-window`
  - Path: 31.255m
  - Net displacement: 0.472m
  - BBox: 1.6m
  - Loopiness: 66.194

Final active tasks include multiple outbound tasks targeting bottom outbound lift queue nodes:

- `task-4529`, `SH-01`, outbound, dropoff `column-bottom-b-c08`
- `task-4531`, `SH-04`, outbound, dropoff `column-bottom-b-c08`
- `task-4532`, `SH-05`, outbound, dropoff `column-bottom-b-c08`
- `task-4537`, queued outbound, wait reason `outbound-lift-queue-full`

Final wait/blocked symptoms:

- `outbound-lift-queue-full` accumulated 2,802s.
- `outbound-lift-fifo-wait` accumulated 2,660.421s.
- `outbound-lift-dock-protected` accumulated 2,170.367s.
- In the last partial hour, these outbound lift reasons became prominent while physical collision violations stayed at 0.

## Local Fix Just Tried

The previous 6h failure was a five-vehicle chain near `module-01-spine-middle`, where `SH-08` could not clear `module-01-spine-bottom-a` because local hold pockets were full and a follower blocked the escape side.

The local fix added a rule in `packages/shuttle-sim-core/src/index.ts`:

- If an empty bottom-a yielder cannot clear for middle-spine access because a follower is holding the escape side, first move that follower to a legal temporary hold route.
- Test added in `packages/shuttle-sim-core/src/index.test.ts` for the five-vehicle chain.

This fixed the 18,210s middle-spine failure and passed the 6h gate, but the 12h run exposed a different downstream outbound-lift queue contract failure.

## Working Hypothesis

This is probably a station/lift resource-contract issue rather than a single path-planning bug:

- Outbound lift approach queue, FIFO service, dock protection, and queue capacity are not owned by one coherent station coordinator.
- Vehicles can be physically near the outbound dock but logically prevented from progressing by FIFO/queue protection, while other vehicles continue to ping-pong in the same throat area.
- The model currently has better shadow diagnostics for station contracts than actual active enforcement.
- The system still allows local traffic conflict resolution to fight with station queue ordering.

## Review Questions

Please review the architecture and recommend a minimal system-level fix, not another local patch.

1. Is this primarily a station-owned resource contract problem rather than a generic pathfinding/collision bug?
2. For inbound and outbound lift queues, what should the single source of truth be for queue slots, service grants, dock approach occupancy, and physical route claims?
3. Should the lift station own queue admission and reserve routes before task assignment, instead of letting global task assignment push multiple AMRs toward the same dock?
4. How should FIFO be enforced so a vehicle waiting in a queue does not block unrelated vehicles or ping-pong near the dock?
5. How should the traffic resolver interact with station queues? For example, should station corridors have a deterministic lane/slot policy and no local side-yield inside the protected throat?
6. What validation gates should be required before a 24h customer-review run?
7. Which parts of the current code should be kept, and which patch layers should be stopped before they make the behavior harder to reason about?

## Proposed Next Step Before More Coding

Do not keep adding isolated deadlock breakers. Freeze this evidence and ask for an external review of a minimal station-owned coordinator design for outbound and inbound lift queues, then implement one narrow contract and rerun:

1. A short deterministic unit reproduction for the 34,800s outbound-lift queue failure.
2. A 1h smoke.
3. A 6h gate.
4. A 12h gate.
5. Only then a 24h run with hourly PPH and 10-minute per-AMR Plotly report.
