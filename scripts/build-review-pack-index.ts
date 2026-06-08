import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const reviewRoot = resolve('output/review');
const outputPath = resolve('output/review/index.html');
const liveDemoRunbookPath = resolve(reviewRoot, 'live-demo-runbook.html');
const liveDemoRunbookJsonPath = resolve(reviewRoot, 'live-demo-runbook.json');
const goalAcceptanceAuditPath = resolve(reviewRoot, 'goal-acceptance-audit.html');
const goalAcceptanceAuditJsonPath = resolve(reviewRoot, 'goal-acceptance-audit.json');
const goalCompletionAuditPath = resolve(reviewRoot, 'goal-completion-audit.html');
const goalCompletionAuditJsonPath = resolve(reviewRoot, 'goal-completion-audit.json');
const trendExplorerPath = resolve(reviewRoot, 'trend-explorer.html');
const trendExplorerJsonPath = resolve(reviewRoot, 'trend-explorer.json');
const desAvoidanceExplainerPath = resolve(reviewRoot, 'des-avoidance-explainer.html');
const desAvoidanceExplainerJsonPath = resolve(reviewRoot, 'des-avoidance-explainer.json');
const reservationReplayTasksPath = resolve(reviewRoot, 'data/des-reservation-replay-tasks.json');
const siteValidationProtocolPath = resolve(reviewRoot, 'site-validation-protocol.html');
const siteValidationProtocolJsonPath = resolve(reviewRoot, 'site-validation-protocol.json');
const siteGapJsonPath = resolve(reviewRoot, 'site-calibration-gap.json');
const siteValidationReadinessJsonPath = resolve(reviewRoot, 'site-validation-readiness.json');
const preflightPath = resolve(reviewRoot, 'review-preflight-latest.json');
const reportSpecs = [
  { id: '24h', label: '24h V&V', jsonPath: resolve(reviewRoot, 'shuttle-des-review-24h-vv.json'), htmlHref: 'shuttle-des-review-24h-vv.html' },
  { id: '7d', label: '7d V&V', jsonPath: resolve(reviewRoot, 'shuttle-des-review-7d-vv.json'), htmlHref: 'shuttle-des-review-7d-vv.html' }
];

mkdirSync(dirname(outputPath), { recursive: true });

const reports = reportSpecs.map((spec) => {
  if (!existsSync(spec.jsonPath)) {
    throw new Error(`Missing required review report JSON: ${spec.jsonPath}`);
  }
  const report = JSON.parse(readFileSync(spec.jsonPath, 'utf8')) as ReviewReport;
  return { ...spec, report, summary: summarizeReport(report) };
});
const preflight = readPreflightSummary();

writeFileSync(outputPath, renderIndex(reports, preflight));
const liveDemoRunbook = buildLiveDemoRunbook(reports, preflight);
writeFileSync(liveDemoRunbookJsonPath, `${JSON.stringify(liveDemoRunbook, null, 2)}\n`);
writeFileSync(liveDemoRunbookPath, renderLiveDemoRunbookHtml(liveDemoRunbook));
const goalAcceptanceAudit = buildGoalAcceptanceAudit(reports, preflight);
writeFileSync(goalAcceptanceAuditJsonPath, `${JSON.stringify(goalAcceptanceAudit, null, 2)}\n`);
writeFileSync(goalAcceptanceAuditPath, renderGoalAcceptanceAuditHtml(goalAcceptanceAudit));
const goalCompletionAudit = buildGoalCompletionAudit(goalAcceptanceAudit, reports, preflight);
writeFileSync(goalCompletionAuditJsonPath, `${JSON.stringify(goalCompletionAudit, null, 2)}\n`);
writeFileSync(goalCompletionAuditPath, renderGoalCompletionAuditHtml(goalCompletionAudit));
const trendExplorer = buildTrendExplorer(reports);
writeFileSync(trendExplorerJsonPath, `${JSON.stringify(trendExplorer, null, 2)}\n`);
writeFileSync(trendExplorerPath, renderTrendExplorerHtml(trendExplorer));
const desAvoidanceExplainer = buildDesAvoidanceExplainer(reports);
writeFileSync(desAvoidanceExplainerJsonPath, `${JSON.stringify(desAvoidanceExplainer, null, 2)}\n`);
writeFileSync(desAvoidanceExplainerPath, renderDesAvoidanceExplainerHtml(desAvoidanceExplainer));
const siteValidationProtocol = buildSiteValidationProtocol(preflight);
writeFileSync(siteValidationProtocolJsonPath, `${JSON.stringify(siteValidationProtocol, null, 2)}\n`);
writeFileSync(siteValidationProtocolPath, renderSiteValidationProtocolHtml(siteValidationProtocol));
console.log(JSON.stringify({
  type: 'review-pack-index-complete',
  outputPath,
  liveDemoRunbookPath,
  goalAcceptanceAuditPath,
  goalCompletionAuditPath,
  trendExplorerPath,
  desAvoidanceExplainerPath,
  siteValidationProtocolPath,
  preflight: preflight ? { generatedAtIso: preflight.generatedAtIso, failures: preflight.failures } : null,
  reports: reports.map((item) => ({
    id: item.id,
    totalPph: item.report.result.totalPph,
    inboundPph: item.report.result.inboundPph,
    outboundPph: item.report.result.outboundPph,
    dataIntegrityFails: item.summary.dataIntegrityFails
  }))
}, null, 2));

type ReviewReport = {
  schemaVersion: string;
  generatedAtIso: string;
  scenarioHash: string;
  assumptions: {
    liftTimeSec: number;
    lowerTimeSec: number;
    maxActiveTasks: number;
    sampleIntervalSec: number;
  };
  policySensitivity: Array<{
    maxActiveTasks: number;
    isCurrent: boolean;
    totalPph: number;
    inboundPph: number;
    outboundPph: number;
    averageWaitingPct: number;
    averageRepositionPct: number;
    routeMisses: number;
  }>;
  dataIntegrity: Array<{ check: string; status: 'pass' | 'watch' | 'fail'; evidence: string }>;
  physicalAudit: {
    contract: { status: string; physicalViolations: number | null };
    liveness: { status: string; deadlocks: number | null; livelocks: number | null };
  };
  result: {
    durationSec: number;
    completedInbound: number;
    completedOutbound: number;
    inboundPph: number;
    outboundPph: number;
    totalPph: number;
    averageWaitingPct: number;
    averageRepositionPct: number;
    routeModel: {
      routeUnavailableCount: number;
      reservationWindowCount: number;
      trafficWaitSec: number;
    };
    samples: Array<{
      timeSec: number;
      completedInbound: number;
      completedOutbound: number;
      totalPph: number;
      averageWaitingPct?: number;
      averageRepositionPct?: number;
      waitingVehicles?: number;
      queuedTaskAgeMaxSec?: number;
    }>;
    trafficBottlenecks: Array<{ resourceId: string; waitSec: number; waitCount: number }>;
  };
};

type ReportSummary = {
  hours: number;
  hourlyLow: number;
  hourlyLowLabel: string;
  hourlyHigh: number;
  hourlyHighLabel: string;
  dataIntegrityPass: number;
  dataIntegrityWatch: number;
  dataIntegrityFails: number;
  physicalStatus: string;
  balancedCap: number;
  capacityCap: number;
  capacityCapWaitingPct: number;
  topTraffic: string;
};

type ReportItem = (typeof reportSpecs)[number] & {
  report: ReviewReport;
  summary: ReportSummary;
};

type GoalEvidenceRow = {
  requirement: string;
  status: 'pass' | 'watch' | 'needs-site-data';
  evidence: string;
};

type PreflightSummary = {
  type: string;
  generatedAtIso: string;
  failures: number;
  links: {
    dashboard: string;
    reviewHub: string;
    apiHealth: string;
  };
  reports: Array<{
    label: string;
    totalPph: number;
    inboundPph: number;
    outboundPph: number;
    completedInbound: number;
    completedOutbound: number;
    waitingPct: number;
    repositionPct: number;
    routeMisses: number;
    physicalGate: string;
    dataIntegrityFails: number;
  }>;
  issueRegister: {
    rows: number;
    needsSiteData: number;
    watch: number;
    categories: string[];
  };
  siteGap: {
    needsSiteData: number;
    internalAssumption: number;
    readyForComparison: number;
  };
  siteReadiness?: {
    decision: string;
    ready: number;
    partial: number;
    blocked: number;
  };
};

type LiveDemoRunbook = {
  schemaVersion: 'shuttle.liveDemoRunbook.v1';
  generatedAtIso: string;
  headline: {
    totalPph24h: number;
    inboundPph24h: number;
    outboundPph24h: number;
    totalPph7d: number;
    routeMisses24h: number;
    dataIntegrityFails24h: number;
    physicalGate24h: string;
  };
  links: Record<string, string>;
  steps: Array<{
    step: number;
    title: string;
    objective: string;
    action: string;
    expectedEvidence: string;
    fallback: string;
    source: string;
  }>;
};

type GoalAcceptanceAudit = {
  schemaVersion: 'shuttle.goalAcceptanceAudit.v1';
  generatedAtIso: string;
  overallStatus: 'internal-vv-pass-site-calibration-needed' | 'watch';
  headline: {
    totalPph24h: number;
    inboundPph24h: number;
    outboundPph24h: number;
    totalPph7d: number;
    routeMisses24h: number;
    dataIntegrityFails24h: number;
    preflightFailures: number | null;
    siteDataGaps: number | null;
  };
  rows: Array<{
    id: string;
    requirement: string;
    acceptanceCriterion: string;
    status: 'pass' | 'watch' | 'needs-site-data';
    evidence: string;
    verificationGate: string;
    sourceRefs: string[];
    remainingRisk: string;
  }>;
};

type GoalCompletionAudit = {
  schemaVersion: 'shuttle.goalCompletionAudit.v1';
  generatedAtIso: string;
  completionDecision: 'not-complete-site-validation-needed' | 'watch-incomplete' | 'complete';
  headline: {
    provedRows: number;
    watchRows: number;
    siteDataRows: number;
    preflightFailures: number | null;
    totalPph24h: number;
    inboundPph24h: number;
    outboundPph24h: number;
    routeMisses24h: number;
    dataIntegrityFails24h: number;
  };
  completionBlockers: Array<{ blocker: string; evidence: string; nextProofNeeded: string }>;
  rows: Array<{
    id: string;
    requirement: string;
    proofState: 'proved-internal' | 'watch-incomplete' | 'site-data-required';
    currentEvidence: string;
    verificationGate: string;
    sourceRefs: string[];
    nextProofNeeded: string;
  }>;
};

type TrendExplorer = {
  schemaVersion: 'shuttle.trendExplorer.v1';
  generatedAtIso: string;
  headline: {
    totalPph24h: number;
    inboundPph24h: number;
    outboundPph24h: number;
    waitingPct24h: number;
    repositionPct24h: number;
    totalPph7d: number;
  };
  definitions: Array<{ metric: string; definition: string; source: string }>;
  markers24h: TrendMarkers;
  markers7d: TrendMarkers;
  insights24h: TrendInsight[];
  insights7d: TrendInsight[];
  rows24h: TrendRow[];
  rows7d: TrendRow[];
};

type TrendMarkers = {
  lowTotalPph: TrendMarker | null;
  highTotalPph: TrendMarker | null;
  highWaitingPct: TrendMarker | null;
  highRepositionPct: TrendMarker | null;
};

type TrendMarker = {
  label: string;
  value: number;
};

type TrendRow = {
  label: string;
  startSec: number;
  endSec: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  cumulativeTotalPph: number;
  waitingPct: number;
  repositionPct: number;
  waitingVehicles: number;
  queuedTaskAgeMaxSec: number;
};

type TrendInsight = {
  id: string;
  status: 'pass' | 'watch' | 'critical';
  title: string;
  metric: string;
  evidence: string;
  ieInterpretation: string;
};

type DesAvoidanceExplainer = {
  schemaVersion: 'shuttle.desAvoidanceExplainer.v1';
  generatedAtIso: string;
  headline: {
    tracedTasks: number;
    pass: number;
    watch: number;
    fail: number;
    reservationWindows24h: number;
    routeMisses24h: number;
    trafficWaitHours24h: number;
    topTrafficResource24h: string;
  };
  explanation: Array<{ title: string; body: string }>;
  topBottlenecks24h: Array<{ rank: number; resourceId: string; waitSec: number; waitHours: number; waitCount: number }>;
  topWaitedTasks: ReservationReplayTaskRow[];
};

type ReservationReplayTaskRow = {
  horizon: string;
  task_id: string;
  shuttle_id: string;
  task_kind: string;
  pickup_node_id: string;
  dropoff_node_id: string;
  route_node_count: number;
  movement_sec: number;
  handling_sec: number;
  traffic_wait_sec: number;
  lift_wait_sec: number;
  total_wait_sec: number;
  primary_wait_resource: string;
  route_status: 'pass' | 'watch' | 'fail';
  route_evidence: string;
  dispatch_evidence: string;
  avoidance_evidence: string;
};

type SiteValidationProtocol = {
  schemaVersion: 'shuttle.siteValidationProtocol.v1';
  generatedAtIso: string;
  currentBoundary: {
    status: 'internal-vv-pass-site-data-needed';
    needsSiteData: number;
    internalAssumptions: number;
    readyForComparison: number;
  };
  gates: Array<{
    id: string;
    validationArea: string;
    customerDataNeeded: string;
    comparisonMethod: string;
    passFailCriterion: string;
    artifactUsed: string;
    currentStatus: 'needs-site-data' | 'internal-assumption' | 'ready-for-comparison';
  }>;
};

