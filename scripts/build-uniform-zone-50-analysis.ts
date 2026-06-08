import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createInboundOutboundDemoScenario,
  runHeadlessDes
} from '../packages/shuttle-sim-core/src/index.ts';

type DesResult = ReturnType<typeof runHeadlessDes>;
type Scenario = ReturnType<typeof createInboundOutboundDemoScenario>;
type TaskTrace = DesResult['reservationReplay']['tasks'][number];
type ReplayPhase = TaskTrace['phases'][number];

const outputHtmlPath = resolve('output/review/uniform-zone-50-analysis.html');
const outputJsonPath = resolve('output/review/uniform-zone-50-analysis.json');
mkdirSync(dirname(outputHtmlPath), { recursive: true });

const baselineScenario = createScenario('baseline-current-full-columns', {
  initialOutboundFullColumns: 4,
  initialStorageFillPolicy: 'full-columns' as const
});
const uniformScenario = createScenario('uniform-zone-50', {
  initialOutboundFullColumns: 0,
  initialStorageFillPolicy: 'zone-balanced-50' as const,
  storageSelectionPolicy: 'sequential' as const
});
const optimizedScenario = createScenario('uniform-zone-50-traffic-aware', {
  initialOutboundFullColumns: 0,
  initialStorageFillPolicy: 'zone-balanced-50' as const,
  storageSelectionPolicy: 'traffic-aware' as const
});

const runOptions = {
  durationSec: 24 * 3600,
  sampleIntervalSec: 3600,
  maxActiveTasks: 6,
  traceTaskLimit: 6000
};

const baseline = runHeadlessDes({ scenario: baselineScenario, ...runOptions });
const uniform = runHeadlessDes({ scenario: uniformScenario, ...runOptions });

const report = {
  generatedAtIso: new Date().toISOString(),
  runOptions,
  runs: [
    summarizeRun('Current baseline: first 4 columns full', baselineScenario, baseline),
    summarizeRun('Uniform four-zone 50% full', uniformScenario, uniform),
    summarizeRun('Uniform 50% + traffic-aware storage selection', optimizedScenario, runHeadlessDes({ scenario: optimizedScenario, ...runOptions }))
  ]
};

