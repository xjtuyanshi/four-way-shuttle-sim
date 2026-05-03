# Phase 0 Merge TODO

Scope: continue the `codex/phase1-validation-traffic-demo` branch toward merge without adding product features or redesigning architecture.

## Current Branch State

- Repository is public: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Review branch: `codex/phase1-validation-traffic-demo`
- Base branch: `main`
- External review verdict addressed so far: merge after fixes
- Unreal Engine 5.7.4 and full Xcode are installed; bridge compile/headless smoke passed

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

## Final External Review Result

- Final ChatGPT Pro review was run against head `28d6aeb112440998e8d6a603ab35065b73ccde52`.
- The full GitHub-access review stalled on remote access/truncation, so a second no-network merge-blocker review was run from the final packet.
- Result: no verified must-fix findings before merge.
- Verdict: merge now.
- Unreal bridge compile/headless smoke is verified on this machine. Packaged Pixel Streaming soak remains pending until the real visual scene exists.

## Merge-Blocking TODO

- Keep `currentNodeOccupancy` and reservation coverage as the authoritative traffic-control invariant.
- Keep one parking node per vehicle for Phase 0 reset ownership.
- Keep duplicate node ids rejected before reset occupancy is initialized.
- Keep dashboard stream reducers covered by tests so incremental `vehicleState` / `kpiUpdate` messages refresh the UI.
- Keep Phase 0 reservation capacities fixed at `1`; defer multi-capacity counting to Phase 1.
- Keep validation-owned cumulative aggregation for physical/reservation violations.
- Keep Unreal and Pixel Streaming runtime validation gated by installed UE/Xcode tools and by whether a real UE scene exists.
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
- Real Unreal visual scene assembly and actor binding.
- Pixel Streaming 30-minute 1080p single-user validation after the real scene exists.
