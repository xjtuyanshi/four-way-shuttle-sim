# Four-Way Shuttle Sim

High-fidelity four-way shuttle simulation prototype.

Phase 0 separates deterministic simulation truth from Unreal rendering:

- `packages/shuttle-sim-core`: authoritative SimCore / WCS-lite state, task generation, routing, reservations, event logs, and KPI snapshots.
- `packages/shuttle-schemas`: shared protocol and scenario schemas.
- `apps/shuttle-api`: HTTP/WebSocket command and stream API.
- `apps/shuttle-dashboard`: React dashboard with parameters, KPI, event log, traffic diagnostics, and a local Three.js 3D SimCore preview.
- `unreal-bridge`: source-only Unreal Engine plugin scaffold for visual twin subscription.

## Local Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm shuttle:prereq
pnpm shuttle:validate
pnpm dev:api
pnpm dev:dashboard
```

Default local URLs:

- API: `http://localhost:8791/api/shuttle/health`
- WebSocket: `ws://localhost:8791/shuttle-ws`
- Dashboard: `http://localhost:5179`

## Customer Review Pack

Use the review pack command when rebuilding the Monday customer-review artifacts from the current SimCore/DES implementation:

```bash
pnpm run shuttle:review-pack
```

This command regenerates:

- `output/review/shuttle-des-review-24h-vv.html`
- `output/review/shuttle-des-review-7d-vv.html`
- `output/review/data/des-period-pph-24h.csv`
- `output/review/data/des-period-pph-7d.csv`
- `output/review/data/des-traffic-bottlenecks-24h.csv`
- `output/review/data/des-traffic-bottlenecks-7d.csv`
- `output/review/data/des-reservation-replay-tasks-24h.csv`
- `output/review/data/des-reservation-replay-tasks-7d.csv`
- `output/review/data/des-reservation-replay-tasks.json`
- `output/review/data/review-issue-register.csv`
- `output/review/data/review-issue-register.json`
- `output/review/data/ie-action-plan.csv`
- `output/review/data/ie-action-plan.json`
- `output/review/ie-action-plan.html`
- `output/review/live-demo-runbook.html`
- `output/review/live-demo-runbook.json`
- `output/review/goal-acceptance-audit.html`
- `output/review/goal-acceptance-audit.json`
- `output/review/goal-completion-audit.html`
- `output/review/goal-completion-audit.json`
- `output/review/trend-explorer.html`
- `output/review/trend-explorer.json`
- `output/review/des-avoidance-explainer.html`
- `output/review/des-avoidance-explainer.json`
- `output/review/site-validation-protocol.html`
- `output/review/site-validation-protocol.json`
- `output/review/site-validation-readiness.html`
- `output/review/site-validation-readiness.json`
- `output/review/data/metric-lineage.csv`
- `output/review/data/metric-lineage.json`
- `output/review/metric-lineage.html`
- `output/review/site-calibration-gap.html`
- `output/review/index.html`

It also gates the dashboard review surface with `pnpm run shuttle:dashboard-evidence-verify`, which checks that the React dashboard still contains the answer-first summary, DES period PPH, data-integrity, readiness, IE findings, and reservation-replay bottleneck panels, plus the saved screenshot evidence used by the review reports.

The review hub includes a Goal evidence matrix that maps the original review asks to the current evidence: inbound/outbound/total PPH, hourly PPH markers, Window PPH and Waiting Share definitions, data-integrity checks, DES reservation avoidance, physical liveness, live 3D evidence, and the remaining customer site-data boundary.

The CSV exports are the raw review data behind the charts: period PPH is recomputed from adjacent cumulative samples, traffic-bottleneck CSVs list the yellow-grid node/edge resources with the highest accumulated reservation wait, and the issue register collects IE observations, policy tradeoffs, bottlenecks, and remaining site-data gaps.

The metric lineage artifact explains each review metric's source fields, formula, current 24h/7d values, automated verification gate, and remaining customer/site data needed for calibration.

The reservation replay task exports preserve the traced DES avoidance rows behind the dashboard replay: each traced task records shuttle id, pickup/dropoff nodes, empty/loaded route node counts, traffic/lift wait seconds, primary wait resource, route status, and route evidence. `pnpm run shuttle:review-verify` fails if any traced task has a `fail` route status.

