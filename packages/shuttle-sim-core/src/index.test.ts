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
    expect(parsed.layout.nodes.filter((node) => node.type === 'lift-blackbox').map((node) => node.id).sort()).toEqual([
      'inbound-lift-a',
      'inbound-lift-b',
      'outbound-lift-a',
      'outbound-lift-b'
    ]);
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
    const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
    const storageXs = storageNodes.map((node) => node.x);
    const storageRows = [...new Set(storageNodes.map((node) => node.z))].sort((left, right) => left - right);
    const storageColumns = [...new Set(storageNodes.map((node) => node.x))].sort((left, right) => left - right);
    const inboundLifts = ['inbound-lift-a', 'inbound-lift-b'].map((nodeId) => nodes.get(nodeId)!);
    const outboundLifts = ['outbound-lift-a', 'outbound-lift-b'].map((nodeId) => nodes.get(nodeId)!);
    const inboundX = inboundLifts[0]!.x;
    const outboundX = outboundLifts[0]!.x;

    expect(storageRows).toHaveLength(6);
    expect(storageColumns).toHaveLength(8);
    expect(storageNodes).toHaveLength(48);
    expect(storageRows.every((z) => storageNodes.filter((node) => node.z === z).length === storageColumns.length)).toBe(true);
    expect(fifoLaneEdges).toHaveLength(storageRows.length * (storageColumns.length + 1));
    expect(fifoLaneEdges.every((edge) => edge.directionMode === 'twoWay')).toBe(true);
    expect(storageColumns.slice(1).every((x, index) => x - storageColumns[index]! <= 1.3)).toBe(true);
    expect(storageRows.slice(1).every((z, index) => z - storageRows[index]! <= 1.25)).toBe(true);
    expect(Math.max(...storageXs)).toBeLessThan(inboundX);
    expect(Math.min(...storageXs)).toBeGreaterThan(outboundX);
    expect(scenario.layout.nodes.some((node) => node.id === 'inbound' || node.id === 'outbound')).toBe(false);
    expect(scenario.layout.edges.some((edge) => edge.id === 'inbound-x-main' || edge.id === 'x-outbound-outbound')).toBe(false);
    expect(inboundLifts.every((node) => node.x === inboundX)).toBe(true);
    expect(outboundLifts.every((node) => node.x === outboundX)).toBe(true);
    expect(inboundLifts.every((node) => Math.abs(node.z) > 0)).toBe(true);
    expect(outboundLifts.every((node) => Math.abs(node.z) > 0)).toBe(true);
    expect(scenario.layout.edges.some((edge) => edge.id === 'inbound-lift-a-right-row-01')).toBe(true);
    expect(scenario.layout.edges.some((edge) => edge.id === 'outbound-lift-a-left-row-01')).toBe(true);
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

  it('keeps dedicated lift ports from creating artificial two-vehicle deadlocks', () => {
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

    expect(state.kpis.completedInbound).toBeGreaterThan(0);
    expect(state.kpis.deadlockCount).toBe(0);
    expect(state.tasks.every((task) => task.kind !== 'inbound' || task.pickupNodeId.startsWith('inbound-lift-'))).toBe(true);
    expect(state.tasks.every((task) => task.kind !== 'outbound' || task.dropoffNodeId.startsWith('outbound-lift-'))).toBe(true);
    expect(state.traffic.liftPorts).toHaveLength(4);
    expect(state.traffic.liftPorts.some((port) => port.queueLength > 0)).toBe(true);
    expect(state.traffic.liftPorts.some((port) => port.kind === 'inbound' && port.utilization > 0)).toBe(true);
    expect(Object.keys(state.kpis.blockedTimeByReasonSec).some((reason) => reason.startsWith('inbound-lift-busy:'))).toBe(true);
  });

  it('defers outbound work instead of creating phantom pallets when FIFO storage is empty', () => {
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

  it('fills and drains FIFO storage lanes using existing pallet loads', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 260,
      taskGeneration: {
        inboundRatePerHour: 720,
        outboundRatePerHour: 720,
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
    for (let index = 0; index < 2000 && sim.getState().kpis.completedOutbound < 1; index += 1) {
      sim.step(0.2);
    }
    const state = sim.getState();
    const outboundTasks = state.tasks.filter((task) => task.kind === 'outbound');
    const storageOccupancy = sim.getDebugState().storageNodeOccupancy;

    expect(state.kpis.completedOutbound).toBeGreaterThanOrEqual(1);
    expect(outboundTasks.slice(0, 1).map((task) => [task.pickupNodeId, task.loadId])).toEqual([
      ['storage-r01-c01', 'load-0001']
    ]);
    expect(state.loads.find((load) => load.id === 'load-0001')).toMatchObject({ state: 'delivered', nodeId: expect.stringMatching(/^outbound-lift-/) });
    expect(storageOccupancy.some((entry) => entry.nodeId === 'storage-r01-c01')).toBe(false);
    expect(storageOccupancy).toEqual(expect.arrayContaining([
      { nodeId: 'storage-r01-c02', loadId: 'load-0007' },
      { nodeId: 'storage-r02-c01', loadId: 'load-0002' },
      { nodeId: 'storage-r03-c01', loadId: 'load-0003' },
      { nodeId: 'storage-r06-c01', loadId: 'load-0006' }
    ]));
  });

  it('does not route through occupied storage cells that are not the current task endpoint', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        nodes: [
          { id: 'parking-a', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'parking-b', type: 'parking', x: 0, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'inbound-lift-test', type: 'lift-blackbox', x: 1, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'storage-blocker', type: 'storage', x: 2, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'storage-target', type: 'storage', x: 3, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'bypass', type: 'aisle', x: 2, y: 0, z: 2, noStop: false, noParking: true, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'parking-a-inbound-lift-test', from: 'parking-a', to: 'inbound-lift-test', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'parking-lift', noParking: true },
          { id: 'inbound-lift-test-storage-blocker', from: 'inbound-lift-test', to: 'storage-blocker', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'blocked-storage-path', noParking: true },
          { id: 'storage-blocker-storage-target', from: 'storage-blocker', to: 'storage-target', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'blocked-storage-path', noParking: true },
          { id: 'inbound-lift-test-bypass', from: 'inbound-lift-test', to: 'bypass', lengthM: 2, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'storage-bypass', noParking: true },
          { id: 'bypass-storage-target', from: 'bypass', to: 'storage-target', lengthM: 2, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'storage-bypass', noParking: true }
        ],
        zones: []
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.addLoadForTest({ id: 'load-blocker', state: 'stored', nodeId: 'storage-blocker', vehicleId: null, weightKg: 100 });
    sim.addLoadForTest({ id: 'load-inbound', state: 'waiting', nodeId: 'inbound-lift-test', vehicleId: null, weightKg: 100 });
    sim.addTaskForTest({
      id: 'task-inbound',
      kind: 'inbound',
      state: 'queued',
      createdAtSec: 0,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId: 'inbound-lift-test',
      dropoffNodeId: 'storage-target',
      loadId: 'load-inbound',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const assignedVehicle = sim.getState().vehicles.find((vehicle) => vehicle.taskId === 'task-inbound');

    expect(assignedVehicle?.routeNodeIds).toEqual(expect.arrayContaining(['inbound-lift-test', 'bypass', 'storage-target']));
    expect(assignedVehicle?.routeNodeIds).not.toContain('storage-blocker');
  });

  it('drains multiple pallets from the same FIFO row without hidden compaction', () => {
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
      dropoffNodeId: 'outbound-lift-a',
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
      dropoffNodeId: 'outbound-lift-a',
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

  it('defers inbound work when FIFO storage cells are stored or already reserved', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 2000,
      taskGeneration: {
        inboundRatePerHour: 3600,
        outboundRatePerHour: 0,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 50
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
    }));

    sim.start();
    for (let index = 0; index < 20000 && !(sim.getState().kpis.blockedTimeByReasonSec['storage-full'] > 0); index += 1) {
      sim.step(0.2);
    }
    const state = sim.getState();

    expect(state.tasks).toHaveLength(48);
    expect(sim.getDebugState().storageNodeOccupancy).toHaveLength(48);
    expect(state.kpis.blockedTimeByReasonSec['storage-full']).toBeGreaterThan(0);
    expect(sim.getEventLog().some((entry) => entry.eventType === 'task-deferred' && entry.reason === 'storage-full')).toBe(true);
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
