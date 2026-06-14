import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  createInboundOutboundDemoScenario,
  hashScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

type Point = { x: number; z: number };
type LiftRole = 'inbound' | 'outbound';
type LiftDisplayRailLevel = 'top-a' | 'top-b' | 'bottom-a' | 'bottom-b';
type Anomaly = {
  timeSec: number;
  vehicleId: string | null;
  code: string;
  severity: 'warn' | 'critical';
  detail: string;
};
type DisplayTrace = {
  lastPoint: Point | null;
  lastNodeId: string | null;
  lastEdgeId: string | null;
  lastMove: { timeSec: number; axis: 'x' | 'z'; sign: -1 | 1; magnitude: number } | null;
  liftWorkcellChanges: Array<{ timeSec: number; nodeId: string }>;
};

const durationSec = numberArg('--duration-sec', 3600);
const sampleSec = numberArg('--sample-sec', 60);
const dtSec = numberArg('--dt-sec', 0.2);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const outputPath = resolve(stringArg('--out') ?? `output/shuttle/lift-visual-audit-${Date.now()}.json`);
const maxAnomalies = integerArg('--max-anomalies', 200);
const stopOnCritical = process.argv.includes('--stop-on-critical');

mkdirSync(dirname(outputPath), { recursive: true });

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
const nodeMap = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
const edgeKeys = new Set(scenario.layout.edges.flatMap((edge) => [
  edgeKey(edge.from, edge.to),
  ...(edge.directionMode === 'twoWay' ? [edgeKey(edge.to, edge.from)] : [])
]));
const liftDocks = createLiftDockPoints();
const noDriveRects = createLiftNoDriveRects();
const traces = new Map<string, DisplayTrace>();
const anomalies: Anomaly[] = [];
const samples: Array<{
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  waitingVehicles: number;
  anomalies: number;
}> = [];
let nextSampleSec = 0;

sim.start();
for (let elapsedSec = 0; elapsedSec < durationSec - 1e-9 && sim.getClock().status === 'running'; elapsedSec += dtSec) {
  const state = sim.step(Math.min(dtSec, durationSec - elapsedSec));
  auditState(state);
  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    samples.push({
      timeSec: round(state.simTimeSec),
      completedInbound: state.kpis.completedInbound,
      completedOutbound: state.kpis.completedOutbound,
      totalPph: round(state.kpis.totalPph, 3),
      waitingVehicles: state.traffic.waitingVehicles.length,
      anomalies: anomalies.length
    });
    console.log(JSON.stringify({ type: 'lift-visual-sample', ...samples[samples.length - 1] }));
    nextSampleSec += sampleSec;
  }
  if (stopOnCritical && anomalies.some((anomaly) => anomaly.severity === 'critical')) {
    break;
  }
}

const finalState = sim.getState();
const report = {
  schemaVersion: 'shuttle.liftVisualAudit.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  status: finalState.status,
  rules: [
    'displayed vehicle centers must not enter lift no-drive rectangles except at that lift dock point',
    'displayed vehicle movement in lift projected areas must be axis-aligned on the grid',
    'displayed lift workcell service/queue nodes must project onto feasible grid queue points',
    'displayed lift-area movement must not reverse direction within 8 seconds',
    'displayed planned/local route segments must be axis-aligned',
    'displayed route segments must not pass through lift no-drive rectangles except at dock points',
    'vehicles must not visibly bounce among lift workcell nodes more than 6 changes in 20 seconds'
  ],
  summary: {
    completedInbound: finalState.kpis.completedInbound,
    completedOutbound: finalState.kpis.completedOutbound,
    totalPph: finalState.kpis.totalPph,
    deadlocks: finalState.kpis.deadlockCount,
    livelocks: finalState.kpis.livelockCount,
    physicalViolations: finalState.traffic.physicalViolationCount,
    anomalyCounts: countAnomalies(anomalies)
  },
  samples,
  anomalies: anomalies.slice(0, maxAnomalies)
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ type: 'lift-visual-complete', outputPath, anomalies: anomalies.length }, null, 2));

