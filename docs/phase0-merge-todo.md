# Phase 0 Merge TODO

Scope: continue the `codex/p1-p5-physics-traffic-3d` branch toward merge without adding product features or redesigning architecture.

## Current Branch State

- Repository is public: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Review branch: `codex/p1-p5-physics-traffic-3d`
- Base branch: `main`
- External review verdict addressed so far: merge after fixes
- Unreal runtime validation remains blocked until Unreal Engine 5.7.4 and full Xcode are installed

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

## Merge-Blocking TODO

- Keep `currentNodeOccupancy` and reservation coverage as the authoritative traffic-control invariant.
- Keep one parking node per vehicle for Phase 0 reset ownership.
- Keep Phase 0 reservation capacities fixed at `1`; defer multi-capacity counting to Phase 1.
- Keep validation-owned cumulative aggregation for physical/reservation violations.
- Keep Unreal and Pixel Streaming runtime validation marked blocked on machines without required tools.
- Do not merge if any of `pnpm typecheck`, `pnpm test`, `pnpm build`, or `pnpm shuttle:validate` fails.

## Ready-For-Review TODO

- Give ChatGPT Pro `docs/chatgpt-pro-review-packet.md`.
- Ask it to review the latest pushed branch head.
- Use `docs/review-hardening-report.md` as the requirement-to-fix map.
- Treat any new must-fix finding as another merge-hardening pass, not as Phase 1 feature work.

## Phase 1 TODO

- Capacity-aware reservations for edges, nodes, and zones.
- Stronger wait-for graph and livelock analysis.
- Real Unreal Engine compile and runtime smoke after installing prerequisites.
- Pixel Streaming 30-minute 1080p single-user validation.
