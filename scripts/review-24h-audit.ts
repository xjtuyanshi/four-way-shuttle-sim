import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { KpiSnapshot, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  createInboundOutboundDemoScenario,
  hashScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

type IssueSeverity = 'critical' | 'warning' | 'observation';

type ReviewIssue = {
  id: string;
  title: string;
  severity: IssueSeverity;
  metric: string;
  detail: string;
  recommendation: string;
};

type ReviewSample = {
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  windowTotalPph: number;
  activeTasks: number;
  queuedTasks: number;
  waitingVehicles: number;
  averageRepositionPct: number;
  averageWaitingPct: number;
  averageProductivePct: number;
  routeRatioAvg: number;
  routeRatioP95: number;
  routeRatioMax: number;
  deadlocks: number;
  livelocks: number;
  physicalViolations: number;
};

type RouteOutlier = {
  timeSec: number;
  vehicleId: string;
  state: string;
  loaded: boolean;
  taskId: string | null;
  goalNodeId: string;
  ratio: number;
  routeDistanceM: number;
  lowerBoundM: number;
  nodeCount: number;
  reason: string | null;
  route: string;
};

const durationSec = numberArg('--duration-sec', 86_400);
const dtSec = numberArg('--dt-sec', 1);
const sampleSec = numberArg('--sample-sec', 1_800);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const maxActiveVehicleStillSec = numberArg('--max-active-vehicle-still-sec', 180);
const outputPath = resolve(stringArg('--out') ?? `output/review/shuttle-review-24h-${Date.now()}.json`);
const htmlPath = resolve(stringArg('--html') ?? outputPath.replace(/\.json$/i, '.html'));

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(htmlPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  timeStepSec: dtSec,
  vehicles: { count: shuttleCount },
  taskGeneration: {
    inboundRatePerHour,
    outboundRatePerHour,
    inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
      ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
      : 0.5,
    initialOutboundFullColumns
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const sim = new ShuttleSimCore(scenario);
const nodeById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
const vehicleMotion = new Map<string, { x: number; z: number; nodeId: string; lastMovedSec: number }>();
const samples: ReviewSample[] = [];
const routeOutliers: RouteOutlier[] = [];
const routeRatios: number[] = [];
const localRouteReasons = new Map<string, number>();
let nextSampleSec = 0;

sim.start();
for (const vehicle of sim.getState().vehicles) {
  vehicleMotion.set(vehicle.id, {
    x: vehicle.x,
    z: vehicle.z,
    nodeId: vehicle.currentNodeId,
    lastMovedSec: sim.getState().simTimeSec
  });
}

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const state = sim.step(Math.min(dtSec, durationSec - sim.getClock().simTimeSec));
  updateVehicleMotion(state);
  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    const routeStats = sampleRouteEfficiency(state);
    const breakdown = averageBreakdown(state.kpis);
    const sample: ReviewSample = {
      timeSec: round(state.simTimeSec),
      completedInbound: state.kpis.completedInbound,
      completedOutbound: state.kpis.completedOutbound,
      totalPph: round(state.kpis.totalPph, 3),
      windowTotalPph: round(state.kpis.windowTotalPph, 3),
      activeTasks: state.kpis.activeTasks,
      queuedTasks: state.kpis.queuedTasks,
      waitingVehicles: state.traffic.waitingVehicles.length,
      averageRepositionPct: round(breakdown.repositionPct, 2),
      averageWaitingPct: round(breakdown.waitingPct, 2),
      averageProductivePct: round(breakdown.productivePct, 2),
      routeRatioAvg: round(routeStats.avg, 3),
      routeRatioP95: round(routeStats.p95, 3),
      routeRatioMax: round(routeStats.max, 3),
      deadlocks: state.kpis.deadlockCount,
      livelocks: state.kpis.livelockCount,
      physicalViolations: state.traffic.physicalViolationCount
    };
    samples.push(sample);
    console.log(JSON.stringify({ type: 'review-24h-sample', ...sample }));
    nextSampleSec += sampleSec;
  }
}

const finalState = sim.getState();
const finalBreakdown = averageBreakdown(finalState.kpis);
const finalRouteStats = aggregate(routeRatios);
const issues = detectIssues(finalState, finalBreakdown, finalRouteStats);
const report = {
  schemaVersion: 'shuttle.review24h.v1',
  generatedAtIso: new Date().toISOString(),
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  durationSec,
  dtSec,
  sampleSec,
  status: finalState.status,
  summary: {
    completedInbound: finalState.kpis.completedInbound,
    completedOutbound: finalState.kpis.completedOutbound,
    completedTotal: finalState.kpis.completedInbound + finalState.kpis.completedOutbound,
    inboundPph: finalState.kpis.inboundPph,
    outboundPph: finalState.kpis.outboundPph,
    totalPph: finalState.kpis.totalPph,
    windowTotalPph: finalState.kpis.windowTotalPph,
    deadlocks: finalState.kpis.deadlockCount,
    livelocks: finalState.kpis.livelockCount,
    physicalViolations: finalState.traffic.physicalViolationCount,
    routeRatio: finalRouteStats,
    finalBreakdown
  },
  issues,
  samples,
  routeOutliers: routeOutliers.slice(0, 25),
  localRouteReasons: Object.fromEntries([...localRouteReasons.entries()].sort((left, right) => right[1] - left[1])),
  liftPorts: finalState.traffic.liftPorts,
  blockedTimeByReasonSec: finalState.kpis.blockedTimeByReasonSec,
  finalVehicles: finalState.vehicles,
  finalActiveTasks: finalState.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed')
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(htmlPath, renderHtml(report));
console.log(JSON.stringify({ type: 'review-24h-complete', outputPath, htmlPath, issues: issues.length }, null, 2));

if (issues.some((issue) => issue.severity === 'critical')) {
  process.exitCode = 1;
}

function detectIssues(
  state: ShuttleSimState,
  breakdown: ReturnType<typeof averageBreakdown>,
  routes: ReturnType<typeof aggregate>
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const theoretical = state.kpis.theoreticalCapacity;
  const requestedTotalPph = scenario.taskGeneration.inboundRatePerHour + scenario.taskGeneration.outboundRatePerHour;
  const liftAndLowerSec = scenario.physicsParams.liftTimeSec + scenario.physicsParams.lowerTimeSec;
  const activeVehicleStalls = activeVehicleStallSummaries(state);

  if (state.kpis.deadlockCount > 0 || state.kpis.livelockCount > 0 || state.traffic.physicalViolationCount > 0) {
    issues.push({
      id: 'hard-failure',
      title: 'Hard simulation failure detected',
      severity: 'critical',
      metric: `deadlock=${state.kpis.deadlockCount}, livelock=${state.kpis.livelockCount}, physical=${state.traffic.physicalViolationCount}`,
      detail: 'A customer-review run cannot pass with deadlock, livelock, or physical overlap/path violations.',
      recommendation: 'Freeze feature work and debug the first failing timestamp before making throughput claims.'
    });
  }

  if (activeVehicleStalls.length > 0) {
    issues.push({
      id: 'active-vehicle-stall',
      title: 'Active vehicle stall detected',
      severity: 'critical',
      metric: `${activeVehicleStalls.length} active vehicle(s) still >= ${maxActiveVehicleStillSec}s`,
      detail: activeVehicleStalls.map((stall) => `${stall.vehicleId} ${stall.state} ${stall.currentNodeId}`).join('; '),
      recommendation: 'Inspect the blocked vehicle reservation and route context at the first stall timestamp.'
    });
  }

  if (requestedTotalPph > (theoretical?.fleetPph ?? 0) * 3) {
    issues.push({
      id: 'demand-vs-capacity',
      title: 'Requested demand is far above modeled fleet capacity',
      severity: 'warning',
      metric: `requested=${round(requestedTotalPph, 1)} PPH, theoretical fleet=${round(theoretical?.fleetPph ?? 0, 1)} PPH, achieved=${round(state.kpis.totalPph, 1)} PPH`,
      detail: 'The current scenario requests 7200 PPH but the model theory and achieved output are near the shuttle-cycle bound. This makes queue/assignment behavior look artificially saturated.',
      recommendation: 'For review, separate stress-input demos from capacity-claim demos; use a demand level near the expected design capacity when evaluating control logic quality.'
    });
  }

  if (breakdown.repositionPct >= 20) {
    issues.push({
      id: 'high-reposition',
      title: 'High empty reposition / taskless travel',
      severity: 'warning',
      metric: `average reposition=${round(breakdown.repositionPct, 1)}%`,
      detail: 'Reposition is currently defined as empty shuttle travel while no task is assigned. A 20%+ share means the fleet spends a large fraction of time on standby exits, clearing moves, or return positioning.',
      recommendation: 'Add a dispatch policy that holds idle shuttles near demand-weighted lift/column zones instead of sending them through generic storage-exit/standby movements.'
    });
  }

  if (liftAndLowerSec < 5) {
    issues.push({
      id: 'unrealistic-handling-time',
      title: 'Lift / lower time parameter is not review-realistic',
      severity: 'warning',
      metric: `lift=${scenario.physicsParams.liftTimeSec}s, lower=${scenario.physicsParams.lowerTimeSec}s`,
      detail: 'The current review scenario uses near-instant pick/drop timing, so lift utilization and visible load transfer timing are not meaningful for a customer-facing material-flow review.',
      recommendation: 'Run at least one review scenario with lift/lower set to the customer-assumed handling time, for example 30s if that is the agreed assumption.'
    });
  }

  if (routes.p95 >= 2 || routes.max >= 3) {
    issues.push({
      id: 'route-efficiency-outliers',
      title: 'Route efficiency outliers detected',
      severity: 'warning',
      metric: `avg=${round(routes.avg, 2)}x, p95=${round(routes.p95, 2)}x, max=${round(routes.max, 2)}x`,
      detail: 'Some active route plans are much longer than the Manhattan lower bound to the current goal.',
      recommendation: 'Inspect top route outliers and decide whether they are legitimate local yield moves or dispatch/routing mistakes.'
    });
  }

  if (state.kpis.totalPph < (theoretical?.fleetPph ?? 0) * 0.85) {
    issues.push({
      id: 'throughput-gap',
      title: 'Achieved throughput is materially below theoretical fleet bound',
      severity: 'warning',
      metric: `achieved=${round(state.kpis.totalPph, 1)} PPH, theoretical=${round(theoretical?.fleetPph ?? 0, 1)} PPH`,
      detail: 'A large gap can indicate traffic contention, task assignment inefficiency, or scenario imbalance.',
      recommendation: 'Compare achieved vs theoretical under realistic demand and handling time before claiming final PPH.'
    });
  }

  if (issues.length === 0) {
    issues.push({
      id: 'no-rule-failures',
      title: 'No rule-triggered failures in this 24h audit',
      severity: 'observation',
      metric: '0 critical/warning issues',
      detail: 'The configured audit rules did not find hard failures or major policy issues.',
      recommendation: 'Keep this as a baseline and repeat after any routing or dispatch change.'
    });
  }

  return issues;
}

function sampleRouteEfficiency(state: ShuttleSimState): { avg: number; p95: number; max: number } {
  const sampleRatios: number[] = [];
  for (const vehicle of state.vehicles) {
    const route = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
    const goalNodeId = vehicle.plannedGoalNodeId ?? route.at(-1) ?? null;
    if (!goalNodeId || route.length < 2) {
      continue;
    }
    const lowerBoundM = routeLowerBoundM(vehicle, goalNodeId);
    if (lowerBoundM <= 0.05) {
      continue;
    }
    const routeDistanceM = routeDistanceFromVehicleM(vehicle, route);
    const ratio = routeDistanceM / lowerBoundM;
    sampleRatios.push(ratio);
    routeRatios.push(ratio);
    if (vehicle.localRouteReason) {
      localRouteReasons.set(vehicle.localRouteReason, (localRouteReasons.get(vehicle.localRouteReason) ?? 0) + 1);
    }
    if (ratio >= 2) {
      routeOutliers.push({
        timeSec: round(state.simTimeSec),
        vehicleId: vehicle.id,
        state: vehicle.state,
        loaded: vehicle.loaded,
        taskId: vehicle.taskId,
        goalNodeId,
        ratio: round(ratio, 3),
        routeDistanceM: round(routeDistanceM, 3),
        lowerBoundM: round(lowerBoundM, 3),
        nodeCount: route.length,
        reason: vehicle.localRouteReason ?? vehicle.waitReason,
        route: route.join('>')
      });
      routeOutliers.sort((left, right) => right.ratio - left.ratio || right.routeDistanceM - left.routeDistanceM);
      routeOutliers.length = Math.min(routeOutliers.length, 100);
    }
  }
  return aggregate(sampleRatios);
}

function remainingRouteNodeIds(vehicle: VehicleState, preferredNodeIds: string[]): string[] {
  const fallback = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
  const source = preferredNodeIds.length >= 2 ? preferredNodeIds : fallback;
  if (source.length < 2) return source;
  if (vehicle.currentEdgeId && vehicle.targetNodeId) {
    const targetIndex = source.indexOf(vehicle.targetNodeId);
    if (targetIndex >= 0) return [vehicle.currentNodeId, ...source.slice(targetIndex)];
  }
  const currentIndex = source.indexOf(vehicle.currentNodeId);
  if (currentIndex >= 0) return source.slice(currentIndex);
  return fallback.length >= 2 ? fallback : source;
}

function routeDistanceFromVehicleM(vehicle: VehicleState, route: string[]): number {
  let distanceM = 0;
  let cursor = { x: vehicle.x, z: vehicle.z };
  for (const nodeId of route.slice(1)) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    distanceM += Math.hypot(node.x - cursor.x, node.z - cursor.z);
    cursor = { x: node.x, z: node.z };
  }
  return distanceM;
}

function routeLowerBoundM(vehicle: VehicleState, goalNodeId: string): number {
  const node = nodeById.get(goalNodeId);
  return node ? Math.abs(node.x - vehicle.x) + Math.abs(node.z - vehicle.z) : 0;
}

function averageBreakdown(kpis: KpiSnapshot): {
  busyPct: number;
  productivePct: number;
  movingPct: number;
  handlingPct: number;
  waitingPct: number;
  idlePct: number;
  repositionPct: number;
} {
  const values = Object.values(kpis.vehicleUtilizationBreakdown);
  const average = (selector: (value: typeof values[number]) => number): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + selector(value), 0) / values.length * 100;
  return {
    busyPct: round(average((value) => value.busy), 3),
    productivePct: round(average((value) => value.productive), 3),
    movingPct: round(average((value) => value.moving), 3),
    handlingPct: round(average((value) => value.handling), 3),
    waitingPct: round(average((value) => value.waiting), 3),
    idlePct: round(average((value) => value.idle), 3),
    repositionPct: round(average((value) => value.tasklessTravel), 3)
  };
}

