import { ShuttleScenarioSchema, type ShuttleScenario } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  calculateTravelTimeSec,
  createDefaultShuttleScenario,
  hashEventLog,
  motionProfileAt
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

describe('shuttle phase 0 SimCore', () => {
  it('validates the default phase 0 scenario schema', () => {
    const scenario = createDefaultShuttleScenario();
    const parsed = ShuttleScenarioSchema.parse(scenario);

    expect(parsed.schemaVersion).toBe('shuttle.phase0.v0');
    expect(parsed.layout.nodes.some((node) => node.type === 'lift-blackbox')).toBe(true);
    expect(parsed.layout.zones.some((zone) => zone.noStop && zone.noParking)).toBe(true);
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
    const storageXs = scenario.layout.nodes.filter((node) => node.type === 'storage').map((node) => node.x);
    const inboundX = nodes.get('inbound')!.x;
    const outboundX = nodes.get('outbound')!.x;

    expect(fifoLaneEdges).toHaveLength(8);
    expect(fifoLaneEdges.every((edge) => edge.directionMode === 'oneWay')).toBe(true);
    expect(Math.max(...storageXs)).toBeLessThan(inboundX);
    expect(Math.min(...storageXs)).toBeGreaterThan(outboundX);
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

  it('rejects scenarios without one parking node per vehicle for Phase 0', () => {
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...createDefaultShuttleScenario(),
        vehicles: {
          ...createDefaultShuttleScenario().vehicles,
          count: 3
        }
      })
    ).toThrow(/one parking node per vehicle/);
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

  it('produces the same event log hash for the same seed', () => {
    const scenario = createDefaultShuttleScenario({ durationSec: 180, taskGeneration: { maxTasks: 8 } });
    const hashes = Array.from({ length: 3 }, () => {
      const sim = new ShuttleSimCore(scenario);
      sim.runToEnd(180);
      return hashEventLog(sim.getEventLog());
    });

    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
  });

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

  it('records reservation conflicts and wait reasons under two-vehicle pressure', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 120,
      taskGeneration: {
        inboundRatePerHour: 720,
        outboundRatePerHour: 720,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 12
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.runToEnd(120);
    const state = sim.getState();

    expect(state.kpis.reservationConflictCount).toBeGreaterThan(0);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'vehicle-waiting' && entry.reason?.includes('reserved'))).toBe(true);
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

  it('blocks opposite-direction same-edge movement with an active edge reservation', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
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
        nodes: [
          { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'B', type: 'parking', x: 0, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'X', type: 'intersection', x: 4, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'C', type: 'parking', x: 8, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'A-X', from: 'A', to: 'X', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'west', noParking: true },
          { id: 'X-C', from: 'X', to: 'C', lengthM: 4, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'east', noParking: true },
          { id: 'B-X', from: 'B', to: 'X', lengthM: 5.66, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'north', noParking: true }
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
});