The IE action plan turns the issue register into review-ready actions: priority, status, question, evidence, likely root cause, recommended action, next experiment/check, and customer data needed.

The live demo runbook is the review-day script for the live animated dashboard: reset, top-line PPH answer, Window PPH and Waiting Share explanation, DES avoidance replay, IE action plan, and site-calibration boundary.

The goal acceptance audit is the requirement-by-requirement proof page for the active review goal. It maps throughput, hourly PPH curves, Window PPH/Waiting Share definitions, IE problem diagnosis, V&V, data correctness, live animation, DES avoidance visibility, and the real-site calibration boundary to concrete evidence links and verification gates.

The goal completion audit is the stricter completion decision page. It says whether the active goal can honestly be marked complete, lists the internal proof rows, preserves the site-data-required row, and names the remaining proof needed before internal V&V becomes real-site validation.

The trend explorer is the customer-facing explanation page for the trend charts. It shows 24h Inbound PPH, Outbound PPH, Total Window PPH, Waiting Share, and Reposition Share with numeric markers, chart labels, metric definitions, and exact hourly rows.

The DES avoidance explainer is the customer-facing page for reservation-window avoidance evidence. It summarizes traced task pass/watch/fail counts, reservation windows, route misses, top yellow-grid wait resources, and the task-level waits that explain DES avoidance behavior.

The site validation protocol turns the remaining calibration gap into comparison gates: customer data needed, comparison method, pass/fail criterion, and the review artifact that consumes each input.

The site validation readiness gate is the machine-scored version of that boundary. It checks whether WCS/MES demand, lift timing, motion specs, CAD geometry, clearance envelope, no-drive zones, WCS policy, synchronized visual samples, and signed thresholds are ready for real site comparison. The current review state is expected to be `blocked-by-site-data`.

`pnpm run shuttle:site-readiness-verify` self-tests that gate in three modes: current-review data remains blocked, a complete customer-data fixture becomes ready, and an over-strict customer threshold turns the 24h comparison into partial instead of falsely passing.

Serve the review folder locally with:

```bash
python3 -m http.server 8123 -d output/review
```

Then open:

- Review hub: `http://127.0.0.1:8123/index.html`
- 24h V&V report: `http://127.0.0.1:8123/shuttle-des-review-24h-vv.html`
- 7d V&V report: `http://127.0.0.1:8123/shuttle-des-review-7d-vv.html`
- Metric lineage: `http://127.0.0.1:8123/metric-lineage.html`
- IE action plan: `http://127.0.0.1:8123/ie-action-plan.html`
- Live demo runbook: `http://127.0.0.1:8123/live-demo-runbook.html`
- Goal acceptance audit: `http://127.0.0.1:8123/goal-acceptance-audit.html`
- Goal completion audit: `http://127.0.0.1:8123/goal-completion-audit.html`
- Trend explorer: `http://127.0.0.1:8123/trend-explorer.html`
- DES avoidance explainer: `http://127.0.0.1:8123/des-avoidance-explainer.html`
- Site validation protocol: `http://127.0.0.1:8123/site-validation-protocol.html`
- Site validation readiness: `http://127.0.0.1:8123/site-validation-readiness.html`
- Site calibration gap: `http://127.0.0.1:8123/site-calibration-gap.html`

Before a live demo, run the preflight gate:

```bash
pnpm run shuttle:review-preflight
```

This checks TypeScript, generated review artifacts, dashboard evidence, site-calibration templates, the current review assumption file, and the running dashboard/API pair. On success it writes `output/review/review-preflight-latest.json` and refreshes the review hub so the latest gate result is visible from `http://127.0.0.1:8123/index.html`.

If you only need to diagnose the running dashboard/API process pair, use:

```bash
pnpm run shuttle:live-env-verify
```

This checks `http://127.0.0.1:5190/`, confirms the served dashboard source includes the live trend marker UI, checks API health at `http://127.0.0.1:8791`, and runs a short DES job that must return the current `shuttle.headlessDes.v1` schema with yellow-grid route model, reservation replay, issue list, positive inbound/outbound/total PPH, and `0` route misses. It is meant to catch stale dashboard/API processes from another synced folder before a customer review.

