import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createInboundOutboundDemoScenario,
  runHeadlessDes
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
  lengthM: number;
  directionMode?: 'oneWay' | 'twoWay';
};

type TracePhase = {
  kind: 'empty-travel' | 'loaded-travel' | 'traffic-wait' | 'lift-wait' | 'lift-handle' | 'lower-handle';
  startSec: number;
  endSec: number;
  resourceId?: string;
};

type TaskTrace = {
  taskId: string;
  shuttleId: string;
  kind: 'inbound' | 'outbound';
  regionIndex: number;
  dispatchSec: number;
  completeSec: number;
  pickupNodeId: string;
  dropoffNodeId: string;
  storageNodeId: string;
  liftNodeId: string;
  emptyRouteNodeIds: string[];
  loadedRouteNodeIds: string[];
  trafficWaitSec: number;
  liftWaitSec: number;
  phases: TracePhase[];
};

type Point = { x: number; z: number };

const outputHtmlPath = resolve('output/review/feasible-area-map.html');
const outputJsonPath = resolve('output/review/feasible-area-map.json');
const outputSvgPath = resolve('output/review/charts/feasible-area-map.svg');
const outputPngPath = resolve('output/review/charts/feasible-area-map.png');
mkdirSync(dirname(outputHtmlPath), { recursive: true });
mkdirSync(dirname(outputSvgPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
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
    initialOutboundFullColumns: 4
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: 2
  }
});

const result = runHeadlessDes({
  scenario,
  durationSec: 24 * 3600,
  sampleIntervalSec: 3600,
  maxActiveTasks: 6,
  traceTaskLimit: 6000
});

const nodes = scenario.layout.nodes as LayoutNode[];
const edges = scenario.layout.edges as LayoutEdge[];
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const traces = result.reservationReplay.tasks as TaskTrace[];
const waits = result.reservationReplay.topWaitIntervals;
const incident = waits.find((wait) => wait.resourceId === 'edge:module-02-spine-bottom-a-module-02-spine-bottom-b') ?? waits[0]!;
const snapshotSec = chooseSnapshotSec();
const activeVehicles = traces
  .filter((trace) => trace.dispatchSec <= snapshotSec && trace.completeSec >= snapshotSec)
  .map((trace) => {
    const phase = trace.phases.find((item) =>
      item.kind !== 'empty-travel' &&
      item.kind !== 'loaded-travel' &&
      item.startSec <= snapshotSec + 1e-9 &&
      item.endSec >= snapshotSec - 1e-9
    ) ??
      trace.phases.find((item) => item.startSec <= snapshotSec + 1e-9 && item.endSec >= snapshotSec - 1e-9) ??
      trace.phases.find((item) => item.startSec >= snapshotSec) ??
      trace.phases.at(-1);
    const point = phase ? pointForPhase(trace, phase, snapshotSec) : null;
    return {
      shuttleId: trace.shuttleId,
      taskId: trace.taskId,
      kind: trace.kind,
      phaseKind: phase?.kind ?? 'unknown',
      resourceId: phase?.resourceId ?? null,
      waitElapsedSec: phase && (phase.kind === 'traffic-wait' || phase.kind === 'lift-wait')
        ? Math.max(0, snapshotSec - phase.startSec)
        : 0,
      storageNodeId: trace.storageNodeId,
      liftNodeId: trace.liftNodeId,
      point
    };
  })
  .filter((item) => item.point !== null);

const feasibleNodeIds = new Set(nodes.filter((node) => isYellowGridNodeId(node.id)).map((node) => node.id));
const feasibleEdges = edges.filter((edge) =>
  feasibleNodeIds.has(edge.from) &&
  feasibleNodeIds.has(edge.to) &&
  isAxisAlignedNodePair(edge.from, edge.to)
);
const infeasibleEdges = edges.filter((edge) => !feasibleEdges.includes(edge));
const svg = renderMapSvg();
writeFileSync(outputSvgPath, svg);
convertSvgToPng(outputSvgPath, outputPngPath);

const evidence = {
  generatedAtIso: new Date().toISOString(),
  snapshotSec: round(snapshotSec, 3),
  snapshotClock: formatClock(snapshotSec),
  incident,
  counts: {
    totalNodes: nodes.length,
    feasibleNodes: feasibleNodeIds.size,
    totalEdges: edges.length,
    feasibleEdges: feasibleEdges.length,
    infeasibleEdges: infeasibleEdges.length,
    activeVehicles: activeVehicles.length
  },
  activeVehicles,
  artifacts: {
    html: outputHtmlPath,
    svg: outputSvgPath,
    png: outputPngPath
  }
};

