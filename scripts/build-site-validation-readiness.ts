import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const inputPath = resolve(positionalArg(0) ?? 'config/shuttle/customer-site-calibration.current-review.json');
const review24hPath = resolve(stringArg('--review') ?? 'output/review/shuttle-des-review-24h-vv.json');
const outputJsonPath = resolve(stringArg('--out-json') ?? 'output/review/site-validation-readiness.json');
const outputHtmlPath = resolve(stringArg('--html') ?? 'output/review/site-validation-readiness.html');

mkdirSync(dirname(outputJsonPath), { recursive: true });
mkdirSync(dirname(outputHtmlPath), { recursive: true });

const calibration = JSON.parse(readFileSync(inputPath, 'utf8')) as SiteCalibration;
const review24h = existsSync(review24hPath) ? JSON.parse(readFileSync(review24hPath, 'utf8')) as ReviewReport : null;
const rows = buildRows(calibration, review24h);
const summary: ReadinessReport = {
  schemaVersion: 'shuttle.siteValidationReadiness.v1',
  generatedAtIso: new Date().toISOString(),
  inputPath,
  review24hPath: existsSync(review24hPath) ? review24hPath : null,
  decision: rows.every((row) => row.status === 'ready') ? 'ready-for-site-comparison' : 'blocked-by-site-data',
  counts: {
    ready: rows.filter((row) => row.status === 'ready').length,
    partial: rows.filter((row) => row.status === 'partial').length,
    blocked: rows.filter((row) => row.status === 'blocked').length
  },
  rows
};