if (anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function auditState(state: ShuttleSimState): void {
  for (const vehicle of state.vehicles) {
    const displayPoint = displayPointForVehicle(vehicle);
    auditVehicleDisplayPoint(state.simTimeSec, vehicle, displayPoint);
    auditVehicleDisplayMovement(state.simTimeSec, vehicle, displayPoint);
    auditVehicleRoutes(state.simTimeSec, vehicle);
    auditLiftWorkcellJitter(state.simTimeSec, vehicle);
  }
}

function auditVehicleDisplayPoint(timeSec: number, vehicle: VehicleState, point: Point): void {
  const rect = noDriveRects.find((candidate) => pointInsideRect(point, candidate));
  if (!rect) {
    return;
  }
  const dock = liftDocks.get(rect.liftNodeId);
  if (dock && distance(point, dock) <= 0.08) {
    return;
  }
  addAnomaly(timeSec, vehicle.id, 'vehicle-display-inside-lift-no-drive', 'critical', `${vehicle.id} display=(${round(point.x)},${round(point.z)}) rect=${rect.id} node=${vehicle.currentNodeId}`);
}

function auditVehicleDisplayMovement(timeSec: number, vehicle: VehicleState, point: Point): void {
  const trace = traces.get(vehicle.id) ?? { lastPoint: null, lastNodeId: null, lastEdgeId: null, lastMove: null, liftWorkcellChanges: [] };
  if (trace.lastPoint) {
    const dx = Math.abs(point.x - trace.lastPoint.x);
    const dz = Math.abs(point.z - trace.lastPoint.z);
    const nearLift = isLiftDisplayProjectedNode(vehicle.currentNodeId) || (vehicle.targetNodeId && isLiftDisplayProjectedNode(vehicle.targetNodeId));
    if (trace.lastEdgeId === vehicle.currentEdgeId && dx > 0.09 && dz > 0.09 && nearLift) {
      if (!displayStepFollowsSameOrthogonalEdgePath(vehicle, trace.lastPoint, point)) {
        addAnomaly(timeSec, vehicle.id, 'vehicle-display-diagonal-step-near-lift', 'critical', `${vehicle.id} edge=${vehicle.currentEdgeId ?? '?'} current=${vehicle.currentNodeId} target=${vehicle.targetNodeId ?? '?'} moved display (${round(trace.lastPoint.x)},${round(trace.lastPoint.z)}) -> (${round(point.x)},${round(point.z)})`);
      }
    }
    if (nearLift && (dx > 0.18 || dz > 0.18)) {
      const axis = dx >= dz ? 'x' : 'z';
      const delta = axis === 'x' ? point.x - trace.lastPoint.x : point.z - trace.lastPoint.z;
      const sign = delta < 0 ? -1 : 1;
      if (
        trace.lastMove &&
        trace.lastMove.axis === axis &&
        trace.lastMove.sign !== sign &&
        trace.lastMove.magnitude > 0.18 &&
        timeSec - trace.lastMove.timeSec <= 8
      ) {
        addAnomaly(timeSec, vehicle.id, 'vehicle-display-turnback-near-lift', 'warn', `${vehicle.id} reversed ${axis} near lift within ${round(timeSec - trace.lastMove.timeSec, 3)}s: ${vehicle.currentNodeId}->${vehicle.targetNodeId ?? '?'}`);
      }
      trace.lastMove = { timeSec, axis, sign, magnitude: axis === 'x' ? dx : dz };
    }
    if (trace.lastEdgeId !== vehicle.currentEdgeId && nearLift && distance(trace.lastPoint, point) > 1.2) {
      addAnomaly(timeSec, vehicle.id, 'vehicle-display-large-snap-near-lift', 'warn', `${vehicle.id} snapped display (${round(trace.lastPoint.x)},${round(trace.lastPoint.z)}) -> (${round(point.x)},${round(point.z)}) edge ${trace.lastEdgeId ?? '?'} -> ${vehicle.currentEdgeId ?? '?'}`);
    }
  }
  trace.lastPoint = point;
  trace.lastEdgeId = vehicle.currentEdgeId;
  traces.set(vehicle.id, trace);
}

function auditVehicleRoutes(timeSec: number, vehicle: VehicleState): void {
  for (const [kind, nodeIds] of [
    ['planned', remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds)],
    ['local', remainingRouteNodeIds(vehicle, vehicle.routeNodeIds)]
  ] as const) {
    for (const segment of routeRenderSegments(vehicle, nodeIds)) {
      if (!isAxisAligned(segment.from, segment.to)) {
        addAnomaly(timeSec, vehicle.id, `route-display-diagonal-segment:${kind}`, 'critical', `${vehicle.id} ${kind} ${segment.fromNodeId}->${segment.toNodeId}`);
      }
      const rect = noDriveRects.find((candidate) => segmentIntersectsRectInterior(segment.from, segment.to, candidate));
      if (rect) {
        addAnomaly(timeSec, vehicle.id, `route-display-enters-lift-no-drive:${kind}`, 'critical', `${vehicle.id} ${kind} ${segment.fromNodeId}->${segment.toNodeId} rect=${rect.id}`);
      }
    }
  }
}

