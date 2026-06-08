import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const currentPath = resolve('config/shuttle/customer-site-calibration.current-review.json');
const outputJsonPath = resolve('output/review/site-calibration-gap.json');
const outputHtmlPath = resolve('output/review/site-calibration-gap.html');

mkdirSync(dirname(outputJsonPath), { recursive: true });
mkdirSync(dirname(outputHtmlPath), { recursive: true });

const current = JSON.parse(readFileSync(currentPath, 'utf8')) as CurrentReviewCalibration;
const rows = buildGapRows(current);
const summary = {
  schemaVersion: 'shuttle.siteCalibrationGap.v1',
  generatedAtIso: new Date().toISOString(),
  source: currentPath,
  currentStatus: current.status,
  counts: {
    needsSiteData: rows.filter((row) => row.status === 'needs-site-data').length,
    internalAssumption: rows.filter((row) => row.status === 'internal-assumption').length,
    readyForComparison: rows.filter((row) => row.status === 'ready-for-comparison').length
  },
  rows
};

writeFileSync(outputJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(outputHtmlPath, renderHtml(summary));
console.log(JSON.stringify({
  type: 'site-calibration-gap-complete',
  outputJsonPath,
  outputHtmlPath,
  counts: summary.counts
}, null, 2));

type CurrentReviewCalibration = {
  status: string;
  demandProfile: { source: string; rows: Array<{ inboundArrivals: number | string; outboundRequested: number | string; notes: string }> };
  liftCycle: { source: string; ports: Array<{ pickupLiftP50Sec: number | string; dropLowerP50Sec: number | string; pickupLiftP95Sec: number | string; dropLowerP95Sec: number | string; notes: string }> };
  shuttleMotion: { source: string; loadedSpeedMps: number | string; emptySpeedMps: number | string; accelerationMps2: number | string; turnDwellSec: number | string; notes: string };
  layoutDimensions: { source: string; storagePitchX: number | string; storagePitchZ: number | string; aisleCenterSpacing: number | string };
  loadAndClearanceEnvelope: { source: string; loadFootprintX: number | string; shuttleFootprintX: number | string; requiredClearance: number | string };
  blockedCellsAndNoDriveZones: { source: string; blockedCells: Array<{ cellId: string; reason: string }>; noDriveRectangles: Array<{ zoneId: string; reason: string }> };
  controlPolicy: { source: string; maxConcurrentReleasedTasks: number | string; dispatchPriority: string; storageAssignmentRule: string; notes: string };
  visualValidationSamples: Array<{ sampleId: string; videoFileOrUrl: string; taskId: string; eventTimestampIso: string; notes: string }>;
  acceptanceThresholds: { source: string; inboundPphTarget: string | number; outboundPphTarget: string | number; totalPphTarget: string | number; maxWaitingSharePct: string | number };
};

type GapStatus = 'needs-site-data' | 'internal-assumption' | 'ready-for-comparison';

type GapRow = {
  area: string;
  status: GapStatus;
  currentReviewValue: string;
  customerReplacementNeeded: string;
  modelImpact: string;
};

type GapReport = {
  schemaVersion: string;
  generatedAtIso: string;
  source: string;
  currentStatus: string;
  counts: Record<string, number>;
  rows: GapRow[];
};

function buildGapRows(current: CurrentReviewCalibration): GapRow[] {
  const demand = current.demandProfile.rows[0];
  const lift = current.liftCycle.ports[0];
  const visual = current.visualValidationSamples[0];
  return [
    {
      area: 'Demand profile',
      status: 'internal-assumption',
      currentReviewValue: `${valueText(demand?.inboundArrivals)} inbound PPH + ${valueText(demand?.outboundRequested)} outbound PPH; source: ${current.demandProfile.source}`,
      customerReplacementNeeded: 'WCS/MES hourly arrivals, requests, and completions for at least 24h; 7 days preferred.',
      modelImpact: 'Controls offered load and determines whether PPH valleys are demand-driven or system-driven.'
    },
    {
      area: 'Lift/lower timing',
      status: 'internal-assumption',
      currentReviewValue: `lift P50 ${valueText(lift?.pickupLiftP50Sec)}s, lower P50 ${valueText(lift?.dropLowerP50Sec)}s; P95 ${valueText(lift?.pickupLiftP95Sec)} / ${valueText(lift?.dropLowerP95Sec)}`,
      customerReplacementNeeded: 'PLC timestamps or synchronized video by lift port, direction, P50/P95, and sample count.',
      modelImpact: 'Controls service capacity, lift utilization, and visual pickup/drop synchronization.'
    },
    {
      area: 'Shuttle motion',
      status: 'internal-assumption',
      currentReviewValue: `loaded ${valueText(current.shuttleMotion.loadedSpeedMps)} m/s, empty ${valueText(current.shuttleMotion.emptySpeedMps)} m/s, accel ${valueText(current.shuttleMotion.accelerationMps2)}, turn dwell ${valueText(current.shuttleMotion.turnDwellSec)}`,
      customerReplacementNeeded: 'Vendor motion spec and commissioning logs for speed, accel/decel, turn/reverse dwell, and positioning tolerance.',
      modelImpact: 'Calibrates travel time and validates whether 3D animation timing matches the site.'
    },
    {
      area: 'Layout dimensions',
      status: 'needs-site-data',
      currentReviewValue: `storage pitch X/Z ${valueText(current.layoutDimensions.storagePitchX)} / ${valueText(current.layoutDimensions.storagePitchZ)}, aisle spacing ${valueText(current.layoutDimensions.aisleCenterSpacing)}; source: ${current.layoutDimensions.source}`,
      customerReplacementNeeded: 'CAD export or dimensioned top-down drawing with storage pitch, aisle centers, lift ports, parking/staging coordinates.',
      modelImpact: 'Replaces generated geometry and decides whether yellow-grid paths match the real site.'
    },
    {
      area: 'Load and clearance envelope',
      status: 'needs-site-data',
      currentReviewValue: `load footprint X ${valueText(current.loadAndClearanceEnvelope.loadFootprintX)}, shuttle footprint X ${valueText(current.loadAndClearanceEnvelope.shuttleFootprintX)}, clearance ${valueText(current.loadAndClearanceEnvelope.requiredClearance)}`,
      customerReplacementNeeded: 'Pallet/load footprint, overhang, shuttle body, roller transfer footprint, and required clearance.',
      modelImpact: 'Defines physical no-drive regions and validates vehicle/load separation.'
    },
    {
      area: 'Blocked cells and no-drive zones',
      status: 'needs-site-data',
      currentReviewValue: `${current.blockedCellsAndNoDriveZones.blockedCells.length} placeholder blocked-cell row(s), ${current.blockedCellsAndNoDriveZones.noDriveRectangles.length} placeholder no-drive rectangle row(s); source: ${current.blockedCellsAndNoDriveZones.source}`,
      customerReplacementNeeded: 'CAD/site survey listing structural blocked cells, maintenance exclusions, and no-drive rectangles.',
      modelImpact: 'Prevents routing or storage through unavailable physical space.'
    },
    {
      area: 'Control policy',
      status: 'internal-assumption',
      currentReviewValue: `max concurrent released tasks ${valueText(current.controlPolicy.maxConcurrentReleasedTasks)}; dispatch ${current.controlPolicy.dispatchPriority}; storage ${current.controlPolicy.storageAssignmentRule}`,
      customerReplacementNeeded: 'WCS/WES dispatch priority, FIFO/LIFO rules, queue/buffer capacities, release limits, and repositioning policy.',
      modelImpact: 'Explains waiting, reposition, lift imbalance, and task assignment behavior.'
    },
    {
      area: 'Visual validation samples',
      status: 'needs-site-data',
      currentReviewValue: `internal sample ${visual?.sampleId ?? 'none'}; task ${visual?.taskId ?? 'none'}; timestamp ${visual?.eventTimestampIso ?? 'none'}`,
      customerReplacementNeeded: '3-5 synchronized site clips with task ids and PLC/WCS timestamps covering pickup/dropoff.',
      modelImpact: 'Verifies animation/load-state timing against real operation.'
    },
    {
      area: 'Acceptance thresholds',
      status: 'needs-site-data',
      currentReviewValue: `inbound ${valueText(current.acceptanceThresholds.inboundPphTarget)}, outbound ${valueText(current.acceptanceThresholds.outboundPphTarget)}, total ${valueText(current.acceptanceThresholds.totalPphTarget)}, waiting ${valueText(current.acceptanceThresholds.maxWaitingSharePct)}`,
      customerReplacementNeeded: 'Signed customer review thresholds for inbound PPH, outbound PPH, total PPH, waiting, reposition, and lift utilization.',
      modelImpact: 'Turns internal observations into customer-facing pass/fail decisions.'
    }
  ];
}

function renderHtml(report: GapReport): string {
  const rows = report.rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.area)}</td>
      <td><span class="status ${row.status}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.currentReviewValue)}</td>
      <td>${escapeHtml(row.customerReplacementNeeded)}</td>
      <td>${escapeHtml(row.modelImpact)}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Site Calibration Gap Report</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --warn:#f1b752; --violet:#b997ff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1280px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .metric { border:1px solid var(--line); border-radius:8px; padding:12px; background:rgba(255,255,255,.035); }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; margin-top:7px; font-size:24px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { border-top:1px solid var(--line); padding:9px; text-align:left; color:var(--muted); vertical-align:top; }
    th { color:var(--text); }
    .status { display:inline-block; min-width:128px; padding:4px 7px; border-radius:6px; color:#071016; text-align:center; font-weight:700; }
    .status.needs-site-data { background:var(--warn); }
    .status.internal-assumption { background:var(--violet); }
    .status.ready-for-comparison { background:#43c687; }
    @media (max-width:860px) { main { padding:14px; } .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">site calibration gap</p>
      <h1>Current Review Assumptions vs Customer Data Needed</h1>
      <p>This report turns the current internal-review assumption snapshot into a customer data gap list. It is not a site capacity claim.</p>
    </header>
    <section class="grid">
      <div class="metric"><span>Needs Site Data</span><strong>${report.counts.needsSiteData}</strong></div>
      <div class="metric"><span>Internal Assumptions</span><strong>${report.counts.internalAssumption}</strong></div>
      <div class="metric"><span>Ready For Comparison</span><strong>${report.counts.readyForComparison}</strong></div>
    </section>
    <section>
      <p class="eyebrow">Gap table</p>
      <h2>What Must Be Replaced Before Site-Calibrated Claim</h2>
      <table>
        <thead><tr><th>Area</th><th>Status</th><th>Current Review Value</th><th>Customer Replacement Needed</th><th>Model Impact</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return 'missing';
  return String(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
