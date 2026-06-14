import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  createInboundOutboundDemoScenario,
  hashScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

type Point = { x: number; z: number };
type VehicleFrame = Pick<VehicleState, 'id' | 'x' | 'z' | 'currentNodeId' | 'targetNodeId' | 'currentEdgeId' | 'routeNodeIds' | 'routeIndex'>;
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
const outputPath = resolve(stringArg('--out') ?? `output/shuttle/collision-rebuild-audit-${Date.now()}.json`);
const maxAnomalies = integerArg('--max-anomalies', 250);
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

const edgeById = new Map(scenario.layout.edges.map((edge) => [edge.id, edge]));
const sim = new ShuttleSimCore(scenario);
const anomalies: Anomaly[] = [];
const samples: Array<{
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  physicalViolations: number;
  anomalies: number;
}> = [];
const previousByVehicle = new Map<string, VehicleFrame>();
let nextSampleSec = 0;

sim.start();
let state = sim.getState();
for (const vehicle of state.vehicles) {
  previousByVehicle.set(vehicle.id, frame(vehicle));
}

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  state = sim.step(Math.min(dtSec, durationSec - clock.simTimeSec));
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
    console.log(JSON.stringify({ type: 'collision-rebuild-sample', ...sample }));
    nextSampleSec += sampleSec;
  }
  if (stopOnCritical && anomalies.some((anomaly) => anomaly.severity === 'critical')) {
    break;
  }
}

const finalState = sim.getState();
const report = {
  schemaVersion: 'shuttle.collisionRebuildAudit.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  status: finalState.status,
  rules: [
    'no two stationary shuttles may occupy the same node',
    'no two shuttle square footprints may overlap',
    'two shuttle swept center paths may not cross inside one tick',
    'opposite-direction movement on the same physical edge is forbidden'
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
console.log(JSON.stringify({ type: 'collision-rebuild-complete', outputPath, anomalies: anomalies.length }, null, 2));

if (anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function auditState(current: ShuttleSimState): void {
  const stationaryByNode = new Map<string, string[]>();
  for (const vehicle of current.vehicles) {
    if (vehicle.currentEdgeId === null) {
      const vehicles = stationaryByNode.get(vehicle.currentNodeId) ?? [];
      vehicles.push(vehicle.id);
      stationaryByNode.set(vehicle.currentNodeId, vehicles);
    }
  }
  for (const [nodeId, vehicleIds] of stationaryByNode) {
    if (vehicleIds.length > 1) {
      addAnomaly(current.simTimeSec, 'duplicate-stationary-node', 'critical', vehicleIds, `${nodeId}: ${vehicleIds.join(',')}`);
    }
  }

  for (let leftIndex = 0; leftIndex < current.vehicles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < current.vehicles.length; rightIndex += 1) {
      const left = current.vehicles[leftIndex]!;
      const right = current.vehicles[rightIndex]!;
      auditPair(current.simTimeSec, left, right);
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
  if (!previousLeft || !previousRight) {
    return;
  }
  const leftMoved = distance(previousLeft, left) > 0.05;
  const rightMoved = distance(previousRight, right) > 0.05;
  if (!leftMoved || !rightMoved) {
    return;
  }
  if (
    segmentsIntersect(previousLeft, left, previousRight, right) &&
    !sharedEndpoint(previousLeft, left, previousRight, right) &&
    !sameVehicleEdge(left, right)
  ) {
    addAnomaly(
      timeSec,
      'swept-center-path-crossing',
      'critical',
      vehicleIds,
      `${left.id} ${pointText(previousLeft)}->${pointText(left)} edge=${left.currentEdgeId ?? '?'}; ${right.id} ${pointText(previousRight)}->${pointText(right)} edge=${right.currentEdgeId ?? '?'}`
    );
  }
}

function frame(vehicle: VehicleState): VehicleFrame {
  return {
    id: vehicle.id,
    x: vehicle.x,
    z: vehicle.z,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    currentEdgeId: vehicle.currentEdgeId,
    routeNodeIds: [...vehicle.routeNodeIds],
    routeIndex: vehicle.routeIndex
  };
}

function axisAlignedSquareOverlap(left: Point, right: Point): boolean {
  const sideM = Math.max(scenario.vehicles.lengthM, scenario.vehicles.widthM);
  return Math.abs(left.x - right.x) < sideM && Math.abs(left.z - right.z) < sideM;
}

function oppositeDirectionSameEdge(left: VehicleState, right: VehicleState): boolean {
  if (!left.currentEdgeId || !right.currentEdgeId || left.currentEdgeId !== right.currentEdgeId) {
    return false;
  }
  const leftNext = left.targetNodeId;
  const rightNext = right.targetNodeId;
  return Boolean(leftNext && rightNext && left.currentNodeId === rightNext && right.currentNodeId === leftNext);
}

function sameVehicleEdge(left: VehicleState, right: VehicleState): boolean {
  if (!left.currentEdgeId || !right.currentEdgeId || left.currentEdgeId !== right.currentEdgeId) {
    return false;
  }
  const edge = edgeById.get(left.currentEdgeId);
  if (!edge) {
    return false;
  }
  return edge.directionMode === 'twoWay';
}

function sharedEndpoint(leftPrev: Point, left: Point, rightPrev: Point, right: Point): boolean {
  return [leftPrev, left].some((leftPoint) => [rightPrev, right].some((rightPoint) => distance(leftPoint, rightPoint) <= 1e-6));
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const ab = orientation(a, b, c) * orientation(a, b, d);
  const cd = orientation(c, d, a) * orientation(c, d, b);
  return ab < -1e-9 && cd < -1e-9;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function pairDetail(left: VehicleState, right: VehicleState): string {
  return `${left.id}@${left.currentNodeId}->${left.targetNodeId ?? '?'} ${pointText(left)} edge=${left.currentEdgeId ?? '?'}; ${right.id}@${right.currentNodeId}->${right.targetNodeId ?? '?'} ${pointText(right)} edge=${right.currentEdgeId ?? '?'}`;
}

function pointText(point: Point): string {
  return `(${round(point.x)},${round(point.z)})`;
}

function addAnomaly(timeSec: number, code: string, severity: Anomaly['severity'], vehicleIds: string[], detail: string): void {
  const key = `${code}:${vehicleIds.join(',')}:${detail}`;
  if (anomalies.some((anomaly) => `${anomaly.code}:${anomaly.vehicleIds.join(',')}:${anomaly.detail}` === key)) {
    return;
  }
  const anomaly = { timeSec: round(timeSec), code, severity, vehicleIds, detail };
  anomalies.push(anomaly);
  console.error(JSON.stringify({ type: 'collision-rebuild-anomaly', ...anomaly }));
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