function activeVehicleStallSummaries(state: ShuttleSimState): Array<{
  vehicleId: string;
  stillForSec: number;
  state: string;
  currentNodeId: string;
}> {
  return state.vehicles
    .filter((vehicle) => vehicle.taskId !== null || vehicle.loaded || vehicle.targetNodeId !== null)
    .map((vehicle) => {
      const motion = vehicleMotion.get(vehicle.id);
      return {
        vehicleId: vehicle.id,
        stillForSec: round(state.simTimeSec - (motion?.lastMovedSec ?? state.simTimeSec), 3),
        state: vehicle.state,
        currentNodeId: vehicle.currentNodeId
      };
    })
    .filter((vehicle) => vehicle.stillForSec >= maxActiveVehicleStillSec);
}

function updateVehicleMotion(state: ShuttleSimState): void {
  for (const vehicle of state.vehicles) {
    const previous = vehicleMotion.get(vehicle.id);
    if (
      !previous ||
      previous.nodeId !== vehicle.currentNodeId ||
      Math.hypot(previous.x - vehicle.x, previous.z - vehicle.z) > 0.02
    ) {
      vehicleMotion.set(vehicle.id, {
        x: vehicle.x,
        z: vehicle.z,
        nodeId: vehicle.currentNodeId,
        lastMovedSec: state.simTimeSec
      });
    }
  }
}

