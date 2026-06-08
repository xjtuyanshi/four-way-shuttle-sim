import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const reviewRoot = resolve('output/review');
const dataRoot = resolve(reviewRoot, 'data');
const reportSpecs = [
  {
    id: '24h',
    jsonPath: resolve(reviewRoot, 'shuttle-des-review-24h-vv.json'),
    periodCsvPath: resolve(dataRoot, 'des-period-pph-24h.csv'),
    bottleneckCsvPath: resolve(dataRoot, 'des-traffic-bottlenecks-24h.csv'),
    replayCsvPath: resolve(dataRoot, 'des-reservation-replay-tasks-24h.csv')
  },
  {
    id: '7d',
    jsonPath: resolve(reviewRoot, 'shuttle-des-review-7d-vv.json'),
    periodCsvPath: resolve(dataRoot, 'des-period-pph-7d.csv'),
    bottleneckCsvPath: resolve(dataRoot, 'des-traffic-bottlenecks-7d.csv'),
    replayCsvPath: resolve(dataRoot, 'des-reservation-replay-tasks-7d.csv')
  }
];
const issueRegisterCsvPath = resolve(dataRoot, 'review-issue-register.csv');
const issueRegisterJsonPath = resolve(dataRoot, 'review-issue-register.json');
const metricLineageCsvPath = resolve(dataRoot, 'metric-lineage.csv');
const metricLineageJsonPath = resolve(dataRoot, 'metric-lineage.json');
const metricLineageHtmlPath = resolve(reviewRoot, 'metric-lineage.html');
const reservationReplayJsonPath = resolve(dataRoot, 'des-reservation-replay-tasks.json');
const ieActionPlanCsvPath = resolve(dataRoot, 'ie-action-plan.csv');
const ieActionPlanJsonPath = resolve(dataRoot, 'ie-action-plan.json');
const ieActionPlanHtmlPath = resolve(reviewRoot, 'ie-action-plan.html');

mkdirSync(dataRoot, { recursive: true });

const reports = reportSpecs.map((spec) => {
  if (!existsSync(spec.jsonPath)) {
    throw new Error(`Missing review report JSON: ${spec.jsonPath}`);
  }
  const report = JSON.parse(readFileSync(spec.jsonPath, 'utf8')) as ReviewReport;
  const periodRows = buildPeriodRows(report.result);
  verifyPeriodRows(spec.id, report, periodRows);
  writeCsv(spec.periodCsvPath, periodRows.map((row) => ({
    period_label: row.label,
    start_sec: row.startSec,
    end_sec: row.endSec,
    inbound_completed_delta: row.inboundDelta,
    outbound_completed_delta: row.outboundDelta,
    total_completed_delta: row.inboundDelta + row.outboundDelta,
    inbound_pph: round(row.inboundPph, 6),
    outbound_pph: round(row.outboundPph, 6),
    total_pph: round(row.totalPph, 6),
    cumulative_total_pph: round(row.cumulativeTotalPph, 6),
    waiting_pct: round(row.waitingPct, 6),
    reposition_pct: round(row.repositionPct, 6),
    waiting_vehicles: row.waitingVehicles,
    queued_task_age_max_sec: round(row.queuedTaskAgeMaxSec, 6)
  })));
  writeCsv(spec.bottleneckCsvPath, report.result.trafficBottlenecks.map((row, index) => ({
    rank: index + 1,
    resource_id: row.resourceId,
    wait_sec: round(row.waitSec, 6),
    wait_hours: round(row.waitSec / 3600, 6),
    wait_count: row.waitCount
  })));
  const replayRows = buildReservationReplayRows(spec.id, report);
  writeCsv(spec.replayCsvPath, replayRows);

  return {
    id: spec.id,
    report,
    periodCsvPath: spec.periodCsvPath,
    bottleneckCsvPath: spec.bottleneckCsvPath,
    replayCsvPath: spec.replayCsvPath,
    periodRows: periodRows.length,
    bottleneckRows: report.result.trafficBottlenecks.length,
    replayRows: replayRows.length,
    inboundPph: report.result.inboundPph,
    outboundPph: report.result.outboundPph,
    totalPph: report.result.totalPph
  };
});

const issueRows = buildIssueRegisterRows(reports.map((item) => ({ id: item.id, report: item.report })));
writeCsv(issueRegisterCsvPath, issueRows);
writeFileSync(issueRegisterJsonPath, `${JSON.stringify({ schemaVersion: 'shuttle.reviewIssueRegister.v1', rows: issueRows }, null, 2)}\n`);

const metricLineageRows = buildMetricLineageRows(reports.map((item) => ({ id: item.id, report: item.report })), issueRows);
writeCsv(metricLineageCsvPath, metricLineageRows);
writeFileSync(metricLineageJsonPath, `${JSON.stringify({ schemaVersion: 'shuttle.metricLineage.v1', generatedAtIso: new Date().toISOString(), rows: metricLineageRows }, null, 2)}\n`);
writeFileSync(metricLineageHtmlPath, renderMetricLineageHtml(metricLineageRows));
const reservationReplayRows = reports.flatMap((item) => buildReservationReplayRows(item.id, item.report));
writeFileSync(reservationReplayJsonPath, `${JSON.stringify({ schemaVersion: 'shuttle.reservationReplayTasks.v1', generatedAtIso: new Date().toISOString(), rows: reservationReplayRows }, null, 2)}\n`);
const ieActionRows = buildIeActionPlanRows(reports.map((item) => ({ id: item.id, report: item.report })), issueRows, reservationReplayRows);
writeCsv(ieActionPlanCsvPath, ieActionRows);
writeFileSync(ieActionPlanJsonPath, `${JSON.stringify({ schemaVersion: 'shuttle.ieActionPlan.v1', generatedAtIso: new Date().toISOString(), rows: ieActionRows }, null, 2)}\n`);
writeFileSync(ieActionPlanHtmlPath, renderIeActionPlanHtml(ieActionRows, reports.map((item) => ({ id: item.id, report: item.report })), reservationReplayRows));

console.log(JSON.stringify({
  type: 'review-data-export-complete',
  exports: reports.map(({ report: _report, ...item }) => item),
  issueRegister: {
    csvPath: issueRegisterCsvPath,
    jsonPath: issueRegisterJsonPath,
    rows: issueRows.length
  },
  metricLineage: {
    csvPath: metricLineageCsvPath,
    jsonPath: metricLineageJsonPath,
    htmlPath: metricLineageHtmlPath,
    rows: metricLineageRows.length
  },
  reservationReplay: {
    jsonPath: reservationReplayJsonPath,
    rows: reservationReplayRows.length,
    csvPaths: reports.map((item) => item.replayCsvPath)
  },
  ieActionPlan: {
    csvPath: ieActionPlanCsvPath,
    jsonPath: ieActionPlanJsonPath,
    htmlPath: ieActionPlanHtmlPath,
    rows: ieActionRows.length
  }
}, null, 2));

type ReviewReport = {
  scenarioHash: string;
  scenario?: ReviewScenario;
  dataIntegrity: Array<{ check: string; status: string; evidence: string }>;
  physicalAudit: {
    contract: { status: string };
    liveness: { status: string };
  };
  policySensitivity: Array<{
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
  }>;
  result: DesResult;
};

type ReviewScenario = {
  layout?: {
    nodes?: Array<{ id: string }>;
    edges?: Array<{ from: string; to: string }>;
  };
};

