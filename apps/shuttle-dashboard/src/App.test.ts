import type { KpiSnapshot, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { createDefaultShuttleScenario, createInboundMvpBaselineScenario, summarizeScenarioStaticSceneContract } from '@four-way-shuttle/sim-core';
import { describe, expect, it } from 'vitest';

import goldenStaticSceneContract from '../../../config/shuttle/static-scene-contract.golden.json';
import {
  mergeKpiUpdate,
  mergeVehicleStateUpdate,
  inferTopLiftRegionCount,
  shouldResetAfterParamUpdate,
  shouldResumeAfterParamUpdate,
  summarizeScenarioSetup,
  summarizeResourceUtilization,
  vehicleCanInterpolateVisual
} from './App.js';
import {
  resolveCadDimensionAnnotations,
  resolveDashboardStaticSceneContract,
  resolveScene3DVehicleBodyPose,
  resolveScene3DVisualScenario,
  resolveScene3DVisualState,
  resolveScene3DVisualStaticScene
} from './ShuttleScene3D.js';
import { FLOW_VISUAL_COLORS, resolveLoadFlowRole, resolveVehicleLoadFlowRole } from './flowColors.js';

function vehicle(overrides: Partial<VehicleState> & { id: string }): VehicleState {
  const { id, ...rest } = overrides;

  return {
    id,
    state: 'idle',
    x: 0,
    y: 0.08,
    z: 0,
    yaw: 0,
    speedMps: 0,
    loaded: false,
    taskId: null,
    targetNodeId: null,
    currentNodeId: 'parking-a',
    currentEdgeId: null,
    routeNodeIds: [],
    plannedGoalNodeId: null,
    plannedRouteNodeIds: [],
    localRouteNodeIds: [],
    localRouteReason: null,
    routeIndex: 0,
    legRemainingM: 0,
    legElapsedSec: 0,
    legTravelSec: 0,
    phaseRemainingSec: 0,
    waitReason: null,
    blockingReservationId: null,
    blockingVehicleId: null,
    blockedTimeSec: 0,
    idleTimeSec: 0,
    busyTimeSec: 0,
    ...rest
  };
}

function kpis(overrides: Partial<KpiSnapshot> = {}): KpiSnapshot {
  return {
    inboundPph: 0,
    outboundPph: 0,
    totalPph: 0,
    windowInboundPph: 0,
    windowOutboundPph: 0,
    windowTotalPph: 0,
    pphWindowSec: 0,
    demandOutboundPph: 0,
    demandTotalPph: 0,
    completedInbound: 0,
    completedOutbound: 0,
    completedSeededOutbound: 0,
    completedDemandOutbound: 0,
    activeTasks: 0,
    queuedTasks: 0,
    averageTaskCycleSec: 0,
    p95TaskCycleSec: 0,
    averageTaskWaitSec: 0,
    vehicleUtilization: {},
    vehicleUtilizationBreakdown: {},
    liftPph: {},
    blockedTimeByReasonSec: {},
    reservationConflictCount: 0,
    replanCount: 0,
    deadlockCount: 0,
    livelockCount: 0,
    eventLogHash: 'empty',
    ...overrides
  };
}

function state(overrides: Partial<ShuttleSimState> = {}): ShuttleSimState {
  return {
    schemaVersion: 'shuttle.phase0.state.v0',
    scenarioId: 'scenario',
    sessionId: 'session',
    status: 'running',
    simTimeSec: 0,
    durationSec: 60,
    seed: 1,
    vehicles: [vehicle({ id: 'SH-01' }), vehicle({ id: 'SH-02', currentNodeId: 'parking-b', z: 4 })],
    tasks: [],
    loads: [],
    reservations: [],
    traffic: {
      trafficMode: 'flow-debug',
      safetyValidated: false,
      collisionAvoidanceEnabled: true,
      longHorizonReservationEnabled: false,
      clearThroughLookaheadEnabled: true,
      clearThroughMaxLookaheadLegs: 8,
      activeFutureGrantCount: 0,
      legacyZoneHoldEnabled: false,
      activeReservationCount: 0,
      waitingVehicles: [],
      conflictSessions: [],
      liftPorts: [],
      deadlockCandidateVehicleIds: [],
      minVehicleSeparationM: null,
      maxObservedSpeedMps: 0,
      physicalViolationCount: 0
    },
    kpis: kpis(),
    recentEvents: [],
    error: null,
    ...overrides
  };
}

describe('dashboard stream reducers', () => {
  it('merges incremental vehicleState messages into the current state snapshot', () => {
    const previous = state();
    const next = mergeVehicleStateUpdate(previous, [
      vehicle({ id: 'SH-02', state: 'loaded-moving', currentNodeId: 'x-main', currentEdgeId: 'main', speedMps: 1.5 }),
      vehicle({ id: 'SH-03', currentNodeId: 'parking-c', z: 8 })
    ], 12.5);

    expect(next?.simTimeSec).toBe(12.5);
    expect(next?.vehicles.map((candidate) => candidate.id)).toEqual(['SH-01', 'SH-02', 'SH-03']);
    expect(next?.vehicles.find((candidate) => candidate.id === 'SH-01')?.currentNodeId).toBe('parking-a');
    expect(next?.vehicles.find((candidate) => candidate.id === 'SH-02')?.state).toBe('loaded-moving');
    expect(next?.vehicles.find((candidate) => candidate.id === 'SH-02')?.speedMps).toBe(1.5);
  });

  it('merges kpiUpdate messages into the current state snapshot', () => {
    const next = mergeKpiUpdate(state(), kpis({ totalPph: 120, reservationConflictCount: 4 }), 22);

    expect(next?.simTimeSec).toBe(22);
    expect(next?.kpis.totalPph).toBe(120);
    expect(next?.kpis.reservationConflictCount).toBe(4);
  });
});

describe('dashboard live vehicle interpolation', () => {
  it('allows interpolation only while the vehicle remains on the same motion leg', () => {
    const previous = vehicle({
      id: 'SH-01',
      state: 'moving-to-pickup',
      currentNodeId: 'column-top-b-c08',
      targetNodeId: 'column-top-b-c09',
      currentEdgeId: 'column-top-b-c08-column-top-b-c09',
      taskId: 'task-0001',
      x: 12.5,
      z: 0.8
    });
    const next = vehicle({
      ...previous,
      x: 13,
      z: 0.8
    });

    expect(vehicleCanInterpolateVisual(previous, next)).toBe(true);
  });

  it('does not interpolate across node or edge changes because that draws false shortcuts', () => {
    const previous = vehicle({
      id: 'SH-01',
      state: 'moving-to-pickup',
      currentNodeId: 'column-top-b-c08',
      targetNodeId: 'column-top-b-c09',
      currentEdgeId: 'column-top-b-c08-column-top-b-c09',
      taskId: 'task-0001',
      x: 12.5,
      z: 0.8
    });
    const next = vehicle({
      ...previous,
      currentNodeId: 'column-top-b-c09',
      targetNodeId: 'lift-01-inbound-queue-01-entry-access',
      currentEdgeId: 'lift-01-inbound-queue-01-entry-access-column-top-b-c09',
      x: 13.75,
      z: 0.1
    });

    expect(vehicleCanInterpolateVisual(previous, next)).toBe(false);
  });
});

describe('dashboard flow colors', () => {
  it('keeps active outbound loads orange while they are still stored or carried', () => {
    const outboundState = state({
      vehicles: [
        vehicle({ id: 'SH-01', loaded: true, taskId: 'task-outbound-01', currentNodeId: 'storage-r01-c01' })
      ],
      tasks: [
        {
          id: 'task-outbound-01',
          kind: 'outbound',
          state: 'in-progress',
          createdAtSec: 0,
          assignedAtSec: 1,
          startedAtSec: 2,
          completedAtSec: null,
          pickupNodeId: 'storage-r01-c01',
          dropoffNodeId: 'outbound-lift-top-01',
          loadId: 'load-outbound-01',
          vehicleId: 'SH-01',
          replanCount: 0,
          waitReason: null
        }
      ],
      loads: [
        {
          id: 'load-outbound-01',
          state: 'carried',
          nodeId: null,
          vehicleId: 'SH-01',
          weightKg: 100
        }
      ]
    });

    expect(resolveLoadFlowRole(outboundState, outboundState.loads[0]!)).toBe('outbound');
    expect(resolveVehicleLoadFlowRole(outboundState, outboundState.vehicles[0]!)).toBe('outbound');
    expect(FLOW_VISUAL_COLORS.outbound.hex).toBe('#e2b84b');
  });

  it('keeps inventory inbound-colored until an active outbound task claims it', () => {
    const storedState = state({
      loads: [
        {
          id: 'load-stored-01',
          state: 'stored',
          nodeId: 'storage-r01-c01',
          vehicleId: null,
          weightKg: 100
        }
      ]
    });

    const claimedState = state({
      tasks: [
        {
          id: 'task-outbound-02',
          kind: 'outbound',
          state: 'assigned',
          createdAtSec: 0,
          assignedAtSec: 1,
          startedAtSec: null,
          completedAtSec: null,
          pickupNodeId: 'storage-r01-c01',
          dropoffNodeId: 'outbound-lift-top-01',
          loadId: 'load-stored-01',
          vehicleId: 'SH-01',
          replanCount: 0,
          waitReason: null
        }
      ],
      loads: storedState.loads
    });

    expect(resolveLoadFlowRole(storedState, storedState.loads[0]!)).toBe('inbound');
    expect(resolveLoadFlowRole(claimedState, claimedState.loads[0]!)).toBe('outbound');
  });
});

describe('dashboard parameter controls', () => {
  it('resets structural changes but only auto-resumes active runs', () => {
    expect(shouldResetAfterParamUpdate('/taskGeneration/inboundRatePerHour', 'running')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/taskGeneration/inboundRatePerHour', 'running')).toBe(true);

    expect(shouldResetAfterParamUpdate('/taskGeneration/outboundRatePerHour', 'paused')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/taskGeneration/outboundRatePerHour', 'paused')).toBe(false);

    expect(shouldResetAfterParamUpdate('/vehicles/count', 'idle')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/vehicles/count', 'idle')).toBe(false);

    expect(shouldResetAfterParamUpdate('/trafficPolicy/collisionAvoidanceEnabled', 'running')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/trafficPolicy/collisionAvoidanceEnabled', 'running')).toBe(true);
    expect(shouldResetAfterParamUpdate('/trafficPolicy/sourceBufferCapacity', 'running')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/trafficPolicy/sourceBufferCapacity', 'running')).toBe(true);

    expect(shouldResetAfterParamUpdate('/physicsParams/loadedSpeedMps', 'running')).toBe(false);
    expect(shouldResumeAfterParamUpdate('/physicsParams/loadedSpeedMps', 'running')).toBe(false);

    expect(shouldResetAfterParamUpdate('/physicsParams/loadedSpeedMps', 'completed')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/physicsParams/loadedSpeedMps', 'completed')).toBe(true);
  });
});

describe('dashboard scenario setup', () => {
  it('summarizes top-lift region count from the generated layout', () => {
    const scenario = createInboundMvpBaselineScenario({
      layoutProfile: {
        liftPairCount: 3
      }
    });
    const setup = summarizeScenarioSetup(scenario);

    expect(inferTopLiftRegionCount(scenario)).toBe(3);
    expect(setup).toMatchObject({
      regionCount: 3,
      shuttleCount: 8,
      storageRows: 14,
      storageColumns: 42,
      storageCapacity: 588,
      physicalLiftCount: 6,
      inboundLiftCount: 3,
      outboundLiftCount: 3
    });
  });
});

describe('dashboard resource utilization', () => {
  it('summarizes storage, shuttle, and lift utilization from the live state', () => {
    const scenario = createDefaultShuttleScenario();
    const summary = summarizeResourceUtilization(scenario, state({
      vehicles: [
        vehicle({ id: 'SH-01', state: 'loaded-moving', taskId: 'task-001' }),
        vehicle({ id: 'SH-02', state: 'idle' })
      ],
      tasks: [
        {
          id: 'task-001',
          kind: 'inbound',
          state: 'in-progress',
          createdAtSec: 0,
          assignedAtSec: 1,
          startedAtSec: 2,
          completedAtSec: null,
          pickupNodeId: 'inbound-lift-top-01',
          dropoffNodeId: 'storage-r01-c02',
          loadId: 'load-001',
          vehicleId: 'SH-01',
          replanCount: 0,
          waitReason: null
        }
      ],
      loads: [
        {
          id: 'load-stored',
          state: 'stored',
          nodeId: 'storage-r01-c01',
          vehicleId: null,
          weightKg: 100
        }
      ],
      traffic: {
        trafficMode: 'flow-debug',
        safetyValidated: false,
        collisionAvoidanceEnabled: true,
        longHorizonReservationEnabled: false,
        clearThroughLookaheadEnabled: true,
        clearThroughMaxLookaheadLegs: 8,
        activeFutureGrantCount: 0,
        legacyZoneHoldEnabled: false,
        activeReservationCount: 0,
        waitingVehicles: [],
        conflictSessions: [],
        liftPorts: [
          {
            nodeId: 'inbound-lift-top-01',
            kind: 'inbound',
            queueLength: 2,
            waitingTaskIds: ['task-002', 'task-003'],
            activeTaskId: 'task-001',
            approachOccupancy: 1,
            approachCapacity: 1,
            sourceBufferOccupancy: 2,
            sourceBufferCapacity: 4,
            completedTasks: 3,
            pph: 36,
            utilization: 0.5
          },
          {
            nodeId: 'outbound-lift-top-01',
            kind: 'outbound',
            queueLength: 0,
            waitingTaskIds: [],
            activeTaskId: null,
            approachOccupancy: 0,
            approachCapacity: 1,
            sourceBufferOccupancy: 0,
            sourceBufferCapacity: 1,
            completedTasks: 1,
            pph: 12,
            utilization: 0.1
          }
        ],
        deadlockCandidateVehicleIds: [],
        minVehicleSeparationM: null,
        maxObservedSpeedMps: 0,
        physicalViolationCount: 0
      },
      kpis: kpis({
        vehicleUtilization: {
          'SH-01': 0.75,
          'SH-02': 0.25
        },
        vehicleUtilizationBreakdown: {
          'SH-01': { busy: 0.75, productive: 0.6, moving: 0.55, handling: 0.05, waiting: 0.1, idle: 0.25, tasklessTravel: 0 },
          'SH-02': { busy: 0.25, productive: 0.05, moving: 0.1, handling: 0, waiting: 0.15, idle: 0.75, tasklessTravel: 0.05 }
        }
      })
    }));

    expect(summary.storage).toMatchObject({
      totalCells: 384,
      usedCells: 2,
      storedCells: 1,
      reservedInboundCells: 1
    });
    expect(summary.storage.utilizationPct).toBeCloseTo(0.5208, 4);
    expect(summary.shuttles).toMatchObject({
      total: 2,
      active: 1,
      idle: 1,
      averageUtilizationPct: 50,
      peakUtilizationPct: 75,
      averageProductivePct: 32.5,
      averageWaitingPct: 12.5,
      averageIdlePct: 50,
      averageTasklessTravelPct: 2.5
    });
    expect(summary.lifts).toMatchObject({
      total: 2,
      active: 1,
      approachOccupied: 1,
      approachCapacity: 2,
      inboundEnabled: 1,
      outboundEnabled: 1,
      queuedTasks: 2,
      averageUtilizationPct: 30,
      inboundAverageUtilizationPct: 50,
      outboundAverageUtilizationPct: 10
    });
  });
});

describe('dashboard static scene contract', () => {
  it('keeps the 3D shuttle body on the physical graph instead of route-display snap rails', () => {
    const liftHelper = {
      id: 'lift-01-inbound-queue-01-entry-access',
      type: 'aisle' as const,
      x: 8,
      y: 0,
      z: 2,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const serviceExit = {
      id: 'lift-01-inbound-queue-01-service-exit',
      type: 'aisle' as const,
      x: 8,
      y: 0,
      z: 5,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const railNode = {
      id: 'column-top-b-c08',
      type: 'aisle' as const,
      x: 14,
      y: 0,
      z: 5,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const bodyPose = resolveScene3DVehicleBodyPose(new Map([
      [liftHelper.id, liftHelper],
      [serviceExit.id, serviceExit],
      [railNode.id, railNode]
    ]), vehicle({
      id: 'SH-03',
      state: 'moving-to-pickup',
      currentNodeId: liftHelper.id,
      targetNodeId: serviceExit.id,
      currentEdgeId: `${liftHelper.id}-${serviceExit.id}`,
      x: 9.4,
      z: 3.25,
      yaw: 1.25
    }));

    expect(bodyPose.x).toBeCloseTo(8, 6);
    expect(bodyPose.z).toBeCloseTo(3.25, 6);
    expect(bodyPose.yaw).toBeCloseTo(1.25, 6);
    expect(bodyPose.x).not.toBeCloseTo(railNode.x, 6);
  });

  it('keeps the 3D visual coordinates aligned with the authoritative 2D map', () => {
    const scenario = createDefaultShuttleScenario();
    const visualScenario = resolveScene3DVisualScenario(scenario);
    const sourceNode = scenario.layout.nodes.find((node) => Math.abs(node.x) > 0.1);
    expect(sourceNode).toBeDefined();

    const visualNode = visualScenario.layout.nodes.find((node) => node.id === sourceNode?.id);
    expect(visualNode?.x).toBeCloseTo(sourceNode?.x ?? 0, 6);
    expect(visualNode?.z).toBeCloseTo(sourceNode?.z ?? 0, 6);

    const contract = resolveDashboardStaticSceneContract(scenario);
    const visualContract = resolveScene3DVisualStaticScene(contract);
    expect(visualContract.storageCells[0]?.xM).toBeCloseTo(contract.storageCells[0]?.xM ?? 0, 6);
    expect(visualContract.storageCells[0]?.zM).toBeCloseTo(contract.storageCells[0]?.zM ?? 0, 6);
    expect(visualContract.storageBlockMinXM).toBeCloseTo(contract.storageBlockMinXM, 6);
    expect(visualContract.storageBlockMaxXM).toBeCloseTo(contract.storageBlockMaxXM, 6);

    const visualState = resolveScene3DVisualState(state({
      vehicles: [
        vehicle({ id: 'SH-03', x: 4.25, z: -2.5, yaw: 0 })
      ]
    }));
    expect(visualState?.vehicles[0]?.x).toBeCloseTo(4.25, 6);
    expect(visualState?.vehicles[0]?.z).toBeCloseTo(-2.5, 6);
    expect(visualState?.vehicles[0]?.yaw).toBeCloseTo(0, 6);
  });

  it('uses the SimCore item-level layout contract for the browser visual twin', () => {
    const contract = resolveDashboardStaticSceneContract(createDefaultShuttleScenario());
    const cadDimensions = resolveCadDimensionAnnotations(contract);

    expect(contract).toEqual(summarizeScenarioStaticSceneContract(createDefaultShuttleScenario()));
    expect(contract).toEqual(goldenStaticSceneContract);
    expect(contract.schemaVersion).toBe('shuttle.simCoreStaticSceneContract.v1');
    expect(contract.singleLevel).toBe(true);
    expect(contract.storageIslandCount).toBe(8);
    expect(contract.denseStorageIslands).toBe(true);
    expect(contract.denseStorageBlock).toBe(false);
    expect(contract.orthogonalTrackOnly).toBe(true);
    expect(contract.dedicatedLiftPorts).toBe(true);
    expect(contract.storagePolicy).toBe('rowContiguousLaneFill');
    expect(contract.inboundStorageFlow).toBe('rightToLeft');
    expect(contract.outboundStorageFlow).toBe('leftPick');
    expect(contract.layoutCalibrationProfile?.id).toBe('phase0-cad-assumption-v1');
    expect(contract.layoutCalibrationProfile?.status).toBe('assumption');
    expect(contract.calibrationReadiness.status).toBe('assumption');
    expect(contract.calibrationReadiness.readyForIndustrialThroughputClaims).toBe(false);
    expect(contract.calibrationReadiness.missingDimensionKeys).toContain('palletLength');
    expect(contract.calibrationReadiness.missingDimensionKeys).toContain('shuttleLength');
    expect(contract.storageCells).toHaveLength(384);
    expect(contract.blockedCells).toEqual([]);
    expect(contract.blockedCellCount).toBe(0);
    expect(contract.structuralCellCount).toBe(0);
    expect(contract.storageCells.every((cell) => cell.lengthXM === 1.25 && cell.lengthZM === 1.2)).toBe(true);
    expect(contract.storageRows).toBe(16);
    expect(contract.storageColumns).toBe(24);
    expect(contract.liftPads.filter((pad) => pad.category === 'inboundLift')).toHaveLength(4);
    expect(contract.liftPads.filter((pad) => pad.category === 'outboundLift')).toHaveLength(4);
    expect(contract.liftPads.some((pad) => pad.side === 'mixed')).toBe(true);
    expect(contract.trackBeds.some((track) => track.category === 'storageLane')).toBe(true);
    expect(contract.diagonalTrackCount).toBe(0);
    expect(cadDimensions).toMatchObject({
      storagePitchXLabelMm: '1250',
      storagePitchZLabelMm: '1200',
      innerBankGap: {
        startZM: -2.2,
        endZM: 2.2,
        labelMm: '4400'
      }
    });
  });

  it('keeps CAD floor dimension annotations synchronized with layout-profile overrides', () => {
    const contract = resolveDashboardStaticSceneContract(createDefaultShuttleScenario({
      layoutProfile: {
        storageCellPitchXM: 1.3,
        storageCellPitchZM: 1.25,
        storageInnerRowZM: 2.35,
        calibrationProfile: {
          id: 'dashboard-dimension-test-profile',
          label: 'Dashboard dimension test profile',
          status: 'partial-cad',
          sourceDescription: 'Test profile for dashboard CAD annotation sync.'
        }
      }
    }));

    expect(resolveCadDimensionAnnotations(contract)).toMatchObject({
      storagePitchXLabelMm: '1300',
      storagePitchZLabelMm: '1250',
      innerBankGap: {
        startZM: -2.35,
        endZM: 2.35,
        labelMm: '4700'
      }
    });
  });
});
