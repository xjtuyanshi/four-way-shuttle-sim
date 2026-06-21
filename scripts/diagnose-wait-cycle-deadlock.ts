import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = Number(process.argv[2] ?? 7200);
const sampleEverySec = Number(process.argv[3] ?? 600);
const traceBreakers = process.argv.includes('--trace-breakers');

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
const breakerStats = new Map<string, { count: number; lastTimeSec: number; lastArgs: unknown[] }>();
if (traceBreakers) {
  const internals = sim as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of [
    'tryYieldInboundQueueEntrantsBlockingLoadedExits',
    'tryBreakAgentRefreshReciprocalEdgeFaceoff',
    'tryBreakAgentRefreshLoadedStorageSwap',
    'tryBreakAgentRefreshStorageColumnQueue',
    'tryClearTopLiftLoadedOutboundStorageExitBlockers',
    'tryClearTopLiftBottomLaneMeterBlockers',
    'tryBreakAgentRefreshColumnAccessStorageSwap',
    'tryBreakAgentRefreshTopLiftAdjacentNodeSwap',
    'tryBreakAgentRefreshWaitCycle',
    'tryYieldEmptyMiddleAccessAwayFromWaitCycle',
    'tryYieldEmptyBottomASpineAwayFromMiddleAccessCycle',
    'tryYieldEmptyStorageEntryAwayFromLoadedInbound',
    'tryBreakAgentRefreshTopLiftSpineCycle',
    'tryBreakAgentRefreshTopLiftQueueAccessParkingSwap',
    'tryBreakAgentRefreshTopLiftServiceClearanceCycle',
    'tryRetreatAgentRefreshNearFaceoff',
    'tryBreakPortalHoldCycle',
    'deadlockCandidateHasActiveRecovery'
  ]) {
    const original = internals[name];
    if (typeof original !== 'function') {
      continue;
    }
    internals[name] = (...args: unknown[]) => {
      const result = original.apply(sim, args);
      if (
        result === true ||
        name === 'tryYieldEmptyMiddleAccessAwayFromWaitCycle' ||
        name === 'tryYieldEmptyBottomASpineAwayFromMiddleAccessCycle' ||
        name === 'tryYieldEmptyStorageEntryAwayFromLoadedInbound'
      ) {
        const timeSec = sim.getClock().simTimeSec;
        const previous = breakerStats.get(name) ?? { count: 0, lastTimeSec: 0, lastArgs: [] };
        breakerStats.set(name, { count: previous.count + 1, lastTimeSec: timeSec, lastArgs: [...args, { result }] });
      }
      return result;
    };
  }
  const sideYieldOriginal = internals.installAgentRefreshSideYieldRoute;
  if (typeof sideYieldOriginal === 'function') {
    internals.installAgentRefreshSideYieldRoute = (...args: unknown[]) => {
      const vehicle = args[0] as { id?: string; currentNodeId?: string; targetNodeId?: string; waitReason?: string };
      const requester = args[1] as { id?: string; currentNodeId?: string; targetNodeId?: string; waitReason?: string };
      const blockedTargetNodeId = args[2];
      const route = args[3];
      console.log(JSON.stringify({
        type: 'side-yield-install-attempt',
        timeSec: sim.getClock().simTimeSec,
        vehicle: {
          id: vehicle?.id,
          currentNodeId: vehicle?.currentNodeId,
          targetNodeId: vehicle?.targetNodeId,
          waitReason: vehicle?.waitReason
        },
        requester: {
          id: requester?.id,
          currentNodeId: requester?.currentNodeId,
          targetNodeId: requester?.targetNodeId,
          waitReason: requester?.waitReason
        },
        blockedTargetNodeId,
        route
      }));
      const result = sideYieldOriginal.apply(sim, args);
      console.log(JSON.stringify({
        type: 'side-yield-install-result',
        timeSec: sim.getClock().simTimeSec,
        vehicleId: vehicle?.id,
        result
      }));
      return result;
    };
  }
}
sim.start();

let nextSampleSec = sampleEverySec;
while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const targetSec = Math.min(durationSec, nextSampleSec);
  sim.advanceByInPlace(targetSec - sim.getClock().simTimeSec);
  if (sim.getClock().simTimeSec + 1e-9 >= nextSampleSec || sim.getClock().simTimeSec >= durationSec - 1e-9) {
    const state = sim.getState();
    const internals = sim as unknown as {
      deadlockCandidateVehicleIds: () => string[];
      agentRefreshWaitingBlockedVehicleIds: () => string[];
      agentRefreshTopLiftSpineCycleWaitCandidateVehicleIds: () => string[];
    };
    console.log(JSON.stringify({
      timeSec: state.simTimeSec,
      deadlockCount: state.kpis.deadlockCount,
      deadlockCandidateSignature: state.kpis.deadlockCandidateSignature,
      deadlockCandidateSinceSec: state.kpis.deadlockCandidateSinceSec,
      deadlockCandidates: internals.deadlockCandidateVehicleIds(),
      nodeOccupiedCandidates: internals.agentRefreshWaitingBlockedVehicleIds(),
      topLiftSpineCandidates: internals.agentRefreshTopLiftSpineCycleWaitCandidateVehicleIds(),
      breakerStats: [...breakerStats.entries()]
        .map(([name, stats]) => ({ name, ...stats }))
        .filter((entry) => entry.lastTimeSec >= state.simTimeSec - sampleEverySec - 1e-9),
      waiting: state.vehicles
        .filter((vehicle) => vehicle.state === 'waiting-blocked')
        .map((vehicle) => ({
          id: vehicle.id,
          loaded: vehicle.loaded,
          state: vehicle.state,
          taskId: vehicle.taskId,
          currentNodeId: vehicle.currentNodeId,
          targetNodeId: vehicle.targetNodeId,
          plannedGoalNodeId: vehicle.plannedGoalNodeId,
          localRouteReason: vehicle.localRouteReason,
          routeNodeIds: vehicle.routeNodeIds,
          waitReason: vehicle.waitReason,
          blockingVehicleId: vehicle.blockingVehicleId,
          waitingSinceSec: (vehicle as { waitingSinceSec?: number | null }).waitingSinceSec ?? null
        }))
    }));
    nextSampleSec += sampleEverySec;
  }
}