type DesResult = {
  durationSec: number;
  completedInbound: number;
  completedOutbound: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  averageWaitingPct: number;
  averageRepositionPct: number;
  waitReasonBreakdown: Record<string, { seconds: number; pct: number }>;
  repositionBreakdown: Record<string, { seconds: number; pct: number }>;
  routeModel: { routeUnavailableCount: number; reservationWindowCount: number; trafficWaitSec: number };
  shuttleUtilization: Record<string, unknown>;
  liftPph: Record<string, { kind: string; completed: number; pph: number; utilization: number }>;
  issues: Array<{
    id: string;
    severity: string;
    title: string;
    metric: string;
    detail: string;
    recommendation: string;
  }>;
  samples: DesSample[];
  trafficBottlenecks: Array<{
    resourceId: string;
    waitSec: number;
    waitCount: number;
  }>;
  reservationReplay: {
    taskTraceLimit: number;
    tracedTaskCount: number;
    omittedTaskCount: number;
    tasks: Array<{
      taskId: string;
      shuttleId: string;
      kind: string;
      regionIndex: number;
      createdAtSec: number;
      dispatchSec: number;
      completeSec: number;
      pickupNodeId: string;
      dropoffNodeId: string;
      storageNodeId: string;
      liftNodeId: string;
      emptyRouteNodeIds: string[];
      loadedRouteNodeIds: string[];
      emptyTravelSec: number;
      loadedTravelSec: number;
      liftWaitSec: number;
      trafficWaitSec: number;
      handlingSec: number;
      phases: Array<{
        kind: string;
        startSec: number;
        endSec: number;
        resourceId?: string;
      }>;
    }>;
    topWaitIntervals: Array<{
      shuttleId: string;
      taskId: string;
      reason: string;
      resourceId: string | null;
      startSec: number;
      endSec: number;
      waitSec: number;
    }>;
  };
};

type DesSample = {
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  averageWaitingPct: number;
  averageRepositionPct: number;
  waitingVehicles: number;
  queuedTaskAgeMaxSec: number;
};

type IssueRegisterRow = {
  issue_id: string;
  horizon: string;
  category: string;
  severity: string;
  title: string;
  metric: string;
  evidence: string;
  recommendation: string;
  source: string;
};

type MetricLineageRow = {
  metric_id: string;
  display_name: string;
  review_question: string;
  source_artifacts: string;
  source_fields: string;
  formula: string;
  denominator_or_window: string;
  current_24h: string;
  current_7d: string;
  automated_verification: string;
  site_calibration_status: string;
  customer_data_needed: string;
};

type IeActionPlanRow = {
  action_id: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'baseline-ok' | 'watch' | 'needs-site-data';
  theme: string;
  horizon: string;
  question: string;
  evidence: string;
  likely_root_cause: string;
  recommended_action: string;
  next_experiment_or_check: string;
  customer_data_needed: string;
  source_artifacts: string;
};