writeFileSync(outputJsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(outputHtmlPath, renderHtml(evidence));

console.log(JSON.stringify({
  type: 'feasible-area-map-complete',
  outputHtmlPath,
  outputJsonPath,
  outputPngPath,
  snapshotClock: evidence.snapshotClock,
  shuttle01: activeVehicles.filter((vehicle) => vehicle.shuttleId === 'SH-01')
}, null, 2));

function renderMapSvg(): string {
  const width = 1400;
  const height = 860;
  const xs = nodes.map((node) => node.x);
  const zs = nodes.map((node) => node.z);
  const bounds = {
    minX: Math.min(...xs) - 1.8,
    maxX: Math.max(...xs) + 1.8,
    minZ: Math.min(...zs) - 1.8,
    maxZ: Math.max(...zs) + 1.8
  };
  const margin = { left: 70, right: 320, top: 76, bottom: 70 };
  const scale = Math.min(
    (width - margin.left - margin.right) / (bounds.maxX - bounds.minX),
    (height - margin.top - margin.bottom) / (bounds.maxZ - bounds.minZ)
  );
  const tx = (x: number) => margin.left + (x - bounds.minX) * scale;
  const ty = (z: number) => margin.top + (z - bounds.minZ) * scale;

  const noGoEdgeLines = infeasibleEdges.map((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return '';
    return `<line x1="${tx(from.x)}" y1="${ty(from.z)}" x2="${tx(to.x)}" y2="${ty(to.z)}" stroke="#B42318" stroke-width="3" opacity="0.22" stroke-dasharray="5 5" />`;
  }).join('\n');
  const feasibleUnderlay = feasibleEdges.map((edge) => {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    return `<line x1="${tx(from.x)}" y1="${ty(from.z)}" x2="${tx(to.x)}" y2="${ty(to.z)}" stroke="#FFF2A8" stroke-width="13" opacity="0.94" stroke-linecap="round" />`;
  }).join('\n');
  const feasibleLines = feasibleEdges.map((edge) => {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    const hot = edge.id === 'module-02-spine-bottom-a-module-02-spine-bottom-b';
    return `<line x1="${tx(from.x)}" y1="${ty(from.z)}" x2="${tx(to.x)}" y2="${ty(to.z)}" stroke="${hot ? '#CC6F47' : '#C8A900'}" stroke-width="${hot ? 5 : 2.6}" opacity="${hot ? 1 : 0.78}" stroke-linecap="round" />`;
  }).join('\n');
  const storageNodes = nodes.filter((node) => node.type === 'storage').map((node) => {
    const feasible = feasibleNodeIds.has(node.id);
    return `<rect x="${tx(node.x) - 3.4}" y="${ty(node.z) - 3.4}" width="6.8" height="6.8" fill="${feasible ? '#9BBDF9' : '#FCA5A5'}" opacity="${feasible ? 0.52 : 0.9}" rx="1.2" />`;
  }).join('\n');
  const yellowNodes = nodes.filter((node) => feasibleNodeIds.has(node.id) && node.type !== 'storage').map((node) => {
    const hot = node.id === 'column-bottom-a-c19' || node.id === 'module-02-spine-bottom-a' || node.id === 'module-02-spine-bottom-b';
    return `<circle cx="${tx(node.x)}" cy="${ty(node.z)}" r="${hot ? 7 : 3.6}" fill="${hot ? '#CC6F47' : '#8F7800'}" opacity="${hot ? 0.95 : 0.55}" />`;
  }).join('\n');
  const liftBoxes = nodes.filter((node) => node.type === 'lift-blackbox').map((node) => {
    const fill = node.liftKind === 'inbound' ? '#71B436' : '#BD569B';
    return `<g>
      <rect x="${tx(node.x) - 16}" y="${ty(node.z) - 16}" width="32" height="32" fill="#B42318" opacity="0.15" rx="5" />
      <rect x="${tx(node.x) - 10}" y="${ty(node.z) - 10}" width="20" height="20" fill="${fill}" opacity="0.92" rx="4" />
      <text x="${tx(node.x) + 14}" y="${ty(node.z) + 4}" class="tiny">${escapeXml(node.id.replace('lift-', 'L'))}</text>
    </g>`;
  }).join('\n');
  const vehicleMarks = activeVehicles.map((vehicle) => {
    const point = vehicle.point!;
    const waiting = vehicle.phaseKind === 'traffic-wait' || vehicle.phaseKind === 'lift-wait';
    const fill = vehicle.shuttleId === 'SH-01' ? '#111827' : waiting ? '#CC6F47' : vehicle.kind === 'inbound' ? '#71B436' : '#BD569B';
    return `<g>
      ${waiting ? `<circle cx="${tx(point.x)}" cy="${ty(point.z)}" r="20" fill="#FFBDA1" opacity="0.32" />` : ''}
      <circle cx="${tx(point.x)}" cy="${ty(point.z)}" r="${vehicle.shuttleId === 'SH-01' ? 12 : 10}" fill="${fill}" stroke="#fff" stroke-width="2" />
      <text x="${tx(point.x)}" y="${ty(point.z) + 4}" text-anchor="middle" class="veh">${vehicle.shuttleId.replace('SH-', '')}</text>
      ${vehicle.shuttleId === 'SH-01' ? `<text x="${tx(point.x) + 14}" y="${ty(point.z) - 14}" class="label">SH-01 here</text>` : ''}
    </g>`;
  }).join('\n');
  const vehicleRows = activeVehicles
    .sort((left, right) => left.shuttleId.localeCompare(right.shuttleId) || left.taskId.localeCompare(right.taskId))
    .map((vehicle, index) => {
      const text = `${vehicle.shuttleId} ${vehicle.kind} ${vehicle.phaseKind}${vehicle.resourceId ? ` @ ${shortResource(vehicle.resourceId)}` : ''}`;
      return `<text x="${width - 292}" y="${214 + index * 24}" class="${vehicle.shuttleId === 'SH-01' ? 'sideHot' : 'side'}">${escapeXml(text)}</text>`;
    }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="nogrid" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="12" stroke="#D92D20" stroke-width="2" opacity="0.22"/>
    </pattern>
  </defs>
  <style>
    .title{font:800 27px Inter,Arial,sans-serif;fill:#1F2430}
    .sub{font:500 13px Inter,Arial,sans-serif;fill:#667085}
    .label{font:800 12px Inter,Arial,sans-serif;fill:#111827}
    .tiny{font:700 9px Inter,Arial,sans-serif;fill:#344054}
    .veh{font:900 10px Inter,Arial,sans-serif;fill:#fff}
    .legend{font:600 13px Inter,Arial,sans-serif;fill:#344054}
    .side{font:600 12px Inter,Arial,sans-serif;fill:#475467}
    .sideHot{font:900 12px Inter,Arial,sans-serif;fill:#111827}
  </style>
  <rect width="100%" height="100%" fill="#F8FAFC"/>
  <text x="42" y="42" class="title">True Feasible / No-Go Area Map</text>
  <text x="42" y="64" class="sub">Snapshot ${formatClock(snapshotSec)}. Hatched floor is not drivable; yellow graph resources are the only DES-drivable resources.</text>
  <rect x="${margin.left - 28}" y="${margin.top - 28}" width="${(bounds.maxX - bounds.minX) * scale + 56}" height="${(bounds.maxZ - bounds.minZ) * scale + 56}" fill="url(#nogrid)" stroke="#E4E7EC" rx="8"/>
  ${noGoEdgeLines}
  ${feasibleUnderlay}
  ${feasibleLines}
  ${storageNodes}
  ${yellowNodes}
  ${liftBoxes}
  ${vehicleMarks}
  <rect x="${width - 308}" y="76" width="270" height="92" fill="#fff" stroke="#E4E7EC" rx="8"/>
  <line x1="${width - 286}" y1="102" x2="${width - 238}" y2="102" stroke="#C8A900" stroke-width="5" stroke-linecap="round"/>
  <text x="${width - 226}" y="106" class="legend">可行黄线资源</text>
  <rect x="${width - 286}" y="120" width="48" height="16" fill="url(#nogrid)" stroke="#D92D20" opacity="0.9"/>
  <text x="${width - 226}" y="133" class="legend">不可行/非行驶区域</text>
  <circle cx="${width - 262}" cy="153" r="9" fill="#111827" stroke="#fff" stroke-width="2"/>
  <text x="${width - 226}" y="157" class="legend">SH-01 位置</text>
  <text x="${width - 300}" y="196" class="label">Active vehicles in this snapshot</text>
  ${vehicleRows}
</svg>`;
}

function chooseSnapshotSec(): number {
  const shuttle01Overlap = traces
    .filter((trace) => trace.shuttleId === 'SH-01')
    .flatMap((trace) => trace.phases.map((phase) => ({
      trace,
      phase,
      startSec: Math.max(phase.startSec, incident.startSec),
      endSec: Math.min(phase.endSec, incident.endSec)
    })))
    .filter((item) => item.endSec > item.startSec + 1e-9)
    .sort((left, right) => {
      const leftWait = left.phase.kind === 'traffic-wait' || left.phase.kind === 'lift-wait' ? 1 : 0;
      const rightWait = right.phase.kind === 'traffic-wait' || right.phase.kind === 'lift-wait' ? 1 : 0;
      return rightWait - leftWait || (right.endSec - right.startSec) - (left.endSec - left.startSec);
    })[0];
  if (shuttle01Overlap) {
    return (shuttle01Overlap.startSec + shuttle01Overlap.endSec) / 2;
  }
  return incident.startSec + Math.min(55, incident.waitSec / 2);
}

function isYellowGridNodeId(nodeId: string): boolean {
  return (
    /^storage-r\d+-c\d+$/.test(nodeId) ||
    /^(?:left|right)-row-\d+$/.test(nodeId) ||
    /^column-(?:(?:top|bottom)-[ab]|middle)-c\d+$/.test(nodeId) ||
    /^(?:module-\d+|module-boundary-\d+)-spine-(?:top|bottom)-[ab]$/.test(nodeId) ||
    /^(?:module-\d+|module-boundary-\d+)-spine-middle$/.test(nodeId)
  );
}

function isAxisAlignedNodePair(fromNodeId: string, toNodeId: string): boolean {
  const from = nodeById.get(fromNodeId);
  const to = nodeById.get(toNodeId);
  return Boolean(from && to && (Math.abs(from.x - to.x) < 1e-6 || Math.abs(from.z - to.z) < 1e-6));
}

function pointForPhase(trace: TaskTrace, phase: TracePhase, timeSec: number): Point {
  if (phase.kind === 'empty-travel') return interpolateRoutePoint(trace.emptyRouteNodeIds, phase, timeSec);
  if (phase.kind === 'loaded-travel') return interpolateRoutePoint(trace.loadedRouteNodeIds, phase, timeSec);
  return pointForResourceId(phase.resourceId ?? '') ??
    nodePoint(trace.dropoffNodeId) ??
    nodePoint(trace.pickupNodeId) ??
    { x: 0, z: 0 };
}

function interpolateRoutePoint(nodeIds: string[], phase: TracePhase, timeSec: number): Point {
  const points = routePoints(nodeIds);
  if (points.length === 0) return { x: 0, z: 0 };
  if (points.length === 1) return points[0]!;
  const ratio = Math.max(0, Math.min(1, (timeSec - phase.startSec) / Math.max(0.001, phase.endSec - phase.startSec)));
  const lengths = points.slice(1).map((point, index) => distance(points[index]!, point));
  const total = Math.max(0.001, lengths.reduce((sum, length) => sum + length, 0));
  let remaining = ratio * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length || index === lengths.length - 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const localRatio = Math.max(0, Math.min(1, remaining / Math.max(0.001, length)));
      return { x: from.x + (to.x - from.x) * localRatio, z: from.z + (to.z - from.z) * localRatio };
    }
    remaining -= length;
  }
  return points.at(-1)!;
}

function routePoints(nodeIds: string[]): Point[] {
  return nodeIds.flatMap((nodeId) => {
    const node = nodeById.get(nodeId);
    return node ? [{ x: node.x, z: node.z }] : [];
  });
}

function pointForResourceId(resourceId: string): Point | null {
  if (resourceId.startsWith('node:')) return nodePoint(resourceId.slice(5));
  if (resourceId.startsWith('edge:')) {
    const edge = edges.find((item) => item.id === resourceId.slice(5));
    const from = edge ? nodeById.get(edge.from) : null;
    const to = edge ? nodeById.get(edge.to) : null;
    return from && to ? { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 } : null;
  }
  return nodePoint(resourceId);
}

function nodePoint(nodeId: string): Point | null {
  const node = nodeById.get(nodeId);
  return node ? { x: node.x, z: node.z } : null;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function convertSvgToPng(svgPath: string, pngPath: string): void {
  const result = spawnSync('rsvg-convert', ['--format', 'png', '--output', pngPath, svgPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`rsvg-convert failed: ${result.stderr || result.stdout}`);
  }
}

function renderHtml(evidence: Record<string, unknown>): string {
  const rows = (evidence.activeVehicles as Array<Record<string, unknown>>).map((vehicle) => `
    <tr>
      <td>${escapeHtml(String(vehicle.shuttleId))}</td>
      <td><code>${escapeHtml(String(vehicle.taskId))}</code></td>
      <td>${escapeHtml(String(vehicle.kind))}</td>
      <td>${escapeHtml(String(vehicle.phaseKind))}</td>
      <td><code>${escapeHtml(String(vehicle.resourceId ?? ''))}</code></td>
      <td>${round(Number(vehicle.waitElapsedSec), 1)}s</td>
      <td><code>${escapeHtml(String(vehicle.storageNodeId))}</code></td>
      <td><code>${escapeHtml(String(vehicle.liftNodeId))}</code></td>
    </tr>
  `).join('');
  const counts = evidence.counts as Record<string, number>;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Feasible Area Map</title>
  <style>
    body { margin:0; background:#f7f8fb; color:#1f2430; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.5; }
    main { max-width:1180px; margin:0 auto; padding:32px 24px 56px; }
    h1 { margin:0 0 12px; font-size:clamp(30px,4vw,44px); line-height:1.05; letter-spacing:0; }
    h2 { margin:28px 0 12px; font-size:24px; letter-spacing:0; }
    section { background:#fff; border:1px solid #e2e5ea; border-radius:8px; padding:22px; margin-top:18px; }
    p { color:#344054; }
    img { width:100%; border:1px solid #e2e5ea; border-radius:8px; background:#fff; }
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:14px; }
    th,td { border-bottom:1px solid #e2e5ea; padding:9px 8px; text-align:left; vertical-align:top; }
    th { color:#667085; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:.92em; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:18px 0; }
    .metric { border:1px solid #e2e5ea; border-radius:8px; padding:13px 15px; background:#fcfcfd; }
    .metric span { display:block; color:#667085; font-size:12px; }
    .metric strong { display:block; margin-top:5px; font-size:22px; }
    @media (max-width: 820px) { main { padding:24px 14px 44px; } .metrics { grid-template-columns:1fr; } section { padding:16px; } }
  </style>
</head>
<body>
<main>
  <h1>Feasible Area Map</h1>
  <p>这张图把模型里的真正 DES 可行资源和不可行区域分开。黄色线/点是可走的 yellow-grid resource；斜线红色背景代表不可行或非行驶区域。</p>
  <section>
    <h2>Snapshot</h2>
    <div class="metrics">
      <div class="metric"><span>Time</span><strong>${escapeHtml(String(evidence.snapshotClock))}</strong></div>
      <div class="metric"><span>Feasible nodes</span><strong>${counts.feasibleNodes}</strong></div>
      <div class="metric"><span>Feasible edges</span><strong>${counts.feasibleEdges}</strong></div>
      <div class="metric"><span>Active vehicles</span><strong>${counts.activeVehicles}</strong></div>
    </div>
    <img src="charts/feasible-area-map.png" alt="true feasible and no-go area map" />
  </section>
  <section>
    <h2>Vehicle State At Snapshot</h2>
    <p>这里可以看到 SH-01 不是在不可行区域，它在这段窗口里执行 outbound 任务；原视频只是局部裁切让它看起来像藏在下边。</p>
    <table><thead><tr><th>Shuttle</th><th>Task</th><th>Kind</th><th>Phase</th><th>Resource</th><th>Wait elapsed</th><th>Storage</th><th>Lift</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
</main>
</body>
</html>`;
}

function shortResource(resourceId: string): string {
  const raw = resourceId.replace(/^(node|edge):/, '');
  const column = /^column-(top-a|top-b|middle|bottom-a|bottom-b)-c(\d+)$/.exec(raw);
  if (column) return `C${column[2]} ${column[1]}`;
  const moduleEdge = /^module-(\d+)-spine-(top-a|top-b|middle|bottom-a|bottom-b)-module-\d+-spine-(top-a|top-b|middle|bottom-a|bottom-b)$/.exec(raw);
  if (moduleEdge) return `M${moduleEdge[1]} ${moduleEdge[2]} -> ${moduleEdge[3]}`;
  return raw.replace(/-/g, ' ').slice(0, 42);
}

function formatClock(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