writeFileSync(outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(outputHtmlPath, renderHtml(report));

console.log(JSON.stringify({
  type: 'uniform-zone-50-analysis-complete',
  outputHtmlPath,
  outputJsonPath,
  baseline: report.runs[0]?.summary,
  uniform: report.runs[1]?.summary
}, null, 2));

function createScenario(
  id: string,
  taskGeneration: {
    initialOutboundFullColumns: number;
    initialStorageFillPolicy: 'full-columns' | 'zone-balanced-50';
    storageSelectionPolicy?: 'sequential' | 'traffic-aware';
  }
): Scenario {
  return createInboundOutboundDemoScenario({
    id,
    durationSec: 24 * 3600,
    vehicles: { count: 8 },
    physicsParams: {
      liftTimeSec: 30,
      lowerTimeSec: 30
    },
    taskGeneration: {
      inboundRatePerHour: 3600,
      outboundRatePerHour: 3600,
      inboundOutboundMix: 0.5,
      maxTasks: 32,
      storageSelectionPolicy: 'sequential',
      ...taskGeneration
    },
    layoutProfile: {
      layoutKind: 'top-lift-column',
      liftPairCount: 2
    }
  });
}

function summarizeRun(label: string, scenario: Scenario, result: DesResult): Record<string, unknown> {
  return {
    label,
    scenarioId: scenario.id,
    initialFillPolicy: scenario.taskGeneration.initialStorageFillPolicy,
    storageSelectionPolicy: scenario.taskGeneration.storageSelectionPolicy,
    initialOutboundFullColumns: scenario.taskGeneration.initialOutboundFullColumns,
    initialZoneFill: summarizeInitialZoneFill(scenario),
    summary: {
      totalPph: result.totalPph,
      inboundPph: result.inboundPph,
      outboundPph: result.outboundPph,
      completedInbound: result.completedInbound,
      completedOutbound: result.completedOutbound,
      storedLoadsFinal: result.storedLoads,
      storageUtilizationFinalPct: round(result.storageUtilization * 100, 2),
      averageWaitingPct: result.averageWaitingPct,
      averageRepositionPct: result.averageRepositionPct,
      maxContinuousWaitingSec: result.maxContinuousWaitingSec,
      trafficReservationWaitPct: result.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0,
      liftWaitPct: result.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0,
      routeMisses: result.routeModel.routeUnavailableCount,
      averageShuttleUtilizationPct: round(result.averageShuttleUtilization * 100, 2)
    },
    zoneWaits: summarizeZoneWaits(result.reservationReplay.tasks),
    topTrafficBottlenecks: result.trafficBottlenecks.slice(0, 12),
    topWaitIntervals: result.reservationReplay.topWaitIntervals.slice(0, 12)
  };
}

function summarizeInitialZoneFill(scenario: Scenario): Array<Record<string, unknown>> {
  const cells = scenario.layout.nodes
    .filter((node) => node.type === 'storage')
    .flatMap((node) => {
      const match = /^storage-r(\d+)-c(\d+)$/.exec(node.id);
      return match ? [{ row: Number(match[1]), column: Number(match[2]) }] : [];
    });
  const maxRow = Math.max(0, ...cells.map((cell) => cell.row));
  const maxColumn = Math.max(0, ...cells.map((cell) => cell.column));
  const zoneColumnSpan = Math.max(1, Math.ceil(maxColumn / 2));
  const zoneStoredColumnCount = Math.floor(zoneColumnSpan / 2);
  const zoneByName = new Map<string, { cells: number; stored: number }>();
  for (const cell of cells) {
    const zone = `${cell.row <= Math.ceil(maxRow / 2) ? 'top' : 'bottom'}-${cell.column <= Math.ceil(maxColumn / 2) ? 'left' : 'right'}`;
    const current = zoneByName.get(zone) ?? { cells: 0, stored: 0 };
    current.cells += 1;
    const stored = scenario.taskGeneration.initialStorageFillPolicy === 'zone-balanced-50'
      ? ((cell.column - 1) % zoneColumnSpan) < zoneStoredColumnCount
      : cell.column <= scenario.taskGeneration.initialOutboundFullColumns;
    if (stored) current.stored += 1;
    zoneByName.set(zone, current);
  }
  return Array.from(zoneByName.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([zone, stat]) => ({
      zone,
      stored: stat.stored,
      cells: stat.cells,
      fillPct: round(stat.stored / Math.max(1, stat.cells) * 100, 2)
    }));
}

function summarizeZoneWaits(tasks: TaskTrace[]): Array<Record<string, unknown>> {
  const stats = new Map<string, { waitSec: number; count: number; resources: Map<string, number> }>();
  for (const task of tasks) {
    for (const phase of task.phases) {
      if (!phase.resourceId || (phase.kind !== 'traffic-wait' && phase.kind !== 'lift-wait')) continue;
      const zone = classifyResourceZone(phase.resourceId);
      const waitSec = Math.max(0, phase.endSec - phase.startSec);
      const stat = stats.get(zone) ?? { waitSec: 0, count: 0, resources: new Map<string, number>() };
      stat.waitSec += waitSec;
      stat.count += 1;
      stat.resources.set(phase.resourceId, (stat.resources.get(phase.resourceId) ?? 0) + waitSec);
      stats.set(zone, stat);
    }
  }
  return Array.from(stats.entries())
    .map(([zone, stat]) => ({
      zone,
      waitMin: round(stat.waitSec / 60, 2),
      count: stat.count,
      topResources: Array.from(stat.resources.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([resourceId, waitSec]) => ({ resourceId, waitMin: round(waitSec / 60, 2) }))
    }))
    .sort((left, right) => Number(right.waitMin) - Number(left.waitMin));
}

function classifyResourceZone(resourceId: string): string {
  const raw = resourceId.replace(/^(node|edge):/, '');
  const storage = /^storage-r(\d+)-c(\d+)$/.exec(raw);
  if (storage) return `${Number(storage[1]) <= 7 ? 'top' : 'bottom'}-${Number(storage[2]) <= 14 ? 'left' : 'right'}`;
  const column = /^column-(top|middle|bottom)(?:-[ab])?-c(\d+)$/.exec(raw);
  if (column) return `${column[1] === 'middle' ? 'middle' : column[1]}-${Number(column[2]) <= 14 ? 'left' : 'right'}`;
  const moduleSpine = /^module-(\d+)-spine-(top|middle|bottom)(?:-[ab])?/.exec(raw);
  if (moduleSpine) return `${moduleSpine[2] === 'middle' ? 'middle' : moduleSpine[2]}-${Number(moduleSpine[1]) <= 1 ? 'left' : 'right'}`;
  return 'other';
}

function renderHtml(report: Record<string, unknown>): string {
  const runs = report.runs as Array<Record<string, unknown>>;
  const comparisonRows = runs.map((run) => {
    const summary = run.summary as Record<string, number>;
    return `
      <tr>
        <td>${escapeHtml(String(run.label))}</td>
        <td>${summary.totalPph}</td>
        <td>${summary.averageWaitingPct}%</td>
        <td>${summary.trafficReservationWaitPct}%</td>
        <td>${summary.liftWaitPct}%</td>
        <td>${summary.averageRepositionPct}%</td>
        <td>${summary.maxContinuousWaitingSec}s</td>
        <td>${summary.routeMisses}</td>
      </tr>
    `;
  }).join('');
  const runSections = runs.map((run) => {
    const fillRows = (run.initialZoneFill as Array<Record<string, unknown>>).map((row) => `
      <tr><td>${escapeHtml(String(row.zone))}</td><td>${row.stored}/${row.cells}</td><td>${row.fillPct}%</td></tr>
    `).join('');
    const zoneWaitRows = (run.zoneWaits as Array<Record<string, unknown>>).map((row) => `
      <tr>
        <td>${escapeHtml(String(row.zone))}</td>
        <td>${row.waitMin} min</td>
        <td>${row.count}</td>
        <td>${escapeHtml((row.topResources as Array<Record<string, unknown>>).map((item) => `${item.resourceId} (${item.waitMin}m)`).join(', '))}</td>
      </tr>
    `).join('');
    const bottleneckRows = (run.topTrafficBottlenecks as Array<Record<string, unknown>>).map((row) => `
      <tr><td><code>${escapeHtml(String(row.resourceId))}</code></td><td>${round(Number(row.waitSec) / 60, 2)} min</td><td>${row.waitCount}</td></tr>
    `).join('');
    return `
      <section>
        <h2>${escapeHtml(String(run.label))}</h2>
        <h3>Initial Fill</h3>
        <table><thead><tr><th>Zone</th><th>Stored / Cells</th><th>Fill</th></tr></thead><tbody>${fillRows}</tbody></table>
        <h3>Wait By Zone</h3>
        <table><thead><tr><th>Zone</th><th>Wait</th><th>Events</th><th>Top resources</th></tr></thead><tbody>${zoneWaitRows}</tbody></table>
        <h3>Top Traffic Bottlenecks</h3>
        <table><thead><tr><th>Resource</th><th>Wait</th><th>Events</th></tr></thead><tbody>${bottleneckRows}</tbody></table>
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Uniform Zone 50% DES Analysis</title>
  <style>
    body { margin:0; background:#f7f8fb; color:#1f2430; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.5; }
    main { max-width:1180px; margin:0 auto; padding:32px 24px 56px; }
    h1 { margin:0 0 12px; font-size:clamp(30px,4vw,44px); line-height:1.05; letter-spacing:0; }
    h2 { margin:0 0 12px; font-size:24px; letter-spacing:0; }
    h3 { margin:22px 0 8px; font-size:17px; letter-spacing:0; }
    p { color:#344054; }
    section { background:#fff; border:1px solid #e2e5ea; border-radius:8px; padding:22px; margin-top:18px; }
    table { width:100%; border-collapse:collapse; margin-top:10px; font-size:14px; }
    th,td { border-bottom:1px solid #e2e5ea; padding:9px 8px; text-align:left; vertical-align:top; }
    th { color:#667085; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:.92em; }
    .callout { border-left:4px solid #cc6f47; padding:10px 14px; background:#fff7f2; border-radius:0 8px 8px 0; }
    @media (max-width: 820px) { main { padding:24px 14px 44px; } section { padding:16px; } }
  </style>
</head>
<body>
<main>
  <h1>Uniform Zone 50% DES Analysis</h1>
  <p>这份报告把当前 baseline 和“四个 Zone 均匀 50% 满”的 DES 结果放在一起比较。</p>
  <section>
    <h2>Comparison</h2>
    <p class="callout">当前 baseline 是前 4 列整列满；uniform 方案是 top-left、top-right、bottom-left、bottom-right 每个 Zone 都 49/98 cell stored。</p>
    <table><thead><tr><th>Run</th><th>Total PPH</th><th>Waiting</th><th>Traffic wait</th><th>Lift wait</th><th>Reposition</th><th>Max continuous wait</th><th>Route misses</th></tr></thead><tbody>${comparisonRows}</tbody></table>
  </section>
  ${runSections}
</main>
</body>
</html>`;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
