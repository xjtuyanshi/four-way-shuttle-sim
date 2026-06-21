# Mac mini remote continuation handoff - 2026-06-20

This file is for continuing the current Codex work on the synced `Old Mac` / Mac mini.

## Current limitation

Codex Desktop currently exposed `handoff_thread`, but the tool is limited to moving another thread between checkout/worktree on the current host. It cannot move the calling thread, and it does not support cloud/remote host handoff. So this thread cannot be directly streamed to the Mac mini from this host.

Remote shell access was also not available from this Mac:

- `~/.ssh/config` only has `github.com`.
- Syncthing device `Old Mac` is connected, but via relay.
- SSH port 22 to the discovered `Old Mac` public addresses timed out.
- `Old-Mac.local` was not resolvable from the current network.

Practical continuation path:

1. Let Syncthing sync this project folder to the Mac mini.
2. Open Codex on the Mac mini and attach/open:
   `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
3. Continue from this handoff file and the current branch `codex/traffic-v2-flow-debug`.

## Current project state

Branch:

```bash
git branch --show-current
# codex/traffic-v2-flow-debug
```

The last pushed commit on GitHub at the time of this note was:

```text
c1153d8 Stabilize long-window AMR flow audit
```

There are local uncommitted changes. Do not reset them. They include earlier shadow-ledger/audit work plus the latest no-stop spine faceoff fix.

## Latest fix made before pausing

Problem reproduced:

- At the 4020s audit checkpoint, loaded inbound `SH-05` waited at `module-02-spine-top-b`.
- Empty outbound `SH-08` waited at `module-02-spine-bottom-a`.
- Both targeted `module-02-spine-middle`.
- This created a no-stop spine faceoff where each vehicle blocked the other's continuation.

Fix direction:

- Keep this as a system-level no-stop spine workcell/yield issue, not a vehicle-specific patch.
- Allow an empty task vehicle already blocked at `bottom-a -> middle` to temporarily yield into a legal storage hold, but only under narrow no-stop faceoff conditions.
- Preserve the rule that the final temporary hold cannot be a `noStop` or `noParking` node.

Files touched in this latest step:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`

New/regression tests that passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "clears an empty bottom-a spine entrant|moves an empty inbound successor out of a loaded predecessor vertical spine claim" --reporter dot
```

Broader related test slice that passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "clears an empty bottom-a spine entrant|no-stop|top-lift spine|vertical spine|side-yield|temporary-yield|column with active outbound ownership|column with active inbound ownership" --reporter dot
```

Result:

```text
42 passed | 416 skipped
```

One existing test assertion was narrowed:

- Test name: `allows same-direction top-lift spine following when the leading shuttle has enough headway`
- Old assertion expected all `traffic.waitingVehicles` to be empty.
- That was too broad because unrelated inbound FIFO/column waiting can exist while the tested follower is healthy.
- New assertion only checks that the tested loaded follower itself is not waiting and there are no physical violations.

## Next commands to run on Mac mini

Run from:

```bash
cd "/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0"
```

First validate TypeScript:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

Then run a short stop-on-critical audit before any 12h/24h run:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --hours 2 \
  --audit-every-sec 30 \
  --out output/review/physical-2h-after-bottom-a-spine-yield-audit.json \
  --checkpoint-dir output/review/physical-2h-after-bottom-a-spine-yield-checkpoints \
  --stop-on-critical
```

Stop rule:

- If this fails before or around the previous 4020s failure point, do not keep patching blindly.
- Capture the checkpoint and compare against:
  `output/review/physical-2h-after-column-mode-mutex-checkpoints/0002-4020s.json`
- If it fails with a new class of deadlock, summarize it for external review before continuing.

If the 2h audit passes, then run 6h or 12h, not 24h immediately:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --hours 6 \
  --audit-every-sec 60 \
  --out output/review/physical-6h-after-bottom-a-spine-yield-audit.json \
  --checkpoint-dir output/review/physical-6h-after-bottom-a-spine-yield-checkpoints \
  --stop-on-critical
```

## User intent to preserve

The user wants root-cause system fixes, not endless local special cases. If the next few rounds still fail, stop and report the exact state rather than continuing to patch blindly.

Core expectations:

- Vehicles must stay on the yellow feasible grid.
- No shuttle overlap /穿模.
- No repeated local rubbing around lift/spine nodes.
- Empty vehicles should move away from high-traffic lift/spine areas when yielding.
- Long audits must include PPH, relocation ratio, AMR 10-minute task-completion series, and long-stationary/looping metrics.
