import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const targetSec = Number(process.argv[2] ?? 14400);
const traceFromSec = Number(process.argv[3] ?? 13480);
const dtSec = Number(process.argv[4] ?? 0.2);
const logPath = resolve(process.argv[5] ?? 'output/review/diagnose-sh08-leg-reset-stack.jsonl');

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

function digest(vehicle: any) {
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
    routeNodeIds: [...vehicle.routeNodeIds],
    plannedRouteNodeIds: [...vehicle.plannedRouteNodeIds],
    localRouteNodeIds: [...vehicle.localRouteNodeIds],
    localRouteReason: vehicle.localRouteReason,
    waitReason: vehicle.waitReason,
    blockingVehicleId: vehicle.blockingVehicleId,
    legRemainingM: vehicle.legRemainingM,
    legElapsedSec: vehicle.legElapsedSec,
    legTravelSec: vehicle.legTravelSec,
    targetSpeedMps: vehicle.targetSpeedMps,
    speedMps: vehicle.speedMps,
    x: vehicle.x,
    z: vehicle.z,
    yaw: vehicle.yaw
  };
}

let nextProgressSec = 600;
while (sim.getClock().simTimeSec < traceFromSec - 1e-9 && sim.getClock().status === 'running') {
  const nextSec = Math.min(traceFromSec, nextProgressSec);
  sim.advanceByInPlace(nextSec - sim.getClock().simTimeSec);
  const clock = sim.getClock();
  if (clock.simTimeSec >= nextProgressSec - 1e-9) {
    console.error(JSON.stringify({ type: 'sh08-reset-fast-progress', timeSec: clock.simTimeSec, traceFromSec, targetSec, logPath }));
    nextProgressSec += 600;
  }
}

const vehicle = sim.vehicles.find((candidate: any) => candidate.id === 'SH-08');
if (!vehicle) {
  throw new Error('SH-08 not found');
}

let legElapsedSec = vehicle.legElapsedSec;
let currentEdgeId = vehicle.currentEdgeId;
const resetRecords: Record<string, unknown>[] = [];
Object.defineProperty(vehicle, 'legElapsedSec', {
  configurable: true,
  enumerable: true,
  get() {
    return legElapsedSec;
  },
  set(nextValue: number) {
    const previousValue = legElapsedSec;
    const before = digest(vehicle);
    legElapsedSec = nextValue;
    const clock = sim.getClock();
    if (
      clock.simTimeSec >= traceFromSec - 1e-9 &&
      before.currentEdgeId !== null &&
      before.targetNodeId !== null &&
      before.legRemainingM > 1e-6 &&
      before.currentNodeId !== before.targetNodeId &&
      previousValue > 1e-9 &&
      nextValue < previousValue - 1e-9
    ) {
      const record = {
        type: 'sh08-legElapsed-regressed',
        timeSec: clock.simTimeSec,
        previousValue,
        nextValue,
        before,
        after: digest(vehicle),
        stack: new Error().stack?.split('\n').slice(1, 12) ?? []
      };
      resetRecords.push(record);
      emit(record);
    }
  }
});
Object.defineProperty(vehicle, 'currentEdgeId', {
  configurable: true,
  enumerable: true,
  get() {
    return currentEdgeId;
  },
  set(nextValue: string | null) {
    const previousValue = currentEdgeId;
    const previousLegRemainingM = vehicle.legRemainingM;
    const previousTargetNodeId = vehicle.targetNodeId;
    currentEdgeId = nextValue;
    const clock = sim.getClock();
    if (
      clock.simTimeSec >= traceFromSec - 1e-9 &&
      previousValue !== null &&
      nextValue === null &&
      previousLegRemainingM > 1e-6 &&
      previousTargetNodeId !== null &&
      vehicle.currentNodeId !== previousTargetNodeId
    ) {
      const record = {
        type: 'sh08-active-edge-cleared-before-arrival',
        timeSec: clock.simTimeSec,
        previousValue,
        nextValue,
        previousLegRemainingM,
        previousTargetNodeId,
        vehicle: digest(vehicle),
        stack: new Error().stack?.split('\n').slice(1, 12) ?? []
      };
      resetRecords.push(record);
      emit(record);
    }
  }
});

emit({
  type: 'sh08-reset-trace-start',
  timeSec: sim.getClock().simTimeSec,
  vehicle: digest(vehicle)
});

while (
  sim.getClock().simTimeSec < targetSec - 1e-9 &&
  sim.getClock().status === 'running' &&
  resetRecords.length < 5
) {
  sim.advanceByInPlace(dtSec);
}

emit({
  type: 'sh08-reset-trace-final',
  timeSec: sim.getClock().simTimeSec,
  resetRecordCount: resetRecords.length,
  vehicle: digest(vehicle)
});

console.error(JSON.stringify({
  type: 'sh08-reset-trace-complete',
  timeSec: sim.getClock().simTimeSec,
  resetRecordCount: resetRecords.length,
  logPath
}));
