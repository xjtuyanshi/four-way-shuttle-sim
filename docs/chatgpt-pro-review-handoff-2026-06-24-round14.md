# ChatGPT Pro Review Handoff - Round 14

Date: 2026-06-24

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Branch: `codex/traffic-v2-flow-debug`
- Base commit before this uncommitted working state: `c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0`
- Working tree has uncommitted code changes in:
  - `packages/shuttle-schemas/src/index.ts`
  - `packages/shuttle-sim-core/src/index.ts`
  - `packages/shuttle-sim-core/src/index.test.ts`
  - `scripts/run-physical-24h-amr-audit.ts`
- Evidence outputs:
  - `output/review/sim-run-rolling-log.html`
  - `output/review/sim-run-rolling-log.json`
  - `output/review/physical-30m-after-envelope-owner-precedence.json`
  - `output/review/physical-24h-after-envelope-owner-precedence-3d-smoke.json`
  - `output/review/physical-24h-after-envelope-owner-precedence-3d-smoke-checkpoints/0003-2400s.json`

## User Goal

The user needs a high-fidelity physical tick four-way shuttle simulation suitable for customer review. The system must:

- Keep all AMRs on the yellow feasible grid.
- Avoid physical overlap/collision and visual tunneling.
- Use simple, DES-like resource principles where shuttles are resources and lifts/stations own FIFO queues.
- Avoid long-term AMR dropouts, stuck shuttles, tiny-loop behavior, and back-and-forth scratching near lift points.
- Produce rolling evidence for every run: why it was rerun, what changed, PPH, hourly PPH, 10-minute per-AMR task matrix, and anomalies.

## Current Validation Status

### Passed Before Long-Run Gate

Targeted tests passed:

```bash
./node_modules/.bin/vitest run \
  packages/shuttle-sim-core/src/high-inbound.test.ts \
  packages/shuttle-sim-core/src/lift-approach.test.ts \
  packages/shuttle-sim-core/src/index.test.ts \
  -t "keeps a 12-shuttle high-inbound stress run active|uses configured lift approach staging capacity|keeps unready top-lift inbound work|outbound station|envelope-yielding candidate" \
  --maxWorkers=1
```

Result:

- 3 test files passed.
- 15 relevant tests passed.

30-minute headless gate passed:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 1800 \
  --audit-every-sec 10 \
  --ten-minute-sec 600 \
  --hourly-sec 3600 \
  --shuttles 8 \
  --regions 2 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --initial-fill-policy zone-balanced-50 \
  --storage-selection-policy sequential \
  --collision-avoidance on \
  --stop-on-critical \
  --out output/review/physical-30m-after-envelope-owner-precedence.json \
  --checkpoint-dir output/review/physical-30m-after-envelope-owner-precedence-checkpoints
```

Result:

- 10m: total PPH 450, inbound 306, outbound 144, anomalies 0.
- 20m: total PPH 465, inbound 321, outbound 144, anomalies 0.
- 30m: total PPH 454, inbound 328, outbound 126, anomalies 0.
- Final: `deadlocks=0`, `livelocks=0`, `physicalViolations=0`, `anomalies=0`.

Short 3D visual smoke passed, but only as a short-window visual sanity check:

- Dashboard: `http://localhost:5191/`
- API: `http://localhost:8791/`
- 3D view ran to about 7 minutes sim time.
- Screenshots showed no obvious visual overlap or shuttles leaving the yellow grid in that short window.
- API sample at sim time 453s:
  - physicalViolations 0
  - min separation 4.574m
  - waiting 0
  - blocked 0
  - total PPH 468.874

### Failed Long-Run Gate

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 86400 \
  --audit-every-sec 10 \
  --ten-minute-sec 600 \
  --hourly-sec 3600 \
  --shuttles 8 \
  --regions 2 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --initial-fill-policy zone-balanced-50 \
  --storage-selection-policy sequential \
  --collision-avoidance on \
  --stop-on-critical \
  --out output/review/physical-24h-after-envelope-owner-precedence-3d-smoke.json \
  --checkpoint-dir output/review/physical-24h-after-envelope-owner-precedence-3d-smoke-checkpoints \
  --change-note "24h gate after 30m envelope owner precedence and clean 3D smoke; track hourly PPH and 10m AMR task matrix"
