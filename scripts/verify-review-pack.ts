import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const reviewRoot = resolve('output/review');
const reportSpecs = [
  {
    id: '24h',
    jsonPath: resolve(reviewRoot, 'shuttle-des-review-24h-vv.json'),
    htmlPath: resolve(reviewRoot, 'shuttle-des-review-24h-vv.html'),
    periodCsvPath: resolve(reviewRoot, 'data/des-period-pph-24h.csv'),
    bottleneckCsvPath: resolve(reviewRoot, 'data/des-traffic-bottlenecks-24h.csv'),
    replayCsvPath: resolve(reviewRoot, 'data/des-reservation-replay-tasks-24h.csv'),
    expectedHours: 24
  },
  {
    id: '7d',
    jsonPath: resolve(reviewRoot, 'shuttle-des-review-7d-vv.json'),
    htmlPath: resolve(reviewRoot, 'shuttle-des-review-7d-vv.html'),
    periodCsvPath: resolve(reviewRoot, 'data/des-period-pph-7d.csv'),
    bottleneckCsvPath: resolve(reviewRoot, 'data/des-traffic-bottlenecks-7d.csv'),
    replayCsvPath: resolve(reviewRoot, 'data/des-reservation-replay-tasks-7d.csv'),
    expectedHours: 168
  }
];
const indexPath = resolve(reviewRoot, 'index.html');
const siteGapHtmlPath = resolve(reviewRoot, 'site-calibration-gap.html');
const siteGapJsonPath = resolve(reviewRoot, 'site-calibration-gap.json');
const issueRegisterCsvPath = resolve(reviewRoot, 'data/review-issue-register.csv');
const issueRegisterJsonPath = resolve(reviewRoot, 'data/review-issue-register.json');
const preflightJsonPath = resolve(reviewRoot, 'review-preflight-latest.json');
const metricLineageHtmlPath = resolve(reviewRoot, 'metric-lineage.html');
const metricLineageCsvPath = resolve(reviewRoot, 'data/metric-lineage.csv');
const metricLineageJsonPath = resolve(reviewRoot, 'data/metric-lineage.json');
const reservationReplayJsonPath = resolve(reviewRoot, 'data/des-reservation-replay-tasks.json');
const ieActionPlanHtmlPath = resolve(reviewRoot, 'ie-action-plan.html');
const ieActionPlanCsvPath = resolve(reviewRoot, 'data/ie-action-plan.csv');
const ieActionPlanJsonPath = resolve(reviewRoot, 'data/ie-action-plan.json');
const liveDemoRunbookHtmlPath = resolve(reviewRoot, 'live-demo-runbook.html');
const liveDemoRunbookJsonPath = resolve(reviewRoot, 'live-demo-runbook.json');
const goalAcceptanceAuditHtmlPath = resolve(reviewRoot, 'goal-acceptance-audit.html');
const goalAcceptanceAuditJsonPath = resolve(reviewRoot, 'goal-acceptance-audit.json');
const goalCompletionAuditHtmlPath = resolve(reviewRoot, 'goal-completion-audit.html');
const goalCompletionAuditJsonPath = resolve(reviewRoot, 'goal-completion-audit.json');
const trendExplorerHtmlPath = resolve(reviewRoot, 'trend-explorer.html');
const trendExplorerJsonPath = resolve(reviewRoot, 'trend-explorer.json');
const desAvoidanceExplainerHtmlPath = resolve(reviewRoot, 'des-avoidance-explainer.html');
const desAvoidanceExplainerJsonPath = resolve(reviewRoot, 'des-avoidance-explainer.json');
const siteValidationProtocolHtmlPath = resolve(reviewRoot, 'site-validation-protocol.html');
const siteValidationProtocolJsonPath = resolve(reviewRoot, 'site-validation-protocol.json');
const siteValidationReadinessHtmlPath = resolve(reviewRoot, 'site-validation-readiness.html');
const siteValidationReadinessJsonPath = resolve(reviewRoot, 'site-validation-readiness.json');
const requiredDashboardEvidence = [
  { title: 'Dashboard Answer-First Summary', src: 'screenshots/dashboard-answer-first-panel.png' },
  { title: 'Dashboard Review Readiness', src: 'screenshots/dashboard-review-readiness-panel.png' },
  { title: 'Dashboard DES Period PPH', src: 'screenshots/dashboard-des-period-pph-panel-focused.png' },
  { title: 'Dashboard DES Data Integrity', src: 'screenshots/dashboard-des-data-integrity-panel-clean.png' },
  { title: 'Dashboard IE Findings', src: 'screenshots/dashboard-des-ie-findings-panel-final.png' },
  { title: 'Dashboard Dispatch Avoidance Audit', src: 'screenshots/dashboard-des-dispatch-audit-panel-tall.png' },
  { title: 'Dashboard DES Replay Bottlenecks', src: 'screenshots/dashboard-des-replay-bottleneck-highlight-final.png' },
  { title: 'Review Cockpit 3D + DES Evidence', src: 'screenshots/dashboard-review-cockpit-3d-des-evidence.png' }
];
const failures: string[] = [];
const warnings: string[] = [];

for (const spec of reportSpecs) {
  requireFile(spec.jsonPath);
  requireFile(spec.htmlPath);
  if (!existsSync(spec.jsonPath) || !existsSync(spec.htmlPath)) continue;

  const report = JSON.parse(readFileSync(spec.jsonPath, 'utf8')) as ReviewReport;
  const html = readFileSync(spec.htmlPath, 'utf8');
  const hours = report.result.durationSec / 3600;
  expect(spec.id, nearlyEqual(hours, spec.expectedHours, 1e-6), `duration ${hours}h equals expected ${spec.expectedHours}h`);
  expect(spec.id, report.result.totalPph > 0, `positive total PPH (${report.result.totalPph})`);
  expect(spec.id, report.result.inboundPph > 0, `positive inbound PPH (${report.result.inboundPph})`);
  expect(spec.id, report.result.outboundPph > 0, `positive outbound PPH (${report.result.outboundPph})`);
  expect(spec.id, report.result.completedInbound > 0 && report.result.completedOutbound > 0, `both directions completed loads (${report.result.completedInbound}/${report.result.completedOutbound})`);
  expect(spec.id, report.result.routeModel.routeUnavailableCount === 0, `route miss count is ${report.result.routeModel.routeUnavailableCount}`);
  expect(spec.id, report.physicalAudit.contract.status === 'pass' && report.physicalAudit.liveness.status === 'pass', `physical gate is ${report.physicalAudit.contract.status}/${report.physicalAudit.liveness.status}`);
  expect(spec.id, report.dataIntegrity.filter((check) => check.status === 'fail').length === 0, 'data integrity has 0 fail checks');
  expect(spec.id, report.policySensitivity.some((row) => row.isCurrent && row.maxActiveTasks === report.assumptions.maxActiveTasks), 'policy sensitivity contains current cap row');
  expect(spec.id, !/undefineds|NaN/.test(html), 'HTML has no undefineds/NaN text');
  expect(spec.id, html.includes('Answer-First Review Brief'), 'HTML contains answer-first brief');
  expect(spec.id, html.includes('Goal Evidence Audit'), 'HTML contains goal evidence audit');
  expect(spec.id, html.includes('Report Inbound, Outbound, and Total PPH for the review period'), 'HTML contains PPH goal audit row');
  expect(spec.id, html.includes('Define Window PPH Trend and Waiting Share Trend clearly'), 'HTML contains trend definition goal audit row');
  expect(spec.id, html.includes('Make DES avoidance behavior visible and auditable'), 'HTML contains DES avoidance goal audit row');
  expect(spec.id, html.includes('Reach real-world validation, not only internal verification'), 'HTML contains site-validation boundary goal audit row');
  expect(spec.id, html.includes('Data Integrity'), 'HTML contains data-integrity section');
  expect(spec.id, html.includes('Window PPH / Waiting Share'), 'HTML contains metric definition section');
  expect(spec.id, html.includes('Visual Verification Gallery'), 'HTML contains visual verification gallery');
  verifyCsvExports(spec.id, spec.periodCsvPath, spec.bottleneckCsvPath, spec.replayCsvPath, report);
  verifyDashboardEvidence(spec.id, spec.htmlPath, html);
}

