import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const targetSec = Number(process.argv[2] ?? 14400);
const dtSec = Number(process.argv[3] ?? 0.2);
const traceFromSec = Number(process.argv[4] ?? 13400);
const logPath = resolve(process.argv[5] ?? 'output/review/diagnose-topb-active-edge-runtime.jsonl');

mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(logPath, '');

function emit(record: Record<string, unknown>) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

const scenario = createInboundOutboundDemoScenario({
  durationSec: targetSec,
  vehicles: { count: 8 },
  taskGeneration: {
    inboundRatePerHour: 3600,
    outboundRatePerHour: 3600,
    inboundOutboundMix: 0.5,
    initialOutboundFullColumns: 4,
    initialStorageFillPolicy: 'zone-balanced-50',
    storageSelectionPolicy: 'sequential'
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: 2
  },
  trafficPolicy: {
    collisionAvoidanceEnabled: true
  }
});

const sim = new ShuttleSimCore(scenario) as any;
sim.start();

const originalAdvanceMovement = sim.advanceMovement.bind(sim);

function vehicleDigest(vehicle: any) {
  if (!vehicle) {
    return null;
  }
  return {
    id: vehicle.id,
    state: vehicle.state,
    loaded: vehicle.loaded,
    taskId: vehicle.taskId,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    currentEdgeId: vehicle.currentEdgeId,
    routeIndex: vehicle.routeIndex,
    routeNodeIds: vehicle.routeNodeIds,
    localRouteReason: vehicle.localRouteReason,
    waitReason: vehicle.waitReason,
    blockingVehicleId: vehicle.blockingVehicleId,
    waitingSinceSec: vehicle.waitingSinceSec,
    legRemainingM: vehicle.legRemainingM,
    legElapsedSec: vehicle.legElapsedSec,
    legTravelSec: vehicle.legTravelSec,
    legMotionMode: vehicle.legMotionMode,
    targetSpeedMps: vehicle.targetSpeedMps,
    speedMps: vehicle.speedMps,
    x: vehicle.x,
    z: vehicle.z,
    yaw: vehicle.yaw
  };
}

function edgeDigest(vehicle: any) {
  if (!vehicle?.currentEdgeId) {
    return null;
  }
  const edge = sim.scenario.layout.edges.find((candidate: any) => candidate.id === vehicle.currentEdgeId) ?? null;
  if (!edge) {
    return null;
  }
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    lengthM: edge.lengthM,
    speedForVehicle: sim.speedForEdge(vehicle, edge),
    distanceForVehicle: sim.routeLegDistanceM(edge)
  };
}

sim.advanceMovement = function patchedAdvanceMovement(vehicle: any, stepSec: number) {
  const timeSec = this.getClock().simTimeSec;
  const shouldTrace =
    timeSec >= traceFromSec &&
    (vehicle.id === 'SH-08' || vehicle.id === 'SH-01' || vehicle.id === 'SH-07');
  if (!shouldTrace) {
    return originalAdvanceMovement(vehicle, stepSec);
  }

  const before = vehicleDigest(vehicle);
  const edgeBefore = edgeDigest(vehicle);
  originalAdvanceMovement(vehicle, stepSec);
  const after = vehicleDigest(vehicle);
  const edgeAfter = edgeDigest(vehicle);
  const changed =
    before?.currentNodeId !== after?.currentNodeId ||
    before?.targetNodeId !== after?.targetNodeId ||
    before?.currentEdgeId !== after?.currentEdgeId ||
    before?.legRemainingM !== after?.legRemainingM ||
    before?.legElapsedSec !== after?.legElapsedSec ||
    before?.waitReason !== after?.waitReason ||
    before?.x !== after?.x ||
    before?.z !== after?.z ||
    vehicle.id === 'SH-08';
  if (changed) {
    emit({
      type: 'topb-advance-movement',
      timeSec,
      stepSec,
      before,
      edgeBefore,
      after,
      edgeAfter
    });
  }
};

function sample(label: string) {
  emit({
    type: 'topb-runtime-sample',
    label,
    timeSec: sim.getClock().simTimeSec,
    vehicles: sim.vehicles
      .filter((vehicle: any) => vehicle.id === 'SH-01' || vehicle.id === 'SH-07' || vehicle.id === 'SH-08')
      .map(vehicleDigest)
  });
}

let nextProgressSec = 600;
const sampleTimes = new Set([13500, 13800, 14100, 14400].filter((time) => time <= targetSec));
while (sim.getClock().simTimeSec < targetSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const nextSampleSec = [...sampleTimes].find((time) => time > clock.simTimeSec + 1e-9) ?? targetSec;
  const nextSec = Math.min(targetSec, nextProgressSec, nextSampleSec);
  sim.advanceByInPlace(Math.max(dtSec, Math.min(nextSec - clock.simTimeSec, dtSec)));
  const after = sim.getClock();
  if (after.simTimeSec >= nextProgressSec - 1e-9) {
    console.error(JSON.stringify({ type: 'topb-diagnose-progress', timeSec: after.simTimeSec, targetSec, logPath }));
    nextProgressSec += 600;
  }
  if (sampleTimes.has(after.simTimeSec)) {
    sample(`sample-${after.simTimeSec}`);
    sampleTimes.delete(after.simTimeSec);
  }
}

sample('final');
