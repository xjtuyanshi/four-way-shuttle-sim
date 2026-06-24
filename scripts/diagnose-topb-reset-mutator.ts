import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const targetSec = Number(process.argv[2] ?? 14400);
const dtSec = Number(process.argv[3] ?? 0.2);
const traceFromSec = Number(process.argv[4] ?? 13500);
const logPath = resolve(process.argv[5] ?? 'output/review/diagnose-topb-reset-mutator.jsonl');

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
    routeNodeIds: [...vehicle.routeNodeIds],
    localRouteNodeIds: [...vehicle.localRouteNodeIds],
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

function getTrackedVehicle() {
  return sim.vehicles.find((vehicle: any) => vehicle.id === 'SH-08') ?? null;
}

function routeKey(vehicle: any) {
  return [
    vehicle?.currentNodeId,
    vehicle?.targetNodeId,
    vehicle?.currentEdgeId,
    vehicle?.routeIndex,
    vehicle?.routeNodeIds?.join('>'),
    vehicle?.localRouteNodeIds?.join('>'),
    vehicle?.localRouteReason,
    vehicle?.plannedGoalNodeId,
    vehicle?.legElapsedSec,
    vehicle?.legRemainingM,
    vehicle?.legTravelSec
  ].join('|');
}

function shouldEmitChange(before: any, after: any) {
  if (!before || !after || sim.getClock().simTimeSec < traceFromSec) {
    return false;
  }
  if (before.legElapsedSec > 0 && after.legElapsedSec < before.legElapsedSec - 1e-9) {
    return true;
  }
  if (before.currentEdgeId !== after.currentEdgeId) {
    return true;
  }
  if (before.targetNodeId !== after.targetNodeId) {
    return true;
  }
  if (before.routeNodeIds.join('>') !== after.routeNodeIds.join('>')) {
    return true;
  }
  if (before.localRouteNodeIds.join('>') !== after.localRouteNodeIds.join('>')) {
    return true;
  }
  if (before.localRouteReason !== after.localRouteReason) {
    return true;
  }
  return false;
}

function wrapMethod(name: string) {
  const original = sim[name];
  if (typeof original !== 'function') {
    return;
  }
  sim[name] = function patchedMethod(...args: unknown[]) {
    const beforeVehicle = getTrackedVehicle();
    const before = vehicleDigest(beforeVehicle);
    const beforeKey = routeKey(beforeVehicle);
    const result = original.apply(this, args);
    const afterVehicle = getTrackedVehicle();
    const after = vehicleDigest(afterVehicle);
    const afterKey = routeKey(afterVehicle);
    if (beforeKey !== afterKey && shouldEmitChange(before, after)) {
      emit({
        type: 'topb-mutator',
        method: name,
        timeSec: this.getClock().simTimeSec,
        args: args.map((arg) => {
          if (arg && typeof arg === 'object' && 'id' in (arg as Record<string, unknown>)) {
            const obj = arg as Record<string, unknown>;
            return {
              id: obj.id,
              currentNodeId: obj.currentNodeId,
              targetNodeId: obj.targetNodeId,
              waitReason: obj.waitReason,
              blockingVehicleId: obj.blockingVehicleId
            };
          }
          return arg;
        }),
        before,
        after
      });
    }
    return result;
  };
}

const methodsToWrap = [
  'replenishInboundSourceBuffers',
  'generateDueTasks',
  'reconcileStationKernelShadowState',
  'assignQueuedTasks',
  'advanceVehicles',
  'updateConflictSessions',
  'clearInactiveLocalRouteClaims',
  'updateLiftPortUtilization',
  'updateDeadlockSmokeCounters',
  'startNextLeg',
  'advanceMovement',
  'authorizeRouteHorizon',
  'agentRefreshHandleMoveBlock',
  'tryYieldTopLiftAccessBlockerAhead',
  'syncActiveInboundPickupClearanceRoute',
  'rerouteInboundPickupVehicleBehindEarlierTask',
  'installInboundPickupClearanceRoute'
];

let nextProgressSec = 600;
while (sim.getClock().simTimeSec < traceFromSec - 1e-9 && sim.getClock().status === 'running') {
  const nextSec = Math.min(traceFromSec, nextProgressSec);
  sim.advanceByInPlace(nextSec - sim.getClock().simTimeSec);
  const after = sim.getClock();
  if (after.simTimeSec >= nextProgressSec - 1e-9) {
    console.error(JSON.stringify({ type: 'topb-reset-fast-progress', timeSec: after.simTimeSec, targetSec, traceFromSec, logPath }));
    nextProgressSec += 600;
  }
}

methodsToWrap.forEach(wrapMethod);
emit({
  type: 'topb-reset-trace-start',
  timeSec: sim.getClock().simTimeSec,
  vehicle: vehicleDigest(getTrackedVehicle())
});

while (sim.getClock().simTimeSec < targetSec - 1e-9 && sim.getClock().status === 'running') {
  sim.advanceByInPlace(dtSec);
  const after = sim.getClock();
  if (after.simTimeSec >= nextProgressSec - 1e-9) {
    console.error(JSON.stringify({ type: 'topb-reset-progress', timeSec: after.simTimeSec, targetSec, logPath }));
    nextProgressSec += 600;
  }
}

emit({
  type: 'topb-reset-final',
  timeSec: sim.getClock().simTimeSec,
  vehicle: vehicleDigest(getTrackedVehicle())
});