writeFileSync(outputJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(outputHtmlPath, renderHtml(summary));

console.log(JSON.stringify({
  type: 'site-validation-readiness-complete',
  outputJsonPath,
  outputHtmlPath,
  decision: summary.decision,
  counts: summary.counts
}, null, 2));

type SiteCalibration = {
  status: string;
  demandProfile?: { rows?: Array<Record<string, unknown>> };
  liftCycle?: { ports?: Array<Record<string, unknown>> };
  shuttleMotion?: Record<string, unknown>;
  layoutDimensions?: { liftPorts?: Array<Record<string, unknown>>; parkingNodes?: Array<Record<string, unknown>> } & Record<string, unknown>;
  loadAndClearanceEnvelope?: Record<string, unknown>;
  blockedCellsAndNoDriveZones?: { blockedCells?: Array<Record<string, unknown>>; noDriveRectangles?: Array<Record<string, unknown>>; source?: unknown };
  controlPolicy?: Record<string, unknown>;
  visualValidationSamples?: Array<Record<string, unknown>>;
  acceptanceThresholds?: Record<string, unknown>;
};

type ReviewReport = {
  result: {
    inboundPph: number;
    outboundPph: number;
    totalPph: number;
    averageWaitingPct: number;
    averageRepositionPct: number;
  };
};

type ReadinessStatus = 'ready' | 'partial' | 'blocked';

type ReadinessRow = {
  id: string;
  area: string;
  status: ReadinessStatus;
  readinessRule: string;
  currentEvidence: string;
  missingProof: string;
  modelImpact: string;
};

type ReadinessReport = {
  schemaVersion: 'shuttle.siteValidationReadiness.v1';
  generatedAtIso: string;
  inputPath: string;
  review24hPath: string | null;
  decision: 'ready-for-site-comparison' | 'blocked-by-site-data';
  counts: Record<ReadinessStatus, number>;
  rows: ReadinessRow[];
};

function buildRows(calibration: SiteCalibration, review24h: ReviewReport | null): ReadinessRow[] {
  const demandRows = calibration.demandProfile?.rows ?? [];
  const demandNumericRows = demandRows.filter((row) => ['inboundArrivals', 'inboundCompleted', 'outboundRequested', 'outboundCompleted'].every((key) => isRealNumber(row[key])));
  const liftPorts = calibration.liftCycle?.ports ?? [];
  const liftReadyPorts = liftPorts.filter((port) =>
    isRealNumber(port.sampleCount) && Number(port.sampleCount) >= 30 &&
    ['pickupLiftP50Sec', 'pickupLiftP95Sec', 'dropLowerP50Sec', 'dropLowerP95Sec'].every((key) => isRealNumber(port[key]))
  );
  const motion = calibration.shuttleMotion ?? {};
  const layout = calibration.layoutDimensions ?? {};
  const envelope = calibration.loadAndClearanceEnvelope ?? {};
  const blocked = calibration.blockedCellsAndNoDriveZones ?? {};
  const control = calibration.controlPolicy ?? {};
  const visual = calibration.visualValidationSamples ?? [];
  const thresholds = calibration.acceptanceThresholds ?? {};
  const thresholdNumbers = ['inboundPphTarget', 'outboundPphTarget', 'totalPphTarget', 'maxWaitingSharePct', 'maxRepositionSharePct'].filter((key) => isRealNumber(thresholds[key]));
  const liftUtilRange = thresholds.acceptableLiftUtilizationRangePct;
  const liftUtilReady = isPlainObject(liftUtilRange) && isRealNumber(liftUtilRange.min) && isRealNumber(liftUtilRange.max);

  return [
    {
      id: 'wcs-mes-demand-profile',
      area: 'WCS/MES demand and completion profile',
      status: demandNumericRows.length >= 24 ? 'ready' : demandNumericRows.length > 0 ? 'partial' : 'blocked',
      readinessRule: 'At least 24 hourly rows with numeric inbound arrivals/completions and outbound requests/completions; 168 rows preferred for 7d validation.',
      currentEvidence: `${demandRows.length} row(s), ${demandNumericRows.length} numeric validation row(s).`,
      missingProof: demandNumericRows.length >= 24 ? 'None for 24h comparison; collect 168 rows for long-run validation.' : 'Customer WCS/MES hourly export with task timestamps and direction.',
      modelImpact: 'Proves whether PPH valleys are demand-driven or caused by material-flow constraints.'
    },
    {
      id: 'lift-cycle-measurements',
      area: 'PLC/video lift cycle measurements',
      status: liftReadyPorts.length >= 2 ? 'ready' : liftReadyPorts.length > 0 ? 'partial' : 'blocked',
      readinessRule: 'At least inbound and outbound lift-port samples with sampleCount >= 30 and numeric P50/P95 lift/lower timings.',
      currentEvidence: `${liftPorts.length} port row(s), ${liftReadyPorts.length} statistically usable port row(s).`,
      missingProof: 'PLC event timestamps or synchronized video by lift port and direction.',
      modelImpact: 'Calibrates lift utilization, queueing, pickup/drop timing, and visual load attach/detach synchronization.'
    },
    {
      id: 'shuttle-motion-spec',
      area: 'Shuttle motion specification',
      status: allNumbers(motion, ['loadedSpeedMps', 'emptySpeedMps', 'accelerationMps2', 'decelerationMps2', 'turnDwellSec', 'reverseDwellSec', 'positionToleranceMm']) ? 'ready' : 'blocked',
      readinessRule: 'Loaded/empty speed, acceleration, deceleration, turn/reverse dwell, and positioning tolerance must be numeric and site/vendor supplied.',
      currentEvidence: summarizeKeys(motion, ['loadedSpeedMps', 'emptySpeedMps', 'accelerationMps2', 'decelerationMps2', 'turnDwellSec', 'reverseDwellSec', 'positionToleranceMm']),
      missingProof: 'Vendor motion spec plus commissioning logs.',
      modelImpact: 'Turns generated travel timing into site-calibrated travel timing.'
    },
    {
      id: 'cad-layout-geometry',
      area: 'CAD layout geometry',
      status: allNumbers(layout, ['storagePitchX', 'storagePitchZ', 'aisleCenterSpacing']) && hasNumericRows(layout.liftPorts ?? [], ['x', 'z']) ? 'ready' : 'blocked',
      readinessRule: 'Numeric storage pitch, aisle spacing, lift-port coordinates, and parking/staging nodes from customer CAD/site survey.',
      currentEvidence: `${summarizeKeys(layout, ['storagePitchX', 'storagePitchZ', 'aisleCenterSpacing'])}; lift ports ${(layout.liftPorts ?? []).length}, parking nodes ${(layout.parkingNodes ?? []).length}.`,
      missingProof: 'CAD export or dimensioned top-down drawing with origin, units, lift ports, staging, and storage pitch.',
      modelImpact: 'Proves the yellow-grid route model matches the real feasible travel area.'
    },
    {
      id: 'clearance-envelope',
      area: 'Load, shuttle, and clearance envelope',
      status: allNumbers(envelope, ['loadFootprintX', 'loadFootprintZ', 'shuttleFootprintX', 'shuttleFootprintZ', 'requiredClearance']) ? 'ready' : 'blocked',
      readinessRule: 'Load footprint, shuttle footprint, and required clearance must be numeric from vendor/customer standards.',
      currentEvidence: summarizeKeys(envelope, ['loadFootprintX', 'loadFootprintZ', 'shuttleFootprintX', 'shuttleFootprintZ', 'requiredClearance']),
      missingProof: 'Vendor drawings, pallet/load overhang, shuttle footprint, roller transfer footprint, and customer clearance standard.',
      modelImpact: 'Defines physical no-drive regions and separation requirements.'
    },
    {
      id: 'blocked-zones-no-drive',
      area: 'Blocked cells and no-drive zones',
      status: hasNonPlaceholder(blocked.source) && (hasNonPlaceholderRows(blocked.blockedCells ?? [], ['cellId', 'reason']) || hasNumericRows(blocked.noDriveRectangles ?? [], ['minX', 'maxX', 'minZ', 'maxZ'])) ? 'ready' : 'blocked',
      readinessRule: 'Site/CAD source plus blocked-cell or no-drive rectangle rows with real identifiers/coordinates.',
      currentEvidence: `${(blocked.blockedCells ?? []).length} blocked-cell row(s), ${(blocked.noDriveRectangles ?? []).length} no-drive rectangle row(s), source ${valueText(blocked.source)}.`,
      missingProof: 'CAD/site survey with structural, maintenance, and safety exclusions.',
      modelImpact: 'Prevents the DES and live model from routing through unavailable physical space.'
    },
    {
      id: 'wcs-control-policy',
      area: 'WCS/WES control policy',
      status: hasNonPlaceholder(control.dispatchPriority) && hasNonPlaceholder(control.storageAssignmentRule) && hasNonPlaceholder(control.retrievalRule) && isRealNumber(control.maxConcurrentReleasedTasks) && isRealNumber(control.liftQueueCapacity) && isRealNumber(control.sourceBufferCapacity) ? 'ready' : 'blocked',
      readinessRule: 'Dispatch, storage/retrieval, release limit, source buffer, and lift queue rules must be customer supplied.',
      currentEvidence: summarizeKeys(control, ['dispatchPriority', 'storageAssignmentRule', 'retrievalRule', 'liftQueueCapacity', 'sourceBufferCapacity', 'maxConcurrentReleasedTasks']),
      missingProof: 'WCS/WES rules export or controls interview.',
      modelImpact: 'Explains waiting, repositioning, lift imbalance, and task assignment behavior.'
    },
    {
      id: 'visual-validation-samples',
      area: 'Synchronized visual validation samples',
      status: visual.filter((sample) => hasNonPlaceholder(sample.videoFileOrUrl) && hasNonPlaceholder(sample.taskId) && hasNonPlaceholder(sample.eventTimestampIso)).length >= 3 ? 'ready' : 'blocked',
      readinessRule: 'At least 3 synchronized site clips with video URL/file, task id, and timestamp covering pickup/dropoff.',
      currentEvidence: `${visual.length} sample row(s), ${visual.filter((sample) => hasNonPlaceholder(sample.videoFileOrUrl) && hasNonPlaceholder(sample.taskId) && hasNonPlaceholder(sample.eventTimestampIso)).length} usable sample(s).`,
      missingProof: 'Site video clips aligned to PLC/WCS task timestamps.',
      modelImpact: 'Verifies that the animation and load-state timing matches real motion.'
    },
    {
      id: 'signed-acceptance-thresholds',
      area: 'Customer acceptance thresholds',
      status: thresholdNumbers.length === 5 && liftUtilReady ? 'ready' : 'blocked',
      readinessRule: 'Numeric inbound/outbound/total PPH targets, max waiting/reposition share, and acceptable lift utilization range.',
      currentEvidence: `${thresholdNumbers.length}/5 numeric top-level threshold(s); lift utilization range ${liftUtilReady ? 'ready' : 'missing'}.`,
      missingProof: 'Signed customer review thresholds.',
      modelImpact: 'Turns engineering observations into customer-facing pass/fail decisions.'
    },
    {
      id: '24h-result-threshold-comparison',
      area: '24h result versus customer thresholds',
      status: review24h && thresholdNumbers.length === 5 ? compareReviewToThresholds(review24h, thresholds) : 'blocked',
      readinessRule: 'A 24h report must be compared to numeric customer thresholds after thresholds are supplied.',
      currentEvidence: review24h
        ? `24h result total ${round(review24h.result.totalPph, 3)}, inbound ${round(review24h.result.inboundPph, 3)}, outbound ${round(review24h.result.outboundPph, 3)}, waiting ${round(review24h.result.averageWaitingPct, 3)}%, reposition ${round(review24h.result.averageRepositionPct, 3)}%.`
        : 'No 24h review report available.',
      missingProof: thresholdNumbers.length === 5 ? 'If status is partial, the run misses at least one customer threshold.' : 'Numeric customer acceptance thresholds.',
      modelImpact: 'This is the final bridge from internal review metrics to site-specific pass/fail.'
    }
  ];
}

function compareReviewToThresholds(report: ReviewReport, thresholds: Record<string, unknown>): ReadinessStatus {
  if (
    report.result.inboundPph >= Number(thresholds.inboundPphTarget) &&
    report.result.outboundPph >= Number(thresholds.outboundPphTarget) &&
    report.result.totalPph >= Number(thresholds.totalPphTarget) &&
    report.result.averageWaitingPct <= Number(thresholds.maxWaitingSharePct) &&
    report.result.averageRepositionPct <= Number(thresholds.maxRepositionSharePct)
  ) return 'ready';
  return 'partial';
}

function renderHtml(report: ReadinessReport): string {
  const rows = report.rows.map((row) => `
    <tr>
      <td><code>${escapeHtml(row.id)}</code><strong>${escapeHtml(row.area)}</strong></td>
      <td><span class="status ${row.status}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.readinessRule)}</td>
      <td>${escapeHtml(row.currentEvidence)}</td>
      <td>${escapeHtml(row.missingProof)}</td>
      <td>${escapeHtml(row.modelImpact)}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Site Validation Readiness</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --blue:#77c8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1440px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    code { display:block; margin-bottom:5px; color:#b7e5ff; font-size:11px; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--warn); background:var(--panel2); }
    .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .metric { border:1px solid var(--line); border-radius:8px; padding:12px; background:rgba(255,255,255,.035); }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; margin-top:7px; font-size:24px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:9px; text-align:left; color:var(--muted); vertical-align:top; }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { display:block; color:var(--text); }
    .status { display:inline-flex; align-items:center; justify-content:center; min-width:82px; min-height:24px; padding:4px 8px; border-radius:999px; font-weight:800; text-transform:uppercase; font-size:11px; border:1px solid var(--line); }
    .status.ready { color:var(--ok); border-color:rgba(67,198,135,.65); }
    .status.partial { color:var(--warn); border-color:rgba(241,183,82,.75); }
    .status.blocked { color:var(--blue); border-color:rgba(119,200,255,.75); }
    @media (max-width:960px) { main { padding:14px; } .grid { grid-template-columns:1fr 1fr; } table { font-size:11.5px; } }
    @media (max-width:640px) { .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">site validation readiness</p>
      <h1>Customer Site Data Readiness Gate</h1>
      <p>This is the executable checklist for turning internal V&V into site validation. It does not fail the review pack because missing customer data is expected, but it prevents us from claiming the goal is complete before the required proof exists.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="site-validation-readiness.json">Open JSON</a>
        <a class="button" href="site-calibration-gap.html">Site Calibration Gap</a>
        <a class="button" href="site-validation-protocol.html">Site Validation Protocol</a>
      </div>
    </header>
    <section class="summary">
      <h2>Decision: ${escapeHtml(report.decision)}</h2>
      <p>${report.decision === 'ready-for-site-comparison'
        ? 'All customer-site data gates are ready for threshold comparison.'
        : 'At least one customer-site data gate is blocked, so the current pack remains internal V&V only.'}</p>
    </section>
    <section class="grid">
      <div class="metric"><span>Ready</span><strong>${report.counts.ready}</strong></div>
      <div class="metric"><span>Partial</span><strong>${report.counts.partial}</strong></div>
      <div class="metric"><span>Blocked</span><strong>${report.counts.blocked}</strong></div>
      <div class="metric"><span>Total Gates</span><strong>${report.rows.length}</strong></div>
    </section>
    <section>
      <p class="eyebrow">machine-scored gates</p>
      <h2>Site Validation Input Coverage</h2>
      <table>
        <thead><tr><th>Area</th><th>Status</th><th>Readiness Rule</th><th>Current Evidence</th><th>Missing Proof</th><th>Model Impact</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function allNumbers(parent: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => isRealNumber(parent[key]));
}

function hasNumericRows(rows: Array<Record<string, unknown>>, keys: string[]): boolean {
  return rows.length > 0 && rows.every((row) => keys.every((key) => isRealNumber(row[key])));
}

function hasNonPlaceholderRows(rows: Array<Record<string, unknown>>, keys: string[]): boolean {
  return rows.length > 0 && rows.every((row) => keys.every((key) => hasNonPlaceholder(row[key])));
}

function summarizeKeys(parent: Record<string, unknown>, keys: string[]): string {
  return keys.map((key) => `${key}=${valueText(parent[key])}`).join(', ');
}

function isRealNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasNonPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return value !== null && value !== undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 &&
    !normalized.includes('not-site-calibrated') &&
    !normalized.includes('not-customer-supplied') &&
    !normalized.includes('generated') &&
    !normalized.includes('none-in-current-review-profile') &&
    !normalized.includes('internal');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return 'missing';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function positionalArg(index: number): string | null {
  const values = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  return values[index] ?? null;
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}
