import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';
import { dirname, resolve } from 'node:path';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const targetSec = Number(process.argv[2] ?? 13200);
const dtSec = Number(process.argv[3] ?? 0.2);
const logPath = resolve(process.argv[4] ?? 'output/review/diagnose-dock-throat-runtime.jsonl');
const sampleTimes = new Set([12810, 12898, 13200, 13800].filter((time) => time <= targetSec));

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
const originalHandleMoveBlock = sim.agentRefreshHandleMoveBlock.bind(sim);
const originalClearServiceLane = sim.tryClearEmptyNoParkingServiceLaneBlocker.bind(sim);

function vehicleDigest(vehicle: any) {
  if (!vehicle) {
    return null;
  }
  return {
    id: vehicle.id,
    state: vehicle.state,
    loaded: vehicle.loaded,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    waitReason: vehicle.waitReason,
    blockingVehicleId: vehicle.blockingVehicleId,
    waitingSinceSec: vehicle.waitingSinceSec,
    routeNodeIds: vehicle.routeNodeIds
  };
}

function shouldTrace(vehicle: any, blockedTargetNodeId: string, block: { reason: string; blockingVehicleId: string | null }) {
  if (sim.getClock().simTimeSec < 12700) {
    return false;
  }
  return (
    vehicle?.id === 'SH-08' ||
    vehicle?.id === 'SH-04' ||
    block.blockingVehicleId === 'SH-08' ||
    block.blockingVehicleId === 'SH-04' ||
    blockedTargetNodeId === 'module-01-spine-bottom-b' ||
    blockedTargetNodeId === 'column-bottom-b-c08'
  );
}

sim.tryClearEmptyNoParkingServiceLaneBlocker = function patchedClear(blocker: any, requester: any, blockedTargetNodeId: string) {
  const trace = this.getClock().simTimeSec >= 12700 && (
    blocker?.id === 'SH-04' ||
    requester?.id === 'SH-08' ||
    blockedTargetNodeId === 'module-01-spine-bottom-b'
  );
  const route = trace
    ? this.topLiftNoParkingServiceLaneClearanceRoute(blocker, requester, blockedTargetNodeId)
    : null;
  const before = trace ? vehicleDigest(blocker) : null;
  const result = originalClearServiceLane(blocker, requester, blockedTargetNodeId);
  if (trace) {
    emit({
      type: 'dock-clear-service-lane',
      timeSec: this.getClock().simTimeSec,
      blocker: before,
      requester: vehicleDigest(requester),
      blockedTargetNodeId,
      candidateRoute: route,
      result,
      afterBlocker: vehicleDigest(blocker)
    });
  }
  return result;
};

sim.agentRefreshHandleMoveBlock = function patchedHandle(vehicle: any, blockedTargetNodeId: string, block: { reason: string; blockingVehicleId: string | null }) {
  const trace = shouldTrace(vehicle, blockedTargetNodeId, block);
  const beforeVehicle = trace ? vehicleDigest(vehicle) : null;
  const blocker = block.blockingVehicleId
    ? this.vehicles.find((candidate: any) => candidate.id === block.blockingVehicleId)
    : null;
  const beforeBlocker = trace ? vehicleDigest(blocker) : null;
  const result = originalHandleMoveBlock(vehicle, blockedTargetNodeId, block);
  if (trace) {
    emit({
      type: 'dock-handle-move-block',
      timeSec: this.getClock().simTimeSec,
      blockedTargetNodeId,
      block,
      result,
      beforeVehicle,
      beforeBlocker,
      afterVehicle: vehicleDigest(vehicle),
      afterBlocker: vehicleDigest(blocker)
    });
  }
  return result;
};

function inspect(label: string) {
  const sh04 = sim.vehicles.find((vehicle: any) => vehicle.id === 'SH-04');
  const sh08 = sim.vehicles.find((vehicle: any) => vehicle.id === 'SH-08');
  const strict = sh08
    ? sim.strictMoveSafetyBlocker(sh08, 'module-01-spine-bottom-b')
    : null;
  const candidateRoute = sh04 && sh08
    ? sim.topLiftNoParkingServiceLaneClearanceRoute(sh04, sh08, 'module-01-spine-bottom-b')
    : null;
  const candidateNodes = [
    'column-bottom-b-c07',
    'column-bottom-b-c08',
    'column-bottom-b-c09',
    'column-bottom-b-c10',
    'column-bottom-a-c08',
    'column-bottom-a-c09',
    'column-bottom-a-c10',
    'storage-r14-c08',
    'storage-r14-c09',
    'storage-r14-c10',
    'parking-03'
  ].map((nodeId) => ({
    nodeId,
    occupantId: sim.currentNodeOccupancy.get(nodeId) ?? null,
    claimantId: sh04 ? sim.nodeClaimedByOtherVehicle(nodeId, sh04.id) : null,
    storedLoadId: sim.storedLoadIdAtNode(nodeId),
    temporaryStorageAllowedForSh04: sh04 ? sim.agentRefreshTemporaryStorageNodeAllowed(sh04, nodeId) : null
  }));
  emit({
    type: 'dock-runtime-sample',
    label,
    timeSec: sim.getClock().simTimeSec,
    strict,
    candidateRoute,
    sh04: vehicleDigest(sh04),
    sh08: vehicleDigest(sh08),
    candidateNodes
  });
}

let nextProgressSec = 600;
while (sim.getClock().simTimeSec < targetSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const nextSampleSec = [...sampleTimes].find((time) => time > clock.simTimeSec + 1e-9) ?? targetSec;
  const nextSec = Math.min(targetSec, nextProgressSec, nextSampleSec);
  sim.advanceByInPlace(Math.max(dtSec, Math.min(nextSec - clock.simTimeSec, dtSec)));
  const after = sim.getClock();
  if (after.simTimeSec >= nextProgressSec - 1e-9) {
    console.error(JSON.stringify({ type: 'dock-diagnose-progress', timeSec: after.simTimeSec, targetSec, logPath }));
    nextProgressSec += 600;
  }
  if (sampleTimes.has(after.simTimeSec)) {
    inspect(`sample-${after.simTimeSec}`);
    sampleTimes.delete(after.simTimeSec);
  }
}

inspect('final');
