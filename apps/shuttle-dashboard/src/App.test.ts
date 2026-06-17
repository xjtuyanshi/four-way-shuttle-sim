import type { KpiSnapshot, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { createDefaultShuttleScenario, createInboundMvpBaselineScenario, summarizeScenarioStaticSceneContract } from '@four-way-shuttle/sim-core';
import { describe, expect, it } from 'vitest';

import goldenStaticSceneContract from '../../../config/shuttle/static-scene-contract.golden.json';
import {
  mergeKpiUpdate,
  mergeVehicleStateUpdate,
  inferTopLiftRegionCount,
  shouldResetAfterParamUpdate,
  shouldResumeAfterParamUpdate,
  shouldInterpolateLiveVehicles,
  summarizeOutboundDemandMix,
  summarizeScenarioSetup,
  summarizeResourceUtilization,
  vehicleCanInterpolateVisual,
  vehicleListHasSquareFootprintOverlap,
  vehicleVisualBodySideM as vehicleVisualBodySideM2D
} from './App.js';
import {
  resolveCadDimensionAnnotations,
  resolveDashboardStaticSceneContract,
  resolveScene3DVehicleBodyPose,
  resolveScene3DVisualScenario,
  resolveScene3DVisualState,
  resolveScene3DVisualStaticScene,
  vehicleVisualBodySideM as vehicleVisualBodySideM3D
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

describe('dashboard outbound demand mix', () => {
  it('separates seeded outbound sweep from demand outbound throughput', () => {
    const mix = summarizeOutboundDemandMix(kpis({
      completedOutbound: 131,
      completedSeededOutbound: 126,
      completedDemandOutbound: 5,
      demandOutboundPph: 15,
      demandTotalPph: 135
    }));

    expect(mix).toMatchObject({
      totalCompletedOutbound: 131,
      seededOutboundCount: 126,
      demandOutboundCount: 5,
      demandOutboundPph: 15,
      demandTotalPph: 135
    });
    expect(mix.seededSharePct).toBeCloseTo(96.183, 3);
    expect(mix.demandSharePct).toBeCloseTo(3.817, 3);
  });
});

describe('dashboard live vehicle interpolation', () => {
  it('detects visual shuttle footprint overlap from the scenario dimensions', () => {
    const scenario = createDefaultShuttleScenario();
    const sideM = Math.max(scenario.vehicles.lengthM, scenario.vehicles.widthM);

    expect(vehicleListHasSquareFootprintOverlap([
      vehicle({ id: 'SH-01', x: 10, z: 5 }),
      vehicle({ id: 'SH-02', x: 10 + sideM * 0.5, z: 5 })
    ], scenario)).toBe(true);
    expect(vehicleListHasSquareFootprintOverlap([
      vehicle({ id: 'SH-01', x: 10, z: 5 }),
      vehicle({ id: 'SH-02', x: 10 + sideM + 0.25, z: 5 })
    ], scenario)).toBe(false);
  });

  it('keeps 2D and 3D visible shuttle bodies inside the physical square envelope', () => {
    const scenario = createDefaultShuttleScenario();
    const physicalSideM = Math.max(scenario.vehicles.lengthM, scenario.vehicles.widthM);

    expect(vehicleVisualBodySideM2D(scenario)).toBeCloseTo(vehicleVisualBodySideM3D(scenario), 6);
    expect(vehicleVisualBodySideM2D(scenario)).toBeGreaterThan(0);
    expect(vehicleVisualBodySideM2D(scenario)).toBeLessThan(physicalSideM);
  });

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

  it('disables live vehicle interpolation at high review speeds', () => {
    expect(shouldInterpolateLiveVehicles(1, true)).toBe(true);
    expect(shouldInterpolateLiveVehicles(10, true)).toBe(true);
    expect(shouldInterpolateLiveVehicles(100, true)).toBe(false);
    expect(shouldInterpolateLiveVehicles(1, false)).toBe(false);
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
          'SH-01': { busy: 0.75, productive: 0.6, moving: 0.55, handling: 0.05, waiting: 0.1, idle: 0.25, tasklessTravel: 0, queueReserveTravel: 0, wasteReposition: 0 },
          'SH-02': { busy: 0.25, productive: 0.05, moving: 0.1, handling: 0, waiting: 0.15, idle: 0.75, tasklessTravel: 0.05, queueReserveTravel: 0.03, wasteReposition: 0.02 }
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
      averageTasklessTravelPct: 2.5,
      averageQueueReserveTravelPct: 1.5,
      averageWasteRepositionPct: 1
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
  it('keeps the 3D shuttle body out of lift no-drive service pads', () => {
    const serviceExit = {
      id: 'lift-01-outbound-queue-01-service-exit',
      type: 'aisle' as const,
      x: 11.25,
      y: 0,
      z: 22.8,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const liftBlackbox: ShuttleScenario['layout']['nodes'][number] = {
      id: 'lift-01-outbound',
      type: 'aisle' as const,
      x: 11.95,
      y: 0,
      z: 23.4,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const bufferNode: ShuttleScenario['layout']['nodes'][number] = {
      id: 'lift-01-outbound-buffer-01',
      type: 'aisle' as const,
      x: 11.25,
      y: 0,
      z: 23.4,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const entryAccess = {
      id: 'lift-01-outbound-queue-01-entry-access',
      type: 'aisle' as const,
      x: 8.75,
      y: 0,
      z: 22.8,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const thirdServiceExit = {
      id: 'lift-01-outbound-queue-03-service-exit',
      type: 'aisle' as const,
      x: 11.25,
      y: 0,
      z: 26,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const thirdEntryAccess = {
      id: 'lift-01-outbound-queue-03-entry-access',
      type: 'aisle' as const,
      x: 8.75,
      y: 0,
      z: 26,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const parkingQueue = {
      id: 'parking-lift-01-outbound-queue',
      type: 'parking' as const,
      x: 7.5,
      y: 0,
      z: 23.4,
      noStop: false,
      noParking: false,
      capacity: 1,
      allowedDirections: []
    };
    const railNode = (id: string, x: number, z = 21.6): ShuttleScenario['layout']['nodes'][number] => ({
      id,
      type: 'intersection',
      x,
      y: 0,
      z,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    });
    const bottomB05 = railNode('column-bottom-b-c05', 7.5);
    const bottomB06 = railNode('column-bottom-b-c06', 8.75);
    const bottomB07 = railNode('column-bottom-b-c07', 10);
    const bottomB08 = railNode('column-bottom-b-c08', 11.25);
    const nodeById: Map<string, ShuttleScenario['layout']['nodes'][number]> = new Map<string, ShuttleScenario['layout']['nodes'][number]>([
      [serviceExit.id, serviceExit],
      [liftBlackbox.id, liftBlackbox],
      [bufferNode.id, bufferNode],
      [entryAccess.id, entryAccess],
      [thirdServiceExit.id, thirdServiceExit],
      [thirdEntryAccess.id, thirdEntryAccess],
      [parkingQueue.id, parkingQueue],
      [bottomB05.id, bottomB05],
      [bottomB06.id, bottomB06],
      [bottomB07.id, bottomB07],
      [bottomB08.id, bottomB08]
    ]);
    const bodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-03',
      state: 'loaded-moving',
      currentNodeId: liftBlackbox.id,
      targetNodeId: bufferNode.id,
      currentEdgeId: `${liftBlackbox.id}-${bufferNode.id}`,
      x: 11.6,
      z: 23.4,
      yaw: 1.25,
      plannedRouteNodeIds: [liftBlackbox.id, bufferNode.id]
    }));
    const stoppedBodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-04',
      state: 'loaded-moving',
      currentNodeId: liftBlackbox.id,
      targetNodeId: null,
      currentEdgeId: null,
      x: liftBlackbox.x,
      z: liftBlackbox.z,
      yaw: -0.5,
      plannedRouteNodeIds: [liftBlackbox.id, bufferNode.id]
    }));
    const horizontalBodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-05',
      state: 'loaded-moving',
      currentNodeId: serviceExit.id,
      targetNodeId: entryAccess.id,
      currentEdgeId: `${serviceExit.id}-${entryAccess.id}`,
      x: 10,
      z: 22.8,
      yaw: -0.5,
      plannedRouteNodeIds: [serviceExit.id, entryAccess.id]
    }));
    const leftQueueBodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-06',
      state: 'loaded-moving',
      currentNodeId: serviceExit.id,
      targetNodeId: parkingQueue.id,
      currentEdgeId: `${serviceExit.id}-${parkingQueue.id}`,
      x: 9.4,
      z: 23.1,
      yaw: -0.5,
      plannedRouteNodeIds: [serviceExit.id, parkingQueue.id]
    }));
    const thirdSlotBodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-07',
      state: 'loaded-moving',
      currentNodeId: thirdServiceExit.id,
      targetNodeId: thirdEntryAccess.id,
      currentEdgeId: `${thirdServiceExit.id}-${thirdEntryAccess.id}`,
      x: 10,
      z: 26,
      yaw: -0.5,
      plannedRouteNodeIds: [thirdServiceExit.id, thirdEntryAccess.id]
    }));

    expect(bodyPose.x).toBeCloseTo(bottomB08.x, 6);
    expect(bodyPose.z).toBeCloseTo(bottomB08.z, 6);
    expect(bodyPose.yaw).toBeCloseTo(1.25, 6);
    expect(stoppedBodyPose.x).toBeCloseTo(bottomB08.x, 6);
    expect(stoppedBodyPose.z).toBeCloseTo(bottomB08.z, 6);
    expect(horizontalBodyPose.x).toBeGreaterThan(bottomB06.x);
    expect(horizontalBodyPose.x).toBeLessThanOrEqual(bottomB08.x);
    expect(horizontalBodyPose.z).toBeCloseTo(bottomB08.z, 6);
    expect(leftQueueBodyPose.x).toBeLessThanOrEqual(bottomB08.x);
    expect(leftQueueBodyPose.z).toBeCloseTo(bottomB08.z, 6);
    expect(thirdSlotBodyPose.x).toBeLessThanOrEqual(bottomB08.x);
    expect(thirdSlotBodyPose.z).toBeCloseTo(bottomB08.z, 6);
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

  it('snaps inbound lift pickup visuals to the lift-side yellow edge stop', () => {
    const liftBlackbox = {
      id: 'lift-01-inbound',
      type: 'aisle' as const,
      x: 10.55,
      y: 0,
      z: -2.6,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const queueAccess = {
      id: 'lift-01-inbound-queue-access',
      type: 'aisle' as const,
      x: 12.5,
      y: 0,
      z: -2,
      noStop: false,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const serviceExit: ShuttleScenario['layout']['nodes'][number] = {
      id: 'lift-01-inbound-queue-01-service-exit',
      type: 'intersection' as const,
      x: 11.25,
      y: 0,
      z: -2,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const topA07: ShuttleScenario['layout']['nodes'][number] = {
      id: 'column-top-a-c07',
      type: 'intersection' as const,
      x: 10,
      y: 0,
      z: -0.8,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const topA08: ShuttleScenario['layout']['nodes'][number] = {
      id: 'column-top-a-c08',
      type: 'intersection' as const,
      x: 12.5,
      y: 0,
      z: -0.8,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const topB08: ShuttleScenario['layout']['nodes'][number] = {
      id: 'column-top-b-c08',
      type: 'intersection' as const,
      x: 12.5,
      y: 0,
      z: 0.8,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const nodeById: Map<string, ShuttleScenario['layout']['nodes'][number]> = new Map([
      [liftBlackbox.id, liftBlackbox],
      [queueAccess.id, queueAccess],
      [serviceExit.id, serviceExit],
      [topA07.id, topA07],
      [topA08.id, topA08],
      [topB08.id, topB08]
    ]);

    const bodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-01',
      state: 'moving-to-pickup',
      currentNodeId: liftBlackbox.id,
      x: liftBlackbox.x,
      z: liftBlackbox.z,
      plannedRouteNodeIds: [liftBlackbox.id, queueAccess.id, topA08.id]
    }));

    expect(bodyPose.x).toBeCloseTo(topA08.x, 6);
    expect(bodyPose.z).toBeCloseTo(topA08.z, 6);
    expect(bodyPose.x).not.toBeCloseTo(serviceExit.x, 6);
    expect(bodyPose.z).not.toBeCloseTo(topB08.z, 6);
  });

  it('keeps inbound lift queue vehicles on the yellow rail they are actually traversing', () => {
    const topA23: ShuttleScenario['layout']['nodes'][number] = {
      id: 'column-top-a-c23',
      type: 'intersection',
      x: 33.75,
      y: 0,
      z: -0.8,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const topB23: ShuttleScenario['layout']['nodes'][number] = {
      id: 'column-top-b-c23',
      type: 'intersection',
      x: 33.75,
      y: 0,
      z: 0.8,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const queueEntry: ShuttleScenario['layout']['nodes'][number] = {
      id: 'lift-02-inbound-queue-01-entry-access',
      type: 'intersection',
      x: 33.75,
      y: 0,
      z: -2,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const queueAccess: ShuttleScenario['layout']['nodes'][number] = {
      id: 'lift-02-inbound-queue-01-access',
      type: 'intersection',
      x: 33.75,
      y: 0,
      z: -2.6,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const queueParking: ShuttleScenario['layout']['nodes'][number] = {
      id: 'parking-lift-02-inbound-queue-02',
      type: 'parking',
      x: 35,
      y: 0,
      z: -4.2,
      noStop: true,
      noParking: true,
      capacity: 1,
      allowedDirections: []
    };
    const nodeById: Map<string, ShuttleScenario['layout']['nodes'][number]> = new Map([
      [topA23.id, topA23],
      [topB23.id, topB23],
      [queueEntry.id, queueEntry],
      [queueAccess.id, queueAccess],
      [queueParking.id, queueParking]
    ]);

    const bodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-06',
      state: 'moving-to-pickup',
      currentNodeId: queueEntry.id,
      targetNodeId: queueAccess.id,
      currentEdgeId: `${queueEntry.id}-${queueAccess.id}`,
      x: 32.5,
      z: topB23.z,
      plannedRouteNodeIds: [queueEntry.id, queueAccess.id]
    }));
    const parkedBodyPose = resolveScene3DVehicleBodyPose(nodeById, vehicle({
      id: 'SH-07',
      state: 'waiting-blocked',
      currentNodeId: queueParking.id,
      targetNodeId: null,
      currentEdgeId: null,
      x: queueParking.x,
      z: queueParking.z,
      plannedRouteNodeIds: [queueParking.id]
    }));

    expect(bodyPose.z).toBeCloseTo(topB23.z, 6);
    expect(bodyPose.z).not.toBeCloseTo(topA23.z, 6);
    expect(parkedBodyPose.z).toBeCloseTo(topB23.z, 6);
    expect(parkedBodyPose.z).not.toBeCloseTo(topA23.z, 6);
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