requireFile(indexPath);
if (existsSync(indexPath)) {
  const indexHtml = readFileSync(indexPath, 'utf8');
  expect('index', !/undefineds|NaN/.test(indexHtml), 'index has no undefineds/NaN text');
  expect('index', indexHtml.includes('Four-Way Shuttle DES V&V Review Hub'), 'index contains review hub title');
  expect('index', indexHtml.includes('Goal evidence matrix'), 'index contains goal evidence matrix');
  expect('index', indexHtml.includes('Inbound / Outbound / Total PPH'), 'index maps PPH requirement');
  expect('index', indexHtml.includes('DES collision avoidance visibility'), 'index maps DES avoidance requirement');
  expect('index', indexHtml.includes('Real-world validation boundary'), 'index maps site-validation boundary');
  expect('index', indexHtml.includes('CSV For Recalculation'), 'index contains CSV export section');
  expect('index', indexHtml.includes('data/des-period-pph-24h.csv'), 'index links 24h period CSV');
  expect('index', indexHtml.includes('data/des-period-pph-7d.csv'), 'index links 7d period CSV');
  expect('index', indexHtml.includes('data/des-reservation-replay-tasks-24h.csv'), 'index links 24h reservation replay task CSV');
  expect('index', indexHtml.includes('data/des-reservation-replay-tasks-7d.csv'), 'index links 7d reservation replay task CSV');
  expect('index', indexHtml.includes('data/des-reservation-replay-tasks.json'), 'index links reservation replay task JSON');
  expect('index', indexHtml.includes('data/review-issue-register.csv'), 'index links issue register CSV');
  expect('index', indexHtml.includes('ie-action-plan.html'), 'index links IE action plan HTML');
  expect('index', indexHtml.includes('data/ie-action-plan.csv'), 'index links IE action plan CSV');
  expect('index', indexHtml.includes('live-demo-runbook.html'), 'index links live demo runbook HTML');
  expect('index', indexHtml.includes('goal-acceptance-audit.html'), 'index links goal acceptance audit HTML');
  expect('index', indexHtml.includes('goal-acceptance-audit.json'), 'index links goal acceptance audit JSON');
  expect('index', indexHtml.includes('goal-completion-audit.html'), 'index links goal completion audit HTML');
  expect('index', indexHtml.includes('goal-completion-audit.json'), 'index links goal completion audit JSON');
  expect('index', indexHtml.includes('trend-explorer.html'), 'index links trend explorer HTML');
  expect('index', indexHtml.includes('trend-explorer.json'), 'index links trend explorer JSON');
  expect('index', indexHtml.includes('des-avoidance-explainer.html'), 'index links DES avoidance explainer HTML');
  expect('index', indexHtml.includes('des-avoidance-explainer.json'), 'index links DES avoidance explainer JSON');
  expect('index', indexHtml.includes('site-validation-protocol.html'), 'index links site validation protocol HTML');
  expect('index', indexHtml.includes('site-validation-protocol.json'), 'index links site validation protocol JSON');
  expect('index', indexHtml.includes('site-validation-readiness.html'), 'index links site validation readiness HTML');
  expect('index', indexHtml.includes('site-validation-readiness.json'), 'index links site validation readiness JSON');
  expect('index', indexHtml.includes('metric-lineage.html'), 'index links metric lineage HTML');
  expect('index', indexHtml.includes('data/metric-lineage.csv'), 'index links metric lineage CSV');
  expect('index', indexHtml.includes('234.9 total PPH'), 'index contains 24h baseline PPH');
  expect('index', indexHtml.includes('234.1 total PPH'), 'index contains 7d baseline PPH');
  verifyPreflightEvidence(indexHtml);
  verifyLocalRefs(indexPath, indexHtml, { scope: 'index', minImages: 4 });
}

requireFile(siteGapHtmlPath);
requireFile(siteGapJsonPath);
if (existsSync(siteGapHtmlPath)) {
  const siteGapHtml = readFileSync(siteGapHtmlPath, 'utf8');
  expect('site-gap', !/undefineds|NaN/.test(siteGapHtml), 'site gap HTML has no undefineds/NaN text');
  expect('site-gap', siteGapHtml.includes('Current Review Assumptions vs Customer Data Needed'), 'site gap HTML contains title');
}
if (existsSync(siteGapJsonPath)) {
  const siteGap = JSON.parse(readFileSync(siteGapJsonPath, 'utf8')) as { counts?: { needsSiteData?: number; internalAssumption?: number }; rows?: unknown[] };
  expect('site-gap', Array.isArray(siteGap.rows) && siteGap.rows.length >= 8, `site gap JSON has ${siteGap.rows?.length ?? 0} rows`);
  expect('site-gap', (siteGap.counts?.needsSiteData ?? 0) > 0, 'site gap JSON records needs-site-data rows');
  expect('site-gap', (siteGap.counts?.internalAssumption ?? 0) > 0, 'site gap JSON records internal-assumption rows');
}

requireFile(issueRegisterCsvPath);
requireFile(issueRegisterJsonPath);
if (existsSync(issueRegisterCsvPath) && existsSync(issueRegisterJsonPath)) {
  const issueCsvRows = parseCsv(readFileSync(issueRegisterCsvPath, 'utf8'));
  const issueJson = JSON.parse(readFileSync(issueRegisterJsonPath, 'utf8')) as { rows?: Array<Record<string, string>> };
  const issueRows = issueJson.rows ?? [];
  expect('issue-register', issueCsvRows.length === issueRows.length, `CSV rows ${issueCsvRows.length} equal JSON rows ${issueRows.length}`);
  expect('issue-register', issueRows.length >= 10, `issue register has ${issueRows.length} rows`);
  expect('issue-register', issueRows.some((row) => row.category === 'Traffic bottleneck'), 'issue register includes traffic bottleneck row');
  expect('issue-register', issueRows.some((row) => row.category === 'Dispatch policy'), 'issue register includes dispatch policy row');
  expect('issue-register', issueRows.some((row) => row.category === 'Site calibration' && row.severity === 'needs-site-data'), 'issue register includes needs-site-data row');
}