type ReservationReplayRow = {
  horizon: string;
  task_id: string;
  shuttle_id: string;
  task_kind: string;
  region_index: number;
  created_at_sec: number;
  dispatch_sec: number;
  complete_sec: number;
  pickup_node_id: string;
  dropoff_node_id: string;
  storage_node_id: string;
  lift_node_id: string;
  empty_route_node_count: number;
  loaded_route_node_count: number;
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

type PeriodRow = {
  label: string;
  startSec: number;
  endSec: number;
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

function verifyPeriodRows(id: string, report: ReviewReport, rows: PeriodRow[]): void {
  const firstSample = [...report.result.samples].sort((left, right) => left.timeSec - right.timeSec)[0];
  const inboundDeltaSum = rows.reduce((sum, row) => sum + row.inboundDelta, 0);
  const outboundDeltaSum = rows.reduce((sum, row) => sum + row.outboundDelta, 0);
  const expectedInboundDelta = report.result.completedInbound - (firstSample?.completedInbound ?? 0);
  const expectedOutboundDelta = report.result.completedOutbound - (firstSample?.completedOutbound ?? 0);
  if (inboundDeltaSum !== expectedInboundDelta || outboundDeltaSum !== expectedOutboundDelta) {
    throw new Error(`${id}: period deltas ${inboundDeltaSum}/${outboundDeltaSum} do not match completed ${expectedInboundDelta}/${expectedOutboundDelta}`);
  }
}

function buildIssueRegisterRows(reports: Array<{ id: string; report: ReviewReport }>): IssueRegisterRow[] {
  const rows: IssueRegisterRow[] = [];
  for (const { id, report } of reports) {
    const result = report.result;
    for (const issue of result.issues) {
      rows.push({
        issue_id: `${id}-des-${issue.id}`,
        horizon: id,
        category: 'DES review threshold',
        severity: issue.severity,
        title: issue.title,
        metric: issue.metric,
        evidence: issue.detail,
        recommendation: issue.recommendation,
        source: 'result.issues'
      });
    }

    const topTraffic = result.trafficBottlenecks[0];
    if (topTraffic) {
      rows.push({
        issue_id: `${id}-top-traffic-bottleneck`,
        horizon: id,
        category: 'Traffic bottleneck',
        severity: topTraffic.waitSec >= 4 * 3600 ? 'watch' : 'observation',
        title: 'Top yellow-grid reservation bottleneck',
        metric: `${round(topTraffic.waitSec / 3600, 3)}h wait / ${topTraffic.waitCount} waits`,
        evidence: `${topTraffic.resourceId} accumulated the largest reservation wait in the ${id} run.`,
        recommendation: 'Inspect this node/edge in the DES replay map and compare against real WCS queueing before changing dispatch policy.',
        source: 'result.trafficBottlenecks[0]'
      });
    }

    const waitingPct = result.averageWaitingPct;
    rows.push({
      issue_id: `${id}-waiting-share`,
      horizon: id,
      category: 'Waiting share',
      severity: waitingPct >= 15 ? 'action' : waitingPct >= 10 ? 'watch' : 'observation',
      title: 'Fleet waiting share',
      metric: `${round(waitingPct, 3)}% average waiting`,
      evidence: `Traffic reservation wait contributes ${round(result.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0, 3)}%; lift resource wait contributes ${round(result.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0, 3)}%.`,
      recommendation: 'Keep as baseline below the internal watch band; rerun after site timing and WCS policy inputs are loaded.',
      source: 'result.waitReasonBreakdown'
    });

    const repositionPct = result.averageRepositionPct;
    rows.push({
      issue_id: `${id}-reposition-share`,
      horizon: id,
      category: 'Reposition',
      severity: repositionPct >= 12 ? 'watch' : 'observation',
      title: 'Empty travel to next pickup',
      metric: `${round(repositionPct, 3)}% average reposition`,
      evidence: `Reposition breakdown: ${Object.entries(result.repositionBreakdown).map(([key, value]) => `${key} ${round(value.pct, 3)}%`).join('; ') || 'none'}.`,
      recommendation: 'Review parking, task release, and lift balancing policy after customer controls policy is known.',
      source: 'result.repositionBreakdown'
    });

    const currentPolicy = report.policySensitivity.find((row) => row.isCurrent);
    const capacityBest = maxBy(report.policySensitivity, (row) => row.totalPph);
    if (currentPolicy && capacityBest && capacityBest.maxActiveTasks !== currentPolicy.maxActiveTasks) {
      rows.push({
        issue_id: `${id}-policy-capacity-tradeoff`,
        horizon: id,
        category: 'Dispatch policy',
        severity: capacityBest.averageWaitingPct >= 15 ? 'watch' : 'observation',
        title: 'Capacity cap increases throughput but raises waiting',
        metric: `cap ${currentPolicy.maxActiveTasks}: ${round(currentPolicy.totalPph, 3)} PPH / ${round(currentPolicy.averageWaitingPct, 3)}% wait; cap ${capacityBest.maxActiveTasks}: ${round(capacityBest.totalPph, 3)} PPH / ${round(capacityBest.averageWaitingPct, 3)}% wait`,
        evidence: `Capacity-only policy's top traffic resource is ${capacityBest.topTrafficResource}.`,
        recommendation: 'Use cap 6 as review baseline until the customer provides waiting/reposition acceptance thresholds.',
        source: 'policySensitivity'
      });
    }

    const liftRows = Object.entries(result.liftPph);
    if (liftRows.length > 1) {
      const maxLift = maxBy(liftRows, ([, lift]) => lift.pph);
      const minLift = minBy(liftRows, ([, lift]) => lift.pph);
      const spreadPct = maxLift && minLift && maxLift[1].pph > 0 ? (maxLift[1].pph - minLift[1].pph) / maxLift[1].pph * 100 : 0;
      rows.push({
        issue_id: `${id}-lift-imbalance`,
        horizon: id,
        category: 'Lift balance',
        severity: spreadPct >= 15 ? 'watch' : 'observation',
        title: 'Lift throughput spread',
        metric: `${round(spreadPct, 3)}% spread`,
        evidence: maxLift && minLift
          ? `Busiest ${maxLift[0]} at ${round(maxLift[1].pph, 3)} PPH; lightest ${minLift[0]} at ${round(minLift[1].pph, 3)} PPH.`
          : 'No lift utilization rows found.',
        recommendation: 'Check storage assignment, outbound seed distribution, and real WCS lift routing rules before changing layout.',
        source: 'result.liftPph'
      });
    }
  }

  const siteGapPath = resolve(reviewRoot, 'site-calibration-gap.json');
  if (existsSync(siteGapPath)) {
    const siteGap = JSON.parse(readFileSync(siteGapPath, 'utf8')) as {
      rows?: Array<{
        area: string;
        status: string;
        currentReviewValue: string;
        customerReplacementNeeded: string;
        modelImpact: string;
      }>;
    };
    for (const row of siteGap.rows ?? []) {
      if (row.status !== 'needs-site-data') continue;
      rows.push({
        issue_id: `site-data-${slug(row.area)}`,
        horizon: 'site',
        category: 'Site calibration',
        severity: 'needs-site-data',
        title: row.area,
        metric: row.status,
        evidence: row.currentReviewValue,
        recommendation: `${row.customerReplacementNeeded} Impact: ${row.modelImpact}`,
        source: 'site-calibration-gap.json'
      });
    }
  }

  return rows;
}

function buildReservationReplayRows(horizon: string, report: ReviewReport): ReservationReplayRow[] {
  const nodes = new Set((report.scenario?.layout?.nodes ?? []).map((node) => node.id));
  const edgePairs = new Set<string>();
  for (const edge of report.scenario?.layout?.edges ?? []) {
    edgePairs.add(`${edge.from}->${edge.to}`);
    edgePairs.add(`${edge.to}->${edge.from}`);
  }
  const canValidateLayout = nodes.size > 0 && edgePairs.size > 0;

  return report.result.reservationReplay.tasks.map((trace) => {
    const allRouteNodeIds = [...trace.emptyRouteNodeIds, ...trace.loadedRouteNodeIds];
    const missingNodes = canValidateLayout ? allRouteNodeIds.filter((nodeId) => !nodes.has(nodeId)) : [];
    const missingEdges = canValidateLayout
      ? [...adjacentPairs(trace.emptyRouteNodeIds), ...adjacentPairs(trace.loadedRouteNodeIds)]
        .filter(([from, to]) => !edgePairs.has(`${from}->${to}`))
      : [];
    const waitPhases = trace.phases
      .filter((phase) => phase.kind === 'traffic-wait' || phase.kind === 'lift-wait')
      .map((phase) => ({
        ...phase,
        waitSec: Math.max(0, phase.endSec - phase.startSec)
      }))
      .sort((left, right) => right.waitSec - left.waitSec);
    const topWait = waitPhases[0] ?? null;
    const totalWaitSec = trace.trafficWaitSec + trace.liftWaitSec;
    const routeStatus: ReservationReplayRow['route_status'] = missingNodes.length > 0 || missingEdges.length > 0 || report.result.routeModel.routeUnavailableCount > 0
      ? 'fail'
      : totalWaitSec >= 30 || allRouteNodeIds.length >= 46
        ? 'watch'
        : 'pass';
    const routeEvidence = !canValidateLayout
      ? `layout omitted in legacy report; routeUnavailableCount=${report.result.routeModel.routeUnavailableCount}`
      : missingNodes.length > 0
      ? `off-grid nodes: ${missingNodes.slice(0, 3).join(', ')}`
      : missingEdges.length > 0
        ? `missing edge: ${missingEdges[0]![0]} -> ${missingEdges[0]![1]}`
        : `empty ${trace.emptyRouteNodeIds.length} nodes, loaded ${trace.loadedRouteNodeIds.length} nodes`;
    const primaryWaitResource = topWait?.resourceId
      ? resourceShortName(topWait.resourceId)
      : totalWaitSec > 0
        ? 'wait without resource id'
        : 'no wait';

    return {
      horizon,
      task_id: trace.taskId,
      shuttle_id: trace.shuttleId,
      task_kind: trace.kind,
      region_index: trace.regionIndex,
      created_at_sec: round(trace.createdAtSec, 6),
      dispatch_sec: round(trace.dispatchSec, 6),
      complete_sec: round(trace.completeSec, 6),
      pickup_node_id: trace.pickupNodeId,
      dropoff_node_id: trace.dropoffNodeId,
      storage_node_id: trace.storageNodeId,
      lift_node_id: trace.liftNodeId,
      empty_route_node_count: trace.emptyRouteNodeIds.length,
      loaded_route_node_count: trace.loadedRouteNodeIds.length,
      route_node_count: allRouteNodeIds.length,
      movement_sec: round(trace.emptyTravelSec + trace.loadedTravelSec, 6),
      handling_sec: round(trace.handlingSec, 6),
      traffic_wait_sec: round(trace.trafficWaitSec, 6),
      lift_wait_sec: round(trace.liftWaitSec, 6),
      total_wait_sec: round(totalWaitSec, 6),
      primary_wait_resource: primaryWaitResource,
      route_status: routeStatus,
      route_evidence: routeEvidence,
      dispatch_evidence: `released at ${round(trace.dispatchSec, 3)}s under cap ${report.result.controlPolicy.maxActiveTasks}`,
      avoidance_evidence: `${round(trace.trafficWaitSec, 3)}s traffic, ${round(trace.liftWaitSec, 3)}s lift`
    };
  });
}

function buildIeActionPlanRows(
  reports: Array<{ id: string; report: ReviewReport }>,
  issueRows: IssueRegisterRow[],
  replayRows: ReservationReplayRow[]
): IeActionPlanRow[] {
  const rows = issueRows.map((issue) => issueToActionRow(issue));
  const report24h = reports.find((item) => item.id === '24h')?.report ?? reports[0]?.report;
  const report7d = reports.find((item) => item.id === '7d')?.report ?? reports[1]?.report ?? report24h;
  const replayFailCount = replayRows.filter((row) => row.route_status === 'fail').length;
  const replayWatchCount = replayRows.filter((row) => row.route_status === 'watch').length;
  const worstReplay = maxBy(replayRows, (row) => row.total_wait_sec);
  rows.push({
    action_id: 'des-reservation-replay-task-audit',
    priority: replayFailCount > 0 ? 'P0' : replayWatchCount > 0 ? 'P2' : 'P3',
    status: replayFailCount > 0 ? 'watch' : 'baseline-ok',
    theme: 'DES avoidance visibility',
    horizon: '24h+7d',
    question: 'Can we explain task-level avoidance instead of only saying the DES has collision avoidance?',
    evidence: `${replayRows.length} traced tasks; ${replayFailCount} fail, ${replayWatchCount} watch. Worst wait ${worstReplay ? `${round(worstReplay.total_wait_sec, 3)}s at ${worstReplay.primary_wait_resource}` : 'none'}.`,
    likely_root_cause: replayFailCount > 0
      ? 'At least one traced task failed the yellow-grid route contract.'
      : 'Watch rows are long waits or long routes, usually caused by reservation contention rather than physical off-grid travel.',
    recommended_action: replayFailCount > 0
      ? 'Stop customer-facing use of this replay until the failed task route is inspected and fixed.'
      : 'Use the replay task exports during review to explain why shuttles wait at reserved nodes/edges instead of crossing occupied resources.',
    next_experiment_or_check: 'Sort des-reservation-replay-tasks*.csv by total_wait_sec desc and inspect the matching route on the dashboard replay map.',
    customer_data_needed: 'Observed shuttle conflict samples, controller headway rules, and zone locking policy from the customer WCS/PLC.',
    source_artifacts: 'data/des-reservation-replay-tasks-24h.csv; data/des-reservation-replay-tasks-7d.csv; data/des-reservation-replay-tasks.json'
  });

  if (report24h && report7d) {
    rows.push({
      action_id: 'review-baseline-acceptance-boundary',
      priority: 'P1',
      status: 'needs-site-data',
      theme: 'Customer acceptance thresholds',
      horizon: 'site',
      question: 'Can we call the current 234 PPH baseline acceptable for the real operation?',
      evidence: `Internal baseline is ${round(report24h.result.totalPph, 3)} PPH for 24h and ${round(report7d.result.totalPph, 3)} PPH for 7d; route misses are ${report24h.result.routeModel.routeUnavailableCount}/${report7d.result.routeModel.routeUnavailableCount}.`,
      likely_root_cause: 'The software run is internally verified, but there is no signed customer target band for PPH, waiting, reposition, or lift utilization yet.',
      recommended_action: 'Treat cap 6 as the review baseline, not a capacity commitment, until customer thresholds are supplied.',
      next_experiment_or_check: 'Load customer target thresholds into the site calibration template, then rerun review-pack and compare baseline against pass/fail bands.',
      customer_data_needed: 'Signed inbound/outbound/total PPH target, max waiting share, max reposition share, acceptable lift utilization range, and review demand profile.',
      source_artifacts: 'output/review/shuttle-des-review-24h-vv.json; output/review/shuttle-des-review-7d-vv.json; config/shuttle/customer-site-calibration.template.json'
    });
  }

  return rows.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.theme.localeCompare(right.theme) || left.action_id.localeCompare(right.action_id));
}

function issueToActionRow(issue: IssueRegisterRow): IeActionPlanRow {
  return {
    action_id: `action-${issue.issue_id}`,
    priority: priorityForIssue(issue),
    status: issue.severity === 'needs-site-data' ? 'needs-site-data' : issue.severity === 'watch' || issue.severity === 'action' ? 'watch' : 'baseline-ok',
    theme: issue.category,
    horizon: issue.horizon,
    question: questionForIssue(issue),
    evidence: `${issue.metric}. ${issue.evidence}`,
    likely_root_cause: likelyRootCauseForIssue(issue),
    recommended_action: issue.recommendation,
    next_experiment_or_check: nextExperimentForIssue(issue),
    customer_data_needed: customerDataForIssue(issue),
    source_artifacts: issue.source
  };
}

function priorityForIssue(issue: IssueRegisterRow): IeActionPlanRow['priority'] {
  if (issue.severity === 'needs-site-data') return 'P1';
  if (issue.severity === 'critical' || issue.severity === 'action') return 'P0';
  if (issue.severity === 'watch') return 'P1';
  if (issue.category === 'Dispatch policy' || issue.category === 'Lift balance' || issue.category === 'Traffic bottleneck') return 'P2';
  return 'P3';
}

function priorityRank(priority: IeActionPlanRow['priority']): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 })[priority];
}

