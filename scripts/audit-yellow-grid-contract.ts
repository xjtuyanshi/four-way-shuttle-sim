import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  createInboundOutboundDemoScenario,
  hashScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

type Point = { x: number; z: number };
type VehicleFrame = Pick<VehicleState, 'id' | 'x' | 'z' | 'currentNodeId' | 'targetNodeId' | 'currentEdgeId'>;
type Anomaly = {
  timeSec: number;
  code: string;
  severity: 'warn' | 'critical';
  vehicleIds: string[];
  detail: string;
};

const durationSec = numberArg('--duration-sec', 600);
const dtSec = numberArg('--dt-sec', 0.2);
const sampleSec = numberArg('--sample-sec', 60);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const storageSelectionPolicy = enumArg('--storage-selection-policy', ['sequential', 'traffic-aware'] as const, 'sequential');
const maxAnomalies = integerArg('--max-anomalies', 500);
const stopOnCritical = process.argv.includes('--stop-on-critical');
const outputPath = resolve(stringArg('--out') ?? `output/shuttle/yellow-grid-contract-audit-${Date.now()}.json`);

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
    initialOutboundFullColumns,
    initialStorageFillPolicy,
    storageSelectionPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const nodeById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
const edgeById = new Map(scenario.layout.edges.map((edge) => [edge.id, edge]));
const yellowGridNodeIds = new Set(
  scenario.layout.nodes
    .filter((node) => isYellowGridNodeId(node.id))
    .map((node) => node.id)
);
const yellowGridEdges = scenario.layout.edges.filter((edge) =>
  yellowGridNodeIds.has(edge.from) &&
  yellowGridNodeIds.has(edge.to) &&
  edgeIsAxisAligned(edge.from, edge.to)
);

const sim = new ShuttleSimCore(scenario);
const anomalies: Anomaly[] = [];
const previousByVehicle = new Map<string, VehicleFrame>();
const samples: Array<{
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  physicalViolations: number;
  anomalies: number;
}> = [];
let nextSampleSec = 0;

sim.start();
for (const vehicle of sim.getState().vehicles) {
  previousByVehicle.set(vehicle.id, frame(vehicle));
}

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const state = sim.step(Math.min(dtSec, durationSec - clock.simTimeSec));
  auditState(state);
  for (const vehicle of state.vehicles) {
    previousByVehicle.set(vehicle.id, frame(vehicle));
  }
  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    const sample = {
      timeSec: round(state.simTimeSec),
      completedInbound: state.kpis.completedInbound,
      completedOutbound: state.kpis.completedOutbound,
      totalPph: round(state.kpis.totalPph, 3),
      physicalViolations: state.traffic.physicalViolationCount,
      anomalies: anomalies.length
    };
    samples.push(sample);
    console.log(JSON.stringify({ type: 'yellow-grid-contract-sample', ...sample }));
    nextSampleSec += sampleSec;
  }
  if (stopOnCritical && anomalies.some((anomaly) => anomaly.severity === 'critical')) {
    break;
  }
}