requireFile(metricLineageHtmlPath);
requireFile(metricLineageCsvPath);
requireFile(metricLineageJsonPath);
requireFile(reservationReplayJsonPath);
requireFile(ieActionPlanHtmlPath);
requireFile(ieActionPlanCsvPath);
requireFile(ieActionPlanJsonPath);
requireFile(liveDemoRunbookHtmlPath);
requireFile(liveDemoRunbookJsonPath);
requireFile(goalAcceptanceAuditHtmlPath);
requireFile(goalAcceptanceAuditJsonPath);
requireFile(goalCompletionAuditHtmlPath);
requireFile(goalCompletionAuditJsonPath);
requireFile(trendExplorerHtmlPath);
requireFile(trendExplorerJsonPath);
requireFile(desAvoidanceExplainerHtmlPath);
requireFile(desAvoidanceExplainerJsonPath);
requireFile(siteValidationProtocolHtmlPath);
requireFile(siteValidationProtocolJsonPath);
requireFile(siteValidationReadinessHtmlPath);
requireFile(siteValidationReadinessJsonPath);
if (existsSync(metricLineageHtmlPath) && existsSync(metricLineageCsvPath) && existsSync(metricLineageJsonPath)) {
  const lineageHtml = readFileSync(metricLineageHtmlPath, 'utf8');
  const lineageCsvRows = parseCsv(readFileSync(metricLineageCsvPath, 'utf8'));
  const lineageJson = JSON.parse(readFileSync(metricLineageJsonPath, 'utf8')) as { rows?: Array<Record<string, string>> };
  const lineageRows = lineageJson.rows ?? [];
  expect('metric-lineage', !/undefineds|NaN/.test(lineageHtml), 'metric lineage HTML has no undefineds/NaN text');
  expect('metric-lineage', lineageHtml.includes('Four-Way Shuttle 指标血缘与 V&V 口径'), 'metric lineage HTML contains title');
  expect('metric-lineage', lineageCsvRows.length === lineageRows.length, `CSV rows ${lineageCsvRows.length} equal JSON rows ${lineageRows.length}`);
  expect('metric-lineage', lineageRows.length >= 10, `metric lineage has ${lineageRows.length} rows`);
  for (const requiredMetric of ['inbound_pph', 'outbound_pph', 'total_pph', 'window_pph_trend', 'waiting_share_pct', 'reposition_share_pct', 'lift_pph_utilization', 'route_unavailable_count', 'reservation_bottlenecks', 'reservation_replay_task_audit', 'data_integrity_gate']) {
    expect('metric-lineage', lineageRows.some((row) => row.metric_id === requiredMetric), `metric lineage includes ${requiredMetric}`);
  }
  expect('metric-lineage', lineageRows.every((row) => typeof row.formula === 'string' && row.formula.length > 8), 'every lineage row has a formula');
  expect('metric-lineage', lineageRows.every((row) => typeof row.automated_verification === 'string' && row.automated_verification.length > 12), 'every lineage row has automated verification text');
  expect('metric-lineage', lineageRows.some((row) => row.site_calibration_status?.includes('site') || row.customer_data_needed?.includes('WCS')), 'lineage records site calibration boundary');
  verifyLocalRefs(metricLineageHtmlPath, lineageHtml, { scope: 'metric-lineage', minImages: 0 });
}
if (existsSync(reservationReplayJsonPath)) {
  const replayJson = JSON.parse(readFileSync(reservationReplayJsonPath, 'utf8')) as { rows?: Array<Record<string, string | number>> };
  const replayRows = replayJson.rows ?? [];
  expect('reservation-replay', replayRows.length >= 100, `combined replay JSON has ${replayRows.length} rows`);
  expect('reservation-replay', replayRows.some((row) => row.horizon === '24h'), 'combined replay JSON includes 24h rows');
  expect('reservation-replay', replayRows.some((row) => row.horizon === '7d'), 'combined replay JSON includes 7d rows');
  expect('reservation-replay', replayRows.every((row) => row.route_status !== 'fail'), 'combined replay JSON has no fail route rows');
  expect('reservation-replay', replayRows.every((row) => Number(row.route_node_count ?? 0) > 0), 'combined replay JSON records route node counts');
  expect('reservation-replay', replayRows.every((row) => typeof row.route_evidence === 'string' && row.route_evidence.length > 8), 'combined replay JSON records route evidence');
}
if (existsSync(ieActionPlanHtmlPath) && existsSync(ieActionPlanCsvPath) && existsSync(ieActionPlanJsonPath)) {
  const actionHtml = readFileSync(ieActionPlanHtmlPath, 'utf8');
  const actionCsvRows = parseCsv(readFileSync(ieActionPlanCsvPath, 'utf8'));
  const actionJson = JSON.parse(readFileSync(ieActionPlanJsonPath, 'utf8')) as { rows?: Array<Record<string, string>> };
  const actionRows = actionJson.rows ?? [];
  expect('ie-action-plan', !/undefineds|NaN/.test(actionHtml), 'IE action plan HTML has no undefineds/NaN text');
  expect('ie-action-plan', actionHtml.includes('Executive Summary'), 'IE action plan has Executive Summary');
  expect('ie-action-plan', actionHtml.includes('Issue-To-Action Table'), 'IE action plan has issue-to-action table');
  expect('ie-action-plan', actionCsvRows.length === actionRows.length, `CSV rows ${actionCsvRows.length} equal JSON rows ${actionRows.length}`);
  expect('ie-action-plan', actionRows.length >= 12, `IE action plan has ${actionRows.length} rows`);
  expect('ie-action-plan', actionRows.some((row) => row.priority === 'P1'), 'IE action plan includes P1 rows');
  expect('ie-action-plan', actionRows.some((row) => row.status === 'needs-site-data'), 'IE action plan includes needs-site-data rows');
  expect('ie-action-plan', actionRows.some((row) => row.action_id === 'des-reservation-replay-task-audit'), 'IE action plan includes DES replay task audit row');
  expect('ie-action-plan', actionRows.some((row) => row.action_id === 'review-baseline-acceptance-boundary'), 'IE action plan includes baseline acceptance boundary row');
  expect('ie-action-plan', actionRows.every((row) => typeof row.recommended_action === 'string' && row.recommended_action.length > 10), 'every IE action row has recommended action');
  expect('ie-action-plan', actionRows.every((row) => typeof row.next_experiment_or_check === 'string' && row.next_experiment_or_check.length > 10), 'every IE action row has next experiment/check');
  verifyLocalRefs(ieActionPlanHtmlPath, actionHtml, { scope: 'ie-action-plan', minImages: 0 });
}
if (existsSync(liveDemoRunbookHtmlPath) && existsSync(liveDemoRunbookJsonPath)) {
  const runbookHtml = readFileSync(liveDemoRunbookHtmlPath, 'utf8');
  const runbook = JSON.parse(readFileSync(liveDemoRunbookJsonPath, 'utf8')) as {
    schemaVersion?: string;
    headline?: { totalPph24h?: number; inboundPph24h?: number; outboundPph24h?: number; routeMisses24h?: number; dataIntegrityFails24h?: number };
    steps?: Array<{ title?: string; action?: string; expectedEvidence?: string; source?: string }>;
  };
  expect('live-demo-runbook', !/undefineds|NaN/.test(runbookHtml), 'live demo runbook HTML has no undefineds/NaN text');
  expect('live-demo-runbook', runbookHtml.includes('Four-Way Shuttle Live Demo Runbook'), 'live demo runbook HTML contains title');
  expect('live-demo-runbook', runbook.schemaVersion === 'shuttle.liveDemoRunbook.v1', `live demo runbook schema is ${runbook.schemaVersion}`);
  expect('live-demo-runbook', (runbook.headline?.totalPph24h ?? 0) > 0, 'live demo runbook records total PPH');
  expect('live-demo-runbook', (runbook.headline?.inboundPph24h ?? 0) > 0 && (runbook.headline?.outboundPph24h ?? 0) > 0, 'live demo runbook records inbound/outbound PPH');
  expect('live-demo-runbook', runbook.headline?.routeMisses24h === 0, `live demo runbook route misses is ${runbook.headline?.routeMisses24h}`);
  expect('live-demo-runbook', runbook.headline?.dataIntegrityFails24h === 0, `live demo runbook data fails is ${runbook.headline?.dataIntegrityFails24h}`);
  expect('live-demo-runbook', Array.isArray(runbook.steps) && runbook.steps.length >= 6, `live demo runbook has ${runbook.steps?.length ?? 0} steps`);
  expect('live-demo-runbook', runbook.steps?.some((step) => step.title?.includes('Reset')) ?? false, 'live demo runbook includes reset step');
  expect('live-demo-runbook', runbook.steps?.some((step) => step.title?.includes('Throughput')) ?? false, 'live demo runbook includes throughput step');
  expect('live-demo-runbook', runbook.steps?.some((step) => step.title?.includes('Window PPH')) ?? false, 'live demo runbook includes Window PPH step');
  expect('live-demo-runbook', runbook.steps?.some((step) => step.title?.includes('DES Avoidance')) ?? false, 'live demo runbook includes DES avoidance step');
  verifyLocalRefs(liveDemoRunbookHtmlPath, runbookHtml, { scope: 'live-demo-runbook', minImages: 0 });
}
if (existsSync(goalAcceptanceAuditHtmlPath) && existsSync(goalAcceptanceAuditJsonPath)) {
  const auditHtml = readFileSync(goalAcceptanceAuditHtmlPath, 'utf8');
  const audit = JSON.parse(readFileSync(goalAcceptanceAuditJsonPath, 'utf8')) as {
    schemaVersion?: string;
    overallStatus?: string;
    headline?: {
      totalPph24h?: number;
      inboundPph24h?: number;
      outboundPph24h?: number;
      routeMisses24h?: number;
      dataIntegrityFails24h?: number;
      preflightFailures?: number | null;
      siteDataGaps?: number | null;
    };
    rows?: Array<{
      id?: string;
      requirement?: string;
      acceptanceCriterion?: string;
      status?: string;
      evidence?: string;
      verificationGate?: string;
      sourceRefs?: string[];
      remainingRisk?: string;
    }>;
  };
  const rows = audit.rows ?? [];
  const rowIds = new Set(rows.map((row) => row.id));
  expect('goal-acceptance-audit', !/undefineds|NaN/.test(auditHtml), 'goal acceptance audit HTML has no undefineds/NaN text');
  expect('goal-acceptance-audit', auditHtml.includes('Four-Way Shuttle Goal Acceptance Audit'), 'goal acceptance audit HTML contains title');
  expect('goal-acceptance-audit', audit.schemaVersion === 'shuttle.goalAcceptanceAudit.v1', `goal acceptance audit schema is ${audit.schemaVersion}`);
  expect('goal-acceptance-audit', audit.overallStatus === 'internal-vv-pass-site-calibration-needed' || audit.overallStatus === 'watch', `goal acceptance audit overall status is ${audit.overallStatus}`);
  expect('goal-acceptance-audit', (audit.headline?.totalPph24h ?? 0) > 0, 'goal acceptance audit records total PPH');
  expect('goal-acceptance-audit', (audit.headline?.inboundPph24h ?? 0) > 0 && (audit.headline?.outboundPph24h ?? 0) > 0, 'goal acceptance audit records inbound/outbound PPH');
  expect('goal-acceptance-audit', audit.headline?.routeMisses24h === 0, `goal acceptance audit route misses is ${audit.headline?.routeMisses24h}`);
  expect('goal-acceptance-audit', audit.headline?.dataIntegrityFails24h === 0, `goal acceptance audit data fails is ${audit.headline?.dataIntegrityFails24h}`);
  expect('goal-acceptance-audit', audit.headline?.preflightFailures === 0, `goal acceptance audit preflight failures is ${audit.headline?.preflightFailures}`);
  expect('goal-acceptance-audit', (audit.headline?.siteDataGaps ?? 0) > 0, 'goal acceptance audit records site data gaps');
  expect('goal-acceptance-audit', rows.length >= 9, `goal acceptance audit has ${rows.length} rows`);
  for (const requiredId of ['throughput-answer', 'hourly-pph-curve', 'trend-definitions', 'ie-system-problems', 'validation-verification', 'data-correctness-monitoring', 'live-animation-review-surface', 'des-avoidance-visibility', 'real-site-validation-boundary']) {
    expect('goal-acceptance-audit', rowIds.has(requiredId), `goal acceptance audit includes ${requiredId}`);
  }
  expect('goal-acceptance-audit', rows.some((row) => row.status === 'needs-site-data'), 'goal acceptance audit preserves needs-site-data boundary');
  expect('goal-acceptance-audit', rows.every((row) => typeof row.acceptanceCriterion === 'string' && row.acceptanceCriterion.length > 20), 'every goal audit row has an acceptance criterion');
  expect('goal-acceptance-audit', rows.every((row) => typeof row.verificationGate === 'string' && row.verificationGate.length > 20), 'every goal audit row has a verification gate');
  expect('goal-acceptance-audit', rows.every((row) => Array.isArray(row.sourceRefs) && row.sourceRefs.length > 0), 'every goal audit row has source references');
  expect('goal-acceptance-audit', auditHtml.includes('Requirement-by-requirement proof'), 'goal acceptance audit contains matrix section');
  expect('goal-acceptance-audit', auditHtml.includes('Window PPH'), 'goal acceptance audit mentions Window PPH');
  expect('goal-acceptance-audit', auditHtml.includes('DES avoidance') || auditHtml.includes('DES Avoidance'), 'goal acceptance audit mentions DES avoidance');
  verifyLocalRefs(goalAcceptanceAuditHtmlPath, auditHtml, { scope: 'goal-acceptance-audit', minImages: 0 });
}
if (existsSync(goalCompletionAuditHtmlPath) && existsSync(goalCompletionAuditJsonPath)) {
  const completionHtml = readFileSync(goalCompletionAuditHtmlPath, 'utf8');
  const completion = JSON.parse(readFileSync(goalCompletionAuditJsonPath, 'utf8')) as {
    schemaVersion?: string;
    completionDecision?: string;
    headline?: {
      provedRows?: number;
      watchRows?: number;
      siteDataRows?: number;
      preflightFailures?: number | null;
      totalPph24h?: number;
      inboundPph24h?: number;
      outboundPph24h?: number;
      routeMisses24h?: number;
      dataIntegrityFails24h?: number;
    };
    completionBlockers?: Array<{ blocker?: string; evidence?: string; nextProofNeeded?: string }>;
    rows?: Array<{
      id?: string;
      requirement?: string;
      proofState?: string;
      currentEvidence?: string;
      verificationGate?: string;
      sourceRefs?: string[];
      nextProofNeeded?: string;
    }>;
  };
  const completionRows = completion.rows ?? [];
  expect('goal-completion-audit', !/undefineds|NaN/.test(completionHtml), 'goal completion audit HTML has no undefineds/NaN text');
  expect('goal-completion-audit', completionHtml.includes('Four-Way Shuttle Goal Completion Audit'), 'goal completion audit HTML contains title');
  expect('goal-completion-audit', completion.schemaVersion === 'shuttle.goalCompletionAudit.v1', `goal completion audit schema is ${completion.schemaVersion}`);
  expect('goal-completion-audit', completion.completionDecision === 'not-complete-site-validation-needed' || completion.completionDecision === 'watch-incomplete' || completion.completionDecision === 'complete', `goal completion audit decision is ${completion.completionDecision}`);
  expect('goal-completion-audit', completion.completionDecision !== 'complete', 'goal completion audit does not overclaim complete while site data is missing');
  expect('goal-completion-audit', (completion.headline?.provedRows ?? 0) >= 7, `goal completion audit proved rows ${completion.headline?.provedRows}`);
  expect('goal-completion-audit', (completion.headline?.siteDataRows ?? 0) >= 1, `goal completion audit site data rows ${completion.headline?.siteDataRows}`);
  expect('goal-completion-audit', completion.headline?.preflightFailures === 0, `goal completion audit preflight failures is ${completion.headline?.preflightFailures}`);
  expect('goal-completion-audit', (completion.headline?.totalPph24h ?? 0) > 0, 'goal completion audit records total PPH');
  expect('goal-completion-audit', (completion.headline?.inboundPph24h ?? 0) > 0 && (completion.headline?.outboundPph24h ?? 0) > 0, 'goal completion audit records inbound/outbound PPH');
  expect('goal-completion-audit', completion.headline?.routeMisses24h === 0, `goal completion audit route misses is ${completion.headline?.routeMisses24h}`);
  expect('goal-completion-audit', completion.headline?.dataIntegrityFails24h === 0, `goal completion audit data fails is ${completion.headline?.dataIntegrityFails24h}`);
  expect('goal-completion-audit', (completion.completionBlockers ?? []).length >= 2, `goal completion audit blockers ${completion.completionBlockers?.length ?? 0}`);
  expect('goal-completion-audit', completion.completionBlockers?.some((blocker) => blocker.nextProofNeeded?.includes('WCS/MES')) ?? false, 'goal completion audit names WCS/MES next proof');
  expect('goal-completion-audit', completionRows.length >= 9, `goal completion audit has ${completionRows.length} rows`);
  expect('goal-completion-audit', completionRows.some((row) => row.proofState === 'site-data-required'), 'goal completion audit preserves site-data-required row');
  expect('goal-completion-audit', completionRows.every((row) => Array.isArray(row.sourceRefs) && row.sourceRefs.length > 0), 'every completion audit row has source references');
  expect('goal-completion-audit', completionHtml.includes('Completion Decision'), 'goal completion audit contains decision section');
  expect('goal-completion-audit', completionHtml.includes('Why not complete yet'), 'goal completion audit contains blocker section');
  expect('goal-completion-audit', completionHtml.includes('Original Goal Coverage'), 'goal completion audit contains original goal coverage section');
  verifyLocalRefs(goalCompletionAuditHtmlPath, completionHtml, { scope: 'goal-completion-audit', minImages: 0 });
}
if (existsSync(trendExplorerHtmlPath) && existsSync(trendExplorerJsonPath)) {
  const trendHtml = readFileSync(trendExplorerHtmlPath, 'utf8');
  const trend = JSON.parse(readFileSync(trendExplorerJsonPath, 'utf8')) as {
    schemaVersion?: string;
    headline?: {
      totalPph24h?: number;
      inboundPph24h?: number;
      outboundPph24h?: number;
      waitingPct24h?: number;
      repositionPct24h?: number;
      totalPph7d?: number;
    };
    definitions?: Array<{ metric?: string; definition?: string; source?: string }>;
    markers24h?: {
      lowTotalPph?: { label?: string; value?: number } | null;
      highTotalPph?: { label?: string; value?: number } | null;
      highWaitingPct?: { label?: string; value?: number } | null;
      highRepositionPct?: { label?: string; value?: number } | null;
    };
    rows24h?: Array<Record<string, string | number>>;
    rows7d?: Array<Record<string, string | number>>;
    insights24h?: Array<{ id?: string; status?: string; title?: string; metric?: string; ieInterpretation?: string }>;
    insights7d?: Array<{ id?: string; status?: string; title?: string; metric?: string; ieInterpretation?: string }>;
  };
  const rows24h = trend.rows24h ?? [];
  const rows7d = trend.rows7d ?? [];
  expect('trend-explorer', !/undefineds|NaN/.test(trendHtml), 'trend explorer HTML has no undefineds/NaN text');
  expect('trend-explorer', trendHtml.includes('Four-Way Shuttle Trend Explorer'), 'trend explorer HTML contains title');
  expect('trend-explorer', trend.schemaVersion === 'shuttle.trendExplorer.v1', `trend explorer schema is ${trend.schemaVersion}`);
  expect('trend-explorer', (trend.headline?.totalPph24h ?? 0) > 0, 'trend explorer records total PPH');
  expect('trend-explorer', (trend.headline?.inboundPph24h ?? 0) > 0 && (trend.headline?.outboundPph24h ?? 0) > 0, 'trend explorer records inbound/outbound PPH');
  expect('trend-explorer', (trend.headline?.waitingPct24h ?? 0) > 0 && (trend.headline?.repositionPct24h ?? 0) > 0, 'trend explorer records waiting/reposition percentages');
  expect('trend-explorer', (trend.headline?.totalPph7d ?? 0) > 0, 'trend explorer records 7d total PPH');
  expect('trend-explorer', rows24h.length === 24, `trend explorer has ${rows24h.length} 24h rows`);
  expect('trend-explorer', rows7d.length === 168, `trend explorer has ${rows7d.length} 7d rows`);
  expect('trend-explorer', rows24h.every((row) => Number(row.inboundPph ?? 0) > 0 && Number(row.outboundPph ?? 0) > 0 && Number(row.totalPph ?? 0) > 0), 'every 24h trend row has positive PPH');
  expect('trend-explorer', Boolean(trend.markers24h?.lowTotalPph?.label && trend.markers24h.highTotalPph?.label && trend.markers24h.highWaitingPct?.label && trend.markers24h.highRepositionPct?.label), 'trend explorer records 24h marker labels');
  expect('trend-explorer', (trend.insights24h ?? []).length >= 5, `trend explorer records ${trend.insights24h?.length ?? 0} IE insights`);
  expect('trend-explorer', (trend.insights24h ?? []).some((row) => row.id === 'waiting-share-watch'), 'trend explorer includes waiting share diagnosis');
  expect('trend-explorer', (trend.insights24h ?? []).every((row) => typeof row.ieInterpretation === 'string' && row.ieInterpretation.length > 20), 'trend explorer IE insights include interpretation text');
  expect('trend-explorer', (trend.definitions ?? []).some((row) => row.metric === 'Window PPH'), 'trend explorer defines Window PPH');
  expect('trend-explorer', (trend.definitions ?? []).some((row) => row.metric === 'Waiting Share'), 'trend explorer defines Waiting Share');
  expect('trend-explorer', trendHtml.includes('24h Window PPH Trend'), 'trend explorer contains PPH chart');
  expect('trend-explorer', trendHtml.includes('24h Waiting / Reposition Share Trend'), 'trend explorer contains wait/reposition chart');
  expect('trend-explorer', trendHtml.includes('Lowest Total PPH') && trendHtml.includes('Peak Waiting Share'), 'trend explorer contains numeric marker cards');
  expect('trend-explorer', trendHtml.includes('24h Trend Findings') && trendHtml.includes('Industrial engineering diagnosis'), 'trend explorer contains IE diagnosis section');
  verifyLocalRefs(trendExplorerHtmlPath, trendHtml, { scope: 'trend-explorer', minImages: 0 });
}
if (existsSync(desAvoidanceExplainerHtmlPath) && existsSync(desAvoidanceExplainerJsonPath)) {
  const explainerHtml = readFileSync(desAvoidanceExplainerHtmlPath, 'utf8');
  const explainer = JSON.parse(readFileSync(desAvoidanceExplainerJsonPath, 'utf8')) as {
    schemaVersion?: string;
    headline?: {
      tracedTasks?: number;
      pass?: number;
      watch?: number;
      fail?: number;
      reservationWindows24h?: number;
      routeMisses24h?: number;
      trafficWaitHours24h?: number;
      topTrafficResource24h?: string;
    };
    explanation?: Array<{ title?: string; body?: string }>;
    topBottlenecks24h?: Array<{ resourceId?: string; waitSec?: number; waitCount?: number }>;
    topWaitedTasks?: Array<{ task_id?: string; total_wait_sec?: number; primary_wait_resource?: string; route_status?: string; avoidance_evidence?: string }>;
  };
  expect('des-avoidance-explainer', !/undefineds|NaN/.test(explainerHtml), 'DES avoidance explainer HTML has no undefineds/NaN text');
  expect('des-avoidance-explainer', explainerHtml.includes('Four-Way Shuttle DES Avoidance Explainer'), 'DES avoidance explainer HTML contains title');
  expect('des-avoidance-explainer', explainer.schemaVersion === 'shuttle.desAvoidanceExplainer.v1', `DES avoidance explainer schema is ${explainer.schemaVersion}`);
  expect('des-avoidance-explainer', (explainer.headline?.tracedTasks ?? 0) >= 100, `DES avoidance traced tasks ${explainer.headline?.tracedTasks ?? 0}`);
  expect('des-avoidance-explainer', (explainer.headline?.pass ?? 0) > 0, 'DES avoidance explainer records pass tasks');
  expect('des-avoidance-explainer', (explainer.headline?.watch ?? 0) > 0, 'DES avoidance explainer records watch tasks');
  expect('des-avoidance-explainer', explainer.headline?.fail === 0, `DES avoidance fail count is ${explainer.headline?.fail}`);
  expect('des-avoidance-explainer', (explainer.headline?.reservationWindows24h ?? 0) > 0, 'DES avoidance explainer records reservation windows');
  expect('des-avoidance-explainer', explainer.headline?.routeMisses24h === 0, `DES avoidance route misses is ${explainer.headline?.routeMisses24h}`);
  expect('des-avoidance-explainer', (explainer.headline?.trafficWaitHours24h ?? 0) > 0, 'DES avoidance explainer records traffic wait hours');
  expect('des-avoidance-explainer', typeof explainer.headline?.topTrafficResource24h === 'string' && explainer.headline.topTrafficResource24h.length > 8, 'DES avoidance explainer records top traffic resource');
  expect('des-avoidance-explainer', (explainer.explanation ?? []).length >= 3, 'DES avoidance explainer has explanation cards');
  expect('des-avoidance-explainer', (explainer.topBottlenecks24h ?? []).length >= 5, 'DES avoidance explainer has bottleneck rows');
  expect('des-avoidance-explainer', (explainer.topWaitedTasks ?? []).length >= 10, 'DES avoidance explainer has waited task rows');
  expect('des-avoidance-explainer', (explainer.topWaitedTasks ?? []).every((row) => row.route_status !== 'fail'), 'DES avoidance waited task rows have no fail status');
  expect('des-avoidance-explainer', (explainer.topWaitedTasks ?? []).some((row) => Number(row.total_wait_sec ?? 0) > 0 && typeof row.primary_wait_resource === 'string'), 'DES avoidance waited tasks include wait/resource evidence');
  expect('des-avoidance-explainer', explainerHtml.includes('DES avoidance means explicit reservation waiting'), 'DES avoidance explainer describes reservation waiting');
  expect('des-avoidance-explainer', explainerHtml.includes('Top 24h Reservation Wait Resources'), 'DES avoidance explainer contains bottleneck section');
  expect('des-avoidance-explainer', explainerHtml.includes('Top Waited 24h Traced Tasks'), 'DES avoidance explainer contains task replay section');
  verifyLocalRefs(desAvoidanceExplainerHtmlPath, explainerHtml, { scope: 'des-avoidance-explainer', minImages: 0 });
}
if (existsSync(siteValidationProtocolHtmlPath) && existsSync(siteValidationProtocolJsonPath)) {
  const protocolHtml = readFileSync(siteValidationProtocolHtmlPath, 'utf8');
  const protocol = JSON.parse(readFileSync(siteValidationProtocolJsonPath, 'utf8')) as {
    schemaVersion?: string;
    currentBoundary?: { status?: string; needsSiteData?: number; internalAssumptions?: number; readyForComparison?: number };
    gates?: Array<{ id?: string; validationArea?: string; customerDataNeeded?: string; comparisonMethod?: string; passFailCriterion?: string; artifactUsed?: string; currentStatus?: string }>;
  };
  const gates = protocol.gates ?? [];
  const gateIds = new Set(gates.map((gate) => gate.id));
  expect('site-validation-protocol', !/undefineds|NaN/.test(protocolHtml), 'site validation protocol HTML has no undefineds/NaN text');
  expect('site-validation-protocol', protocolHtml.includes('Four-Way Shuttle Site Validation Protocol'), 'site validation protocol HTML contains title');
  expect('site-validation-protocol', protocol.schemaVersion === 'shuttle.siteValidationProtocol.v1', `site validation protocol schema is ${protocol.schemaVersion}`);
  expect('site-validation-protocol', protocol.currentBoundary?.status === 'internal-vv-pass-site-data-needed', `site validation protocol boundary is ${protocol.currentBoundary?.status}`);
  expect('site-validation-protocol', (protocol.currentBoundary?.needsSiteData ?? 0) > 0, 'site validation protocol records site-data needs');
  expect('site-validation-protocol', (protocol.currentBoundary?.internalAssumptions ?? 0) > 0, 'site validation protocol records internal assumptions');
  expect('site-validation-protocol', gates.length >= 7, `site validation protocol has ${gates.length} gates`);
  for (const requiredGate of ['demand-profile', 'lift-cycle', 'shuttle-motion', 'layout-and-blocked-zones', 'control-policy', 'visual-synchronization', 'acceptance-thresholds']) {
    expect('site-validation-protocol', gateIds.has(requiredGate), `site validation protocol includes ${requiredGate}`);
  }
  expect('site-validation-protocol', gates.every((gate) => typeof gate.customerDataNeeded === 'string' && gate.customerDataNeeded.length > 20), 'every validation gate has customer data needed');
  expect('site-validation-protocol', gates.every((gate) => typeof gate.comparisonMethod === 'string' && gate.comparisonMethod.length > 20), 'every validation gate has comparison method');
  expect('site-validation-protocol', gates.every((gate) => typeof gate.passFailCriterion === 'string' && gate.passFailCriterion.length > 20), 'every validation gate has pass/fail criterion');
  expect('site-validation-protocol', gates.every((gate) => typeof gate.artifactUsed === 'string' && gate.artifactUsed.length > 8), 'every validation gate has artifact reference');
  expect('site-validation-protocol', gates.every((gate) => gate.currentStatus === 'needs-site-data' || gate.currentStatus === 'internal-assumption' || gate.currentStatus === 'ready-for-comparison'), 'every validation gate has recognized status');
  expect('site-validation-protocol', protocolHtml.includes('How Internal V&V Becomes Site Validation'), 'site validation protocol contains comparison gate section');
  expect('site-validation-protocol', protocolHtml.includes('site-calibration-gap.html'), 'site validation protocol links site calibration gap');
  verifyLocalRefs(siteValidationProtocolHtmlPath, protocolHtml, { scope: 'site-validation-protocol', minImages: 0 });
}
if (existsSync(siteValidationReadinessHtmlPath) && existsSync(siteValidationReadinessJsonPath)) {
  const readinessHtml = readFileSync(siteValidationReadinessHtmlPath, 'utf8');
  const readiness = JSON.parse(readFileSync(siteValidationReadinessJsonPath, 'utf8')) as {
    schemaVersion?: string;
    decision?: string;
    counts?: { ready?: number; partial?: number; blocked?: number };
    rows?: Array<{ id?: string; status?: string; readinessRule?: string; missingProof?: string; modelImpact?: string }>;
  };
  const rows = readiness.rows ?? [];
  const rowIds = new Set(rows.map((row) => row.id));
  expect('site-validation-readiness', !/undefineds|NaN/.test(readinessHtml), 'site validation readiness HTML has no undefineds/NaN text');
  expect('site-validation-readiness', readinessHtml.includes('Site Validation Readiness'), 'site validation readiness HTML contains title');
  expect('site-validation-readiness', readiness.schemaVersion === 'shuttle.siteValidationReadiness.v1', `site validation readiness schema is ${readiness.schemaVersion}`);
  expect('site-validation-readiness', readiness.decision === 'blocked-by-site-data' || readiness.decision === 'ready-for-site-comparison', `site validation readiness decision is ${readiness.decision}`);
  expect('site-validation-readiness', readiness.decision === 'blocked-by-site-data', 'current review readiness stays blocked until customer data is supplied');
  expect('site-validation-readiness', (readiness.counts?.blocked ?? 0) > 0, `site validation readiness blocked count is ${readiness.counts?.blocked}`);
  expect('site-validation-readiness', rows.length >= 10, `site validation readiness has ${rows.length} gates`);
  for (const requiredGate of ['wcs-mes-demand-profile', 'lift-cycle-measurements', 'cad-layout-geometry', 'wcs-control-policy', 'signed-acceptance-thresholds', '24h-result-threshold-comparison']) {
    expect('site-validation-readiness', rowIds.has(requiredGate), `site validation readiness includes ${requiredGate}`);
  }
  expect('site-validation-readiness', rows.every((row) => row.status === 'ready' || row.status === 'partial' || row.status === 'blocked'), 'every readiness row has recognized status');
  expect('site-validation-readiness', rows.every((row) => typeof row.readinessRule === 'string' && row.readinessRule.length > 20), 'every readiness row has readiness rule');
  expect('site-validation-readiness', rows.every((row) => typeof row.missingProof === 'string' && row.missingProof.length > 10), 'every readiness row has missing proof');
  expect('site-validation-readiness', rows.every((row) => typeof row.modelImpact === 'string' && row.modelImpact.length > 20), 'every readiness row has model impact');
  expect('site-validation-readiness', readinessHtml.includes('Customer Site Data Readiness Gate'), 'site validation readiness has review-facing heading');
  expect('site-validation-readiness', readinessHtml.includes('machine-scored gates'), 'site validation readiness contains scored gates section');
  verifyLocalRefs(siteValidationReadinessHtmlPath, readinessHtml, { scope: 'site-validation-readiness', minImages: 0 });
}

