import type { KpiSnapshot, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { createDefaultShuttleScenario, summarizeScenarioStaticSceneContract } from '@four-way-shuttle/sim-core';
import { describe, expect, it } from 'vitest';

import goldenStaticSceneContract from '../../../config/shuttle/static-scene-contract.golden.json';
import {
  mergeKpiUpdate,
  mergeVehicleStateUpdate,
  shouldResetAfterParamUpdate,
  shouldResumeAfterParamUpdate,
  summarizeResourceUtilization
} from './App.js';
import { resolveCadDimensionAnnotations, resolveDashboardStaticSceneContract } from './ShuttleScene3D.js';

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
    completedInbound: 0,
    completedOutbound: 0,
    activeTasks: 0,
    queuedTasks: 0,
    averageTaskCycleSec: 0,
    p95TaskCycleSec: 0,
    averageTaskWaitSec: 0,
    vehicleUtilization: {},
    vehicleUtilizationBreakdown: {},
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
      longHorizonReservationEnabled: false,
      legacyZoneHoldEnabled: false,
      activeReservationCount: 0,
      waitingVehicles: [],
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

describe('dashboard parameter controls', () => {
  it('resets structural changes but only auto-resumes active runs', () => {
    expect(shouldResetAfterParamUpdate('/taskGeneration/inboundRatePerHour', 'running')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/taskGeneration/inboundRatePerHour', 'running')).toBe(true);

    expect(shouldResetAfterParamUpdate('/taskGeneration/outboundRatePerHour', 'paused')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/taskGeneration/outboundRatePerHour', 'paused')).toBe(false);

    expect(shouldResetAfterParamUpdate('/vehicles/count', 'idle')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/vehicles/count', 'idle')).toBe(false);

    expect(shouldResetAfterParamUpdate('/physicsParams/loadedSpeedMps', 'running')).toBe(false);
    expect(shouldResumeAfterParamUpdate('/physicsParams/loadedSpeedMps', 'running')).toBe(false);

    expect(shouldResetAfterParamUpdate('/physicsParams/loadedSpeedMps', 'completed')).toBe(true);
    expect(shouldResumeAfterParamUpdate('/physicsParams/loadedSpeedMps', 'completed')).toBe(true);
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
        longHorizonReservationEnabled: false,
        legacyZoneHoldEnabled: false,
        activeReservationCount: 0,
        waitingVehicles: [],
        liftPorts: [
          {
            nodeId: 'inbound-lift-top-01',
            kind: 'inbound',
            queueLength: 2,
            waitingTaskIds: ['task-002', 'task-003'],
            activeTaskId: 'task-001',
            approachOccupancy: 1,
            approachCapacity: 1,
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