const finalState = sim.getState();
const report = {
  schemaVersion: 'shuttle.yellowGridContractAudit.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  status: finalState.status,
  contract: {
    initialStorageFillPolicy,
    storageSelectionPolicy,
    yellowGridNodeCount: yellowGridNodeIds.size,
    yellowGridEdgeCount: yellowGridEdges.length,
    forbiddenWorkcellPattern: '^(?:lift|parking-lift)-',
    rules: [
      'vehicles must occupy or travel along yellow-grid nodes/edges only',
      'lift and parking-lift workcell nodes are not drivable',
      'movement must be axis-aligned',
      'two stationary vehicles may not share a node',
      'two vehicles may not move opposite directions on the same edge',
      'vehicle square footprints may not overlap',
      'two moving vehicle center sweeps may not cross within one tick'
    ]
  },
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
console.log(JSON.stringify({ type: 'yellow-grid-contract-complete', outputPath, anomalies: anomalies.length }, null, 2));

if (anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function auditState(state: ShuttleSimState): void {
  const stationaryByNode = new Map<string, string[]>();
  for (const vehicle of state.vehicles) {
    if (vehicle.currentEdgeId === null) {
      const vehicles = stationaryByNode.get(vehicle.currentNodeId) ?? [];
      vehicles.push(vehicle.id);
      stationaryByNode.set(vehicle.currentNodeId, vehicles);
    }

    if (!yellowGridNodeIds.has(vehicle.currentNodeId)) {
      addAnomaly(state.simTimeSec, 'vehicle-current-node-outside-yellow-grid', 'critical', [vehicle.id], vehicle.currentNodeId);
    }
    if (vehicle.targetNodeId && !yellowGridNodeIds.has(vehicle.targetNodeId)) {
      addAnomaly(state.simTimeSec, 'vehicle-target-node-outside-yellow-grid', 'critical', [vehicle.id], vehicle.targetNodeId);
    }
    if (vehicle.currentEdgeId) {
      const edge = edgeById.get(vehicle.currentEdgeId);
      if (!edge || !yellowGridNodeIds.has(edge.from) || !yellowGridNodeIds.has(edge.to)) {
        addAnomaly(state.simTimeSec, 'vehicle-edge-outside-yellow-grid', 'critical', [vehicle.id], vehicle.currentEdgeId);
      } else if (!edgeIsAxisAligned(edge.from, edge.to)) {
        addAnomaly(state.simTimeSec, 'vehicle-edge-not-axis-aligned', 'critical', [vehicle.id], vehicle.currentEdgeId);
      }
    }
    if (!pointOnYellowGrid(vehicle)) {
      addAnomaly(state.simTimeSec, 'vehicle-position-outside-yellow-grid', 'critical', [vehicle.id], pointText(vehicle));
    }

    const previous = previousByVehicle.get(vehicle.id);
    if (previous && moved(previous, vehicle) && Math.abs(vehicle.x - previous.x) > 0.02 && Math.abs(vehicle.z - previous.z) > 0.02) {
      addAnomaly(
        state.simTimeSec,
        'vehicle-diagonal-motion',
        'critical',
        [vehicle.id],
        `${pointText(previous)} -> ${pointText(vehicle)}`
      );
    }
  }

  for (const [nodeId, vehicleIds] of stationaryByNode) {
    if (vehicleIds.length > 1) {
      addAnomaly(state.simTimeSec, 'duplicate-stationary-node', 'critical', vehicleIds, `${nodeId}: ${vehicleIds.join(',')}`);
    }
  }

  for (let leftIndex = 0; leftIndex < state.vehicles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < state.vehicles.length; rightIndex += 1) {
      auditPair(state.simTimeSec, state.vehicles[leftIndex]!, state.vehicles[rightIndex]!);
    }
  }
}

function auditPair(timeSec: number, left: VehicleState, right: VehicleState): void {
  const vehicleIds = [left.id, right.id];
  if (axisAlignedSquareOverlap(left, right)) {
    addAnomaly(timeSec, 'axis-aligned-footprint-overlap', 'critical', vehicleIds, pairDetail(left, right));
  }

  if (oppositeDirectionSameEdge(left, right)) {
    addAnomaly(timeSec, 'opposite-direction-same-edge', 'critical', vehicleIds, pairDetail(left, right));
  }

  const previousLeft = previousByVehicle.get(left.id);
  const previousRight = previousByVehicle.get(right.id);
  if (!previousLeft || !previousRight || !moved(previousLeft, left) || !moved(previousRight, right)) {
    return;
  }
  if (
    segmentsIntersect(previousLeft, left, previousRight, right) &&
    !sharedEndpoint(previousLeft, left, previousRight, right) &&
    left.currentEdgeId !== right.currentEdgeId
  ) {
    addAnomaly(
      timeSec,
      'swept-center-path-crossing',
      'critical',
      vehicleIds,
      `${left.id} ${pointText(previousLeft)}->${pointText(left)}; ${right.id} ${pointText(previousRight)}->${pointText(right)}`
    );
  }
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

function edgeIsAxisAligned(fromNodeId: string, toNodeId: string): boolean {
  const from = nodeById.get(fromNodeId);
  const to = nodeById.get(toNodeId);
  return Boolean(from && to && (Math.abs(from.x - to.x) < 1e-6 || Math.abs(from.z - to.z) < 1e-6));
}

function pointOnYellowGrid(point: Point): boolean {
  const toleranceM = 0.08;
  for (const nodeId of yellowGridNodeIds) {
    const node = nodeById.get(nodeId);
    if (node && Math.hypot(point.x - node.x, point.z - node.z) <= toleranceM) {
      return true;
    }
  }
  for (const edge of yellowGridEdges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    if (distancePointToSegment(point, from, to) <= toleranceM) {
      return true;
    }
  }
  return false;
}

function distancePointToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= 1e-9) {
    return Math.hypot(point.x - from.x, point.z - from.z);
  }
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSq));
  return Math.hypot(point.x - (from.x + dx * t), point.z - (from.z + dz * t));
}