function auditLiftWorkcellJitter(timeSec: number, vehicle: VehicleState): void {
  const trace = traces.get(vehicle.id) ?? { lastPoint: null, lastNodeId: null, lastEdgeId: null, lastMove: null, liftWorkcellChanges: [] };
  if (trace.lastNodeId !== vehicle.currentNodeId && liftWorkcellKeyParts(vehicle.currentNodeId)) {
    trace.liftWorkcellChanges.push({ timeSec, nodeId: vehicle.currentNodeId });
    trace.liftWorkcellChanges = trace.liftWorkcellChanges.filter((entry) => timeSec - entry.timeSec <= 20);
    if (trace.liftWorkcellChanges.length > 6) {
      addAnomaly(timeSec, vehicle.id, 'vehicle-lift-workcell-jitter', 'warn', `${vehicle.id} changed lift workcell nodes ${trace.liftWorkcellChanges.length} times in 20s: ${trace.liftWorkcellChanges.map((entry) => entry.nodeId).join(' > ')}`);
      trace.liftWorkcellChanges = trace.liftWorkcellChanges.slice(-2);
    }
  }
  trace.lastNodeId = vehicle.currentNodeId;
  traces.set(vehicle.id, trace);
}

function displayPointForVehicle(vehicle: VehicleState): Point {
  const routeNodeIds = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
  const fallbackRouteNodeIds = routeNodeIds.length >= 2 ? routeNodeIds : remainingRouteNodeIds(vehicle, vehicle.routeNodeIds);
  const displayLevels = liftDisplayLevelsForRoute(fallbackRouteNodeIds);
  return routeDisplayPointForVehicle(vehicle, displayLevels[0] ?? null, displayLevels[1] ?? null);
}

function routeDisplayPointForVehicle(
  vehicle: VehicleState,
  currentPreferredLevel: LiftDisplayRailLevel | null = null,
  targetPreferredLevel: LiftDisplayRailLevel | null = null
): Point {
  const rawPoint = { x: vehicle.x, z: vehicle.z };
  const currentNode = nodeMap.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? nodeMap.get(vehicle.targetNodeId) : null;
  if (vehicle.currentEdgeId && currentNode && targetNode && (isLiftDisplayProjectedNode(currentNode.id) || isLiftDisplayProjectedNode(targetNode.id))) {
    const dx = targetNode.x - currentNode.x;
    const dz = targetNode.z - currentNode.z;
    const lengthSq = dx * dx + dz * dz;
    const progress = lengthSq <= 1e-9 ? 0 : clamp(((rawPoint.x - currentNode.x) * dx + (rawPoint.z - currentNode.z) * dz) / lengthSq, 0, 1);
    const edgePreferredLevel = nearestDisplayRailLevelToPoint(rawPoint);
    return pointOnOrthogonalDisplayPath(
      displayPointForNode(currentNode.id, currentNode, currentPreferredLevel ?? edgePreferredLevel),
      displayPointForNode(targetNode.id, targetNode, targetPreferredLevel ?? edgePreferredLevel),
      progress,
      preferredOrthogonalAxis(currentNode, targetNode)
    );
  }
  if (!vehicle.currentEdgeId && currentNode) {
    return displayPointForNode(currentNode.id, currentNode, currentPreferredLevel);
  }
  return displayPointForNode(vehicle.currentNodeId, rawPoint, currentPreferredLevel);
}

function displayPointForNode(
  nodeId: string,
  fallback: Point,
  preferredLevel: LiftDisplayRailLevel | null = null
): Point {
  const dock = liftNoDriveDisplayDockPoint(nodeId, preferredLevel);
  if (dock) {
    return dock;
  }
  if (!isLiftRouteDisplaySnapNode(nodeId)) {
    return fallback;
  }
  let nearest: Point | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodeMap.values()) {
    if (preferredLevel ? !isLiftDisplayRailLevelNode(node.id, preferredLevel) : !liftDisplayRailLevel(node.id)) {
      continue;
    }
    const candidate = { x: node.x, z: node.z };
    const candidateDistance = distance(candidate, fallback);
    if (candidateDistance < nearestDistance) {
      nearest = candidate;
      nearestDistance = candidateDistance;
    }
  }
  return nearest ?? fallback;
}

