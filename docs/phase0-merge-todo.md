# Phase 0 Merge TODO

Scope: keep the current public `main` merge-ready without adding product features or redesigning architecture.

## Current Branch State

- Repository is public: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Review branch: `main`
- Base branch: `main`
- Latest external review verdict: `merge now`
- Unreal Engine 5.7.4 and full Xcode are installed; bridge compile/headless smoke, live bridge smoke, staged Mac runtime generation, and browser Pixel Streaming smokes passed

## Autonomous Five-Round Pass

1. Confirm public repo, review packet, and hardening report are ready for ChatGPT Pro review.
2. Re-audit traffic-control, validation, and Unreal bridge code for merge-blocking gaps.
3. Apply only minimal tests or documentation needed for issues found in the audit.
4. Re-run full local verification and browser smoke evidence.
5. Push the branch and leave a concise merge/review handoff.

## Five-Round Result

- Round 1: public repo and review branch confirmed.
- Round 2: found one Phase 0 reset invariant gap and one multi-zone reservation coverage gap.
- Round 3: added schema/test hardening for parking-node ownership and all matching zone reservations.
- Round 4: full local verification and browser smoke passed.
- Round 5: latest branch handoff is ready for external review.

## ChatGPT Pro Follow-Up Pass

- The review packet was submitted to ChatGPT Pro against the public branch.
- ChatGPT Pro stalled on network access but returned two actionable follow-ups before stopping.
- Fixed dashboard handling for incremental `vehicleState` and `kpiUpdate` WebSocket messages.
- Added schema/test coverage to reject duplicate node ids, including duplicate parking node ids.
- Re-ran full local verification and browser smoke after these fixes.

## Latest External Review Result

- The latest ChatGPT Pro review was run against the current public `main` branch and returned `Merge now`.
- Local fixes now address the review's must-fix items: rectangular footprint safety validation, long-run queue/lift acceptance, FIFO storage schema contract, queued-slot physical obstacle handling, playback speed validation, UE readiness wording, and lift-port diagnostic wording.
- Result after local verification: no verified must-fix findings remain locally.
- Verdict before final merge: merge-ready for the stated Phase 0 claims.
- Unreal bridge compile/headless smoke, live bridge smoke, staged Mac runtime generation, and local browser Pixel Streaming smokes are verified on this machine. The 30-minute soak and release hardening remain Phase 1 work after the calibrated visual scene is ready.

## Merge-Blocking TODO

- Keep `currentNodeOccupancy` and reservation coverage as the authoritative traffic-control invariant.
- Keep one parking node per vehicle for Phase 0 reset ownership.
- Keep duplicate node ids rejected before reset occupancy is initialized.
- Keep dashboard stream reducers covered by tests so incremental `vehicleState` / `kpiUpdate` messages refresh the UI.
- Keep Phase 0 reservation capacities fixed at `1`; defer multi-capacity counting to Phase 1.
- Keep validation-owned cumulative aggregation for physical/reservation violations.
- Keep rectangular vehicle footprint clearance as the safety acceptance check; `minVehicleSeparationM` is diagnostic only.
- Keep the 600-second long-run validation gate green for queue, waiting vehicle, lift-port queue, deadlock, physical safety, and reservation coverage flags.
- Keep FIFO storage ids on the `storage-rNN-cNN` contract until explicit row/column metadata is added.
- Keep Unreal and Pixel Streaming runtime validation gated by installed UE/Xcode tools and by whether the calibrated scene is ready for a longer soak.
- Do not merge if any of `pnpm typecheck`, `pnpm test`, `pnpm build`, or `pnpm shuttle:validate` fails.

## Ready-For-Review TODO

- Give ChatGPT Pro `docs/chatgpt-pro-review-packet.md`.
- Ask it to review the latest pushed branch head.
- Use `docs/review-hardening-report.md` as the requirement-to-fix map.
- Treat any new must-fix finding as another merge-hardening pass, not as Phase 1 feature work.

## Phase 1 TODO

- Capacity-aware reservations for edges, nodes, and zones.
- Stronger wait-for graph and livelock analysis.
- Positive-control validator fixtures that intentionally trigger each reservation/physical violation code.
- Additional dashboard stream reducer coverage for out-of-order partial updates, reconnect replacement, and vehicle disappearance semantics.
- Zero-distance or same-node traffic transition coverage if future route generation can produce current node equal to target node.
- Calibrated Unreal visual scene assembly from CAD/vendor/site dimensions.
- Pixel Streaming 30-minute 1080p single-user soak after the calibrated scene is reviewed.
