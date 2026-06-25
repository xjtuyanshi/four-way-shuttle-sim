# ChatGPT Pro Review Handoff - Round 14

## Project State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Base commit before this handoff: `a0e3193e7796a63e55c0af56d359c06489d81eb0`
- Working tree: dirty. Intentional tracked edits are in:
  - `packages/shuttle-schemas/src/index.ts`
  - `packages/shuttle-sim-core/src/index.ts`
  - `packages/shuttle-sim-core/src/index.test.ts`
  - `scripts/run-physical-24h-amr-audit.ts`
- Important untracked local evidence/docs already exist under `docs/chatgpt-pro-review-*` and `output/review/`.

## User Goal

The user needs the existing high-fidelity 3D tick four-way shuttle simulation to be stable, explainable, and credible for customer review. The user explicitly does not want a pure DES rewrite. The target architecture is a system-level resource contract on top of the 3D tick model:

- station-owned coordinator
- explicit separation of inbound demand, AMR queue reservation, physical slot occupancy / lease, and active service
- shadow-mode verification first
- source-of-truth cutover only after evidence
- validation by 10m / 30m / 24h A/B, hourly PPH, per-AMR 10-minute completed task counts, long-stuck and small-loop metrics, and 3D visual inspection

## Current Baseline Evidence

The latest accepted restore run after rejecting a bad active-visit experiment:

- `output/review/physical-10m-after-reject-active-visit-egress.json`
  - 10m completed
  - PPH: inbound 306, outbound 180, total 486
  - anomalies 0, critical anomalies 0
- `output/review/physical-30m-after-reject-active-visit-egress.json`
  - 30m completed
  - PPH: inbound 284, outbound 182, total 466
  - waiting 0, blocked 0 at 30m
  - anomalies 0, critical anomalies 0
- `output/review/physical-1h-after-reject-active-visit-egress.json`
  - 1h completed
  - PPH: inbound 260, outbound 199, total 459
  - physical violations 0
  - deadlocks 1
  - critical anomaly count 0, but station contract still reports a critical station wait-for cycle
  - final waiting vehicles:
    - `SH-02`: `module-02-spine-top-b -> module-02-spine-middle`, wait `no-stop-continuation-blocked`, blocker `SH-07`
    - `SH-07`: `column-middle-c21 -> module-02-spine-middle`, wait `no-stop-continuation-blocked`, blocker `SH-08`
    - `SH-08`: `module-02-spine-bottom-a -> module-02-spine-middle`, wait `no-stop-continuation-blocked`, blocker `SH-07`
    - `SH-06`: `column-bottom-a-c07 -> module-01-spine-bottom-a`, wait `node-target-near`, blocker `SH-04`
  - station violation:
    - `lift-02-outbound`: `SH-07(no-stop-continuation-blocked)->SH-08, SH-08(no-stop-continuation-blocked)->SH-07`

The rolling log was updated by these runs:

- `output/review/sim-run-rolling-log.json`
- `output/review/sim-run-rolling-log.html`

## Validations Run

Passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "empty bottom-a spine entrant for a loaded middle-access no-stop faceoff" --maxWorkers=1
pnpm -r --if-present typecheck
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --duration-sec 600 --out output/review/physical-10m-after-reject-active-visit-egress.json ...
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --duration-sec 1800 --out output/review/physical-30m-after-reject-active-visit-egress.json ...
```

Diagnostic 1h run completed but did not prove stability:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --duration-sec 3600 --out output/review/physical-1h-after-reject-active-visit-egress.json ...
```

## Already Attempted And Rejected

I tried to make an active outbound station visit own an upstream approach clear-through route and route foreign vehicles out of it. That was rejected based on short-window evidence.

Rejected run 1:

- `output/review/physical-10m-after-active-visit-egress.json`
- PPH collapsed to inbound 102, outbound 66, total 168
- early station cycle: `SH-07(storage-exit-precedence)->SH-08`, `SH-08(outbound-station-active-visit-approach-owned)->SH-07`

Rejected run 2:

- `output/review/physical-10m-after-active-visit-egress-rank-fix.json`
- PPH collapsed further to inbound 60, outbound 18, total 78
- many long waits caused by `outbound-station-active-visit-approach-owned`

Rejected run 3:

- `output/review/physical-10m-after-active-visit-throat-only.json`
- PPH still only inbound 54, outbound 36, total 90
- still produced station wait-for cycle and long waits

Conclusion from rejected attempts:

- Directly making active visit egress a source-of-truth movement rule is too strong in the current codebase.
- It over-protects resources and converts ordinary physical precedence conflicts into station ownership deadlocks.
- We should not continue patching this direction without a better abstraction.

## What Seems True Now

1. The remaining 1h failure is not physical collision. `physicalViolations = 0`.
2. The critical issue is still resource ownership / wait-for cycle around a no-stop module spine near `lift-02-outbound`.
3. Existing no-stop wait-cycle recovery has a focused unit test that passes, but in the full 1h run the same pattern remains at the end. That suggests invocation timing, route overwrite, internal reservation state, or broader wait graph composition differs from the isolated test.
4. A station-owned coordinator is still likely the right direction, but the ownership boundary must be narrower and staged. It should not own ordinary bottom-a storage exits or broad upstream approach lanes.

## Key Code Areas

- `packages/shuttle-sim-core/src/index.ts`
  - outbound station runtime/request/pass logic around `outboundStationRuntime`, `reconcileOutboundStationRuntime`, `chooseNextOutboundStationTransition`
  - no-stop wait-cycle recovery around `agentRefreshNoStopContinuationWaitCandidateVehicleIds`, `tryBreakAgentRefreshWaitCycle`, `tryYieldEmptyBottomASpineAwayFromNoStopCycle`
  - station kernel shadow diagnostics around `calculateShadowStationContractDiagnostics`
- `packages/shuttle-sim-core/src/index.test.ts`
  - focused no-stop / station tests around the `clears an empty bottom-a spine entrant for a loaded middle-access no-stop faceoff` case
- `scripts/run-physical-24h-amr-audit.ts`
  - rolling run log, hourly PPH, 10-minute AMR windows, anomaly capture

## Questions For ChatGPT Pro

Please review this as an external senior simulation / controls / TypeScript architecture reviewer:

1. Is the remaining problem best modeled as a station-owned resource contract, a no-stop corridor resource, a wait-for graph scheduler, or something else?
2. What is the smallest architecture change that would resolve the `SH-07` / `SH-08` module spine cycle without taking over broad approach lanes?
3. How should the system decide who owns a no-stop module spine segment when one loaded vehicle is trying to clear through to outbound dropoff and one empty vehicle is trying to pass upward to pickup?
4. Why might an isolated unit test for `tryBreakAgentRefreshWaitCycle` pass while the full 1h run still ends with the same wait-for cycle?
5. What should be instrumented next to prove whether the breaker is not invoked, returns false in real internal state, is overwritten by replanning, or is blocked by hidden reservations?
6. What code paths should be preserved, and which patching directions should be stopped?
7. What validation ladder would you require before we run 12h/24h again?