function routeRenderStartPoint(vehicle: VehicleState): Point {
  const currentNode = nodeMap.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? nodeMap.get(vehicle.targetNodeId) : null;
  if (vehicle.currentEdgeId && currentNode && targetNode) {
    return snapPointToAxisAlignedLeg(vehicle, currentNode, targetNode);
  }
  return currentNode ? { x: currentNode.x, z: currentNode.z } : { x: vehicle.x, z: vehicle.z };
}

function routeRenderSegments(vehicle: VehicleState, nodeIds: string[]): Array<{ from: Point; to: Point; fromNodeId: string; toNodeId: string }> {
  if (nodeIds.length < 2) {
    return [];
  }
  const displayLevels = liftDisplayLevelsForRoute(nodeIds);
  const segments: Array<{ from: Point; to: Point; fromNodeId: string; toNodeId: string }> = [];
  let fromNodeId = nodeIds[0]!;
  let graphFromPoint = routeRenderStartPoint(vehicle);
  let activeDisplayLevel = displayLevels[0] ?? displayLevels[1] ?? nearestDisplayRailLevelToPoint(graphFromPoint);
  let displayFromPoint = routeDisplayPointForVehicle(vehicle, displayLevels[0] ?? null, displayLevels[1] ?? null);
  for (let index = 1; index < nodeIds.length; index += 1) {
    const toNodeId = nodeIds[index]!;
    const toNode = nodeMap.get(toNodeId);
    if (!toNode) {
      fromNodeId = toNodeId;
      continue;
    }
    const graphToPoint = { x: toNode.x, z: toNode.z };
    const targetDisplayLevel = displayLevels[index] ?? activeDisplayLevel ?? nearestDisplayRailLevelToPoint(graphFromPoint);
    const displayToPoint = displayPointForNode(toNodeId, graphToPoint, targetDisplayLevel);
    if (edgeKeys.has(edgeKey(fromNodeId, toNodeId)) && isAxisAligned(graphFromPoint, graphToPoint)) {
      for (const segment of orthogonalDisplaySegments(displayFromPoint, displayToPoint, preferredOrthogonalAxis(graphFromPoint, graphToPoint))) {
        segments.push({ ...segment, fromNodeId, toNodeId });
      }
    }
    fromNodeId = toNodeId;
    graphFromPoint = graphToPoint;
    displayFromPoint = displayToPoint;
    activeDisplayLevel = targetDisplayLevel;
  }
  return segments;
}

function createLiftDockPoints(): Map<string, Point> {
  const docks = new Map<string, Point>();
  for (const node of scenario.layout.nodes) {
    if (node.type !== 'lift-blackbox' || (node.liftKind !== 'inbound' && node.liftKind !== 'outbound')) {
      continue;
    }
    const dock = liftFeasibleGridDockPoint(node.id, node.liftKind);
    if (dock) {
      docks.set(node.id, dock);
    }
  }
  return docks;
}

function createLiftNoDriveRects(): Array<{ id: string; liftNodeId: string; role: LiftRole; minX: number; maxX: number; minZ: number; maxZ: number }> {
  const byLift = new Map<string, { liftNodeId: string; role: LiftRole; nodes: Point[] }>();
  for (const node of scenario.layout.nodes) {
    const parts = liftWorkcellKeyParts(node.id);
    if (!parts || !isLiftNoDriveRectNode(node.id)) {
      continue;
    }
    const dock = liftDocks.get(parts.liftNodeId);
    if (dock && distance(dock, node) <= 0.08) {
      continue;
    }
    const entry = byLift.get(parts.liftNodeId) ?? { liftNodeId: parts.liftNodeId, role: parts.role, nodes: [] };
    entry.nodes.push({ x: node.x, z: node.z });
    byLift.set(parts.liftNodeId, entry);
  }
  const padX = 0.34;
  const padZ = 0.08;
  return [...byLift.values()].flatMap((entry) => entry.nodes.map((node, index) => ({
    id: `${entry.liftNodeId}-no-drive-${index + 1}`,
    liftNodeId: entry.liftNodeId,
    role: entry.role,
    minX: node.x - padX,
    maxX: node.x + padX,
    minZ: node.z - padZ,
    maxZ: node.z + padZ
  })));
}

function liftNoDriveDisplayDockPoint(
  nodeId: string,
  preferredLevel: LiftDisplayRailLevel | null = null
): Point | null {
  if (!isLiftNoDriveDisplaySnapNode(nodeId)) {
    return null;
  }
  const parts = liftWorkcellKeyParts(nodeId);
  if (!parts) {
    return null;
  }
  const gridDockPoint = liftNoDriveDisplayPointForNode(nodeId, parts.liftNodeId, parts.role, preferredLevel);
  if (gridDockPoint) {
    return gridDockPoint;
  }
  const dockNode = nodeMap.get(`${parts.liftNodeId}-queue-01-entry-access`) ??
    nodeMap.get(`${parts.liftNodeId}-queue-access`) ??
    nodeMap.get(`${parts.liftNodeId}-queue-01-access`) ??
    nodeMap.get(`${parts.liftNodeId}-queue-01-service-exit`);
  return dockNode ? { x: dockNode.x, z: dockNode.z } : null;
}