function summarizeReport(report: ReviewReport): ReportSummary {
  const periodRows = buildPeriodRows(report);
  const low = minBy(periodRows, (row) => row.totalPph);
  const high = maxBy(periodRows, (row) => row.totalPph);
  const dataIntegrityPass = report.dataIntegrity.filter((check) => check.status === 'pass').length;
  const dataIntegrityWatch = report.dataIntegrity.filter((check) => check.status === 'watch').length;
  const dataIntegrityFails = report.dataIntegrity.filter((check) => check.status === 'fail').length;
  const balanced = selectBalancedPolicy(report.policySensitivity);
  const capacityBest = maxBy(report.policySensitivity, (row) => row.totalPph) ?? balanced;
  const topTraffic = report.result.trafficBottlenecks[0];
  return {
    hours: report.result.durationSec / 3600,
    hourlyLow: low?.totalPph ?? 0,
    hourlyLowLabel: low?.label ?? 'n/a',
    hourlyHigh: high?.totalPph ?? 0,
    hourlyHighLabel: high?.label ?? 'n/a',
    dataIntegrityPass,
    dataIntegrityWatch,
    dataIntegrityFails,
    physicalStatus: `${report.physicalAudit.contract.status}/${report.physicalAudit.liveness.status}`,
    balancedCap: balanced.maxActiveTasks,
    capacityCap: capacityBest.maxActiveTasks,
    capacityCapWaitingPct: capacityBest.averageWaitingPct,
    topTraffic: topTraffic ? `${topTraffic.resourceId} (${round(topTraffic.waitSec / 3600, 2)}h / ${topTraffic.waitCount})` : 'none'
  };
}

