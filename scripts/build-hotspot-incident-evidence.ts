import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

type WaitInterval = {
  shuttleId: string;
  taskId: string;
  reason: 'traffic-reservation-wait' | 'lift-resource-wait';
  resourceId: string | null;
  startSec: number;
  endSec: number;
  waitSec: number;
};

type Point = { x: number; z: number };

type FocusWaitStats = {
  totalWaitSec: number;
  waitCount: number;
  byResource: Array<{ resourceId: string; waitSec: number; count: number; shuttles: string[]; tasks: string[] }>;
  byKind: Array<{ kind: string; waitSec: number; count: number }>;
  byRegion: Array<{ regionIndex: number; waitSec: number; count: number }>;
};

const outputDir = resolve('output/review/hotspot-incident');
const framesDir = resolve(outputDir, 'frames');
const svgDir = resolve(outputDir, 'svg');
const videoPath = resolve(outputDir, 'module-02-hotspot-incident.mp4');
const posterPath = resolve(outputDir, 'module-02-hotspot-incident-poster.png');
const outputHtmlPath = resolve('output/review/hotspot-incident-evidence.html');
const outputJsonPath = resolve('output/review/hotspot-incident-evidence.json');

mkdirSync(outputDir, { recursive: true });
mkdirSync(dirname(outputHtmlPath), { recursive: true });
if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true });
if (existsSync(svgDir)) rmSync(svgDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
mkdirSync(svgDir, { recursive: true });

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

const traces = result.reservationReplay.tasks as TaskTrace[];
const waits = result.reservationReplay.topWaitIntervals as WaitInterval[];
const incident = waits.find((wait) => wait.resourceId === 'edge:module-02-spine-bottom-a-module-02-spine-bottom-b') ?? waits[0]!;
const windowStartSec = Math.max(0, incident.startSec - 50);
const windowEndSec = incident.endSec + 55;
const focusResources = new Set([
  'node:column-bottom-a-c19',
  'edge:module-02-spine-bottom-a-module-02-spine-bottom-b',
  'node:column-middle-c19',
  'node:column-bottom-a-c17',
  'node:column-bottom-a-c18',
  'node:column-middle-c17'
]);
const activeWindowTraces = traces.filter((trace) =>
  trace.dispatchSec <= windowEndSec && trace.completeSec >= windowStartSec
);
const nearbyWaits = waits.filter((wait) =>
  wait.startSec <= windowEndSec && wait.endSec >= windowStartSec
);
const focusedHistoricalWaits = waits
  .filter((wait) => wait.resourceId && focusResources.has(wait.resourceId))
  .slice(0, 30);
const focusWaitStats = summarizeFocusWaitStats(traces, focusResources);

const nodes = scenario.layout.nodes as LayoutNode[];
const edges = scenario.layout.edges as LayoutEdge[];
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const frameRate = 10;
const videoSeconds = 24;
const frameCount = frameRate * videoSeconds;
for (let frame = 0; frame < frameCount; frame += 1) {
  const ratio = frame / Math.max(1, frameCount - 1);
  const timeSec = windowStartSec + (windowEndSec - windowStartSec) * ratio;
  const svg = renderFrameSvg(timeSec, frame, frameCount);
  const svgPath = resolve(svgDir, `frame-${String(frame).padStart(4, '0')}.svg`);
  const pngPath = resolve(framesDir, `frame-${String(frame).padStart(4, '0')}.png`);
  writeFileSync(svgPath, svg);
  convertSvgToPng(svgPath, pngPath);
}

const posterFrame = resolve(framesDir, `frame-${String(Math.floor(frameCount * 0.44)).padStart(4, '0')}.png`);
spawnSync('cp', [posterFrame, posterPath]);
encodeVideo();

const evidence = {
  generatedAtIso: new Date().toISOString(),
  deterministicReplay: true,
  replayInputs: {
    durationSec: 24 * 3600,
    maxActiveTasks: 6,
    traceTaskLimit: 6000,
    liftTimeSec: 30,
    lowerTimeSec: 30,
    shuttles: 8,
    regions: 2,
    initialOutboundFullColumns: 4
  },
  incident,
  window: {
    startSec: round(windowStartSec, 3),
    endSec: round(windowEndSec, 3),
    videoSeconds,
    frameRate,
    frameCount
  },
  summary: {
    activeTaskTracesInWindow: activeWindowTraces.length,
    nearbyTopWaitIntervals: nearbyWaits.length,
    focusedTopWaitIntervalsIn24h: focusedHistoricalWaits.length,
    focusedFullTraceWaitSec: focusWaitStats.totalWaitSec,
    focusedFullTraceWaitCount: focusWaitStats.waitCount,
    totalPph: result.totalPph,
    averageWaitingPct: result.averageWaitingPct,
    trafficReservationWaitPct: result.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0,
    liftWaitPct: result.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0,
    routeMisses: result.routeModel.routeUnavailableCount
  },
  activeWindowTasks: activeWindowTraces.map((trace) => ({
    taskId: trace.taskId,
    shuttleId: trace.shuttleId,
    kind: trace.kind,
    regionIndex: trace.regionIndex,
    dispatchSec: trace.dispatchSec,
    completeSec: trace.completeSec,
    storageNodeId: trace.storageNodeId,
    liftNodeId: trace.liftNodeId,
    trafficWaitSec: trace.trafficWaitSec,
    liftWaitSec: trace.liftWaitSec,
    focusedPhases: trace.phases.filter((phase) => phase.resourceId && focusResources.has(phase.resourceId))
  })),
  focusWaitStats,
  focusedHistoricalWaits,
  artifacts: {
    html: outputHtmlPath,
    video: videoPath,
    poster: posterPath
  }
};
writeFileSync(outputJsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(outputHtmlPath, renderHtml(evidence));

console.log(JSON.stringify({
  type: 'hotspot-incident-evidence-complete',
  outputHtmlPath,
  outputJsonPath,
  videoPath,
  posterPath,
  incident
}, null, 2));

function renderFrameSvg(timeSec: number, frame: number, totalFrames: number): string {
  const width = 1280;
  const height = 720;
  const focus = { minX: 22.4, maxX: 33.5, minZ: 8.4, maxZ: 23.8 };
  const margin = { left: 72, right: 320, top: 76, bottom: 76 };
  const scale = Math.min((width - margin.left - margin.right) / (focus.maxX - focus.minX), (height - margin.top - margin.bottom) / (focus.maxZ - focus.minZ));
  const tx = (x: number) => margin.left + (x - focus.minX) * scale;
  const ty = (z: number) => margin.top + (z - focus.minZ) * scale;
  const visibleEdges = edges.filter((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    return from && to && pointVisible(from, focus, 0.8) && pointVisible(to, focus, 0.8);
  });
  const visibleNodes = nodes.filter((node) => pointVisible(node, focus, 0.3));
  const active = activeWindowTraces.flatMap((trace) => {
    if (trace.dispatchSec > timeSec || trace.completeSec < timeSec) return [];
    const phase = trace.phases.find((item) => item.startSec <= timeSec + 1e-9 && item.endSec >= timeSec - 1e-9) ??
      trace.phases.find((item) => item.startSec >= timeSec) ??
      trace.phases.at(-1);
    if (!phase) return [];
    const point = pointForPhase(trace, phase, timeSec);
    return [{ trace, phase, point }];
  });
  const currentWaits = active.filter((item) => item.phase.kind === 'traffic-wait' || item.phase.kind === 'lift-wait');
  const progress = frame / Math.max(1, totalFrames - 1);
  const incidentActive = timeSec >= incident.startSec && timeSec <= incident.endSec;
  const incidentPoint = pointForResourceId(incident.resourceId ?? '');

  const edgeLines = visibleEdges.map((edge) => {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    const resourceId = `edge:${edge.id}`;
    const hot = resourceId === incident.resourceId || focusResources.has(resourceId);
    return `<line x1="${tx(from.x)}" y1="${ty(from.z)}" x2="${tx(to.x)}" y2="${ty(to.z)}" stroke="${hot ? '#CC6F47' : '#D5B73F'}" stroke-width="${hot ? 8 : 2}" opacity="${hot ? 0.94 : 0.38}" stroke-linecap="round" />`;
  }).join('\n');
  const nodeMarks = visibleNodes.map((node) => {
    const hot = focusResources.has(`node:${node.id}`);
    if (node.type === 'storage') {
      return `<rect x="${tx(node.x) - 3}" y="${ty(node.z) - 3}" width="6" height="6" fill="#A3BEFA" opacity="0.45" rx="1.5"/>`;
    }
    if (node.type === 'lift-blackbox') {
      return `<rect x="${tx(node.x) - 10}" y="${ty(node.z) - 10}" width="20" height="20" fill="${node.liftKind === 'inbound' ? '#71B436' : '#BD569B'}" opacity="0.9" rx="4"/>`;
    }
    return `<circle cx="${tx(node.x)}" cy="${ty(node.z)}" r="${hot ? 8 : 3}" fill="${hot ? '#CC6F47' : '#D5B73F'}" opacity="${hot ? 0.9 : 0.38}"/>`;
  }).join('\n');
  const routeLines = active.map(({ trace }) => {
    const route = trace.kind === 'inbound' ? trace.loadedRouteNodeIds : trace.loadedRouteNodeIds;
    const points = routePoints(route).filter((point) => pointVisible(point, focus, 0.6));
    if (points.length < 2) return '';
    return `<polyline points="${points.map((point) => `${tx(point.x)},${ty(point.z)}`).join(' ')}" fill="none" stroke="${trace.kind === 'inbound' ? '#71B436' : '#BD569B'}" stroke-width="3" opacity="0.22" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('\n');
  const vehicleMarks = active.map(({ trace, phase, point }) => {
    const wait = phase.kind === 'traffic-wait' || phase.kind === 'lift-wait';
    const visible = pointVisible(point, focus, 1.1);
    if (!visible) return '';
    const fill = wait ? '#CC6F47' : trace.kind === 'inbound' ? '#71B436' : '#BD569B';
    const label = trace.shuttleId.replace('SH-', '');
    const waitElapsed = wait ? `${round(Math.max(0, timeSec - phase.startSec), 1)}s` : phase.kind.replace('-travel', '');
    return `<g>
      ${wait ? `<circle cx="${tx(point.x)}" cy="${ty(point.z)}" r="22" fill="#FFBDA1" opacity="0.28"/>` : ''}
      <circle cx="${tx(point.x)}" cy="${ty(point.z)}" r="${wait ? 12 : 9}" fill="${fill}" stroke="#1F2430" stroke-width="1.4"/>
      <text x="${tx(point.x)}" y="${ty(point.z) + 4}" text-anchor="middle" class="veh">${label}</text>
      <text x="${tx(point.x) + 15}" y="${ty(point.z) - 12}" class="vehNote">${escapeXml(waitElapsed)}</text>
    </g>`;
  }).join('\n');
  const activeRows = active
    .sort((left, right) => left.trace.shuttleId.localeCompare(right.trace.shuttleId))
    .map(({ trace, phase }) => {
      const isIncident = trace.taskId === incident.taskId;
      const phaseText = phase.kind === 'traffic-wait'
        ? `WAIT ${shortResource(phase.resourceId ?? '')}`
        : phase.kind.replace(/-/g, ' ');
      return `<text x="${width - 292}" y="${208 + Number(trace.shuttleId.slice(3)) * 25}" class="${isIncident ? 'sideHot' : 'side'}">${escapeXml(`${trace.shuttleId} ${trace.kind} ${phaseText}`)}</text>`;
    }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .title{font:700 24px Inter,Arial,sans-serif;fill:#1F2430}
    .sub{font:400 13px Inter,Arial,sans-serif;fill:#6F768A}
    .clock{font:700 20px "SF Mono",Menlo,monospace;fill:#1F2430}
    .veh{font:800 10px Inter,Arial,sans-serif;fill:#fff}
    .vehNote{font:700 10px "SF Mono",Menlo,monospace;fill:#1F2430}
    .side{font:500 12px Inter,Arial,sans-serif;fill:#464C55}
    .sideHot{font:800 12px Inter,Arial,sans-serif;fill:#804126}
    .label{font:700 12px Inter,Arial,sans-serif;fill:#1F2430}
    .small{font:500 11px Inter,Arial,sans-serif;fill:#6F768A}
  </style>
  <rect width="100%" height="100%" fill="#FCFCFD"/>
  <text x="42" y="36" class="title">Module 02 / C19 hotspot replay</text>
  <text x="42" y="58" class="sub">Deterministic DES replay around the longest wait interval. Orange vehicles are waiting on reserved yellow-grid resources.</text>
  <rect x="${margin.left - 20}" y="${margin.top - 20}" width="${(focus.maxX - focus.minX) * scale + 40}" height="${(focus.maxZ - focus.minZ) * scale + 40}" fill="#FFFFFF" stroke="#E2E5EA" rx="10"/>
  ${edgeLines}
  ${nodeMarks}
  ${routeLines}
  ${incidentPoint ? `<circle cx="${tx(incidentPoint.x)}" cy="${ty(incidentPoint.z)}" r="${incidentActive ? 28 : 20}" fill="#F0986E" opacity="${incidentActive ? 0.38 : 0.18}" stroke="#804126" stroke-width="2" stroke-dasharray="6 4"/>` : ''}
  ${vehicleMarks}
  <text x="${tx(27.5) - 18}" y="${ty(20) + 42}" class="label">C19 bottom-a</text>
  <text x="${tx(31.25) - 10}" y="${ty(20.8) + 48}" class="label">M02 bottom transfer</text>
  <rect x="42" y="${height - 52}" width="${width - 84}" height="12" fill="#E2E5EA" rx="6"/>
  <rect x="42" y="${height - 52}" width="${(width - 84) * progress}" height="12" fill="#CC6F47" rx="6"/>
  <text x="42" y="${height - 62}" class="small">${formatClock(windowStartSec)}</text>
  <text x="${width - 112}" y="${height - 62}" class="small">${formatClock(windowEndSec)}</text>
  <text x="${width - 300}" y="96" class="clock">${formatClock(timeSec)}</text>
  <text x="${width - 300}" y="124" class="sideHot">${escapeXml(incident.shuttleId)} waits ${round(incident.waitSec, 1)}s at ${shortResource(incident.resourceId ?? '')}</text>
  <text x="${width - 300}" y="150" class="side">Active traces: ${active.length} · waiting now: ${currentWaits.length}</text>
  <text x="${width - 300}" y="182" class="label">Vehicles in this window</text>
  ${activeRows}
</svg>`;
}

function pointVisible(point: Point, focus: { minX: number; maxX: number; minZ: number; maxZ: number }, pad = 0): boolean {
  return point.x >= focus.minX - pad && point.x <= focus.maxX + pad && point.z >= focus.minZ - pad && point.z <= focus.maxZ + pad;
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

function summarizeFocusWaitStats(traces: TaskTrace[], focusResourceIds: Set<string>): FocusWaitStats {
  const resourceStats = new Map<string, { waitSec: number; count: number; shuttles: Set<string>; tasks: Set<string> }>();
  const kindStats = new Map<string, { waitSec: number; count: number }>();
  const regionStats = new Map<number, { waitSec: number; count: number }>();

  let totalWaitSec = 0;
  let waitCount = 0;
  for (const trace of traces) {
    for (const phase of trace.phases) {
      if (!phase.resourceId || !focusResourceIds.has(phase.resourceId)) continue;
      if (phase.kind !== 'traffic-wait' && phase.kind !== 'lift-wait') continue;
      const waitSec = Math.max(0, phase.endSec - phase.startSec);
      totalWaitSec += waitSec;
      waitCount += 1;

      const resource = resourceStats.get(phase.resourceId) ?? {
        waitSec: 0,
        count: 0,
        shuttles: new Set<string>(),
        tasks: new Set<string>()
      };
      resource.waitSec += waitSec;
      resource.count += 1;
      resource.shuttles.add(trace.shuttleId);
      resource.tasks.add(trace.taskId);
      resourceStats.set(phase.resourceId, resource);

      const kind = kindStats.get(phase.kind) ?? { waitSec: 0, count: 0 };
      kind.waitSec += waitSec;
      kind.count += 1;
      kindStats.set(phase.kind, kind);

      const region = regionStats.get(trace.regionIndex) ?? { waitSec: 0, count: 0 };
      region.waitSec += waitSec;
      region.count += 1;
      regionStats.set(trace.regionIndex, region);
    }
  }

  return {
    totalWaitSec: round(totalWaitSec, 3),
    waitCount,
    byResource: Array.from(resourceStats.entries())
      .map(([resourceId, stat]) => ({
        resourceId,
        waitSec: round(stat.waitSec, 3),
        count: stat.count,
        shuttles: Array.from(stat.shuttles).sort(),
        tasks: Array.from(stat.tasks).sort().slice(0, 12)
      }))
      .sort((left, right) => right.waitSec - left.waitSec),
    byKind: Array.from(kindStats.entries())
      .map(([kind, stat]) => ({ kind, waitSec: round(stat.waitSec, 3), count: stat.count }))
      .sort((left, right) => right.waitSec - left.waitSec),
    byRegion: Array.from(regionStats.entries())
      .map(([regionIndex, stat]) => ({ regionIndex, waitSec: round(stat.waitSec, 3), count: stat.count }))
      .sort((left, right) => right.waitSec - left.waitSec)
  };
}

function convertSvgToPng(svgPath: string, pngPath: string): void {
  const result = spawnSync('rsvg-convert', ['--format', 'png', '--output', pngPath, svgPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`rsvg-convert failed: ${result.stderr || result.stdout}`);
  }
}

function encodeVideo(): void {
  const result = spawnSync('ffmpeg', [
    '-y',
    '-framerate', String(frameRate),
    '-i', resolve(framesDir, 'frame-%04d.png'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    videoPath
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr || result.stdout}`);
  }
}

function renderHtml(evidence: Record<string, unknown>): string {
  const summary = evidence.summary as Record<string, number>;
  const incidentRow = evidence.incident as WaitInterval;
  const activeTasks = evidence.activeWindowTasks as Array<Record<string, unknown>>;
  const focusedWaits = evidence.focusedHistoricalWaits as WaitInterval[];
  const focusStats = evidence.focusWaitStats as FocusWaitStats;
  const taskRows = activeTasks.map((task) => `
    <tr>
      <td><code>${escapeHtml(String(task.taskId))}</code></td>
      <td>${escapeHtml(String(task.shuttleId))}</td>
      <td>${escapeHtml(String(task.kind))}</td>
      <td>${escapeHtml(String(task.storageNodeId))}</td>
      <td>${escapeHtml(String(task.liftNodeId))}</td>
      <td>${round(Number(task.trafficWaitSec), 1)}s</td>
      <td>${Array.isArray(task.focusedPhases) ? task.focusedPhases.length : 0}</td>
    </tr>
  `).join('');
  const waitRows = focusedWaits.slice(0, 16).map((wait) => `
    <tr>
      <td>${formatClock(wait.startSec)}</td>
      <td>${escapeHtml(wait.shuttleId)}</td>
      <td><code>${escapeHtml(wait.taskId)}</code></td>
      <td>${round(wait.waitSec, 1)}s</td>
      <td><code>${escapeHtml(wait.resourceId ?? '')}</code></td>
    </tr>
  `).join('');
  const focusResourceRows = focusStats.byResource.map((row) => `
    <tr>
      <td><code>${escapeHtml(row.resourceId)}</code><br><span class="muted">${escapeHtml(shortResource(row.resourceId))}</span></td>
      <td>${round(row.waitSec / 60, 2)} min</td>
      <td>${row.count}</td>
      <td>${escapeHtml(row.shuttles.join(', '))}</td>
      <td>${escapeHtml(row.tasks.slice(0, 5).join(', '))}</td>
    </tr>
  `).join('');
  const focusRegionRows = focusStats.byRegion.map((row) => `
    <tr>
      <td>Region ${row.regionIndex}</td>
      <td>${round(row.waitSec / 60, 2)} min</td>
      <td>${row.count}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hotspot Incident Evidence</title>
  <style>
    body { margin:0; background:#f7f8fb; color:#1f2430; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.5; }
    main { max-width:1180px; margin:0 auto; padding:32px 24px 56px; }
    h1 { margin:0 0 12px; font-size:clamp(30px,4vw,44px); line-height:1.05; letter-spacing:0; }
    h2 { margin:32px 0 12px; font-size:24px; letter-spacing:0; }
    p { color:#344054; }
    section { background:#fff; border:1px solid #e2e5ea; border-radius:8px; padding:22px; margin-top:18px; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:18px 0; }
    .metric { border:1px solid #e2e5ea; border-radius:8px; padding:13px 15px; background:#fcfcfd; }
    .metric span { display:block; color:#667085; font-size:12px; }
    .metric strong { display:block; margin-top:5px; font-size:22px; }
    video { width:100%; border:1px solid #e2e5ea; border-radius:8px; background:#fcfcfd; }
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:14px; }
    th,td { border-bottom:1px solid #e2e5ea; padding:9px 8px; text-align:left; vertical-align:top; }
    th { color:#667085; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:.92em; }
    .muted { color:#667085; font-size:12px; }
    .callout { border-left:4px solid #cc6f47; padding:10px 14px; background:#fff7f2; border-radius:0 8px 8px 0; }
    @media (max-width: 820px) { main { padding:24px 14px 44px; } .metrics { grid-template-columns:1fr; } section { padding:16px; } }
  </style>
</head>
<body>
<main>
  <h1>Hotspot Incident Evidence</h1>
  <p>这页复现 24h DES 中最长的 module 02 下侧等待窗口，用全量 deterministic trace 生成视频证据。</p>
  <section>
    <h2>Executive Summary</h2>
    <div class="metrics">
      <div class="metric"><span>Incident</span><strong>${escapeHtml(shortResource(incidentRow.resourceId ?? ''))}</strong></div>
      <div class="metric"><span>Wait</span><strong>${round(incidentRow.waitSec, 1)}s</strong></div>
      <div class="metric"><span>Time</span><strong>${formatClock(incidentRow.startSec)}</strong></div>
      <div class="metric"><span>Vehicle</span><strong>${escapeHtml(incidentRow.shuttleId)}</strong></div>
    </div>
    <p class="callout">这里的异常不是越界或斜线行驶。异常是性能/调度行为：车辆在合法黄线资源 <code>${escapeHtml(incidentRow.resourceId ?? '')}</code> 前长时间等待，说明同一片 single-capacity yellow-grid resource 被任务流反复争用。</p>
  </section>
  <section>
    <h2>Replay Video</h2>
    <video controls preload="metadata" poster="hotspot-incident/module-02-hotspot-incident-poster.png">
      <source src="hotspot-incident/module-02-hotspot-incident.mp4" type="video/mp4" />
    </video>
    <p>橙色车辆表示当前正在等 reservation。右侧列表里加粗/棕色的是 incident vehicle。时间轴覆盖 ${formatClock((evidence.window as Record<string, number>).startSec)} 到 ${formatClock((evidence.window as Record<string, number>).endSec)}。</p>
  </section>
  <section>
    <h2>Evidence: Why the lower-right module dominates</h2>
    <ul>
      <li><strong>它不是全仓库随机拥堵。</strong> 全量 top wait intervals 中，focus resource 反复出现，尤其是 <code>column-bottom-a-c19</code> 和 <code>module-02-spine-bottom-a-module-02-spine-bottom-b</code>。</li>
      <li><strong>它不是 lift 硬瓶颈。</strong> 当前 run 的 lift wait 约 ${round(summary.liftWaitPct, 3)}%，traffic reservation wait 约 ${round(summary.trafficReservationWaitPct, 3)}%。</li>
      <li><strong>行为模式像入口/转接点被多任务挤压。</strong> C17-C19 是列入口，module-02 bottom-a/b 是下侧转接边。车辆从 storage column 出来、横向经过 bottom-a、再转 bottom-b 时，会争用同一组 reservation window。</li>
    </ul>
    <div class="metrics">
      <div class="metric"><span>Focused-resource wait</span><strong>${round(summary.focusedFullTraceWaitSec / 60, 2)} min</strong></div>
      <div class="metric"><span>Focused wait events</span><strong>${summary.focusedFullTraceWaitCount}</strong></div>
      <div class="metric"><span>Top wait type</span><strong>${escapeHtml(focusStats.byKind[0]?.kind ?? 'n/a')}</strong></div>
      <div class="metric"><span>Top region</span><strong>${focusStats.byRegion[0] ? `R${focusStats.byRegion[0].regionIndex}` : 'n/a'}</strong></div>
    </div>
  </section>
  <section>
    <h2>Full-Trace Focus Resource Breakdown</h2>
    <p>这张表用全量 task trace 重新统计，不只看 top wait list。它回答的是：右下模块那几个具体 node/edge 在 24h 内到底累计等了多少。</p>
    <table><thead><tr><th>Resource</th><th>Total wait</th><th>Events</th><th>Shuttles</th><th>Sample tasks</th></tr></thead><tbody>${focusResourceRows}</tbody></table>
    <table><thead><tr><th>Region</th><th>Total wait</th><th>Events</th></tr></thead><tbody>${focusRegionRows}</tbody></table>
  </section>
  <section>
    <h2>Tasks Active In The Video Window</h2>
    <table><thead><tr><th>Task</th><th>Shuttle</th><th>Kind</th><th>Storage</th><th>Lift</th><th>Traffic wait</th><th>Focused phases</th></tr></thead><tbody>${taskRows}</tbody></table>
  </section>
  <section>
    <h2>Repeated Focus-Resource Wait Evidence</h2>
    <table><thead><tr><th>Time</th><th>Shuttle</th><th>Task</th><th>Wait</th><th>Resource</th></tr></thead><tbody>${waitRows}</tbody></table>
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
