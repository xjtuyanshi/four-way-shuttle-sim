import type { ShuttleScenario } from '@four-way-shuttle/schemas';

import {
  createDefaultShuttleScenario,
  ShuttleSimCore,
  verticalStorageFootprintEdgeViolations
} from './index.js';

function runForWithStoragePathAssertions(sim: ShuttleSimCore, scenario: ShuttleScenario, durationSec: number, dtSec = 0.2, sampleSec = 5) {
  sim.start();
  let state = sim.getState();
  let nextSampleSec = 0;
  for (let elapsedSec = 0; elapsedSec < durationSec; elapsedSec = Number((elapsedSec + dtSec).toFixed(6))) {
    state = sim.step(dtSec);
    if (state.simTimeSec + 1e-6 >= nextSampleSec) {
      expectNoVerticalStorageFootprintTravel(scenario, state);
      expectNoLoadedStorageTransitThroughStoredLoads(state);
      nextSampleSec = Number((nextSampleSec + sampleSec).toFixed(6));
    }
  }
  return state;
}

function expectNoTrafficSafetyFailures(state: ReturnType<ShuttleSimCore['getState']>) {
  expect(state.kpis.deadlockCount).toBe(0);
  expect(state.kpis.livelockCount).toBe(0);
  expect(state.traffic.physicalViolationCount).toBe(0);
}

function edgeIdForRouteHop(scenario: ShuttleScenario, fromNodeId: string, toNodeId: string): string | null {
  const edge = scenario.layout.edges.find((candidate) =>
    (candidate.from === fromNodeId && candidate.to === toNodeId) ||
    (candidate.directionMode === 'twoWay' && candidate.from === toNodeId && candidate.to === fromNodeId)
  );
  return edge?.id ?? null;
}

function expectNoVerticalStorageFootprintTravel(scenario: ShuttleScenario, state: ReturnType<ShuttleSimCore['getState']>) {
  const forbiddenEdgeIds = new Set(verticalStorageFootprintEdgeViolations(scenario).map((violation) => violation.edgeId));
  const movingViolations = state.vehicles
    .filter((vehicle) => vehicle.currentEdgeId && forbiddenEdgeIds.has(vehicle.currentEdgeId))
    .map((vehicle) => `${vehicle.id}:${vehicle.currentEdgeId}`)
    .sort();
  const routeViolations = state.vehicles.flatMap((vehicle) => {
    const route = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
    return route.flatMap((nodeId, index) => {
      const nextNodeId = route[index + 1];
      if (!nextNodeId) return [];
      const edgeId = edgeIdForRouteHop(scenario, nodeId, nextNodeId);
      return edgeId && forbiddenEdgeIds.has(edgeId) ? [`${vehicle.id}:${edgeId}`] : [];
    });
  }).sort();

  expect({ movingViolations, routeViolations }).toEqual({ movingViolations: [], routeViolations: [] });
}

function storageFillHoles(nodeIds: string[]): string[] {
  const rows = new Map<string, number[]>();
  for (const nodeId of nodeIds) {
    const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
    if (!match) continue;
    rows.set(match[1]!, [...(rows.get(match[1]!) ?? []), Number(match[2])]);
  }

  const holes: string[] = [];
  for (const [row, columns] of rows) {
    const columnSet = new Set(columns);
    const maxColumn = Math.max(...columns);
    for (let column = 1; column <= maxColumn; column += 1) {
      if (!columnSet.has(column)) holes.push(`r${row}-c${String(column).padStart(2, '0')}`);
    }
  }
  return holes.sort();
}

function expectStorageTraversalOnlyHorizontal(routeNodeIds: string[]) {
  for (let index = 1; index < routeNodeIds.length; index += 1) {
    const from = /^storage-r(\d+)-c(\d+)$/.exec(routeNodeIds[index - 1]!);
    const to = /^storage-r(\d+)-c(\d+)$/.exec(routeNodeIds[index]!);
    if (from && to) {
      expect(to[1]).toBe(from[1]);
    }
  }
}