function axisAlignedSquareOverlap(left: Point, right: Point): boolean {
  const sideM = Math.max(scenario.vehicles.lengthM, scenario.vehicles.widthM);
  return Math.abs(left.x - right.x) < sideM && Math.abs(left.z - right.z) < sideM;
}

function oppositeDirectionSameEdge(left: VehicleState, right: VehicleState): boolean {
  if (!left.currentEdgeId || !right.currentEdgeId || left.currentEdgeId !== right.currentEdgeId) {
    return false;
  }
  return Boolean(left.targetNodeId && right.targetNodeId && left.currentNodeId === right.targetNodeId && right.currentNodeId === left.targetNodeId);
}

function frame(vehicle: VehicleState): VehicleFrame {
  return {
    id: vehicle.id,
    x: vehicle.x,
    z: vehicle.z,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    currentEdgeId: vehicle.currentEdgeId
  };
}

function moved(previous: Point, current: Point): boolean {
  return Math.hypot(current.x - previous.x, current.z - previous.z) > 0.02;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const ab = orientation(a, b, c) * orientation(a, b, d);
  const cd = orientation(c, d, a) * orientation(c, d, b);
  return ab < 0 && cd < 0;
}

function orientation(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
}

function sharedEndpoint(a: Point, b: Point, c: Point, d: Point): boolean {
  return samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d);
}

function samePoint(left: Point, right: Point): boolean {
  return Math.hypot(left.x - right.x, left.z - right.z) <= 0.05;
}

function pairDetail(left: VehicleState, right: VehicleState): string {
  return `${left.id}@${left.currentNodeId}->${left.targetNodeId ?? '-'} ${pointText(left)} edge=${left.currentEdgeId ?? '-'}; ` +
    `${right.id}@${right.currentNodeId}->${right.targetNodeId ?? '-'} ${pointText(right)} edge=${right.currentEdgeId ?? '-'}`;
}

function pointText(point: Point): string {
  return `(${round(point.x, 3)},${round(point.z, 3)})`;
}

function addAnomaly(timeSec: number, code: string, severity: Anomaly['severity'], vehicleIds: string[], detail: string): void {
  if (anomalies.length >= maxAnomalies) {
    return;
  }
  anomalies.push({ timeSec: round(timeSec), code, severity, vehicleIds, detail });
}

function countAnomalies(items: Anomaly[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.code] = (counts[item.code] ?? 0) + 1;
  }
  return counts;
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.max(0, Math.floor(numberArg(name, fallback)));
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  return value && !value.startsWith('--') ? value : null;
}

function enumArg<T extends readonly string[]>(name: string, values: T, fallback: T[number]): T[number] {
  const value = stringArg(name);
  return values.includes(value ?? '') ? value as T[number] : fallback;
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
