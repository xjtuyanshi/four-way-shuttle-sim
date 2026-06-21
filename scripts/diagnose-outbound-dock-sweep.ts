import {
  createInboundOutboundDemoScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

const targetSec = Number(process.argv[2] ?? 683.2);
const vehicleId = process.argv[3] ?? 'SH-06';

const scenario = createInboundOutboundDemoScenario({
  durationSec: targetSec + 1,
  timeStepSec: 0.2,
  vehicles: { count: 8 },
  taskGeneration: {
    inboundRatePerHour: 3600,
    outboundRatePerHour: 3600,
    inboundOutboundMix: 0.5,
    initialStorageFillPolicy: 'full-columns',
    initialOutboundFullColumns: 4
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: 2
  }
});

const sim = new ShuttleSimCore(scenario);
sim.start();
while (sim.getClock().simTimeSec < targetSec - 1e-9 && sim.getClock().status === 'running') {
  sim.advanceByInPlace(Math.min(0.2, targetSec - sim.getClock().simTimeSec));
}

const state = sim.getState();
const internals = sim as unknown as {
  activeTopLiftOutboundDockSweepBlockedNodeIds: (requesterVehicleId: string) => Set<string>;
  activeTopLiftOutboundDockBlockedNodeIds: (requesterVehicleId: string) => Set<string>;
};

console.log(JSON.stringify({
  timeSec: state.simTimeSec,
  vehicle: state.vehicles.find((vehicle) => vehicle.id === vehicleId),
  activeSweepBlocks: [...internals.activeTopLiftOutboundDockSweepBlockedNodeIds(vehicleId)].sort(),
  activeDockBlocks: [...internals.activeTopLiftOutboundDockBlockedNodeIds(vehicleId)].sort(),
  loadedOutboundVehicles: state.vehicles
    .filter((vehicle) => vehicle.loaded && vehicle.taskId)
    .map((vehicle) => {
      const task = state.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null;
      return {
        id: vehicle.id,
        taskKind: task?.kind ?? null,
        taskState: task?.state ?? null,
        currentNodeId: vehicle.currentNodeId,
        targetNodeId: vehicle.targetNodeId,
        plannedGoalNodeId: vehicle.plannedGoalNodeId,
        routeNodeIds: vehicle.routeNodeIds
      };
    })
}, null, 2));
