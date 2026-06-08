# Customer Site Validation Data Request

This checklist turns the remaining validation gap into measurable site data. The current DES/V&V reports verify internal model behavior, yellow-grid routing, reservation-window avoidance, and bounded physical smoke tests. They do not prove site-calibrated capacity until the items below are confirmed with CAD, vendor, PLC, WCS, or measured operating data.

## Required Before Final Capacity Claim

| Area | Data needed | Unit / grain | Evidence source | Why it matters |
| --- | --- | --- | --- | --- |
| Demand profile | Inbound completed/arrived loads and outbound requested/completed loads by hour | loads/hour, at least 24h; ideally 7 days | WCS/MES task export | Replaces the current 3600+3600 PPH stress input with Monday demand. |
| Lift cycle | Lift pickup time, lower/dropoff time, and buffer release time; include P50/P95 and sample count | seconds per lift, by port and direction | PLC logs or timestamped video | Directly controls service time and pickup/drop synchronization. |
| Shuttle motion | Loaded speed, empty speed, acceleration/deceleration, turn/reverse dwell, positioning tolerance | m/s, m/s2, seconds, mm | Vendor spec plus commissioning logs | Calibrates travel time and verifies 3D motion timing. |
| Layout dimensions | Storage pitch X/Z, aisle center spacing, lift/transfer port coordinates, parking/staging coordinates | mm or m, top-down coordinate system | CAD export or dimensioned drawing | Replaces assumed layout calibration profile. |
| Load envelope | Pallet/load footprint, overhang, roller-transfer footprint, shuttle footprint, required clearance | mm | Vendor drawings/site standard | Defines physical clearance and blocked/unsafe regions. |
| Blocked cells | Structural/blocked storage cells, maintenance exclusion zones, no-drive zones | cell id or CAD coordinate rectangle | CAD/site survey | Prevents the simulator from treating blocked space as drivable/storage. |
| Control policy | Real dispatch priority, FIFO/LIFO rules, lift queue/buffer capacity, max concurrent released tasks | rule text and numeric limits | WCS/WES logic export or controls interview | Determines task assignment, waiting, and reposition behavior. |
| Validation video | 3-5 representative pickup/dropoff clips with timestamps and task ids | video plus event timestamps | Site video/PLC/WCS synchronized sample | Verifies visual timing: vehicle arrival, lift action, load attach/detach. |
| Throughput acceptance | Customer review target by side: inbound PPH, outbound PPH, total PPH, waiting threshold | PPH and percent thresholds | Customer review requirement | Defines pass/fail criteria instead of relying on generic observations. |

## Recommended Calibration Procedure

1. Replace layout dimensions and blocked-cell metadata first. Do not tune speed or dispatch policy to hide geometry errors.
2. Calibrate lift/lower timing from measured PLC or video data; use median for baseline and P95 for sensitivity.
3. Calibrate loaded/empty travel speed and acceleration; verify one route segment visually in 3D.
4. Load the measured hourly demand profile and rerun 24h plus 7d DES reports.
5. Compare report PPH, waiting share, lift utilization, and top reservation bottlenecks against the customer target.
6. Only after the calibrated report passes internal gates should the result be called a site capacity claim.

## Current Review Assumptions To Replace

- Lift time: 30 seconds.
- Lower time: 30 seconds.
- Inbound stress demand: 3600 PPH.
- Outbound stress demand: 3600 PPH.
- Layout calibration: top-lift column profile with remaining assumed/low-confidence dimensions.
- DES avoidance model: yellow-grid node/edge reservation windows with max active tasks capped for review stability.

