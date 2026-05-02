# Four-Way Shuttle Layout Reference

This is the working visual reference for the Phase 0 dashboard scene. The goal is not to create a decorative warehouse background; the scene should read like a CAD-derived, meter-based shuttle rack layout.

## References Reviewed

- Swisslog AgileStore describes a roaming pallet shuttle with true four-way movement, deep-lane storage, dynamic routing, and integrated lifts.
- Interlake Mecalux describes four-way pallet shuttles moving forward, backward, and sideways inside pallet storage lanes, with the WCS coordinating shuttle, elevator, and conveyor movement.
- Deen Racking describes a four-way pallet shuttle rack where the shuttle can travel longitudinally and transversely on a track plane to reach warehouse positions.
- Nutech describes four-way shuttle rack layouts as multi-aisle grids with lane geometry, rails, and clearances planned around pallets and process.
- Zikoo lists common supported pallet sizes including 1200 x 800-1000 mm and 1016 x 1219 mm, which is enough for our first CAD footprint assumption.

## Phase 0 Drawing Rules

- Units are meters, matching SimCore.
- The dashboard background is generated from `scenario.layout.nodes` and `scenario.layout.edges`; it is not a freehand image.
- Storage locations are drawn as drivable track cells, not shelving boxes or AMR pickup stands.
- Phase 0 now uses a contiguous storage block: 6 rows x 8 columns = 48 storage cells.
- The current visual cell footprint is 1.25 m x 1.20 m so cells touch as a dense grid instead of appearing as sparse isolated bays.
- Inbound is on the right side of the storage field and outbound is on the left side.
- The simulation is single-level. Lift behavior is modeled as dedicated black-box ports only: `inbound-lift-a/b` feed pallets into the level, and `outbound-lift-a/b` receive pallets out of the level.
- FIFO lanes are one-way in the storage field: inbound places from the right-side infeed direction into the deepest reachable empty cell, and outbound picks from the left-side outfeed direction.
- SimCore does not perform hidden row compaction. A pallet's `nodeId` changes only through explicit vehicle/lift transfer in this Phase 0/1 model; later push-lane mechanics need their own travel time, reservations, and events.
- The browser 3D twin draws the storage field as a continuous rack block with rail geometry, cross-track cell hints, side-aisle track beds, roller conveyors at inbound/outbound, parking pads, and low black-box lift ports.
- The CAD texture stays label-light: visual dimensions come from the SimCore meter grid, while detailed cell names and occupancy are shown in the dashboard inventory panel.

## Next Calibration Inputs Needed

- Real pallet orientation and clearance allowance.
- Real row pitch and track gauge.
- Number of rows, number of pallet positions per row, and lift/conveyor locations from the target layout.
- Real push-lane or shuttle-under-load rule: whether a loaded shuttle may pass under stored pallets, and what clearance/envelope validation is required if it can.