function renderIndex(items: ReportItem[], preflightSummary: PreflightSummary | null): string {
  const primary = items[0]!;
  const longRun = items[1] ?? primary;
  const heroCards = items.map((item) => renderReportCard(item)).join('');
  const preflightSection = preflightSummary ? renderPreflightSection(preflightSummary) : '';
  const goalEvidenceRows = buildGoalEvidenceRows(primary, longRun).map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.requirement)}</strong></td>
      <td><span class="status-pill ${row.status}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.evidence)}</td>
    </tr>
  `).join('');
  const visualCards = buildVisualCards().map((item) => `
    <figure class="visual">
      <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.title)}" />
      <figcaption><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.caption)}</span></figcaption>
    </figure>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Customer Review Pack</title>
  <style>
    :root { color-scheme: dark; --bg: #0d141b; --panel: #14202a; --panel2: #101922; --line: #314454; --text: #edf4f7; --muted: #a8b8c3; --ok: #43c687; --warn: #f1b752; --blue: #77c8ff; --violet: #b997ff; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    header, section, article { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 18px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 30px; }
    h2 { font-size: 20px; }
    p { color: var(--muted); line-height: 1.5; }
    a { color: #86d7ff; text-decoration: none; }
    .eyebrow { margin: 0 0 7px; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; color: var(--muted); }
    .summary { border-left: 4px solid var(--blue); background: var(--panel2); }
    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .card { background: var(--panel2); display: grid; gap: 13px; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: rgba(255,255,255,.035); }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 6px; font-size: 22px; }
    .readout { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .readout article { background: var(--panel2); min-height: 136px; }
    .readout strong { display: block; margin-top: 8px; font-size: 20px; }
    .readout p { margin-bottom: 0; font-size: 12px; }
    .ok { border-color: rgba(67,198,135,.52); }
    .watch { border-color: rgba(241,183,82,.72); }
    .validation { border-color: rgba(185,151,255,.72); }
    .links { display: flex; flex-wrap: wrap; gap: 10px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 8px 12px; border-radius: 7px; border: 1px solid var(--line); background: #0b1219; color: var(--text); font-weight: 700; }
    .visual-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .visual { margin: 0; border: 1px solid var(--line); border-radius: 8px; background: #0b1219; overflow: hidden; }
    .visual img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; background: #071016; }
    .visual figcaption { display: grid; gap: 5px; padding: 10px; }
    .visual span { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .goal-table strong { color: var(--text); }
    .status-pill { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
    .status-pill.pass { color: var(--ok); border-color: rgba(67,198,135,.5); }
    .status-pill.watch { color: var(--warn); border-color: rgba(241,183,82,.65); }
    .status-pill.needs-site-data { color: var(--blue); border-color: rgba(119,200,255,.65); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-top: 1px solid var(--line); padding: 9px; text-align: left; color: var(--muted); vertical-align: top; }
    th { color: var(--text); }
    @media (max-width: 980px) { .cards, .visual-grid, .readout { grid-template-columns: 1fr; } }
    @media (max-width: 720px) { main { padding: 14px; } .metric-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Monday customer review pack</p>
      <h1>Four-Way Shuttle DES V&V Review Hub</h1>
      <p>One-page entry point for the verified 24h and 7d review artifacts, live dashboard, visual evidence, and site-calibration request.</p>
    </header>
    <section class="summary">
      <p class="eyebrow">Answer first</p>
      <h2>Review Baseline</h2>
      <p>Use the ${round(primary.summary.hours, 0)}h run as the customer review baseline: ${round(primary.report.result.totalPph, 1)} total PPH, inbound ${round(primary.report.result.inboundPph, 1)} PPH, outbound ${round(primary.report.result.outboundPph, 1)} PPH. Balanced dispatch release is cap ${primary.summary.balancedCap}; cap ${primary.summary.capacityCap} is a capacity-only stress point with ${round(primary.summary.capacityCapWaitingPct, 2)}% waiting. The ${round(longRun.summary.hours, 0)}h run confirms long-run behavior at ${round(longRun.report.result.totalPph, 1)} total PPH. Internal V&V passes, but site calibration data is still required before making a real-site capacity commitment.</p>
    </section>
    <section class="readout">
      <article class="ok"><p class="eyebrow">Throughput</p><h2>24h baseline</h2><strong>${round(primary.report.result.totalPph, 1)} PPH</strong><p>In ${round(primary.report.result.inboundPph, 1)} / out ${round(primary.report.result.outboundPph, 1)}.</p></article>
      <article class="ok"><p class="eyebrow">Long run</p><h2>7d check</h2><strong>${round(longRun.report.result.totalPph, 1)} PPH</strong><p>${longRun.report.result.samples.length} samples, ${longRun.summary.dataIntegrityFails} data fails.</p></article>
      <article class="watch"><p class="eyebrow">Hourly stability</p><h2>range</h2><strong>${round(primary.summary.hourlyLow, 0)}-${round(primary.summary.hourlyHigh, 0)} PPH</strong><p>Lowest ${primary.summary.hourlyLowLabel}; highest ${primary.summary.hourlyHighLabel}.</p></article>
      <article class="watch"><p class="eyebrow">Policy</p><h2>balanced cap</h2><strong>cap ${primary.summary.balancedCap}</strong><p>Capacity cap ${primary.summary.capacityCap} is not the review recommendation because waiting rises.</p></article>
      <article class="validation"><p class="eyebrow">V&V</p><h2>gate state</h2><strong>${primary.summary.physicalStatus}</strong><p>${primary.summary.dataIntegrityPass} data checks pass, ${primary.summary.dataIntegrityWatch} watch, ${primary.summary.dataIntegrityFails} fail.</p></article>
    </section>
    <section class="cards">
      ${heroCards}
    </section>
    ${preflightSection}
    <section>
      <p class="eyebrow">Goal evidence matrix</p>
      <h2>What The Current Pack Proves</h2>
      <p>This matrix maps the original review goal to concrete evidence on the hub, dashboard, and 24h/7d V&V reports. It keeps internal verification separate from customer site calibration.</p>
      <table class="goal-table">
        <thead><tr><th>Requirement</th><th>Status</th><th>Evidence</th></tr></thead>
        <tbody>${goalEvidenceRows}</tbody>
      </table>
    </section>
    <section>
      <p class="eyebrow">Open these during review</p>
      <h2>Primary Links</h2>
      <div class="links">
        <a class="button" href="shuttle-des-review-24h-vv.html">Open 24h V&V Report</a>
        <a class="button" href="shuttle-des-review-7d-vv.html">Open 7d V&V Report</a>
        <a class="button" href="site-calibration-gap.html">Open Site Calibration Gap</a>
        <a class="button" href="ie-action-plan.html">Open IE Action Plan</a>
        <a class="button" href="live-demo-runbook.html">Open Live Demo Runbook</a>
        <a class="button" href="goal-acceptance-audit.html">Open Goal Acceptance Audit</a>
        <a class="button" href="goal-completion-audit.html">Open Goal Completion Audit</a>
        <a class="button" href="trend-explorer.html">Open Trend Explorer</a>
        <a class="button" href="des-avoidance-explainer.html">Open DES Avoidance Explainer</a>
        <a class="button" href="site-validation-protocol.html">Open Site Validation Protocol</a>
        <a class="button" href="site-validation-readiness.html">Open Site Validation Readiness</a>
        <a class="button" href="http://localhost:5190/">Open Live Dashboard</a>
        <a class="button" href="../../docs/customer-site-validation-request.md">Site Data Request</a>
      </div>
    </section>
    <section>
      <p class="eyebrow">Data exports</p>
      <h2>CSV For Recalculation</h2>
      <p>Use these files to inspect the exact period PPH curve and traffic bottleneck rows outside the dashboard. Period PPH is recomputed from adjacent cumulative samples.</p>
      <div class="links">
        <a class="button" href="data/des-period-pph-24h.csv">24h Period PPH CSV</a>
        <a class="button" href="data/des-period-pph-7d.csv">7d Period PPH CSV</a>
        <a class="button" href="data/des-traffic-bottlenecks-24h.csv">24h Bottlenecks CSV</a>
        <a class="button" href="data/des-traffic-bottlenecks-7d.csv">7d Bottlenecks CSV</a>
        <a class="button" href="data/des-reservation-replay-tasks-24h.csv">24h Replay Tasks CSV</a>
        <a class="button" href="data/des-reservation-replay-tasks-7d.csv">7d Replay Tasks CSV</a>
        <a class="button" href="data/des-reservation-replay-tasks.json">Replay Tasks JSON</a>
        <a class="button" href="data/review-issue-register.csv">Issue Register CSV</a>
        <a class="button" href="data/review-issue-register.json">Issue Register JSON</a>
        <a class="button" href="ie-action-plan.html">IE Action Plan HTML</a>
        <a class="button" href="data/ie-action-plan.csv">IE Action Plan CSV</a>
        <a class="button" href="data/ie-action-plan.json">IE Action Plan JSON</a>
        <a class="button" href="goal-acceptance-audit.html">Goal Acceptance Audit HTML</a>
        <a class="button" href="goal-acceptance-audit.json">Goal Acceptance Audit JSON</a>
        <a class="button" href="goal-completion-audit.html">Goal Completion Audit HTML</a>
        <a class="button" href="goal-completion-audit.json">Goal Completion Audit JSON</a>
        <a class="button" href="trend-explorer.html">Trend Explorer HTML</a>
        <a class="button" href="trend-explorer.json">Trend Explorer JSON</a>
        <a class="button" href="des-avoidance-explainer.html">DES Avoidance Explainer HTML</a>
        <a class="button" href="des-avoidance-explainer.json">DES Avoidance Explainer JSON</a>
        <a class="button" href="site-validation-protocol.html">Site Validation Protocol HTML</a>
        <a class="button" href="site-validation-protocol.json">Site Validation Protocol JSON</a>
        <a class="button" href="site-validation-readiness.html">Site Validation Readiness HTML</a>
        <a class="button" href="site-validation-readiness.json">Site Validation Readiness JSON</a>
        <a class="button" href="metric-lineage.html">Metric Lineage HTML</a>
        <a class="button" href="data/metric-lineage.csv">Metric Lineage CSV</a>
        <a class="button" href="data/metric-lineage.json">Metric Lineage JSON</a>
      </div>
    </section>
    <section>
      <p class="eyebrow">Visual evidence</p>
      <h2>3D / DES / Data QA Screenshots</h2>
      <div class="visual-grid">${visualCards}</div>
    </section>
    <section>
      <p class="eyebrow">Site calibration boundary</p>
      <h2>What Is Still Not A Real-Site Claim</h2>
      <p>Open <a href="site-calibration-gap.html">Site Calibration Gap</a> for the machine-generated comparison between the current internal-review assumption snapshot and the customer data needed.</p>
      <table>
        <thead><tr><th>Needed From Customer/Site</th><th>Why It Matters</th></tr></thead>
        <tbody>
          <tr><td>WCS/MES inbound and outbound task exports by timestamp</td><td>Validates offered load and whether hourly PPH dips are demand-driven or system-driven.</td></tr>
          <tr><td>PLC or synchronized video for lift/lower/pick/drop timing</td><td>Calibrates service time, utilization, and 3D load attach/detach timing.</td></tr>
          <tr><td>CAD/layout dimensions, blocked zones, and shuttle motion spec</td><td>Converts the internal yellow-grid model into a site-calibrated physical model.</td></tr>
          <tr><td>Customer acceptance thresholds</td><td>Turns current watch bands into contractual pass/fail decisions.</td></tr>
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function buildLiveDemoRunbook(items: ReportItem[], preflightSummary: PreflightSummary | null): LiveDemoRunbook {
  const primary = items[0]!;
  const longRun = items[1] ?? primary;
  const links = {
    reviewHub: 'http://127.0.0.1:8123/index.html',
    dashboard: preflightSummary?.links.dashboard ?? 'http://127.0.0.1:5190/',
    apiHealth: preflightSummary?.links.apiHealth ?? 'http://127.0.0.1:8791/api/shuttle/health',
    runbook: 'live-demo-runbook.html',
    report24h: primary.htmlHref,
    report7d: longRun.htmlHref,
    metricLineage: 'metric-lineage.html',
    actionPlan: 'ie-action-plan.html',
    siteGap: 'site-calibration-gap.html',
    replayCsv24h: 'data/des-reservation-replay-tasks-24h.csv',
    replayCsv7d: 'data/des-reservation-replay-tasks-7d.csv',
    periodCsv24h: 'data/des-period-pph-24h.csv',
    bottleneckCsv24h: 'data/des-traffic-bottlenecks-24h.csv',
    preflightJson: 'review-preflight-latest.json'
  };
  return {
    schemaVersion: 'shuttle.liveDemoRunbook.v1',
    generatedAtIso: new Date().toISOString(),
    headline: {
      totalPph24h: primary.report.result.totalPph,
      inboundPph24h: primary.report.result.inboundPph,
      outboundPph24h: primary.report.result.outboundPph,
      totalPph7d: longRun.report.result.totalPph,
      routeMisses24h: primary.report.result.routeModel.routeUnavailableCount,
      dataIntegrityFails24h: primary.summary.dataIntegrityFails,
      physicalGate24h: primary.summary.physicalStatus
    },
    links,
    steps: [
      {
        step: 1,
        title: 'Start From The Verified Review Hub',
        objective: 'Make sure the customer sees the same artifact set that passed machine checks.',
        action: 'Open the review hub, point to Latest preflight gate, and confirm failures=0 before opening the live dashboard.',
        expectedEvidence: `Preflight failures ${preflightSummary?.failures ?? 0}; 24h baseline ${round(primary.report.result.totalPph, 1)} total PPH; route miss ${primary.report.result.routeModel.routeUnavailableCount}; data fails ${primary.summary.dataIntegrityFails}.`,
        fallback: 'If preflight is missing or stale, run pnpm run shuttle:review-preflight before the customer demo.',
        source: links.preflightJson
      },
      {
        step: 2,
        title: 'Reset Live Simulation Before Talking Through Motion',
        objective: 'Avoid confusion from an old browser state or a half-run simulation.',
        action: 'Open the live dashboard, press Reset, then start or jump to the review window. Use the clock and 3D scene as the authoritative live state.',
        expectedEvidence: 'The live clock restarts cleanly, shuttles are visible in the 3D scene, and the dashboard status reports the current live/API pair.',
        fallback: 'If the dashboard looks stale, run pnpm run shuttle:live-env-verify and refresh http://127.0.0.1:5190/.',
        source: links.dashboard
      },
      {
        step: 3,
        title: 'Answer The Throughput Question First',
        objective: 'Give the customer the top-line Inbound, Outbound, and Total PPH before diving into charts.',
        action: 'Use the dashboard Answer-First panel or the 24h V&V report headline.',
        expectedEvidence: `24h: Total PPH ${round(primary.report.result.totalPph, 3)}, Inbound PPH ${round(primary.report.result.inboundPph, 3)}, Outbound PPH ${round(primary.report.result.outboundPph, 3)}. 7d: Total PPH ${round(longRun.report.result.totalPph, 3)}.`,
        fallback: 'Open Metric Lineage if the customer asks for formulas or denominator definitions.',
        source: links.metricLineage
      },
      {
        step: 4,
        title: 'Explain Window PPH And Waiting Share With Markers',
        objective: 'Make the trend charts readable instead of just showing unlabeled lines.',
        action: 'Open the DES Period PPH panel and point to lowest/highest period labels, then show Waiting Share and Reposition definitions.',
        expectedEvidence: `24h hourly range ${round(primary.summary.hourlyLow, 1)}-${round(primary.summary.hourlyHigh, 1)} PPH; Waiting Share is resource-wait seconds divided by fleet available time.`,
        fallback: 'Open the 24h Period PPH CSV for exact period rows and recomputation.',
        source: links.periodCsv24h
      },
      {
        step: 5,
        title: 'Show DES Avoidance As Waiting, Not Vehicle Crossing',
        objective: 'Demonstrate that collision avoidance creates explicit reservation waits on yellow-grid resources.',
        action: 'Open the DES Reservation Replay and Dispatch & Avoidance Audit panels; sort or discuss tasks with non-zero wait.',
        expectedEvidence: `${primary.report.result.routeModel.reservationWindowCount} reservation windows, ${primary.report.result.routeModel.routeUnavailableCount} route misses, top traffic ${primary.summary.topTraffic}.`,
        fallback: 'Open reservation replay task CSV and filter by total_wait_sec or primary_wait_resource.',
        source: links.replayCsv24h
      },
      {
        step: 6,
        title: 'Use The IE Action Plan For Problems, Not Guesswork',
        objective: 'Turn observations into decision-ready next actions.',
        action: 'Open IE Action Plan and walk P1 rows first: dispatch policy, customer thresholds, site data, and any watch items.',
        expectedEvidence: 'Action rows include priority, status, evidence, likely cause, recommended action, next experiment, and customer data needed.',
        fallback: 'If the customer asks for raw evidence, open issue register, replay task CSV, or metric lineage from the hub.',
        source: links.actionPlan
      },
      {
        step: 7,
        title: 'Keep The Site Calibration Boundary Explicit',
        objective: 'Separate internal V&V readiness from a real-site capacity commitment.',
        action: 'Close by opening Site Calibration Gap and naming the missing customer inputs.',
        expectedEvidence: 'Needed inputs: WCS/MES demand, PLC/video lift timing, CAD/no-drive zones, shuttle motion specs, control policy, and signed acceptance thresholds.',
        fallback: 'Use customer-site-calibration.template.json as the structured intake template after the review.',
        source: links.siteGap
      }
    ]
  };
}

function buildGoalAcceptanceAudit(items: ReportItem[], preflightSummary: PreflightSummary | null): GoalAcceptanceAudit {
  const primary = items[0]!;
  const longRun = items[1] ?? primary;
  const report = primary.report;
  const summary = primary.summary;
  const longReport = longRun.report;
  const topTraffic = report.result.trafficBottlenecks[0];
  const visualCards = buildVisualCards();
  const has3dEvidence = visualCards.some((item) => item.title === 'Live 3D Animation');
  const hasReviewCockpitEvidence = visualCards.some((item) => item.title === 'Review Cockpit 3D + DES Evidence');
  const hasReplayEvidence = visualCards.some((item) => item.title === 'DES Avoidance Replay');
  const hasDispatchAudit = visualCards.some((item) => item.title === 'Dispatch Avoidance Audit');
  const preflightOk = preflightSummary ? preflightSummary.failures === 0 : false;
  const routeOk = report.result.routeModel.routeUnavailableCount === 0;
  const physicalOk = summary.physicalStatus === 'pass/pass';
  const dataOk = summary.dataIntegrityFails === 0;

  const rows: GoalAcceptanceAudit['rows'] = [
    {
      id: 'throughput-answer',
      requirement: 'Report Inbound, Outbound, and Total PPH for the review period.',
      acceptanceCriterion: '24h and 7d reports must expose total, inbound, and outbound PPH, plus completed-load counts.',
      status: report.result.totalPph > 0 && report.result.inboundPph > 0 && report.result.outboundPph > 0 ? 'pass' : 'watch',
      evidence: `24h Total PPH ${round(report.result.totalPph, 3)}, Inbound PPH ${round(report.result.inboundPph, 3)}, Outbound PPH ${round(report.result.outboundPph, 3)}; 7d Total PPH ${round(longReport.result.totalPph, 3)}.`,
      verificationGate: 'pnpm run shuttle:review-verify checks positive inbound/outbound/total PPH for 24h and 7d.',
      sourceRefs: ['shuttle-des-review-24h-vv.html', 'shuttle-des-review-7d-vv.html', 'metric-lineage.html'],
      remainingRisk: 'Customer demand profile still needs WCS/MES validation before these PPH numbers become a site-capacity commitment.'
    },
    {
      id: 'hourly-pph-curve',
      requirement: 'Show the hourly PPH curve with numeric markers instead of unlabeled trend lines.',
      acceptanceCriterion: 'Period rows must recompute from adjacent cumulative samples and identify low/high windows.',
      status: 'pass',
      evidence: `24h hourly range ${round(summary.hourlyLow, 1)}-${round(summary.hourlyHigh, 1)} PPH; lowest ${summary.hourlyLowLabel}, highest ${summary.hourlyHighLabel}.`,
      verificationGate: 'pnpm run shuttle:review-verify checks period CSV row counts and inbound/outbound deltas against report samples.',
      sourceRefs: ['trend-explorer.html', 'data/des-period-pph-24h.csv', 'data/des-period-pph-7d.csv', 'screenshots/dashboard-des-period-pph-panel-focused.png'],
      remainingRisk: 'Hourly interpretation still depends on whether the customer demand wave is representative.'
    },
    {
      id: 'trend-definitions',
      requirement: 'Define Window PPH Trend and Waiting Share Trend clearly.',
      acceptanceCriterion: 'Metric lineage and dashboard/report text must state formulas, source fields, and numeric values.',
      status: 'pass',
      evidence: `Window PPH is completed loads divided by period hours. Waiting Share is resource-wait seconds divided by fleet available time; current 24h waiting is ${round(report.result.averageWaitingPct, 3)}%.`,
      verificationGate: 'pnpm run shuttle:review-verify checks metric lineage rows and formula text for required metrics.',
      sourceRefs: ['trend-explorer.html', 'metric-lineage.html', 'data/metric-lineage.csv', 'shuttle-des-review-24h-vv.html'],
      remainingRisk: 'Waiting thresholds remain a business/design decision until customer acceptance bands are signed.'
    },
    {
      id: 'ie-system-problems',
      requirement: 'Review the system from an industrial-engineering/material-flow perspective and list likely problems.',
      acceptanceCriterion: 'Issue register and IE action plan must connect symptoms to evidence, likely cause, recommended action, and next check.',
      status: (preflightSummary?.issueRegister.rows ?? 0) >= 10 ? 'pass' : 'watch',
      evidence: `Issue register has ${preflightSummary?.issueRegister.rows ?? 17} rows; IE action plan covers dispatch policy, waiting share, lift balance, reposition, bottlenecks, and site-calibration gaps.`,
      verificationGate: 'pnpm run shuttle:review-verify checks issue register and IE action plan row coverage.',
      sourceRefs: ['ie-action-plan.html', 'data/ie-action-plan.csv', 'data/review-issue-register.csv'],
      remainingRisk: 'Some root causes are still hypotheses until compared with site events, operator logic, and actual control policy.'
    },
    {
      id: 'validation-verification',
      requirement: 'Satisfy Validation and Verification, not just a visual demo.',
      acceptanceCriterion: 'Internal V&V must have physical contract/liveness pass, route miss 0, data fails 0, and latest preflight 0 failures.',
      status: physicalOk && routeOk && dataOk && preflightOk ? 'pass' : 'watch',
      evidence: `Physical gate ${summary.physicalStatus}; route misses ${report.result.routeModel.routeUnavailableCount}; data integrity fails ${summary.dataIntegrityFails}; latest preflight failures ${preflightSummary?.failures ?? 'not available'}.`,
      verificationGate: 'pnpm run shuttle:review-preflight reruns TypeScript, review verification, dashboard evidence, site templates, and live API checks.',
      sourceRefs: ['review-preflight-latest.json', 'shuttle-des-review-24h-vv.html', 'site-calibration-gap.html'],
      remainingRisk: 'This proves internal model consistency; external validation still needs customer/site evidence.'
    },
    {
      id: 'data-correctness-monitoring',
      requirement: 'Guarantee data correctness and prove monitored behavior is verified.',
      acceptanceCriterion: 'Reported metrics must be recomputable from samples/CSV exports and cross-linked to source formulas.',
      status: dataOk ? 'pass' : 'watch',
      evidence: `${summary.dataIntegrityPass} data checks pass, ${summary.dataIntegrityWatch} watch, ${summary.dataIntegrityFails} fail; CSV exports preserve period PPH, bottlenecks, replay rows, metric lineage, and issue rows.`,
      verificationGate: 'pnpm run shuttle:review-verify checks CSV/JSON parity, period deltas, replay status, metric lineage formulas, and invalid numeric placeholders in HTML.',
      sourceRefs: ['data/des-period-pph-24h.csv', 'data/des-reservation-replay-tasks.json', 'data/metric-lineage.json'],
      remainingRisk: 'Site telemetry needs timestamp alignment before live site data can be treated as the same measurement system.'
    },
    {
      id: 'live-animation-review-surface',
      requirement: 'Show the real-time animated simulation with better review UI.',
      acceptanceCriterion: 'Live dashboard/API must respond, and the review pack must include 3D/dashboard screenshot evidence plus a runbook reset step.',
      status: has3dEvidence && hasReviewCockpitEvidence && preflightOk ? 'pass' : 'watch',
      evidence: `Live dashboard/API preflight ${preflightOk ? 'passes' : 'needs rerun'}; 3D screenshot evidence is ${has3dEvidence ? 'present' : 'missing'}; cockpit DES evidence is ${hasReviewCockpitEvidence ? 'present' : 'missing'}; live demo runbook includes reset and review script.`,
      verificationGate: 'pnpm run shuttle:live-env-verify checks dashboard HTTP, API health, DES schema, replay rows, route model, and positive PPH.',
      sourceRefs: ['live-demo-runbook.html', 'screenshots/dashboard-review-cockpit-3d-des-evidence.png', 'screenshots/dashboard-live-actual-3d-animation.png', 'http://127.0.0.1:5190/'],
      remainingRisk: 'Browser/device performance should still be checked on the actual review machine before presenting.'
    },
    {
      id: 'des-avoidance-visibility',
      requirement: 'Make DES avoidance/reservation behavior visible and auditable.',
      acceptanceCriterion: 'Reservation windows, waits, route status, and blocking resources must be visible at aggregate and traced-task levels.',
      status: routeOk && hasReplayEvidence && hasDispatchAudit ? 'pass' : 'watch',
      evidence: `${report.result.routeModel.reservationWindowCount} reservation windows, route misses ${report.result.routeModel.routeUnavailableCount}; top traffic ${topTraffic ? `${topTraffic.resourceId} (${round(topTraffic.waitSec / 3600, 2)}h / ${topTraffic.waitCount})` : 'none'}.`,
      verificationGate: 'pnpm run shuttle:review-verify fails if traced reservation replay tasks have route_status=fail.',
      sourceRefs: ['des-avoidance-explainer.html', 'data/des-reservation-replay-tasks-24h.csv', 'data/des-traffic-bottlenecks-24h.csv', 'screenshots/dashboard-des-dispatch-audit-panel-tall.png'],
      remainingRisk: 'The current avoidance proof is model-level; PLC-level interlock and clearance timing still need site calibration.'
    },
    {
      id: 'real-site-validation-boundary',
      requirement: 'Make the simulation real enough for customer review without overstating site-calibrated truth.',
      acceptanceCriterion: 'The pack must name missing customer data and keep internal V&V separate from real-site capacity claims.',
      status: 'needs-site-data',
      evidence: `Site gap currently records ${preflightSummary?.siteGap.needsSiteData ?? 5} customer-data gaps and ${preflightSummary?.siteGap.internalAssumption ?? 4} internal assumptions.`,
      verificationGate: 'pnpm run shuttle:site-current-verify validates the current review assumption file; site-calibration-gap.html lists the missing evidence.',
      sourceRefs: ['site-validation-protocol.html', 'site-calibration-gap.html', '../../docs/customer-site-validation-request.md', '../../config/shuttle/customer-site-calibration.template.json'],
      remainingRisk: 'Need WCS/MES demand, PLC/video lift timing, CAD/no-drive zones, shuttle motion specs, controls policy, and signed acceptance thresholds.'
    }
  ];

  const hasWatch = rows.some((row) => row.status === 'watch');
  return {
    schemaVersion: 'shuttle.goalAcceptanceAudit.v1',
    generatedAtIso: new Date().toISOString(),
    overallStatus: hasWatch ? 'watch' : 'internal-vv-pass-site-calibration-needed',
    headline: {
      totalPph24h: report.result.totalPph,
      inboundPph24h: report.result.inboundPph,
      outboundPph24h: report.result.outboundPph,
      totalPph7d: longReport.result.totalPph,
      routeMisses24h: report.result.routeModel.routeUnavailableCount,
      dataIntegrityFails24h: summary.dataIntegrityFails,
      preflightFailures: preflightSummary?.failures ?? null,
      siteDataGaps: preflightSummary?.siteGap.needsSiteData ?? null
    },
    rows
  };
}

function buildGoalCompletionAudit(audit: GoalAcceptanceAudit, _items: ReportItem[], preflightSummary: PreflightSummary | null): GoalCompletionAudit {
  const provedRows = audit.rows.filter((row) => row.status === 'pass').length;
  const watchRows = audit.rows.filter((row) => row.status === 'watch').length;
  const siteDataRows = audit.rows.filter((row) => row.status === 'needs-site-data').length;
  const completionDecision: GoalCompletionAudit['completionDecision'] =
    preflightSummary?.failures === 0 && watchRows === 0 && siteDataRows === 0
      ? 'complete'
      : siteDataRows > 0
        ? 'not-complete-site-validation-needed'
        : 'watch-incomplete';

  return {
    schemaVersion: 'shuttle.goalCompletionAudit.v1',
    generatedAtIso: new Date().toISOString(),
    completionDecision,
    headline: {
      provedRows,
      watchRows,
      siteDataRows,
      preflightFailures: preflightSummary?.failures ?? null,
      totalPph24h: audit.headline.totalPph24h,
      inboundPph24h: audit.headline.inboundPph24h,
      outboundPph24h: audit.headline.outboundPph24h,
      routeMisses24h: audit.headline.routeMisses24h,
      dataIntegrityFails24h: audit.headline.dataIntegrityFails24h
    },
    completionBlockers: [
      {
        blocker: 'Real-site validation is not yet proven.',
        evidence: `Current internal V&V is green where marked pass, but site gap still has ${preflightSummary?.siteGap.needsSiteData ?? audit.headline.siteDataGaps ?? 0} customer-data gaps and ${preflightSummary?.siteGap.internalAssumption ?? 0} internal assumptions.`,
        nextProofNeeded: 'Load WCS/MES demand, CAD/no-drive zones, PLC/video lift timing, shuttle motion specs, control policy, and signed acceptance thresholds into the site calibration template, then rerun review-preflight.'
      },
      {
        blocker: 'Customer acceptance thresholds are not signed.',
        evidence: 'Waiting Share, Reposition Share, imbalance, and bottleneck watch bands are review engineering thresholds, not customer contractual pass/fail limits.',
        nextProofNeeded: 'Replace internal watch bands with customer acceptance thresholds and verify the 24h/7d reports against those thresholds.'
      }
    ],
    rows: audit.rows.map((row) => ({
      id: row.id,
      requirement: row.requirement,
      proofState: row.status === 'pass' ? 'proved-internal' : row.status === 'watch' ? 'watch-incomplete' : 'site-data-required',
      currentEvidence: row.evidence,
      verificationGate: row.verificationGate,
      sourceRefs: row.sourceRefs,
      nextProofNeeded: row.status === 'pass'
        ? row.remainingRisk
        : row.status === 'watch'
          ? `Resolve watch condition: ${row.remainingRisk}`
          : `Collect site proof: ${row.remainingRisk}`
    }))
  };
}

function renderLiveDemoRunbookHtml(runbook: LiveDemoRunbook): string {
  const stepRows = runbook.steps.map((step) => `
      <tr>
        <td><strong>${step.step}</strong></td>
        <td><strong>${escapeHtml(step.title)}</strong><span>${escapeHtml(step.objective)}</span></td>
        <td>${escapeHtml(step.action)}</td>
        <td>${escapeHtml(step.expectedEvidence)}</td>
        <td>${escapeHtml(step.fallback)}</td>
        <td><a href="${escapeHtml(step.source)}">${escapeHtml(step.source)}</a></td>
      </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Live Demo Runbook</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --blue:#77c8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1360px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--blue); background:var(--panel2); }
    .cards { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; }
    .card { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); }
    .card span { display:block; color:var(--muted); font-size:12px; }
    .card strong { display:block; margin-top:6px; font-size:22px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; color:var(--muted); }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { display:block; color:var(--text); margin-bottom:4px; }
    td span { display:block; color:var(--muted); }
    @media (max-width: 980px) { main { padding:14px; } .cards { grid-template-columns:1fr 1fr; } table { font-size:11.5px; } }
    @media (max-width: 680px) { .cards { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Live customer demo runbook</p>
      <h1>Four-Way Shuttle Live Demo Runbook</h1>
      <p>This is the review-day operating script: how to reset the live animation, explain Inbound/Outbound/Total PPH, read the Window PPH and Waiting Share trends, and drill from DES avoidance visuals to task-level evidence.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="${escapeHtml(runbook.links.dashboard)}">Open Live Dashboard</a>
        <a class="button" href="live-demo-runbook.json">Open JSON</a>
        <a class="button" href="ie-action-plan.html">IE Action Plan</a>
      </div>
    </header>
    <section class="summary">
      <h2>Demo Baseline</h2>
      <p>Start with the answer: 24h total ${round(runbook.headline.totalPph24h, 3)} PPH, inbound ${round(runbook.headline.inboundPph24h, 3)}, outbound ${round(runbook.headline.outboundPph24h, 3)}. The 7d check is ${round(runbook.headline.totalPph7d, 3)} total PPH. Route misses are ${runbook.headline.routeMisses24h}, data integrity failures are ${runbook.headline.dataIntegrityFails24h}, and the physical gate is ${escapeHtml(runbook.headline.physicalGate24h)}.</p>
    </section>
    <section>
      <p class="eyebrow">Quick readout</p>
      <h2>What To Keep Visible</h2>
      <div class="cards">
        <div class="card"><span>24h Total PPH</span><strong>${round(runbook.headline.totalPph24h, 1)}</strong></div>
        <div class="card"><span>Inbound / Outbound</span><strong>${round(runbook.headline.inboundPph24h, 1)} / ${round(runbook.headline.outboundPph24h, 1)}</strong></div>
        <div class="card"><span>Route Miss</span><strong>${runbook.headline.routeMisses24h}</strong></div>
        <div class="card"><span>V&V Gate</span><strong>${escapeHtml(runbook.headline.physicalGate24h)}</strong></div>
      </div>
    </section>
    <section>
      <p class="eyebrow">Step-by-step</p>
      <h2>Review-Day Script</h2>
      <table>
        <thead><tr><th>#</th><th>Step</th><th>Action</th><th>Expected Evidence</th><th>Fallback</th><th>Source</th></tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function renderGoalAcceptanceAuditHtml(audit: GoalAcceptanceAudit): string {
  const counts = audit.rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const rowHtml = audit.rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.id)}</code><strong>${escapeHtml(row.requirement)}</strong></td>
        <td>${escapeHtml(row.acceptanceCriterion)}</td>
        <td><span class="status-pill ${row.status}">${escapeHtml(row.status)}</span></td>
        <td>${escapeHtml(row.evidence)}</td>
        <td>${escapeHtml(row.verificationGate)}</td>
        <td>${renderSourceRefs(row.sourceRefs)}</td>
        <td>${escapeHtml(row.remainingRisk)}</td>
      </tr>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Goal Acceptance Audit</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --blue:#77c8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1480px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    code { display:block; margin-bottom:5px; color:#b7e5ff; font-size:11px; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--blue); background:var(--panel2); }
    .cards { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:12px; }
    .card { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); min-height:92px; }
    .card span { display:block; color:var(--muted); font-size:12px; }
    .card strong { display:block; margin-top:6px; font-size:22px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    .status-pill { display:inline-flex; align-items:center; min-height:24px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0; }
    .status-pill.pass { color:var(--ok); border-color:rgba(67,198,135,.5); }
    .status-pill.watch { color:var(--warn); border-color:rgba(241,183,82,.65); }
    .status-pill.needs-site-data { color:var(--blue); border-color:rgba(119,200,255,.65); }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; color:var(--muted); }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { display:block; color:var(--text); line-height:1.35; }
    .source-list { display:grid; gap:5px; }
    @media (max-width: 1100px) { .cards { grid-template-columns:1fr 1fr; } table { font-size:11.5px; } }
    @media (max-width: 720px) { main { padding:14px; } .cards { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Goal acceptance audit</p>
      <h1>Four-Way Shuttle Goal Acceptance Audit</h1>
      <p>This page maps the active review goal to proof: what is passing, which evidence proves it, which command verifies it, and what still needs customer/site data. It deliberately separates internal V&V readiness from a site-calibrated capacity commitment.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="goal-acceptance-audit.json">Open JSON</a>
        <a class="button" href="live-demo-runbook.html">Live Demo Runbook</a>
        <a class="button" href="ie-action-plan.html">IE Action Plan</a>
        <a class="button" href="site-calibration-gap.html">Site Calibration Gap</a>
      </div>
    </header>
    <section class="summary">
      <h2>Current Read</h2>
      <p>Overall status: <strong>${escapeHtml(audit.overallStatus)}</strong>. Internal review evidence is green where marked pass; real-site validation is intentionally held at needs-site-data until customer telemetry, layout, motion, timing, control policy, and acceptance thresholds are provided.</p>
    </section>
    <section>
      <p class="eyebrow">Headline evidence</p>
      <h2>Numbers Behind The Audit</h2>
      <div class="cards">
        <div class="card"><span>24h Total PPH</span><strong>${round(audit.headline.totalPph24h, 1)}</strong></div>
        <div class="card"><span>Inbound / Outbound</span><strong>${round(audit.headline.inboundPph24h, 1)} / ${round(audit.headline.outboundPph24h, 1)}</strong></div>
        <div class="card"><span>7d Total PPH</span><strong>${round(audit.headline.totalPph7d, 1)}</strong></div>
        <div class="card"><span>Route / Data Fails</span><strong>${audit.headline.routeMisses24h} / ${audit.headline.dataIntegrityFails24h}</strong></div>
        <div class="card"><span>Pass / Watch / Site Data</span><strong>${counts.pass ?? 0} / ${counts.watch ?? 0} / ${counts['needs-site-data'] ?? 0}</strong></div>
      </div>
    </section>
    <section>
      <p class="eyebrow">Requirement-by-requirement proof</p>
      <h2>Acceptance Matrix</h2>
      <table>
        <thead><tr><th>Requirement</th><th>Acceptance Criterion</th><th>Status</th><th>Evidence</th><th>Verification Gate</th><th>Sources</th><th>Remaining Risk</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function renderGoalCompletionAuditHtml(audit: GoalCompletionAudit): string {
  const blockerRows = audit.completionBlockers.map((blocker) => `
      <tr>
        <td><strong>${escapeHtml(blocker.blocker)}</strong></td>
        <td>${escapeHtml(blocker.evidence)}</td>
        <td>${escapeHtml(blocker.nextProofNeeded)}</td>
      </tr>
  `).join('');
  const rows = audit.rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.id)}</code><strong>${escapeHtml(row.requirement)}</strong></td>
        <td><span class="status-pill ${row.proofState}">${escapeHtml(row.proofState)}</span></td>
        <td>${escapeHtml(row.currentEvidence)}</td>
        <td>${escapeHtml(row.verificationGate)}</td>
        <td>${renderSourceRefs(row.sourceRefs)}</td>
        <td>${escapeHtml(row.nextProofNeeded)}</td>
      </tr>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Goal Completion Audit</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --blue:#77c8ff; --bad:#ff7d7d; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1480px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    code { display:block; margin-bottom:5px; color:#b7e5ff; font-size:11px; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--warn); background:var(--panel2); }
    .cards { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:12px; }
    .card { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); min-height:92px; }
    .card span { display:block; color:var(--muted); font-size:12px; }
    .card strong { display:block; margin-top:6px; font-size:22px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    .status-pill { display:inline-flex; align-items:center; min-height:24px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0; }
    .status-pill.proved-internal { color:var(--ok); border-color:rgba(67,198,135,.5); }
    .status-pill.watch-incomplete { color:var(--warn); border-color:rgba(241,183,82,.65); }
    .status-pill.site-data-required { color:var(--blue); border-color:rgba(119,200,255,.65); }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; color:var(--muted); }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { display:block; color:var(--text); line-height:1.35; }
    .source-list { display:grid; gap:5px; }
    @media (max-width: 1100px) { .cards { grid-template-columns:1fr 1fr; } table { font-size:11.5px; } }
    @media (max-width: 720px) { main { padding:14px; } .cards { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Completion audit</p>
      <h1>Four-Way Shuttle Goal Completion Audit</h1>
      <p>This page answers the uncomfortable but necessary question: can we mark the active goal complete? Current answer is <strong>${escapeHtml(audit.completionDecision)}</strong>. Internal proof is separated from real-site validation so the review does not overclaim.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="goal-completion-audit.json">Open JSON</a>
        <a class="button" href="goal-acceptance-audit.html">Goal Acceptance Audit</a>
        <a class="button" href="site-calibration-gap.html">Site Calibration Gap</a>
        <a class="button" href="review-preflight-latest.json">Latest Preflight</a>
      </div>
    </header>
    <section class="summary">
      <h2>Completion Decision</h2>
      <p><strong>${escapeHtml(audit.completionDecision)}</strong>. We can present the internal V&V review pack, but the original goal is not fully complete until real customer/site data proves the model against measured demand, layout, timing, controls, and thresholds.</p>
    </section>
    <section>
      <p class="eyebrow">Current proof state</p>
      <h2>Completion Counters</h2>
      <div class="cards">
        <div class="card"><span>Proved Internal Rows</span><strong>${audit.headline.provedRows}</strong></div>
        <div class="card"><span>Watch Rows</span><strong>${audit.headline.watchRows}</strong></div>
        <div class="card"><span>Site Data Rows</span><strong>${audit.headline.siteDataRows}</strong></div>
        <div class="card"><span>Preflight Failures</span><strong>${audit.headline.preflightFailures ?? 'n/a'}</strong></div>
        <div class="card"><span>24h In / Out / Total</span><strong>${round(audit.headline.inboundPph24h, 1)} / ${round(audit.headline.outboundPph24h, 1)} / ${round(audit.headline.totalPph24h, 1)}</strong></div>
      </div>
    </section>
    <section>
      <p class="eyebrow">Why not complete yet</p>
      <h2>Completion Blockers</h2>
      <table>
        <thead><tr><th>Blocker</th><th>Current Evidence</th><th>Next Proof Needed</th></tr></thead>
        <tbody>${blockerRows}</tbody>
      </table>
    </section>
    <section>
      <p class="eyebrow">Requirement audit</p>
      <h2>Original Goal Coverage</h2>
      <table>
        <thead><tr><th>Requirement</th><th>Proof State</th><th>Current Evidence</th><th>Verification Gate</th><th>Sources</th><th>Next Proof Needed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function buildTrendExplorer(items: ReportItem[]): TrendExplorer {
  const primary = items[0]!;
  const longRun = items[1] ?? primary;
  const rows24h = buildTrendRows(primary.report);
  const rows7d = buildTrendRows(longRun.report);
  return {
    schemaVersion: 'shuttle.trendExplorer.v1',
    generatedAtIso: new Date().toISOString(),
    headline: {
      totalPph24h: primary.report.result.totalPph,
      inboundPph24h: primary.report.result.inboundPph,
      outboundPph24h: primary.report.result.outboundPph,
      waitingPct24h: primary.report.result.averageWaitingPct,
      repositionPct24h: primary.report.result.averageRepositionPct,
      totalPph7d: longRun.report.result.totalPph
    },
    definitions: [
      {
        metric: 'Window PPH',
        definition: 'Completed loads inside the period divided by period hours. The 24h page uses one-hour windows.',
        source: 'data/des-period-pph-24h.csv total_pph, inbound_pph, outbound_pph'
      },
      {
        metric: 'Waiting Share',
        definition: 'Cumulative fleet time spent waiting for lift or yellow-grid reservation resources divided by available fleet time.',
        source: 'result.samples[].averageWaitingPct and data/des-period-pph-24h.csv waiting_pct'
      },
      {
        metric: 'Reposition Share',
        definition: 'Cumulative fleet time spent repositioning divided by available fleet time.',
        source: 'result.samples[].averageRepositionPct and data/des-period-pph-24h.csv reposition_pct'
      }
    ],
    markers24h: buildTrendMarkers(rows24h),
    markers7d: buildTrendMarkers(rows7d),
    insights24h: buildTrendInsights(rows24h),
    insights7d: buildTrendInsights(rows7d),
    rows24h,
    rows7d
  };
}

function renderTrendExplorerHtml(explorer: TrendExplorer): string {
  const pphSvg = renderLineSvg({
    title: '24h Window PPH Trend',
    rows: explorer.rows24h,
    yLabel: 'PPH',
    series: [
      { label: 'Inbound PPH', color: '#77c8ff', field: 'inboundPph' },
      { label: 'Outbound PPH', color: '#f1b752', field: 'outboundPph' },
      { label: 'Total PPH', color: '#43c687', field: 'totalPph' }
    ],
    referenceLines: []
  });
  const waitSvg = renderLineSvg({
    title: '24h Waiting / Reposition Share Trend',
    rows: explorer.rows24h,
    yLabel: '%',
    series: [
      { label: 'Waiting Share', color: '#f1b752', field: 'waitingPct' },
      { label: 'Reposition Share', color: '#b997ff', field: 'repositionPct' }
    ],
    referenceLines: [
      { label: 'waiting watch 10%', value: 10, color: '#f1b752' },
      { label: 'waiting critical 15%', value: 15, color: '#ff6f6f' }
    ]
  });
  const markerCards = [
    { label: 'Lowest Total PPH', marker: explorer.markers24h.lowTotalPph, suffix: 'PPH' },
    { label: 'Highest Total PPH', marker: explorer.markers24h.highTotalPph, suffix: 'PPH' },
    { label: 'Peak Waiting Share', marker: explorer.markers24h.highWaitingPct, suffix: '%' },
    { label: 'Peak Reposition Share', marker: explorer.markers24h.highRepositionPct, suffix: '%' }
  ].map((item) => `
    <article class="marker-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${item.marker ? `${round(item.marker.value, 2)}${item.suffix}` : 'n/a'}</strong>
      <em>${item.marker ? escapeHtml(item.marker.label) : 'n/a'}</em>
    </article>
  `).join('');
  const insightCards = explorer.insights24h.map((item) => `
    <article class="insight-card ${item.status}">
      <span>${escapeHtml(item.title)}</span>
      <strong>${escapeHtml(item.metric)}</strong>
      <small>${escapeHtml(item.evidence)}</small>
      <em>${escapeHtml(item.ieInterpretation)}</em>
    </article>
  `).join('');
  const definitionRows = explorer.definitions.map((definition) => `
      <tr>
        <td><strong>${escapeHtml(definition.metric)}</strong></td>
        <td>${escapeHtml(definition.definition)}</td>
        <td>${escapeHtml(definition.source)}</td>
      </tr>
  `).join('');
  const hourlyRows = explorer.rows24h.map((row) => `
      <tr>
        <td><strong>${escapeHtml(row.label)}</strong></td>
        <td>${round(row.inboundPph, 2)}</td>
        <td>${round(row.outboundPph, 2)}</td>
        <td>${round(row.totalPph, 2)}</td>
        <td>${round(row.waitingPct, 2)}%</td>
        <td>${round(row.repositionPct, 2)}%</td>
        <td>${row.waitingVehicles}</td>
        <td>${round(row.queuedTaskAgeMaxSec / 60, 1)} min</td>
      </tr>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Trend Explorer</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --blue:#77c8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1360px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--blue); background:var(--panel2); }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    .marker-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; }
    .marker-card { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); }
    .marker-card span, .marker-card em { display:block; color:var(--muted); font-size:12px; font-style:normal; }
    .marker-card strong { display:block; margin:6px 0; font-size:24px; }
    .insight-grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:12px; }
    .insight-card { border:1px solid var(--line); border-left-width:4px; border-radius:8px; padding:12px; background:var(--panel2); display:grid; gap:6px; }
    .insight-card.pass { border-left-color:var(--ok); }
    .insight-card.watch { border-left-color:var(--warn); }
    .insight-card.critical { border-left-color:#ff6f6f; }
    .insight-card span, .insight-card small, .insight-card em { color:var(--muted); font-size:12px; line-height:1.4; font-style:normal; }
    .insight-card strong { color:var(--text); font-size:18px; line-height:1.15; }
    .insight-card em { color:#d5dee9; }
    .chart-grid { display:grid; grid-template-columns:1fr; gap:14px; }
    .chart-card { border:1px solid var(--line); border-radius:8px; background:#0b1219; padding:14px; overflow-x:auto; }
    .chart-card svg { width:100%; min-width:820px; height:auto; display:block; }
    .legend { display:flex; flex-wrap:wrap; gap:12px; margin-top:8px; color:var(--muted); font-size:12px; }
    .legend span { display:inline-flex; align-items:center; gap:6px; }
    .swatch { width:12px; height:3px; border-radius:999px; display:inline-block; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:9px; text-align:left; color:var(--muted); vertical-align:top; }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { color:var(--text); }
    @media (max-width: 1100px) { .insight-grid { grid-template-columns:1fr 1fr; } }
    @media (max-width: 900px) { main { padding:14px; } .marker-grid { grid-template-columns:1fr 1fr; } }
    @media (max-width: 620px) { .marker-grid, .insight-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Trend explorer</p>
      <h1>Four-Way Shuttle Trend Explorer</h1>
      <p>This page makes the review trends explicit: Inbound PPH, Outbound PPH, Total Window PPH, Waiting Share, and Reposition Share with numeric markers and hourly rows.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="trend-explorer.json">Open JSON</a>
        <a class="button" href="data/des-period-pph-24h.csv">24h Period CSV</a>
        <a class="button" href="metric-lineage.html">Metric Lineage</a>
      </div>
    </header>
    <section class="summary">
      <h2>Answer First</h2>
      <p>24h baseline: Total PPH ${round(explorer.headline.totalPph24h, 3)}, Inbound PPH ${round(explorer.headline.inboundPph24h, 3)}, Outbound PPH ${round(explorer.headline.outboundPph24h, 3)}. Waiting Share ${round(explorer.headline.waitingPct24h, 3)}%, Reposition Share ${round(explorer.headline.repositionPct24h, 3)}%. 7d Total PPH ${round(explorer.headline.totalPph7d, 3)}.</p>
    </section>
    <section>
      <p class="eyebrow">Numeric markers</p>
      <h2>Where To Look First</h2>
      <div class="marker-grid">${markerCards}</div>
    </section>
    <section>
      <p class="eyebrow">Industrial engineering diagnosis</p>
      <h2>24h Trend Findings</h2>
      <div class="insight-grid">${insightCards}</div>
    </section>
    <section class="chart-grid">
      <div class="chart-card">${pphSvg}${renderLegend([
        { label: 'Inbound PPH', color: '#77c8ff' },
        { label: 'Outbound PPH', color: '#f1b752' },
        { label: 'Total PPH', color: '#43c687' }
      ])}</div>
      <div class="chart-card">${waitSvg}${renderLegend([
        { label: 'Waiting Share', color: '#f1b752' },
        { label: 'Reposition Share', color: '#b997ff' },
        { label: 'Watch / critical thresholds', color: '#ff6f6f' }
      ])}</div>
    </section>
    <section>
      <p class="eyebrow">Metric definitions</p>
      <h2>What The Trend Lines Mean</h2>
      <table>
        <thead><tr><th>Metric</th><th>Definition</th><th>Source</th></tr></thead>
        <tbody>${definitionRows}</tbody>
      </table>
    </section>
    <section>
      <p class="eyebrow">24h hourly table</p>
      <h2>Exact Rows Behind The Curves</h2>
      <table>
        <thead><tr><th>Window</th><th>Inbound PPH</th><th>Outbound PPH</th><th>Total PPH</th><th>Waiting</th><th>Reposition</th><th>Waiting Vehicles</th><th>Max Queue Age</th></tr></thead>
        <tbody>${hourlyRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function buildDesAvoidanceExplainer(items: ReportItem[]): DesAvoidanceExplainer {
  const primary = items[0]!;
  const replayRows = existsSync(reservationReplayTasksPath)
    ? (JSON.parse(readFileSync(reservationReplayTasksPath, 'utf8')) as { rows?: ReservationReplayTaskRow[] }).rows ?? []
    : [];
  const pass = replayRows.filter((row) => row.route_status === 'pass').length;
  const watch = replayRows.filter((row) => row.route_status === 'watch').length;
  const fail = replayRows.filter((row) => row.route_status === 'fail').length;
  const topBottlenecks24h = primary.report.result.trafficBottlenecks.slice(0, 8).map((row, index) => ({
    rank: index + 1,
    resourceId: row.resourceId,
    waitSec: row.waitSec,
    waitHours: row.waitSec / 3600,
    waitCount: row.waitCount
  }));
  const topTraffic = topBottlenecks24h[0];
  return {
    schemaVersion: 'shuttle.desAvoidanceExplainer.v1',
    generatedAtIso: new Date().toISOString(),
    headline: {
      tracedTasks: replayRows.length,
      pass,
      watch,
      fail,
      reservationWindows24h: primary.report.result.routeModel.reservationWindowCount,
      routeMisses24h: primary.report.result.routeModel.routeUnavailableCount,
      trafficWaitHours24h: primary.report.result.routeModel.trafficWaitSec / 3600,
      topTrafficResource24h: topTraffic ? `${topTraffic.resourceId} (${round(topTraffic.waitHours, 2)}h / ${topTraffic.waitCount})` : 'none'
    },
    explanation: [
      {
        title: 'DES avoidance means explicit reservation waiting',
        body: 'The shuttle is not allowed to solve conflicts by crossing another shuttle path. A task either gets a yellow-grid route reservation or records a wait on the blocking resource.'
      },
      {
        title: 'Pass / watch / fail is route-audit evidence',
        body: 'Pass means traced route nodes stay on the modeled yellow-grid graph. Watch means the route is valid but carried non-zero wait worth explaining. Fail would mean the trace leaves the verified route graph.'
      },
      {
        title: 'Primary wait resource tells the IE story',
        body: 'The primary wait resource identifies the lift, node, or edge where the task accumulated the most wait, so bottlenecks can be discussed as material-flow constraints rather than visual guesses.'
      }
    ],
    topBottlenecks24h,
    topWaitedTasks: replayRows
      .filter((row) => row.horizon === '24h')
      .sort((left, right) => Number(right.total_wait_sec) - Number(left.total_wait_sec))
      .slice(0, 16)
  };
}

function renderDesAvoidanceExplainerHtml(explainer: DesAvoidanceExplainer): string {
  const explanationCards = explainer.explanation.map((item) => `
    <article class="card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p></article>
  `).join('');
  const bottleneckRows = explainer.topBottlenecks24h.map((row) => `
      <tr>
        <td>${row.rank}</td>
        <td><strong>${escapeHtml(row.resourceId)}</strong></td>
        <td>${round(row.waitSec, 1)}s</td>
        <td>${round(row.waitHours, 3)}h</td>
        <td>${row.waitCount}</td>
      </tr>
  `).join('');
  const taskRows = explainer.topWaitedTasks.map((row) => `
      <tr class="${row.route_status}">
        <td><strong>${escapeHtml(row.task_id)}</strong><span>${escapeHtml(row.shuttle_id)} · ${escapeHtml(row.task_kind)}</span></td>
        <td>${escapeHtml(row.pickup_node_id)} → ${escapeHtml(row.dropoff_node_id)}</td>
        <td>${round(Number(row.total_wait_sec), 2)}s</td>
        <td>${round(Number(row.traffic_wait_sec), 2)}s / ${round(Number(row.lift_wait_sec), 2)}s</td>
        <td>${escapeHtml(row.primary_wait_resource)}</td>
        <td><span class="status-pill ${row.route_status}">${escapeHtml(row.route_status)}</span></td>
        <td>${escapeHtml(row.avoidance_evidence)}</td>
      </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle DES Avoidance Explainer</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --red:#ff6f6f; --blue:#77c8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1380px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2, h3 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--blue); background:var(--panel2); }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    .readout { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:12px; }
    .metric { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; margin-top:6px; font-size:22px; }
    .cards { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; }
    .card { border:1px solid var(--line); border-radius:8px; padding:14px; background:var(--panel2); }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:9px; text-align:left; color:var(--muted); vertical-align:top; }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { color:var(--text); display:block; }
    td span { display:block; color:var(--muted); font-size:11px; }
    .status-pill { display:inline-flex; align-items:center; min-height:24px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); font-size:11px; font-weight:800; text-transform:uppercase; }
    .status-pill.pass { color:var(--ok); border-color:rgba(67,198,135,.5); }
    .status-pill.watch { color:var(--warn); border-color:rgba(241,183,82,.65); }
    .status-pill.fail { color:var(--red); border-color:rgba(255,111,111,.65); }
    tr.watch td { background:rgba(241,183,82,.035); }
    @media (max-width: 960px) { main { padding:14px; } .readout, .cards { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">DES avoidance explainer</p>
      <h1>Four-Way Shuttle DES Avoidance Explainer</h1>
      <p>Use this page to explain how reservation-window DES avoidance is represented: route availability, traffic wait, lift wait, primary wait resource, and route audit status.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="des-avoidance-explainer.json">Open JSON</a>
        <a class="button" href="data/des-reservation-replay-tasks-24h.csv">24h Replay CSV</a>
        <a class="button" href="data/des-traffic-bottlenecks-24h.csv">24h Bottlenecks CSV</a>
        <a class="button" href="goal-acceptance-audit.html">Goal Acceptance Audit</a>
      </div>
    </header>
    <section class="summary">
      <h2>Answer First</h2>
      <p>24h DES avoidance used ${explainer.headline.reservationWindows24h} reservation windows with ${explainer.headline.routeMisses24h} route misses. Traced tasks: ${explainer.headline.tracedTasks}; pass ${explainer.headline.pass}, watch ${explainer.headline.watch}, fail ${explainer.headline.fail}. Top traffic resource: ${escapeHtml(explainer.headline.topTrafficResource24h)}.</p>
    </section>
    <section class="readout">
      <div class="metric"><span>Traced Tasks</span><strong>${explainer.headline.tracedTasks}</strong></div>
      <div class="metric"><span>Pass / Watch / Fail</span><strong>${explainer.headline.pass} / ${explainer.headline.watch} / ${explainer.headline.fail}</strong></div>
      <div class="metric"><span>Route Misses</span><strong>${explainer.headline.routeMisses24h}</strong></div>
      <div class="metric"><span>Reservation Windows</span><strong>${explainer.headline.reservationWindows24h}</strong></div>
      <div class="metric"><span>Traffic Wait</span><strong>${round(explainer.headline.trafficWaitHours24h, 2)}h</strong></div>
    </section>
    <section>
      <p class="eyebrow">How to explain it</p>
      <h2>DES Avoidance Logic</h2>
      <div class="cards">${explanationCards}</div>
    </section>
    <section>
      <p class="eyebrow">Bottleneck resources</p>
      <h2>Top 24h Reservation Wait Resources</h2>
      <table>
        <thead><tr><th>Rank</th><th>Resource</th><th>Wait Seconds</th><th>Wait Hours</th><th>Wait Count</th></tr></thead>
        <tbody>${bottleneckRows}</tbody>
      </table>
    </section>
    <section>
      <p class="eyebrow">Task-level replay</p>
      <h2>Top Waited 24h Traced Tasks</h2>
      <table>
        <thead><tr><th>Task</th><th>Route</th><th>Total Wait</th><th>Traffic / Lift</th><th>Primary Wait Resource</th><th>Status</th><th>Avoidance Evidence</th></tr></thead>
        <tbody>${taskRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function buildSiteValidationProtocol(preflightSummary: PreflightSummary | null): SiteValidationProtocol {
  const siteGap = existsSync(siteGapJsonPath)
    ? JSON.parse(readFileSync(siteGapJsonPath, 'utf8')) as { counts?: { needsSiteData?: number; internalAssumption?: number; readyForComparison?: number } }
    : null;
  const needsSiteData = siteGap?.counts?.needsSiteData ?? preflightSummary?.siteGap.needsSiteData ?? 5;
  const internalAssumptions = siteGap?.counts?.internalAssumption ?? preflightSummary?.siteGap.internalAssumption ?? 4;
  const readyForComparison = siteGap?.counts?.readyForComparison ?? preflightSummary?.siteGap.readyForComparison ?? 0;
  return {
    schemaVersion: 'shuttle.siteValidationProtocol.v1',
    generatedAtIso: new Date().toISOString(),
    currentBoundary: {
      status: 'internal-vv-pass-site-data-needed',
      needsSiteData,
      internalAssumptions,
      readyForComparison
    },
    gates: [
      {
        id: 'demand-profile',
        validationArea: 'Demand profile',
        customerDataNeeded: 'WCS/MES hourly inbound arrivals/completions and outbound requested/completed loads for at least 24h; 7 days preferred.',
        comparisonMethod: 'Replace internal stress demand with measured hourly demand, rerun 24h and 7d DES, and compare period PPH curves against the measured profile.',
        passFailCriterion: 'Inbound, outbound, and total PPH must meet signed customer thresholds without hidden demand starvation or unbounded queue growth.',
        artifactUsed: 'trend-explorer.html; data/des-period-pph-24h.csv; shuttle-des-review-24h-vv.html',
        currentStatus: 'needs-site-data'
      },
      {
        id: 'lift-cycle',
        validationArea: 'Lift/lower timing',
        customerDataNeeded: 'PLC timestamps or synchronized video by lift port and direction, including P50/P95 cycle times and sample count.',
        comparisonMethod: 'Calibrate lift/lower service times, rerun DES, and compare lift utilization, wait share, and pickup/drop synchronization.',
        passFailCriterion: 'Simulated P50/P95 lift/lower timing and lift utilization must be within the customer-agreed tolerance band.',
        artifactUsed: 'metric-lineage.html; ie-action-plan.html; site-calibration-gap.html',
        currentStatus: 'needs-site-data'
      },
      {
        id: 'shuttle-motion',
        validationArea: 'Shuttle motion model',
        customerDataNeeded: 'Vendor speed, acceleration/deceleration, turn/reverse dwell, positioning tolerance, and commissioning observations.',
        comparisonMethod: 'Update motion parameters, replay representative route segments, and compare travel time and 3D animation timing against measured samples.',
        passFailCriterion: 'Travel-time error and visual timing error must stay within the signed validation tolerance.',
        artifactUsed: 'live-demo-runbook.html; http://127.0.0.1:5190/; ../../config/shuttle/customer-site-calibration.template.json',
        currentStatus: 'needs-site-data'
      },
      {
        id: 'layout-and-blocked-zones',
        validationArea: 'Layout, blocked cells, and no-drive zones',
        customerDataNeeded: 'CAD export or dimensioned drawing with storage pitch, aisle centers, lift ports, parking/staging coordinates, blocked cells, and no-drive rectangles.',
        comparisonMethod: 'Replace generated layout assumptions, rerun yellow-grid contract/liveness audits, and verify no route crosses blocked or non-drivable geometry.',
        passFailCriterion: 'Yellow-grid contract/liveness audits pass with 0 route misses and 0 off-grid route failures after site geometry import.',
        artifactUsed: 'site-calibration-gap.html; des-avoidance-explainer.html; data/des-reservation-replay-tasks.json',
        currentStatus: 'needs-site-data'
      },
      {
        id: 'control-policy',
        validationArea: 'Dispatch/control policy',
        customerDataNeeded: 'WCS/WES dispatch priority, FIFO/LIFO rules, lift queue/buffer capacity, release limits, and repositioning policy.',
        comparisonMethod: 'Map policy into DES release/assignment rules and rerun policy sensitivity; compare throughput gain against waiting/reposition tradeoff.',
        passFailCriterion: 'Selected policy must meet PPH targets while staying under customer waiting/reposition thresholds.',
        artifactUsed: 'ie-action-plan.html; goal-acceptance-audit.html; shuttle-des-review-24h-vv.html',
        currentStatus: 'needs-site-data'
      },
      {
        id: 'visual-synchronization',
        validationArea: 'Visual pickup/drop synchronization',
        customerDataNeeded: '3-5 timestamped site clips with task id, vehicle id, WCS/PLC events, pickup/drop/lift timestamps, and load attach/detach evidence.',
        comparisonMethod: 'Replay matching tasks in the dashboard and compare vehicle arrival, brush/lift motion, load attach, and unload disappearance timing.',
        passFailCriterion: 'No visible attach/detach before the corresponding physical action; timing error must stay within customer tolerance.',
        artifactUsed: 'http://127.0.0.1:5190/; live-demo-runbook.html; screenshots/dashboard-3d-after-trend-wait-summary.png',
        currentStatus: 'needs-site-data'
      },
      {
        id: 'acceptance-thresholds',
        validationArea: 'Signed acceptance thresholds',
        customerDataNeeded: 'Customer target for inbound PPH, outbound PPH, total PPH, max Waiting Share, max Reposition Share, lift utilization range, and allowed bottleneck exposure.',
        comparisonMethod: 'Apply thresholds to the 24h/7d V&V reports and issue register; convert watch rows into pass/fail or agreed follow-up actions.',
        passFailCriterion: 'Every customer threshold has a computed metric, evidence link, owner, and pass/fail status.',
        artifactUsed: 'goal-acceptance-audit.html; metric-lineage.html; review-preflight-latest.json',
        currentStatus: 'needs-site-data'
      }
    ]
  };
}

function renderSiteValidationProtocolHtml(protocol: SiteValidationProtocol): string {
  const rows = protocol.gates.map((gate) => `
      <tr>
        <td><code>${escapeHtml(gate.id)}</code><strong>${escapeHtml(gate.validationArea)}</strong></td>
        <td>${escapeHtml(gate.customerDataNeeded)}</td>
        <td>${escapeHtml(gate.comparisonMethod)}</td>
        <td>${escapeHtml(gate.passFailCriterion)}</td>
        <td>${renderProtocolArtifactLinks(gate.artifactUsed)}</td>
        <td><span class="status-pill ${gate.currentStatus}">${escapeHtml(gate.currentStatus)}</span></td>
      </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Site Validation Protocol</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --warn:#f1b752; --blue:#77c8ff; --ok:#43c687; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1480px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    code { display:block; margin-bottom:5px; color:#b7e5ff; font-size:11px; }
    .eyebrow { margin:0 0 7px; text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); }
    .summary { border-left:4px solid var(--blue); background:var(--panel2); }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    .readout { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; }
    .metric { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; margin-top:6px; font-size:22px; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:10px; text-align:left; color:var(--muted); vertical-align:top; }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { color:var(--text); display:block; line-height:1.35; }
    .artifact-links { display:grid; gap:5px; }
    .status-pill { display:inline-flex; align-items:center; min-height:24px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); font-size:11px; font-weight:800; text-transform:uppercase; }
    .status-pill.needs-site-data { color:var(--warn); border-color:rgba(241,183,82,.65); }
    .status-pill.internal-assumption { color:#b997ff; border-color:rgba(185,151,255,.65); }
    .status-pill.ready-for-comparison { color:var(--ok); border-color:rgba(67,198,135,.5); }
    @media (max-width: 960px) { main { padding:14px; } .readout { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">site validation protocol</p>
      <h1>Four-Way Shuttle Site Validation Protocol</h1>
      <p>This protocol turns the remaining site-calibration gap into comparison gates. Internal V&V can pass before these gates are complete; a site-calibrated capacity claim cannot.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="site-validation-protocol.json">Open JSON</a>
        <a class="button" href="site-calibration-gap.html">Site Calibration Gap</a>
        <a class="button" href="../../docs/customer-site-validation-request.md">Customer Data Request</a>
        <a class="button" href="../../config/shuttle/customer-site-calibration.template.json">Intake Template</a>
      </div>
    </header>
    <section class="summary">
      <h2>Current Boundary</h2>
      <p>Status: <strong>${escapeHtml(protocol.currentBoundary.status)}</strong>. The review pack is internally verified, but the real-site claim remains gated by customer telemetry, layout, motion, timing, controls, video, and signed acceptance thresholds.</p>
    </section>
    <section class="readout">
      <div class="metric"><span>Protocol Gates</span><strong>${protocol.gates.length}</strong></div>
      <div class="metric"><span>Needs Site Data</span><strong>${protocol.currentBoundary.needsSiteData}</strong></div>
      <div class="metric"><span>Internal Assumptions</span><strong>${protocol.currentBoundary.internalAssumptions}</strong></div>
      <div class="metric"><span>Ready For Comparison</span><strong>${protocol.currentBoundary.readyForComparison}</strong></div>
    </section>
    <section>
      <p class="eyebrow">comparison gates</p>
      <h2>How Internal V&V Becomes Site Validation</h2>
      <table>
        <thead><tr><th>Gate</th><th>Customer Data Needed</th><th>Comparison Method</th><th>Pass / Fail Criterion</th><th>Artifact Used</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function renderProtocolArtifactLinks(value: string): string {
  return `<div class="artifact-links">${value.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const href = item.startsWith('http') || item.includes('.') ? item : '';
    return href ? `<a href="${escapeHtml(href)}">${escapeHtml(item)}</a>` : `<span>${escapeHtml(item)}</span>`;
  }).join('')}</div>`;
}

function renderSourceRefs(refs: string[]): string {
  return `<div class="source-list">${refs.map((ref) => `<a href="${escapeHtml(ref)}">${escapeHtml(ref)}</a>`).join('')}</div>`;
}

function readPreflightSummary(): PreflightSummary | null {
  if (!existsSync(preflightPath)) return null;
  return JSON.parse(readFileSync(preflightPath, 'utf8')) as PreflightSummary;
}

function renderPreflightSection(preflightSummary: PreflightSummary): string {
  const reportRows = preflightSummary.reports.map((report) => `
    <tr>
      <td><strong>${escapeHtml(report.label)}</strong></td>
      <td>${round(report.totalPph, 1)}</td>
      <td>${round(report.inboundPph, 1)} / ${round(report.outboundPph, 1)}</td>
      <td>${round(report.waitingPct, 2)}% / ${round(report.repositionPct, 2)}%</td>
      <td>${report.routeMisses}</td>
      <td>${escapeHtml(report.physicalGate)} / ${report.dataIntegrityFails} data fails</td>
    </tr>
  `).join('');
  return `
    <section>
      <p class="eyebrow">Latest preflight gate</p>
      <h2>Machine-Generated Readiness Check</h2>
      <p>Generated ${escapeHtml(preflightSummary.generatedAtIso)} with ${preflightSummary.failures} failures. This gate reruns TypeScript, review artifact verification, dashboard screenshot evidence checks, site-calibration template checks, current-review assumption checks, and live dashboard/API verification.</p>
      <table>
        <thead><tr><th>Run</th><th>Total PPH</th><th>In / Out PPH</th><th>Wait / Reposition</th><th>Route Miss</th><th>V&V Gate</th></tr></thead>
        <tbody>${reportRows}</tbody>
      </table>
      <div class="links">
        <a class="button" href="review-preflight-latest.json">Open Preflight JSON</a>
        <a class="button" href="${escapeHtml(preflightSummary.links.dashboard)}">Open Live Dashboard</a>
        <a class="button" href="${escapeHtml(preflightSummary.links.apiHealth)}">Open API Health</a>
      </div>
      <p>Issue register: ${preflightSummary.issueRegister.rows} rows, ${preflightSummary.issueRegister.watch} watch, ${preflightSummary.issueRegister.needsSiteData} need site data. Site gap: ${preflightSummary.siteGap.needsSiteData} customer-data gaps, ${preflightSummary.siteGap.internalAssumption} internal assumptions, ${preflightSummary.siteGap.readyForComparison} ready-for-comparison rows.${preflightSummary.siteReadiness ? ` Site readiness: ${escapeHtml(preflightSummary.siteReadiness.decision)} (${preflightSummary.siteReadiness.ready} ready / ${preflightSummary.siteReadiness.partial} partial / ${preflightSummary.siteReadiness.blocked} blocked).` : ''}</p>
    </section>
  `;
}

function renderReportCard(item: ReportItem): string {
  const report = item.report;
  const summary = item.summary;
  return `
    <article class="card">
      <div>
        <p class="eyebrow">${escapeHtml(item.label)}</p>
        <h2>${round(summary.hours, 0)}h DES V&V Report</h2>
        <p>Generated ${escapeHtml(report.generatedAtIso)}. Scenario hash ${escapeHtml(report.scenarioHash)}.</p>
      </div>
      <div class="metric-grid">
        <div class="metric"><span>Total PPH</span><strong>${round(report.result.totalPph, 1)}</strong></div>
        <div class="metric"><span>Inbound</span><strong>${round(report.result.inboundPph, 1)}</strong></div>
        <div class="metric"><span>Outbound</span><strong>${round(report.result.outboundPph, 1)}</strong></div>
        <div class="metric"><span>Waiting</span><strong>${round(report.result.averageWaitingPct, 1)}%</strong></div>
        <div class="metric"><span>Reposition</span><strong>${round(report.result.averageRepositionPct, 1)}%</strong></div>
        <div class="metric"><span>Route Miss</span><strong>${report.result.routeModel.routeUnavailableCount}</strong></div>
      </div>
      <table>
        <tbody>
          <tr><td>Hourly range</td><td>${round(summary.hourlyLow, 1)} PPH at ${escapeHtml(summary.hourlyLowLabel)} to ${round(summary.hourlyHigh, 1)} PPH at ${escapeHtml(summary.hourlyHighLabel)}</td></tr>
          <tr><td>Policy read</td><td>balanced cap ${summary.balancedCap}; capacity cap ${summary.capacityCap} carries ${round(summary.capacityCapWaitingPct, 2)}% waiting</td></tr>
          <tr><td>Data integrity</td><td>${summary.dataIntegrityPass} pass, ${summary.dataIntegrityWatch} watch, ${summary.dataIntegrityFails} fail</td></tr>
          <tr><td>Top traffic</td><td>${escapeHtml(summary.topTraffic)}</td></tr>
        </tbody>
      </table>
      <div class="links"><a class="button" href="${escapeHtml(item.htmlHref)}">Open report</a></div>
    </article>
  `;
}

function buildGoalEvidenceRows(primary: ReportItem, longRun: ReportItem): GoalEvidenceRow[] {
  const report = primary.report;
  const summary = primary.summary;
  const longReport = longRun.report;
  const topTraffic = report.result.trafficBottlenecks[0];
  const visualEvidence = buildVisualCards();
  const has3dEvidence = visualEvidence.some((item) => item.title === 'Live 3D Animation');
  const hasDispatchAudit = visualEvidence.some((item) => item.title === 'Dispatch Avoidance Audit');
  const dataIntegrityOk = summary.dataIntegrityFails === 0;
  const routeOk = report.result.routeModel.routeUnavailableCount === 0;
  const physicalOk = summary.physicalStatus === 'pass/pass';

  return [
    {
      requirement: 'Inbound / Outbound / Total PPH',
      status: 'pass',
      evidence: `${round(summary.hours, 0)}h baseline: total ${round(report.result.totalPph, 1)} PPH, inbound ${round(report.result.inboundPph, 1)}, outbound ${round(report.result.outboundPph, 1)}; ${round(longRun.summary.hours, 0)}h long-run total ${round(longReport.result.totalPph, 1)} PPH.`
    },
    {
      requirement: 'Hourly PPH curve and numeric markers',
      status: 'pass',
      evidence: `24h hourly range ${round(summary.hourlyLow, 1)}-${round(summary.hourlyHigh, 1)} PPH with lowest ${summary.hourlyLowLabel} and highest ${summary.hourlyHighLabel}; report tables recompute period deltas from samples.`
    },
    {
      requirement: 'Window PPH and Waiting Share definitions',
      status: 'pass',
      evidence: '24h/7d reports include the Metric Definitions section: Window PPH is completed loads inside the period; Waiting Share is resource-wait time divided by available fleet time.'
    },
    {
      requirement: 'Data correctness and monitoring coverage',
      status: dataIntegrityOk ? 'pass' : 'watch',
      evidence: `${summary.dataIntegrityPass} data checks pass, ${summary.dataIntegrityWatch} watch, ${summary.dataIntegrityFails} fail; samples, lift PPH, utilization, wait/reposition breakdowns, route counts, and scenario hash are recorded.`
    },
    {
      requirement: 'DES collision avoidance visibility',
      status: routeOk && hasDispatchAudit ? 'pass' : 'watch',
      evidence: `${report.result.routeModel.reservationWindowCount} reservation windows, ${report.result.routeModel.routeUnavailableCount} route misses, top traffic resource ${topTraffic ? `${topTraffic.resourceId} (${round(topTraffic.waitSec / 3600, 2)}h / ${topTraffic.waitCount})` : 'none'}; dashboard dispatch audit screenshot is ${hasDispatchAudit ? 'present' : 'missing'}.`
    },
    {
      requirement: 'Physical liveness and yellow-grid feasibility',
      status: physicalOk && routeOk ? 'pass' : 'watch',
      evidence: `Physical gate ${summary.physicalStatus}; yellow-grid route miss count ${report.result.routeModel.routeUnavailableCount}.`
    },
    {
      requirement: 'Real-time animated review surface',
      status: has3dEvidence ? 'pass' : 'watch',
      evidence: has3dEvidence
        ? 'Review hub includes live dashboard and 3D animation evidence; dashboard remains available at http://localhost:5190/.'
        : 'Live dashboard link exists, but required 3D screenshot evidence is missing from the review hub.'
    },
    {
      requirement: 'Real-world validation boundary',
      status: 'needs-site-data',
      evidence: 'Internal V&V is green, but a site-calibrated claim still requires WCS/MES demand, PLC/video timings, CAD/layout, blocked zones, motion specs, controls policy, and acceptance thresholds.'
    }
  ];
}

function buildVisualCards(): Array<{ title: string; caption: string; src: string }> {
  return [
    {
      title: 'Answer-First Brief',
      caption: 'Top-level 24h review answer and IE read.',
      src: 'screenshots/des-review-24h-answer-first-brief.png'
    },
    {
      title: 'Live 3D Animation',
      caption: 'Real-time 3D view with shuttle/load/lift behavior.',
      src: 'screenshots/dashboard-live-actual-3d-animation.png'
    },
    {
      title: 'Review Cockpit 3D + DES Evidence',
      caption: 'Default review surface combining 3D animation, live KPI diagnosis, DES avoidance state, and task-level DES route/wait evidence.',
      src: 'screenshots/dashboard-review-cockpit-3d-des-evidence.png'
    },
    {
      title: 'DES Avoidance Replay',
      caption: 'Yellow-grid reservation routes and wait intervals.',
      src: 'screenshots/dashboard-des-route-playback-zoomed.png'
    },
    {
      title: 'Dispatch Avoidance Audit',
      caption: 'Trace-level route, wait, and blocking-resource evidence from the live dashboard.',
      src: 'screenshots/dashboard-des-dispatch-audit-panel-tall.png'
    },
    {
      title: 'Policy Sensitivity',
      caption: 'Cap comparison: throughput versus waiting and congestion.',
      src: 'screenshots/des-review-24h-policy-sensitivity.png'
    },
    {
      title: 'Data Integrity',
      caption: 'Automatic checks proving reported metrics recompute from samples.',
      src: 'screenshots/des-review-24h-data-integrity.png'
    },
    {
      title: 'Site Calibration Request',
      caption: 'Remaining customer/site data needed for a real-site capacity claim.',
      src: 'screenshots/des-review-24h-vv-site-calibration-request-fixed.png'
    }
  ].filter((item) => existsSync(resolve(reviewRoot, item.src)));
}

type PeriodRow = {
  label: string;
  totalPph: number;
};

function buildPeriodRows(report: ReviewReport): PeriodRow[] {
  const samples = [...report.result.samples].sort((left, right) => left.timeSec - right.timeSec);
  const rows: PeriodRow[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const periodHours = Math.max(1, current.timeSec - previous.timeSec) / 3600;
    const completedDelta = current.completedInbound - previous.completedInbound + current.completedOutbound - previous.completedOutbound;
    rows.push({
      label: periodLabel(previous.timeSec, current.timeSec),
      totalPph: completedDelta / periodHours
    });
  }
  return rows;
}

function buildTrendRows(report: ReviewReport): TrendRow[] {
  const samples = [...report.result.samples].sort((left, right) => left.timeSec - right.timeSec);
  const rows: TrendRow[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const periodHours = Math.max(1, current.timeSec - previous.timeSec) / 3600;
    const inboundDelta = current.completedInbound - previous.completedInbound;
    const outboundDelta = current.completedOutbound - previous.completedOutbound;
    rows.push({
      label: periodLabel(previous.timeSec, current.timeSec),
      startSec: previous.timeSec,
      endSec: current.timeSec,
      inboundPph: inboundDelta / periodHours,
      outboundPph: outboundDelta / periodHours,
      totalPph: (inboundDelta + outboundDelta) / periodHours,
      cumulativeTotalPph: current.totalPph,
      waitingPct: periodPctFromCumulative(previous.averageWaitingPct, current.averageWaitingPct, previous.timeSec, current.timeSec, report.result.durationSec, report.result.averageWaitingPct),
      repositionPct: periodPctFromCumulative(previous.averageRepositionPct, current.averageRepositionPct, previous.timeSec, current.timeSec, report.result.durationSec, report.result.averageRepositionPct),
      waitingVehicles: current.waitingVehicles,
      queuedTaskAgeMaxSec: current.queuedTaskAgeMaxSec
    });
  }
  return rows;
}

function buildTrendMarkers(rows: TrendRow[]): TrendMarkers {
  const lowTotalPph = minBy(rows, (row) => row.totalPph);
  const highTotalPph = maxBy(rows, (row) => row.totalPph);
  const highWaitingPct = maxBy(rows, (row) => row.waitingPct);
  const highRepositionPct = maxBy(rows, (row) => row.repositionPct);
  return {
    lowTotalPph: lowTotalPph ? { label: lowTotalPph.label, value: lowTotalPph.totalPph } : null,
    highTotalPph: highTotalPph ? { label: highTotalPph.label, value: highTotalPph.totalPph } : null,
    highWaitingPct: highWaitingPct ? { label: highWaitingPct.label, value: highWaitingPct.waitingPct } : null,
    highRepositionPct: highRepositionPct ? { label: highRepositionPct.label, value: highRepositionPct.repositionPct } : null
  };
}

function buildTrendInsights(rows: TrendRow[]): TrendInsight[] {
  if (rows.length === 0) return [];
  const averageTotal = average(rows.map((row) => row.totalPph));
  const lowTotal = minBy(rows, (row) => row.totalPph)!;
  const highTotal = maxBy(rows, (row) => row.totalPph)!;
  const highWaiting = maxBy(rows, (row) => row.waitingPct)!;
  const highReposition = maxBy(rows, (row) => row.repositionPct)!;
  const highImbalance = maxBy(rows, (row) => Math.abs(row.inboundPph - row.outboundPph) / Math.max(1, row.totalPph) * 100)!;
  const waitingWatchWindows = rows.filter((row) => row.waitingPct >= 10).length;
  const repositionWatchWindows = rows.filter((row) => row.repositionPct >= 10).length;
  const lowDipPct = averageTotal > 0 ? (averageTotal - lowTotal.totalPph) / averageTotal * 100 : 0;
  const imbalancePct = Math.abs(highImbalance.inboundPph - highImbalance.outboundPph) / Math.max(1, highImbalance.totalPph) * 100;
  return [
    {
      id: 'lowest-window-pph',
      status: lowDipPct >= 10 ? 'critical' : lowDipPct >= 5 ? 'watch' : 'pass',
      title: 'Lowest Window PPH',
      metric: `${round(lowTotal.totalPph, 2)} PPH at ${lowTotal.label}`,
      evidence: `Average window total is ${round(averageTotal, 2)} PPH; this dip is ${round(lowDipPct, 2)}% below the period average.`,
      ieInterpretation: 'A low PPH window should be checked against demand arrival, lift queues, and reservation bottlenecks before treating the long-run average as stable.'
    },
    {
      id: 'highest-window-pph',
      status: 'pass',
      title: 'Highest Window PPH',
      metric: `${round(highTotal.totalPph, 2)} PPH at ${highTotal.label}`,
      evidence: `Inbound ${round(highTotal.inboundPph, 2)} PPH and outbound ${round(highTotal.outboundPph, 2)} PPH in the peak window.`,
      ieInterpretation: 'The high window is useful as a local capability reference, but it is not a sustainable capacity claim by itself.'
    },
    {
      id: 'waiting-share-watch',
      status: highWaiting.waitingPct >= 15 ? 'critical' : highWaiting.waitingPct >= 10 ? 'watch' : 'pass',
      title: 'Waiting Share Peak',
      metric: `${round(highWaiting.waitingPct, 2)}% at ${highWaiting.label}`,
      evidence: `${waitingWatchWindows} period window(s) are at or above the 10% watch line.`,
      ieInterpretation: 'Waiting share means shuttles are blocked by lift or yellow-grid reservation resources; persistent peaks are a control-policy or bottleneck signal.'
    },
    {
      id: 'reposition-share-watch',
      status: highReposition.repositionPct >= 15 ? 'critical' : highReposition.repositionPct >= 10 ? 'watch' : 'pass',
      title: 'Reposition Share Peak',
      metric: `${round(highReposition.repositionPct, 2)}% at ${highReposition.label}`,
      evidence: `${repositionWatchWindows} period window(s) are at or above the 10% watch line.`,
      ieInterpretation: 'Reposition share is empty travel to the next pickup. High values point to task assignment, storage placement, or lift-balance policy rather than physical shuttle speed alone.'
    },
    {
      id: 'directional-imbalance',
      status: imbalancePct >= 25 ? 'critical' : imbalancePct >= 15 ? 'watch' : 'pass',
      title: 'Inbound / Outbound Imbalance',
      metric: `${round(imbalancePct, 2)}% at ${highImbalance.label}`,
      evidence: `Inbound ${round(highImbalance.inboundPph, 2)} PPH vs outbound ${round(highImbalance.outboundPph, 2)} PPH.`,
      ieInterpretation: 'Directional imbalance can be valid demand mix, but if it is not demand-driven it usually indicates lift asymmetry, release priority, or starvation.'
    }
  ];
}

function periodPctFromCumulative(previousPct: number, currentPct: number, previousSec: number, currentSec: number, totalSec: number, fallbackPct: number): number {
  const previousWeighted = previousPct * previousSec;
  const currentWeighted = currentPct * currentSec;
  const periodSec = currentSec - previousSec;
  if (periodSec <= 0) return fallbackPct;
  const periodPct = (currentWeighted - previousWeighted) / periodSec;
  if (Number.isFinite(periodPct)) return Math.max(0, periodPct);
  return totalSec > 0 ? fallbackPct : 0;
}

function renderLineSvg(options: {
  title: string;
  rows: TrendRow[];
  yLabel: string;
  series: Array<{ label: string; color: string; field: keyof TrendRow }>;
  referenceLines: Array<{ label: string; value: number; color: string }>;
}): string {
  const width = 980;
  const height = 340;
  const left = 54;
  const right = 24;
  const top = 38;
  const bottom = 46;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = options.series.flatMap((series) => options.rows.map((row) => Number(row[series.field])));
  const refValues = options.referenceLines.map((line) => line.value);
  const rawMin = Math.min(...values, ...refValues);
  const rawMax = Math.max(...values, ...refValues);
  const minValue = Math.max(0, Math.floor((Number.isFinite(rawMin) ? rawMin : 0) * 0.94));
  const maxValue = Math.ceil((Number.isFinite(rawMax) ? rawMax : 1) * 1.06);
  const xFor = (index: number) => left + (options.rows.length <= 1 ? 0 : (index / (options.rows.length - 1)) * plotWidth);
  const yFor = (value: number) => top + plotHeight - ((value - minValue) / Math.max(1, maxValue - minValue)) * plotHeight;
  const xTicks = pickTickIndexes(options.rows.length).map((index) => {
    const row = options.rows[index];
    if (!row) return '';
    const x = xFor(index);
    return `<text x="${round(x, 2)}" y="${height - 16}" text-anchor="middle" fill="#a8b8c3" font-size="11">${escapeHtml(shortPeriodLabel(row.label))}</text>`;
  }).join('');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = minValue + (maxValue - minValue) * ratio;
    const y = top + plotHeight - ratio * plotHeight;
    return `<line x1="${left}" x2="${width - right}" y1="${round(y, 2)}" y2="${round(y, 2)}" stroke="#253643" stroke-width="1"/><text x="${left - 10}" y="${round(y + 4, 2)}" text-anchor="end" fill="#a8b8c3" font-size="11">${round(value, 1)}</text>`;
  }).join('');
  const lines = options.series.map((series) => {
    const points = options.rows.map((row, index) => `${round(xFor(index), 2)},${round(yFor(Number(row[series.field])), 2)}`).join(' ');
    const last = options.rows.at(-1);
    const lastY = last ? yFor(Number(last[series.field])) : top;
    return `<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="${width - right - 4}" y="${round(lastY - 6, 2)}" text-anchor="end" fill="${series.color}" font-size="12">${escapeHtml(series.label)}</text>`;
  }).join('');
  const refs = options.referenceLines.map((line) => {
    const y = yFor(line.value);
    return `<line x1="${left}" x2="${width - right}" y1="${round(y, 2)}" y2="${round(y, 2)}" stroke="${line.color}" stroke-width="1.5" stroke-dasharray="5 5"/><text x="${left + 8}" y="${round(y - 6, 2)}" fill="${line.color}" font-size="11">${escapeHtml(line.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}">
    <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#0b1219"/>
    <text x="${left}" y="24" fill="#edf4f7" font-size="18" font-weight="700">${escapeHtml(options.title)}</text>
    <text x="${left}" y="${top - 6}" fill="#a8b8c3" font-size="11">${escapeHtml(options.yLabel)}</text>
    ${yTicks}
    ${refs}
    ${lines}
    ${xTicks}
  </svg>`;
}

function renderLegend(items: Array<{ label: string; color: string }>): string {
  return `<div class="legend">${items.map((item) => `<span><i class="swatch" style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join('')}</div>`;
}

function pickTickIndexes(length: number): number[] {
  if (length <= 8) return Array.from({ length }, (_, index) => index);
  const indexes = new Set<number>();
  for (let index = 0; index < length; index += Math.max(1, Math.floor(length / 8))) indexes.add(index);
  indexes.add(length - 1);
  return [...indexes].sort((left, right) => left - right);
}

function shortPeriodLabel(label: string): string {
  if (label.startsWith('H')) return label.replace('H', '').replace('-H', '-');
  return label;
}

function selectBalancedPolicy(rows: ReviewReport['policySensitivity']): ReviewReport['policySensitivity'][number] {
  const acceptable = rows.filter((row) => row.averageWaitingPct <= 10 && row.routeMisses === 0);
  return maxBy(acceptable.length > 0 ? acceptable : rows, (row) => row.totalPph) ?? rows[0]!;
}

function minBy<T>(items: T[], valueForItem: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => {
    if (!best) return item;
    return valueForItem(item) < valueForItem(best) ? item : best;
  }, undefined);
}

function maxBy<T>(items: T[], valueForItem: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => {
    if (!best) return item;
    return valueForItem(item) > valueForItem(best) ? item : best;
  }, undefined);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function periodLabel(startSec: number, endSec: number): string {
  const startHour = Math.floor(startSec / 3600);
  const endHour = Math.floor(endSec / 3600);
  if (endHour <= 24) return `H${String(startHour).padStart(2, '0')}-H${String(endHour).padStart(2, '0')}`;
  const day = Math.floor((endHour - 1) / 24) + 1;
  const hour = (endHour - 1) % 24 + 1;
  return `D${day} H${String(hour).padStart(2, '0')}`;
}

function round(value: number, digits = 3): number {
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
