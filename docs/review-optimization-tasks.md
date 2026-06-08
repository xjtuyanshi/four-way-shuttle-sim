# Review Optimization Tasks

This checklist tracks the Monday-review recovery work after the feasible-area and hotspot evidence runs.

## Done

- [x] Treat the current yellow-grid map as the authoritative feasible area for this iteration.
- [x] Generate a feasible/no-go map that marks drivable yellow-grid resources and non-drivable floor.
- [x] Reproduce the module-02 / C19 hotspot incident with deterministic DES trace and video evidence.
- [x] Add four-zone 50% initial storage fill policy for DES.
- [x] Add traffic-aware DES storage selection and prove A/B improvement:
  - Total PPH: 233.5 -> 251.125 for uniform 50%.
  - Traffic reservation wait: 6.081% -> 1.863%.
  - Max continuous wait: 114.146s -> 72.337s.
  - Bottom-right wait: 287.19 min -> 58.67 min.
- [x] Add command entry points:
  - `npm run shuttle:uniform-zone-50`
  - `npm run shuttle:des-optimized`
  - `npm run shuttle:des-review-optimized`
  - `npm run shuttle:feasible-map`
  - `npm run shuttle:hotspot-incident`
- [x] Pass the optimized DES policy through dashboard/API headless DES runs.
- [x] Pass four-zone 50% and traffic-aware policy through dashboard/API physical setup.
- [x] Seed four-zone 50% outbound inventory in physical/3D reset.
- [x] Add traffic-aware top-lift inbound/outbound storage selection to the physical task creator.
- [x] Run physical/3D reset with `zone-balanced-50` and `traffic-aware`, then inspect the live scene:
  - Browser: `http://127.0.0.1:5191/`
  - Screenshot: `output/review/current-dashboard-policy-sync-browser.png`
  - Live run screenshot: `output/review/current-dashboard-live-run-browser.png`
- [x] Confirm dashboard setup labels show `zone-balanced-50` and `traffic-aware`.
- [x] Run physical liveness/contract audits after the physical strategy sync:
  - `output/review/optimized-yellow-grid-contract-smoke.json`: 180s, 0 anomalies, 0 physical violations.
  - `output/review/optimized-yellow-grid-liveness-smoke.json`: 900s, 0 anomalies, 0 deadlocks/livelocks/physical violations.
- [x] Record a short physical/3D run after reset and compare hotspot behavior against the previous C19/C20/M02-bottom evidence:
  - `output/review/optimized-physical-recording-600s.json`: 600s, 240 PPH, 0 anomaly markers, 0 deadlocks/livelocks/physical violations, max sampled waiting vehicles 1.
  - The previous long C19/C20/M02-bottom hotspot wait was not reproduced in this 600s optimized physical recording.

## Still To Decide

- [ ] Decide whether storage cells remain drivable for this phase or whether only aisle/column yellow-grid corridors should be drivable in the next model iteration.

## Current Acceptance Target

For the current iteration, success means the review path can show:

- The current feasible area is explicit and inspectable.
- DES uses uniform four-zone 50% inventory and traffic-aware storage selection.
- Physical/3D setup loads the same policy knobs.
- Evidence pages and commands are reproducible from the repo.
- Any remaining difference between DES and 3D is documented before customer review.
