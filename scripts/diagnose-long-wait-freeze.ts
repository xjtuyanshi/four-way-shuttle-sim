import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const sampleTimesSec = (process.argv[2] ?? '14400,16800,18000,21600')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)
  .sort((left, right) => left - right);

const trackedVehicleIds = new Set((process.argv[3] ?? 'SH-01,SH-02,SH-05,SH-06,SH-07')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean));

const durationSec = sampleTimesSec.at(-1) ?? 21600;
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

for (const sampleTimeSec of sampleTimesSec) {
  const deltaSec = sampleTimeSec - sim.getClock().simTimeSec;
  if (deltaSec > 0) {
    sim.advanceByInPlace(deltaSec);
  }
  const state = sim.getState();
  const vehicles = state.vehicles.filter((vehicle) =>
    trackedVehicleIds.has(vehicle.id) ||
    vehicle.state === 'waiting-blocked' ||
    state.vehicles.some((other) => other.blockingVehicleId === vehicle.id)
  );
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  console.log(JSON.stringify({
    type: 'long-wait-freeze-sample',
    timeSec: state.simTimeSec,
    kpis: {
      inboundPph: state.kpis.inboundPph,
      outboundPph: state.kpis.outboundPph,
      totalPph: state.kpis.totalPph,
      windowInboundPph: state.kpis.windowInboundPph,
      windowOutboundPph: state.kpis.windowOutboundPph,
      windowTotalPph: state.kpis.windowTotalPph,
      queuedTasks: state.kpis.queuedTasks,
      activeTasks: state.kpis.activeTasks,
      deadlockCount: state.kpis.deadlockCount
    },
    waitingVehicles: state.traffic.waitingVehicles,
    vehicles: vehicles.map((vehicle) => {
      const task = vehicle.taskId ? tasksById.get(vehicle.taskId) : null;
      return {
        id: vehicle.id,
        state: vehicle.state,
        loaded: vehicle.loaded,
        taskId: vehicle.taskId,
        taskKind: task?.kind ?? null,
        pickupNodeId: task?.pickupNodeId ?? null,
        dropoffNodeId: task?.dropoffNodeId ?? null,
        currentNodeId: vehicle.currentNodeId,
        targetNodeId: vehicle.targetNodeId,
        plannedGoalNodeId: vehicle.plannedGoalNodeId,
        routeNodeIds: vehicle.routeNodeIds,
        plannedRouteNodeIds: vehicle.plannedRouteNodeIds,
        localRouteNodeIds: vehicle.localRouteNodeIds,
        localRouteReason: vehicle.localRouteReason,
        waitReason: vehicle.waitReason,
        blockingVehicleId: vehicle.blockingVehicleId,
        blockedTimeSec: vehicle.blockedTimeSec,
        speedMps: vehicle.speedMps,
        x: vehicle.x,
        z: vehicle.z
      };
    })
  }));
}
