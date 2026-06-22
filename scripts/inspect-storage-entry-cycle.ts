import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = Number(process.argv[2] ?? 12600);
const nodes = [
  'module-boundary-01-spine-middle',
  'column-middle-c15',
  'storage-r08-c15',
  'storage-r09-c15',
  'storage-r10-c15',
  'module-boundary-01-spine-bottom-a',
  'module-boundary-01-spine-top-b'
];

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
    console.error(JSON.stringify({
      type: 'inspect-progress',
      timeSec: sim.getClock().simTimeSec
    }));
    nextProgressSec += 600;
  }
}
const state = sim.getState();
const internals = sim as unknown as {
  currentNodeOccupancy: Map<string, string>;
  storedLoadIdAtNode: (nodeId: string) => string | null;
  nodeClaimedByOtherVehicle: (nodeId: string, vehicleId: string) => boolean;
  movingVehicleTargetingNode: (nodeId: string, vehicleId: string) => boolean;
  deadlockCandidateVehicleIds: () => string[];
  agentRefreshTemporaryStorageNodeAllowed: (vehicle: unknown, nodeId: string) => boolean;
  agentRefreshYieldPocketCompatibleWithRequester: (vehicle: unknown, nodeId: string, requester: unknown) => boolean;
  agentRefreshYieldPocketKeepsGoalReachable: (vehicle: unknown, nodeId: string) => boolean;
  agentRefreshYieldPocketCanReturn: (vehicle: unknown, nodeId: string, blockedTargetNodeId: string) => boolean;
  agentMinimalYieldFirstLegSafe: (vehicle: unknown, fromNodeId: string, toNodeId: string) => boolean;
  routeHasOnlyAdjacentEdges: (routeNodeIds: string[]) => boolean;
  agentRefreshLocalRouteNodesClear: (vehicle: unknown, routeNodeIds: string[]) => boolean;
  agentRefreshMoveBlocker: (vehicle: unknown, toNodeId: string, routeNodeIds: string[]) => unknown;
  topLiftTemporaryYieldRouteConflictsWithLoadedVerticalSpine: (vehicle: unknown, routeNodeIds: string[]) => boolean;
  topLiftTaskVehicleSideYieldRouteUsesDisallowedStorage: (vehicle: unknown, routeNodeIds: string[]) => boolean;
};
const sh06 = state.vehicles.find((vehicle) => vehicle.id === 'SH-06') ?? null;
const sh08 = state.vehicles.find((vehicle) => vehicle.id === 'SH-08') ?? null;
const candidateRoutes = [
  ['storage-r08-c15', 'storage-r09-c15'],
  ['storage-r08-c15', 'storage-r09-c15', 'storage-r10-c15'],
  ['storage-r08-c15', 'storage-r09-c15', 'storage-r10-c15', 'storage-r11-c15'],
  ['storage-r08-c15', 'storage-r09-c15', 'storage-r10-c15', 'storage-r11-c15', 'storage-r12-c15']
];

console.log(JSON.stringify({
  simTimeSec: state.simTimeSec,
  deadlockCount: state.kpis.deadlockCount,
  deadlockCandidates: internals.deadlockCandidateVehicleIds(),
  nodes: nodes.map((nodeId) => ({
    nodeId,
    occupantId: internals.currentNodeOccupancy.get(nodeId) ?? null,
    storedLoadId: internals.storedLoadIdAtNode(nodeId),
    claimedBy: state.vehicles
      .filter((vehicle) => internals.nodeClaimedByOtherVehicle(nodeId, vehicle.id))
      .map((vehicle) => vehicle.id),
    targetedBy: state.vehicles
      .filter((vehicle) => internals.movingVehicleTargetingNode(nodeId, vehicle.id))
      .map((vehicle) => vehicle.id),
    neighbors: scenario.layout.edges
      .filter((edge) => edge.from === nodeId || edge.to === nodeId)
      .map((edge) => edge.from === nodeId ? edge.to : edge.from)
      .sort()
  })),
  vehicles: state.vehicles
    .filter((vehicle) =>
      ['SH-05', 'SH-06', 'SH-08'].includes(vehicle.id) ||
      nodes.includes(vehicle.currentNodeId) ||
      (vehicle.targetNodeId !== null && nodes.includes(vehicle.targetNodeId))
    )
    .map((vehicle) => ({
      id: vehicle.id,
      loaded: vehicle.loaded,
      state: vehicle.state,
      taskId: vehicle.taskId,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      waitReason: vehicle.waitReason,
      blockingVehicleId: vehicle.blockingVehicleId,
      routeNodeIds: vehicle.routeNodeIds,
      localRouteReason: vehicle.localRouteReason
    })),
  candidateRoutes: sh06 && sh08
    ? candidateRoutes.map((route) => {
      const terminal = route[route.length - 1]!;
      return {
        route,
        terminal,
        stored: route.map((nodeId) => [nodeId, internals.storedLoadIdAtNode(nodeId)]),
        occupied: route.map((nodeId) => [nodeId, internals.currentNodeOccupancy.get(nodeId) ?? null]),
        claimed: route.map((nodeId) => [nodeId, internals.nodeClaimedByOtherVehicle(nodeId, sh06.id)]),
        tempAllowed: internals.agentRefreshTemporaryStorageNodeAllowed(sh06, terminal),
        compatible: internals.agentRefreshYieldPocketCompatibleWithRequester(sh06, terminal, sh08),
        keepsGoalReachable: internals.agentRefreshYieldPocketKeepsGoalReachable(sh06, terminal),
        canReturn: internals.agentRefreshYieldPocketCanReturn(sh06, terminal, 'column-middle-c15'),
        firstLegSafe: internals.agentMinimalYieldFirstLegSafe(sh06, sh06.currentNodeId, route[1]!),
        adjacent: internals.routeHasOnlyAdjacentEdges(route),
        localClear: internals.agentRefreshLocalRouteNodesClear(sh06, route),
        moveBlocker: internals.agentRefreshMoveBlocker(sh06, route[1]!, route),
        verticalConflict: internals.topLiftTemporaryYieldRouteConflictsWithLoadedVerticalSpine(sh06, route),
        disallowedStorage: internals.topLiftTaskVehicleSideYieldRouteUsesDisallowedStorage(sh06, route)
      };
    })
    : []
}, null, 2));
