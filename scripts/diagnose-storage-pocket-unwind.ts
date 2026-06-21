import {
  createInboundOutboundDemoScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

const timeSec = Number(process.argv[2] ?? 700);

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
const pairSpecs = [
  ['SH-01', 'SH-04'],
  ['SH-06', 'SH-03']
];

for (const [yielderId, winnerId] of pairSpecs) {
  const yielder = vehicles.find((vehicle) => vehicle.id === yielderId);
  const winner = vehicles.find((vehicle) => vehicle.id === winnerId);
  if (!yielder || !winner) {
    continue;
  }

  console.log(JSON.stringify({
    pair: `${yielderId}<-${winnerId}`,
    yielder: summarizeVehicle(yielder),
    winner: summarizeVehicle(winner),
    task: engine.taskForVehicle(winner),
    winnerRouteTail: engine.vehicleRouteTail(winner, winner.routeNodeIds),
    edgeWinnerToYielder: Boolean(engine.traffic.findEdge(winner.currentNodeId, yielder.currentNodeId)),
    helperResult: {
      topLiftColumnLayout: engine.topLiftColumnLayoutEnabled(),
      yielderIsStorage: engine.isStorageNode(yielder.currentNodeId),
      winnerBottomA: isBottomA(winner.currentNodeId),
      winnerState: winner.state,
      winnerWaitReason: winner.waitReason,
      winnerBlocksOnYielder: winner.blockingVehicleId === yielder.id,
      winnerTargetsYielder: winner.targetNodeId === yielder.currentNodeId,
      winnerTaskKind: engine.taskForVehicle(winner)?.kind ?? null
    },
    neighbors: engine.neighbors(winner.currentNodeId).map((neighbor: { nodeId: string; lengthM: number }) =>
      inspectCandidate(engine, winner, yielder, neighbor.nodeId)
    )
  }, null, 2));

  const before = summarizeVehicle(winner);
  const installed = engine.agentRefreshInstallSideYield(winner, yielder.currentNodeId, yielder, null);
  console.log(JSON.stringify({
    pair: `${yielderId}<-${winnerId}`,
    directInstallResult: installed,
    winnerBefore: before,
    winnerAfter: summarizeVehicle(winner)
  }, null, 2));
}

function summarizeVehicle(vehicle: Record<string, any>): Record<string, unknown> {
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
  winner: Record<string, any>,
  yielder: Record<string, any>,
  nodeId: string
): Record<string, unknown> {
  const blockedTargetNodeId = yielder.currentNodeId;
  const forbiddenNodeIds = new Set<string>([winner.currentNodeId, blockedTargetNodeId, yielder.currentNodeId]);
  if (yielder.targetNodeId) {
    forbiddenNodeIds.add(yielder.targetNodeId);
  }
  const requesterContinuationNodeId = engine.agentRouteNodeAfter(yielder, blockedTargetNodeId);
  if (requesterContinuationNodeId) {
    forbiddenNodeIds.add(requesterContinuationNodeId);
  }
  for (const protectedNodeId of engine.agentRefreshRequesterProtectedRouteNodeIds(yielder)) {
    forbiddenNodeIds.add(protectedNodeId);
  }
  for (const protectedNodeId of engine.topLiftOutboundClearanceProtectedRouteNodeIds(yielder)) {
    forbiddenNodeIds.add(protectedNodeId);
  }
  for (const protectedNodeId of engine.agentRefreshLoadedRequesterProtectedRouteNodeIds(yielder)) {
    forbiddenNodeIds.add(protectedNodeId);
  }
  for (const protectedNodeId of engine.agentRefreshLoadedTrafficProtectedRouteNodeIds(winner)) {
    forbiddenNodeIds.add(protectedNodeId);
  }

  const directRoute = [winner.currentNodeId, nodeId];
  const holdRoute = engine.extendTopLiftTemporaryYieldRouteToHold(
    winner,
    directRoute,
    new Set([blockedTargetNodeId, yielder.currentNodeId])
  );
  return {
    nodeId,
    type: engine.layoutNode(nodeId)?.type ?? null,
    noStop: Boolean(engine.layoutNode(nodeId)?.noStop),
    noParking: Boolean(engine.layoutNode(nodeId)?.noParking),
    occupiedBy: engine.currentNodeOccupancy.get(nodeId) ?? null,
    claimedBy: engine.nodeClaimedByOtherVehicle(nodeId, winner.id),
    forbidden: forbiddenNodeIds.has(nodeId),
    tempAllowed: engine.topLiftEmptyTemporaryYieldNodeAllowed(winner, nodeId),
    pocketAllowed: engine.agentRefreshYieldPocketAllowed(winner, nodeId),
    compatible: engine.agentRefreshYieldPocketCompatibleWithRequester(winner, nodeId, yielder),
    keepsGoalReachable: engine.agentRefreshYieldPocketKeepsGoalReachable(winner, nodeId),
    canReturn: engine.agentRefreshYieldPocketCanReturn(winner, nodeId, blockedTargetNodeId),
    movesAway: engine.agentRefreshYieldPocketMovesAwayFromBlockedTransfer(winner, nodeId, blockedTargetNodeId),
    firstLegSafe: engine.agentMinimalYieldFirstLegSafe(winner, winner.currentNodeId, nodeId),
    conflictsLoadedVertical: engine.topLiftTemporaryYieldRouteConflictsWithLoadedVerticalSpine(winner, directRoute),
    holdRoute
  };
}

function isBottomA(nodeId: string): boolean {
  return /^column-bottom-a-c\d+$/.test(nodeId) ||
    /^(module-\d+|module-boundary-\d+)-spine-bottom-a$/.test(nodeId);
}
