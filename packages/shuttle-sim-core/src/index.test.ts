import { ShuttleScenarioSchema, ShuttleSimStateSchema, type ShuttleScenario } from '@four-way-shuttle/schemas';

import goldenStaticSceneContract from '../../../config/shuttle/static-scene-contract.golden.json';
import {
  ShuttleSimCore,
  REQUIRED_CALIBRATION_DIMENSION_KEYS,
  calculateTravelTimeSec,
  createDefaultShuttleScenario,
  hashEventLog,
  motionProfileAt,
  summarizeScenarioStaticSceneContract,
  verticalStorageFootprintEdgeViolations
} from './index.js';

function testScenario(overrides: Partial<ShuttleScenario>): ShuttleScenario {
  const base: ShuttleScenario = {
    schemaVersion: 'shuttle.phase0.v0',
    id: 'test-scenario',
    name: 'Test Scenario',
    seed: 7,
    durationSec: 60,
    timeStepSec: 0.2,
    vehicles: {
      count: 2,
      lengthM: 1,
      widthM: 1,
      heightM: 0.2,
      emptySpeedMps: 1,
      loadedSpeedMps: 0.7,
      accelerationMps2: 1,
      switchDirectionSec: 0,
      liftTimeSec: 0,
      lowerTimeSec: 0,
      maxLoadKg: 1000,
      safetyRadiusM: 0.4,
      batteryEnabled: false,
      initialSoc: 1
    },
    layout: {
      units: 'meter',
      calibrationProfile: null,
      nodes: [
        { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
        { id: 'B', type: 'parking', x: 4, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
      ],
      edges: [
        { id: 'A-B', from: 'A', to: 'B', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-B', noParking: true }
      ],
      zones: []
    },
    taskGeneration: {
      inboundRatePerHour: 0,
      outboundRatePerHour: 0,
      inboundOutboundMix: 0.5,
      arrivalDistribution: 'deterministic',
      maxTasks: 1
    },
    physicsParams: {
      emptySpeedMps: 1,
      loadedSpeedMps: 0.7,
      accelerationMps2: 1,
      switchDirectionSec: 0,
      liftTimeSec: 0,
      lowerTimeSec: 0,
      loadedClearanceM: 0.2,
      reservationClearanceSec: 0.2
    },
    routingPolicy: {
      algorithm: 'astar',
      allowReplan: true,
      routeTimeoutSec: 12,
      maxReplansPerTask: 3
    },
    trafficPolicy: {
      edgeCapacity: 1,
      nodeCapacity: 1,
      zoneCapacity: 1,
      liftApproachCapacity: 1,
      minimumClearanceSec: 0.2,
      priorityAgingSec: 20,
      deadlockDetectSec: 1,
      deadlockBreakPolicy: 'oldest-waits-wins'
    }
  };
  return ShuttleScenarioSchema.parse({
    ...base,
    ...overrides,
    vehicles: { ...base.vehicles, ...overrides.vehicles },
    layout: { ...base.layout, ...overrides.layout },
    taskGeneration: { ...base.taskGeneration, ...overrides.taskGeneration },
    physicsParams: { ...base.physicsParams, ...overrides.physicsParams },
    routingPolicy: { ...base.routingPolicy, ...overrides.routingPolicy },
    trafficPolicy: { ...base.trafficPolicy, ...overrides.trafficPolicy }
  });
}

function runFor(sim: ShuttleSimCore, durationSec: number, dtSec = 0.2) {
  sim.start();
  for (let elapsedSec = 0; elapsedSec < durationSec; elapsedSec = Number((elapsedSec + dtSec).toFixed(6))) {
    sim.step(dtSec);
  }
  return sim.getState();
}

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

function addStoredLoads(sim: ShuttleSimCore, nodeIds: string[]) {
  nodeIds.forEach((nodeId, index) => {
    sim.addLoadForTest({
      id: `stored-${String(index + 1).padStart(4, '0')}`,
      state: 'stored',
      nodeId,
      vehicleId: null,
      weightKg: 100
    });
  });
}

function crossRowStorageHops(routeNodeIds: string[]): Array<[string, string]> {
  const storageRow = (nodeId: string): string | null => /^storage-r(\d+)-c\d+$/.exec(nodeId)?.[1] ?? null;
  const hops: Array<[string, string]> = [];
  for (let index = 1; index < routeNodeIds.length; index += 1) {
    const from = routeNodeIds[index - 1]!;
    const to = routeNodeIds[index]!;
    const fromRow = storageRow(from);
    const toRow = storageRow(to);
    if (fromRow && toRow && fromRow !== toRow) {
      hops.push([from, to]);
    }
  }
  return hops;
}

function storageRowsInRoute(routeNodeIds: string[]): string[] {
  return [...new Set(routeNodeIds.flatMap((nodeId) => {
    const match = /^storage-r(\d+)-c\d+$/.exec(nodeId);
    return match ? [match[1]!] : [];
  }))];
}

function storageColumn(nodeId: string): number | null {
  return Number(/^storage-r\d+-c(\d+)$/.exec(nodeId)?.[1] ?? NaN) || null;
}

function storageFillHoles(nodeIds: string[]): string[] {
  const rows = new Map<string, number[]>();
  for (const nodeId of nodeIds) {
    const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
    if (!match) {
      continue;
    }
    rows.set(match[1]!, [...(rows.get(match[1]!) ?? []), Number(match[2])]);
  }

  const holes: string[] = [];
  for (const [row, columns] of rows) {
    const columnSet = new Set(columns);
    const maxColumn = Math.max(...columns);
    for (let column = 1; column <= maxColumn; column += 1) {
      if (!columnSet.has(column)) {
        holes.push(`r${row}-c${String(column).padStart(2, '0')}`);
      }
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
      if (!nextNodeId) {
        return [];
      }
      const edgeId = edgeIdForRouteHop(scenario, nodeId, nextNodeId);
      return edgeId && forbiddenEdgeIds.has(edgeId) ? [`${vehicle.id}:${edgeId}`] : [];
    });
  }).sort();

  expect({ movingViolations, routeViolations }).toEqual({ movingViolations: [], routeViolations: [] });
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
    if (!task) {
      continue;
    }
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

function verifiedCalibrationDimensions(): NonNullable<ShuttleScenario['layout']['calibrationProfile']>['dimensions'] {
  const currentAssumptionValues = new Map(
    createDefaultShuttleScenario().layout.calibrationProfile?.dimensions.map((dimension) => [dimension.key, dimension.valueM])
  );
  return REQUIRED_CALIBRATION_DIMENSION_KEYS.map((key) => ({
    key,
    label: key,
    valueM: currentAssumptionValues.get(key) ?? 1,
    source: 'cad' as const,
    confidence: 'high' as const
  }));
}

describe('shuttle phase 0 SimCore', () => {
  it('validates the default phase 0 scenario schema', () => {
    const scenario = createDefaultShuttleScenario();
    const parsed = ShuttleScenarioSchema.parse(scenario);

    expect(parsed.schemaVersion).toBe('shuttle.phase0.v0');
    expect(parsed.vehicles.safetyRadiusM).toBe(0.1);
    expect(parsed.physicsParams.liftTimeSec).toBe(0.05);
    expect(parsed.physicsParams.lowerTimeSec).toBe(0.05);
    expect(parsed.layout.nodes.filter((node) => node.type === 'lift-blackbox').map((node) => node.id).sort()).toEqual([
      'inbound-lift-bottom-01',
      'inbound-lift-bottom-02',
      'inbound-lift-top-01',
      'inbound-lift-top-02',
      'outbound-lift-bottom-01',
      'outbound-lift-bottom-02',
      'outbound-lift-top-01',
      'outbound-lift-top-02'
    ]);
    expect(parsed.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')).toHaveLength(4);
    expect(parsed.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound')).toHaveLength(4);
    expect(parsed.layout.nodes.filter((node) => node.type === 'parking' && !node.noParking).map((node) => node.id).sort()).toEqual([
      'parking-a',
      'parking-b',
      'parking-c',
      'parking-d',
      'parking-e',
      'parking-f',
      'parking-g',
      'parking-h'
    ]);
    expect(parsed.layout.nodes.filter((node) => node.id.includes('-stage-') && node.type === 'parking' && node.noParking)).toHaveLength(12);
    expect(parsed.layout.zones.some((zone) => zone.noStop && zone.noParking)).toBe(true);
    expect(parsed.layout.calibrationProfile).toMatchObject({
      id: 'phase0-cad-assumption-v1',
      status: 'assumption',
      units: 'meter'
    });
    expect(parsed.layout.calibrationProfile?.blockedCells).toEqual([]);
    expect(parsed.layout.calibrationProfile?.dimensions.map((dimension) => dimension.key)).toEqual([
      'storageCellPitchX',
      'storageCellPitchZ',
      'storageBayGapX',
      'mainLaneCenterSpacingZ',
      'innerStorageBankGapZ',
      'liftStandoffZ',
      'sideClearanceX'
    ]);
  });

  it('can create an all-inbound lift layout with staging for every lift position', () => {
    const scenario = createDefaultShuttleScenario({ liftMode: 'all-inbound', vehicles: { count: 8 } });
    const parsed = ShuttleScenarioSchema.parse(scenario);
    const liftNodes = parsed.layout.nodes.filter((node) => node.type === 'lift-blackbox');

    expect(liftNodes).toHaveLength(8);
    expect(liftNodes.every((node) => node.liftKind === 'inbound')).toBe(true);
    expect(parsed.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound')).toHaveLength(0);
    expect(parsed.layout.nodes.filter((node) => node.id.includes('-stage-') && node.type === 'parking' && node.noParking)).toHaveLength(24);
    for (const lift of liftNodes) {
      expect(parsed.layout.nodes.filter((node) => node.id.startsWith(`${lift.id}-stage-`))).toHaveLength(3);
    }

    const state = new ShuttleSimCore(scenario).getState();
    expect(state.traffic.liftPorts.filter((port) => port.kind === 'inbound')).toHaveLength(8);
    expect(state.traffic.liftPorts.filter((port) => port.kind === 'outbound')).toHaveLength(0);
  });

  it('limits generated inbound source loads to one waiting pallet per lift', () => {
    const scenario = createDefaultShuttleScenario({
      liftMode: 'all-inbound',
      vehicles: { count: 8 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 16
      },
      physicsParams: {
        liftTimeSec: 0.01,
        lowerTimeSec: 0.01
      },
      trafficPolicy: {
        liftApproachCapacity: 8
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.start();
    for (let index = 0; index < 80; index += 1) {
      sim.step(0.2);
    }

    const state = sim.getState();
    const inboundLiftIds = new Set(
      scenario.layout.nodes
        .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
        .map((node) => node.id)
    );
    const waitingSourceLoads = state.loads.filter((load) =>
      load.state === 'waiting' &&
      load.nodeId !== null &&
      inboundLiftIds.has(load.nodeId)
    );
    const waitingLoadsByLift = new Map<string, number>();
    for (const load of waitingSourceLoads) {
      waitingLoadsByLift.set(load.nodeId!, (waitingLoadsByLift.get(load.nodeId!) ?? 0) + 1);
    }

    expect(waitingSourceLoads.length).toBeLessThanOrEqual(inboundLiftIds.size);
    expect(Math.max(0, ...waitingLoadsByLift.values())).toBeLessThanOrEqual(1);
    expect(state.tasks.filter((task) => task.kind === 'inbound' && task.state === 'assigned')).toHaveLength(8);
    expect(state.tasks.length).toBeLessThanOrEqual(16);
  });

  it('parses legacy state diagnostics without lift-port allocation details', () => {
    const state = new ShuttleSimCore(createDefaultShuttleScenario()).getState();
    const legacyTraffic: Record<string, unknown> = { ...state.traffic };
    delete legacyTraffic.liftPorts;

    const parsed = ShuttleSimStateSchema.parse({ ...state, traffic: legacyTraffic });

    expect(parsed.traffic.liftPorts).toEqual([]);
  });

  it('starts eight-shuttle smoke runs from distinct staged parking positions', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({ vehicles: { count: 8 } }));
    const state = sim.getState();
    const debug = sim.getDebugState();

    expect(state.vehicles.map((vehicle) => vehicle.currentNodeId).sort()).toEqual([
      'parking-a',
      'parking-b',
      'parking-c',
      'parking-d',
      'parking-e',
      'parking-f',
      'parking-g',
      'parking-h'
    ]);
    expect(debug.currentNodeOccupancy.map((occupancy) => occupancy.nodeId).sort()).toEqual([
      'parking-a',
      'parking-b',
      'parking-c',
      'parking-d',
      'parking-e',
      'parking-f',
      'parking-g',
      'parking-h'
    ]);
  });

  it('uses storage cells as under-load temporary parking beyond dedicated pads', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({ vehicles: { count: 12 } }));
    const state = sim.getState();
    const storageParkedVehicle = state.vehicles.find((vehicle) => vehicle.id === 'SH-09');
    const storageParkedNodeIds = state.vehicles.slice(8).map((vehicle) => vehicle.currentNodeId);

    expect(storageParkedVehicle?.currentNodeId).toMatch(/^storage-r\d+-c\d+$/);
    expect(storageParkedNodeIds).toEqual([
      'storage-r16-c01',
      'storage-r15-c01',
      'storage-r14-c01',
      'storage-r13-c01'
    ]);
    sim.addLoadForTest({
      id: 'load-above-sh-09',
      state: 'stored',
      nodeId: storageParkedVehicle!.currentNodeId,
      vehicleId: null,
      weightKg: 100
    });

    const debug = sim.getDebugState();
    expect(debug.currentNodeOccupancy).toContainEqual({
      nodeId: storageParkedVehicle!.currentNodeId,
      vehicleId: 'SH-09'
    });
    expect(debug.storageNodeOccupancy).toContainEqual({
      nodeId: storageParkedVehicle!.currentNodeId,
      loadId: 'load-above-sh-09'
    });
  });

  it('parks inbound-only idle shuttles inside storage cells before using aisle-side pads', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      vehicles: { count: 8 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 8
      }
    }));

    expect(sim.getState().vehicles.map((vehicle) => vehicle.currentNodeId)).toEqual([
      'storage-r16-c12',
      'storage-r16-c24',
      'storage-r01-c06',
      'storage-r01-c18',
      'storage-r16-c01',
      'storage-r15-c01',
      'storage-r14-c01',
      'storage-r13-c01'
    ]);
    expect(sim.getState().vehicles.every((vehicle) => !vehicle.currentNodeId.startsWith('parking-'))).toBe(true);
  });

  it('primes saturated all-inbound sources and dispatches every shuttle without aisle-wide serialization', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
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
        liftApproachCapacity: 8,
        minimumClearanceSec: 0.4,
        deadlockDetectSec: 20
      }
    }));
    const resetState = sim.getState();
    const waitingLoads = resetState.loads.filter((load) => load.state === 'waiting');

    expect(resetState.tasks).toHaveLength(8);
    expect(waitingLoads).toHaveLength(8);
    expect(new Set(resetState.tasks.map((task) => task.pickupNodeId)).size).toBe(8);
    expect(new Set(waitingLoads.map((load) => load.nodeId)).size).toBe(8);

    sim.start();
    const dispatchedState = sim.step(0.1);

    expect(dispatchedState.tasks.filter((task) => task.state === 'assigned')).toHaveLength(8);
    expect(dispatchedState.vehicles.filter((vehicle) => vehicle.currentEdgeId !== null)).toHaveLength(8);
    expect(dispatchedState.traffic.waitingVehicles).toEqual([]);
    expect(dispatchedState.vehicles.every((vehicle) => vehicle.waitReason === null)).toBe(true);
    expect(dispatchedState.traffic).toMatchObject({
      trafficMode: 'flow-debug',
      safetyValidated: false,
      longHorizonReservationEnabled: false,
      legacyZoneHoldEnabled: false
    });
    expect(dispatchedState.reservations.some((reservation) => reservation.reasonCode === 'zone-hold')).toBe(false);
    expectNoTrafficSafetyFailures(dispatchedState);
  });

  it('keeps the 8-shuttle all-inbound stress flow alive without a legacy reservation wall', () => {
    const scenario = createDefaultShuttleScenario({
      liftMode: 'all-inbound',
      durationSec: 7200,
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
        liftApproachCapacity: 8,
        minimumClearanceSec: 0.4,
        deadlockDetectSec: 20
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.start();

    for (let index = 0; index < 5; index += 1) {
      sim.step(0.2);
    }
    const oneSecondState = sim.getState();

    expect(oneSecondState.tasks.filter((task) => task.state === 'assigned')).toHaveLength(8);
    expect(oneSecondState.vehicles.filter((vehicle) => vehicle.currentEdgeId !== null)).toHaveLength(8);
    expect(oneSecondState.traffic.waitingVehicles).toEqual([]);
    expect(oneSecondState.reservations.some((reservation) => reservation.reasonCode === 'zone-hold')).toBe(false);

    for (let index = 0; index < 595; index += 1) {
      sim.step(0.2);
    }
    const state = sim.getState();

    expect(state.kpis.completedInbound).toBeGreaterThan(0);
    expect(state.kpis.totalPph).toBeGreaterThan(0);
    expect(state.traffic.waitingVehicles.length).toBeLessThan(8);
    expect(state.traffic.deadlockCandidateVehicleIds).toEqual([]);
    expect(state.reservations.some((reservation) => reservation.reasonCode === 'zone-hold')).toBe(false);
    expect(state.kpis.blockedTimeByReasonSec['zone-reserved'] ?? 0).toBeLessThan(20);
    expectNoTrafficSafetyFailures(state);
  }, 30000);

  it('does not allocate inbound dropoff cells currently occupied by parked shuttles', () => {
    const scenario = createDefaultShuttleScenario({
      vehicles: { count: 9 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 2
      }
    });
    const sim = new ShuttleSimCore(scenario);
    const parkedStorageNodeId = sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-09')?.currentNodeId;
    for (const node of scenario.layout.nodes.filter((candidate) => candidate.type === 'storage' && candidate.id !== parkedStorageNodeId)) {
      sim.addLoadForTest({
        id: `load-${node.id}`,
        state: 'stored',
        nodeId: node.id,
        vehicleId: null,
        weightKg: 100
      });
    }

    sim.start();
    for (let index = 0; index < 5 && !(sim.getState().kpis.blockedTimeByReasonSec['storage-full'] > 0); index += 1) {
      sim.step(0.2);
    }

    expect(parkedStorageNodeId).toMatch(/^storage-r\d+-c\d+$/);
    expect(sim.getState().tasks.some((task) => task.dropoffNodeId === parkedStorageNodeId)).toBe(false);
    expect(sim.getState().kpis.blockedTimeByReasonSec['storage-full']).toBeGreaterThan(0);
  });

  it('keeps the default demo on orthogonal four-way shuttle aisles', () => {
    const scenario = createDefaultShuttleScenario();
    const nodes = new Map(scenario.layout.nodes.map((node) => [node.id, node]));

    for (const edge of scenario.layout.edges) {
      const from = nodes.get(edge.from)!;
      const to = nodes.get(edge.to)!;
      expect(from.x === to.x || from.z === to.z).toBe(true);
      expect(from.x === to.x && from.z === to.z).toBe(false);
    }

    const fifoLaneEdges = scenario.layout.edges.filter((edge) => edge.conflictGroup?.startsWith('fifo-lane'));
    const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
    const storageXs = storageNodes.map((node) => node.x);
    const storageRows = [...new Set(storageNodes.map((node) => node.z))].sort((left, right) => left - right);
    const storageColumns = [...new Set(storageNodes.map((node) => node.x))].sort((left, right) => left - right);
    const inboundLifts = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound');
    const outboundLifts = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound');
    const storageColumnGaps = storageColumns.slice(1).map((x, index) => x - storageColumns[index]!);
    const storageRowGaps = storageRows.slice(1).map((z, index) => z - storageRows[index]!);
    const mainNorthNodes = scenario.layout.nodes.filter((node) => node.id.startsWith('main-north-')).sort((left, right) => left.x - right.x);
    const mainSouthNodes = scenario.layout.nodes.filter((node) => node.id.startsWith('main-south-')).sort((left, right) => left.x - right.x);
    const mainLaneEdges = scenario.layout.edges.filter((edge) =>
      edge.conflictGroup?.startsWith('main-lane-north') || edge.conflictGroup?.startsWith('main-lane-south')
    );
    const rightUprightEdges = scenario.layout.edges.filter((edge) => edge.conflictGroup?.startsWith('right-upright'));

    expect(scenario.layout.nodes.every((node) => node.y === 0)).toBe(true);
    expect(storageRows).toHaveLength(16);
    expect(storageColumns).toHaveLength(24);
    expect(storageNodes).toHaveLength(384);
    expect(storageRows.every((z) => storageNodes.filter((node) => node.z === z).length === storageColumns.length)).toBe(true);
    expect(fifoLaneEdges).toHaveLength(storageRows.length * (storageColumns.length + 1));
    expect(fifoLaneEdges.every((edge) => edge.directionMode === 'twoWay')).toBe(true);
    expect(storageColumnGaps.filter((gap) => gap > 1.3)).toHaveLength(3);
    expect(storageColumnGaps.filter((gap) => gap <= 1.3)).toHaveLength(20);
    expect(storageRowGaps.filter((gap) => gap > 1.25)).toEqual([4.4]);
    expect(mainNorthNodes).toHaveLength(6);
    expect(mainSouthNodes).toHaveLength(6);
    expect(mainNorthNodes.every((node, index) => node.x === mainSouthNodes[index]!.x)).toBe(true);
    expect(mainLaneEdges).toHaveLength(10);
    expect(mainLaneEdges.every((edge) => edge.directionMode === 'twoWay')).toBe(true);
    expect(rightUprightEdges.length).toBeGreaterThan(0);
    expect(rightUprightEdges.every((edge) => edge.directionMode === 'twoWay')).toBe(true);
    expect(mainNorthNodes.every((node) => node.z < 0)).toBe(true);
    expect(mainSouthNodes.every((node) => node.z > 0)).toBe(true);
    expect(Math.max(...storageXs)).toBeLessThan(Math.max(...mainNorthNodes.map((node) => node.x)));
    expect(Math.min(...storageXs)).toBeGreaterThan(Math.min(...mainNorthNodes.map((node) => node.x)));
    expect(scenario.layout.nodes.some((node) => node.id === 'inbound' || node.id === 'outbound')).toBe(false);
    expect(scenario.layout.edges.some((edge) => edge.id === 'inbound-x-main' || edge.id === 'x-outbound-outbound')).toBe(false);
    expect(inboundLifts).toHaveLength(4);
    expect(outboundLifts).toHaveLength(4);
    expect(inboundLifts.every((node) => Math.abs(node.z) > 0)).toBe(true);
    expect(outboundLifts.every((node) => Math.abs(node.z) > 0)).toBe(true);
    expect(scenario.layout.edges.some((edge) => edge.id === 'inbound-lift-top-01-main-north-01')).toBe(true);
    expect(scenario.layout.edges.some((edge) => edge.id === 'outbound-lift-bottom-02-main-south-03')).toBe(true);
  });

  it('rejects diagonal or multi-level custom layout edges', () => {
    const scenario = createDefaultShuttleScenario();

    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          nodes: scenario.layout.nodes.map((node) =>
            node.id === 'main-south-01' ? { ...node, x: node.x + 0.4 } : node
          )
        }
      })
    ).toThrow(/diagonal/);

    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          nodes: scenario.layout.nodes.map((node) =>
            node.id === 'main-south-01' ? { ...node, y: 1.2 } : node
          )
        }
      })
    ).toThrow(/single-floor/);
  });

  it('rejects zones that reference unknown graph resources', () => {
    const scenario = createDefaultShuttleScenario();

    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          zones: [
            ...scenario.layout.zones,
            {
              id: 'bad-zone',
              type: 'intersection',
              nodeIds: ['missing-node'],
              edgeIds: ['missing-edge'],
              noStop: true,
              noParking: true,
              capacity: 1
            }
          ]
        }
      })
    ).toThrow(/references unknown node missing-node/);
  });

  it('summarizes the default layout contract used by the Unreal static scaffold', () => {
    const contract = summarizeScenarioStaticSceneContract(createDefaultShuttleScenario());

    expect(contract).toEqual(goldenStaticSceneContract);
    expect(contract).toMatchObject({
      schemaVersion: 'shuttle.simCoreStaticSceneContract.v1',
      scenarioId: 'shuttle-phase0-balanced',
      units: 'meter',
      storageRows: 16,
      storageColumns: 24,
      storageCellCount: 384,
      blockedCellCount: 0,
      structuralCellCount: 0,
      trackBedCount: 494,
      storageLaneTrackCount: 400,
      sideAisleTrackCount: 42,
      crossAisleTrackCount: 12,
      inboundConnectorTrackCount: 8,
      outboundConnectorTrackCount: 8,
      parkingConnectorTrackCount: 24,
      diagonalTrackCount: 0,
      inboundLiftPadCount: 4,
      outboundLiftPadCount: 4,
      parkingPadCount: 20,
      singleLevel: true,
      storageIslandCount: 8,
      denseStorageIslands: true,
      denseStorageBlock: false,
      orthogonalTrackOnly: true,
      dedicatedLiftPorts: true,
      inboundSide: 'mixed',
      outboundSide: 'mixed',
      layoutCalibrationProfile: {
        id: 'phase0-cad-assumption-v1',
        status: 'assumption'
      },
      calibrationReadiness: {
        status: 'assumption',
        readyForIndustrialThroughputClaims: false
      }
    });
    expect(contract.calibrationReadiness.requiredDimensionKeys).toEqual([...REQUIRED_CALIBRATION_DIMENSION_KEYS]);
    expect(contract.calibrationReadiness.presentDimensionKeys).toEqual([
      'storageCellPitchX',
      'storageCellPitchZ',
      'storageBayGapX',
      'mainLaneCenterSpacingZ',
      'innerStorageBankGapZ',
      'liftStandoffZ',
      'sideClearanceX'
    ]);
    expect(contract.calibrationReadiness.assumedDimensionKeys).toContain('storageCellPitchX');
    expect(contract.calibrationReadiness.lowConfidenceDimensionKeys).toContain('storageCellPitchX');
    expect(contract.calibrationReadiness.missingDimensionKeys).toEqual([
      'palletLength',
      'palletWidth',
      'palletHeight',
      'shuttleLength',
      'shuttleWidth',
      'shuttleHeight',
      'loadedClearance',
      'liftPadLength',
      'liftPadWidth',
      'rollerTransferLength',
      'rollerTransferWidth',
      'parkingPadLength',
      'parkingPadWidth'
    ]);
    expect(contract.calibrationReadiness.message).toContain('throughput remains smoke-test only');
    expect(contract.storagePitchXM).toBeCloseTo(1.25, 6);
    expect(contract.storagePitchZM).toBeCloseTo(1.2, 6);
    expect(contract.storageBlockMinXM).toBeCloseTo(2.5, 6);
    expect(contract.storageBlockMaxXM).toBeCloseTo(38, 6);
    expect(contract.storageBlockMinZM).toBeCloseTo(-10.6, 6);
    expect(contract.storageBlockMaxZM).toBeCloseTo(10.6, 6);
    expect(contract.inboundLiftXM).toBeCloseTo(25, 6);
    expect(contract.outboundLiftXM).toBeCloseTo(25, 6);
    expect(contract.storageCells).toHaveLength(384);
    expect(contract.blockedCells).toEqual([]);
    expect(contract.storageIslandCount).toBe(8);
    expect(contract.denseStorageIslands).toBe(true);
    expect(contract.denseStorageBlock).toBe(false);
    expect(contract.storageCells[0]).toMatchObject({
      id: 'storage-r01-c01',
      row: 1,
      column: 1,
      xM: 2.5,
      yM: 0,
      zM: -10.6
    });
    expect(contract.storageCells.at(-1)).toMatchObject({
      id: 'storage-r16-c24',
      row: 16,
      column: 24,
      xM: 38,
      yM: 0,
      zM: 10.6
    });
    expect(contract.storageCells.every((cell) => cell.lengthXM === 1.25 && cell.lengthZM === 1.2)).toBe(true);
    expect(contract.layoutCalibrationProfile?.dimensions.find((dimension) => dimension.key === 'storageCellPitchX')).toMatchObject({
      valueM: 1.25,
      source: 'assumed',
      confidence: 'low'
    });
    expect(
      Array.from({ length: 16 }, (_, rowIndex) =>
        contract.storageCells.filter((cell) => cell.row === rowIndex + 1).map((cell) => cell.column)
      )
    ).toEqual(Array.from({ length: 16 }, () => Array.from({ length: 24 }, (_, columnIndex) => columnIndex + 1)));
    expect(contract.trackBeds.every((track) => track.orientation === 'x' || track.orientation === 'z')).toBe(true);
    expect(contract.trackBeds.filter((track) => track.category === 'storageLane')).toHaveLength(400);
    expect(contract.trackBeds.find((track) => track.id === 'right-row-01-storage-r01-c24')).toMatchObject({
      category: 'storageLane',
      zM: -10.6,
      lengthXM: 2.5,
      lengthZM: 0.08,
      orientation: 'x',
      row: 1,
      side: 'right'
    });
    expect(contract.trackBeds.find((track) => track.id === 'main-north-01-main-north-02')).toMatchObject({
      category: 'crossAisle',
      zM: -0.8,
      orientation: 'x'
    });
    expect(contract.trackBeds.find((track) => track.id === 'left-row-08-main-north-00')).toMatchObject({
      category: 'sideAisle',
      xM: 0,
      lengthXM: 0.1,
      orientation: 'z',
      side: 'left'
    });
    expect(contract.liftPads.filter((pad) => pad.category === 'inboundLift').map((pad) => pad.id).sort()).toEqual([
      'inbound-lift-bottom-01',
      'inbound-lift-bottom-02',
      'inbound-lift-top-01',
      'inbound-lift-top-02'
    ]);
    expect(contract.liftPads.filter((pad) => pad.category === 'outboundLift')).toHaveLength(4);
    expect(contract.parkingPads.filter((pad) => pad.id.startsWith('parking-')).map((pad) => pad.id).sort()).toEqual([
      'parking-a',
      'parking-b',
      'parking-c',
      'parking-d',
      'parking-e',
      'parking-f',
      'parking-g',
      'parking-h'
    ]);
    expect(contract.parkingPads.filter((pad) => pad.id.includes('-stage-'))).toHaveLength(12);
  });

  it('rejects vertical travel edges that cut through storage-cell footprints', () => {
    const base = createDefaultShuttleScenario();
    const scenarioWithVerticalStorageCut = createDefaultShuttleScenario({
      layout: {
        ...base.layout,
        nodes: [
          ...base.layout.nodes,
          { id: 'bad-portal-top', type: 'intersection', x: 2.5, y: 0, z: -11.3, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'bad-portal-bottom', type: 'intersection', x: 2.5, y: 0, z: -8.7, noStop: false, noParking: true, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          ...base.layout.edges,
          {
            id: 'bad-vertical-storage-edge',
            from: 'bad-portal-top',
            to: 'bad-portal-bottom',
            lengthM: 2.6,
            directionMode: 'twoWay',
            reservationType: 'edge',
            conflictGroup: 'bad-storage-cut',
            noParking: true
          }
        ]
      }
    });

    expect(verticalStorageFootprintEdgeViolations(base)).toEqual([]);
    expect(verticalStorageFootprintEdgeViolations(scenarioWithVerticalStorageCut)).toEqual([
      { edgeId: 'bad-vertical-storage-edge', cellId: 'storage-r01-c01' }
    ]);
    expect(() => new ShuttleSimCore(scenarioWithVerticalStorageCut)).toThrow(/vertical edge bad-vertical-storage-edge crosses storage-cell footprint/);
  });

  it('carries blocked and structural CAD reference cells into the static scene contract without routing them', () => {
    const contract = summarizeScenarioStaticSceneContract(createDefaultShuttleScenario({
      layoutProfile: {
        calibrationProfile: {
          id: 'blocked-cell-contract-test-profile',
          label: 'Blocked cell contract test profile',
          status: 'partial-cad',
          sourceDescription: 'Test profile with explicit non-storage CAD reference cells.',
          blockedCells: [
            {
              id: 'cad-structural-gap-01',
              role: 'structural',
              xM: 17.25,
              yM: 0,
              zM: 0,
              lengthXM: 1.25,
              lengthZM: 1.2,
              source: 'cad',
              confidence: 'medium',
              note: 'Reference cell drawn from CAD as non-routable structure.'
            },
            {
              id: 'cad-blocked-gap-01',
              role: 'blocked',
              xM: 28.5,
              yM: 0,
              zM: 0,
              lengthXM: 1.25,
              lengthZM: 1.2,
              source: 'site',
              confidence: 'high'
            }
          ]
        }
      }
    }));

    expect(contract.blockedCellCount).toBe(2);
    expect(contract.structuralCellCount).toBe(1);
    expect(contract.blockedCells.map((cell) => cell.id)).toEqual(['cad-blocked-gap-01', 'cad-structural-gap-01']);
    expect(contract.blockedCells[0]).toMatchObject({
      role: 'blocked',
      xM: 28.5,
      zM: 0,
      source: 'site',
      confidence: 'high'
    });
    expect(contract.storageCells.some((cell) => cell.id === 'cad-blocked-gap-01')).toBe(false);
    expect(contract.trackBeds.some((track) => track.id === 'cad-blocked-gap-01')).toBe(false);
  });

  it('marks the static scene ready for industrial throughput claims only with a fully verified calibration profile', () => {
    const contract = summarizeScenarioStaticSceneContract(createDefaultShuttleScenario({
      layoutProfile: {
        calibrationProfile: {
          id: 'verified-calibration-test-profile',
          label: 'Verified calibration test profile',
          status: 'verified',
          sourceDescription: 'Test profile with every required dimension sourced from CAD.',
          dimensions: verifiedCalibrationDimensions()
        }
      }
    }));

    expect(contract.calibrationReadiness).toMatchObject({
      status: 'verified',
      readyForIndustrialThroughputClaims: true,
      missingDimensionKeys: [],
      assumedDimensionKeys: [],
      lowConfidenceDimensionKeys: []
    });
    expect(contract.calibrationReadiness.calibratedDimensionKeys).toEqual([...REQUIRED_CALIBRATION_DIMENSION_KEYS]);
    expect(contract.calibrationReadiness.message).toBe('Layout dimensions are verified for industrial throughput claims.');
  });

  it('keeps layout-profile overrides synchronized with calibration metadata and static-scene footprints', () => {
    const scenario = createDefaultShuttleScenario({
      layoutProfile: {
        storageCellPitchXM: 1.3,
        storageCellPitchZM: 1.25,
        storageBayGapXM: 2.5,
        storageInnerRowZM: 2.35,
        sideClearanceXM: 2.7,
        mainLaneNorthZM: -0.9,
        mainLaneSouthZM: 0.9,
        liftStandoffZM: 2,
        calibrationProfile: {
          id: 'partial-cad-test-profile',
          label: 'Partial CAD test profile',
          status: 'partial-cad',
          sourceDescription: 'Test override values from a partial CAD profile.'
        }
      }
    });
    const contract = summarizeScenarioStaticSceneContract(scenario);
    const dimensionsByKey = new Map(scenario.layout.calibrationProfile?.dimensions.map((dimension) => [dimension.key, dimension.valueM]));

    expect(scenario.layout.calibrationProfile).toMatchObject({
      id: 'partial-cad-test-profile',
      label: 'Partial CAD test profile',
      status: 'partial-cad',
      sourceDescription: 'Test override values from a partial CAD profile.'
    });
    expect(dimensionsByKey.get('storageCellPitchX')).toBe(1.3);
    expect(dimensionsByKey.get('storageCellPitchZ')).toBe(1.25);
    expect(dimensionsByKey.get('storageBayGapX')).toBe(2.5);
    expect(dimensionsByKey.get('mainLaneCenterSpacingZ')).toBe(1.8);
    expect(dimensionsByKey.get('innerStorageBankGapZ')).toBe(4.7);
    expect(dimensionsByKey.get('liftStandoffZ')).toBe(2);
    expect(dimensionsByKey.get('sideClearanceX')).toBe(2.7);
    expect(contract.layoutCalibrationProfile?.dimensions.find((dimension) => dimension.key === 'storageCellPitchX')).toMatchObject({
      valueM: 1.3,
      source: 'assumed',
      confidence: 'low'
    });
    expect(contract.storagePitchXM).toBeCloseTo(1.3, 6);
    expect(contract.storagePitchZM).toBeCloseTo(1.25, 6);
    expect(contract.storageCells.every((cell) => cell.lengthXM === 1.3 && cell.lengthZM === 1.25)).toBe(true);
  });

  it('rejects multi-capacity traffic resources for Phase 0', () => {
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...createDefaultShuttleScenario(),
        trafficPolicy: {
          ...createDefaultShuttleScenario().trafficPolicy,
          edgeCapacity: 2
        }
      })
    ).toThrow(/edgeCapacity=1/);
  });

  it('rejects scenarios without one parkable non-aisle node per vehicle for Phase 0', () => {
    const base = createDefaultShuttleScenario();
    expect(() =>
      createDefaultShuttleScenario({
        vehicles: { count: 9 },
        layout: {
          ...base.layout,
          nodes: base.layout.nodes.map((node) => node.type === 'storage' ? { ...node, noParking: true } : node)
        }
      })
    ).toThrow(/parkable non-aisle node per vehicle/);
  });

  it('rejects duplicate node ids before reset occupancy is initialized', () => {
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...createDefaultShuttleScenario(),
        layout: {
          ...createDefaultShuttleScenario().layout,
          nodes: createDefaultShuttleScenario().layout.nodes.map((node) =>
            node.id === 'parking-b' ? { ...node, id: 'parking-a' } : node
          )
        }
      })
    ).toThrow(/Duplicate node id parking-a/);
  });

  it('rejects storage nodes without explicit FIFO row and column ids', () => {
    const scenario = createDefaultShuttleScenario();
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          nodes: scenario.layout.nodes.map((node) =>
            node.id === 'storage-r01-c01' ? { ...node, id: 'storage-a' } : node
          )
        }
      })
    ).toThrow(/storage-rNN-cNN/);
  });

  it('rejects lift-blackbox nodes without explicit liftKind metadata', () => {
    const scenario = createDefaultShuttleScenario();
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          nodes: scenario.layout.nodes.map((node) =>
            node.id === 'inbound-lift-top-01' ? { ...node, liftKind: undefined } : node
          )
        }
      })
    ).toThrow(/lift-blackbox nodes must declare liftKind/);
  });

  it('rejects storage rows without left and right side access nodes', () => {
    const scenario = createDefaultShuttleScenario();
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          nodes: scenario.layout.nodes.filter((node) => node.id !== 'left-row-01')
        }
      })
    ).toThrow(/requires side access node left-row-01/);
  });

  it('rejects storage-to-storage edges that cross FIFO rows', () => {
    const scenario = createDefaultShuttleScenario();
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...scenario,
        layout: {
          ...scenario.layout,
          edges: [
            ...scenario.layout.edges,
            {
              id: 'storage-r01-c01-storage-r02-c01',
              from: 'storage-r01-c01',
              to: 'storage-r02-c01',
              lengthM: 1.2,
              directionMode: 'twoWay',
              reservationType: 'edge',
              conflictGroup: 'invalid-storage-cross-row',
              noParking: true
            }
          ]
        }
      })
    ).toThrow(/storage-area traversal must stay horizontal/);
  });

  it('produces the same event log hash for the same seed', () => {
    const scenario = createDefaultShuttleScenario({ durationSec: 90, taskGeneration: { maxTasks: 8 } });
    const hashes = Array.from({ length: 3 }, () => {
      const sim = new ShuttleSimCore(scenario);
      sim.runToEnd(90);
      return hashEventLog(sim.getEventLog());
    });

    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
  }, 60000);

  it('does not advance while paused and resumes without losing state', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({ durationSec: 120 }));
    sim.start();
    sim.step(5);
    const beforePause = sim.getState();

    sim.pause();
    sim.step(20);
    const paused = sim.getState();
    expect(paused.simTimeSec).toBe(beforePause.simTimeSec);

    sim.resume();
    sim.step(5);
    expect(sim.getState().simTimeSec).toBeGreaterThan(paused.simTimeSec);
  });

  it('keeps dedicated lift ports from creating artificial two-vehicle deadlocks', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 120,
      taskGeneration: {
        inboundRatePerHour: 720,
        outboundRatePerHour: 720,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 12
      },
      physicsParams: {
        emptySpeedMps: 8,
        loadedSpeedMps: 7,
        accelerationMps2: 10,
        switchDirectionSec: 0,
        liftTimeSec: 0.05,
        lowerTimeSec: 0.05,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.runToEnd(120);
    const state = sim.getState();

    expect(state.kpis.completedInbound).toBeGreaterThan(0);
    expect(state.kpis.deadlockCount).toBe(0);
    const liftKindByNodeId = new Map(scenario.layout.nodes.map((node) => [node.id, node.liftKind ?? null]));
    expect(state.tasks.every((task) => task.kind !== 'inbound' || liftKindByNodeId.get(task.pickupNodeId) === 'inbound')).toBe(true);
    expect(state.tasks.every((task) => task.kind !== 'outbound' || liftKindByNodeId.get(task.dropoffNodeId) === 'outbound')).toBe(true);
    expect(state.traffic.liftPorts).toHaveLength(8);
    expect(state.traffic.liftPorts.some((port) => port.kind === 'inbound' && port.utilization > 0)).toBe(true);
  }, 15000);

  it('lets opposite main-lane traffic pass without portal-zone deadlock in the default layout', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 30,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 2
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0,
        liftTimeSec: 0.1,
        lowerTimeSec: 0.1,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['main-north-03', 'main-north-02', 'main-north-01', 'main-north-00', 'parking-c']);
    sim.setVehicleRouteForTest('SH-02', ['main-south-02', 'main-south-03', 'main-south-04', 'main-south-05', 'parking-b']);

    for (let index = 0; index < 120; index += 1) {
      sim.step(0.2);
    }

    const state = sim.getState();
    expect(state.kpis.deadlockCount).toBe(0);
    expect(state.vehicles.every((vehicle) => vehicle.waitReason !== 'zone-reserved')).toBe(true);
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-01')?.currentNodeId).toBe('parking-c');
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-02')?.currentNodeId).toBe('parking-b');
  });

  it('holds head-on main-lane swaps at parking pads when neither shuttle can clear a no-stop route', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 60,
      vehicles: {
        count: 2
      },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0,
        liftTimeSec: 0.1,
        lowerTimeSec: 0.1,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['parking-c', 'main-north-00', 'main-north-01', 'main-north-02', 'main-north-03', 'main-north-04', 'main-north-05', 'parking-a']);
    sim.setVehicleRouteForTest('SH-02', ['parking-a', 'main-north-05', 'main-north-04', 'main-north-03', 'main-north-02', 'main-north-01', 'main-north-00', 'parking-c']);

    for (let index = 0; index < 10; index += 1) {
      sim.step(0.2);
    }

    const state = sim.getState();
    expect(state.kpis.deadlockCount).toBe(0);
    expect(state.traffic.deadlockCandidateVehicleIds).toEqual([]);
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-01')).toMatchObject({
      currentNodeId: 'parking-c',
      currentEdgeId: null,
      waitReason: 'no-stop-clearance-incomplete'
    });
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-02')).toMatchObject({
      currentNodeId: 'parking-a',
      currentEdgeId: null,
      waitReason: 'no-stop-clearance-incomplete'
    });
  });

  it('does not serialize parallel main-aisle travel through a broad portal zone', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 20,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 2
      },
      physicsParams: {
        emptySpeedMps: 2.6,
        loadedSpeedMps: 2.2,
        accelerationMps2: 2,
        switchDirectionSec: 0,
        liftTimeSec: 0.5,
        lowerTimeSec: 0.5,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.1
      }
    });
    expect(scenario.layout.zones.find((zone) => zone.id === 'zone-main-portal-02')).toBeUndefined();

    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['main-south-03', 'main-south-04', 'main-south-05', 'parking-b']);
    sim.setVehicleRouteForTest('SH-02', ['main-north-03', 'main-north-04', 'main-north-05', 'parking-a']);
    sim.step(0.2);

    const state = sim.getState();
    expect(state.reservations.some((reservation) => reservation.resourceId === 'zone-main-portal-03')).toBe(false);
    expect(state.reservations.some((reservation) => reservation.resourceId === 'zone-main-portal-04')).toBe(false);
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-01')).toMatchObject({
      currentNodeId: 'main-south-03',
      currentEdgeId: 'main-south-03-main-south-04'
    });
    const parallelVehicle = state.vehicles.find((vehicle) => vehicle.id === 'SH-02');
    expect(parallelVehicle).toMatchObject({
      currentNodeId: 'main-north-03',
      currentEdgeId: 'main-north-03-main-north-04'
    });
    expect(parallelVehicle?.state).not.toBe('waiting-blocked');
  });

  it('does not let a stopped portal-node occupant hold downstream portal zones', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 20,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 2
      },
      physicsParams: {
        emptySpeedMps: 2.6,
        loadedSpeedMps: 2.2,
        accelerationMps2: 2,
        switchDirectionSec: 0,
        liftTimeSec: 0.5,
        lowerTimeSec: 0.5,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.1
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.addReservationForTest({
      resourceType: 'edge',
      resourceId: 'main-north-01-main-north-02',
      vehicleId: 'external-blocker',
      taskId: null,
      startTimeSec: 0,
      endTimeSec: 60,
      priority: 0,
      conflictGroup: null,
      reasonCode: 'test-block'
    });
    sim.setVehicleRouteForTest('SH-01', ['main-north-02', 'main-north-01']);

    sim.step(0.2);

    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')).toMatchObject({
      currentNodeId: 'main-north-02',
      currentEdgeId: null,
      waitReason: 'edge-reserved'
    });
    expect(sim.getState().reservations).not.toContainEqual(
      expect.objectContaining({ vehicleId: 'SH-01', resourceType: 'zone', resourceId: 'zone-main-portal-node-02', reasonCode: 'zone-hold' })
    );

    sim.setVehicleRouteForTest('SH-02', ['outbound-lift-top-01', 'main-south-02']);
    sim.step(0.2);

    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-02')).toMatchObject({
      state: 'waiting-blocked',
      waitReason: 'no-stop-continuation-blocked',
      currentNodeId: 'outbound-lift-top-01'
    });
  });

  it('does not enter a no-stop control chain unless the route can clear to a stoppable node', () => {
    const sim = new ShuttleSimCore(testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'parking', x: 0, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'X', type: 'intersection', x: 4, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'Y', type: 'intersection', x: 8, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 12, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-X', from: 'A', to: 'X', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-X', noParking: true },
          { id: 'X-Y', from: 'X', to: 'Y', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'X-Y', noParking: true },
          { id: 'Y-C', from: 'Y', to: 'C', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'Y-C', noParking: true }
        ],
        zones: []
      }
    }));
    sim.setVehicleRouteForTest('SH-02', ['C']);
    sim.setVehicleRouteForTest('SH-01', ['A', 'X', 'Y', 'C']);

    const state = sim.step(0.2);
    const vehicle = state.vehicles.find((candidate) => candidate.id === 'SH-01');

    expect(vehicle).toMatchObject({
      state: 'waiting-blocked',
      currentNodeId: 'A',
      currentEdgeId: null,
      targetNodeId: 'X',
      waitReason: 'no-stop-clearance-incomplete'
    });
  });

  it('defers outbound work instead of creating phantom pallets when contiguous lane-fill storage is empty', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 10,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 3600,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 3
      }
    }));

    sim.start();
    sim.step(1);
    const state = sim.getState();

    expect(state.tasks).toHaveLength(0);
    expect(state.loads).toHaveLength(0);
    expect(state.kpis.blockedTimeByReasonSec['storage-empty']).toBeGreaterThan(0);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'task-deferred' && entry.reason === 'storage-empty')).toBe(true);
  });

  it('spreads inbound work across FIFO rows while preserving contiguous fill inside each row', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      liftMode: 'all-inbound',
      durationSec: 120,
      vehicles: { count: 8 },
      taskGeneration: {
        inboundRatePerHour: 720,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 8
      },
      physicsParams: {
        emptySpeedMps: 6,
        loadedSpeedMps: 5,
        accelerationMps2: 6,
        switchDirectionSec: 0,
        liftTimeSec: 0.1,
        lowerTimeSec: 0.1,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.1
      }
    }));

    sim.start();
    for (let index = 0; index < 300 && sim.getState().tasks.filter((task) => task.kind === 'inbound').length < 8; index += 1) {
      sim.step(0.2);
    }
    const state = sim.getState();
    const inboundTasks = state.tasks.filter((task) => task.kind === 'inbound');
    const storageOccupancy = sim.getDebugState().storageNodeOccupancy;

    expect(inboundTasks).toHaveLength(8);
    expect(state.kpis.deadlockCount).toBe(0);
    expect(inboundTasks.slice(0, 8).map((task) => [task.dropoffNodeId, task.loadId])).toEqual([
      ['storage-r01-c01', 'load-0001'],
      ['storage-r02-c01', 'load-0002'],
      ['storage-r03-c01', 'load-0003'],
      ['storage-r04-c01', 'load-0004'],
      ['storage-r05-c01', 'load-0005'],
      ['storage-r06-c01', 'load-0006'],
      ['storage-r07-c01', 'load-0007'],
      ['storage-r08-c01', 'load-0008']
    ]);
    expect(storageOccupancy).toEqual(expect.arrayContaining([
      { nodeId: 'storage-r01-c01', loadId: 'load-0001' },
      { nodeId: 'storage-r02-c01', loadId: 'load-0002' },
      { nodeId: 'storage-r03-c01', loadId: 'load-0003' },
      { nodeId: 'storage-r04-c01', loadId: 'load-0004' },
      { nodeId: 'storage-r05-c01', loadId: 'load-0005' },
      { nodeId: 'storage-r06-c01', loadId: 'load-0006' },
      { nodeId: 'storage-r07-c01', loadId: 'load-0007' },
      { nodeId: 'storage-r08-c01', loadId: 'load-0008' }
    ]));
  });

  it('routes through stored pallet cells on the same horizontal storage row', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 120,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 4
      }
    }));
    sim.setVehicleRouteForTest('SH-01', ['left-row-01']);
    sim.setVehicleRouteForTest('SH-02', ['parking-a', 'main-north-04']);
    sim.addLoadForTest({ id: 'load-pass-through', state: 'stored', nodeId: 'storage-r01-c01', vehicleId: null, weightKg: 100 });
    sim.addLoadForTest({ id: 'load-pick', state: 'stored', nodeId: 'storage-r01-c02', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'outbound-c02',
      kind: 'outbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'storage-r01-c02',
      dropoffNodeId: 'outbound-lift-top-01',
      loadId: 'load-pick',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const assignedVehicle = sim.getState().vehicles.find((vehicle) => vehicle.taskId === 'outbound-c02');
    const route = assignedVehicle?.routeNodeIds ?? [];

    expect(assignedVehicle?.id).toBe('SH-01');
    expect(route.indexOf('storage-r01-c01')).toBeGreaterThan(route.indexOf('left-row-01'));
    expect(route.indexOf('storage-r01-c02')).toBeGreaterThan(route.indexOf('storage-r01-c01'));
    expect(crossRowStorageHops(route)).toEqual([]);
  });

  it('uses the outfeed-side storage exit when an idle shuttle is parked under a load', () => {
    const scenario = createDefaultShuttleScenario({
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      }
    });
    scenario.layout.nodes = scenario.layout.nodes.map((node) =>
      node.type === 'parking' ? { ...node, noParking: true } : node
    );
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['storage-r16-c01']);

    expect(sim.getState().vehicles[0]?.currentNodeId).toBe('storage-r16-c01');
    sim.start();
    sim.step(0.2);
    const assigned = sim.getEventLog().find((event) => event.eventType === 'task-assigned');
    const route = String(assigned?.details.route ?? '').split('>');

    expect(route.slice(0, 2)).toEqual(['storage-r16-c01', 'left-row-16']);
  });

  it('routes empty inbound pickup shuttles out through the left side instead of counterflowing on the right infeed aisle', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      }
    }));
    sim.setVehicleRouteForTest('SH-01', ['storage-r03-c24']);
    sim.addLoadForTest({ id: 'manual-inbound-load', state: 'waiting', nodeId: 'inbound-lift-top-02', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'manual-inbound',
      kind: 'inbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'inbound-lift-top-02',
      dropoffNodeId: 'storage-r04-c01',
      loadId: 'manual-inbound-load',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const route = sim.getState().vehicles[0]?.routeNodeIds ?? [];
    const pickupIndex = route.indexOf('inbound-lift-top-02');

    expect(route.slice(0, 2)).toEqual(['storage-r03-c24', 'storage-r03-c23']);
    expect(route.indexOf('left-row-03')).toBeGreaterThan(route.indexOf('storage-r03-c01'));
    expect(route.slice(0, pickupIndex).includes('right-row-03')).toBe(false);
  });

  it('ends inbound work at the target storage cell without a post-dropoff route tail', () => {
    const scenario = createDefaultShuttleScenario({
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      }
    });
    const sim = new ShuttleSimCore(scenario);

    sim.start();
    sim.step(0.2);
    const assigned = sim.getEventLog().find((event) => event.eventType === 'task-assigned');
    const route = String(assigned?.details.route ?? '').split('>');
    const dropoffIndex = route.indexOf('storage-r01-c01');

    expect(dropoffIndex).toBeGreaterThan(0);
    expect(dropoffIndex).toBe(route.length - 1);
    expect(route.slice(route.indexOf('right-row-01') + 1).flatMap((nodeId) => storageColumn(nodeId) ?? [])).toEqual(
      expect.arrayContaining([1])
    );
  });

  it('dispatches an unloaded inbound-only shuttle from dropoff to lift-near storage standby', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 120,
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      },
      physicsParams: {
        emptySpeedMps: 6,
        loadedSpeedMps: 5,
        accelerationMps2: 6,
        switchDirectionSec: 0,
        liftTimeSec: 0.05,
        lowerTimeSec: 0.05,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.start();
    let state = sim.getState();
    for (let elapsedSec = 0; elapsedSec < 120 && state.kpis.completedInbound < 1; elapsedSec = Number((elapsedSec + 0.2).toFixed(6))) {
      state = sim.step(0.2);
    }
    const vehicle = state.vehicles[0]!;
    const standbyEvent = sim.getEventLog().find((event) => event.eventType === 'vehicle-standby-dispatched');
    const standbyRoute = String(standbyEvent?.details.route ?? '').split('>');
    const standbyTarget = standbyRoute.at(-1);

    expect(state.kpis.completedInbound).toBe(1);
    expect(vehicle.state).toBe('assigned');
    expect(vehicle.loaded).toBe(false);
    expect(vehicle.taskId).toBeNull();
    expect(standbyEvent).toBeDefined();
    expect(standbyTarget).toMatch(/^storage-r\d+-c\d+$/);
    expect(standbyTarget).not.toBe('storage-r01-c01');
    expect(vehicle.routeNodeIds.at(-1)).toBe(standbyTarget);
    expect(crossRowStorageHops(vehicle.routeNodeIds)).toEqual([]);
    expect(state.loads.find((load) => load.id === 'load-0001')).toMatchObject({
      state: 'stored',
      nodeId: 'storage-r01-c01',
      vehicleId: null
    });
    expect(sim.getDebugState().currentNodeOccupancy).toContainEqual({
      nodeId: 'storage-r01-c01',
      vehicleId: 'SH-01'
    });
  });

  it('preempts an empty inbound-standby shuttle at the next control node when a lift calls it', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 2
      }
    }));
    sim.setVehicleRouteForTest('SH-01', ['storage-r01-c24', 'right-row-01', 'main-north-05']);
    sim.addLoadForTest({ id: 'manual-call-load', state: 'waiting', nodeId: 'inbound-lift-top-02', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'manual-call',
      kind: 'inbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'inbound-lift-top-02',
      dropoffNodeId: 'storage-r02-c01',
      loadId: 'manual-call-load',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const vehicle = sim.getState().vehicles[0]!;

    expect(vehicle.taskId).toBe('manual-call');
    expect(vehicle.routeNodeIds).toContain('inbound-lift-top-02');
    expect(vehicle.routeNodeIds.at(-1)).toBe('storage-r02-c01');
  });

  it('routes cross-row storage moves through side aisles instead of vertical storage hops', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 120,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 4
      }
    }));
    sim.setVehicleRouteForTest('SH-01', ['storage-r01-c01']);
    sim.setVehicleRouteForTest('SH-02', ['parking-a', 'main-north-04']);
    sim.addLoadForTest({ id: 'load-r02-c01', state: 'stored', nodeId: 'storage-r02-c01', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'outbound-r02-c01',
      kind: 'outbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'storage-r02-c01',
      dropoffNodeId: 'outbound-lift-top-01',
      loadId: 'load-r02-c01',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const assignedVehicle = sim.getState().vehicles.find((vehicle) => vehicle.taskId === 'outbound-r02-c01');

    expect(assignedVehicle?.id).toBe('SH-01');
    expect(assignedVehicle?.routeNodeIds).toEqual(expect.arrayContaining(['left-row-01', 'left-row-02', 'storage-r02-c01']));
    expect(crossRowStorageHops(assignedVehicle?.routeNodeIds ?? [])).toEqual([]);
    expect(storageRowsInRoute(assignedVehicle?.routeNodeIds ?? [])).toEqual(['01', '02']);
  });

  it('assigns executable work to the nearest idle shuttle resource', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'parking-a', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'parking-b', type: 'parking', x: 9, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'inbound-lift-test', type: 'lift-blackbox', liftKind: 'inbound', x: 10, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'right-row-01', type: 'intersection', x: 11, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'storage-r01-c01', type: 'storage', x: 12, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'left-row-01', type: 'intersection', x: 13, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'parking-a-inbound-lift-test', from: 'parking-a', to: 'inbound-lift-test', lengthM: 10, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'far-resource', noParking: true },
          { id: 'parking-b-inbound-lift-test', from: 'parking-b', to: 'inbound-lift-test', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'near-resource', noParking: true },
          { id: 'inbound-lift-test-right-row-01', from: 'inbound-lift-test', to: 'right-row-01', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'lift-row', noParking: true },
          { id: 'right-row-01-storage-r01-c01', from: 'right-row-01', to: 'storage-r01-c01', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'fifo-lane-01', noParking: true },
          { id: 'storage-r01-c01-left-row-01', from: 'storage-r01-c01', to: 'left-row-01', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'fifo-lane-01', noParking: true },
          { id: 'left-row-01-parking-b', from: 'left-row-01', to: 'parking-b', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'left-exit', noParking: true }
        ],
        zones: []
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.addLoadForTest({ id: 'load-near', state: 'waiting', nodeId: 'inbound-lift-test', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'task-near',
      kind: 'inbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'inbound-lift-test',
      dropoffNodeId: 'storage-r01-c01',
      loadId: 'load-near',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);

    expect(sim.getState().tasks.find((task) => task.id === 'task-near')).toMatchObject({
      state: 'assigned',
      vehicleId: 'SH-02'
    });
    expect(sim.getEventLog().find((entry) => entry.eventType === 'task-assigned' && entry.taskId === 'task-near')?.reason).toBe('nearest-available');
  });

  it('does not treat future queued inbound slots as physical storage obstacles', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 120,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 10
      }
    }));
    sim.addLoadForTest({ id: 'load-r06-c03', state: 'waiting', nodeId: 'inbound-lift-top-01', vehicleId: null, weightKg: 100 });
    sim.addLoadForTest({ id: 'load-r06-c04', state: 'waiting', nodeId: 'inbound-lift-top-01', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'task-r06-c03',
      kind: 'inbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'inbound-lift-top-01',
      dropoffNodeId: 'storage-r06-c03',
      loadId: 'load-r06-c03',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });
    sim.addTaskForTest({
      id: 'task-r06-c04',
      kind: 'inbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'inbound-lift-top-01',
      dropoffNodeId: 'storage-r06-c04',
      loadId: 'load-r06-c04',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const assignedVehicle = sim.getState().vehicles.find((vehicle) => vehicle.taskId === 'task-r06-c03');

    expect(assignedVehicle?.routeNodeIds).toEqual(expect.arrayContaining(['right-row-06', 'storage-r06-c04', 'storage-r06-c03']));
  });

  it('drains multiple pallets from the same storage row without hidden compaction', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 300,
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 10
      },
      physicsParams: {
        emptySpeedMps: 6,
        loadedSpeedMps: 5,
        accelerationMps2: 6,
        switchDirectionSec: 0,
        liftTimeSec: 0.1,
        lowerTimeSec: 0.1,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.1
      }
    }));
    sim.addLoadForTest({ id: 'load-a', state: 'stored', nodeId: 'storage-r01-c01', vehicleId: null, weightKg: 100 });
    sim.addLoadForTest({ id: 'load-b', state: 'stored', nodeId: 'storage-r01-c02', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'outbound-a',
      kind: 'outbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'storage-r01-c01',
      dropoffNodeId: 'outbound-lift-top-01',
      loadId: 'load-a',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    for (let index = 0; index < 2000 && sim.getState().tasks.find((task) => task.id === 'outbound-a')?.state !== 'completed'; index += 1) {
      sim.step(0.2);
    }

    expect(sim.getState().tasks.find((task) => task.id === 'outbound-a')?.state).toBe('completed');
    expect(sim.getDebugState().storageNodeOccupancy).toEqual([{ nodeId: 'storage-r01-c02', loadId: 'load-b' }]);

    sim.addTaskForTest({
      id: 'outbound-b',
      kind: 'outbound',
      state: 'queued',
      createdAtSec: sim.getState().simTimeSec,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'storage-r01-c02',
      dropoffNodeId: 'outbound-lift-top-01',
      loadId: 'load-b',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    for (let index = 0; index < 2000 && sim.getState().tasks.find((task) => task.id === 'outbound-b')?.state !== 'completed'; index += 1) {
      sim.step(0.2);
    }

    expect(sim.getState().tasks.find((task) => task.id === 'outbound-b')?.state).toBe('completed');
    expect(sim.getDebugState().storageNodeOccupancy).toEqual([]);
    expect(sim.getState().loads.filter((load) => load.state === 'delivered').map((load) => load.id).sort()).toEqual(['load-a', 'load-b']);
  });

  it('defers inbound work when contiguous lane-fill storage cells are stored or already reserved', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 20,
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 10
      }
    });
    const sim = new ShuttleSimCore(scenario);
    for (const node of scenario.layout.nodes.filter((candidate) => candidate.type === 'storage')) {
      sim.addLoadForTest({
        id: `load-${node.id}`,
        state: 'stored',
        nodeId: node.id,
        vehicleId: null,
        weightKg: 100
      });
    }

    sim.start();
    for (let index = 0; index < 10 && !(sim.getState().kpis.blockedTimeByReasonSec['storage-full'] > 0); index += 1) {
      sim.step(0.2);
    }
    const state = sim.getState();

    expect(state.tasks).toHaveLength(0);
    expect(sim.getDebugState().storageNodeOccupancy).toHaveLength(384);
    expect(state.kpis.blockedTimeByReasonSec['storage-full']).toBeGreaterThan(0);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'task-deferred' && entry.reason === 'storage-full')).toBe(true);
  });

  it('keeps a near-full contiguous lane-fill store bounded without over-allocating slots', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 20,
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 3
      }
    });
    const sim = new ShuttleSimCore(scenario);
    const finalSlotNodeId = 'storage-r15-c24';
    const occupiedStorageNodeIds = scenario.layout.nodes
      .filter((node) => node.type === 'storage' && node.id !== finalSlotNodeId)
      .map((node) => node.id);
    addStoredLoads(sim, occupiedStorageNodeIds);

    sim.start();
    for (let index = 0; index < 20 && !(sim.getState().kpis.blockedTimeByReasonSec['storage-full'] > 0); index += 1) {
      sim.step(0.2);
    }
    const state = sim.getState();

    expectNoTrafficSafetyFailures(state);
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.dropoffNodeId).toBe(finalSlotNodeId);
    expect(sim.getDebugState().storageNodeOccupancy).toHaveLength(384);
    expect(state.kpis.blockedTimeByReasonSec['storage-full']).toBeGreaterThan(0);
  });

  it('attributes queued inbound pressure to vehicle availability when every shuttle is already busy', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 60,
      vehicles: {
        count: 1,
        emptySpeedMps: 1,
        loadedSpeedMps: 0.8,
        accelerationMps2: 1,
        liftTimeSec: 0.05,
        lowerTimeSec: 0.05
      },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 4
      },
      trafficPolicy: {
        liftApproachCapacity: 1
      }
    });
    const state = runFor(new ShuttleSimCore(scenario), 5);
    const queuedTasks = state.tasks.filter((task) => task.state === 'queued');

    expect(state.kpis.activeTasks).toBe(1);
    expect(queuedTasks.length).toBeGreaterThan(0);
    expect(queuedTasks.every((task) => task.waitReason === 'vehicle-unavailable')).toBe(true);
    expect(state.kpis.blockedTimeByReasonSec['vehicle-unavailable']).toBeGreaterThan(0);
  });

  it('accepts dashboard-style parameter updates through JSON pointers', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario());
    const result = sim.setParam('/physicsParams/loadedSpeedMps', 1.25);

    expect(result.accepted).toBe(true);
    expect(sim.getScenario().physicsParams.loadedSpeedMps).toBe(1.25);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'param-updated')).toBe(true);
  });

  it('keeps explicit node occupancy ownership while vehicles wait and move', () => {
    const sim = new ShuttleSimCore(testScenario({}));

    expect(sim.getDebugState().currentNodeOccupancy).toEqual([
      { nodeId: 'A', vehicleId: 'SH-01' },
      { nodeId: 'B', vehicleId: 'SH-02' }
    ]);

    sim.setVehicleRouteForTest('SH-01', ['A', 'B']);
    sim.step(0.2);

    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.waitReason).toBe('node-occupied');
    expect(sim.getDebugState().currentNodeOccupancy).toEqual([
      { nodeId: 'A', vehicleId: 'SH-01' },
      { nodeId: 'B', vehicleId: 'SH-02' }
    ]);
  });

  it('keeps four-way shuttle yaw fixed while translating through right-angle routes', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'P', type: 'parking', x: -4, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'aisle', x: 4, y: 0, z: 4, noStop: false, noParking: true, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-B', noParking: true },
          { id: 'B-C', from: 'B', to: 'C', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'B-C', noParking: true }
        ],
        zones: []
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'B', 'C']);

    const observedYaw: Array<number | undefined> = [];
    for (let index = 0; index < 60; index += 1) {
      sim.step(0.2);
      observedYaw.push(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.yaw);
    }

    expect(observedYaw.every((yaw) => yaw === 0)).toBe(true);
    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')).toMatchObject({
      currentNodeId: 'C',
      x: 4,
      z: 4
    });
  });

  it('cruises through same-axis cell chains instead of stopping at every grid node', () => {
    const scenario = testScenario({
      durationSec: 20,
      vehicles: {
        count: 1,
        lengthM: 1,
        widthM: 1,
        heightM: 0.2,
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        maxLoadKg: 1000,
        safetyRadiusM: 0.1,
        batteryEnabled: false,
        initialSoc: 1
      },
      physicsParams: {
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      },
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 1.25, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'aisle', x: 2.5, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'D', type: 'parking', x: 3.75, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 1.25, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'row-a', noParking: true },
          { id: 'B-C', from: 'B', to: 'C', lengthM: 1.25, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'row-b', noParking: true },
          { id: 'C-D', from: 'C', to: 'D', lengthM: 1.25, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'row-c', noParking: true }
        ],
        zones: []
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'B', 'C', 'D']);
    let arrivalTimeSec = Number.POSITIVE_INFINITY;
    for (let index = 0; index < 80; index += 1) {
      sim.step(0.1);
      if (sim.getState().vehicles[0]?.currentNodeId === 'D') {
        arrivalTimeSec = sim.getState().simTimeSec;
        break;
      }
    }

    const fullStopTravelSec = calculateTravelTimeSec(1.25, 2, 1.2) * 3;
    expect(arrivalTimeSec).toBeLessThan(fullStopTravelSec - 0.8);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'reservation-created' && entry.details.motionMode === 'cruise')).toBe(true);
    expectNoTrafficSafetyFailures(sim.getState());
  });

  it('holds a same-lane follower until the leading shuttle clears minimum headway', () => {
    const base = testScenario({});
    const scenario = testScenario({
      vehicles: { ...base.vehicles, count: 2 },
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'parking', x: 1.25, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 2.5, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 1.25, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'row-a', noParking: true },
          { id: 'B-C', from: 'B', to: 'C', lengthM: 1.25, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'row-b', noParking: true }
        ],
        zones: []
      },
      physicsParams: {
        emptySpeedMps: 2.6,
        loadedSpeedMps: 2.2,
        accelerationMps2: 2,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['B', 'C']);
    sim.setVehicleRouteForTest('SH-02', ['A', 'B']);

    sim.step(0.2);
    const follower = sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-02');

    expect(follower?.state).toBe('waiting-blocked');
    expect(follower?.waitReason).toBe('min-separation');
    expect(follower?.blockingVehicleId).toBe('SH-01');
  });

  it('uses local same-row storage grants instead of preauthorizing the whole row', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      },
      physicsParams: {
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    }));
    sim.setVehicleRouteForTest('SH-01', [
      'storage-r01-c08',
      'storage-r01-c07',
      'storage-r01-c06',
      'storage-r01-c05',
      'storage-r01-c04',
      'storage-r01-c03',
      'storage-r01-c02',
      'storage-r01-c01'
    ]);

    sim.step(0.2);
    const horizonEvent = sim.getEventLog().find((entry) => entry.eventType === 'reservation-created' && entry.reason === 'route-horizon');

    expect(horizonEvent?.details.horizonLegCount).toBe(1);
    expect(
      sim.getState().reservations.filter((reservation) =>
        reservation.vehicleId === 'SH-01' &&
        reservation.resourceType === 'edge' &&
        reservation.resourceId.startsWith('storage-r01-')
      ).length
    ).toBe(1);

    for (let index = 0; index < 80 && sim.getState().vehicles[0]?.currentNodeId !== 'storage-r01-c01'; index += 1) {
      sim.step(0.1);
    }

    expect(sim.getState().vehicles[0]?.currentNodeId).toBe('storage-r01-c01');
    expectNoTrafficSafetyFailures(sim.getState());
  });

  it('uses a local row-entry storage grant from the infeed side', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 1
      },
      physicsParams: {
        emptySpeedMps: 2,
        loadedSpeedMps: 1.5,
        accelerationMps2: 1.2,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    }));
    sim.setVehicleRouteForTest('SH-01', [
      'right-row-01',
      'storage-r01-c24',
      'storage-r01-c23',
      'storage-r01-c22',
      'storage-r01-c21',
      'storage-r01-c20',
      'storage-r01-c19',
      'storage-r01-c18'
    ]);

    sim.step(0.2);
    const horizonEvent = sim.getEventLog().find((entry) => entry.eventType === 'reservation-created' && entry.reason === 'route-horizon');

    expect(horizonEvent?.details.horizonLegCount).toBe(1);
    expect(
      sim.getState().reservations.filter((reservation) =>
        reservation.vehicleId === 'SH-01' &&
        reservation.resourceType === 'edge' &&
        (
          reservation.resourceId === 'right-row-01-storage-r01-c24' ||
          reservation.resourceId.startsWith('storage-r01-')
        )
      ).length
    ).toBe(1);
    expectNoTrafficSafetyFailures(sim.getState());
  });

  it('keeps reservation horizons out of main aisles and lift approaches to avoid artificial wait-for cycles', () => {
    const base = testScenario({});
    const sim = new ShuttleSimCore(testScenario({
      vehicles: { ...base.vehicles, count: 1 },
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 1, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'aisle', x: 2, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'D', type: 'parking', x: 3, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'main-a', noParking: true },
          { id: 'B-C', from: 'B', to: 'C', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'main-b', noParking: true },
          { id: 'C-D', from: 'C', to: 'D', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'main-c', noParking: true }
        ],
        zones: []
      }
    }));
    sim.setVehicleRouteForTest('SH-01', ['A', 'B', 'C', 'D']);
    sim.step(0.2);
    const horizonEvent = sim.getEventLog().find((entry) => entry.eventType === 'reservation-created' && entry.reason === 'route-horizon');

    expect(horizonEvent?.details.horizonLegCount).toBe(1);
    expect(sim.getState().reservations.filter((reservation) => reservation.vehicleId === 'SH-01' && reservation.resourceType === 'edge')).toHaveLength(1);
    expectNoTrafficSafetyFailures(sim.getState());
  });

  it('does not add direction-switch dwell to the default four-way shuttle demo', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario());
    sim.runToEnd(90);

    expect(sim.getState().vehicles.every((vehicle) => vehicle.yaw === 0)).toBe(true);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'direction-switch-started')).toBe(false);
  });

  it('adds direction-switch dwell for orthogonal moves without rotating the shuttle body', () => {
    const scenario = testScenario({
      durationSec: 40,
      physicsParams: {
        emptySpeedMps: 2,
        loadedSpeedMps: 1,
        accelerationMps2: 2,
        switchDirectionSec: 1,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.2
      },
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'P', type: 'parking', x: -4, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'aisle', x: 4, y: 0, z: 4, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'D', type: 'aisle', x: 8, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-B', noParking: true },
          { id: 'B-C', from: 'B', to: 'C', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'B-C', noParking: true },
          { id: 'B-D', from: 'B', to: 'D', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'B-D', noParking: true }
        ],
        zones: []
      }
    });
    const turningSim = new ShuttleSimCore(scenario);
    turningSim.setVehicleRouteForTest('SH-01', ['A', 'B', 'C']);

    for (let index = 0; index < 20; index += 1) {
      turningSim.step(0.2);
    }

    const dwellVehicle = turningSim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01');
    expect(dwellVehicle).toMatchObject({
      currentNodeId: 'B',
      currentEdgeId: null,
      yaw: 0
    });
    expect(dwellVehicle?.phaseRemainingSec ?? 0).toBeGreaterThan(0);
    expect(turningSim.getEventLog().some((entry) => entry.eventType === 'direction-switch-started')).toBe(true);

    for (let index = 0; index < 8; index += 1) {
      turningSim.step(0.2);
    }
    expect(turningSim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.currentEdgeId).toBe('B-C');

    const straightSim = new ShuttleSimCore(scenario);
    straightSim.setVehicleRouteForTest('SH-01', ['A', 'B', 'D']);
    for (let index = 0; index < 28; index += 1) {
      straightSim.step(0.2);
    }
    expect(straightSim.getEventLog().some((entry) => entry.eventType === 'direction-switch-started')).toBe(false);
  });

  it('blocks opposite-direction same-edge movement with an active edge reservation', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 8, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-B', noParking: true }
        ],
        zones: []
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'B']);
    sim.step(0.2);

    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.currentEdgeId).toBe('A-B');
    expect(sim.getDebugState().currentNodeOccupancy).toEqual([{ nodeId: 'C', vehicleId: 'SH-02' }]);

    sim.setVehicleRouteForTest('SH-02', ['B', 'A']);
    sim.step(0.2);
    const state = sim.getState();
    const secondVehicle = state.vehicles.find((vehicle) => vehicle.id === 'SH-02');

    expect(secondVehicle?.state).toBe('waiting-blocked');
    expect(secondVehicle?.waitReason).toBe('edge-reserved');
    expect(state.vehicles.filter((vehicle) => vehicle.currentEdgeId === 'A-B')).toHaveLength(1);
    expect(state.traffic.minVehicleSeparationM ?? Infinity).toBeGreaterThanOrEqual(scenario.vehicles.safetyRadiusM * 2);
  });

  it('prevents a target-node occupancy race while the current occupant waits', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'parking', x: 4, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'X', type: 'intersection', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 8, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-X', from: 'A', to: 'X', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'west', noParking: true },
          { id: 'X-C', from: 'X', to: 'C', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'east', noParking: true },
          { id: 'B-X', from: 'B', to: 'X', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'north', noParking: true }
        ],
        zones: [{ id: 'zone-x', type: 'intersection', nodeIds: ['X'], edgeIds: ['A-X', 'X-C', 'B-X'], noStop: true, noParking: true, capacity: 1, conflictGroup: 'zone-x' }]
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'X', 'C']);
    sim.setVehicleRouteForTest('SH-02', ['B']);
    sim.addReservationForTest({
      resourceType: 'edge',
      resourceId: 'X-C',
      vehicleId: 'external-blocker',
      taskId: null,
      startTimeSec: 0,
      endTimeSec: 60,
      priority: 0,
      conflictGroup: 'east',
      reasonCode: 'test-block'
    });

    for (let index = 0; index < 40; index += 1) {
      sim.step(0.2);
    }

    expect(sim.getDebugState().currentNodeOccupancy).toContainEqual({ nodeId: 'X', vehicleId: 'SH-01' });
    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.waitReason).toBe('edge-reserved');

    sim.setVehicleRouteForTest('SH-02', ['B', 'X']);
    sim.step(0.2);

    expect(sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-02')?.waitReason).toBe('node-occupied');
    expect(sim.getDebugState().currentNodeOccupancy).toContainEqual({ nodeId: 'X', vehicleId: 'SH-01' });
  });

  it('serializes crossing paths through a shared zone', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'parking', x: 0, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 6, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'D', type: 'parking', x: 6, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-C', from: 'A', to: 'C', lengthM: 6, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'south', noParking: true },
          { id: 'B-D', from: 'B', to: 'D', lengthM: 6, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'north', noParking: true }
        ],
        zones: [{ id: 'zone-cross', type: 'intersection', nodeIds: [], edgeIds: ['A-C', 'B-D'], noStop: true, noParking: true, capacity: 1, conflictGroup: 'zone-cross' }]
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'C']);
    sim.setVehicleRouteForTest('SH-02', ['B', 'D']);
    sim.step(0.2);

    const state = sim.getState();
    expect(state.reservations.filter((reservation) => reservation.resourceType === 'zone' && reservation.resourceId === 'zone-cross')).toHaveLength(1);
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-02')?.waitReason).toBe('zone-reserved');
  });

  it('reserves every matching zone for an edge and target node', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 8, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'edge-a-b', noParking: true }
        ],
        zones: [
          { id: 'zone-edge', type: 'intersection', nodeIds: [], edgeIds: ['A-B'], noStop: true, noParking: true, capacity: 1, conflictGroup: 'zone-edge' },
          { id: 'zone-node', type: 'intersection', nodeIds: ['B'], edgeIds: [], noStop: true, noParking: true, capacity: 1, conflictGroup: 'zone-node' }
        ]
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'B']);
    sim.step(0.2);

    const zoneIds = sim
      .getState()
      .reservations.filter((reservation) => reservation.vehicleId === 'SH-01' && reservation.resourceType === 'zone')
      .map((reservation) => reservation.resourceId)
      .sort();
    expect(zoneIds).toEqual(['zone-edge', 'zone-node']);
  });

  it('does not call a linear wait chain a deadlock candidate but reports a wait-for cycle', () => {
    const sim = new ShuttleSimCore(testScenario({}));
    sim.setVehicleWaitingForTest('SH-01', { targetNodeId: 'B', waitReason: 'node-occupied', blockingVehicleId: 'SH-02', waitingSinceSec: 0 });
    expect(sim.getState().traffic.deadlockCandidateVehicleIds).toEqual([]);
    expect(sim.getState().kpis.deadlockCount).toBe(0);

    sim.setVehicleWaitingForTest('SH-02', { targetNodeId: 'A', waitReason: 'node-occupied', blockingVehicleId: 'SH-01', waitingSinceSec: 0 });
    expect(sim.getState().traffic.deadlockCandidateVehicleIds.sort()).toEqual(['SH-01', 'SH-02']);
  });

  it('computes triangular and trapezoidal motion profiles without NaN values', () => {
    expect(calculateTravelTimeSec(1, 2, 1)).toBeCloseTo(2, 6);
    expect(motionProfileAt(1, 1, 2, 1)).toMatchObject({ distanceM: 0.5, speedMps: 1 });

    const trapezoidTravelSec = calculateTravelTimeSec(10, 2, 1);
    expect(trapezoidTravelSec).toBeCloseTo(7, 6);
    expect(motionProfileAt(3, 10, 2, 1)).toMatchObject({ distanceM: 4, speedMps: 2 });

    expect(calculateTravelTimeSec(4, 2, 1)).toBeCloseTo(4, 6);
    expect(motionProfileAt(0, 0, 2, 1)).toEqual({ distanceM: 0, speedMps: 0 });
  });

  it('arrives according to acceleration-aware travel time and loaded speed limits', () => {
    const scenario = testScenario({
      vehicles: {
        count: 2,
        lengthM: 1,
        widthM: 1,
        heightM: 0.2,
        emptySpeedMps: 2,
        loadedSpeedMps: 1,
        accelerationMps2: 1,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        maxLoadKg: 1000,
        safetyRadiusM: 0.4,
        batteryEnabled: false,
        initialSoc: 1
      },
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'aisle', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 8, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-B', noParking: true }
        ],
        zones: []
      },
      physicsParams: {
        emptySpeedMps: 2,
        loadedSpeedMps: 1,
        accelerationMps2: 1,
        switchDirectionSec: 0,
        liftTimeSec: 0,
        lowerTimeSec: 0,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.2
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'B']);
    sim.step(0.2);
    const travelSec = sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.legTravelSec ?? 0;
    expect(travelSec).toBeCloseTo(calculateTravelTimeSec(4, 2, 1), 6);
    while (sim.getState().vehicles.find((vehicle) => vehicle.id === 'SH-01')?.currentEdgeId) {
      sim.step(0.2);
    }
    expect(sim.getState().simTimeSec).toBeCloseTo(travelSec, 0);

    const loadedTravelSec = calculateTravelTimeSec(4, scenario.physicsParams.loadedSpeedMps, scenario.physicsParams.accelerationMps2);
    expect(loadedTravelSec).toBeGreaterThan(travelSec);
  });

  it('reports lightweight inbound theoretical shuttle capacity from the current layout and speed parameters', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({ vehicles: { count: 12 } }));
    const baseline = sim.getState().kpis.theoreticalCapacity!;

    expect(baseline.kind).toBe('inbound');
    expect(baseline.shuttleCount).toBe(12);
    expect(baseline.singleShuttlePph).toBeGreaterThan(40);
    expect(baseline.fleetPph).toBeCloseTo(baseline.singleShuttlePph * 12, 2);
    expect(baseline.idealCycleSec).toBeCloseTo(
      baseline.loadedTravelSec + baseline.emptyReturnSec + baseline.liftAndLowerSec,
      3
    );
    expect(baseline.averageLoadedDistanceM).toBeGreaterThan(0);
    expect(baseline.averageEmptyReturnDistanceM).toBeGreaterThan(0);
    expect(baseline.assumptions).toContain('inbound-only ideal with unlimited lift-side demand');

    expect(sim.setParam('/physicsParams/loadedSpeedMps', 2).accepted).toBe(true);
    const fasterLoaded = sim.getState().kpis.theoreticalCapacity!;
    expect(fasterLoaded.singleShuttlePph).toBeGreaterThan(baseline.singleShuttlePph);
  });
});
