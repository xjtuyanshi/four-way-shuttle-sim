import { ShuttleScenarioSchema, ShuttleSimStateSchema, type ShuttleScenario } from '@four-way-shuttle/schemas';

import goldenStaticSceneContract from '../../../config/shuttle/static-scene-contract.golden.json';
import {
  ShuttleSimCore,
  calculateTravelTimeSec,
  createDefaultShuttleScenario,
  hashEventLog,
  motionProfileAt,
  summarizeScenarioStaticSceneContract
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

describe('shuttle phase 0 SimCore', () => {
  it('validates the default phase 0 scenario schema', () => {
    const scenario = createDefaultShuttleScenario();
    const parsed = ShuttleScenarioSchema.parse(scenario);

    expect(parsed.schemaVersion).toBe('shuttle.phase0.v0');
    expect(parsed.vehicles.safetyRadiusM).toBe(0.1);
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

  it('parses legacy state diagnostics without lift-port allocation details', () => {
    const state = new ShuttleSimCore(createDefaultShuttleScenario()).getState();
    const legacyTraffic: Record<string, unknown> = { ...state.traffic };
    delete legacyTraffic.liftPorts;

    const parsed = ShuttleSimStateSchema.parse({ ...state, traffic: legacyTraffic });

    expect(parsed.traffic.liftPorts).toEqual([]);
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
      trackBedCount: 474,
      storageLaneTrackCount: 400,
      sideAisleTrackCount: 42,
      crossAisleTrackCount: 12,
      inboundConnectorTrackCount: 8,
      outboundConnectorTrackCount: 8,
      parkingConnectorTrackCount: 4,
      diagonalTrackCount: 0,
      inboundLiftPadCount: 4,
      outboundLiftPadCount: 4,
      parkingPadCount: 4,
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
      }
    });
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
    expect(contract.parkingPads.map((pad) => pad.id).sort()).toEqual(['parking-a', 'parking-b', 'parking-c', 'parking-d']);
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

  it('rejects scenarios without one parking node per vehicle for Phase 0', () => {
    expect(() =>
      ShuttleScenarioSchema.parse({
        ...createDefaultShuttleScenario(),
        vehicles: {
          ...createDefaultShuttleScenario().vehicles,
          count: 5
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
  });

  it('lets opposite one-way main lanes pass without portal-zone deadlock in the default layout', () => {
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
    sim.setVehicleRouteForTest('SH-01', ['main-north-03', 'main-north-02', 'main-north-01']);
    sim.setVehicleRouteForTest('SH-02', ['main-south-02', 'main-south-03', 'main-south-04']);

    for (let index = 0; index < 80; index += 1) {
      sim.step(0.2);
    }

    const state = sim.getState();
    expect(state.kpis.deadlockCount).toBe(0);
    expect(state.vehicles.every((vehicle) => vehicle.waitReason !== 'zone-reserved')).toBe(true);
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-01')?.currentNodeId).toBe('main-north-01');
    expect(state.vehicles.find((vehicle) => vehicle.id === 'SH-02')?.currentNodeId).toBe('main-south-04');
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

  it('fills one storage row contiguously from outfeed toward infeed before opening the next row', () => {
    const sim = new ShuttleSimCore(createDefaultShuttleScenario({
      durationSec: 120,
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
      ['storage-r01-c02', 'load-0002'],
      ['storage-r01-c03', 'load-0003'],
      ['storage-r01-c04', 'load-0004'],
      ['storage-r01-c05', 'load-0005'],
      ['storage-r01-c06', 'load-0006'],
      ['storage-r01-c07', 'load-0007'],
      ['storage-r01-c08', 'load-0008']
    ]);
    expect(storageOccupancy).toEqual(expect.arrayContaining([
      { nodeId: 'storage-r01-c01', loadId: 'load-0001' },
      { nodeId: 'storage-r01-c02', loadId: 'load-0002' },
      { nodeId: 'storage-r01-c03', loadId: 'load-0003' },
      { nodeId: 'storage-r01-c04', loadId: 'load-0004' },
      { nodeId: 'storage-r01-c05', loadId: 'load-0005' },
      { nodeId: 'storage-r01-c06', loadId: 'load-0006' },
      { nodeId: 'storage-r01-c07', loadId: 'load-0007' },
      { nodeId: 'storage-r01-c08', loadId: 'load-0008' }
    ]));
  });

  it('does not route through occupied storage cells that are not the current task endpoint', () => {
    const scenario = testScenario({
      layout: {
        units: 'meter',
        calibrationProfile: null,
        nodes: [
          { id: 'parking-a', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'parking-b', type: 'parking', x: 0, y: 0, z: 4, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
          { id: 'inbound-lift-test', type: 'lift-blackbox', liftKind: 'inbound', x: 1, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'left-row-01', type: 'aisle', x: 1, y: 0, z: -1, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'storage-r01-c01', type: 'storage', x: 2, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'storage-r01-c02', type: 'storage', x: 3, y: 0, z: 0, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'right-row-01', type: 'aisle', x: 4, y: 0, z: -1, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
          { id: 'bypass', type: 'aisle', x: 2, y: 0, z: 2, noStop: false, noParking: true, capacity: 1, allowedDirections: [] }
        ],
        edges: [
          { id: 'parking-a-inbound-lift-test', from: 'parking-a', to: 'inbound-lift-test', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'parking-lift', noParking: true },
          { id: 'inbound-lift-test-storage-r01-c01', from: 'inbound-lift-test', to: 'storage-r01-c01', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'blocked-storage-path', noParking: true },
          { id: 'storage-r01-c01-storage-r01-c02', from: 'storage-r01-c01', to: 'storage-r01-c02', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'blocked-storage-path', noParking: true },
          { id: 'inbound-lift-test-right-row-01', from: 'inbound-lift-test', to: 'right-row-01', lengthM: 3, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'right-row-access', noParking: true },
          { id: 'right-row-01-storage-r01-c02', from: 'right-row-01', to: 'storage-r01-c02', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'right-row-access', noParking: true },
          { id: 'inbound-lift-test-bypass', from: 'inbound-lift-test', to: 'bypass', lengthM: 2, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'storage-bypass', noParking: true },
          { id: 'bypass-storage-r01-c02', from: 'bypass', to: 'storage-r01-c02', lengthM: 2, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'storage-bypass', noParking: true }
        ],
        zones: []
      }
    });
    const sim = new ShuttleSimCore(scenario);
    sim.addLoadForTest({ id: 'load-blocker', state: 'stored', nodeId: 'storage-r01-c01', vehicleId: null, weightKg: 100 });
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
      dropoffNodeId: 'storage-r01-c02',
      loadId: 'load-inbound',
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    });

    sim.step(0.2);
    const assignedVehicle = sim.getState().vehicles.find((vehicle) => vehicle.taskId === 'task-inbound');

    expect(assignedVehicle?.routeNodeIds).toEqual(expect.arrayContaining(['inbound-lift-test', 'right-row-01', 'storage-r01-c02']));
    expect(assignedVehicle?.routeNodeIds).not.toContain('storage-r01-c01');
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
    const finalSlotNodeId = 'storage-r16-c24';
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

  it('keeps four-vehicle mixed lift and FIFO pressure bounded without deadlock', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 360,
      vehicles: { count: 4 },
      taskGeneration: {
        inboundRatePerHour: 240,
        outboundRatePerHour: 240,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 32
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0.2,
        liftTimeSec: 0.2,
        lowerTimeSec: 0.2,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      },
      trafficPolicy: {
        deadlockDetectSec: 5
      }
    });
    const sim = new ShuttleSimCore(scenario);
    addStoredLoads(sim, [
      'storage-r01-c01',
      'storage-r01-c02',
      'storage-r02-c01',
      'storage-r02-c02',
      'storage-r03-c01',
      'storage-r03-c02',
      'storage-r04-c01',
      'storage-r04-c02'
    ]);

    const state = runFor(sim, scenario.durationSec);
    const blockedReasons = Object.keys(state.kpis.blockedTimeByReasonSec);

    expectNoTrafficSafetyFailures(state);
    expect(state.kpis.completedInbound).toBeGreaterThan(0);
    expect(state.kpis.completedOutbound).toBeGreaterThan(0);
    expect(blockedReasons.some((reason) => reason.startsWith('fifo-') || reason.includes('lift-busy'))).toBe(true);
    expect(state.vehicles).toHaveLength(4);
    expect(state.vehicles.every((vehicle) => Number.isFinite(vehicle.x) && Number.isFinite(vehicle.z))).toBe(true);
  }, 15000);

  it('keeps one-direction pressure cases bounded for inbound-only and outbound-only runs', () => {
    const inboundScenario = createDefaultShuttleScenario({
      durationSec: 240,
      vehicles: { count: 4 },
      taskGeneration: {
        inboundRatePerHour: 240,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 20
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0.2,
        liftTimeSec: 0.2,
        lowerTimeSec: 0.2,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const inboundState = runFor(new ShuttleSimCore(inboundScenario), inboundScenario.durationSec);

    expectNoTrafficSafetyFailures(inboundState);
    expect(inboundState.kpis.completedInbound).toBeGreaterThan(0);
    expect(inboundState.kpis.completedOutbound).toBe(0);

    const outboundScenario = createDefaultShuttleScenario({
      durationSec: 240,
      vehicles: { count: 4 },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 240,
        inboundOutboundMix: 0,
        arrivalDistribution: 'deterministic',
        maxTasks: 20
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0.2,
        liftTimeSec: 0.2,
        lowerTimeSec: 0.2,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const outboundSim = new ShuttleSimCore(outboundScenario);
    addStoredLoads(outboundSim, [
      'storage-r01-c01',
      'storage-r01-c02',
      'storage-r01-c03',
      'storage-r01-c04',
      'storage-r02-c01',
      'storage-r02-c02',
      'storage-r02-c03',
      'storage-r02-c04'
    ]);
    const outboundState = runFor(outboundSim, outboundScenario.durationSec);

    expectNoTrafficSafetyFailures(outboundState);
    expect(outboundState.kpis.completedInbound).toBe(0);
    expect(outboundState.kpis.completedOutbound).toBeGreaterThan(0);
  }, 15000);

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
});