```

Result:

- Stopped at sim time 2400s, i.e. 40 minutes.
- total PPH dropped to 387.
- inbound PPH 277.5.
- outbound PPH 109.5.
- anomalies 7.
- critical anomalies 6.
- physicalViolations 0.
- shadow ledger violations in the 10m sample: 0.

10-minute task matrix:

| Window | Sim sec | Total tasks | Inbound tasks | Outbound tasks | Critical vehicles |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 0-600 | 75 | 51 | 24 | none |
| 2 | 600-1200 | 80 | 56 | 24 | none |
| 3 | 1200-1800 | 72 | 57 | 15 | none |
| 4 | 1800-2400 | 31 | 21 | 10 | SH-01, SH-02, SH-07 |

Critical AMR facts in window 4:

| AMR | Tasks | Path | Blocked | End node | Target | Wait reason | Blocker | Risk |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| SH-01 | 0 | 0m | 600s | `column-bottom-a-c18` | `column-bottom-b-c18` | `outbound-lift-dock-protected` | SH-02 | stationary + long wait |
| SH-02 | 0 | 0m | 600s | `column-bottom-a-c17` | `column-bottom-a-c18` | `node-occupied` | SH-01 | stationary + long wait |
| SH-07 | 0 | 0m | 600s | `column-bottom-a-c19` | `column-bottom-a-c18` | `node-occupied` | SH-01 | stationary + long wait |

Checkpoint `0003-2400s.json` details:

- SH-01:
  - empty, task `task-0236`, inbound assigned
  - current `column-bottom-a-c18`
  - target `column-bottom-b-c18`
  - planned goal `column-bottom-b-c18`
  - wait `outbound-lift-dock-protected`
  - blocker SH-02
- SH-02:
  - loaded, task `task-0201`, outbound in-progress
  - current `column-bottom-a-c17`
  - target `column-bottom-a-c18`
  - planned goal `column-bottom-a-c21`
  - wait `node-occupied`
  - blocker SH-01
- SH-07:
  - loaded, task `task-0230`, inbound in-progress
  - current `column-bottom-a-c19`
  - target `column-bottom-a-c18`
  - planned goal `storage-r14-c18`
  - wait `node-occupied`
  - blocker SH-01

Interpretation:

This appears to be a station/dock corridor resource contract failure, not a single shortest-path bug. The outbound dock protected layer blocks SH-01 because SH-02 owns/needs the dock lane, while ordinary node occupancy blocks SH-02 and SH-07 behind SH-01. It creates a stable 3-vehicle knot on `column-bottom-a-c17/c18/c19`.

## Recent Fixes Before This Failure

These were already attempted before the 40m failure:

- Non-top inbound source buffer now honors configured `sourceBufferCapacity` instead of hardcoded capacity 1.
- Added non-top inbound admission load that counts only work still consuming lift approach/source slots.
- Added outbound station active envelope forward clearing so a tasked foreign vehicle already in the envelope can clear forward into the service node when that is the only way to unblock the station owner.
- Added envelope owner precedence so an envelope-yielding candidate does not block the current outbound station owner at the dock-corridor layer.

These fixes solved earlier 10m and 30m failures but did not solve the 40m bottom-a knot.

## Questions For ChatGPT Pro

Please review this as a system architecture/resource contract issue.

1. Is this now evidence that the current patch-by-patch station/dock/lane arbitration is fundamentally too fragmented?
2. What is the smallest viable refactor to express station, queue, throat, and service-node ownership as one consistent resource contract?
3. How should the bottom-a outbound dock queue behave under mixed inbound/outbound traffic when:
   - an outbound loaded vehicle needs to pass through `column-bottom-a-c18`,
   - an inbound assigned empty vehicle is staged around `column-bottom-a-c18`,
   - another loaded inbound vehicle also targets/passes the same node?
4. Should there be a single station kernel that grants movement leases for `approach -> service -> clear-through`, instead of separate ad hoc checks like `outbound-lift-dock-protected`, `node-occupied`, and envelope-owned exceptions?
5. What invariant should tests enforce to prevent this class of three-vehicle stable knot?
6. What should the next validation ladder be? Current proposal:
   - reproduce 2400s exactly,
   - add a minimal unit/regression test for SH-01/SH-02/SH-07,
   - make one architecture-level fix,
   - rerun 40m, 2h, 6h, 24h with rolling log,
   - require per-10m AMR task matrix to show no active AMR has 0 tasks and 0m path with 600s blocked unless truly idle/no demand.

Please avoid suggesting a full rewrite unless strictly necessary. The user needs a practical path that preserves the existing dashboard and physical tick simulation but makes traffic arbitration correct and easier to reason about.