function liftDockDisplayRailLevel(role: LiftRole): LiftDisplayRailLevel {
  return role === 'inbound' ? 'top-a' : 'bottom-b';
}

function liftWorkcellQueueIndex(nodeId: string): number | null {
  const match = /-queue-(\d{2})(?:-|$)/.exec(nodeId);
  return match ? Number(match[1]) : null;
}

function railColumnIndex(nodeId: string): number | null {
  const match = /^column-(?:top|bottom)-[ab]-c(\d+)$/.exec(nodeId);
  return match ? Number(match[1]) : null;
}

function findRailNodeAtColumn(level: LiftDisplayRailLevel, columnIndex: number): ShuttleScenario['layout']['nodes'][number] | null {
  return nodeMap.get(`column-${level}-c${String(columnIndex).padStart(2, '0')}`) ?? null;
}

function findRailNodeAtOffset(
  level: LiftDisplayRailLevel,
  anchor: Point,
  direction: -1 | 1,
  offset: number
): ShuttleScenario['layout']['nodes'][number] | null {
  if (offset <= 0) {
    return null;
  }
  const candidates = [...nodeMap.values()]
    .filter((node) => new RegExp(`^column-${level}-c\\d+$`).test(node.id))
    .filter((node) => (node.x - anchor.x) * direction > 1e-6)
    .sort((left, right) => (left.x - anchor.x) * direction - (right.x - anchor.x) * direction);
  return candidates[offset - 1] ?? candidates.at(-1) ?? null;
}

function nearestRailNodeToPoint(level: LiftDisplayRailLevel, point: Point): ShuttleScenario['layout']['nodes'][number] | null {
  let nearest: ShuttleScenario['layout']['nodes'][number] | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodeMap.values()) {
    if (!isLiftDisplayRailLevelNode(node.id, level)) {
      continue;
    }
    const candidateDistance = distance(node, point);
    if (candidateDistance < nearestDistance) {
      nearest = node;
      nearestDistance = candidateDistance;
    }
  }
  return nearest;
}

function nearestDisplayRailLevelToPoint(point: Point): LiftDisplayRailLevel | null {
  let nearestLevel: LiftDisplayRailLevel | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodeMap.values()) {
    const level = liftDisplayRailLevel(node.id);
    if (!level) {
      continue;
    }
    const candidateDistance = distance(node, point);
    if (candidateDistance < nearestDistance) {
      nearestLevel = level;
      nearestDistance = candidateDistance;
    }
  }
  return nearestLevel;
}

function defaultLiftNoDriveDisplayRailLevelForNode(nodeId: string, role: LiftRole): LiftDisplayRailLevel {
  if (/-queue(?:-\d{2})?(?:$|-access|-entry-access)$/.test(nodeId) || /^parking-lift-\d{2}-(?:inbound|outbound)-queue/.test(nodeId)) {
    return role === 'inbound' ? 'top-b' : 'bottom-b';
  }
  return liftDockDisplayRailLevel(role);
}

function liftQueueDisplayDirection(liftNodeId: string): -1 | 1 {
  const serviceNode = nodeMap.get(`${liftNodeId}-queue-01-service-exit`);
  const entryNode = nodeMap.get(`${liftNodeId}-queue-01-entry-access`) ?? nodeMap.get(`${liftNodeId}-queue-access`);
  if (serviceNode && entryNode && Math.abs(entryNode.x - serviceNode.x) > 1e-6) {
    return entryNode.x > serviceNode.x ? 1 : -1;
  }
  return 1;
}

function liftGridDockNodeId(liftNodeId: string, role: LiftRole): string | null {
  const anchorNode = liftGridDockAnchorNode(liftNodeId, role);
  if (!anchorNode) {
    return null;
  }
  return nearestRailNodeToPoint(liftDockDisplayRailLevel(role), anchorNode)?.id ?? null;
}

