import {
  createInboundOutboundDemoScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

const dtSec = 0.2;
const endSec = 676.6;
const traceStartSec = 674;
const traceEndSec = 676.6;

const scenario = createInboundOutboundDemoScenario({
  durationSec: endSec,
  timeStepSec: dtSec,
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
const core = sim as unknown as Record<string, (...args: unknown[]) => unknown>;

for (const name of [
  'agentRouteToGoal',
  'existingRouteTailToGoal',
  'agentRefreshNominalRouteToGoal',
  'installAgentRefreshPlannedRoute',
  'agentRefreshLoadedInboundRouteToDropoff',
  'agentRefreshHandleMoveBlock',
  'beginAgentSimpleLeg',
  'startNextLeg',
  'startNextLegAgentSimple'
]) {
  const original = core[name];
  if (typeof original !== 'function') {
    continue;
  }
  core[name] = function tracedMethod(...args: unknown[]): unknown {
    const timeSec = sim.getClock().simTimeSec;
    const vehicle = args.find((arg) => typeof arg === 'object' && arg !== null && (arg as { id?: unknown }).id === 'SH-06') as
      | Record<string, unknown>
      | undefined;
    const shouldTrace = Boolean(vehicle && timeSec >= traceStartSec && timeSec <= traceEndSec);
    if (shouldTrace) {
      console.log(JSON.stringify({
        t: round(timeSec),
        phase: 'before',
        method: name,
        vehicle: vehicleState(vehicle),
        args: summarizeArgs(args)
      }));
    }
    const result = original.apply(this, args);
    if (shouldTrace) {
      console.log(JSON.stringify({
        t: round(timeSec),
        phase: 'after',
        method: name,
        vehicle: vehicleState(vehicle!),
        args: summarizeArgs(args),
        result: Array.isArray(result) ? result : result === true || result === false ? result : null
      }));
    }
    return result;
  };
}

sim.start();
while (sim.getClock().simTimeSec < endSec - 1e-9 && sim.getClock().status === 'running') {
  const state = sim.step(Math.min(dtSec, endSec - sim.getClock().simTimeSec));
  if (state.simTimeSec >= traceStartSec && state.simTimeSec <= traceEndSec) {
    const vehicle = state.vehicles.find((candidate) => candidate.id === 'SH-06');
    if (vehicle) {
      console.log(JSON.stringify({
        t: round(state.simTimeSec),
        phase: 'sample',
        vehicle: vehicleState(vehicle as unknown as Record<string, unknown>),
        probes: probeNodes()
      }));
    }
  }
}

function vehicleState(vehicle: Record<string, unknown>): Record<string, unknown> {
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
    waitReason: vehicle.waitReason,
    routeNodeIds: vehicle.routeNodeIds
  };
}

function summarizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg !== 'object' || arg === null) {
      return arg;
    }
    const record = arg as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.kind === 'string') {
      return {
        type: 'task',
        id: record.id,
        kind: record.kind,
        state: record.state,
        pickupNodeId: record.pickupNodeId,
        dropoffNodeId: record.dropoffNodeId,
        vehicleId: record.vehicleId
      };
    }
    if (record.id === 'SH-06') {
      return { type: 'vehicle', id: record.id };
    }
    return { type: 'object' };
  });
}

function probeNodes(): Record<string, unknown> {
  const storedLoadIdAtNode = core.storedLoadIdAtNode?.bind(core);
  const occupancy = (sim as unknown as { currentNodeOccupancy?: Map<string, string> }).currentNodeOccupancy;
  const claims = (sim as unknown as { nodeClaims?: Map<string, string> }).nodeClaims;
  const nodes = ['storage-r07-c05', 'column-middle-c05', 'storage-r08-c05'];
  return Object.fromEntries(nodes.map((nodeId) => [
    nodeId,
    {
      storedLoadId: typeof storedLoadIdAtNode === 'function' ? storedLoadIdAtNode(nodeId) : null,
      occupantId: occupancy?.get(nodeId) ?? null,
      claimId: claims?.get(nodeId) ?? null
    }
  ]));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