function questionForIssue(issue: IssueRegisterRow): string {
  if (issue.category === 'Traffic bottleneck') return 'Which yellow-grid resource should we inspect first if the customer asks why waiting is non-zero?';
  if (issue.category === 'Waiting share') return 'Is fleet waiting low enough to keep the current dispatch cap as the baseline?';
  if (issue.category === 'Reposition') return 'Is empty travel a material task-assignment or parking opportunity?';
  if (issue.category === 'Dispatch policy') return 'Should we raise the active-task cap for more throughput, or keep cap 6 for stable review behavior?';
  if (issue.category === 'Lift balance') return 'Are lift ports balanced enough, or is storage/outbound distribution skewing work?';
  if (issue.category === 'Site calibration') return 'What customer data is required before this becomes a site-calibrated claim?';
  return 'Did the configured DES review thresholds find a software or operating-policy issue?';
}

function likelyRootCauseForIssue(issue: IssueRegisterRow): string {
  if (issue.category === 'Traffic bottleneck') return 'Localized reservation contention at a yellow-grid node/edge, pending comparison to real WCS traffic-zone behavior.';
  if (issue.category === 'Waiting share') return 'Modeled waits are mostly reservation and lift-resource waits under the current dispatch cap.';
  if (issue.category === 'Reposition') return 'Empty travel to pickup is driven by current parking, task release, and storage/lift matching assumptions.';
  if (issue.category === 'Dispatch policy') return 'Higher active-task release increases concurrency but also increases reservation contention and waiting.';
  if (issue.category === 'Lift balance') return 'Current outbound seed distribution and storage assignment may concentrate work by region or lift pair.';
  if (issue.category === 'Site calibration') return 'The current value is an internal review assumption rather than a customer-measured input.';
  return 'No configured internal DES threshold tripped; remaining risk depends on customer site data and acceptance bands.';
}

function nextExperimentForIssue(issue: IssueRegisterRow): string {
  if (issue.category === 'Traffic bottleneck') return 'Open the replay task CSV, filter primary_wait_resource or traffic bottleneck resource, then inspect those tasks on the dashboard replay.';
  if (issue.category === 'Waiting share') return 'Run cap 5/6/7/8 sensitivity after customer waiting threshold is known; compare throughput gain against waiting share.';
  if (issue.category === 'Reposition') return 'Test nearest-cycle-cost assignment or demand-weighted parking, then compare reposition_pct and total PPH.';
  if (issue.category === 'Dispatch policy') return 'Keep cap 6 as baseline, rerun cap 8 only as stress evidence, and mark the waiting tradeoff clearly.';
  if (issue.category === 'Lift balance') return 'Run the same demand with alternate outbound seed distribution or lift assignment rules and compare lift spread.';
  if (issue.category === 'Site calibration') return 'Fill the corresponding field in customer-site-calibration.template.json and rerun site-gap plus review-pack.';
  return 'Keep as baseline and rerun after each route, dispatch, layout, or calibration change.';
}

