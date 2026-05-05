# Real Layout Calibration Notes

This note captures the user-provided CAD screenshot from `IMG_8078.DNG`. The DNG can be converted locally for inspection only; converted image artifacts are intentionally not committed.

## Interpreted CAD Semantics

- Purple cross-braced rectangles are dense pallet storage cells. They are contiguous grid positions, not individual freestanding boxes.
- Yellow horizontal and vertical runs are shuttle corridors/rails. The long horizontal corridors include adjacent parallel lanes, so Phase 0 should continue modeling those as separate one-capacity lanes instead of a single capacity-2 resource.
- White/bright assemblies at vertical portals are shuttle/lift/transfer mechanisms. They should render as low transfer/lift stations with guide posts and rollers, not as gray storage boxes.
- Yellow equipment blocks above some storage islands are dedicated transfer/lift ports. Dedicated inbound and outbound roles remain a control-system property, but the visual treatment should read as transfer equipment connected to the aisle.
- Gray/green X-marked cells inside storage bands are blocked or structural positions, not general storage. Phase 0 can keep them out of the default graph until exact CAD metadata is available.
- The scene is a single level for simulation. Lifts are black-box I/O ports for this floor.

## Visible Dimensions

The screenshot contains several CAD dimension labels, but the photo angle and glare make them insufficient for final calibration. The visible labels include a main lower dimension that reads approximately `4380` mm and smaller labels around the main corridor that appear around `3477` mm / `1530` mm. Treat these as references to confirm against CAD, not authoritative constants.

Current Phase 0 constants remain placeholders:

- Storage pitch X: 1250 mm.
- Storage pitch Z: 1200 mm.
- Main two-lane corridor centers: +/-800 mm from the level centerline.
- Visual shuttle envelope: 1090 mm x 1030 mm plus software clearance.

These placeholders are now encoded in the SimCore default layout calibration profile `phase0-cad-assumption-v1`, exposed through `scenario.layout.calibrationProfile` and the shared static-scene contract. Treat every dimension in that profile as `source: assumed` / `confidence: low` until replaced by CAD/vendor/site measurements.

The static-scene contract also reports `calibrationReadiness`. That gate keeps `readyForIndustrialThroughputClaims=false` until every required layout, pallet, shuttle, lift-pad, roller-transfer, and parking-pad dimension is present with CAD/vendor/site source data and at least medium confidence.

## Implementation Rules From This Reference

- Draw storage as dense purple track-cell grids with no interior gap inside each island.
- Draw the main corridor as yellow rails/guide lines, with adjacent lanes represented by distinct nodes and edges.
- Draw lift ports as yellow transfer stations with rollers and posts. Do not draw gray boxes in the middle of the storage area unless they represent a specific blocked/structural CAD cell.
- Encode confirmed blocked/structural cells as `layoutCalibrationProfile.blockedCells`; these are visual/reference cells only unless later routing work explicitly turns them into graph obstacles.
- Treat the current eight parking/staging pads as a smoke-test placeholder. They are one-capacity parking nodes so vehicle-count testing can reach 8, but their exact charging/staging coordinates remain unverified until CAD/vendor/site data is available.
- Keep all vehicle motion orthogonal. No diagonal shortcut edges may be introduced to match the picture.
- Keep the visible default shuttle body orientation fixed. It may translate along X or Z and reverse directly out of storage/lane nodes, but it must not visually turn at right-angle moves.
- Keep FIFO as an inventory policy. Storage cells are positions on the shuttle track grid, while inbound/outbound sequencing remains controlled by SimCore tasks and reservations.
- Keep visual storage cell footprints equal to the calibrated storage pitch inside each dense island so adjacent cells read as a contiguous grid, not as sparse boxes.

## Next Data Needed

- Original CAD export or a straight top-down screenshot without camera glare.
- Confirmed storage cell pitch and pallet envelope.
- Confirmed corridor lane center spacing and clear width.
- Exact transfer/lift port coordinates and which ports are inbound versus outbound.
- Confirmed shuttle, pallet/load, lift-pad, roller-transfer, and parking-pad envelopes.
- Blocked structural cells inside storage islands, if any should be part of the routing graph.
