import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type LayoutNode = {
  id: string;
  type: string;
  x: number;
  z: number;
  liftKind?: string;
};

type LayoutEdge = {
  id: string;
  from: string;
  to: string;
};

type TrafficBottleneck = {
  resourceId: string;
  waitSec: number;
  waitCount: number;
};

type DesReviewReport = {
  generatedAtIso: string;
  scenarioId: string;
  assumptions: {
    liftTimeSec: number;
    lowerTimeSec: number;
    maxActiveTasks: number;
  };
  result: {
    durationSec: number;
    totalPph: number;
    inboundPph: number;
    outboundPph: number;
    averageWaitingPct: number;
    averageRepositionPct: number;
    averageShuttleUtilization: number;
    maxQueuedTaskAgeSec: number;
    liftPph: Record<string, { kind: string; completed: number; pph: number; utilization: number }>;
    waitReasonBreakdown: Record<string, { seconds: number; pct: number }>;
    repositionBreakdown: Record<string, { seconds: number; pct: number }>;
    trafficBottlenecks: TrafficBottleneck[];
    routeModel: {
      routeUnavailableCount: number;
      reservationWindowCount: number;
      trafficWaitSec: number;
    };
  };
  physicalAudit: {
    contract: { status: string };
    liveness: { status: string };
  };
};

type ReplayTaskRow = {
  task_id: string;
  shuttle_id: string;
  task_kind: string;
  region_index: string;
  storage_node_id: string;
  lift_node_id: string;
  traffic_wait_sec: string;
  lift_wait_sec: string;
  total_wait_sec: string;
  primary_wait_resource: string;
  route_status: string;
};

type LocatedResource = TrafficBottleneck & {
  rank: number;
  kind: 'node' | 'edge' | 'unknown';
  label: string;
  shortLabel: string;
  x: number;
  z: number;
  from?: LayoutNode;
  to?: LayoutNode;
  cluster: string;
};

const reviewRoot = resolve('output/review');
const report24Path = resolve(reviewRoot, 'shuttle-des-review-24h-vv.json');
const report7dPath = resolve(reviewRoot, 'shuttle-des-review-7d-vv.json');
const replayCsvPath = resolve(reviewRoot, 'data/des-reservation-replay-tasks-24h.csv');
const outputHtmlPath = resolve(reviewRoot, 'bottleneck-traffic-analysis.html');
const outputJsonPath = resolve(reviewRoot, 'bottleneck-traffic-analysis.json');
const chartDir = resolve(reviewRoot, 'charts');

mkdirSync(dirname(outputHtmlPath), { recursive: true });
mkdirSync(chartDir, { recursive: true });

const report24 = readJson<DesReviewReport>(report24Path);
const report7d = readJson<DesReviewReport>(report7dPath);
const replayRows = existsSync(replayCsvPath) ? readCsv<ReplayTaskRow>(replayCsvPath) : [];

const scenario = createInboundOutboundDemoScenario({
  durationSec: report24.result.durationSec,
  vehicles: { count: 8 },
  taskGeneration: {
    inboundRatePerHour: 3600,
    outboundRatePerHour: 3600,
    inboundOutboundMix: 0.5,
    initialOutboundFullColumns: 4
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: 2
  }
});

const nodes = scenario.layout.nodes as LayoutNode[];
const edges = scenario.layout.edges as LayoutEdge[];
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const located = locateResources(report24.result.trafficBottlenecks, nodeById).slice(0, 20);
const top10WaitSec = located.slice(0, 10).reduce((sum, item) => sum + item.waitSec, 0);
const listedWaitSec = located.reduce((sum, item) => sum + item.waitSec, 0);
const c17ToC19WaitSec = located
  .filter((item) => /c(?:17|18|19)\b/.test(item.resourceId) || /module-02-spine-bottom/.test(item.resourceId))
  .reduce((sum, item) => sum + item.waitSec, 0);
const topCluster = summarizeCluster(located);
const replaySummary = summarizeReplayRows(replayRows);

