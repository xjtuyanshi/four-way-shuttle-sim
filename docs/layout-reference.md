# Four-Way Shuttle Layout Reference

This is the working visual reference for the Phase 0 dashboard scene. The goal is not to create a decorative warehouse background; the scene should read like a CAD-derived, meter-based shuttle rack layout.

## References Reviewed

- [Swisslog AgileStore](https://www.swisslog.com/en-us/products-systems-solutions/asrs-automated-storage-retrieval-systems/automated-pallet-warehouse/agilestore-4-way-pallet-shuttle-asrs) describes a roaming pallet shuttle ASRS with high-density pallet storage, deep lanes, dynamic routing, and integrated lifts.
- [Swisslog's AgileStore launch note](https://www.swisslog.com/en-us/about-swisslog/newsroom/news-press-releases-blog-posts/2026/03/swisslog-agilestore-4-way-roaming-shuttle) emphasizes pallet handling, traffic management, lift integration, and rack-based high-density storage rather than AMR-style open-floor travel.
- [Interlake Mecalux Pallet Shuttle](https://www.interlakemecalux.com/automated-storage-retrieval-systems/pallet-shuttle) documents shuttle movement inside storage lanes on rails and FIFO/LIFO storage behavior.
- [Mecalux Automated Pallet Shuttle](https://www.mecalux.com/warehousing-solutions/automated-warehouses-for-pallets/automated-pallet-shuttle) documents lift/elevator and conveyor handoff as part of automated pallet shuttle systems.
- [Path Planning Methods for Four-Way Shuttle](https://mdpi-res.com/d_attachment/mathematics/mathematics-13-01588/article_deploy/mathematics-13-01588.pdf?version=1747054286) describes inbound/outbound operation around elevator docking and storage/retrieval routing.

## Phase 0 Drawing Rules

- Units are meters, matching SimCore.
- The dashboard background is generated from `scenario.layout.nodes` and `scenario.layout.edges`; it is not a freehand image.
- Storage locations are drawn as drivable track cells, not shelving boxes or AMR pickup stands.
- Phase 0 now uses a contiguous storage block: 6 rows x 8 columns = 48 storage cells.
- The current visual cell footprint is 1.25 m x 1.20 m so cells touch as a dense grid instead of appearing as sparse isolated bays.
- Inbound is on the right side of the storage field and outbound is on the left side.
- The simulation is single-level. Lift behavior is modeled as dedicated black-box ports only: `inbound-lift-a/b` feed pallets into the level, and `outbound-lift-a/b` receive pallets out of the level.
- Lift-port utilization in Phase 0/1 means port allocation by an active task, not measured lift motor/service utilization.
- FIFO is a storage/retrieval policy, not a one-way rail constraint: the shuttle can travel both directions on an empty lane, inbound places from the right-side infeed direction into the deepest reachable empty cell, and outbound picks from the left-side outfeed direction.
- SimCore does not perform hidden row compaction. A pallet's `nodeId` changes only through explicit vehicle/lift transfer in this Phase 0/1 model; later push-lane mechanics need their own travel time, reservations, and events.
- Stored pallet cells are blocking transit for route planning unless that cell is the current task endpoint, such as the outbound pickup cell. The model does not assume free pass-through under stored pallets.
- The browser 3D twin draws the storage field as a continuous single-level track bed with low rail geometry, cross-track cell hints, side-aisle track beds, roller conveyors at inbound/outbound, parking pads, and low black-box lift ports.
- The CAD texture stays label-light: visual dimensions come from the SimCore meter grid, while detailed cell names and occupancy are shown in the dashboard inventory panel.

## Next Calibration Inputs Needed

- Real pallet orientation and clearance allowance.
- Real row pitch and track gauge.
- Number of rows, number of pallet positions per row, and lift/conveyor locations from the target layout.
- Real push-lane mechanics and shuttle envelope clearances for later phases.
