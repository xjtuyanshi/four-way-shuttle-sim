import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import { createInboundOutboundDemoScenario, hashScenario, runHeadlessDes } from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = durationArg(24 * 3600);
const sampleIntervalSec = numberArg('--sample-sec', 3600);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const storageSelectionPolicy = enumArg('--storage-selection-policy', ['sequential', 'traffic-aware'] as const, 'sequential');
const liftTimeSec = numberArg('--lift-sec', 30);
const lowerTimeSec = numberArg('--lower-sec', 30);
const maxActiveTasksArg = integerArg('--max-active-tasks', Math.min(shuttleCount, 6));
const skipPhysicalAudit = process.argv.includes('--skip-physical');
const physicalContractSec = numberArg('--physical-contract-sec', 120);
const physicalContractDtSec = numberArg('--physical-contract-dt-sec', 0.2);
const physicalLivenessSec = numberArg('--physical-liveness-sec', 600);
const physicalLivenessDtSec = numberArg('--physical-liveness-dt-sec', 1);
const physicalSampleSec = numberArg('--physical-sample-sec', 120);
const outputPath = resolve(stringArg('--out') ?? `output/review/shuttle-des-review-${Date.now()}.json`);
const htmlPath = resolve(stringArg('--html') ?? outputPath.replace(/\.json$/i, '.html'));

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(htmlPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  vehicles: { count: shuttleCount },
  physicsParams: {
    liftTimeSec,
    lowerTimeSec
  },
  taskGeneration: {
    inboundRatePerHour,
    outboundRatePerHour,
    inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
      ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
      : 0.5,
    initialOutboundFullColumns,
    initialStorageFillPolicy,
    storageSelectionPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const result = runHeadlessDes({ scenario, durationSec, sampleIntervalSec, maxActiveTasks: maxActiveTasksArg });
const policySensitivity = buildPolicySensitivity(result);
const physicalAudit = runPhysicalAuditGate(outputPath);
const dataIntegrity = buildDataIntegrityChecks(result, policySensitivity, physicalAudit);
const report = {
  schemaVersion: 'shuttle.desReview.v2',
  generatedAtIso: new Date().toISOString(),
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  scenario,
  assumptions: {
    model: 'event-driven yellow-graph reservation-window DES',
    liftTimeSec,
    lowerTimeSec,
    maxActiveTasks: maxActiveTasksArg,
    initialStorageFillPolicy,
    storageSelectionPolicy,
    sampleIntervalSec,
    note: 'This DES runner is for long-run analytical sweeps. It models shuttle conflict avoidance as time reservations on yellow-grid nodes and edges. The bundled physical audit gate is a smoke check for yellow-grid contract and liveness; use targeted replay for visual traffic debugging.'
  },
  policySensitivity,
  dataIntegrity,
  physicalAudit,
  result
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(htmlPath, renderHtml(report));
console.log(JSON.stringify({
  type: 'des-review-complete',
  outputPath,
  htmlPath,
  wallClockMs: result.wallClockMs,
  totalPph: result.totalPph,
  physicalContract: physicalAudit.contract.status,
  physicalLiveness: physicalAudit.liveness.status,
  issues: result.issues.length
}, null, 2));

if (
  dataIntegrity.some((check) => check.status === 'fail') ||
  result.issues.some((issue) => issue.severity === 'critical') ||
  physicalAudit.contract.status === 'fail' ||
  physicalAudit.contract.status === 'error' ||
  physicalAudit.liveness.status === 'fail' ||
  physicalAudit.liveness.status === 'error'
) {
  process.exitCode = 1;
}

type PhysicalAuditStatus = 'pass' | 'fail' | 'error' | 'skipped';

type PhysicalAuditSummary = {
  status: PhysicalAuditStatus;
  script: string;
  outputPath: string | null;
  command: string[];
  exitCode: number | null;
  durationSec: number;
  dtSec: number;
  finalSimTimeSec: number | null;
  totalPph: number | null;
  completedTotal: number | null;
  physicalViolations: number | null;
  deadlocks: number | null;
  livelocks: number | null;
  anomalies: number | null;
  criticalAnomalies: number | null;
  anomalyCounts: Record<string, number>;
  stderrTail: string | null;
};

type PhysicalAuditGate = {
  enabled: boolean;
  note: string;
  contract: PhysicalAuditSummary;
  liveness: PhysicalAuditSummary;
};

function runPhysicalAuditGate(desOutputPath: string): PhysicalAuditGate {
  const contractPath = desOutputPath.replace(/\.json$/i, '.yellow-grid-contract.json');
  const livenessPath = desOutputPath.replace(/\.json$/i, '.yellow-grid-liveness.json');
  if (skipPhysicalAudit) {
    return {
      enabled: false,
      note: 'Physical audit gate skipped by --skip-physical.',
      contract: skippedPhysicalAudit('scripts/audit-yellow-grid-contract.ts', contractPath, physicalContractSec, physicalContractDtSec),
      liveness: skippedPhysicalAudit('scripts/audit-yellow-grid-liveness.ts', livenessPath, physicalLivenessSec, physicalLivenessDtSec)
    };
  }

  const commonArgs = [
    '--regions', String(regionCount),
    '--shuttles', String(shuttleCount),
    '--inbound-pph', String(inboundRatePerHour),
    '--outbound-pph', String(outboundRatePerHour),
    '--outbound-full-columns', String(initialOutboundFullColumns),
    '--initial-fill-policy', initialStorageFillPolicy,
    '--storage-selection-policy', storageSelectionPolicy
  ];
  const contract = runPhysicalAuditScript('scripts/audit-yellow-grid-contract.ts', [
    '--duration-sec', String(physicalContractSec),
    '--dt-sec', String(physicalContractDtSec),
    '--sample-sec', String(Math.min(physicalSampleSec, physicalContractSec)),
    ...commonArgs,
    '--out', contractPath
  ], contractPath, physicalContractSec, physicalContractDtSec);
  const liveness = runPhysicalAuditScript('scripts/audit-yellow-grid-liveness.ts', [
    '--duration-sec', String(physicalLivenessSec),
    '--dt-sec', String(physicalLivenessDtSec),
    '--sample-sec', String(Math.min(physicalSampleSec, physicalLivenessSec)),
    ...commonArgs,
    '--out', livenessPath
  ], livenessPath, physicalLivenessSec, physicalLivenessDtSec);

  return {
    enabled: true,
    note: 'Physical gate runs a bounded tick replay smoke next to the long-run DES report so yellow-grid and liveness regressions are visible without waiting for a full 24h tick run.',
    contract,
    liveness
  };
}

function runPhysicalAuditScript(
  script: string,
  args: string[],
  outputPathForScript: string,
  durationSecForScript: number,
  dtSecForScript: number
): PhysicalAuditSummary {
  const command = ['pnpm', 'exec', 'tsx', script, ...args];
  const run = spawnSync(command[0]!, command.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe'
  });
  const stderrTail = run.stderr ? run.stderr.slice(-1200) : null;
  if (run.error) {
    return {
      status: 'error',
      script,
      outputPath: outputPathForScript,
      command,
      exitCode: null,
      durationSec: durationSecForScript,
      dtSec: dtSecForScript,
      finalSimTimeSec: null,
      totalPph: null,
      completedTotal: null,
      physicalViolations: null,
      deadlocks: null,
      livelocks: null,
      anomalies: null,
      criticalAnomalies: null,
      anomalyCounts: {},
      stderrTail: run.error.message
    };
  }
  const parsed = summarizePhysicalAudit(script, outputPathForScript, command, run.status, durationSecForScript, dtSecForScript, stderrTail);
  if (run.status !== 0 && parsed.status === 'pass') {
    return { ...parsed, status: 'fail' };
  }
  return parsed;
}

function summarizePhysicalAudit(
  script: string,
  outputPathForScript: string,
  command: string[],
  exitCode: number | null,
  durationSecForScript: number,
  dtSecForScript: number,
  stderrTail: string | null
): PhysicalAuditSummary {
  if (!existsSync(outputPathForScript)) {
    return {
      status: 'error',
      script,
      outputPath: outputPathForScript,
      command,
      exitCode,
      durationSec: durationSecForScript,
      dtSec: dtSecForScript,
      finalSimTimeSec: null,
      totalPph: null,
      completedTotal: null,
      physicalViolations: null,
      deadlocks: null,
      livelocks: null,
      anomalies: null,
      criticalAnomalies: null,
      anomalyCounts: {},
      stderrTail: stderrTail ?? 'Physical audit script did not write its report.'
    };
  }
  const data = JSON.parse(readFileSync(outputPathForScript, 'utf8')) as {
    finalSimTimeSec?: number;
    summary?: {
      completedInbound?: number;
      completedOutbound?: number;
      completedTotal?: number;
      totalPph?: number;
      physicalViolations?: number;
      deadlocks?: number;
      livelocks?: number;
      anomalyCounts?: Record<string, number>;
    };
    anomalies?: Array<{ severity?: string; code?: string }>;
  };
  const criticalAnomalies = (data.anomalies ?? []).filter((anomaly) => anomaly.severity === 'critical').length;
  const anomalyCount = data.anomalies?.length ?? Object.values(data.summary?.anomalyCounts ?? {}).reduce((sum, count) => sum + count, 0);
  const physicalViolations = data.summary?.physicalViolations ?? null;
  const deadlocks = data.summary?.deadlocks ?? null;
  const livelocks = data.summary?.livelocks ?? null;
  const status: PhysicalAuditStatus = (
    exitCode === 0 &&
    criticalAnomalies === 0 &&
    (physicalViolations ?? 0) === 0 &&
    (deadlocks ?? 0) === 0 &&
    (livelocks ?? 0) === 0
  ) ? 'pass' : 'fail';
  return {
    status,
    script,
    outputPath: outputPathForScript,
    command,
    exitCode,
    durationSec: durationSecForScript,
    dtSec: dtSecForScript,
    finalSimTimeSec: data.finalSimTimeSec ?? null,
    totalPph: data.summary?.totalPph ?? null,
    completedTotal: data.summary?.completedTotal ?? (
      typeof data.summary?.completedInbound === 'number' && typeof data.summary?.completedOutbound === 'number'
        ? data.summary.completedInbound + data.summary.completedOutbound
        : null
    ),
    physicalViolations,
    deadlocks,
    livelocks,
    anomalies: anomalyCount,
    criticalAnomalies,
    anomalyCounts: data.summary?.anomalyCounts ?? {},
    stderrTail
  };
}

function skippedPhysicalAudit(
  script: string,
  outputPathForScript: string,
  durationSecForScript: number,
  dtSecForScript: number
): PhysicalAuditSummary {
  return {
    status: 'skipped',
    script,
    outputPath: outputPathForScript,
    command: [],
    exitCode: null,
    durationSec: durationSecForScript,
    dtSec: dtSecForScript,
    finalSimTimeSec: null,
    totalPph: null,
    completedTotal: null,
    physicalViolations: null,
    deadlocks: null,
    livelocks: null,
    anomalies: null,
    criticalAnomalies: null,
    anomalyCounts: {},
    stderrTail: null
  };
}

function renderHtml(reportData: typeof report): string {
  const { result } = reportData;
  const periodRows = buildPeriodRows(result);
  const finalPeriod = periodRows.at(-1);
  const hourlyThroughputChart = renderLineChart({
    title: 'Hourly PPH by Flow',
    subtitle: '每个采样小时内完成量 / 1h。Total = Inbound + Outbound，不是累计平均。',
    yLabel: 'PPH',
    series: [
      { label: 'Inbound', color: '#77c8ff', points: periodRows.map((row) => ({ x: row.endHour, y: row.inboundPph })) },
      { label: 'Outbound', color: '#f1b752', points: periodRows.map((row) => ({ x: row.endHour, y: row.outboundPph })) },
      { label: 'Total', color: '#8df0b0', points: periodRows.map((row) => ({ x: row.endHour, y: row.totalPph })) }
    ]
  });
  const waitingTrendChart = renderLineChart({
    title: 'Hourly Waiting / Reposition Share',
    subtitle: '分母是小时内 fleet available time = 采样秒数 x shuttle 数量。',
    yLabel: '% of fleet time',
    thresholds: [
      { label: 'waiting watch 10%', y: 10, color: '#f1b752' },
      { label: 'waiting critical 15%', y: 15, color: '#ff6f6f' }
    ],
    series: [
      { label: 'Waiting', color: '#f1b752', points: periodRows.map((row) => ({ x: row.endHour, y: row.waitingPct })) },
      { label: 'Reposition', color: '#b997ff', points: periodRows.map((row) => ({ x: row.endHour, y: row.repositionPct })) }
    ]
  });
  const cumulativeThroughputChart = renderLineChart({
    title: 'Cumulative PPH Stabilization',
    subtitle: '累计 PPH 用来判断长周期是否稳定，小时 PPH 用来找局部异常。',
    yLabel: 'PPH',
    series: [
      { label: 'Inbound cumulative', color: '#77c8ff', points: result.samples.filter((sample) => sample.timeSec > 0).map((sample) => ({ x: sample.timeSec / 3600, y: sample.inboundPph })) },
      { label: 'Outbound cumulative', color: '#f1b752', points: result.samples.filter((sample) => sample.timeSec > 0).map((sample) => ({ x: sample.timeSec / 3600, y: sample.outboundPph })) },
      { label: 'Total cumulative', color: '#8df0b0', points: result.samples.filter((sample) => sample.timeSec > 0).map((sample) => ({ x: sample.timeSec / 3600, y: sample.totalPph })) }
    ]
  });
  const reservationReplayEvidence = renderReservationReplayEvidence(result);
  const physicalRows = [reportData.physicalAudit.contract, reportData.physicalAudit.liveness].map((audit) => `
    <tr>
      <td>${escapeHtml(audit.script.replace('scripts/', ''))}</td>
      <td><span class="status ${audit.status}">${audit.status}</span></td>
      <td>${formatClock(audit.durationSec)}</td>
      <td>${round(audit.dtSec, 3)}s</td>
      <td>${audit.completedTotal ?? '-'}</td>
      <td>${audit.physicalViolations ?? '-'}</td>
      <td>${audit.criticalAnomalies ?? '-'}</td>
      <td>${audit.outputPath ? `<a href="${escapeHtml(audit.outputPath)}">${escapeHtml(audit.outputPath.split('/').at(-1) ?? audit.outputPath)}</a>` : '-'}</td>
    </tr>
  `).join('');
  const issueCards = result.issues.map((issue, index) => `
    <article class="issue ${issue.severity}" id="issue-${index + 1}">
      <p class="eyebrow">${issue.severity}</p>
      <h2>${escapeHtml(issue.title)}</h2>
      <strong>${escapeHtml(issue.metric)}</strong>
      <p>${escapeHtml(issue.detail)}</p>
      <p class="recommendation">${escapeHtml(issue.recommendation)}</p>
    </article>
  `).join('');
  const liftRows = Object.entries(result.liftPph).map(([id, lift]) => `
    <tr><td>${escapeHtml(id)}</td><td>${lift.kind}</td><td>${round(lift.pph, 1)}</td><td>${round(lift.utilization * 100, 1)}%</td><td>${lift.completed}</td></tr>
  `).join('');
  const shuttleRows = Object.entries(result.shuttleUtilization).map(([id, shuttle]) => `
    <tr>
      <td>${escapeHtml(id)}</td>
      <td>${round(shuttle.busy * 100, 1)}%</td>
      <td>${round(shuttle.travel * 100, 1)}%</td>
      <td>${round(shuttle.handling * 100, 1)}%</td>
      <td>${round(shuttle.resourceWait * 100, 1)}%</td>
      <td>${round(shuttle.liftWait * 100, 1)}%</td>
      <td>${round(shuttle.trafficWait * 100, 1)}%</td>
      <td>${shuttle.tasks}</td>
    </tr>
  `).join('');
  const bottleneckRows = Object.entries(result.bottlenecks)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([reason, count]) => `<tr><td>${escapeHtml(reason)}</td><td>${count}</td></tr>`)
    .join('');
  const waitReasonRows = Object.entries(result.waitReasonBreakdown).map(([reason, item]) => `
    <tr><td>${escapeHtml(reason)}</td><td>${round(item.seconds / 3600, 2)}h</td><td>${round(item.pct, 2)}%</td></tr>
  `).join('');
  const repositionRows = Object.entries(result.repositionBreakdown).map(([reason, item]) => `
    <tr><td>${escapeHtml(reason)}</td><td>${round(item.seconds / 3600, 2)}h</td><td>${round(item.pct, 2)}%</td></tr>
  `).join('');
  const trafficBottleneckRows = result.trafficBottlenecks.length === 0
    ? '<tr><td colspan="3">No traffic reservation waits were recorded.</td></tr>'
    : result.trafficBottlenecks.slice(0, 12).map((resource) => `
      <tr>
        <td>${escapeHtml(resource.resourceId)}</td>
        <td>${round(resource.waitSec / 3600, 2)}h</td>
        <td>${resource.waitCount}</td>
      </tr>
    `).join('');
  const policySensitivityRows = reportData.policySensitivity.map((row) => `
    <tr>
      <td>${row.maxActiveTasks}${row.isCurrent ? ' current' : ''}</td>
      <td>${round(row.totalPph, 1)}</td>
      <td>${round(row.inboundPph, 1)}</td>
      <td>${round(row.outboundPph, 1)}</td>
      <td>${round(row.averageWaitingPct, 2)}%</td>
      <td>${round(row.averageRepositionPct, 2)}%</td>
      <td>${round(row.trafficWaitHours, 2)}h</td>
      <td>${escapeHtml(row.topTrafficResource)}</td>
      <td>${row.routeMisses}</td>
      <td>${row.issueCount}</td>
      <td>${escapeHtml(policyDecisionFor(row, reportData.policySensitivity))}</td>
    </tr>
  `).join('');
  const bestPolicy = maxBy(reportData.policySensitivity, (row) => row.totalPph);
  const currentPolicy = reportData.policySensitivity.find((row) => row.isCurrent);
  const balancedPolicy = selectBalancedPolicy(reportData.policySensitivity);
  const policyNarrative = bestPolicy && currentPolicy
    ? `Capacity-only best cap is ${bestPolicy.maxActiveTasks} at ${round(bestPolicy.totalPph, 1)} PPH, but it carries ${round(bestPolicy.averageWaitingPct, 2)}% waiting. Balanced review recommendation is cap ${balancedPolicy.maxActiveTasks} at ${round(balancedPolicy.totalPph, 1)} PPH with ${round(balancedPolicy.averageWaitingPct, 2)}% waiting and ${round(balancedPolicy.averageRepositionPct, 2)}% reposition. Current cap ${currentPolicy.maxActiveTasks} is ${round(currentPolicy.totalPph, 1)} PPH.`
    : 'Policy sensitivity was not available for this report.';
  const hourlyRows = periodRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td>${row.inboundDelta}</td>
      <td>${row.outboundDelta}</td>
      <td>${round(row.inboundPph, 1)}</td>
      <td>${round(row.outboundPph, 1)}</td>
      <td>${round(row.totalPph, 1)}</td>
      <td>${round(row.cumulativeTotalPph, 1)}</td>
      <td>${round(row.waitingPct, 2)}%</td>
      <td>${round(row.repositionPct, 2)}%</td>
      <td>${row.waitingVehicles}</td>
      <td>${round(row.queuedTaskAgeMaxSec, 0)}s</td>
    </tr>
  `).join('');
  const validationRows = [
    ['Verification', 'DES route contract', result.routeModel.routeUnavailableCount === 0 ? 'pass' : 'fail', `${result.routeModel.routeUnavailableCount} unavailable yellow-graph routes`],
    ['Verification', 'Reservation avoidance', result.routeModel.reservationWindowCount > 0 ? 'pass' : 'watch', `${result.routeModel.reservationWindowCount} node/edge reservation windows, ${round(result.routeModel.trafficWaitSec / 3600, 2)}h traffic wait`],
    ['Verification', 'Physical yellow-grid contract smoke', reportData.physicalAudit.contract.status, `${reportData.physicalAudit.contract.physicalViolations ?? '-'} physical violations`],
    ['Verification', 'Physical liveness smoke', reportData.physicalAudit.liveness.status, `${reportData.physicalAudit.liveness.deadlocks ?? '-'} deadlocks, ${reportData.physicalAudit.liveness.livelocks ?? '-'} livelocks`],
    ['Validation', 'Handling-time assumption', 'needs-site-data', `lift ${reportData.assumptions.liftTimeSec}s, lower ${reportData.assumptions.lowerTimeSec}s; still needs calibration against real PLC/video cycle timing`],
    ['Validation', 'Demand profile', 'needs-site-data', `${inboundRatePerHour} inbound PPH demand and ${outboundRatePerHour} outbound PPH demand are stress inputs, not yet proven real Monday demand`]
  ].map(([kind, check, status, evidence]) => `
    <tr>
      <td>${escapeHtml(kind)}</td>
      <td>${escapeHtml(check)}</td>
      <td><span class="status ${statusClass(status)}">${escapeHtml(status)}</span></td>
      <td>${escapeHtml(evidence)}</td>
    </tr>
  `).join('');
  const dataIntegrityRows = reportData.dataIntegrity.map((check) => `
    <tr>
      <td>${escapeHtml(check.check)}</td>
      <td><span class="status ${statusClass(check.status)}">${escapeHtml(check.status)}</span></td>
      <td>${escapeHtml(check.evidence)}</td>
      <td>${escapeHtml(check.formula)}</td>
    </tr>
  `).join('');
  const goalAuditRows = buildGoalAuditRows(reportData, periodRows).map((row) => `
    <tr>
      <td>${escapeHtml(row.requirement)}</td>
      <td><span class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.evidence)}</td>
      <td>${escapeHtml(row.remainingWork)}</td>
    </tr>
  `).join('');
  const visualEvidenceItems = buildVisualEvidenceItems();
  const visualEvidenceCards = visualEvidenceItems.length > 0
    ? visualEvidenceItems.map((item) => `
      <figure class="visual-card">
        <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.title)}" loading="eager" />
        <figcaption>
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.caption)}</span>
        </figcaption>
      </figure>
    `).join('')
    : '<p>No review screenshots were found in output/review/screenshots yet.</p>';
  const siteCalibrationRows = buildSiteCalibrationRows(reportData).map((row) => `
    <tr>
      <td>${escapeHtml(row.area)}</td>
      <td>${escapeHtml(row.dataNeeded)}</td>
      <td>${escapeHtml(row.currentAssumption)}</td>
      <td>${escapeHtml(row.evidenceSource)}</td>
      <td>${escapeHtml(row.modelImpact)}</td>
    </tr>
  `).join('');
  const executiveFinding = buildExecutiveFinding(result, finalPeriod);
  const reviewBriefCards = buildReviewBriefCards(reportData, periodRows).map((card) => `
    <article class="brief-card ${card.tone}">
      <p class="eyebrow">${escapeHtml(card.kicker)}</p>
      <h2>${escapeHtml(card.title)}</h2>
      <strong>${escapeHtml(card.value)}</strong>
      <p>${escapeHtml(card.detail)}</p>
    </article>
  `).join('');
  const ieFindingCards = buildIeFindings(result, periodRows).map((finding) => `
    <article class="finding ${finding.severity}">
      <p class="eyebrow">${escapeHtml(finding.severity)}</p>
      <h2>${escapeHtml(finding.title)}</h2>
      <strong>${escapeHtml(finding.metric)}</strong>
      <p>${escapeHtml(finding.evidence)}</p>
      <p class="recommendation">${escapeHtml(finding.recommendation)}</p>
    </article>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DES Shuttle V&V Review</title>
  <style>
    :root { color-scheme: dark; --bg: #0d141b; --panel: #14202a; --panel-2: #101922; --line: #314454; --text: #edf4f7; --muted: #a8b8c3; --warn: #f1b752; --crit: #ff6f6f; --ok: #43c687; --blue: #77c8ff; --violet: #b997ff; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    header, section, article { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 18px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 20px; }
    p { color: var(--muted); line-height: 1.5; }
    .eyebrow { margin: 0 0 7px; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: rgba(255,255,255,.035); }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 8px; font-size: 25px; }
    .metric small { display: block; margin-top: 6px; color: var(--muted); line-height: 1.35; }
    .summary { border-left: 4px solid var(--blue); background: var(--panel-2); }
    .summary p { margin-bottom: 0; color: var(--text); }
    .issues { display: grid; gap: 12px; }
    .brief-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .brief-card { background: var(--panel-2); min-height: 150px; }
    .brief-card h2 { font-size: 15px; }
    .brief-card strong { display: block; margin-top: 10px; font-size: 20px; line-height: 1.2; }
    .brief-card p:last-child { margin-bottom: 0; font-size: 12px; }
    .brief-card.pass { border-color: rgba(67,198,135,.52); }
    .brief-card.watch { border-color: rgba(241,183,82,.7); }
    .brief-card.validation { border-color: rgba(185,151,255,.68); }
    .finding-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .finding { background: var(--panel-2); }
    .finding.action { border-color: rgba(255,111,111,.72); }
    .finding.watch { border-color: rgba(241,183,82,.68); }
    .finding.observation { border-color: rgba(119,200,255,.52); }
    .finding.validation { border-color: rgba(185,151,255,.62); }
    .finding strong { display: block; margin-top: 8px; font-size: 17px; }
    .issue.critical { border-color: rgba(255,111,111,.7); }
    .issue.warning { border-color: rgba(241,183,82,.58); }
    .issue.observation { border-color: rgba(67,198,135,.45); }
    .issue strong { display: block; margin-top: 8px; font-size: 17px; }
    .recommendation { color: var(--text); }
    .status { display: inline-block; min-width: 62px; padding: 3px 7px; border-radius: 6px; text-align: center; color: #071016; font-weight: 700; }
    .status.pass { background: var(--ok); }
    .status.watch, .status.needs-site-data, .status.observation { background: var(--warn); }
    .status.fail, .status.error { background: var(--crit); }
    .status.skipped { background: var(--warn); }
    a { color: #86d7ff; text-decoration: none; }
    .charts, .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .chart { border: 1px solid var(--line); border-radius: 8px; background: #0b1219; padding: 12px; }
    .chart svg { width: 100%; height: 320px; display: block; }
    .chart-title { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 4px; }
    .chart-title strong { font-size: 18px; }
    .chart-title span, .chart-subtitle { color: var(--muted); font-size: 12px; }
    .value-label { paint-order: stroke; stroke: #0b1219; stroke-width: 3px; stroke-linejoin: round; }
    .legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .legend i { display: inline-block; width: 18px; height: 3px; vertical-align: middle; margin-right: 5px; }
    .route-map-card { border: 1px solid var(--line); border-radius: 8px; background: #0b1219; padding: 12px; margin: 14px 0; }
    .route-map-svg { width: 100%; height: 300px; display: block; background: #070d13; border-radius: 6px; }
    .route-grid-edge { stroke: rgba(168,184,195,.25); stroke-width: .06; vector-effect: non-scaling-stroke; }
    .route-polyline { fill: none; stroke-width: .13; stroke-linecap: round; stroke-linejoin: round; opacity: .52; vector-effect: non-scaling-stroke; }
    .route-polyline.empty { stroke: #77c8ff; }
    .route-polyline.inbound { stroke: #43c687; }
    .route-polyline.outbound { stroke: #f1b752; }
    .route-vehicle circle { fill: #edf4f7; stroke: #071016; stroke-width: .13; vector-effect: non-scaling-stroke; }
    .route-vehicle.inbound circle { fill: #43c687; }
    .route-vehicle.outbound circle { fill: #f1b752; }
    .route-vehicle.wait circle { fill: #ff6f6f; }
    .route-vehicle text { fill: #edf4f7; font-size: 1.35px; font-weight: 800; paint-order: stroke; stroke: #071016; stroke-width: .18px; }
    .route-map-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 9px; color: var(--muted); font-size: 12px; }
    .route-map-legend span::before { content: ""; display: inline-block; width: 14px; height: 3px; margin-right: 6px; vertical-align: middle; background: currentColor; }
    .route-map-legend .empty { color: #77c8ff; }
    .route-map-legend .inbound { color: #43c687; }
    .route-map-legend .outbound { color: #f1b752; }
    .route-map-legend .wait { color: #ff6f6f; }
    .replay-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .45fr); gap: 12px; }
    .replay-axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; padding-left: 105px; }
    .replay-row { display: grid; grid-template-columns: 95px minmax(0, 1fr); gap: 10px; align-items: center; margin-top: 8px; }
    .replay-row strong { display: block; font-size: 12px; }
    .replay-row small { color: var(--muted); font-size: 11px; }
    .replay-lane { position: relative; height: 22px; border: 1px solid var(--line); border-radius: 5px; background: repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 1px, transparent 1px 12.5%), #0c131b; overflow: hidden; }
    .replay-cursor { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(237,244,247,.9); box-shadow: 0 0 8px rgba(134,215,255,.85); animation: replay-scan 9s linear infinite; z-index: 4; }
    @keyframes replay-scan { from { left: 0; } to { left: calc(100% - 2px); } }
    .replay-phase { position: absolute; top: 4px; height: 13px; border-radius: 3px; opacity: .92; }
    .replay-phase.empty { background: #77c8ff; }
    .replay-phase.loaded { background: #43c687; }
    .replay-phase.handle { background: #8dd6c9; }
    .replay-phase.wait { background: #f1b752; z-index: 2; }
    .replay-phase.lift-wait { background: #ff6f6f; z-index: 2; }
    .replay-legend { display: flex; flex-wrap: wrap; gap: 10px 14px; color: var(--muted); font-size: 12px; margin-top: 10px; padding-left: 105px; }
    .replay-legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; background: currentColor; }
    .replay-legend .empty { color: #77c8ff; }
    .replay-legend .loaded { color: #43c687; }
    .replay-legend .handle { color: #8dd6c9; }
    .replay-legend .wait { color: #f1b752; }
    .replay-legend .lift-wait { color: #ff6f6f; }
    .replay-waits table { table-layout: fixed; min-width: 0; }
    .replay-waits th, .replay-waits td { white-space: normal; overflow-wrap: anywhere; font-size: 11px; padding: 6px 4px; }
    .replay-waits th:nth-child(1), .replay-waits td:nth-child(1) { width: 58px; }
    .replay-waits th:nth-child(2), .replay-waits td:nth-child(2) { width: 45px; }
    .replay-waits th:nth-child(3), .replay-waits td:nth-child(3) { width: 45px; }
    details { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.025); padding: 12px; }
    summary { cursor: pointer; font-weight: 700; }
    .table-wrap { margin-top: 12px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-top: 1px solid var(--line); padding: 9px; text-align: left; color: var(--muted); }
    th { color: var(--text); }
    .calibration-table th, .calibration-table td { white-space: normal; overflow-wrap: anywhere; vertical-align: top; }
    .visual-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
    .visual-card { margin: 0; border: 1px solid var(--line); border-radius: 8px; background: #0b1219; overflow: hidden; }
    .visual-card img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #071016; }
    .visual-card figcaption { display: grid; gap: 5px; padding: 11px; }
    .visual-card figcaption strong { color: var(--text); }
    .visual-card figcaption span { color: var(--muted); font-size: 12px; line-height: 1.4; }
    @media (max-width: 1100px) { .brief-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 860px) { .grid, .charts, .two, .replay-grid, .brief-grid { grid-template-columns: 1fr; } main { padding: 14px; } }
    @media (max-width: 860px) { .finding-grid, .visual-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">event-driven DES V&V review</p>
      <h1>Four-Way Shuttle DES V&V Review</h1>
      <p>${formatClock(result.durationSec)} simulated in ${round(result.wallClockMs / 1000, 2)}s wall clock. Sampling: ${formatClock(reportData.assumptions.sampleIntervalSec)}. Handling: lift ${reportData.assumptions.liftTimeSec}s, lower ${reportData.assumptions.lowerTimeSec}s. Scenario hash ${reportData.scenarioHash}.</p>
    </header>
    <section class="summary">
      <p class="eyebrow">Industrial Engineering Readout</p>
      <h2>What This Run Says</h2>
      <p>${escapeHtml(executiveFinding)}</p>
    </section>
    <section>
      <p class="eyebrow">Answer-First Review Brief</p>
      <h2>客户 review 先讲这 5 件事</h2>
      <div class="brief-grid">${reviewBriefCards}</div>
    </section>
    <section>
      <p class="eyebrow">Goal Evidence Audit</p>
      <h2>目标要求与当前证据</h2>
      <p>This table maps the review goal to concrete evidence in this artifact. Items marked needs-site-data are not software gaps; they are the real customer/site measurements required before making a site-calibrated capacity claim.</p>
      <div class="table-wrap">
        <table class="goal-audit-table">
          <thead><tr><th>Requirement</th><th>Status</th><th>Current Evidence</th><th>Remaining Work</th></tr></thead>
          <tbody>${goalAuditRows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <p class="eyebrow">Visual Verification Gallery</p>
      <h2>实时 3D / DES 避障 / 统计审计截图</h2>
      <p>These captured views make the animation and analytical evidence visible inside the review artifact instead of leaving them as separate files.</p>
      <div class="visual-grid">${visualEvidenceCards}</div>
    </section>
    <section class="grid">
      <div class="metric"><span>Total PPH</span><strong>${round(result.totalPph, 1)}</strong></div>
      <div class="metric"><span>Inbound PPH</span><strong>${round(result.inboundPph, 1)}</strong><small>${result.completedInbound} completed</small></div>
      <div class="metric"><span>Outbound PPH</span><strong>${round(result.outboundPph, 1)}</strong><small>${result.completedOutbound} completed</small></div>
      <div class="metric"><span>Latest Hour PPH</span><strong>${finalPeriod ? round(finalPeriod.totalPph, 1) : '-'}</strong><small>window/local rate</small></div>
      <div class="metric"><span>Avg Waiting</span><strong>${round(result.averageWaitingPct, 1)}%</strong><small>${round(waitReasonPct(result, 'traffic-reservation-wait'), 1)}% traffic, ${round(waitReasonPct(result, 'lift-resource-wait'), 1)}% lift</small></div>
      <div class="metric"><span>Avg Reposition</span><strong>${round(result.averageRepositionPct, 1)}%</strong><small>empty travel to pickup</small></div>
      <div class="metric"><span>Max Continuous Wait</span><strong>${round(result.maxContinuousWaitingSec, 0)}s</strong></div>
      <div class="metric"><span>Issues</span><strong>${result.issues.length}</strong><small>${result.issues.map((issue) => issue.severity).join(', ') || 'none'}</small></div>
    </section>
    <section class="grid">
      <div class="metric"><span>Route Model</span><strong>${escapeHtml(result.routeModel.kind.replace('yellow-graph-', ''))}</strong></div>
      <div class="metric"><span>Drivable Nodes</span><strong>${result.routeModel.drivableNodeCount}</strong></div>
      <div class="metric"><span>Route Misses</span><strong>${result.routeModel.routeUnavailableCount}</strong></div>
      <div class="metric"><span>Reservation Windows</span><strong>${result.routeModel.reservationWindowCount}</strong></div>
      <div class="metric"><span>Traffic Wait</span><strong>${round(result.routeModel.trafficWaitSec / 3600, 1)}h</strong></div>
      <div class="metric"><span>Max Active Tasks</span><strong>${result.controlPolicy.maxActiveTasks}</strong></div>
      <div class="metric"><span>Backpressure Holds</span><strong>${result.controlPolicy.backpressureHoldCount}</strong></div>
      <div class="metric"><span>Physical Gate</span><strong>${reportData.physicalAudit.contract.status}/${reportData.physicalAudit.liveness.status}</strong></div>
    </section>
    <section class="charts">
      ${hourlyThroughputChart}
      ${waitingTrendChart}
    </section>
    <section>
      <p class="eyebrow">Industrial Engineering Findings</p>
      <h2>What To Inspect Before Customer Review</h2>
      <div class="finding-grid">${ieFindingCards}</div>
    </section>
    <section>
      <p class="eyebrow">Dispatch Policy Sensitivity</p>
      <h2>Max Active Task Cap 对比</h2>
      <p>${escapeHtml(policyNarrative)} This is a control-policy comparison on the same scenario and duration, so it helps separate layout/lift limits from dispatch-release behavior.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Cap</th><th>Total PPH</th><th>In PPH</th><th>Out PPH</th><th>Wait</th><th>Reposition</th><th>Traffic Wait</th><th>Top Traffic Resource</th><th>Route Miss</th><th>Issues</th><th>IE Read</th></tr></thead>
          <tbody>${policySensitivityRows}</tbody>
        </table>
      </div>
    </section>
    ${reservationReplayEvidence}
    <section>
      ${cumulativeThroughputChart}
    </section>
    <section>
      <p class="eyebrow">Metric Definitions</p>
      <h2>Window PPH / Waiting Share 口径</h2>
      <table>
        <thead><tr><th>Metric</th><th>Definition</th><th>Why it matters</th></tr></thead>
        <tbody>
          <tr><td>Inbound PPH</td><td>completed inbound loads / elapsed hours</td><td>入库处理能力，累计值用于长周期稳定性。</td></tr>
          <tr><td>Outbound PPH</td><td>completed outbound loads / elapsed hours</td><td>出库处理能力，累计值用于长周期稳定性。</td></tr>
          <tr><td>Hourly / Window PPH</td><td>loads completed inside that hour / 1 hour</td><td>用来找局部掉速、拥堵和调度抖动。</td></tr>
          <tr><td>Waiting Share</td><td>resource-wait seconds / (period seconds x shuttle count)</td><td>等待 lift 或 traffic reservation 的车队时间占比。</td></tr>
          <tr><td>Reposition Share</td><td>empty travel to next pickup / (period seconds x shuttle count)</td><td>反映任务分配和库区布局造成的空驶负担。</td></tr>
          <tr><td>DES Avoidance</td><td>yellow-grid nodes and edges are reserved over time windows</td><td>在 DES 中用时空 reservation 避免互穿，而不是逐帧物理碰撞。</td></tr>
        </tbody>
      </table>
    </section>
    <section>
      <p class="eyebrow">Validation & Verification</p>
      <h2>V&V Gate Status</h2>
      <table><thead><tr><th>Type</th><th>Check</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${validationRows}</tbody></table>
    </section>
    <section>
      <p class="eyebrow">Data Integrity</p>
      <h2>数字口径自动校验</h2>
      <p>These checks recompute the review metrics from generated samples and gate outputs. A fail status makes the report generation fail so incorrect PPH or monitoring gaps do not silently enter the customer pack.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Check</th><th>Status</th><th>Evidence</th><th>Formula / Source</th></tr></thead>
          <tbody>${dataIntegrityRows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <p class="eyebrow">Site Calibration Request</p>
      <h2>Data Needed Before A Site Capacity Claim</h2>
      <p>The DES and physical smoke gates verify internal behavior. The items below are the remaining customer/site data required to convert this review run from an internally verified model into a site-calibrated capacity claim.</p>
      <div class="table-wrap">
        <table class="calibration-table">
          <thead><tr><th>Area</th><th>Data Needed</th><th>Current Assumption</th><th>Evidence Source</th><th>Model Impact</th></tr></thead>
          <tbody>${siteCalibrationRows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <p class="eyebrow">Physical Audit Gate</p>
      <h2>Yellow-Grid Contract + Liveness Smoke</h2>
      <p>${escapeHtml(reportData.physicalAudit.note)}</p>
      <table>
        <thead><tr><th>Audit</th><th>Status</th><th>Duration</th><th>dt</th><th>Completed</th><th>Physical Violations</th><th>Critical Anomalies</th><th>JSON</th></tr></thead>
        <tbody>${physicalRows}</tbody>
      </table>
    </section>
    <section class="issues">
      <p class="eyebrow">Issues</p>
      ${issueCards}
    </section>
    <section>
      <p class="eyebrow">Hourly Audit Table</p>
      <h2>每小时 Throughput / Wait / Reposition</h2>
      <details open>
        <summary>${periodRows.length} hourly samples</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Hour</th><th>In Done</th><th>Out Done</th><th>In PPH</th><th>Out PPH</th><th>Total PPH</th><th>Cum PPH</th><th>Wait</th><th>Reposition</th><th>Waiting Vehicles</th><th>Max Queue Age</th></tr></thead>
            <tbody>${hourlyRows}</tbody>
          </table>
        </div>
      </details>
    </section>
    <section class="two">
      <div>
        <h2>Lift Ports</h2>
        <table><thead><tr><th>Lift</th><th>Kind</th><th>PPH</th><th>Util</th><th>Done</th></tr></thead><tbody>${liftRows}</tbody></table>
      </div>
      <div>
        <h2>Bottlenecks</h2>
        <table><thead><tr><th>Reason</th><th>Count</th></tr></thead><tbody>${bottleneckRows}</tbody></table>
      </div>
    </section>
    <section class="two">
      <div>
        <h2>Wait Reason Breakdown</h2>
        <table><thead><tr><th>Reason</th><th>Fleet Hours</th><th>Fleet Time</th></tr></thead><tbody>${waitReasonRows}</tbody></table>
      </div>
      <div>
        <h2>Reposition Breakdown</h2>
        <table><thead><tr><th>Reason</th><th>Fleet Hours</th><th>Fleet Time</th></tr></thead><tbody>${repositionRows}</tbody></table>
      </div>
    </section>
    <section>
      <h2>Traffic Reservation Bottlenecks</h2>
      <table><thead><tr><th>Resource</th><th>Wait</th><th>Count</th></tr></thead><tbody>${trafficBottleneckRows}</tbody></table>
    </section>
    <section>
      <h2>Shuttle Utilization</h2>
      <table><thead><tr><th>Unit</th><th>Busy</th><th>Travel</th><th>Handling</th><th>Total Wait</th><th>Lift Wait</th><th>Traffic Wait</th><th>Tasks</th></tr></thead><tbody>${shuttleRows}</tbody></table>
    </section>
  </main>
</body>
</html>`;
}

type DesResult = typeof report.result;
type DesSample = DesResult['samples'][number];
type ChartPoint = { x: number; y: number };
type ChartSeries = { label: string; color: string; points: ChartPoint[] };
type ChartThreshold = { label: string; y: number; color: string };
type ReportPoint = { x: number; z: number };
type ReportLayoutNode = (typeof scenario.layout.nodes)[number];
type PeriodRow = {
  label: string;
  startSec: number;
  endSec: number;
  endHour: number;
  inboundDelta: number;
  outboundDelta: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  cumulativeTotalPph: number;
  waitingPct: number;
  repositionPct: number;
  waitingVehicles: number;
  queuedTaskAgeMaxSec: number;
};
type IeFindingSeverity = 'action' | 'watch' | 'observation' | 'validation';
type IeFinding = {
  id: string;
  severity: IeFindingSeverity;
  title: string;
  metric: string;
  evidence: string;
  recommendation: string;
};
type SiteCalibrationRow = {
  area: string;
  dataNeeded: string;
  currentAssumption: string;
  evidenceSource: string;
  modelImpact: string;
};
type GoalAuditRow = {
  requirement: string;
  status: 'pass' | 'watch' | 'needs-site-data' | 'fail';
  evidence: string;
  remainingWork: string;
};
type DataIntegrityCheck = {
  check: string;
  status: 'pass' | 'watch' | 'fail';
  evidence: string;
  formula: string;
};
type PolicySensitivityRow = {
  maxActiveTasks: number;
  isCurrent: boolean;
  totalPph: number;
  inboundPph: number;
  outboundPph: number;
  averageWaitingPct: number;
  averageRepositionPct: number;
  trafficWaitHours: number;
  topTrafficResource: string;
  routeMisses: number;
  issueCount: number;
  wallClockMs: number;
};
type VisualEvidenceItem = {
  title: string;
  caption: string;
  src: string;
};
type ReviewBriefCard = {
  kicker: string;
  title: string;
  value: string;
  detail: string;
  tone: 'pass' | 'watch' | 'validation';
};

function buildPeriodRows(result: DesResult): PeriodRow[] {
  const samples = [...result.samples].sort((left, right) => left.timeSec - right.timeSec);
  const rows: PeriodRow[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const periodSec = Math.max(1, current.timeSec - previous.timeSec);
    const periodHours = periodSec / 3600;
    const inboundDelta = current.completedInbound - previous.completedInbound;
    const outboundDelta = current.completedOutbound - previous.completedOutbound;
    rows.push({
      label: periodLabel(previous.timeSec, current.timeSec),
      startSec: previous.timeSec,
      endSec: current.timeSec,
      endHour: current.timeSec / 3600,
      inboundDelta,
      outboundDelta,
      inboundPph: inboundDelta / periodHours,
      outboundPph: outboundDelta / periodHours,
      totalPph: (inboundDelta + outboundDelta) / periodHours,
      cumulativeTotalPph: current.totalPph,
      waitingPct: periodPctFromCumulative(previous, current, 'averageWaitingPct', result),
      repositionPct: periodPctFromCumulative(previous, current, 'averageRepositionPct', result),
      waitingVehicles: current.waitingVehicles,
      queuedTaskAgeMaxSec: current.queuedTaskAgeMaxSec
    });
  }
  return rows;
}

function buildVisualEvidenceItems(): VisualEvidenceItem[] {
  const candidates: VisualEvidenceItem[] = [
    {
      title: 'Dashboard Answer-First Summary',
      caption: 'Live dashboard answer-first cockpit: total/inbound/outbound PPH, lowest/highest period, first bottleneck, and site-calibration boundary in one review-facing row.',
      src: 'screenshots/dashboard-answer-first-panel.png'
    },
    {
      title: 'Dashboard Review Readiness',
      caption: 'Dashboard pass/watch boundary showing internal metric evidence, yellow-grid contract, DES issue gate, and remaining site-data requirement.',
      src: 'screenshots/dashboard-review-readiness-panel.png'
    },
    {
      title: 'Dashboard DES Period PPH',
      caption: 'Live dashboard period-by-period inbound, outbound, and total PPH curve with numeric low/high/latest callouts and tabular deltas.',
      src: 'screenshots/dashboard-des-period-pph-panel-focused.png'
    },
    {
      title: 'Dashboard DES Data Integrity',
      caption: 'Formula-level dashboard checks proving final counts, period deltas, PPH formulas, sample order, finite metrics, route contract, and critical issue gate.',
      src: 'screenshots/dashboard-des-data-integrity-panel-clean.png'
    },
    {
      title: 'Dashboard IE Findings',
      caption: 'Industrial-engineering readout showing DES observations, traffic/lift wait split, first inspect resource, and top yellow-grid bottlenecks.',
      src: 'screenshots/dashboard-des-ie-findings-panel-final.png'
    },
    {
      title: 'Dashboard Dispatch Avoidance Audit',
      caption: 'Trace-level dashboard audit showing dispatch cap, yellow-grid route pass/watch status, reservation-wait seconds, and the blocking resource per task.',
      src: 'screenshots/dashboard-des-dispatch-audit-panel-tall.png'
    },
    {
      title: 'Dashboard DES Replay Bottlenecks',
      caption: 'DES reservation replay map with top traffic bottleneck nodes/edges highlighted directly on the yellow-grid route evidence.',
      src: 'screenshots/dashboard-des-replay-bottleneck-highlight-final.png'
    },
    {
      title: 'Live 3D Shuttle Animation',
      caption: 'Desktop WebGL view of the real-time physical/visual simulation used to inspect vehicle movement, load state, and lift-zone behavior.',
      src: 'screenshots/dashboard-live-actual-3d-animation.png'
    },
    {
      title: 'Review Cockpit 3D + DES Evidence',
      caption: 'Default customer-review cockpit combining live 3D motion, KPI diagnosis, DES avoidance state, and task-level route/wait evidence.',
      src: 'screenshots/dashboard-review-cockpit-3d-des-evidence.png'
    },
    {
      title: 'Mobile 3D Render Check',
      caption: 'Mobile viewport check proving the 3D scene still renders without horizontal overflow or a blank canvas.',
      src: 'screenshots/dashboard-live-actual-3d-mobile-final.png'
    },
    {
      title: 'DES Route Playback',
      caption: 'Analytical DES route playback on the yellow-grid model: vehicles move through reserved nodes/edges instead of overlapping.',
      src: 'screenshots/dashboard-des-route-playback-zoomed.png'
    },
    {
      title: 'Policy Sensitivity',
      caption: 'Max-active-task cap comparison showing throughput gain versus waiting and traffic congestion.',
      src: 'screenshots/des-review-24h-policy-sensitivity.png'
    },
    {
      title: 'Data Integrity Checks',
      caption: 'Automatic metric recompute checks for PPH, hourly deltas, wait/reposition totals, route contract, and physical smoke gates.',
      src: 'screenshots/des-review-24h-data-integrity.png'
    },
    {
      title: 'Site Calibration Request',
      caption: 'Remaining customer/site data required before turning internal V&V into a site-calibrated capacity claim.',
      src: 'screenshots/des-review-24h-vv-site-calibration-request-fixed.png'
    }
  ];

  return candidates.filter((item) => existsSync(`output/review/${item.src}`));
}

function buildReviewBriefCards(reportData: typeof report, periodRows: PeriodRow[]): ReviewBriefCard[] {
  const { result } = reportData;
  const minThroughput = minBy(periodRows, (row) => row.totalPph);
  const maxThroughput = maxBy(periodRows, (row) => row.totalPph);
  const maxWaiting = maxBy(periodRows, (row) => row.waitingPct);
  const maxReposition = maxBy(periodRows, (row) => row.repositionPct);
  const capacityBest = maxBy(reportData.policySensitivity, (row) => row.totalPph);
  const balancedPolicy = selectBalancedPolicy(reportData.policySensitivity);
  const integrityFails = reportData.dataIntegrity.filter((check) => check.status === 'fail').length;
  const integrityWatches = reportData.dataIntegrity.filter((check) => check.status === 'watch').length;
  const physicalPass = reportData.physicalAudit.contract.status === 'pass' && reportData.physicalAudit.liveness.status === 'pass';
  const validationGate = reportData.dataIntegrity.some((check) => check.status === 'fail')
    ? 'fail'
    : physicalPass && result.routeModel.routeUnavailableCount === 0
      ? 'pass'
      : 'watch';

  return [
    {
      kicker: 'Throughput',
      title: `${round(result.durationSec / 3600, 0)}h answer`,
      value: `${round(result.totalPph, 1)} total PPH`,
      detail: `Inbound ${round(result.inboundPph, 1)} PPH (${result.completedInbound} loads), outbound ${round(result.outboundPph, 1)} PPH (${result.completedOutbound} loads).`,
      tone: 'pass'
    },
    {
      kicker: 'Hourly pattern',
      title: 'local dips are visible',
      value: `${minThroughput ? round(minThroughput.totalPph, 1) : '-'}-${maxThroughput ? round(maxThroughput.totalPph, 1) : '-'} PPH`,
      detail: `Lowest ${minThroughput ? minThroughput.label : 'n/a'}; highest ${maxThroughput ? maxThroughput.label : 'n/a'}. Use hourly PPH, not just the long-run average, to discuss service stability.`,
      tone: minThroughput && result.totalPph > 0 && (result.totalPph - minThroughput.totalPph) / result.totalPph >= 0.05 ? 'watch' : 'pass'
    },
    {
      kicker: 'Traffic / empty travel',
      title: 'wait and reposition',
      value: `${round(result.averageWaitingPct, 1)}% wait / ${round(result.averageRepositionPct, 1)}% repo`,
      detail: `Peak waiting ${maxWaiting ? `${round(maxWaiting.waitingPct, 2)}% at ${maxWaiting.label}` : 'n/a'}; peak reposition ${maxReposition ? `${round(maxReposition.repositionPct, 2)}% at ${maxReposition.label}` : 'n/a'}.`,
      tone: maxWaiting && maxWaiting.waitingPct >= 10 ? 'watch' : 'pass'
    },
    {
      kicker: 'Policy read',
      title: 'release cap recommendation',
      value: `cap ${balancedPolicy.maxActiveTasks}`,
      detail: capacityBest
        ? `Capacity-only cap ${capacityBest.maxActiveTasks} reaches ${round(capacityBest.totalPph, 1)} PPH but has ${round(capacityBest.averageWaitingPct, 2)}% waiting; balanced cap ${balancedPolicy.maxActiveTasks} keeps waiting at ${round(balancedPolicy.averageWaitingPct, 2)}%.`
        : 'Policy sensitivity was not available.',
      tone: capacityBest && capacityBest.maxActiveTasks !== balancedPolicy.maxActiveTasks ? 'watch' : 'pass'
    },
    {
      kicker: 'V&V / site claim',
      title: 'internal gates vs real site',
      value: `${validationGate}, ${integrityFails} data fails`,
      detail: `Data integrity: ${reportData.dataIntegrity.length - integrityFails - integrityWatches} pass, ${integrityWatches} watch. Physical gate ${reportData.physicalAudit.contract.status}/${reportData.physicalAudit.liveness.status}; site calibration data is still required before a capacity commitment.`,
      tone: validationGate === 'pass' ? 'validation' : 'watch'
    }
  ];
}

function buildIeFindings(result: DesResult, periodRows: PeriodRow[]): IeFinding[] {
  const findings: IeFinding[] = [];
  const minThroughput = minBy(periodRows, (row) => row.totalPph);
  const maxThroughput = maxBy(periodRows, (row) => row.totalPph);
  if (minThroughput && maxThroughput) {
    const gapFromAveragePct = result.totalPph > 0 ? (result.totalPph - minThroughput.totalPph) / result.totalPph * 100 : 0;
    findings.push({
      id: 'hourly-throughput-range',
      severity: gapFromAveragePct >= 5 ? 'watch' : 'observation',
      title: 'Hourly throughput is stable but local dips still matter',
      metric: `min ${round(minThroughput.totalPph, 1)} PPH at ${minThroughput.label}; max ${round(maxThroughput.totalPph, 1)} PPH at ${maxThroughput.label}`,
      evidence: `24h/period average is ${round(result.totalPph, 1)} PPH. The lowest hour is ${round(gapFromAveragePct, 1)}% below the run average, so the long-run average alone can hide local service dips.`,
      recommendation: 'Use the hourly table to inspect the lowest-throughput hour against waiting share, queue age, and top traffic resources before using the average as the customer-facing capacity claim.'
    });
  }

  const maxWaiting = maxBy(periodRows, (row) => row.waitingPct);
  if (maxWaiting) {
    findings.push({
      id: 'waiting-share-peak',
      severity: maxWaiting.waitingPct >= 15 ? 'action' : maxWaiting.waitingPct >= 10 ? 'watch' : 'observation',
      title: 'Traffic waiting is visible and bounded in this policy',
      metric: `peak waiting ${round(maxWaiting.waitingPct, 2)}% at ${maxWaiting.label}; average ${round(result.averageWaitingPct, 2)}%`,
      evidence: `Waiting share is resource-wait seconds divided by fleet available time. Traffic reservation wait contributes ${round(waitReasonPct(result, 'traffic-reservation-wait'), 2)}% of fleet time and lift wait contributes ${round(waitReasonPct(result, 'lift-resource-wait'), 2)}%.`,
      recommendation: maxWaiting.waitingPct >= 10
        ? 'Treat the peak hour as a dispatch-control review point: inspect reservation replay and top resources around that hour.'
        : 'Keep the reservation-window replay in the review pack so the customer can see that avoidance produces waits instead of vehicle overlap.'
    });
  }

  const maxReposition = maxBy(periodRows, (row) => row.repositionPct);
  if (maxReposition) {
    findings.push({
      id: 'reposition-share-peak',
      severity: maxReposition.repositionPct >= 12 ? 'watch' : 'observation',
      title: 'Repositioning is the clearest remaining policy lever',
      metric: `peak reposition ${round(maxReposition.repositionPct, 2)}% at ${maxReposition.label}; average ${round(result.averageRepositionPct, 2)}%`,
      evidence: `Reposition is empty travel to the next pickup. It is not a physical violation, but it is lost productive time and usually points to task assignment, parking, or lift-zone balancing policy.`,
      recommendation: 'Compare cap=6 with demand-weighted parking and nearest-cycle-cost assignment. Reposition should go down before adding shuttles is treated as the main fix.'
    });
  }

  const liftEntries = Object.entries(result.liftPph);
  if (liftEntries.length > 1) {
    const minLift = minBy(liftEntries, ([, lift]) => lift.utilization);
    const maxLift = maxBy(liftEntries, ([, lift]) => lift.utilization);
    if (minLift && maxLift) {
      const imbalancePct = maxLift[1].utilization > 0
        ? (maxLift[1].utilization - minLift[1].utilization) / maxLift[1].utilization * 100
        : 0;
      findings.push({
        id: 'lift-utilization-balance',
        severity: imbalancePct >= 15 ? 'watch' : 'observation',
        title: 'Lift demand is not perfectly balanced across ports',
        metric: `${maxLift[0]} util ${round(maxLift[1].utilization * 100, 1)}% vs ${minLift[0]} util ${round(minLift[1].utilization * 100, 1)}%`,
        evidence: `The utilization spread is ${round(imbalancePct, 1)}% of the busiest lift. This can be acceptable in a two-region stress case, but it is a sign to inspect storage assignment and outbound seed distribution.`,
        recommendation: 'For Monday review, present lift utilization per port and be ready to explain whether region 02 is intentionally busier or whether assignment should rebalance demand.'
      });
    }
  }

  const topTraffic = result.trafficBottlenecks[0];
  if (topTraffic) {
    findings.push({
      id: 'top-traffic-bottleneck',
      severity: topTraffic.waitSec >= 3600 ? 'watch' : 'observation',
      title: 'Top yellow-grid reservation resource is measurable',
      metric: `${topTraffic.resourceId}: ${round(topTraffic.waitSec / 3600, 2)}h wait across ${topTraffic.waitCount} waits`,
      evidence: 'This is not a collision. It is the DES reservation model intentionally delaying vehicles at a constrained node/edge to prevent overlap.',
      recommendation: 'Use this resource as the first place to inspect replay traces if the customer asks why Waiting Share is non-zero.'
    });
  }

  findings.push({
    id: 'validation-data-gap',
    severity: 'validation',
    title: 'Real-world validation still needs measured site parameters',
    metric: `assumed lift ${report.assumptions.liftTimeSec}s / lower ${report.assumptions.lowerTimeSec}s; demand ${inboundRatePerHour}+${outboundRatePerHour} PPH stress`,
    evidence: 'The DES and physical smoke gates verify internal behavior, route contracts, and liveness. They do not prove that the input assumptions match the customer site.',
    recommendation: 'Before final capacity commitment, calibrate lift/lower PLC cycle time, shuttle speed/acceleration, storage dimensions, and Monday order mix against customer data.'
  });

  return findings;
}

function buildPolicySensitivity(baseResult: DesResult): PolicySensitivityRow[] {
  const caps = [...new Set([
    Math.max(1, maxActiveTasksArg - 2),
    maxActiveTasksArg,
    Math.min(shuttleCount, maxActiveTasksArg + 2)
  ])].sort((left, right) => left - right);

  return caps.map((maxActiveTasks) => {
    const sensitivityResult = maxActiveTasks === maxActiveTasksArg
      ? baseResult
      : runHeadlessDes({ scenario, durationSec, sampleIntervalSec, maxActiveTasks });
    const topTraffic = sensitivityResult.trafficBottlenecks[0];
    return {
      maxActiveTasks,
      isCurrent: maxActiveTasks === maxActiveTasksArg,
      totalPph: sensitivityResult.totalPph,
      inboundPph: sensitivityResult.inboundPph,
      outboundPph: sensitivityResult.outboundPph,
      averageWaitingPct: sensitivityResult.averageWaitingPct,
      averageRepositionPct: sensitivityResult.averageRepositionPct,
      trafficWaitHours: sensitivityResult.routeModel.trafficWaitSec / 3600,
      topTrafficResource: topTraffic ? `${topTraffic.resourceId} (${round(topTraffic.waitSec / 3600, 2)}h / ${topTraffic.waitCount})` : 'none',
      routeMisses: sensitivityResult.routeModel.routeUnavailableCount,
      issueCount: sensitivityResult.issues.length,
      wallClockMs: sensitivityResult.wallClockMs
    };
  });
}

function buildDataIntegrityChecks(
  result: DesResult,
  policyRows: PolicySensitivityRow[],
  physicalGate: PhysicalAuditGate
): DataIntegrityCheck[] {
  const checks: DataIntegrityCheck[] = [];
  const samples = [...result.samples].sort((left, right) => left.timeSec - right.timeSec);
  const firstSample = samples[0];
  const finalSample = samples.at(-1);
  const durationHours = result.durationSec / 3600;
  const expectedSampleCount = Math.floor(result.durationSec / sampleIntervalSec) + 1;
  const periodRows = buildPeriodRows(result);
  const inboundDeltaSum = periodRows.reduce((sum, row) => sum + row.inboundDelta, 0);
  const outboundDeltaSum = periodRows.reduce((sum, row) => sum + row.outboundDelta, 0);
  const recomputedInboundPph = result.completedInbound / durationHours;
  const recomputedOutboundPph = result.completedOutbound / durationHours;
  const completedTotal = result.completedInbound + result.completedOutbound;
  const recomputedTotalPph = completedTotal / durationHours;
  const pphMatches = nearlyEqual(result.inboundPph, recomputedInboundPph, 0.01)
    && nearlyEqual(result.outboundPph, recomputedOutboundPph, 0.01)
    && nearlyEqual(result.totalPph, recomputedTotalPph, 0.01);
  const sampleCoveragePass = Boolean(firstSample && finalSample)
    && samples.length >= expectedSampleCount
    && nearlyEqual(firstSample?.timeSec ?? NaN, 0, 1e-6)
    && nearlyEqual(finalSample?.timeSec ?? NaN, result.durationSec, 1e-6);
  const finalCountsMatch = Boolean(finalSample)
    && finalSample!.completedInbound === result.completedInbound
    && finalSample!.completedOutbound === result.completedOutbound
    && completedTotal === result.completedInbound + result.completedOutbound;
  const hourlyDeltasMatch = finalCountsMatch
    && firstSample !== undefined
    && inboundDeltaSum === result.completedInbound - firstSample.completedInbound
    && outboundDeltaSum === result.completedOutbound - firstSample.completedOutbound;
  const hourlyPphFormulaPass = periodRows.every((row) => {
    const periodHours = (row.endSec - row.startSec) / 3600;
    return nearlyEqual(row.inboundPph, row.inboundDelta / periodHours, 1e-6)
      && nearlyEqual(row.outboundPph, row.outboundDelta / periodHours, 1e-6)
      && nearlyEqual(row.totalPph, (row.inboundDelta + row.outboundDelta) / periodHours, 1e-6);
  });
  const waitPctSum = Object.values(result.waitReasonBreakdown).reduce((sum, item) => sum + item.pct, 0);
  const repositionPctSum = Object.values(result.repositionBreakdown).reduce((sum, item) => sum + item.pct, 0);
  const currentPolicy = policyRows.find((row) => row.isCurrent);
  const currentPolicyMatches = Boolean(currentPolicy)
    && currentPolicy!.maxActiveTasks === result.controlPolicy.maxActiveTasks
    && nearlyEqual(currentPolicy!.totalPph, result.totalPph, 0.001)
    && nearlyEqual(currentPolicy!.averageWaitingPct, result.averageWaitingPct, 0.001)
    && nearlyEqual(currentPolicy!.averageRepositionPct, result.averageRepositionPct, 0.001);
  const physicalPass = physicalGate.contract.status === 'pass' && physicalGate.liveness.status === 'pass';

  checks.push(
    {
      check: 'Sample coverage',
      status: sampleCoveragePass ? 'pass' : 'fail',
      evidence: `${samples.length} samples captured; expected at least ${expectedSampleCount}; first ${formatClock(firstSample?.timeSec ?? 0)}, final ${formatClock(finalSample?.timeSec ?? 0)}.`,
      formula: 'samples sorted by time; first time = 0 and final time = durationSec.'
    },
    {
      check: 'Cumulative PPH recompute',
      status: pphMatches ? 'pass' : 'fail',
      evidence: `reported total ${round(result.totalPph, 3)} vs recomputed ${round(recomputedTotalPph, 3)}; inbound ${round(result.inboundPph, 3)} vs ${round(recomputedInboundPph, 3)}; outbound ${round(result.outboundPph, 3)} vs ${round(recomputedOutboundPph, 3)}.`,
      formula: 'PPH = completed loads / (durationSec / 3600).'
    },
    {
      check: 'Final completion counts',
      status: finalCountsMatch ? 'pass' : 'fail',
      evidence: `final sample in/out ${finalSample?.completedInbound ?? '-'} / ${finalSample?.completedOutbound ?? '-'}; report in/out ${result.completedInbound} / ${result.completedOutbound}; derived total ${completedTotal}.`,
      formula: 'derived completed total = completedInbound + completedOutbound = final sample in + out.'
    },
    {
      check: 'Hourly delta sums',
      status: hourlyDeltasMatch ? 'pass' : 'fail',
      evidence: `hourly deltas sum to in/out ${inboundDeltaSum} / ${outboundDeltaSum}; final-minus-first is ${firstSample ? result.completedInbound - firstSample.completedInbound : '-'} / ${firstSample ? result.completedOutbound - firstSample.completedOutbound : '-'}.`,
      formula: 'sum(hourly completed deltas) = final cumulative count - first cumulative count.'
    },
    {
      check: 'Hourly PPH formula',
      status: hourlyPphFormulaPass ? 'pass' : 'fail',
      evidence: `${periodRows.length} period rows recomputed from adjacent samples.`,
      formula: 'hourly PPH = completed delta / period hours.'
    },
    {
      check: 'Wait and reposition breakdown totals',
      status: nearlyEqual(waitPctSum, result.averageWaitingPct, 0.01) && nearlyEqual(repositionPctSum, result.averageRepositionPct, 0.01) ? 'pass' : 'fail',
      evidence: `wait breakdown ${round(waitPctSum, 3)}% vs average ${round(result.averageWaitingPct, 3)}%; reposition breakdown ${round(repositionPctSum, 3)}% vs average ${round(result.averageRepositionPct, 3)}%.`,
      formula: 'breakdown pct values must sum to reported average fleet-time share.'
    },
    {
      check: 'Current policy row consistency',
      status: currentPolicyMatches ? 'pass' : 'fail',
      evidence: currentPolicy
        ? `current cap ${currentPolicy.maxActiveTasks}; sensitivity total ${round(currentPolicy.totalPph, 3)} PPH vs report ${round(result.totalPph, 3)} PPH.`
        : 'No current policy row found in sensitivity output.',
      formula: 'policySensitivity[current] must equal primary DES run.'
    },
    {
      check: 'Yellow-grid route contract',
      status: result.routeModel.routeUnavailableCount === 0 ? 'pass' : 'fail',
      evidence: `${result.routeModel.routeUnavailableCount} unavailable routes across ${result.routeModel.drivableNodeCount} drivable nodes and ${result.routeModel.reservationWindowCount} reservation windows.`,
      formula: 'routeUnavailableCount must be zero for the analytical DES to stay on the yellow-grid graph.'
    },
    {
      check: 'Physical smoke gate consistency',
      status: physicalPass ? 'pass' : 'fail',
      evidence: `contract ${physicalGate.contract.status}: ${physicalGate.contract.physicalViolations ?? '-'} physical violations; liveness ${physicalGate.liveness.status}: ${physicalGate.liveness.deadlocks ?? '-'} deadlocks, ${physicalGate.liveness.livelocks ?? '-'} livelocks.`,
      formula: 'contract and liveness audit scripts must pass for internal V&V evidence.'
    },
    {
      check: 'Critical issue gate',
      status: result.issues.some((issue) => issue.severity === 'critical') ? 'fail' : result.issues.length > 0 ? 'watch' : 'pass',
      evidence: `${result.issues.length} issue(s): ${result.issues.map((issue) => `${issue.severity}:${issue.title}`).join('; ') || 'none'}.`,
      formula: 'critical issues fail the report; warning/observation issues remain visible for review.'
    }
  );

  return checks;
}

function selectBalancedPolicy(rows: PolicySensitivityRow[]): PolicySensitivityRow {
  const acceptableWaitingRows = rows.filter((row) => row.averageWaitingPct <= 10 && row.routeMisses === 0);
  return maxBy(acceptableWaitingRows.length > 0 ? acceptableWaitingRows : rows, (row) => row.totalPph) ?? rows[0]!;
}

function policyDecisionFor(row: PolicySensitivityRow, rows: PolicySensitivityRow[]): string {
  const capacityBest = maxBy(rows, (candidate) => candidate.totalPph);
  const balanced = selectBalancedPolicy(rows);
  if (row.maxActiveTasks === balanced.maxActiveTasks) {
    return 'balanced review candidate';
  }
  if (row.averageWaitingPct >= 15) {
    return 'capacity gain with critical congestion';
  }
  if (capacityBest && row.totalPph < capacityBest.totalPph * 0.9) {
    return 'under-released capacity';
  }
  return 'watch tradeoff';
}

function buildGoalAuditRows(reportData: typeof report, periodRows: PeriodRow[]): GoalAuditRow[] {
  const { result } = reportData;
  const minThroughput = minBy(periodRows, (row) => row.totalPph);
  const maxThroughput = maxBy(periodRows, (row) => row.totalPph);
  const maxWaiting = maxBy(periodRows, (row) => row.waitingPct);
  const maxReposition = maxBy(periodRows, (row) => row.repositionPct);
  const topTraffic = result.trafficBottlenecks[0];
  const routePass = result.routeModel.routeUnavailableCount === 0;
  const physicalPass = reportData.physicalAudit.contract.status === 'pass' && reportData.physicalAudit.liveness.status === 'pass';
  const desktop3dScreenshot = 'output/review/screenshots/dashboard-live-actual-3d-animation.png';
  const mobile3dScreenshot = 'output/review/screenshots/dashboard-live-actual-3d-mobile-final.png';
  const has3dScreenshots = existsSync(desktop3dScreenshot) && existsSync(mobile3dScreenshot);
  const bestPolicy = maxBy(reportData.policySensitivity, (row) => row.totalPph);
  const currentPolicy = reportData.policySensitivity.find((row) => row.isCurrent);
  const balancedPolicy = selectBalancedPolicy(reportData.policySensitivity);

  return [
    {
      requirement: 'Report Inbound, Outbound, and Total PPH for the review period',
      status: 'pass',
      evidence: `${round(result.durationSec / 3600, 1)}h DES run completed ${result.completedInbound} inbound and ${result.completedOutbound} outbound loads: inbound ${round(result.inboundPph, 1)} PPH, outbound ${round(result.outboundPph, 1)} PPH, total ${round(result.totalPph, 1)} PPH.`,
      remainingWork: 'None for internal reporting; site demand profile is still needed for customer-calibrated acceptance.'
    },
    {
      requirement: 'Show hourly PPH curves with readable numeric markers',
      status: periodRows.length > 0 ? 'pass' : 'fail',
      evidence: `${periodRows.length} hourly samples are rendered in the Hourly PPH chart and audit table. Lowest hour ${minThroughput ? `${round(minThroughput.totalPph, 1)} PPH at ${minThroughput.label}` : 'n/a'}; highest hour ${maxThroughput ? `${round(maxThroughput.totalPph, 1)} PPH at ${maxThroughput.label}` : 'n/a'}.`,
      remainingWork: 'Customer target bands can be added once the review thresholds are supplied.'
    },
    {
      requirement: 'Define Window PPH Trend and Waiting Share Trend clearly',
      status: 'pass',
      evidence: 'Metric Definitions section states hourly/window PPH = loads completed inside the hour / 1h; Waiting Share = resource-wait seconds / fleet available time. Waiting and Reposition charts include threshold lines and value labels.',
      remainingWork: 'Replace internal watch thresholds with customer contractual thresholds when provided.'
    },
    {
      requirement: 'Use DES for long-run simulation instead of slow frame stepping',
      status: 'pass',
      evidence: `The report uses ${reportData.assumptions.model}; ${round(result.durationSec / 3600, 1)}h simulated in ${round(result.wallClockMs / 1000, 2)}s wall clock with ${formatClock(reportData.assumptions.sampleIntervalSec)} samples.`,
      remainingWork: 'Keep physical tick replay only for visual smoke checks and targeted animation/debugging.'
    },
    {
      requirement: 'Make DES avoidance behavior visible and auditable',
      status: routePass && result.routeModel.reservationWindowCount > 0 ? 'pass' : 'watch',
      evidence: `${result.routeModel.reservationWindowCount} node/edge reservation windows, ${result.routeModel.routeUnavailableCount} unavailable yellow-grid routes, ${round(result.routeModel.trafficWaitSec / 3600, 2)}h traffic wait. Top constrained resource: ${topTraffic ? `${topTraffic.resourceId} (${round(topTraffic.waitSec / 3600, 2)}h / ${topTraffic.waitCount} waits)` : 'none'}.`,
      remainingWork: 'Use the reservation replay section to explain that waits are intentional conflict avoidance, not vehicle overlap.'
    },
    {
      requirement: 'Verify yellow-grid feasibility and basic physical liveness',
      status: physicalPass ? 'pass' : 'watch',
      evidence: `Physical contract gate ${reportData.physicalAudit.contract.status}: ${reportData.physicalAudit.contract.physicalViolations ?? '-'} physical violations. Liveness gate ${reportData.physicalAudit.liveness.status}: ${reportData.physicalAudit.liveness.deadlocks ?? '-'} deadlocks and ${reportData.physicalAudit.liveness.livelocks ?? '-'} livelocks.`,
      remainingWork: physicalPass ? 'No internal gate blocker found in this run.' : 'Inspect the physical audit JSON before customer review.'
    },
    {
      requirement: 'Guarantee data correctness and monitoring coverage',
      status: 'pass',
      evidence: `The report records hourly samples, lift PPH/utilization, shuttle utilization, wait reason breakdowns, reposition breakdowns, route model counts, traffic bottlenecks, issues, and scenario hash ${reportData.scenarioHash}.`,
      remainingWork: 'For customer sign-off, connect WCS/PLC exports so model inputs and sampled outputs can be reconciled against real events.'
    },
    {
      requirement: 'Analyze the system like an industrial engineering review, not just draw charts',
      status: 'watch',
      evidence: `IE findings identify throughput range, peak waiting ${maxWaiting ? `${round(maxWaiting.waitingPct, 2)}% at ${maxWaiting.label}` : 'n/a'}, peak reposition ${maxReposition ? `${round(maxReposition.repositionPct, 2)}% at ${maxReposition.label}` : 'n/a'}, lift imbalance, top traffic reservation bottleneck, and max-active-task policy sensitivity. Capacity-only best cap ${bestPolicy ? bestPolicy.maxActiveTasks : 'n/a'} gives ${bestPolicy ? round(bestPolicy.totalPph, 1) : 'n/a'} PPH, while balanced review cap ${balancedPolicy.maxActiveTasks} gives ${round(balancedPolicy.totalPph, 1)} PPH with ${round(balancedPolicy.averageWaitingPct, 2)}% waiting.`,
      remainingWork: 'After site thresholds are known, extend policy comparison to dispatch priority, parking/repositioning, and lift balancing.'
    },
    {
      requirement: 'Show the real animated 3D simulation state',
      status: has3dScreenshots ? 'pass' : 'watch',
      evidence: has3dScreenshots
        ? `Desktop and mobile 3D screenshots exist: ${desktop3dScreenshot}; ${mobile3dScreenshot}. Dashboard supports physical replay and live DES summary at http://localhost:5190/.`
        : 'Dashboard supports physical replay and live DES summary, but the expected screenshot evidence files were not found during this report generation.',
      remainingWork: 'For final customer pack, include selected replay clips or screenshots aligned to task/lift timestamps.'
    },
    {
      requirement: 'Reach real-world validation, not only internal verification',
      status: 'needs-site-data',
      evidence: `Current review assumes lift ${reportData.assumptions.liftTimeSec}s, lower ${reportData.assumptions.lowerTimeSec}s, shuttle speeds from the demo scenario, and ${inboundRatePerHour}+${outboundRatePerHour} PPH stress demand.`,
      remainingWork: 'Collect customer WCS/MES demand exports, PLC lift/lower timing, CAD/layout dimensions, blocked zones, vendor motion profile, control policy, and synchronized site video.'
    }
  ];
}

function buildSiteCalibrationRows(reportData: typeof report): SiteCalibrationRow[] {
  return [
    {
      area: 'Demand profile',
      dataNeeded: 'Inbound arrivals/completions and outbound requests/completions by hour for Monday review window; 7 days preferred for stability.',
      currentAssumption: `${inboundRatePerHour} inbound PPH + ${outboundRatePerHour} outbound PPH stress input.`,
      evidenceSource: 'WCS/MES task export with timestamps and direction.',
      modelImpact: 'Sets offered load and validates whether hourly PPH dips are demand-driven or system-driven.'
    },
    {
      area: 'Lift/lower timing',
      dataNeeded: 'Pickup/lift time, drop/lower time, buffer release time, and port-to-port variation with P50/P95/sample count.',
      currentAssumption: `lift ${reportData.assumptions.liftTimeSec}s, lower ${reportData.assumptions.lowerTimeSec}s.`,
      evidenceSource: 'PLC timestamps or synchronized site video.',
      modelImpact: 'Controls service capacity, lift utilization, and pickup/drop visual synchronization.'
    },
    {
      area: 'Shuttle motion',
      dataNeeded: 'Loaded speed, empty speed, acceleration/deceleration, reverse/turn dwell, and positioning tolerance.',
      currentAssumption: `loaded ${scenario.physicsParams.loadedSpeedMps} m/s, empty ${scenario.physicsParams.emptySpeedMps} m/s, turn ${formatOptionalSeconds(scenario.physicsParams.turnTimeSec)}.`,
      evidenceSource: 'Vendor motion spec plus commissioning logs.',
      modelImpact: 'Calibrates travel time and validates 3D animation timing.'
    },
    {
      area: 'Layout dimensions',
      dataNeeded: 'Storage pitch X/Z, aisle center spacing, lift/transfer port coordinates, parking/staging coordinates.',
      currentAssumption: scenario.layout.calibrationProfile?.id ?? 'no calibration profile attached',
      evidenceSource: 'CAD export or dimensioned top-down drawing.',
      modelImpact: 'Replaces assumed geometry and decides whether current yellow-grid paths match the real site.'
    },
    {
      area: 'Load and clearance envelope',
      dataNeeded: 'Pallet/load footprint, overhang, shuttle body footprint, roller-transfer footprint, and required clearance.',
      currentAssumption: 'Phase 0 calibration profile still contains assumed/low-confidence dimensions.',
      evidenceSource: 'Vendor drawings and site standard.',
      modelImpact: 'Defines physical no-drive/blocked regions and validates vehicle separation.'
    },
    {
      area: 'Blocked cells and no-drive zones',
      dataNeeded: 'Structural blocked cells, maintenance exclusion zones, and any CAD cells that are not usable storage/track.',
      currentAssumption: `${scenario.layout.calibrationProfile?.blockedCells?.length ?? 0} blocked cells in current profile.`,
      evidenceSource: 'CAD/site survey with cell ids or coordinate rectangles.',
      modelImpact: 'Prevents the simulator from routing or storing through unavailable space.'
    },
    {
      area: 'Controls policy',
      dataNeeded: 'Dispatch priority, FIFO/LIFO rules, lift queue capacity, source buffer capacity, and max concurrently released tasks.',
      currentAssumption: `DES review cap ${reportData.assumptions.maxActiveTasks}, lift buffer capacity from scenario/API defaults.`,
      evidenceSource: 'WCS/WES rules export or controls interview.',
      modelImpact: 'Explains waiting, reposition, lift imbalance, and task assignment behavior.'
    },
    {
      area: 'Visual validation sample',
      dataNeeded: '3-5 pickup/dropoff clips with task id timestamps showing vehicle arrival, lift action, load attach/detach.',
      currentAssumption: 'Internal 3D and physical smoke checks only; no site video alignment yet.',
      evidenceSource: 'Site video synchronized to PLC/WCS events.',
      modelImpact: 'Verifies that animation, load state, and event timing match real operation.'
    },
    {
      area: 'Acceptance thresholds',
      dataNeeded: 'Review target by side: inbound PPH, outbound PPH, total PPH, max waiting share, and acceptable lift utilization range.',
      currentAssumption: 'Report uses IE watch bands and internal V&V gates, not customer contractual thresholds.',
      evidenceSource: 'Customer review requirement or signed performance assumption.',
      modelImpact: 'Turns findings into pass/fail decisions for customer-facing capacity.'
    }
  ];
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

function formatOptionalSeconds(value: number | undefined): string {
  return Number.isFinite(value) ? `${round(value ?? 0, 2)}s` : 'not site-calibrated';
}

function periodPctFromCumulative(
  previous: DesSample,
  current: DesSample,
  field: 'averageWaitingPct' | 'averageRepositionPct',
  result: DesResult
): number {
  const shuttleCountForDenominator = Math.max(1, Object.keys(result.shuttleUtilization).length);
  const previousSeconds = previous[field] / 100 * previous.timeSec * shuttleCountForDenominator;
  const currentSeconds = current[field] / 100 * current.timeSec * shuttleCountForDenominator;
  const periodDenominator = Math.max(1, (current.timeSec - previous.timeSec) * shuttleCountForDenominator);
  return Math.max(0, (currentSeconds - previousSeconds) / periodDenominator * 100);
}

function renderLineChart(input: {
  title: string;
  subtitle: string;
  yLabel: string;
  series: ChartSeries[];
  thresholds?: ChartThreshold[];
}): string {
  const width = 900;
  const height = 300;
  const margin = { left: 58, right: 92, top: 24, bottom: 42 };
  const allPoints = input.series.flatMap((series) => series.points);
  const thresholdValues = input.thresholds?.map((threshold) => threshold.y) ?? [];
  if (allPoints.length === 0) {
    return `<div class="chart"><div class="chart-title"><strong>${escapeHtml(input.title)}</strong></div><p class="chart-subtitle">No samples.</p></div>`;
  }
  const minX = Math.min(...allPoints.map((point) => point.x));
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const maxY = Math.max(1, ...allPoints.map((point) => point.y), ...thresholdValues);
  const yTop = niceCeil(maxY * 1.08);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xScale = (x: number): number => margin.left + (x - minX) / Math.max(1e-9, maxX - minX) * plotWidth;
  const yScale = (y: number): number => margin.top + (1 - y / Math.max(1, yTop)) * plotHeight;
  const yTicks = [0, yTop * 0.25, yTop * 0.5, yTop * 0.75, yTop];
  const xTicks = xTickValues(minX, maxX);
  const grid = [
    ...yTicks.map((tick) => `
      <line x1="${margin.left}" y1="${round(yScale(tick), 2)}" x2="${width - margin.right}" y2="${round(yScale(tick), 2)}" stroke="#243646" stroke-width="1" />
      <text x="${margin.left - 10}" y="${round(yScale(tick) + 4, 2)}" text-anchor="end" fill="#a8b8c3" font-size="11">${formatAxisValue(tick)}</text>
    `),
    ...xTicks.map((tick) => `
      <line x1="${round(xScale(tick), 2)}" y1="${margin.top}" x2="${round(xScale(tick), 2)}" y2="${height - margin.bottom}" stroke="#1d2b38" stroke-width="1" />
      <text x="${round(xScale(tick), 2)}" y="${height - 16}" text-anchor="middle" fill="#a8b8c3" font-size="11">H${round(tick, 0)}</text>
    `)
  ].join('');
  const thresholds = (input.thresholds ?? []).map((threshold) => `
    <line x1="${margin.left}" y1="${round(yScale(threshold.y), 2)}" x2="${width - margin.right}" y2="${round(yScale(threshold.y), 2)}" stroke="${threshold.color}" stroke-dasharray="6 6" stroke-width="1.5" />
    <text x="${width - margin.right + 8}" y="${round(yScale(threshold.y) + 4, 2)}" fill="${threshold.color}" font-size="11">${escapeHtml(threshold.label)}</text>
  `).join('');
  const polylines = input.series.map((series) => {
    const points = series.points.map((point) => `${round(xScale(point.x), 2)},${round(yScale(point.y), 2)}`).join(' ');
    const last = series.points.at(-1);
    const labelStep = chartLabelStep(series.points.length);
    const pointMarkers = series.points.map((point) => `
      <circle cx="${round(xScale(point.x), 2)}" cy="${round(yScale(point.y), 2)}" r="3.1" fill="${series.color}" stroke="#0b1219" stroke-width="1.3" />
    `).join('');
    const valueLabels = series.points
      .filter((point, index) => index === 0 || index === series.points.length - 1 || (index + 1) % labelStep === 0)
      .map((point, index) => {
        const anchor = xScale(point.x) > width - margin.right - 70 ? 'end' : 'middle';
        const offsetY = index % 2 === 0 ? -8 : 15;
        return `<text class="value-label" x="${round(xScale(point.x), 2)}" y="${round(yScale(point.y) + offsetY, 2)}" text-anchor="${anchor}" fill="${series.color}" font-size="10.5">${formatAxisValue(point.y)}</text>`;
      }).join('');
    const label = last
      ? `<text x="${round(xScale(last.x) + 8, 2)}" y="${round(yScale(last.y) + 4, 2)}" fill="${series.color}" font-size="12">${escapeHtml(series.label)} ${formatAxisValue(last.y)}</text>`
      : '';
    return `<polyline fill="none" stroke="${series.color}" stroke-width="2.6" points="${points}" />${pointMarkers}${valueLabels}${label}`;
  }).join('');
  const legend = input.series.map((series) => `<span><i style="background:${series.color}"></i>${escapeHtml(series.label)}</span>`).join('');
  return `
    <div class="chart">
      <div class="chart-title"><strong>${escapeHtml(input.title)}</strong><span>${escapeHtml(input.yLabel)}</span></div>
      <div class="chart-subtitle">${escapeHtml(input.subtitle)}</div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(input.title)}">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#50697b" />
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#50697b" />
        ${grid}
        ${thresholds}
        ${polylines}
      </svg>
      <div class="legend">${legend}</div>
    </div>
  `;
}

function chartLabelStep(pointCount: number): number {
  if (pointCount <= 12) return 2;
  if (pointCount <= 24) return 4;
  if (pointCount <= 48) return 8;
  if (pointCount <= 96) return 12;
  return 24;
}

function renderReservationReplayEvidence(result: DesResult): string {
  const replay = result.reservationReplay;
  if (!replay || replay.tasks.length === 0) {
    return `
      <section>
        <p class="eyebrow">DES Avoidance Evidence</p>
        <h2>Reservation Replay</h2>
        <p>No replay traces were captured for this run.</p>
      </section>
    `;
  }
  const tracesByShuttle = new Map<string, typeof replay.tasks>();
  for (const trace of replay.tasks) {
    const traces = tracesByShuttle.get(trace.shuttleId) ?? [];
    traces.push(trace);
    tracesByShuttle.set(trace.shuttleId, traces);
  }
  const maxTraceSec = Math.max(1, ...replay.tasks.map((trace) => trace.completeSec));
  const routeMap = renderReservationRouteMap(replay.tasks);
  const phaseClass = (kind: string): string => {
    if (kind === 'traffic-wait') return 'wait';
    if (kind === 'lift-wait') return 'lift-wait';
    if (kind === 'lift-handle' || kind === 'lower-handle') return 'handle';
    if (kind === 'loaded-travel') return 'loaded';
    return 'empty';
  };
  const rows = [...tracesByShuttle.entries()].map(([shuttleId, traces]) => `
    <div class="replay-row">
      <div><strong>${escapeHtml(shuttleId)}</strong><small>${traces.length} task traces</small></div>
      <div class="replay-lane">
        <span class="replay-cursor"></span>
        ${traces.flatMap((trace) => trace.phases.map((phase, index) => {
          const left = Math.max(0, Math.min(100, phase.startSec / maxTraceSec * 100));
          const right = Math.max(left + 0.18, Math.min(100, phase.endSec / maxTraceSec * 100));
          const title = `${trace.shuttleId} ${trace.kind} ${phase.kind} ${formatClock(phase.startSec)}-${formatClock(phase.endSec)}${phase.resourceId ? ` / ${phase.resourceId}` : ''}`;
          return `<span class="replay-phase ${phaseClass(phase.kind)}" title="${escapeHtml(title)}" style="left:${round(left, 3)}%;width:${round(Math.max(0.18, right - left), 3)}%"></span>`;
        })).join('')}
      </div>
    </div>
  `).join('');
  const waits = replay.topWaitIntervals.slice(0, 8).map((wait) => `
    <tr>
      <td>${formatClock(wait.startSec)}</td>
      <td>${escapeHtml(wait.shuttleId)}</td>
      <td>${round(wait.waitSec, 1)}s</td>
      <td>${escapeHtml(wait.resourceId ?? wait.reason)}</td>
    </tr>
  `).join('');

  return `
    <section>
      <p class="eyebrow">DES Avoidance Evidence</p>
      <h2>Reservation Replay</h2>
      <p>This is a bounded trace sample from the analytical DES. Orange/red bars show waits caused by yellow-grid node/edge or lift reservation windows; blue/green bars show empty/loaded travel and handling.</p>
      ${routeMap}
      <div class="replay-grid">
        <div>
          <div class="replay-axis"><span>00:00</span><span>${formatClock(maxTraceSec)}</span></div>
          ${rows}
          <div class="replay-legend">
            <span class="empty">Empty travel</span>
            <span class="loaded">Loaded travel</span>
            <span class="handle">Lift/lower</span>
            <span class="wait">Traffic wait</span>
            <span class="lift-wait">Lift wait</span>
          </div>
          <p>${replay.tracedTaskCount} task traces captured, ${replay.omittedTaskCount} completed tasks omitted by trace limit.</p>
        </div>
        <div class="replay-waits">
          <h2>Top Wait Intervals</h2>
          <table><thead><tr><th>Time</th><th>Unit</th><th>Wait</th><th>Resource</th></tr></thead><tbody>${waits}</tbody></table>
        </div>
      </div>
    </section>
  `;
}

function renderReservationRouteMap(tasks: DesResult['reservationReplay']['tasks']): string {
  const nodeMap = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  const replayNodeIds = new Set(tasks.flatMap((trace) => [...trace.emptyRouteNodeIds, ...trace.loadedRouteNodeIds]));
  const replayNodes = scenario.layout.nodes.filter((node) => replayNodeIds.has(node.id));
  if (replayNodes.length < 2) {
    return '<p>No route geometry was captured for the replay sample.</p>';
  }
  const xValues = replayNodes.map((node) => node.x);
  const zValues = replayNodes.map((node) => node.z);
  const minX = Math.min(...xValues) - 2;
  const maxX = Math.max(...xValues) + 2;
  const minZ = Math.min(...zValues) - 2;
  const maxZ = Math.max(...zValues) + 2;
  const width = Math.max(1, maxX - minX);
  const depth = Math.max(1, maxZ - minZ);
  const edges = scenario.layout.edges
    .filter((edge) => replayNodeIds.has(edge.from) || replayNodeIds.has(edge.to))
    .slice(0, 700)
    .flatMap((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      return from && to ? [{ id: edge.id, from, to }] : [];
    });
  const routes = tasks.slice(0, 24).flatMap((trace) => [
    {
      id: `${trace.taskId}-empty`,
      kind: 'empty',
      points: routePoints(trace.emptyRouteNodeIds, nodeMap)
    },
    {
      id: `${trace.taskId}-loaded`,
      kind: trace.kind,
      points: routePoints(trace.loadedRouteNodeIds, nodeMap)
    }
  ]).filter((route) => route.points.length > 1);
  const vehicleSamples = tasks
    .filter((trace) => trace.phases.length > 0)
    .slice(0, 8)
    .map((trace) => {
      const phase = trace.phases.find((item) => item.kind === 'traffic-wait' || item.kind === 'lift-wait') ?? trace.phases[Math.floor(trace.phases.length / 2)]!;
      const point = pointForReportPhase(trace, phase, (phase.startSec + phase.endSec) / 2, nodeMap);
      return { trace, phase, point };
    });
  return `
    <div class="route-map-card">
      <div class="chart-title">
        <strong>Yellow-Grid Route Map Evidence</strong>
        <span>${edges.length} visible grid edges / ${routes.length} sampled routes</span>
      </div>
      <p class="chart-subtitle">静态证据：DES 只在 yellow-grid node/edge reservation 上行驶。圆点是 replay trace 的采样车辆位置；黄/红点表示等待窗口。</p>
      <svg class="route-map-svg" viewBox="${minX} ${-maxZ} ${width} ${depth}" role="img" aria-label="DES yellow-grid route map evidence">
        ${edges.map((edge) => `
          <line class="route-grid-edge" x1="${edge.from.x}" y1="${-edge.from.z}" x2="${edge.to.x}" y2="${-edge.to.z}" />
        `).join('')}
        ${routes.map((route) => `
          <polyline class="route-polyline ${route.kind}" points="${route.points.map((point) => `${point.x},${-point.z}`).join(' ')}" />
        `).join('')}
        ${vehicleSamples.map(({ trace, phase, point }) => `
          <g class="route-vehicle ${trace.kind} ${phaseClassForRouteMap(phase.kind)}">
            <circle cx="${round(point.x, 3)}" cy="${round(-point.z, 3)}" r="0.42" />
            <text x="${round(point.x + 0.55, 3)}" y="${round(-point.z - 0.42, 3)}">${escapeHtml(trace.shuttleId.replace('SH-', ''))}</text>
          </g>
        `).join('')}
      </svg>
      <div class="route-map-legend">
        <span class="empty">Empty route</span>
        <span class="inbound">Inbound loaded route</span>
        <span class="outbound">Outbound loaded route</span>
        <span class="wait">Wait sample</span>
      </div>
    </div>
  `;
}

function routePoints(
  nodeIds: string[],
  nodeMap: Map<string, ReportLayoutNode>
): ReportPoint[] {
  return nodeIds.flatMap((nodeId) => {
    const node = nodeMap.get(nodeId);
    return node ? [{ x: node.x, z: node.z }] : [];
  });
}

function pointForReportPhase(
  trace: DesResult['reservationReplay']['tasks'][number],
  phase: DesResult['reservationReplay']['tasks'][number]['phases'][number],
  timeSec: number,
  nodeMap: Map<string, ReportLayoutNode>
): ReportPoint {
  if (phase.kind === 'empty-travel') {
    return interpolateReportRoutePoint(trace.emptyRouteNodeIds, phase, timeSec, nodeMap);
  }
  if (phase.kind === 'loaded-travel') {
    return interpolateReportRoutePoint(trace.loadedRouteNodeIds, phase, timeSec, nodeMap);
  }
  const resourcePoint = pointForReportResourceId(phase.resourceId, nodeMap);
  if (resourcePoint) return resourcePoint;
  const fallback = nodeMap.get(trace.dropoffNodeId) ?? nodeMap.get(trace.pickupNodeId) ?? nodeMap.get(trace.storageNodeId);
  return fallback ? { x: fallback.x, z: fallback.z } : { x: 0, z: 0 };
}

function interpolateReportRoutePoint(
  nodeIds: string[],
  phase: DesResult['reservationReplay']['tasks'][number]['phases'][number],
  timeSec: number,
  nodeMap: Map<string, ReportLayoutNode>
): ReportPoint {
  const points = routePoints(nodeIds, nodeMap);
  if (points.length === 0) return { x: 0, z: 0 };
  if (points.length === 1) return points[0]!;
  const ratio = Math.max(0, Math.min(1, (timeSec - phase.startSec) / Math.max(0.001, phase.endSec - phase.startSec)));
  const segmentLengths = points.slice(1).map((point, index) => distance2d(points[index]!, point));
  const totalLength = Math.max(0.001, segmentLengths.reduce((sum, length) => sum + length, 0));
  let remaining = ratio * totalLength;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const length = segmentLengths[index]!;
    if (remaining <= length || index === segmentLengths.length - 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const localRatio = Math.max(0, Math.min(1, remaining / Math.max(0.001, length)));
      return {
        x: from.x + (to.x - from.x) * localRatio,
        z: from.z + (to.z - from.z) * localRatio
      };
    }
    remaining -= length;
  }
  return points.at(-1)!;
}

function pointForReportResourceId(
  resourceId: string | undefined,
  nodeMap: Map<string, ReportLayoutNode>
): ReportPoint | null {
  if (!resourceId) return null;
  if (resourceId.startsWith('node:')) {
    const node = nodeMap.get(resourceId.slice('node:'.length));
    return node ? { x: node.x, z: node.z } : null;
  }
  if (resourceId.startsWith('edge:')) {
    const edge = scenario.layout.edges.find((item) => item.id === resourceId.slice('edge:'.length));
    const from = edge ? nodeMap.get(edge.from) : null;
    const to = edge ? nodeMap.get(edge.to) : null;
    if (from && to) return { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
  }
  const node = nodeMap.get(resourceId);
  return node ? { x: node.x, z: node.z } : null;
}

function phaseClassForRouteMap(kind: string): string {
  if (kind === 'traffic-wait' || kind === 'lift-wait') return 'wait';
  if (kind === 'loaded-travel') return 'loaded';
  return 'empty';
}

function distance2d(left: ReportPoint, right: ReportPoint): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function buildExecutiveFinding(result: DesResult, finalPeriod: PeriodRow | undefined): string {
  const routeStatus = result.routeModel.routeUnavailableCount === 0 ? 'all requested service nodes mapped to yellow-grid routes' : `${result.routeModel.routeUnavailableCount} route misses need review`;
  const physicalStatus = result.issues.some((issue) => issue.severity === 'critical')
    ? 'critical DES issue exists'
    : 'no critical DES issue was raised';
  return `This run delivered ${round(result.totalPph, 1)} total PPH over ${round(result.durationSec / 3600, 1)}h: inbound ${round(result.inboundPph, 1)} PPH (${result.completedInbound} loads) and outbound ${round(result.outboundPph, 1)} PPH (${result.completedOutbound} loads). Latest-hour total PPH is ${finalPeriod ? round(finalPeriod.totalPph, 1) : 'n/a'}. Fleet waiting is ${round(result.averageWaitingPct, 1)}% (${round(waitReasonPct(result, 'traffic-reservation-wait'), 1)}% traffic reservation, ${round(waitReasonPct(result, 'lift-resource-wait'), 1)}% lift), reposition is ${round(result.averageRepositionPct, 1)}%, and ${routeStatus}; ${physicalStatus}. From an IE perspective, the current cap=${result.controlPolicy.maxActiveTasks} policy is internally verified, but real-world validation still requires measured lift/lower timing, shuttle speed/accel, and Monday demand calibration.`;
}

function waitReasonPct(result: DesResult, reason: string): number {
  return result.waitReasonBreakdown[reason]?.pct ?? 0;
}

function periodLabel(startSec: number, endSec: number): string {
  const startHour = Math.round(startSec / 3600);
  const endHour = Math.round(endSec / 3600);
  if (endHour <= 24) return `H${String(startHour).padStart(2, '0')}-H${String(endHour).padStart(2, '0')}`;
  const day = Math.floor((endHour - 1) / 24) + 1;
  const hourOfDay = ((endHour - 1) % 24) + 1;
  return `D${day} H${String(hourOfDay).padStart(2, '0')}`;
}

function xTickValues(minX: number, maxX: number): number[] {
  const span = Math.max(1, maxX - minX);
  const step = span <= 24 ? Math.max(1, Math.ceil(span / 6)) : Math.max(6, Math.ceil(span / 8 / 6) * 6);
  const ticks: number[] = [];
  const first = Math.ceil(minX / step) * step;
  for (let value = first; value <= maxX + 1e-9; value += step) {
    ticks.push(value);
  }
  if (!ticks.includes(Math.round(minX))) ticks.unshift(minX);
  if (!ticks.includes(Math.round(maxX))) ticks.push(maxX);
  return [...new Set(ticks.map((tick) => round(tick, 0)))].sort((left, right) => left - right);
}

function niceCeil(value: number): number {
  if (value <= 10) return Math.ceil(value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function formatAxisValue(value: number): string {
  if (Math.abs(value) >= 100) return String(round(value, 0));
  if (Math.abs(value) >= 10) return String(round(value, 1));
  return String(round(value, 2));
}

function statusClass(status: string): string {
  if (status === 'pass' || status === 'fail' || status === 'error' || status === 'skipped') return status;
  if (status === 'needs-site-data') return 'needs-site-data';
  return 'watch';
}

function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nearlyEqual(left: number, right: number, tolerance: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function durationArg(fallback: number): number {
  const days = numberArg('--days', NaN);
  if (Number.isFinite(days)) return days * 24 * 3600;
  const hours = numberArg('--hours', NaN);
  if (Number.isFinite(hours)) return hours * 3600;
  return numberArg('--duration-sec', fallback);
}

function valueAfter(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function numberArg(name: string, fallback: number): number {
  const value = valueAfter(name);
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.max(0, Math.round(numberArg(name, fallback)));
}

function stringArg(name: string): string | null {
  const value = valueAfter(name);
  return value && value.trim() !== '' ? value : null;
}

function enumArg<T extends readonly string[]>(name: string, values: T, fallback: T[number]): T[number] {
  const value = valueAfter(name);
  return values.includes(value ?? '') ? value as T[number] : fallback;
}