function liftGridDockAnchorNode(liftNodeId: string, role: LiftRole): ShuttleScenario['layout']['nodes'][number] | null {
  const candidateIds = role === 'inbound'
    ? [
        liftNodeId,
        `${liftNodeId}-buffer-access`,
        `${liftNodeId}-queue-01-service-exit`,
        `${liftNodeId}-queue-access`,
        `${liftNodeId}-queue-01-access`,
      ]
    : [
        liftNodeId,
        `${liftNodeId}-queue-01-service-exit`,
        `${liftNodeId}-buffer-access`,
        `${liftNodeId}-queue-01-entry-access`,
        `${liftNodeId}-queue-access`
      ];
  for (const candidateId of candidateIds) {
    const node = nodeMap.get(candidateId);
    if (node) {
      return node;
    }
  }
  return null;
}

function liftFeasibleGridDockPoint(liftNodeId: string, role: LiftRole): Point | null {
  const anchorNode = liftGridDockAnchorNode(liftNodeId, role);
  if (!anchorNode) {
    return null;
  }
  const nearest = nearestRailNodeToPoint(liftDockDisplayRailLevel(role), anchorNode);
  return nearest ? { x: nearest.x, z: nearest.z } : { x: anchorNode.x, z: anchorNode.z };
}

function liftNoDriveDisplayPointForNode(
  nodeId: string,
  liftNodeId: string,
  role: LiftRole,
  preferredLevel: LiftDisplayRailLevel | null = null
): Point | null {
  const displaysAtDock = /^lift-\d{2}-(?:inbound|outbound)(?:$|-throat|-buffer-access|-buffer-\d{2}|-queue-\d{2}-service-exit)$/.test(nodeId);
  if (displaysAtDock && (preferredLevel === null || preferredLevel === liftDockDisplayRailLevel(role))) {
    return liftFeasibleGridDockPoint(liftNodeId, role);
  }
  const level = preferredLevel ?? defaultLiftNoDriveDisplayRailLevelForNode(nodeId, role);
  const queuePoint = liftQueueDisplayRailPoint(nodeId, liftNodeId, level, role);
  if (queuePoint) {
    return queuePoint;
  }
  const node = nodeMap.get(nodeId);
  const nearest = node ? nearestRailNodeToPoint(level, node) : null;
  return nearest ? { x: nearest.x, z: nearest.z } : liftFeasibleGridDockPoint(liftNodeId, role);
}

function liftQueueDisplayRailPoint(
  nodeId: string,
  liftNodeId: string,
  level: LiftDisplayRailLevel,
  role: LiftRole
): Point | null {
  const dockNodeId = liftGridDockNodeId(liftNodeId, role);
  const dockNode = dockNodeId ? nodeMap.get(dockNodeId) : null;
  if (!dockNode) {
    return null;
  }
  const queueAccess = new RegExp(`^${liftNodeId}-queue(?:-(\\d{2}))?-access$`).exec(nodeId);
  const queueEntry = new RegExp(`^${liftNodeId}-queue-(\\d{2})-entry-access$`).exec(nodeId);
  const queueParking = new RegExp(`^parking-${liftNodeId}-queue(?:-(\\d{2}))?$`).exec(nodeId);
  let offset: number | null = null;
  if (queueEntry) {
    offset = Number(queueEntry[1]);
  } else if (queueAccess) {
    offset = Math.max(1, queueAccess[1] ? Number(queueAccess[1]) : 0);
  } else if (queueParking) {
    offset = (queueParking[1] ? Number(queueParking[1]) : 1) + 1;
  }
  if (offset === null) {
    return null;
  }
  const node = findRailNodeAtOffset(level, dockNode, liftQueueDisplayDirection(liftNodeId), offset);
  return node ? { x: node.x, z: node.z } : null;
}

function liftWorkcellKeyParts(nodeId: string): { liftNodeId: string; role: LiftRole } | null {
  const match = /^(?:lift|parking-lift)-(\d{2})-(inbound|outbound)(?:$|-)/.exec(nodeId);
  return match ? { liftNodeId: `lift-${match[1]}-${match[2] as LiftRole}`, role: match[2] as LiftRole } : null;
}

function isLiftRouteDisplaySnapNode(nodeId: string): boolean {
  return false;
}

function isLiftNoDriveDisplaySnapNode(nodeId: string): boolean {
  return /^(?:lift|parking-lift)-\d{2}-(?:inbound|outbound)(?:$|-throat|-buffer-access|-buffer-\d{2}|-queue(?:-\d{2})?|-queue-access|-queue-\d{2}-(?:access|entry-access|service-exit))$/.test(nodeId);
}

function isLiftNoDriveRectNode(nodeId: string): boolean {
  return /^lift-\d{2}-(?:inbound|outbound)(?:$|-buffer-\d{2})$/.test(nodeId);
}

