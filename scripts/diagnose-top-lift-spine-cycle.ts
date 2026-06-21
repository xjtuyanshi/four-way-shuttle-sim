import {
  createInboundOutboundDemoScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

const timeSec = Number(process.argv[2] ?? 1850);

const scenario = createInboundOutboundDemoScenario({
  durationSec: timeSec,
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
sim.advanceByInPlace(timeSec);

const engine = sim as unknown as Record<string, any>;
const vehicles = engine.vehicles as Array<Record<string, any>>;
const ids = ['SH-01', 'SH-02', 'SH-04', 'SH-05', 'SH-07'];

console.log(JSON.stringify({
  timeSec: sim.getClock().simTimeSec,
  vehicles: ids.map((id) => summarizeVehicle(vehicles.find((vehicle) => vehicle.id === id)))
}, null, 2));

for (const id of ['SH-07', 'SH-04', 'SH-02']) {
  const vehicle = vehicles.find((entry) => entry.id === id);
  if (!vehicle) {
    continue;
  }
  console.log(JSON.stringify({
    id,
    task: engine.taskForVehicle(vehicle),
    neighbors: engine.neighbors(vehicle.currentNodeId).map((neighbor: { nodeId: string }) =>
      inspectCandidate(engine, vehicle, neighbor.nodeId)
    )
  }, null, 2));
}

const sh07 = vehicles.find((entry) => entry.id === 'SH-07');
if (sh07) {
  const before = summarizeVehicle(sh07);
  const moved = engine.tryMoveAgentRefreshTopLiftLoadedDownAside(sh07, sh07.currentNodeId, sh07.targetNodeId);
  console.log(JSON.stringify({
    method: 'tryMoveAgentRefreshTopLiftLoadedDownAside',
    moved,
    before,
    after: summarizeVehicle(sh07)
  }, null, 2));
}

function summarizeVehicle(vehicle: Record<string, any> | undefined): Record<string, unknown> | null {
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
    waitReason: vehicle.waitReason,
    blockingVehicleId: vehicle.blockingVehicleId,
    routeIndex: vehicle.routeIndex,
    routeNodeIds: vehicle.routeNodeIds?.slice(0, 12),
    localRouteReason: vehicle.localRouteReason,
    localRouteNodeIds: vehicle.localRouteNodeIds?.slice(0, 12)
  };
}

function inspectCandidate(
  engine: Record<string, any>,
  vehicle: Record<string, any>,
  nodeId: string
): Record<string, unknown> {
  const route = [vehicle.currentNodeId, nodeId];
  return {
    nodeId,
    type: engine.layoutNode(nodeId)?.type ?? null,
    noStop: Boolean(engine.layoutNode(nodeId)?.noStop),
    noParking: Boolean(engine.layoutNode(nodeId)?.noParking),
    occupiedBy: engine.currentNodeOccupancy.get(nodeId) ?? null,
    claimedBy: engine.nodeClaimedByOtherVehicle(nodeId, vehicle.id),
    topLiftColumnSpineOrAccess: engine.topLiftColumnSpineOrAccessNode(nodeId),
    yieldPocketAllowed: engine.agentRefreshYieldPocketAllowed(vehicle, nodeId),
    keepsGoalReachable: engine.agentRefreshYieldPocketKeepsGoalReachable(vehicle, nodeId),
    firstLegSafe: engine.agentMinimalYieldFirstLegSafe(vehicle, vehicle.currentNodeId, nodeId),
    localRouteClear: engine.agentRefreshLocalRouteNodesClear(vehicle, route),
    loadedVerticalConflict: engine.topLiftTemporaryYieldRouteConflictsWithLoadedVerticalSpine(vehicle, route),
    moveBlock: engine.agentRefreshMoveBlocker(vehicle, nodeId, route)
  };
}