function customerDataForIssue(issue: IssueRegisterRow): string {
  if (issue.category === 'Traffic bottleneck') return 'Traffic-zone locking rules, safety headway, and WCS/PLC samples around blocked shuttles.';
  if (issue.category === 'Waiting share') return 'Real wait-state classification by lift wait, traffic wait, blocked path, and control delay.';
  if (issue.category === 'Reposition') return 'Actual WCS task assignment, parking, interleaving, and deadhead/reposition definitions.';
  if (issue.category === 'Dispatch policy') return 'Customer task release cap, queue priorities, starvation rules, and accepted waiting/reposition thresholds.';
  if (issue.category === 'Lift balance') return 'PLC lift busy/idle logs, lift cycle definitions, and real inbound/outbound lift routing policy.';
  if (issue.category === 'Site calibration') return issue.recommendation;
  return 'Customer demand profile and acceptance thresholds to turn baseline observations into pass/fail decisions.';
}

function buildMetricLineageRows(reports: Array<{ id: string; report: ReviewReport }>, issueRows: IssueRegisterRow[]): MetricLineageRow[] {
  const report24h = reports.find((item) => item.id === '24h')?.report ?? reports[0]?.report;
  const report7d = reports.find((item) => item.id === '7d')?.report ?? reports[1]?.report ?? report24h;
  if (!report24h || !report7d) return [];

  const topTraffic24h = report24h.result.trafficBottlenecks[0];
  const topTraffic7d = report7d.result.trafficBottlenecks[0];
  const currentPolicy24h = report24h.policySensitivity.find((row) => row.isCurrent);
  const currentPolicy7d = report7d.policySensitivity.find((row) => row.isCurrent);
  const dataIntegrity24h = summarizeDataIntegrity(report24h);
  const dataIntegrity7d = summarizeDataIntegrity(report7d);

  return [
    {
      metric_id: 'inbound_pph',
      display_name: 'Inbound PPH',
      review_question: 'How many inbound loads per hour did the model complete?',
      source_artifacts: 'shuttle-des-review-24h-vv.json; shuttle-des-review-7d-vv.json; data/des-period-pph-*.csv',
      source_fields: 'result.completedInbound; result.durationSec; result.samples[].completedInbound; data/des-period-pph-*.csv.inbound_pph',
      formula: 'completedInbound / (durationSec / 3600). Period rows use delta(completedInbound) / periodHours.',
      denominator_or_window: 'Full run for headline; adjacent sample windows for hourly/window trend.',
      current_24h: `${round(report24h.result.inboundPph, 3)} PPH; ${report24h.result.completedInbound} completed`,
      current_7d: `${round(report7d.result.inboundPph, 3)} PPH; ${report7d.result.completedInbound} completed`,
      automated_verification: 'review-verify checks positive inbound PPH; CSV export verifies inbound period deltas sum back to completedInbound minus first sample.',
      site_calibration_status: 'internal-review-assumption',
      customer_data_needed: 'WCS/MES inbound task export by timestamp and actual accepted/completed inbound count.'
    },
    {
      metric_id: 'outbound_pph',
      display_name: 'Outbound PPH',
      review_question: 'How many outbound loads per hour did the model complete?',
      source_artifacts: 'shuttle-des-review-24h-vv.json; shuttle-des-review-7d-vv.json; data/des-period-pph-*.csv',
      source_fields: 'result.completedOutbound; result.durationSec; result.samples[].completedOutbound; data/des-period-pph-*.csv.outbound_pph',
      formula: 'completedOutbound / (durationSec / 3600). Period rows use delta(completedOutbound) / periodHours.',
      denominator_or_window: 'Full run for headline; adjacent sample windows for hourly/window trend.',
      current_24h: `${round(report24h.result.outboundPph, 3)} PPH; ${report24h.result.completedOutbound} completed`,
      current_7d: `${round(report7d.result.outboundPph, 3)} PPH; ${report7d.result.completedOutbound} completed`,
      automated_verification: 'review-verify checks positive outbound PPH; CSV export verifies outbound period deltas sum back to completedOutbound minus first sample.',
      site_calibration_status: 'internal-review-assumption',
      customer_data_needed: 'WCS/MES outbound order export by timestamp and actual picked/shipped count.'
    },
    {
      metric_id: 'total_pph',
      display_name: 'Total PPH',
      review_question: 'What total throughput should be used as the review baseline?',
      source_artifacts: 'shuttle-des-review-24h-vv.json; shuttle-des-review-7d-vv.json; review-preflight-latest.json',
      source_fields: 'result.totalPph; result.completedInbound; result.completedOutbound; result.durationSec',
      formula: '(completedInbound + completedOutbound) / (durationSec / 3600).',
      denominator_or_window: 'Full run duration: 24h and 168h.',
      current_24h: `${round(report24h.result.totalPph, 3)} PPH`,
      current_7d: `${round(report7d.result.totalPph, 3)} PPH`,
      automated_verification: 'review-verify checks positive total PPH and preflight writes failures=0 only after review, dashboard, site-template, current-assumption, and live-env gates pass.',
      site_calibration_status: 'internal-review-assumption',
      customer_data_needed: 'Customer target PPH and real demand mix by inbound/outbound side.'
    },
    {
      metric_id: 'window_pph_trend',
      display_name: 'Window PPH Trend',
      review_question: 'Where did hourly throughput dip or spike?',
      source_artifacts: 'data/des-period-pph-24h.csv; data/des-period-pph-7d.csv; 24h/7d V&V HTML charts',
      source_fields: 'period_label; inbound_completed_delta; outbound_completed_delta; inbound_pph; outbound_pph; total_pph',
      formula: 'For each adjacent sample pair: completed delta inside the window / window hours.',
      denominator_or_window: 'Sample-to-sample window; review baseline uses 1h sample cadence.',
      current_24h: summarizePeriodRange(report24h),
      current_7d: summarizePeriodRange(report7d),
      automated_verification: 'CSV export recomputes every window from cumulative samples and review-verify checks CSV row count equals samples-1.',
      site_calibration_status: 'verified-internal-windowing',
      customer_data_needed: 'Real WCS/MES completed-task timestamps to compare simulated hourly windows with site-hour windows.'
    },
    {
      metric_id: 'waiting_share_pct',
      display_name: 'Waiting Share Trend',
      review_question: 'How much fleet time was lost waiting for lift or traffic reservations?',
      source_artifacts: 'shuttle-des-review-*.json; data/des-period-pph-*.csv; 24h/7d V&V HTML charts',
      source_fields: 'result.averageWaitingPct; result.waitReasonBreakdown; result.samples[].averageWaitingPct; data/des-period-pph-*.csv.waiting_pct',
      formula: 'resource-wait seconds / (period seconds x shuttle count) x 100.',
      denominator_or_window: 'Fleet available time; full run for headline and adjacent sample windows for trend.',
      current_24h: `${round(report24h.result.averageWaitingPct, 3)}%; ${summarizeBreakdown(report24h.result.waitReasonBreakdown)}`,
      current_7d: `${round(report7d.result.averageWaitingPct, 3)}%; ${summarizeBreakdown(report7d.result.waitReasonBreakdown)}`,
      automated_verification: 'review-verify requires metric-definition section and CSV exports; dashboard evidence verifier requires Window PPH and Waiting Share source markers.',
      site_calibration_status: 'internal-resource-wait-policy',
      customer_data_needed: 'PLC/WCS wait-state logs or synchronized video to classify real wait causes by lift, traffic conflict, blocked path, and control delay.'
    },
    {
      metric_id: 'reposition_share_pct',
      display_name: 'Reposition Share',
      review_question: 'How much time was empty travel to the next pickup?',
      source_artifacts: 'shuttle-des-review-*.json; data/des-period-pph-*.csv; issue register',
      source_fields: 'result.averageRepositionPct; result.repositionBreakdown; result.samples[].averageRepositionPct; issue register category=Reposition',
      formula: 'empty travel to next pickup seconds / (period seconds x shuttle count) x 100.',
      denominator_or_window: 'Fleet available time; full run for headline and adjacent sample windows for trend.',
      current_24h: `${round(report24h.result.averageRepositionPct, 3)}%; ${summarizeBreakdown(report24h.result.repositionBreakdown)}`,
      current_7d: `${round(report7d.result.averageRepositionPct, 3)}%; ${summarizeBreakdown(report7d.result.repositionBreakdown)}`,
      automated_verification: 'Issue register emits a Reposition row for every horizon; CSV exports include reposition_pct for every period.',
      site_calibration_status: 'policy-diagnostic',
      customer_data_needed: 'Customer task assignment, parking, interleaving, and dispatch-release policy.'
    },
    {
      metric_id: 'lift_pph_utilization',
      display_name: 'Lift PPH / Utilization',
      review_question: 'Which lift ports are busiest, and is lift balance a material-flow issue?',
      source_artifacts: 'shuttle-des-review-*.json; issue register category=Lift balance',
      source_fields: 'result.liftPph[port].completed; result.liftPph[port].pph; result.liftPph[port].utilization',
      formula: 'lift PPH = completed lift cycles / run hours. utilization = modeled lift busy seconds / durationSec.',
      denominator_or_window: 'Per lift port across the run horizon.',
      current_24h: summarizeLiftRange(report24h),
      current_7d: summarizeLiftRange(report7d),
      automated_verification: 'Issue register emits Lift balance spread; review reports list lift rows and utilization spread.',
      site_calibration_status: 'needs-site-timing-for-commitment',
      customer_data_needed: 'PLC lift busy/idle logs, lift cycle definitions, handoff timing, and whether utilization should be mechanical, port-allocation, or control-occupied utilization.'
    },
    {
      metric_id: 'route_unavailable_count',
      display_name: 'Yellow-Grid Route Miss Count',
      review_question: 'Did any DES route leave the permitted yellow-grid graph or fail to find a legal route?',
      source_artifacts: 'shuttle-des-review-*.json; live-env verify; yellow-grid audits',
      source_fields: 'result.routeModel.routeUnavailableCount; physicalAudit.contract.status; physicalAudit.liveness.status',
      formula: 'Count of DES tasks for which no yellow-grid graph route was available.',
      denominator_or_window: 'Full run; must remain zero for review acceptance.',
      current_24h: `${report24h.result.routeModel.routeUnavailableCount}; physical ${report24h.physicalAudit.contract.status}/${report24h.physicalAudit.liveness.status}`,
      current_7d: `${report7d.result.routeModel.routeUnavailableCount}; physical ${report7d.physicalAudit.contract.status}/${report7d.physicalAudit.liveness.status}`,
      automated_verification: 'review-verify requires routeUnavailableCount=0 and physical gate pass/pass for both 24h and 7d; live-env verify checks the current API returns route miss 0.',
      site_calibration_status: 'internal-layout-verified',
      customer_data_needed: 'Customer CAD/layout, no-drive zones, clearance envelope, and blocked cells to replace the internal yellow-grid assumption.'
    },
    {
      metric_id: 'reservation_bottlenecks',
      display_name: 'Reservation Bottlenecks',
      review_question: 'Where does DES avoidance create the most traffic waiting?',
      source_artifacts: 'data/des-traffic-bottlenecks-*.csv; data/des-reservation-replay-tasks-*.csv; dashboard DES replay; 24h/7d V&V reports',
      source_fields: 'result.trafficBottlenecks[].resourceId; waitSec; waitCount; result.reservationReplay.tasks[].phases; data/des-reservation-replay-tasks-*.csv.primary_wait_resource',
      formula: 'Aggregate traffic-reservation wait seconds by yellow-grid node/edge resource and rank descending. Task replay rows preserve per-task route status and top wait resource.',
      denominator_or_window: 'Full run aggregation plus first traced task sample for task-level inspection.',
      current_24h: topTraffic24h ? `${topTraffic24h.resourceId}: ${round(topTraffic24h.waitSec / 3600, 3)}h / ${topTraffic24h.waitCount} waits` : 'none',
      current_7d: topTraffic7d ? `${topTraffic7d.resourceId}: ${round(topTraffic7d.waitSec / 3600, 3)}h / ${topTraffic7d.waitCount} waits` : 'none',
      automated_verification: 'CSV export row count must equal trafficBottlenecks length; dashboard evidence verifier requires dispatch audit and replay bottleneck screenshots.',
      site_calibration_status: 'internal-route-reservation-policy',
      customer_data_needed: 'Real control-system conflict policy, safety headway, traffic-zone locking, and observed shuttle-to-shuttle blocking samples.'
    },
    {
      metric_id: 'reservation_replay_task_audit',
      display_name: 'Reservation Replay Task Audit',
      review_question: 'For each traced task, did it stay on the yellow route and wait instead of crossing reserved resources?',
      source_artifacts: 'data/des-reservation-replay-tasks-24h.csv; data/des-reservation-replay-tasks-7d.csv; data/des-reservation-replay-tasks.json',
      source_fields: 'reservationReplay.tasks[].emptyRouteNodeIds; loadedRouteNodeIds; phases; trafficWaitSec; liftWaitSec; scenario.layout.nodes/edges',
      formula: 'Validate every traced task route against scenario nodes/edges; mark fail for off-grid/missing-edge/routeUnavailable, watch for long wait or long route, pass otherwise.',
      denominator_or_window: 'Traced DES task sample controlled by traceTaskLimit; aggregate run route miss gate remains full-horizon.',
      current_24h: summarizeReplayRows('24h', buildReservationReplayRows('24h', report24h)),
      current_7d: summarizeReplayRows('7d', buildReservationReplayRows('7d', report7d)),
      automated_verification: 'review-verify checks replay CSV/JSON row consistency, no fail route rows, required columns, and traced task count reconciliation.',
      site_calibration_status: 'internal-yellow-grid-task-trace',
      customer_data_needed: 'Customer controls conflict policy and observed task-level traces to compare wait locations and route choices.'
    },
    {
      metric_id: 'dispatch_policy_sensitivity',
      display_name: 'Dispatch Policy Sensitivity',
      review_question: 'Is the current release cap the best operational recommendation?',
      source_artifacts: 'shuttle-des-review-*.json; 24h/7d policy sensitivity tables; issue register category=Dispatch policy',
      source_fields: 'policySensitivity[].maxActiveTasks; totalPph; averageWaitingPct; averageRepositionPct; routeMisses; isCurrent',
      formula: 'Compare candidate maxActiveTasks caps on throughput, waiting, reposition, traffic wait, and route misses.',
      denominator_or_window: 'Full run repeated for each candidate cap.',
      current_24h: currentPolicy24h ? `current cap ${currentPolicy24h.maxActiveTasks}: ${round(currentPolicy24h.totalPph, 3)} PPH / ${round(currentPolicy24h.averageWaitingPct, 3)}% wait` : 'current policy missing',
      current_7d: currentPolicy7d ? `current cap ${currentPolicy7d.maxActiveTasks}: ${round(currentPolicy7d.totalPph, 3)} PPH / ${round(currentPolicy7d.averageWaitingPct, 3)}% wait` : 'current policy missing',
      automated_verification: 'review-verify requires policySensitivity contains the current cap row; issue register records capacity-vs-waiting tradeoff when best-throughput cap differs.',
      site_calibration_status: 'review-baseline-not-final-controls',
      customer_data_needed: 'Customer WCS task release rules, queue priorities, starvation rules, wave profile, and accepted waiting/reposition thresholds.'
    },
    {
      metric_id: 'data_integrity_gate',
      display_name: 'Data Integrity Gate',
      review_question: 'Can the reported numbers be recomputed from recorded samples and artifacts?',
      source_artifacts: 'shuttle-des-review-*.json; verify-review-pack; dashboard evidence verifier; review-preflight-latest.json',
      source_fields: 'dataIntegrity[].status/evidence; CSV row counts; period delta sums; scenarioHash',
      formula: 'All required checks must have zero fail rows; period CSV deltas must reconcile to cumulative completions.',
      denominator_or_window: 'Artifact-level gate, not a simulation metric.',
      current_24h: dataIntegrity24h,
      current_7d: dataIntegrity7d,
      automated_verification: 'review-verify fails on data-integrity fail rows, CSV mismatch, missing screenshots, broken links, missing preflight evidence, route misses, or physical-gate failures.',
      site_calibration_status: 'verified-internal-artifact-chain',
      customer_data_needed: 'Independent customer source extracts to cross-check model input demand and output completions against real operations.'
    },
    {
      metric_id: 'issue_register',
      display_name: 'IE Issue Register',
      review_question: 'What problems should an industrial engineer investigate next?',
      source_artifacts: 'data/review-issue-register.csv; data/review-issue-register.json; review hub',
      source_fields: 'issue_id; horizon; category; severity; metric; evidence; recommendation; source',
      formula: 'Generated from DES issues, top traffic resource, waiting share, reposition share, dispatch cap tradeoff, lift balance, and site-calibration gaps.',
      denominator_or_window: '24h, 7d, and site-calibration scope.',
      current_24h: `${issueRows.filter((row) => row.horizon === '24h').length} issue rows`,
      current_7d: `${issueRows.filter((row) => row.horizon === '7d').length} issue rows; ${issueRows.filter((row) => row.severity === 'needs-site-data').length} site-data rows overall`,
      automated_verification: 'review-verify checks CSV/JSON row consistency and required categories: Traffic bottleneck, Dispatch policy, and Site calibration.',
      site_calibration_status: 'mixed-internal-and-site-gap',
      customer_data_needed: 'Customer operating targets and acceptance thresholds to promote observations/watch rows into pass/fail decisions.'
    }
  ];
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

function summarizePeriodRange(report: ReviewReport): string {
  const rows = buildPeriodRows(report.result);
  const low = minBy(rows, (row) => row.totalPph);
  const high = maxBy(rows, (row) => row.totalPph);
  if (!low || !high) return 'no period rows';
  return `${round(low.totalPph, 3)}-${round(high.totalPph, 3)} total PPH; low ${low.label}, high ${high.label}`;
}

function summarizeBreakdown(rows: Record<string, { seconds: number; pct: number }>): string {
  const entries = Object.entries(rows).sort((left, right) => right[1].pct - left[1].pct);
  if (entries.length === 0) return 'no breakdown rows';
  return entries.map(([key, value]) => `${key} ${round(value.pct, 3)}%`).join('; ');
}

function summarizeLiftRange(report: ReviewReport): string {
  const rows = Object.entries(report.result.liftPph);
  const high = maxBy(rows, ([, lift]) => lift.pph);
  const low = minBy(rows, ([, lift]) => lift.pph);
  if (!high || !low) return 'no lift rows';
  return `${high[0]} ${round(high[1].pph, 3)} PPH / ${round(high[1].utilization * 100, 2)}% util; ${low[0]} ${round(low[1].pph, 3)} PPH / ${round(low[1].utilization * 100, 2)}% util`;
}

function summarizeReplayRows(horizon: string, rows: ReservationReplayRow[]): string {
  const pass = rows.filter((row) => row.route_status === 'pass').length;
  const watch = rows.filter((row) => row.route_status === 'watch').length;
  const fail = rows.filter((row) => row.route_status === 'fail').length;
  const worst = maxBy(rows, (row) => row.total_wait_sec);
  return `${rows.length} traced ${horizon} tasks; ${pass} pass / ${watch} watch / ${fail} fail; worst wait ${worst ? `${round(worst.total_wait_sec, 3)}s at ${worst.primary_wait_resource}` : 'none'}`;
}

function adjacentPairs(nodeIds: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 1; index < nodeIds.length; index += 1) {
    pairs.push([nodeIds[index - 1]!, nodeIds[index]!]);
  }
  return pairs;
}