function verifyPreflightEvidence(indexHtml: string): void {
  if (!existsSync(preflightJsonPath)) return;
  const preflight = JSON.parse(readFileSync(preflightJsonPath, 'utf8')) as { failures?: number; reports?: unknown[]; issueRegister?: { rows?: number }; siteGap?: { needsSiteData?: number }; siteReadiness?: { decision?: string; blocked?: number } };
  expect('preflight', indexHtml.includes('Latest preflight gate'), 'index contains latest preflight gate section');
  expect('preflight', indexHtml.includes('review-preflight-latest.json'), 'index links latest preflight JSON');
  expect('preflight', preflight.failures === 0, `latest preflight failures is ${preflight.failures}`);
  expect('preflight', Array.isArray(preflight.reports) && preflight.reports.length >= 2, `latest preflight has ${preflight.reports?.length ?? 0} report summaries`);
  expect('preflight', (preflight.issueRegister?.rows ?? 0) > 0, 'latest preflight records issue register row count');
  expect('preflight', (preflight.siteGap?.needsSiteData ?? 0) > 0, 'latest preflight records site-data gap count');
  if (preflight.siteReadiness) {
    expect('preflight', preflight.siteReadiness.decision === 'blocked-by-site-data', `latest preflight site readiness is ${preflight.siteReadiness.decision}`);
    expect('preflight', (preflight.siteReadiness.blocked ?? 0) > 0, 'latest preflight records blocked site readiness gates');
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ type: 'review-pack-verify-failed', failures, warnings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  type: 'review-pack-verify-complete',
  failures: 0,
  warnings,
  reports: reportSpecs.map((spec) => {
    const report = JSON.parse(readFileSync(spec.jsonPath, 'utf8')) as ReviewReport;
    return {
      id: spec.id,
      totalPph: report.result.totalPph,
      inboundPph: report.result.inboundPph,
      outboundPph: report.result.outboundPph,
      routeMisses: report.result.routeModel.routeUnavailableCount,
      physicalGate: `${report.physicalAudit.contract.status}/${report.physicalAudit.liveness.status}`,
      dataIntegrityFails: report.dataIntegrity.filter((check) => check.status === 'fail').length
    };
  })
}, null, 2));