function expectNoLoadedStorageTransitThroughStoredLoads(state: ReturnType<ShuttleSimCore['getState']>) {
  const storedNodeIds = new Set(
    state.loads
      .filter((load) => load.state === 'stored' && load.nodeId?.startsWith('storage-'))
      .flatMap((load) => load.nodeId ? [load.nodeId] : [])
  );
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));

  for (const vehicle of state.vehicles.filter((candidate) => candidate.loaded && candidate.taskId)) {
    const task = taskById.get(vehicle.taskId!);
    if (!task) continue;
    const dropoffIndex = vehicle.routeNodeIds.indexOf(task.dropoffNodeId, vehicle.routeIndex);
    const loadedPath = dropoffIndex >= 0
      ? vehicle.routeNodeIds.slice(vehicle.routeIndex + 1, dropoffIndex)
      : vehicle.routeNodeIds.slice(vehicle.routeIndex + 1);
    expect(loadedPath.filter((nodeId) => storedNodeIds.has(nodeId))).toEqual([]);
  }
}

function expectIdleVehiclesParkedOnlyOnParkableNodes(scenario: ShuttleScenario, state: ReturnType<ShuttleSimCore['getState']>) {
  const nodesById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  for (const vehicle of state.vehicles.filter((candidate) => candidate.state === 'idle' && candidate.taskId === null)) {
    const node = nodesById.get(vehicle.currentNodeId);
    expect(node).toBeDefined();
    expect(node?.noParking).toBe(false);
    expect(node?.noStop).toBe(false);
    expect(['parking', 'storage']).toContain(node?.type);
  }
}