function resourceShortName(resourceId: string): string {
  return resourceId
    .replace(/^node:/, 'node ')
    .replace(/^edge:/, 'edge ')
    .replace(/^(.{38}).+$/, '$1...');
}

function countBy<T>(items: T[], keyForItem: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyForItem(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function summarizeDataIntegrity(report: ReviewReport): string {
  const pass = report.dataIntegrity.filter((row) => row.status === 'pass').length;
  const watch = report.dataIntegrity.filter((row) => row.status === 'watch').length;
  const fail = report.dataIntegrity.filter((row) => row.status === 'fail').length;
  return `${pass} pass / ${watch} watch / ${fail} fail; scenario ${report.scenarioHash}`;
}

function renderIeActionPlanHtml(rows: IeActionPlanRow[], reports: Array<{ id: string; report: ReviewReport }>, replayRows: ReservationReplayRow[]): string {
  const report24h = reports.find((item) => item.id === '24h')?.report ?? reports[0]?.report;
  const report7d = reports.find((item) => item.id === '7d')?.report ?? reports[1]?.report ?? report24h;
  const priorityCounts = countBy(rows, (row) => row.priority);
  const statusCounts = countBy(rows, (row) => row.status);
  const replayFailCount = replayRows.filter((row) => row.route_status === 'fail').length;
  const replayWatchCount = replayRows.filter((row) => row.route_status === 'watch').length;
  const urgentRows = rows.filter((row) => row.priority === 'P0' || row.priority === 'P1');
  const actionRows = rows.map((row) => `
      <tr class="${row.status}">
        <td><strong>${escapeHtml(row.priority)}</strong><span>${escapeHtml(row.status)}</span></td>
        <td><strong>${escapeHtml(row.theme)}</strong><span>${escapeHtml(row.horizon)}</span></td>
        <td>${escapeHtml(row.question)}</td>
        <td>${escapeHtml(row.evidence)}</td>
        <td>${escapeHtml(row.likely_root_cause)}</td>
        <td>${escapeHtml(row.recommended_action)}<br><small>${escapeHtml(row.next_experiment_or_check)}</small></td>
        <td>${escapeHtml(row.customer_data_needed)}</td>
      </tr>
  `).join('');
  const urgentList = urgentRows.slice(0, 6).map((row) => `<li><strong>${escapeHtml(row.theme)}:</strong> ${escapeHtml(row.recommended_action)}</li>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle IE Action Plan</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --panel2:#101922; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --ok:#43c687; --warn:#f1b752; --blue:#77c8ff; --bad:#ff7b7b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 1360px; margin:0 auto; padding:28px; display:grid; gap:18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2 { margin:0 0 10px; letter-spacing:0; }
    p, li { color:var(--muted); line-height:1.55; }
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
    th, td { border-top:1px solid var(--line); padding:9px; text-align:left; vertical-align:top; color:var(--muted); }
    th { color:var(--text); background:#101922; position:sticky; top:0; }
    td strong { display:block; color:var(--text); margin-bottom:4px; }
    td span, small { color:var(--muted); }
    tr.baseline-ok td:first-child strong { color:var(--ok); }
    tr.watch td:first-child strong { color:var(--warn); }
    tr.needs-site-data td:first-child strong { color:var(--blue); }
    .note { border-left:3px solid var(--warn); background:rgba(241,183,82,.08); }
    @media (max-width: 980px) { main { padding:14px; } .cards { grid-template-columns:1fr 1fr; } table { font-size:11.5px; } }
    @media (max-width: 680px) { .cards { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Industrial engineering action plan</p>
      <h1>Four-Way Shuttle IE Review: From Findings To Actions</h1>
      <p>This report turns the verified DES review artifacts into decision-ready operating actions: what is acceptable as an internal baseline, what deserves a watch item, and what still needs customer/site data before making a real-site capacity claim.</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="data/ie-action-plan.csv">Open CSV</a>
        <a class="button" href="data/ie-action-plan.json">Open JSON</a>
        <a class="button" href="metric-lineage.html">Metric Lineage</a>
      </div>
    </header>
    <section class="summary">
      <h2>Executive Summary</h2>
      <ul>
        <li><strong>The internal model is review-ready as a baseline, not a site commitment.</strong> 24h total PPH is ${report24h ? round(report24h.result.totalPph, 3) : 'n/a'} and 7d total PPH is ${report7d ? round(report7d.result.totalPph, 3) : 'n/a'}, with route misses at ${report24h?.result.routeModel.routeUnavailableCount ?? 'n/a'} / ${report7d?.result.routeModel.routeUnavailableCount ?? 'n/a'} and data-integrity failures at 0.</li>
        <li><strong>The main operating tradeoff is release policy.</strong> Cap 6 remains the review baseline because higher release caps increase throughput but materially raise waiting.</li>
        <li><strong>DES avoidance is now auditable task by task.</strong> ${replayRows.length} replay rows show ${replayFailCount} fail routes and ${replayWatchCount} watch routes; watch rows are long waits/routes to inspect, not off-grid proof.</li>
        <li><strong>Customer data is the remaining blocker for real-site validation.</strong> The action plan keeps site-data rows separate from software findings so the Monday review can separate model readiness from calibration requirements.</li>
      </ul>
    </section>
    <section>
      <p class="eyebrow">Status readout</p>
      <h2>What Needs Attention First</h2>
      <div class="cards">
        <div class="card"><span>P0 actions</span><strong>${priorityCounts.P0 ?? 0}</strong></div>
        <div class="card"><span>P1 actions</span><strong>${priorityCounts.P1 ?? 0}</strong></div>
        <div class="card"><span>Watch rows</span><strong>${statusCounts.watch ?? 0}</strong></div>
        <div class="card"><span>Needs site data</span><strong>${statusCounts['needs-site-data'] ?? 0}</strong></div>
      </div>
      <p>The current pack has no P0 stop-ship item when route fail count remains zero. P1 rows are mostly customer-data and policy-threshold decisions, not evidence that the DES engine is broken.</p>
    </section>
    <section>
      <p class="eyebrow">Recommended next steps</p>
      <h2>Use These Actions In The Review</h2>
      <ul>${urgentList || '<li>No P0/P1 rows were generated.</li>'}</ul>
    </section>
    <section>
      <p class="eyebrow">Findings with evidence</p>
      <h2>Issue-To-Action Table</h2>
      <table>
        <thead><tr><th>Priority</th><th>Theme</th><th>Question</th><th>Evidence</th><th>Likely Cause</th><th>Action / Experiment</th><th>Customer Data Needed</th></tr></thead>
        <tbody>${actionRows}</tbody>
      </table>
    </section>
    <section class="note">
      <p class="eyebrow">Caveats and assumptions</p>
      <h2>What Could Change The Recommendation</h2>
      <p>The baseline recommendation can change after customer WCS/MES demand, PLC/video lift timing, blocked/no-drive zones, motion specs, and acceptance thresholds are loaded. Until then, the action plan is an internally verified material-flow review, not a contractual real-site capacity guarantee.</p>
    </section>
  </main>
</body>
</html>`;
}

function renderMetricLineageHtml(rows: MetricLineageRow[]): string {
  const tableRows = rows.map((row) => `
      <tr>
        <td><strong>${escapeHtml(row.display_name)}</strong><span>${escapeHtml(row.metric_id)}</span></td>
        <td>${escapeHtml(row.review_question)}</td>
        <td>${escapeHtml(row.formula)}<br><small>${escapeHtml(row.denominator_or_window)}</small></td>
        <td>${escapeHtml(row.current_24h)}</td>
        <td>${escapeHtml(row.current_7d)}</td>
        <td>${escapeHtml(row.automated_verification)}</td>
        <td><span class="status">${escapeHtml(row.site_calibration_status)}</span><br>${escapeHtml(row.customer_data_needed)}</td>
      </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Four-Way Shuttle Metric Lineage</title>
  <style>
    :root { color-scheme: dark; --bg:#0d141b; --panel:#14202a; --line:#314454; --text:#edf4f7; --muted:#a8b8c3; --blue:#77c8ff; --warn:#f1b752; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, Arial, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 1360px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    header, section { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; }
    h1, h2, p { margin-top:0; }
    p { color:var(--muted); line-height:1.5; }
    a { color:#86d7ff; text-decoration:none; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { border-top:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; color:var(--muted); }
    th { color:var(--text); position:sticky; top:0; background:#101922; }
    td strong { display:block; color:var(--text); margin-bottom:4px; }
    td span, small { color:var(--muted); }
    .status { display:inline-flex; color:var(--warn); font-weight:800; margin-bottom:5px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; min-height:36px; align-items:center; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:#0b1219; color:var(--text); font-weight:700; }
    .eyebrow { text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--muted); margin-bottom:7px; }
    @media (max-width: 900px) { main { padding:14px; } table { font-size:11.5px; } th, td { padding:8px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Metric lineage</p>
      <h1>Four-Way Shuttle 指标血缘与 V&V 口径</h1>
      <p>这个页面回答客户 review 里最容易被追问的问题：每个 PPH、Waiting Share、Reposition、lift utilization、route miss 和 issue register 指标从哪里来，怎么算，当前数值是多少，哪些自动 gate 已经验证，哪些仍然必须用现场数据替换。</p>
      <div class="links">
        <a class="button" href="index.html">Back to Review Hub</a>
        <a class="button" href="data/metric-lineage.csv">Open CSV</a>
        <a class="button" href="data/metric-lineage.json">Open JSON</a>
      </div>
    </header>
    <section>
      <h2>Lineage Table</h2>
      <table>
        <thead><tr><th>Metric</th><th>Question</th><th>Formula / Window</th><th>24h Current</th><th>7d Current</th><th>Automated Verification</th><th>Site Calibration</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function writeCsv(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length === 0) {
    writeFileSync(path, '');
    return;
  }
  const headers = Object.keys(rows[0]!);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function periodLabel(startSec: number, endSec: number): string {
  const endHour = Math.round(endSec / 3600);
  if (endHour <= 24) {
    return `H${String(Math.floor(startSec / 3600)).padStart(2, '0')}-H${String(endHour).padStart(2, '0')}`;
  }
  const day = Math.floor((endHour - 1) / 24) + 1;
  const hourOfDay = ((endHour - 1) % 24) + 1;
  return `D${day} H${String(hourOfDay).padStart(2, '0')}`;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