type ReviewReport = {
  assumptions: { maxActiveTasks: number };
  policySensitivity: Array<{ maxActiveTasks: number; isCurrent: boolean }>;
  dataIntegrity: Array<{ status: string }>;
  physicalAudit: {
    contract: { status: string };
    liveness: { status: string };
  };
  result: {
    durationSec: number;
    completedInbound: number;
    completedOutbound: number;
    inboundPph: number;
    outboundPph: number;
    totalPph: number;
    routeModel: { routeUnavailableCount: number };
    reservationReplay: { tracedTaskCount: number };
    samples: Array<{
      timeSec: number;
      completedInbound: number;
      completedOutbound: number;
    }>;
    trafficBottlenecks: Array<{ resourceId: string; waitSec: number; waitCount: number }>;
  };
};

function requireFile(path: string): void {
  if (!existsSync(path)) failures.push(`missing file: ${path}`);
}

function expect(scope: string, condition: boolean, message: string): void {
  if (!condition) failures.push(`${scope}: ${message}`);
}

function verifyLocalRefs(htmlPath: string, html: string, options: { scope: string; minImages: number }): void {
  const htmlDir = dirname(htmlPath);
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!).filter((href) => !href.startsWith('http'));
  const imageSources = [...html.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]!);
  for (const href of hrefs) {
    const target = resolveLocalRef(htmlDir, href);
    if (!existsSync(target)) failures.push(`${options.scope}: missing href target ${href}`);
  }
  for (const src of imageSources) {
    const target = resolveLocalRef(htmlDir, src);
    if (!existsSync(target)) failures.push(`${options.scope}: missing image target ${src}`);
  }
  if (imageSources.length < options.minImages) warnings.push(`${options.scope}: expected at least ${options.minImages} visual evidence images, found ${imageSources.length}`);
}

