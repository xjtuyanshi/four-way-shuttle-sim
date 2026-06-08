import type { KpiSnapshot, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import type { HeadlessDesResult } from '@four-way-shuttle/sim-core';
import { createDefaultShuttleScenario, createInboundMvpBaselineScenario, summarizeScenarioStaticSceneContract } from '@four-way-shuttle/sim-core';
import { describe, expect, it } from 'vitest';

import goldenStaticSceneContract from '../../../config/shuttle/static-scene-contract.golden.json';
import {
  appendPphHistorySample,
  buildLiveHourlyRows,
  buildLiveTrendDiagnosis,
  buildDesDispatchAuditRows,
  buildReviewDesEvidence,
  buildReviewTrafficReadouts,
  liveTrendMarkers,
  mergeKpiUpdate,
  mergeVehicleStateUpdate,
  inferTopLiftRegionCount,
  shouldResetAfterParamUpdate,
  shouldResumeAfterParamUpdate,
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

function headlessDesForAudit(options: {
  routeNodeIds: string[];
  trafficWaitSec: number;
  trafficResourceId?: string;
}): HeadlessDesResult {
  const trafficPhase = options.trafficWaitSec > 0
    ? [{
      kind: 'traffic-wait' as const,
      startSec: 1,
      endSec: 1 + options.trafficWaitSec,
      resourceId: options.trafficResourceId
    }]
    : [];

  return {
    schemaVersion: 'shuttle.headlessDes.v1',
    scenarioId: 'audit-test',
    durationSec: 3600,
    finalSimTimeSec: 3600,
    wallClockMs: 1,
    processedEvents: 1,
    generatedInbound: 1,
    generatedOutbound: 0,
    acceptedInbound: 1,
    acceptedOutbound: 0,
    skippedInbound: 0,
    skippedOutbound: 0,
    completedInbound: 1,
    completedOutbound: 0,
    inboundPph: 1,
    outboundPph: 0,
    totalPph: 1,
    queuedTasks: 0,
    activeTasks: 0,
    pendingInboundDemand: 0,
    pendingOutboundDemand: 0,
    storedLoads: 1,
    storageCapacity: 1,
    storageUtilization: 1,
    averageShuttleUtilization: 0,
    averageWaitingPct: 0,
    averageRepositionPct: 0,
    maxContinuousWaitingSec: options.trafficWaitSec,
    maxQueuedTaskAgeSec: 0,
    sustainedCongestionWindows: 0,
    controlPolicy: { maxActiveTasks: 6, backpressureHoldCount: 0 },
    repositionBreakdown: {},
    waitReasonBreakdown: {},
    trafficBottlenecks: [],
    routeModel: {
      kind: 'yellow-graph-reservation-window',
      drivableNodeCount: 2,
      drivableEdgeCount: 1,
      mappedServiceNodeCount: 2,
      routeUnavailableCount: 0,
      reservationResourceCount: 1,
      reservationWindowCount: 1,
      trafficWaitSec: options.trafficWaitSec
    },
    shuttleUtilization: {},
    liftPph: {},
    bottlenecks: {},
    issues: [],
    anomalyMarkers: [],
    reservationReplay: {
      taskTraceLimit: 1,
      tracedTaskCount: 1,
      omittedTaskCount: 0,
      tasks: [{
        taskId: 'T-1',
        shuttleId: 'SH-01',
        kind: 'inbound',
        regionIndex: 0,
        createdAtSec: 0,
        dispatchSec: 0,
        completeSec: 30,
        pickupNodeId: options.routeNodeIds[0] ?? 'a',
        dropoffNodeId: options.routeNodeIds.at(-1) ?? 'b',
        storageNodeId: options.routeNodeIds.at(-1) ?? 'b',
        liftNodeId: options.routeNodeIds[0] ?? 'a',
        emptyRouteNodeIds: options.routeNodeIds,
        loadedRouteNodeIds: options.routeNodeIds,
        emptyTravelSec: 5,
        loadedTravelSec: 6,
        liftWaitSec: 0,
        trafficWaitSec: options.trafficWaitSec,
        handlingSec: 10,
        phases: [
          { kind: 'empty-travel', startSec: 0, endSec: 1 },
          ...trafficPhase,
          { kind: 'loaded-travel', startSec: 10, endSec: 20 }
        ]
      }],
      topWaitIntervals: []
    },
    samples: []
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

describe('dashboard live trend markers', () => {
  it('builds hourly live PPH buckets from cumulative completed counts', () => {
    const rows = buildLiveHourlyRows([
      {
        simTimeSec: 0,
        completedInbound: 0,
        completedOutbound: 0,
        inboundPph: 0,
        outboundPph: 0,
        totalPph: 0,
        waitingPct: 0,
        repositionPct: 0,
        liftPph: {}
      },
      {
        simTimeSec: 3600,
        completedInbound: 110,
        completedOutbound: 140,
        inboundPph: 110,
        outboundPph: 140,
        totalPph: 250,
        waitingPct: 0,
        repositionPct: 0,
        liftPph: {}
      },
      {
        simTimeSec: 7200,
        completedInbound: 250,
        completedOutbound: 245,
        inboundPph: 140,
        outboundPph: 105,
        totalPph: 245,
        waitingPct: 0,
        repositionPct: 0,
        liftPph: {}
      }
    ]);

    expect(rows.map((row) => row.label)).toEqual(['H01', 'H02']);
    expect(rows[0]).toMatchObject({ inboundDelta: 110, outboundDelta: 140, inboundPph: 110, outboundPph: 140, totalPph: 250 });
    expect(rows[1]).toMatchObject({ inboundDelta: 140, outboundDelta: 105, inboundPph: 140, outboundPph: 105, totalPph: 245 });
  });

  it('drops stale trend history when the live clock moves backward after reset', () => {
    const next = appendPphHistorySample([
      {
        simTimeSec: 120,
        inboundPph: 90,
        outboundPph: 70,
        totalPph: 160,
        waitingPct: 11,
        repositionPct: 5,
        liftPph: {}
      },
      {
        simTimeSec: 180,
        inboundPph: 115,
        outboundPph: 100,
        totalPph: 215,
        waitingPct: 8,
        repositionPct: 9,
        liftPph: {}
      }
    ], {
      simTimeSec: 0,
      inboundPph: 0,
      outboundPph: 0,
      totalPph: 0,
      waitingPct: 0,
      repositionPct: 0,
      liftPph: {}
    });

    expect(next).toEqual([{
      simTimeSec: 0,
      inboundPph: 0,
      outboundPph: 0,
      totalPph: 0,
      waitingPct: 0,
      repositionPct: 0,
      liftPph: {}
    }]);
  });

  it('computes low, high, and peak markers from the live KPI history', () => {
    const markers = liveTrendMarkers([
      {
        simTimeSec: 60,
        inboundPph: 100,
        outboundPph: 80,
        totalPph: 180,
        waitingPct: 4,
        repositionPct: 7,
        liftPph: {}
      },
      {
        simTimeSec: 120,
        inboundPph: 90,
        outboundPph: 70,
        totalPph: 160,
        waitingPct: 11,
        repositionPct: 5,
        liftPph: {}
      },
      {
        simTimeSec: 180,
        inboundPph: 115,
        outboundPph: 100,
        totalPph: 215,
        waitingPct: 8,
        repositionPct: 9,
        liftPph: {}
      }
    ]);

    expect(markers.total?.min).toBe(160);
    expect(markers.total?.minSimTimeSec).toBe(120);
    expect(markers.total?.max).toBe(215);
    expect(markers.total?.maxSimTimeSec).toBe(180);
    expect(markers.waiting?.max).toBe(11);
    expect(markers.waiting?.maxSimTimeSec).toBe(120);
    expect(markers.reposition?.min).toBe(5);
    expect(markers.reposition?.minSimTimeSec).toBe(120);
  });

  it('ignores startup zero samples once productive live trend samples exist', () => {
    const markers = liveTrendMarkers([
      {
        simTimeSec: 0,
        inboundPph: 0,
        outboundPph: 0,
        totalPph: 0,
        waitingPct: 0,
        repositionPct: 0,
        liftPph: {}
      },
      {
        simTimeSec: 60,
        inboundPph: 70,
        outboundPph: 50,
        totalPph: 120,
        waitingPct: 5,
        repositionPct: 6,
        liftPph: {}
      },
      {
        simTimeSec: 120,
        inboundPph: 100,
        outboundPph: 90,
        totalPph: 190,
        waitingPct: 7,
        repositionPct: 8,
        liftPph: {}
      }
    ]);

    const diagnosis = buildLiveTrendDiagnosis([
      {
        simTimeSec: 0,
        inboundPph: 0,
        outboundPph: 0,
        totalPph: 0,
        waitingPct: 0,
        repositionPct: 0,
        liftPph: {}
      },
      {
        simTimeSec: 60,
        inboundPph: 70,
        outboundPph: 50,
        totalPph: 120,
        waitingPct: 5,
        repositionPct: 6,
        liftPph: {}
      }
    ]);

    expect(markers.total?.min).toBe(120);
    expect(markers.total?.minSimTimeSec).toBe(60);
    expect(diagnosis.find((item) => item.id === 'window-throughput')?.evidence).toContain('1/2 productive samples');
  });

  it('turns live trend history into engineering diagnosis cards', () => {
    const diagnosis = buildLiveTrendDiagnosis([
      {
        simTimeSec: 60,
        inboundPph: 120,
        outboundPph: 115,
        totalPph: 235,
        waitingPct: 7,
        repositionPct: 8,
        liftPph: {}
      },
      {
        simTimeSec: 120,
        inboundPph: 130,
        outboundPph: 90,
        totalPph: 220,
        waitingPct: 12,
        repositionPct: 16,
        liftPph: {}
      },
      {
        simTimeSec: 180,
        inboundPph: 110,
        outboundPph: 85,
        totalPph: 195,
        waitingPct: 11,
        repositionPct: 14,
        liftPph: {}
      },
      {
        simTimeSec: 240,
        inboundPph: 105,
        outboundPph: 70,
        totalPph: 175,
        waitingPct: 16,
        repositionPct: 18,
        liftPph: {}
      }
    ]);

    expect(diagnosis.map((item) => item.id)).toEqual([
      'window-throughput',
      'flow-balance',
      'waiting-share',
      'reposition-share'
    ]);
    expect(diagnosis.find((item) => item.id === 'window-throughput')?.status).toBe('critical');
    expect(diagnosis.find((item) => item.id === 'waiting-share')?.status).toBe('critical');
    expect(diagnosis.find((item) => item.id === 'reposition-share')?.detail).toContain('critical >=15%');
  });
});

describe('dashboard review cockpit traffic readouts', () => {
  it('summarizes live reservation holds, safety, and lift pressure', () => {
    const readouts = buildReviewTrafficReadouts(state({
      simTimeSec: 120,
      traffic: {
        trafficMode: 'agent-refresh',
        safetyValidated: true,
        collisionAvoidanceEnabled: true,
        longHorizonReservationEnabled: true,
        clearThroughLookaheadEnabled: true,
        clearThroughMaxLookaheadLegs: 8,
        activeFutureGrantCount: 3,
        legacyZoneHoldEnabled: false,
        activeReservationCount: 12,
        waitingVehicles: [{
          vehicleId: 'SH-01',
          currentNodeId: 'a',
          targetNodeId: 'b',
          waitReason: 'edge-reservation',
          blockedTimeSec: 22,
          waitingSinceSec: 98,
          blockingReservationId: 'R-1',
          blockingVehicleId: 'SH-02'
        }],
        conflictSessions: [],
        liftPorts: [{
          nodeId: 'out-lift-1',
          kind: 'outbound',
          queueLength: 2,
          waitingTaskIds: ['T-1', 'T-2'],
          activeTaskId: 'T-0',
          approachOccupancy: 2,
          approachCapacity: 2,
          sourceBufferOccupancy: 0,
          sourceBufferCapacity: 1,
          completedTasks: 3,
          pph: 100,
          utilization: 0.9
        }],
        deadlockCandidateVehicleIds: [],
        minVehicleSeparationM: 0.72,
        maxObservedSpeedMps: 1.2,
        physicalViolationCount: 0
      }
    }));

    expect(readouts.map((item) => item.id)).toEqual([
      'reservation-control',
      'traffic-holds',
      'physical-safety',
      'lift-port-pressure'
    ]);
    expect(readouts.find((item) => item.id === 'reservation-control')?.status).toBe('pass');
    expect(readouts.find((item) => item.id === 'traffic-holds')?.status).toBe('watch');
    expect(readouts.find((item) => item.id === 'lift-port-pressure')?.status).toBe('watch');
    expect(readouts.find((item) => item.id === 'physical-safety')?.value).toBe('0');
  });
});

describe('dashboard review cockpit DES evidence', () => {
  it('summarizes task-level DES route and wait evidence', () => {
    const scenario = createDefaultShuttleScenario();
    const edge = scenario.layout.edges[0]!;
    const result = headlessDesForAudit({
      routeNodeIds: [edge.from, edge.to],
      trafficWaitSec: 45,
      trafficResourceId: `edge:${edge.id}`
    });
    result.trafficBottlenecks = [{
      resourceId: `edge:${edge.id}`,
      waitSec: 120,
      waitCount: 4
    }];
    result.routeModel.reservationWindowCount = 12;
    result.routeModel.trafficWaitSec = 45;
    result.reservationReplay.tracedTaskCount = 1;
    result.reservationReplay.topWaitIntervals = [{
      taskId: 'T-1',
      shuttleId: 'SH-01',
      startSec: 1,
      endSec: 46,
      waitSec: 45,
      reason: 'traffic-reservation-wait',
      resourceId: `edge:${edge.id}`
    }];

    const evidence = buildReviewDesEvidence(scenario, result);

    expect(evidence?.routeStatus).toBe('watch');
    expect(evidence?.routeMisses).toBe(0);
    expect(evidence?.reservationWindows).toBe(12);
    expect(evidence?.routeWatch).toBe(1);
    expect(evidence?.topBottleneck).toContain('0.03h / 4');
    expect(evidence?.topWaitTask).toContain('45s');
  });
});

describe('dashboard DES dispatch audit', () => {
  it('marks traced DES routes as yellow-grid pass when nodes and adjacent edges are present', () => {
    const scenario = createDefaultShuttleScenario();
    const edge = scenario.layout.edges[0]!;
    const result = headlessDesForAudit({
      routeNodeIds: [edge.from, edge.to],
      trafficWaitSec: 8,
      trafficResourceId: `edge:${edge.id}`
    });

    const rows = buildDesDispatchAuditRows(scenario, result);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.routeStatus).toBe('pass');
    expect(rows[0]?.primaryWaitResource).toContain('edge ');
    expect(rows[0]?.avoidanceEvidence).toContain('8s traffic');
  });

  it('fails traced DES routes that leave the known yellow-grid graph', () => {
    const scenario = createDefaultShuttleScenario();
    const edge = scenario.layout.edges[0]!;
    const result = headlessDesForAudit({
      routeNodeIds: [edge.from, 'not-a-yellow-node', edge.to],
      trafficWaitSec: 0
    });

    const rows = buildDesDispatchAuditRows(scenario, result);

    expect(rows[0]?.routeStatus).toBe('fail');
    expect(rows[0]?.routeEvidence).toContain('off-grid nodes');
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
  it('keeps the 3D shuttle body on distinct physical lift queue positions', () => {
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
    const secondLiftHelper = {
      id: 'lift-01-inbound-queue-03-entry-access',
      type: 'aisle' as const,
      x: 8,
      y: 0,
      z: 6.2,
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
      [secondLiftHelper.id, secondLiftHelper],
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
      yaw: 1.25,
      plannedRouteNodeIds: [liftHelper.id, serviceExit.id, railNode.id]
    }));
    const secondBodyPose = resolveScene3DVehicleBodyPose(new Map([
      [liftHelper.id, liftHelper],
      [secondLiftHelper.id, secondLiftHelper],
      [serviceExit.id, serviceExit],
      [railNode.id, railNode]
    ]), vehicle({
      id: 'SH-04',
      state: 'moving-to-pickup',
      currentNodeId: secondLiftHelper.id,
      targetNodeId: railNode.id,
      currentEdgeId: `${secondLiftHelper.id}-${railNode.id}`,
      x: 8,
      z: 6.2,
      yaw: -0.5,
      plannedRouteNodeIds: [secondLiftHelper.id, railNode.id]
    }));

    expect(bodyPose.x).toBeCloseTo(8, 6);
    expect(bodyPose.z).toBeCloseTo(3.25, 6);
    expect(bodyPose.yaw).toBeCloseTo(1.25, 6);
    expect(secondBodyPose.x).toBeCloseTo(secondLiftHelper.x, 6);
    expect(secondBodyPose.z).toBeCloseTo(secondLiftHelper.z, 6);
    expect(Math.hypot(bodyPose.x - secondBodyPose.x, bodyPose.z - secondBodyPose.z)).toBeGreaterThan(1);
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
