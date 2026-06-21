import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = Number(process.argv[2] ?? 10800);
const vehicleId = process.argv[3] ?? 'SH-04';

const scenario = createInboundOutboundDemoScenario({
  durationSec,
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

const sim = new ShuttleSimCore(scenario);
sim.start();
let nextProgressSec = 600;
while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const targetSec = Math.min(durationSec, nextProgressSec);
  sim.advanceByInPlace(targetSec - sim.getClock().simTimeSec);
  if (sim.getClock().simTimeSec + 1e-9 >= nextProgressSec) {
    console.error(JSON.stringify({ type: 'inspect-progress', timeSec: sim.getClock().simTimeSec }));
    nextProgressSec += 600;
  }
}

const state = sim.getState();
const vehicle = state.vehicles.find((candidate) => candidate.id === vehicleId) ??
  state.vehicles.find((candidate) => candidate.loaded && candidate.waitReason === 'route-unavailable') ??
  null;
const task = vehicle?.taskId
  ? state.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null
  : null;

const internals = sim as unknown as Record<string, (...args: unknown[]) => unknown> & {
  currentNodeOccupancy: Map<string, string>;
  nodeClaimedByOtherVehicle: (nodeId: string, vehicleId: string) => string | null;
  storedLoadIdAtNode: (nodeId: string) => string | null;
};

function call<T>(name: string, ...args: unknown[]): T | null {
  try {
    const fn = internals[name];
    if (typeof fn !== 'function') {
      return null;
    }
    return fn.apply(sim, args) as T;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) } as T;
  }
}

function routeStatus(route: string[] | null): unknown {
  if (!route) {
    return null;
  }
  return {
    route,
    stored: route.map((nodeId) => [nodeId, internals.storedLoadIdAtNode(nodeId)]),
    occupied: route.map((nodeId) => [nodeId, internals.currentNodeOccupancy.get(nodeId) ?? null]),
    claimedByOther: vehicle ? route.map((nodeId) => [nodeId, internals.nodeClaimedByOtherVehicle(nodeId, vehicle.id)]) : []
  };
}

const diagnostics: Record<string, unknown> = {};
if (vehicle && task) {
  const liftNodeId = call<string>('taskLiftPortNodeId', task);
  const currentExitRoute = call<string[]>('topLiftLoadedOutboundStorageExitRoute', vehicle.currentNodeId);
  const currentExitNodeId = currentExitRoute?.at(-1) ?? null;
  const queueServiceTargets = liftNodeId
    ? call<string[]>('topLiftQueueServiceTargets', vehicle.currentNodeId, liftNodeId, task.dropoffNodeId)
    : null;
  const meterApproachTargets = queueServiceTargets
    ? null
    : call<string[]>('topLiftOutboundMeterApproachTargets', task, task.dropoffNodeId);
  const targets = [currentExitNodeId, ...((queueServiceTargets ?? meterApproachTargets ?? [task.dropoffNodeId]) as string[])]
    .filter((nodeId): nodeId is string => Boolean(nodeId));

  const stepChecks: unknown[] = [];
  let fromNodeId = vehicle.currentNodeId;
  for (const target of targets) {
    if (target === fromNodeId) {
      continue;
    }
    const directRoute = call<string[]>('topLiftDirectStorageColumnExitRoute', fromNodeId, target);
    const directConflict = directRoute
      ? call<boolean>('routeHasStoredLoadConflict', directRoute, new Set([fromNodeId]))
      : null;
    const blockedNodeIds = call<Set<string>>('blockedStorageTransitNodeIds', fromNodeId, target, { blockStoredLoads: true });
    const protectedInbound = task.vehicleId
      ? call<Set<string>>('activeTopLiftLoadedInboundProtectedNodeIds', task.vehicleId)
      : null;
    const protectedInboundService = task.vehicleId
      ? call<Set<string>>('activeTopLiftInboundServiceProtectedNodeIds', task.vehicleId)
      : null;
    if (blockedNodeIds instanceof Set) {
      if (protectedInbound instanceof Set) {
        for (const nodeId of protectedInbound) blockedNodeIds.add(nodeId);
      }
      if (protectedInboundService instanceof Set) {
        for (const nodeId of protectedInboundService) blockedNodeIds.add(nodeId);
      }
      blockedNodeIds.delete(fromNodeId);
      blockedNodeIds.delete(target);
    }
    const segment = blockedNodeIds instanceof Set
      ? call<string[]>('tryAgentRefreshShortestPath', fromNodeId, target, blockedNodeIds, null)
      : null;
    stepChecks.push({
      fromNodeId,
      target,
      directRoute: routeStatus(directRoute),
      directConflict,
      blockedCount: blockedNodeIds instanceof Set ? blockedNodeIds.size : blockedNodeIds,
      protectedInbound: protectedInbound instanceof Set ? [...protectedInbound] : protectedInbound,
      protectedInboundService: protectedInboundService instanceof Set ? [...protectedInboundService] : protectedInboundService,
      segment: routeStatus(segment)
    });
    fromNodeId = target;
  }

  diagnostics.liftNodeId = liftNodeId;
  diagnostics.currentExitRoute = routeStatus(currentExitRoute);
  diagnostics.queueServiceTargets = queueServiceTargets;
  diagnostics.meterApproachTargets = meterApproachTargets;
  diagnostics.targets = targets;
  diagnostics.stepChecks = stepChecks;
  diagnostics.nominalRoute = routeStatus(call<string[]>('agentRefreshLoadedOutboundRouteToDropoff', vehicle.currentNodeId, task, task.dropoffNodeId));
  diagnostics.inboundProtectors = state.vehicles
    .filter((candidate) => candidate.loaded)
    .map((candidate) => {
      const candidateTask = candidate.taskId
        ? state.tasks.find((taskCandidate) => taskCandidate.id === candidate.taskId) ?? null
        : null;
      if (candidateTask?.kind !== 'inbound') {
        return null;
      }
      const protectedRouteTail = call<string[]>('topLiftLoadedInboundProtectedRouteTail', candidate, candidateTask);
      return {
        vehicleId: candidate.id,
        taskId: candidateTask.id,
        currentNodeId: candidate.currentNodeId,
        targetNodeId: candidate.targetNodeId,
        plannedGoalNodeId: candidate.plannedGoalNodeId,
        waitReason: candidate.waitReason,
        blockingVehicleId: candidate.blockingVehicleId,
        routeNodeIds: candidate.routeNodeIds,
        protectedRouteTail
      };
    })
    .filter(Boolean);
}

console.log(JSON.stringify({
  simTimeSec: state.simTimeSec,
  status: state.status,
  kpis: state.kpis,
  selectedVehicle: vehicle,
  selectedTask: task,
  waiting: state.vehicles
    .filter((candidate) => candidate.state === 'waiting-blocked')
    .map((candidate) => ({
      id: candidate.id,
      loaded: candidate.loaded,
      taskId: candidate.taskId,
      currentNodeId: candidate.currentNodeId,
      targetNodeId: candidate.targetNodeId,
      plannedGoalNodeId: candidate.plannedGoalNodeId,
      waitReason: candidate.waitReason,
      blockingVehicleId: candidate.blockingVehicleId,
      routeNodeIds: candidate.routeNodeIds
    })),
  diagnostics
}, null, 2));
