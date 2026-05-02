import type { KpiSnapshot, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { describe, expect, it } from 'vitest';

import { mergeKpiUpdate, mergeVehicleStateUpdate } from './App.js';

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