Current review baseline:

- 24h DES: `234.875` total PPH, `118.75` inbound PPH, `116.125` outbound PPH.
- 7d DES: `234.113` total PPH, `117.381` inbound PPH, `116.732` outbound PPH.
- Data integrity: `0` failed checks in both 24h and 7d reports.
- Physical smoke gates: yellow-grid contract and liveness both `pass`.
- Route contract: `0` unavailable DES yellow-grid routes.
- Dispatch baseline: max active task cap `6`; cap `8` is capacity-only stress and raises waiting materially.

The review pack is internally verified, not yet a site-calibrated capacity commitment. Before final customer-facing performance claims, collect the inputs listed in `docs/customer-site-validation-request.md`: real WCS/MES demand exports, PLC or synchronized-video lift/lower timings, CAD/layout dimensions, blocked/no-drive zones, shuttle motion specs, controls policy, and signed acceptance thresholds.

Use `config/shuttle/customer-site-calibration.template.json` as the machine-readable intake template for those customer/site inputs. Check the template shape with:

```bash
pnpm run shuttle:site-template-verify
```

Generate the current assumption-vs-site-data gap report independently with:

```bash
pnpm run shuttle:site-gap
```

This writes `output/review/site-calibration-gap.html` and `output/review/site-calibration-gap.json`, then the review hub links to the HTML page. The gap report is intentionally a boundary artifact: it shows what is supported by the internal review model and what must be replaced by customer WCS/MES, PLC/video, CAD, motion-spec, control-policy, and acceptance-threshold inputs before making a site-calibrated capacity claim.

The current internal review baseline is captured separately in `config/shuttle/customer-site-calibration.current-review.json`. It records the assumptions behind the generated review pack, including the `3600` inbound + `3600` outbound PPH stress input, `30s` lift/lower handling, demo shuttle speeds, and review cap `6`. It is deliberately marked `internal-review-assumption`, not site-calibrated. Check it with:

```bash
pnpm run shuttle:site-current-verify
```

Unreal Engine 5.7.4 and full Xcode are installed on the local Mac. Local macOS browser smoke has passed with a generated `PixelStreaming2` render-target capture scene plus the source bridge compile/headless smoke path. Packaged runtime soak and release hardening remain out of scope for Phase 0.

Phase 0 storage policy is a conservative row-level contract, not a full industrial throughput proof: inbound placement spreads work across FIFO rows while preserving contiguous fill inside each row, inbound shuttles back out toward the infeed side after dropoff, outbound drains without hidden compaction, stored pallets do not block shuttle pass-through under the load, and all reservation capacities remain fixed at `1`. The customer-review DES profile uses explicit lift/lower handling assumptions, currently `30s` lift and `30s` lower, so capacity claims stay tied to visible handling-time inputs instead of hidden near-zero defaults.

The default physical layout is generated from the assumption-grade calibration profile `phase0-cad-assumption-v1`. That profile is exposed as `scenario.layout.calibrationProfile` and in the static-scene contract so CAD/vendor/site dimensions can replace the placeholder pitch, aisle, lift, and clearance values without moving authority out of SimCore.

The checked-in golden fixture `config/shuttle/static-scene-contract.golden.json` freezes the current default static-scene contract. SimCore, the dashboard, and the Unreal smoke path compare against it so layout, unit, storage-cell, track, lift, and calibration metadata drift is explicit.

CAD-visible blocked or structural cells are represented as non-routable `layoutCalibrationProfile.blockedCells` metadata and mirrored into the static-scene contract as `blockedCells`. The default profile keeps that list empty until exact CAD/site coordinates are available, so the simulator does not invent unusable storage positions.

`pnpm shuttle:validate` runs the Phase 0 acceptance gate without rendering: same-seed event-log hash stability, a small seed sweep, a 600-second long-run sweep, prerequisite inspection, KPI summary, deadlock checks, reservation coverage checks, and physical safety checks for speed, acceleration, finite coordinates, and rectangular vehicle footprint clearance.

Phase 0 enforces edge, node, and zone capacity as `1`, and requires at least one parking node per vehicle so reset can assign one authoritative current-node occupant per shuttle. Multi-capacity reservation accounting is reserved for Phase 1.