const hotspotSvgPath = resolve(chartDir, 'bottleneck-hotspot-map.svg');
const hotspotPngPath = resolve(chartDir, 'bottleneck-hotspot-map.png');
const rankingSvgPath = resolve(chartDir, 'bottleneck-ranking.svg');
const rankingPngPath = resolve(chartDir, 'bottleneck-ranking.png');
const hotspotSvg = renderHotspotMapSvg(nodes, edges, located);
const rankingSvg = renderRankingSvg(located.slice(0, 15));
writeFileSync(hotspotSvgPath, hotspotSvg);
writeFileSync(rankingSvgPath, rankingSvg);
convertSvgToPng(hotspotSvgPath, hotspotPngPath, 2);
convertSvgToPng(rankingSvgPath, rankingPngPath, 2);

const output = {
  generatedAtIso: new Date().toISOString(),
  sourceReports: {
    report24Path,
    report7dPath,
    replayCsvPath
  },
  headline: {
    totalPph24h: report24.result.totalPph,
    waitingPct24h: report24.result.averageWaitingPct,
    trafficReservationPct24h: report24.result.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0,
    liftWaitPct24h: report24.result.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0,
    repositionPct24h: report24.result.averageRepositionPct,
    routeMisses24h: report24.result.routeModel.routeUnavailableCount,
    physicalGate24h: `${report24.physicalAudit.contract.status}/${report24.physicalAudit.liveness.status}`,
    top10ShareOfListedTop20: listedWaitSec > 0 ? round((top10WaitSec / listedWaitSec) * 100, 1) : 0,
    c17ToC19AndModule02BottomWaitHours: round(c17ToC19WaitSec / 3600, 2)
  },
  topCluster,
  replaySummary,
  bottlenecks: located
};
writeFileSync(outputJsonPath, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(outputHtmlPath, renderHtml({
  report24,
  report7d,
  output,
  located,
  replaySummary,
  hotspotPng: 'charts/bottleneck-hotspot-map.png',
  rankingPng: 'charts/bottleneck-ranking.png'
}));

console.log(JSON.stringify({
  type: 'bottleneck-traffic-analysis-complete',
  outputHtmlPath,
  outputJsonPath,
  hotspotPngPath,
  rankingPngPath,
  topResource: located[0]?.resourceId ?? null
}, null, 2));

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`Missing required input: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readCsv<T extends Record<string, string>>(path: string): T[] {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row as T;
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function locateResources(items: TrafficBottleneck[], nodeById: Map<string, LayoutNode>): LocatedResource[] {
  return items.map((item, index) => {
    const nodeId = item.resourceId.startsWith('node:') ? item.resourceId.slice(5) : null;
    if (nodeId) {
      const node = nodeById.get(nodeId);
      return {
        ...item,
        rank: index + 1,
        kind: node ? 'node' : 'unknown',
        label: humanResourceLabel(item.resourceId),
        shortLabel: shortResourceLabel(item.resourceId),
        x: node?.x ?? 0,
        z: node?.z ?? 0,
        cluster: clusterForResource(item.resourceId)
      };
    }
    const edgeId = item.resourceId.startsWith('edge:') ? item.resourceId.slice(5) : null;
    const endpoints = edgeId ? edgeEndpoints(edgeId, nodeById) : null;
    return {
      ...item,
      rank: index + 1,
      kind: endpoints ? 'edge' : 'unknown',
      label: humanResourceLabel(item.resourceId),
      shortLabel: shortResourceLabel(item.resourceId),
      x: endpoints ? round((endpoints.from.x + endpoints.to.x) / 2, 3) : 0,
      z: endpoints ? round((endpoints.from.z + endpoints.to.z) / 2, 3) : 0,
      from: endpoints?.from,
      to: endpoints?.to,
      cluster: clusterForResource(item.resourceId)
    };
  });
}

function edgeEndpoints(edgeId: string, nodeById: Map<string, LayoutNode>): { from: LayoutNode; to: LayoutNode } | null {
  const nodeIds = [...nodeById.keys()].sort((left, right) => right.length - left.length);
  for (const fromId of nodeIds) {
    const prefix = `${fromId}-`;
    if (!edgeId.startsWith(prefix)) continue;
    const toId = edgeId.slice(prefix.length);
    const from = nodeById.get(fromId);
    const to = nodeById.get(toId);
    if (from && to) return { from, to };
  }
  return null;
}

function clusterForResource(resourceId: string): string {
  if (/module-02-spine-bottom|c(?:17|18|19|20|21)\b/.test(resourceId)) return 'Module 02 bottom / C17-C21 cluster';
  if (/module-01-spine-bottom|c(?:03|04|05|06|07|08)\b/.test(resourceId)) return 'Module 01 bottom / C03-C08 cluster';
  if (/column-middle/.test(resourceId)) return 'Middle aisle column access';
  return 'Other yellow-grid resource';
}

function summarizeCluster(items: LocatedResource[]): Array<{ cluster: string; waitSec: number; waitHours: number; count: number; sharePct: number }> {
  const totals = new Map<string, { waitSec: number; count: number }>();
  for (const item of items) {
    const current = totals.get(item.cluster) ?? { waitSec: 0, count: 0 };
    current.waitSec += item.waitSec;
    current.count += 1;
    totals.set(item.cluster, current);
  }
  const total = [...totals.values()].reduce((sum, item) => sum + item.waitSec, 0);
  return [...totals.entries()]
    .map(([cluster, item]) => ({
      cluster,
      waitSec: round(item.waitSec, 3),
      waitHours: round(item.waitSec / 3600, 2),
      count: item.count,
      sharePct: total > 0 ? round((item.waitSec / total) * 100, 1) : 0
    }))
    .sort((left, right) => right.waitSec - left.waitSec);
}

function summarizeReplayRows(rows: ReplayTaskRow[]) {
  const waited = rows.filter((row) => Number(row.traffic_wait_sec) > 0 || Number(row.lift_wait_sec) > 0);
  const byResource = countBy(waited, (row) => row.primary_wait_resource);
  const byKind = countBy(waited, (row) => row.task_kind);
  const byRegion = countBy(waited, (row) => `region ${row.region_index}`);
  const topRows = [...rows]
    .sort((left, right) => Number(right.total_wait_sec) - Number(left.total_wait_sec))
    .slice(0, 10)
    .map((row) => ({
      taskId: row.task_id,
      shuttleId: row.shuttle_id,
      taskKind: row.task_kind,
      storageNodeId: row.storage_node_id,
      liftNodeId: row.lift_node_id,
      trafficWaitSec: round(Number(row.traffic_wait_sec), 3),
      liftWaitSec: round(Number(row.lift_wait_sec), 3),
      totalWaitSec: round(Number(row.total_wait_sec), 3),
      primaryWaitResource: row.primary_wait_resource,
      routeStatus: row.route_status
    }));
  return {
    sampleRows: rows.length,
    waitedRows: waited.length,
    topPrimaryWaitResources: byResource.slice(0, 10),
    waitByTaskKind: byKind,
    waitByRegion: byRegion,
    topWaitRows: topRows
  };
}

function countBy<T>(rows: T[], keyFn: (row: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function renderHotspotMapSvg(nodes: LayoutNode[], edges: LayoutEdge[], bottlenecks: LocatedResource[]): string {
  const width = 1440;
  const height = 860;
  const margin = { left: 74, right: 420, top: 78, bottom: 84 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minZ = Math.min(...nodes.map((node) => node.z));
  const maxZ = Math.max(...nodes.map((node) => node.z));
  const scale = Math.min((width - margin.left - margin.right) / (maxX - minX), (height - margin.top - margin.bottom) / (maxZ - minZ));
  const tx = (x: number) => margin.left + (x - minX) * scale;
  const ty = (z: number) => margin.top + (z - minZ) * scale;
  const maxWait = Math.max(...bottlenecks.map((item) => item.waitSec));
  const bottleneckByNode = new Map(bottlenecks.filter((item) => item.kind === 'node').map((item) => [item.resourceId.slice(5), item]));
  const bottleneckByEdge = new Map(bottlenecks.filter((item) => item.kind === 'edge').map((item) => [item.resourceId.slice(5), item]));
  const focusNodes = nodes.filter((node) =>
    /^column-(?:bottom-a|bottom-b|middle)-c(?:17|18|19|20|21)$/.test(node.id) ||
    /^module-02-spine-(?:bottom-a|bottom-b|middle)$/.test(node.id)
  );
  const focusX0 = Math.min(...focusNodes.map((node) => tx(node.x))) - 24;
  const focusX1 = Math.max(...focusNodes.map((node) => tx(node.x))) + 24;
  const focusY0 = Math.min(...focusNodes.map((node) => ty(node.z))) - 24;
  const focusY1 = Math.max(...focusNodes.map((node) => ty(node.z))) + 24;

  const edgeLines = edges.map((edge) => {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) return '';
    const hot = bottleneckByEdge.get(edge.id);
    const stroke = hot ? '#CC6F47' : '#D5B73F';
    const strokeWidth = hot ? 4 + (hot.waitSec / maxWait) * 8 : 1.15;
    const opacity = hot ? 0.95 : 0.2;
    return `<line x1="${tx(from.x)}" y1="${ty(from.z)}" x2="${tx(to.x)}" y2="${ty(to.z)}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linecap="round" />`;
  }).join('\n');

  const storageDots = nodes
    .filter((node) => node.type === 'storage')
    .map((node) => `<rect x="${tx(node.x) - 2.4}" y="${ty(node.z) - 2.4}" width="4.8" height="4.8" fill="#A3BEFA" opacity="0.42" rx="1" />`)
    .join('\n');

  const liftDots = nodes
    .filter((node) => node.type === 'lift-blackbox')
    .map((node) => `<g><rect x="${tx(node.x) - 10}" y="${ty(node.z) - 10}" width="20" height="20" fill="${node.liftKind === 'inbound' ? '#71B436' : '#BD569B'}" opacity="0.9" rx="4" /><text x="${tx(node.x)}" y="${ty(node.z) - 14}" text-anchor="middle" class="tiny">${escapeXml(node.id.replace('lift-', 'L'))}</text></g>`)
    .join('\n');

  const hotNodes = bottlenecks.filter((item) => item.kind === 'node').map((item) => {
    const radius = 7 + Math.sqrt(item.waitSec / maxWait) * 25;
    const x = tx(item.x);
    const y = ty(item.z);
    return `<g>
      <circle cx="${x}" cy="${y}" r="${radius + 6}" fill="#FFBDA1" opacity="0.25" />
      <circle cx="${x}" cy="${y}" r="${radius}" fill="#CC6F47" opacity="0.86" stroke="#804126" stroke-width="1.5" />
      <text x="${x}" y="${y + 4}" text-anchor="middle" class="rank">${item.rank}</text>
    </g>`;
  }).join('\n');

  const labelItems = bottlenecks.slice(0, 6);
  const labels = labelItems.map((item, index) => {
    const x = tx(item.x);
    const y = ty(item.z);
    const lx = width - 384;
    const ly = 392 + index * 42;
    const text = `${item.rank}. ${item.shortLabel} · ${round(item.waitSec / 3600, 2)}h / ${item.waitCount}`;
    return `<g>
      <line x1="${x}" y1="${y}" x2="${lx - 12}" y2="${ly - 8}" stroke="#464C55" stroke-width="1" opacity="0.48" />
      <rect x="${lx}" y="${ly - 24}" width="340" height="30" fill="#FFFFFF" stroke="#E2E5EA" rx="5" opacity="0.97" />
      <text x="${lx + 10}" y="${ly - 4}" class="label">${escapeXml(text)}</text>
    </g>`;
  }).join('\n');

  const legend = `<g transform="translate(${width - 384}, 118)">
    <text x="0" y="0" class="legendTitle">How to read this</text>
    <text x="0" y="28" class="legendText">Orange circles = node wait seconds</text>
    <text x="0" y="52" class="legendText">Thick orange line = hot edge</text>
    <text x="0" y="76" class="legendText">Yellow lines = legal drivable graph</text>
    <text x="0" y="100" class="legendText">Blue squares = storage cells</text>
    <text x="0" y="136" class="legendText">Focus box: module 02 lower aisle</text>
    <text x="0" y="160" class="legendText">C17-C19 sits just left of that spine.</text>
  </g>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .title{font:700 24px Inter,Arial,sans-serif;fill:#1F2430}
    .subtitle{font:400 14px Inter,Arial,sans-serif;fill:#6F768A}
    .tiny{font:500 9px Inter,Arial,sans-serif;fill:#464C55}
    .rank{font:700 13px "SF Mono",Menlo,monospace;fill:#fff}
    .label{font:600 12px Inter,Arial,sans-serif;fill:#1F2430}
    .axisLabel{font:500 11px Inter,Arial,sans-serif;fill:#6F768A}
    .legendTitle{font:700 14px Inter,Arial,sans-serif;fill:#1F2430}
    .legendText{font:400 12px Inter,Arial,sans-serif;fill:#464C55}
  </style>
  <rect width="100%" height="100%" fill="#FCFCFD"/>
  <text x="42" y="36" class="title">Traffic reservation hotspots on the yellow-grid graph</text>
  <text x="42" y="59" class="subtitle">24h V&amp;V baseline, circles/lines scaled by accumulated reservation wait seconds. Coordinates use the generated top-lift-column layout.</text>
  <rect x="${focusX0}" y="${focusY0}" width="${focusX1 - focusX0}" height="${focusY1 - focusY0}" fill="#FFEDDE" stroke="#CC6F47" stroke-width="2" stroke-dasharray="8 5" rx="10" opacity="0.8"/>
  ${edgeLines}
  ${storageDots}
  ${liftDots}
  ${hotNodes}
  ${labels}
  ${legend}
  <text x="${tx(27.5)}" y="${ty(20) + 58}" class="axisLabel">C17-C19 lower access lane</text>
  <text x="${tx(31.25) + 16}" y="${ty(20.8) + 10}" class="axisLabel">module-02 spine bottom transfer</text>
</svg>`;
}