function verifyDashboardEvidence(scope: string, htmlPath: string, html: string): void {
  const htmlDir = dirname(htmlPath);
  for (const evidence of requiredDashboardEvidence) {
    expect(scope, html.includes(evidence.title), `HTML contains visual evidence title ${evidence.title}`);
    expect(scope, html.includes(`src="${evidence.src}"`), `HTML references visual evidence image ${evidence.src}`);
    const imagePath = resolveLocalRef(htmlDir, evidence.src);
    expect(scope, existsSync(imagePath), `visual evidence image exists ${evidence.src}`);
  }
}

function verifyCsvExports(scope: string, periodCsvPath: string, bottleneckCsvPath: string, replayCsvPath: string, report: ReviewReport): void {
  requireFile(periodCsvPath);
  requireFile(bottleneckCsvPath);
  requireFile(replayCsvPath);
  if (!existsSync(periodCsvPath) || !existsSync(bottleneckCsvPath) || !existsSync(replayCsvPath)) return;

  const periodRows = parseCsv(readFileSync(periodCsvPath, 'utf8'));
  const bottleneckRows = parseCsv(readFileSync(bottleneckCsvPath, 'utf8'));
  const replayRows = parseCsv(readFileSync(replayCsvPath, 'utf8'));
  expect(scope, periodRows.length === Math.max(0, report.result.samples.length - 1), `period CSV has ${periodRows.length} rows for ${report.result.samples.length} samples`);
  expect(scope, bottleneckRows.length === report.result.trafficBottlenecks.length, `bottleneck CSV has ${bottleneckRows.length} rows for ${report.result.trafficBottlenecks.length} bottlenecks`);
  expect(scope, replayRows.length === report.result.reservationReplay.tracedTaskCount, `replay CSV has ${replayRows.length} rows for ${report.result.reservationReplay.tracedTaskCount} traced tasks`);
  expect(scope, periodRows[0] ? Object.hasOwn(periodRows[0], 'inbound_pph') && Object.hasOwn(periodRows[0], 'outbound_pph') && Object.hasOwn(periodRows[0], 'total_pph') : false, 'period CSV contains PPH columns');
  expect(scope, bottleneckRows[0] ? Object.hasOwn(bottleneckRows[0], 'resource_id') && Object.hasOwn(bottleneckRows[0], 'wait_sec') : false, 'bottleneck CSV contains resource/wait columns');
  expect(scope, replayRows[0] ? Object.hasOwn(replayRows[0], 'task_id') && Object.hasOwn(replayRows[0], 'route_status') && Object.hasOwn(replayRows[0], 'route_evidence') : false, 'replay CSV contains task/route evidence columns');
  expect(scope, replayRows.every((row) => row.route_status !== 'fail'), 'replay CSV has no fail route rows');
  expect(scope, replayRows.some((row) => Number(row.total_wait_sec) > 0), 'replay CSV includes tasks with explicit wait');

  const inboundDeltaSum = sumCsvNumber(periodRows, 'inbound_completed_delta');
  const outboundDeltaSum = sumCsvNumber(periodRows, 'outbound_completed_delta');
  const firstSample = [...report.result.samples].sort((left, right) => left.timeSec - right.timeSec)[0];
  expect(scope, inboundDeltaSum === report.result.completedInbound - (firstSample?.completedInbound ?? 0), `period CSV inbound deltas sum to ${inboundDeltaSum}`);
  expect(scope, outboundDeltaSum === report.result.completedOutbound - (firstSample?.completedOutbound ?? 0), `period CSV outbound deltas sum to ${outboundDeltaSum}`);
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function sumCsvNumber(rows: Array<Record<string, string>>, field: string): number {
  return rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0);
}

function resolveLocalRef(baseDir: string, ref: string): string {
  const withoutHash = ref.split('#')[0] ?? ref;
  const withoutQuery = withoutHash.split('?')[0] ?? withoutHash;
  return resolve(join(baseDir, withoutQuery));
}

function nearlyEqual(left: number, right: number, tolerance: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}
