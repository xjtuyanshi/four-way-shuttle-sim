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
- Pallet footprint assumption for the visual layer is 1.20 m x 1.00 m.
- Inbound is on the right side of the storage field and outbound is on the left side.
- FIFO lanes are one-way in the storage field: the shuttle enters from the right, places/pushes loads toward the left end first, and outbound picks from the left.
- The CAD texture labels storage field span, cell pitch, row pitch, and node ids so the visual can be checked against a future real CAD import.

## Next Calibration Inputs Needed

- Real pallet orientation and clearance allowance.
- Real row pitch and track gauge.
- Number of rows, number of pallet positions per row, and lift/conveyor locations from the target layout.
- Whether to display a single layer or stacked rack levels in the browser preview before Unreal owns the final visual.