function renderRankingSvg(items: LocatedResource[]): string {
  const width = 1240;
  const height = 610;
  const margin = { left: 310, right: 170, top: 82, bottom: 54 };
  const rowH = 30;
  const maxWait = Math.max(...items.map((item) => item.waitSec));
  const xScale = (value: number) => (value / maxWait) * (width - margin.left - margin.right);
  const bars = items.map((item, index) => {
    const y = margin.top + index * rowH;
    const barW = xScale(item.waitSec);
    const fill = item.cluster.startsWith('Module 02') ? '#CC6F47' : item.cluster.startsWith('Module 01') ? '#5477C4' : '#B8A037';
    return `<g>
      <text x="${margin.left - 12}" y="${y + 18}" text-anchor="end" class="barLabel">${escapeXml(`${item.rank}. ${item.shortLabel}`)}</text>
      <rect x="${margin.left}" y="${y + 4}" width="${barW}" height="18" fill="${fill}" rx="4" opacity="0.9"/>
      <text x="${margin.left + barW + 8}" y="${y + 18}" class="value">${round(item.waitSec / 3600, 2)}h · ${item.waitCount}</text>
    </g>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .title{font:700 23px Inter,Arial,sans-serif;fill:#1F2430}
    .subtitle{font:400 14px Inter,Arial,sans-serif;fill:#6F768A}
    .barLabel{font:500 12px Inter,Arial,sans-serif;fill:#1F2430}
    .value{font:500 12px "SF Mono",Menlo,monospace;fill:#464C55}
    .note{font:400 12px Inter,Arial,sans-serif;fill:#6F768A}
  </style>
  <rect width="100%" height="100%" fill="#FCFCFD"/>
  <text x="40" y="36" class="title">Top reservation bottlenecks</text>
  <text x="40" y="59" class="subtitle">24h accumulated wait by node/edge; labels show wait hours and wait count.</text>
  ${bars}
  <g transform="translate(${margin.left}, ${height - 34})">
    <rect x="0" y="-10" width="14" height="10" fill="#CC6F47" rx="2"/><text x="22" y="0" class="note">Module 02 / C17-C21</text>
    <rect x="190" y="-10" width="14" height="10" fill="#5477C4" rx="2"/><text x="212" y="0" class="note">Module 01 / C03-C08</text>
    <rect x="380" y="-10" width="14" height="10" fill="#B8A037" rx="2"/><text x="402" y="0" class="note">Other yellow-grid resource</text>
  </g>
</svg>`;
}

function renderHtml(args: {
  report24: DesReviewReport;
  report7d: DesReviewReport;
  output: unknown;
  located: LocatedResource[];
  replaySummary: ReturnType<typeof summarizeReplayRows>;
  hotspotPng: string;
  rankingPng: string;
}): string {
  const { report24, report7d, located, replaySummary, hotspotPng, rankingPng } = args;
  const top = located[0]!;
  const second = located[1]!;
  const trafficPct = report24.result.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0;
  const liftWaitPct = report24.result.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0;
  const liftUtilRange = utilizationRange(report24);
  const topClusterRows = summarizeCluster(located)
    .map((row) => `<tr><td>${escapeHtml(row.cluster)}</td><td>${row.waitHours} h</td><td>${row.sharePct}%</td><td>${row.count}</td></tr>`)
    .join('');
  const bottleneckRows = located.slice(0, 12).map((item) => `
    <tr>
      <td>${item.rank}</td>
      <td><code>${escapeHtml(item.resourceId)}</code></td>
      <td>${escapeHtml(item.cluster)}</td>
      <td>${round(item.waitSec / 3600, 2)} h</td>
      <td>${item.waitCount}</td>
      <td>${round(item.x, 2)}, ${round(item.z, 2)}</td>
    </tr>`).join('');
  const taskRows = replaySummary.topWaitRows.slice(0, 8).map((row) => `
    <tr>
      <td><code>${escapeHtml(row.taskId)}</code></td>
      <td>${escapeHtml(row.taskKind)}</td>
      <td>${escapeHtml(row.storageNodeId)}</td>
      <td>${escapeHtml(row.liftNodeId)}</td>
      <td>${row.totalWaitSec}s</td>
      <td>${escapeHtml(row.primaryWaitResource)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Traffic Bottleneck Analysis</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #1f2430;
      --muted: #667085;
      --line: #e2e5ea;
      --yellow: #d5b73f;
      --orange: #cc6f47;
      --blue: #5477c4;
      --olive: #71b436;
      --pink: #bd569b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 56px; }
    h1 { margin: 0 0 14px; font-size: clamp(30px, 4vw, 44px); line-height: 1.05; letter-spacing: 0; }
    h2 { margin: 34px 0 12px; font-size: 24px; letter-spacing: 0; }
    h3 { margin: 20px 0 8px; font-size: 18px; letter-spacing: 0; }
    p { margin: 8px 0 12px; color: #344054; }
    code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.92em; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0 24px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .metric span { display:block; color: var(--muted); font-size: 12px; }
    .metric strong { display:block; margin-top: 5px; font-size: 22px; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      margin-top: 18px;
    }
    .figure {
      margin: 18px 0 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fcfcfd;
    }
    .figure img { display: block; width: 100%; height: auto; }
    .callout {
      border-left: 4px solid var(--orange);
      padding: 10px 14px;
      background: #fff7f2;
      border-radius: 0 8px 8px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 14px;
    }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .small { color: var(--muted); font-size: 13px; }
    ul, ol { padding-left: 20px; }
    li { margin: 7px 0; }
    @media (max-width: 820px) {
      main { padding: 24px 14px 44px; }
      .summary, .grid2 { grid-template-columns: 1fr; }
      section { padding: 16px; }
      table { font-size: 12px; }
    }
  </style>
</head>
<body>
<main>
  <h1>Traffic Bottleneck Analysis</h1>
  <p>这份报告把 24h V&amp;V 的 reservation wait 映射回 generated top-lift-column 黄线网络，回答“到底堵在哪里”和“那附近发生了什么”。</p>

  <section>
    <h2>Executive Summary</h2>
    <ul>
      <li><strong>当前瓶颈是局部路权冲突，不是 lift 满载。</strong> 24h waiting 为 ${report24.result.averageWaitingPct}%，其中 traffic reservation wait 为 ${round(trafficPct, 3)}%，lift wait 只有 ${round(liftWaitPct, 3)}%。Lift utilization 范围约 ${liftUtilRange}。</li>
      <li><strong>最热区域集中在 module 02 下侧黄线和 C17-C19 列入口。</strong> 最大热点是 <code>${escapeHtml(top.resourceId)}</code>，第二热点是 <code>${escapeHtml(second.resourceId)}</code>；这两个点合计约 ${round((top.waitSec + second.waitSec) / 3600, 2)} 小时等待。</li>
      <li><strong>这更像调度/路权释放策略问题。</strong> 车队平均 utilization 约 ${round(report24.result.averageShuttleUtilization * 100, 1)}%，reposition 为 ${report24.result.averageRepositionPct}%，说明车不是缺活，而是在局部热点和去 pickup 的过程中消耗时间。</li>
      <li><strong>安全 gate 没失败，但性能解释要保守。</strong> route misses 为 ${report24.result.routeModel.routeUnavailableCount}，physical gate 是 ${escapeHtml(report24.physicalAudit.contract.status)}/${escapeHtml(report24.physicalAudit.liveness.status)}；这说明没有越黄线/找不到路，但不说明当前调度已经最优。</li>
    </ul>
  </section>

  <section>
    <h2>Hotspot Map: 堵点落在下侧 C17-C19 和 module 02 spine</h2>
    <p><strong>这张图是最重要的定位图。</strong> 橙色圆圈是节点等待，橙色粗线是边等待，编号对应 bottleneck 排名。虚线框里的 module 02 lower aisle 是当前最值得打开 3D/2D 盯的区域。</p>
    <div class="figure"><img src="${hotspotPng}" alt="Traffic hotspot map on yellow grid" /></div>
    <p class="callout">我的解释：C17-C19 下侧访问点和 module-02 bottom spine 是一个“汇入/横移/转竖向”的组合冲突区。车辆要从列通道出来、横向经过 bottom-a，再通过 module spine bottom-a/b 做转接；reservation-window 策略会让后车在节点或边前等待，因此累计 wait 集中在这一小片。</p>
  </section>

  <section>
    <h2>Top Bottlenecks: 前两个点已经解释了很大一块等待</h2>
    <p><strong>等待不是均匀分布。</strong> top 20 里，module 02 / C17-C21 cluster 占比最高；这说明优化应该先针对局部通道和 dispatch gate，而不是全仓库平均撒改。</p>
    <div class="figure"><img src="${rankingPng}" alt="Top reservation bottleneck ranking" /></div>
    <div class="grid2">
      <div>
        <h3>Cluster summary</h3>
        <table><thead><tr><th>Cluster</th><th>Wait</th><th>Share</th><th>Rows</th></tr></thead><tbody>${topClusterRows}</tbody></table>
      </div>
      <div>
        <h3>Why this matters</h3>
        <p>如果一个小区域占掉大量等待，继续加车或提高任务释放上限可能会把问题放大。更合理的下一步是做局部控制实验：限制同时进入 C17-C21 lower lane 的任务数、让 outbound/inbound 在 module 02 bottom spine 有明确优先级、或给 C17-C19 旁边建立更早的 yield/pocket 规则。</p>
      </div>
    </div>
  </section>

  <section>
    <h2>What Is Happening Near That Area</h2>
    <p><strong>从行为上看，热点区域在处理三类冲突。</strong></p>
    <ol>
      <li><strong>列入口冲突：</strong><code>column-bottom-a-c17/c18/c19</code> 是下侧外部黄线访问点，车辆从 storage column 出入时会在这里争用单容量节点。</li>
      <li><strong>module spine 转接冲突：</strong><code>module-02-spine-bottom-a → bottom-b</code> 是下侧双线之间的转接边，横向和竖向/服务方向的车辆都容易碰到这个 reservation。</li>
      <li><strong>任务释放压力：</strong><code>maxActiveTasks=6</code> 下仍有 active-task-backpressure 和 buffer full 计数，说明系统在保护并发，但热点附近的任务顺序仍会把车辆推到同一个小区域。</li>
    </ol>
    <p>所以这不是“车跑出了黄线”，而是“所有车都遵守黄线以后，某些黄线节点成了单车道瓶颈”。</p>
  </section>

  <section>
    <h2>Evidence Tables</h2>
    <h3>Top located resources</h3>
    <table>
      <thead><tr><th>Rank</th><th>Resource</th><th>Cluster</th><th>Wait</th><th>Count</th><th>x, z</th></tr></thead>
      <tbody>${bottleneckRows}</tbody>
    </table>
    <h3>Task replay sample: longest waits</h3>
    <p class="small">Replay sample 是抽样任务，不是全量等待统计；用来理解行为，不替代 aggregate bottleneck 排名。</p>
    <table>
      <thead><tr><th>Task</th><th>Kind</th><th>Storage</th><th>Lift</th><th>Total Wait</th><th>Primary Wait</th></tr></thead>
      <tbody>${taskRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Recommended Next Steps</h2>
    <ol>
      <li><strong>先做 module 02 / C17-C21 局部 replay。</strong> 在 live UI 里高亮这些 resource，观察车辆是否反复在 bottom-a/b 转接边前让行。</li>
      <li><strong>做一个 dispatch A/B：</strong>对 C17-C21 lower lane 加局部并发上限或优先级，比较 total PPH、traffic wait、reposition。</li>
      <li><strong>检查 pickup 分配。</strong> 当前 to-task-pickup reposition 为 ${report24.result.averageRepositionPct}%，需要验证任务是不是经常分给离热点更远的车。</li>
      <li><strong>不要先加 lift。</strong> 24h 与 7d 的 lift utilization 都没有接近饱和；先把路权热点处理掉，才知道 lift 是否成为下一层瓶颈。</li>
    </ol>
  </section>

  <section>
    <h2>Caveats and Assumptions</h2>
    <p>这份报告使用 internal generated top-lift-column layout 和 24h/7d V&amp;V 输出。它可以解释当前模型为什么堵，但还不能替代现场 CAD、WCS/MES 任务流、PLC/video lift timing 和真实 no-drive zone 校准。</p>
    <p class="small">Generated from <code>shuttle-des-review-24h-vv.json</code>, <code>shuttle-des-review-7d-vv.json</code>, and <code>data/des-reservation-replay-tasks-24h.csv</code>.</p>
  </section>
</main>
</body>
</html>`;
}

function utilizationRange(report: DesReviewReport): string {
  const utils = Object.values(report.result.liftPph).map((lift) => lift.utilization * 100);
  return `${round(Math.min(...utils), 1)}%-${round(Math.max(...utils), 1)}%`;
}

function humanResourceLabel(resourceId: string): string {
  return resourceId
    .replace(/^node:/, 'node ')
    .replace(/^edge:/, 'edge ')
    .replace(/-/g, ' ');
}

function shortResourceLabel(resourceId: string): string {
  const raw = resourceId.replace(/^(node|edge):/, '');
  const column = /^column-(top-a|top-b|middle|bottom-a|bottom-b)-c(\d+)$/.exec(raw);
  if (column) return `C${column[2]} ${column[1]}`;
  const moduleEdge = /^module-(\d+)-spine-(top-a|top-b|middle|bottom-a|bottom-b)-module-\d+-spine-(top-a|top-b|middle|bottom-a|bottom-b)$/.exec(raw);
  if (moduleEdge) return `M${moduleEdge[1]} ${moduleEdge[2]} -> ${moduleEdge[3]}`;
  const moduleNode = /^module-(\d+)-spine-(top-a|top-b|middle|bottom-a|bottom-b)$/.exec(raw);
  if (moduleNode) return `M${moduleNode[1]} ${moduleNode[2]}`;
  const storageEdge = /^storage-r(\d+)-c(\d+)-storage-r(\d+)-c(\d+)$/.exec(raw);
  if (storageEdge) return `R${storageEdge[1]}C${storageEdge[2]} -> R${storageEdge[3]}C${storageEdge[4]}`;
  const storageNode = /^storage-r(\d+)-c(\d+)$/.exec(raw);
  if (storageNode) return `R${storageNode[1]}C${storageNode[2]}`;
  return raw.replace(/-/g, ' ').slice(0, 32);
}

function convertSvgToPng(svgPath: string, pngPath: string, scale: number): void {
  const result = spawnSync('rsvg-convert', ['--zoom', String(scale), '--format', 'png', '--output', pngPath, svgPath], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`rsvg-convert failed for ${svgPath}: ${result.stderr || result.stdout}`);
  }
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

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, '&apos;');
}