describe('shuttle phase 0 high-inbound SimCore', () => {
  it('keeps a 12-shuttle high-inbound stress run active without premature completion', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 7200,
      vehicles: {
        count: 12,
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        liftTimeSec: 0.05,
        lowerTimeSec: 0.05
      },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 80
      },
      trafficPolicy: {
        deadlockDetectSec: 20
      }
    });
    const state = runForWithStoragePathAssertions(new ShuttleSimCore(scenario), scenario, 120, 0.2, 30);
    const utilizedVehicleCount = Object.values(state.kpis.vehicleUtilization).filter((utilization) => utilization > 0.05).length;
    const utilizationBreakdowns = Object.values(state.kpis.vehicleUtilizationBreakdown);
    const averageBusyUtilization = utilizationBreakdowns.reduce((sum, value) => sum + value.busy, 0) / utilizationBreakdowns.length;
    const averageProductiveUtilization = utilizationBreakdowns.reduce((sum, value) => sum + value.productive, 0) / utilizationBreakdowns.length;
    const averageWaitingUtilization = utilizationBreakdowns.reduce((sum, value) => sum + value.waiting, 0) / utilizationBreakdowns.length;

    expect(state.status).toBe('running');
    expect(state.simTimeSec).toBe(120);
    expect(state.kpis.completedInbound).toBeGreaterThanOrEqual(1);
    expect(state.kpis.totalPph).toBeGreaterThanOrEqual(30);
    expect(state.kpis.activeTasks).toBeGreaterThanOrEqual(8);
    expect(state.kpis.queuedTasks).toBeGreaterThanOrEqual(0);
    expect(utilizedVehicleCount).toBeGreaterThanOrEqual(10);
    expect(utilizationBreakdowns).toHaveLength(12);
    expect(averageBusyUtilization).toBeGreaterThan(0.5);
    expect(averageProductiveUtilization).toBeGreaterThan(0.2);
    expect(averageProductiveUtilization).toBeLessThan(averageBusyUtilization);
    expect(averageWaitingUtilization).toBeGreaterThan(0);
    expect(
      state.traffic.liftPorts
        .filter((port) => port.kind === 'inbound')
        .reduce((total, port) => total + port.approachOccupancy, 0)
    ).toBeGreaterThanOrEqual(3);
    expect(state.kpis.blockedTimeByReasonSec['inbound-lift-source-full']).toBeGreaterThan(0);
    expect(Math.max(...state.traffic.liftPorts.filter((port) => port.kind === 'inbound').map((port) => port.utilization))).toBeLessThan(0.02);
    expectIdleVehiclesParkedOnlyOnParkableNodes(scenario, state);
    expect(storageFillHoles(state.loads.filter((load) => load.state === 'stored' && load.nodeId?.startsWith('storage-')).map((load) => load.nodeId!))).toEqual([]);
    expectNoLoadedStorageTransitThroughStoredLoads(state);
    for (const vehicle of state.vehicles) {
      expectStorageTraversalOnlyHorizontal(vehicle.routeNodeIds);
    }
    expectNoTrafficSafetyFailures(state);
  }, 90000);

  it('keeps long high-inbound pressure from deadlocking on storage-row entry parking', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 7200,
      timeStepSec: 1,
      vehicles: {
        count: 12,
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        liftTimeSec: 0.05,
        lowerTimeSec: 0.05
      },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 80
      },
      trafficPolicy: {
        deadlockDetectSec: 20
      }
    });
    const sim = new ShuttleSimCore(scenario);

    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-12')?.currentNodeId).toBe('storage-r09-c01');
    const state = runForWithStoragePathAssertions(sim, scenario, 240, 1, 30);
    const utilizedVehicleCount = Object.values(state.kpis.vehicleUtilization).filter((utilization) => utilization > 0.05).length;

    expect(state.status).toBe('running');
    expect(state.kpis.completedInbound).toBeGreaterThanOrEqual(5);
    expect(state.kpis.totalPph).toBeGreaterThan(50);
    expect(utilizedVehicleCount).toBeGreaterThanOrEqual(11);
    expect(
      Object.values(state.kpis.vehicleUtilization).reduce((total, utilization) => total + utilization, 0) /
      Object.values(state.kpis.vehicleUtilization).length
    ).toBeGreaterThan(0.6);
    expect(state.kpis.deadlockCount).toBe(0);
    expect(state.reservations.some((reservation) => reservation.reasonCode === 'zone-hold')).toBe(false);
    expect(state.traffic.legacyZoneHoldEnabled).toBe(false);
    expect(storageFillHoles(state.loads.filter((load) => load.state === 'stored' && load.nodeId?.startsWith('storage-')).map((load) => load.nodeId!))).toEqual([]);
    expectNoLoadedStorageTransitThroughStoredLoads(state);
    expectNoTrafficSafetyFailures(state);
  }, 60000);

  it('keeps the 8-shuttle agent-simple demo moving when loaded shuttles meet empty pickup traffic', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 7200,
      liftMode: 'all-inbound',
      vehicles: {
        count: 8,
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        liftTimeSec: 0.01,
        lowerTimeSec: 0.01
      },
      physicsParams: {
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        liftTimeSec: 0.01,
        lowerTimeSec: 0.01
      },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 16
      },
      trafficPolicy: {
        controllerMode: 'agent-simple',
        liftApproachCapacity: 8,
        minimumClearanceSec: 0.4,
        deadlockDetectSec: 20
      }
    });

    const state = runForWithStoragePathAssertions(new ShuttleSimCore(scenario), scenario, 180, 0.2, 30);

    expect(state.kpis.completedInbound).toBeGreaterThanOrEqual(8);
    expect(state.kpis.totalPph).toBeGreaterThan(100);
    expect(state.kpis.deadlockCount).toBe(0);
    expect(state.traffic.deadlockCandidateVehicleIds).toEqual([]);
    expect(state.traffic.waitingVehicles.length).toBeLessThan(8);
    expectNoTrafficSafetyFailures(state);
  }, 60000);

});