function aggregate(values: number[]): { count: number; avg: number; p95: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const avg = sorted.length === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    avg: round(avg, 3),
    p95: round(sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))]!, 3),
    max: round(sorted.at(-1) ?? 0, 3)
  };
}

function renderHtml(report: typeof report): string {
  const issueCards = report.issues.map((issue, index) => `
    <article class="issue ${issue.severity}" id="issue-${index + 1}">
      <div>
        <p class="eyebrow">${issue.severity}</p>
        <h2>${escapeHtml(issue.title)}</h2>
      </div>
      <strong>${escapeHtml(issue.metric)}</strong>
      <p>${escapeHtml(issue.detail)}</p>
      <p class="recommendation">${escapeHtml(issue.recommendation)}</p>
    </article>
  `).join('\n');
  const pphPoints = sparklinePoints(report.samples.map((sample) => sample.totalPph), 760, 180);
  const repositionPoints = sparklinePoints(report.samples.map((sample) => sample.averageRepositionPct), 760, 180);
  const blockedRows = Object.entries(report.blockedTimeByReasonSec)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 12)
    .map(([reason, seconds]) => `<tr><td>${escapeHtml(reason)}</td><td>${round(Number(seconds), 1)}s</td></tr>`)
    .join('');
  const liftRows = report.liftPorts.map((port) => `
    <tr>
      <td>${escapeHtml(port.nodeId)}</td>
      <td>${port.kind}</td>
      <td>${round((port.utilization ?? 0) * 100, 1)}%</td>
      <td>${round(port.pph ?? 0, 1)}</td>
      <td>${port.completedTasks ?? 0}</td>
      <td>${port.approachOccupancy ?? 0}/${port.approachCapacity ?? 1}</td>
      <td>${port.queueLength}</td>
    </tr>
  `).join('');
  const routeRows = report.routeOutliers.length === 0
    ? '<tr><td colspan="7">No route ratio >= 2.0 was observed at sample points.</td></tr>'
    : report.routeOutliers.slice(0, 12).map((route) => `
      <tr>
        <td>${formatClock(route.timeSec)}</td>
        <td>${route.vehicleId}</td>
        <td>${escapeHtml(route.goalNodeId)}</td>
        <td>${route.ratio}x</td>
        <td>${route.routeDistanceM}m</td>
        <td>${route.nodeCount}</td>
        <td>${escapeHtml(route.reason ?? '-')}</td>
      </tr>
    `).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>24h Shuttle Review</title>
  <style>
    :root { color-scheme: dark; --bg: #101922; --panel: #151f2a; --line: #2b3a47; --text: #eef4f6; --muted: #95a6b3; --warn: #f1b752; --crit: #ff6f6f; --ok: #43c687; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    header, section, article { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 18px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 20px; }
    p { color: var(--muted); line-height: 1.5; }
    .eyebrow { margin: 0 0 6px; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: rgba(255,255,255,.03); }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 8px; font-size: 25px; }
    .issues { display: grid; gap: 12px; }
    .issue { display: grid; gap: 10px; }
    .issue.warning { border-color: rgba(241,183,82,.55); }
    .issue.critical { border-color: rgba(255,111,111,.65); }
    .issue.observation { border-color: rgba(67,198,135,.48); }
    .issue strong { font-size: 18px; color: var(--text); }
    .recommendation { color: var(--text); }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    svg { width: 100%; height: 220px; border: 1px solid var(--line); border-radius: 8px; background: #0c131b; }
    polyline { fill: none; stroke-width: 3; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-top: 1px solid var(--line); padding: 9px; text-align: left; color: var(--muted); }
    th { color: var(--text); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 860px) { .grid, .charts, .two { grid-template-columns: 1fr; } main { padding: 14px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">24h review audit</p>
      <h1>Four-Way Shuttle Simulation Review</h1>
      <p>${formatClock(report.durationSec)} simulated, dt ${report.dtSec}s, sample ${report.sampleSec}s. Scenario hash ${report.scenarioHash}.</p>
    </header>
    <section class="grid">
      <div class="metric"><span>Total PPH</span><strong>${round(report.summary.totalPph, 1)}</strong></div>
      <div class="metric"><span>Inbound / Outbound</span><strong>${round(report.summary.inboundPph, 1)} / ${round(report.summary.outboundPph, 1)}</strong></div>
      <div class="metric"><span>Completed</span><strong>${report.summary.completedTotal}</strong></div>
      <div class="metric"><span>Hard failures</span><strong>${report.summary.deadlocks + report.summary.livelocks + report.summary.physicalViolations}</strong></div>
      <div class="metric"><span>Avg reposition</span><strong>${round(report.summary.finalBreakdown.repositionPct, 1)}%</strong></div>
      <div class="metric"><span>Avg waiting</span><strong>${round(report.summary.finalBreakdown.waitingPct, 1)}%</strong></div>
      <div class="metric"><span>Route p95 / max</span><strong>${report.summary.routeRatio.p95}x / ${report.summary.routeRatio.max}x</strong></div>
      <div class="metric"><span>Issue count</span><strong>${report.issues.length}</strong></div>
    </section>
    <section class="issues">
      <p class="eyebrow">Issues</p>
      ${issueCards}
    </section>
    <section class="charts">
      <div>
        <h2>PPH Trend</h2>
        <svg viewBox="0 0 800 220" role="img"><polyline stroke="#e8edf4" points="${pphPoints}" /></svg>
      </div>
      <div>
        <h2>Reposition Trend</h2>
        <svg viewBox="0 0 800 220" role="img"><polyline stroke="#b58cff" points="${repositionPoints}" /></svg>
      </div>
    </section>
    <section class="two">
      <div>
        <h2>Lift Ports</h2>
        <table><thead><tr><th>Lift</th><th>Kind</th><th>Util</th><th>PPH</th><th>Done</th><th>Approach</th><th>Q</th></tr></thead><tbody>${liftRows}</tbody></table>
      </div>
      <div>
        <h2>Blocked Time Reasons</h2>
        <table><thead><tr><th>Reason</th><th>Seconds</th></tr></thead><tbody>${blockedRows}</tbody></table>
      </div>
    </section>
    <section>
      <h2>Route Outliers</h2>
      <table><thead><tr><th>Time</th><th>Unit</th><th>Goal</th><th>Ratio</th><th>Distance</th><th>Nodes</th><th>Reason</th></tr></thead><tbody>${routeRows}</tbody></table>
    </section>
  </main>
</body>
</html>`;
}

function sparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  if (values.length === 1) {
    const y = height - ((values[0]! - min) / Math.max(1, max - min)) * (height - 30) - 15;
    return `20,${round(y, 2)} ${width - 20},${round(y, 2)}`;
  }
  return values.map((value, index) => {
    const x = 20 + (index / (values.length - 1)) * (width - 40);
    const y = height - ((value - min) / Math.max(1, max - min)) * (height - 30) - 15;
    return `${round(x, 2)},${round(y, 2)}`;
  }).join(' ');
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

function numberArg(flag: string, fallback: number): number {
  const raw = stringArg(flag);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function integerArg(flag: string, fallback: number): number {
  const parsed = numberArg(flag, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function stringArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
