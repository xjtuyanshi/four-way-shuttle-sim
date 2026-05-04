# Four-Way Shuttle Layout Reference

This is the working visual reference for the Phase 0 dashboard scene. The goal is not to create a decorative warehouse background; the scene should read like a CAD-derived, meter-based shuttle rack layout.

The user-provided CAD screenshot calibration notes are tracked in `docs/real-layout-calibration.md`.

## Public References Reviewed

- [Swisslog AgileStore](https://www.swisslog.com/en-us/products-systems-solutions/asrs-automated-storage-retrieval-systems/automated-pallet-warehouse/agilestore-4-way-pallet-shuttle-asrs) describes a roaming pallet shuttle ASRS with high-density pallet storage, deep lanes, dynamic routing, and integrated lifts.
- [Swisslog's AgileStore launch note](https://www.swisslog.com/en-us/about-swisslog/newsroom/news-press-releases-blog-posts/2026/03/swisslog-agilestore-4-way-roaming-shuttle) emphasizes pallet handling, traffic management, lift integration, and rack-based high-density storage rather than AMR-style open-floor travel.
- [Interlake Mecalux Pallet Shuttle](https://www.interlakemecalux.com/automated-storage-retrieval-systems/pallet-shuttle) documents shuttle movement inside storage lanes on rails and FIFO/LIFO storage behavior.
- [Mecalux Automated Pallet Shuttle](https://www.mecalux.com/warehousing-solutions/automated-warehouses-for-pallets/automated-pallet-shuttle) documents lift/elevator and conveyor handoff as part of automated pallet shuttle systems.
- [Path Planning Methods for Four-Way Shuttle](https://mdpi-res.com/d_attachment/mathematics/mathematics-13-01588/article_deploy/mathematics-13-01588.pdf?version=1747054286) describes inbound/outbound operation around elevator docking and storage/retrieval routing.

## Phase 0 Drawing Rules

- Units are meters, matching SimCore.
- The dashboard background is generated from `scenario.layout.nodes` and `scenario.layout.edges`; it is not a freehand image.
- Storage locations are drawn as drivable track cells, not shelving boxes or AMR pickup stands.
- Dense storage islands should render as contiguous purple track-cell grids. Interior cells are real positions; the middle of a storage block is not empty.
- Phase 0 now uses a multi-bank storage field: 16 rows x 24 columns = 384 logical storage cells.
- Storage rows are split into upper and lower banks around the main aisle. Storage columns are split into four 6-column islands with vertical corridor gaps, so the scene reads as multiple dense storage islands instead of a single toy-like rectangle.
- The current visual cell footprint is 1.25 m x 1.20 m so cells touch within each storage island instead of appearing as sparse isolated bays.
- The current shuttle safety check uses the configured 1.09 m x 1.03 m vehicle footprint plus 0.10 m clearance as a software validation envelope. This is a placeholder until real shuttle/pallet envelope and track-gauge clearance data are available.
- Inbound and outbound are dedicated lift-port roles, not just left/right sides. The default scene has four inbound lift black boxes and four outbound lift black boxes distributed along upper and lower transfer corridors.
- Lift ports should render as transfer/lift equipment with yellow guide rails, rollers, and posts. They should not look like gray storage boxes placed in the middle of the field.
- The simulation is single-level. Lift behavior is modeled as dedicated black-box ports only. Each `lift-blackbox` node must declare `liftKind: "inbound"` or `liftKind: "outbound"`; SimCore and the static scene contract use that metadata as the source of truth. The current default instances are `inbound-lift-top-01`, `inbound-lift-top-02`, `inbound-lift-bottom-01`, and `inbound-lift-bottom-02` for inbound, plus `outbound-lift-top-01`, `outbound-lift-top-02`, `outbound-lift-bottom-01`, and `outbound-lift-bottom-02` for outbound.
- Lift-port utilization in Phase 0/1 means port allocation by an active task, not measured lift motor/service utilization.
- FIFO is a storage/retrieval policy, not a one-way rail constraint: the shuttle can travel both directions on an empty lane, inbound places from the right-side infeed direction into the deepest reachable empty cell, and outbound picks from the left-side outfeed direction.
- The static scene contract exposes `storagePolicy: "rowContiguousLaneFill"`, `inboundStorageFlow: "rightToLeft"`, and `outboundStorageFlow: "leftPick"` so dashboard, Unreal smoke, and review notes use the same wording.
- SimCore does not perform hidden row compaction. A pallet's `nodeId` changes only through explicit vehicle/lift transfer in this Phase 0/1 model; later push-lane mechanics need their own travel time, reservations, and events.
- Stored pallet cells are blocking transit for route planning unless that cell is the current task endpoint, such as the outbound pickup cell. The model does not assume free pass-through under stored pallets.
- The two-lane main aisle is modeled as two adjacent one-capacity lanes rather than a capacity=2 reservation resource. The north lane is westbound and the south lane is eastbound so vehicles do not meet head-on in the long corridor.
- The browser 3D twin draws each storage island as its own continuous single-level track bed with low rail geometry, cross-track cell hints, side-aisle track beds, roller conveyors at inbound/outbound, parking pads, and low black-box lift ports.
- The CAD texture stays label-light: visual dimensions come from the SimCore meter grid, while detailed cell names and occupancy are shown in the dashboard inventory panel.

## Next Calibration Inputs Needed

- Real pallet orientation and clearance allowance.
- Real row pitch and track gauge.
- Exact number of rows, number of pallet positions per row, lift/conveyor locations, and aisle widths from CAD.
- Real push-lane mechanics and shuttle envelope clearances for later phases.
