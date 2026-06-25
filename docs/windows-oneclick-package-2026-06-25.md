# Windows One-Click Demo Package - 2026-06-25

Package file:

- `output/shuttle-demo-oneclick-windows-a0f72e2.zip`

Built from app code commit:

- `a0f72e2` on branch `codex/traffic-v2-flow-debug`

How to run on Windows:

1. Download and unzip `output/shuttle-demo-oneclick-windows-a0f72e2.zip`.
2. Double-click `Start Shuttle Demo.bat`.
3. The package starts the API on `http://localhost:8791`, the dashboard on `http://localhost:5180`, loads the default 4-region / 8-shuttle scenario, and opens the browser.
4. Double-click `Stop Shuttle Demo.bat` when finished.

The zip is prebuilt. It includes a Windows `node.exe`, compiled API JavaScript, packaged sim-core/schemas, and the built dashboard assets. It does not require a GitHub checkout, `pnpm install`, or a local Node installation.

Smoke test performed on macOS using the same packaged JavaScript:

- API health endpoint started successfully.
- Static dashboard server started successfully.
- Demo scenario loaded successfully.
- Resulting state: `running`, `8` vehicles, scenario `shuttle-customer-outbound-demo-4-region`.

Known status:

- This is a directly runnable demo package, not a claim that the long-run physical tick issue is fully solved.
- Latest unresolved P0 remains documented in `docs/deadline-handoff-2026-06-25.md`: the station throat audit stops around `3105s` with `station-exclusive-lease-has-foreign-occupant` for `lift-02-outbound`.