function isLiftDisplayProjectedNode(nodeId: string): boolean {
  return isLiftRouteDisplaySnapNode(nodeId) || isLiftNoDriveDisplaySnapNode(nodeId);
}

function liftDisplayRailLevel(nodeId: string): LiftDisplayRailLevel | null {
  const column = /^column-((?:top|bottom)-[ab])-c\d+$/.exec(nodeId);
  if (column) {
    return column[1] as LiftDisplayRailLevel;
  }
  const spine = /^(?:module-\d+|module-boundary-\d+)-spine-((?:top|bottom)-[ab])$/.exec(nodeId);
  return spine ? spine[1] as LiftDisplayRailLevel : null;
}

function isLiftDisplayRailLevelNode(nodeId: string, level: LiftDisplayRailLevel): boolean {
  return new RegExp(`^column-${level}-c\\d+$`).test(nodeId) ||
    new RegExp(`^(?:module-\\d+|module-boundary-\\d+)-spine-${level}$`).test(nodeId);
}

function liftDisplayLevelForRouteNode(nodeIds: string[], index: number): LiftDisplayRailLevel | null {
  const nodeId = nodeIds[index];
  if (!nodeId || !isLiftDisplayProjectedNode(nodeId)) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previousNodeId = nodeIds[cursor]!;
    const railLevel = liftDisplayRailLevel(previousNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftDisplayProjectedNode(previousNodeId)) {
      break;
    }
  }

  for (let cursor = index + 1; cursor < nodeIds.length; cursor += 1) {
    const nextNodeId = nodeIds[cursor]!;
    const railLevel = liftDisplayRailLevel(nextNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftDisplayProjectedNode(nextNodeId)) {
      break;
    }
  }

  return null;
}

function liftDisplayLevelsForRoute(nodeIds: string[]): Array<LiftDisplayRailLevel | null> {
  return nodeIds.map((_, index) => liftDisplayLevelForRouteNode(nodeIds, index));
}

function remainingRouteNodeIds(vehicle: VehicleState, preferredNodeIds: string[]): string[] {
  const fallback = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
  const source = preferredNodeIds.length >= 2 ? preferredNodeIds : fallback;
  if (source.length < 2) {
    return source;
  }
  if (vehicle.currentEdgeId && vehicle.targetNodeId) {
    const targetIndex = source.indexOf(vehicle.targetNodeId);
    if (targetIndex >= 0) {
      return [vehicle.currentNodeId, ...source.slice(targetIndex)];
    }
  }
  const currentIndex = source.indexOf(vehicle.currentNodeId);
  return currentIndex >= 0 ? source.slice(currentIndex) : fallback.length >= 2 ? fallback : source;
}

function snapPointToAxisAlignedLeg(point: Point, from: Point, to: Point): Point {
  if (Math.abs(from.x - to.x) <= Math.abs(from.z - to.z)) {
    return { x: from.x, z: clamp(point.z, Math.min(from.z, to.z), Math.max(from.z, to.z)) };
  }
  return { x: clamp(point.x, Math.min(from.x, to.x), Math.max(from.x, to.x)), z: from.z };
}

function preferredOrthogonalAxis(from: Point, to: Point): 'x' | 'z' {
  return Math.abs(to.x - from.x) >= Math.abs(to.z - from.z) ? 'x' : 'z';
}

function orthogonalDisplaySegments(from: Point, to: Point, preferredAxis: 'x' | 'z'): Array<{ from: Point; to: Point }> {
  if (isAxisAligned(from, to)) {
    return distance(from, to) > 1e-6 ? [{ from, to }] : [];
  }
  const mid = preferredAxis === 'x' ? { x: to.x, z: from.z } : { x: from.x, z: to.z };
  return [{ from, to: mid }, { from: mid, to }].filter((segment) => distance(segment.from, segment.to) > 1e-6);
}

function pointOnOrthogonalDisplayPath(from: Point, to: Point, progress: number, preferredAxis: 'x' | 'z'): Point {
  const segments = orthogonalDisplaySegments(from, to, preferredAxis);
  if (segments.length === 0) {
    return from;
  }
  const totalLength = segments.reduce((sum, segment) => sum + distance(segment.from, segment.to), 0);
  let remaining = clamp(progress, 0, 1) * totalLength;
  for (const segment of segments) {
    const length = distance(segment.from, segment.to);
    if (remaining <= length || segment === segments[segments.length - 1]) {
      const ratio = length <= 1e-9 ? 0 : clamp(remaining / length, 0, 1);
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        z: segment.from.z + (segment.to.z - segment.from.z) * ratio
      };
    }
    remaining -= length;
  }
  return to;
}

function displayStepFollowsSameOrthogonalEdgePath(vehicle: VehicleState, fromPoint: Point, toPoint: Point): boolean {
  const currentNode = nodeMap.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? nodeMap.get(vehicle.targetNodeId) : null;
  if (
    !vehicle.currentEdgeId ||
    !currentNode ||
    !targetNode ||
    (!isLiftDisplayProjectedNode(currentNode.id) && !isLiftDisplayProjectedNode(targetNode.id))
  ) {
    return false;
  }
  const routeNodeIds = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
  const fallbackRouteNodeIds = routeNodeIds.length >= 2 ? routeNodeIds : remainingRouteNodeIds(vehicle, vehicle.routeNodeIds);
  const displayLevels = liftDisplayLevelsForRoute(fallbackRouteNodeIds);
  const displayFrom = displayPointForNode(currentNode.id, currentNode, displayLevels[0] ?? null);
  const displayTo = displayPointForNode(targetNode.id, targetNode, displayLevels[1] ?? null);
  const segments = orthogonalDisplaySegments(displayFrom, displayTo, preferredOrthogonalAxis(currentNode, targetNode));
  if (segments.length < 2) {
    return false;
  }
  const fromProgress = progressAlongOrthogonalSegments(fromPoint, segments);
  const toProgress = progressAlongOrthogonalSegments(toPoint, segments);
  return fromProgress !== null && toProgress !== null && toProgress >= fromProgress - 0.05;
}

function progressAlongOrthogonalSegments(point: Point, segments: Array<{ from: Point; to: Point }>): number | null {
  const tolerance = 0.16;
  let offset = 0;
  for (const segment of segments) {
    const length = distance(segment.from, segment.to);
    if (length <= 1e-9) {
      continue;
    }
    if (Math.abs(segment.from.x - segment.to.x) <= 1e-6) {
      const minZ = Math.min(segment.from.z, segment.to.z) - tolerance;
      const maxZ = Math.max(segment.from.z, segment.to.z) + tolerance;
      if (Math.abs(point.x - segment.from.x) <= tolerance && point.z >= minZ && point.z <= maxZ) {
        return offset + Math.abs(point.z - segment.from.z);
      }
    } else if (Math.abs(segment.from.z - segment.to.z) <= 1e-6) {
      const minX = Math.min(segment.from.x, segment.to.x) - tolerance;
      const maxX = Math.max(segment.from.x, segment.to.x) + tolerance;
      if (Math.abs(point.z - segment.from.z) <= tolerance && point.x >= minX && point.x <= maxX) {
        return offset + Math.abs(point.x - segment.from.x);
      }
    }
    offset += length;
  }
  return null;
}

function segmentIntersectsRectInterior(from: Point, to: Point, rect: { liftNodeId: string; minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  const dock = liftDocks.get(rect.liftNodeId);
  const steps = Math.max(2, Math.ceil(distance(from, to) / 0.1));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const point = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    if (dock && distance(point, dock) <= 0.1) {
      continue;
    }
    if (pointInsideRect(point, rect)) {
      return true;
    }
  }
  return false;
}

function pointInsideRect(point: Point, rect: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  return point.x > rect.minX && point.x < rect.maxX && point.z > rect.minZ && point.z < rect.maxZ;
}

function isAxisAligned(from: Point, to: Point): boolean {
  return Math.abs(from.x - to.x) <= 1e-6 || Math.abs(from.z - to.z) <= 1e-6;
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function addAnomaly(timeSec: number, vehicleId: string | null, code: string, severity: Anomaly['severity'], detail: string): void {
  const key = `${vehicleId ?? 'system'}:${code}:${detail}`;
  if (anomalies.some((anomaly) => `${anomaly.vehicleId ?? 'system'}:${anomaly.code}:${anomaly.detail}` === key)) {
    return;
  }
  const anomaly = { timeSec: round(timeSec), vehicleId, code, severity, detail };
  anomalies.push(anomaly);
  console.error(JSON.stringify({ type: 'lift-visual-anomaly', ...anomaly }));
}

function countAnomalies(items: Anomaly[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, anomaly) => {
    counts[anomaly.code] = (counts[anomaly.code] ?? 0) + 1;
    return counts;
  }, {});
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function valueAfter(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function numberArg(name: string, fallback: number): number {
  const value = valueAfter(name);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.floor(numberArg(name, fallback));
}

function stringArg(name: string): string | null {
  return valueAfter(name);
}
