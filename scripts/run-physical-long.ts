import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type PhysicalSample = {
  timeSec: number;
  wallClockMs: number;
  completedInbound: number;
  completedOutbound: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  windowInboundPph: number;
  windowOutboundPph: number;
  windowTotalPph: number;
  pphWindowSec: number;
  demandOutboundPph: number;
  demandTotalPph: number;
  activeTasks: number;
  queuedTasks: number;
  waitingVehicles: number;
  idleVehicles: number;
  blockedVehicles: number;
  averageBusyPct: number;
  averageProductivePct: number;
  averageTasklessTravelPct: number;
  averageQueueReserveTravelPct: number;
  averageWasteRepositionPct: number;
  averageWaitingPct: number;
  averageIdlePct: number;
  deadlocks: number;
  livelocks: number;
  physicalViolations: number;
  topBlockedReasons: Array<{ reason: string; sec: number }>;
  inboundColumnPredecessorWaitContexts: InboundColumnPredecessorWaitContexts;
};

type InboundColumnPredecessorWaitContexts = {
  total: number;
  emptyToPickup: number;
  loadedNearLift: number;
  loadedAway: number;
  noActivePredecessor: number;
  examples: Array<{
    taskId: string;
    dropoffNodeId: string;
    column: number;
    row: number;
    context: 'emptyToPickup' | 'loadedNearLift' | 'loadedAway' | 'noActivePredecessor';
    inferredQueueNodeId: string | null;
    queueNodeStatus: 'free' | 'occupied' | 'claimed' | 'unknown';
    queueBlockingVehicleIds: string[];
    predecessorTaskId: string | null;
    predecessorDropoffNodeId: string | null;
    predecessorVehicleId: string | null;
    predecessorVehicleLoaded: boolean | null;
    predecessorCurrentNodeId: string | null;
    predecessorTargetNodeId: string | null;
    predecessorPlannedGoalNodeId: string | null;
  }>;
  byColumn: Array<{
    column: number;
    total: number;
    emptyToPickup: number;
    loadedNearLift: number;
    loadedAway: number;
    noActivePredecessor: number;
  }>;
};

type PhysicalAnomaly = {
  timeSec: number;
  severity: 'warn' | 'critical';
  code: string;
  detail: string;
};

type VehicleTrace = {
  signature: string;
  sinceSec: number;
  lastMovingSec: number;
  idleSinceSec: number | null;
  edgeStallSinceSec: number | null;
  lastX: number;
  lastZ: number;
};

const durationSec = durationArg();
const sampleSec = numberArg('--sample-sec', 600);
const checkpointSec = numberArg('--checkpoint-sec', 3600);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const storageSelectionPolicy = enumArg('--storage-selection-policy', ['sequential', 'traffic-aware'] as const, 'sequential');
const collisionAvoidance = enumArg('--collision-avoidance', ['on', 'off'] as const, 'on');
const outputPath = resolve(stringArg('--out') ?? `output/shuttle/physical-long-${Date.now()}.json`);
const tracePath = resolve(stringArg('--trace-out') ?? outputPath.replace(/\.json$/i, '.trace.json'));
const checkpointDir = resolve(stringArg('--checkpoint-dir') ?? outputPath.replace(/\.json$/i, '-checkpoints'));
const checkpointMode = stringArg('--checkpoint-mode') ?? 'compact';
const inlineTrace = process.argv.includes('--inline-trace') || checkpointMode === 'full';
const eventLogRetain = integerArg('--event-log-retain', 5000);
const eventLogRetainSec = numberArg('--event-log-retain-sec', 300);
const stopOnCritical = process.argv.includes('--stop-on-critical');
const maxPhysicalAnomalyEvents = integerArg('--max-physical-anomaly-events', 25);
const auditEverySec = numberArg('--audit-every-sec', 1);

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(tracePath), { recursive: true });
mkdirSync(checkpointDir, { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  vehicles: { count: shuttleCount },
  taskGeneration: {
    inboundRatePerHour,
    outboundRatePerHour,
    inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
      ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
      : 0.5,
    initialOutboundFullColumns,
    initialStorageFillPolicy,
    storageSelectionPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  },
  trafficPolicy: {
    collisionAvoidanceEnabled: collisionAvoidance === 'on'
  }
});

const sim = new ShuttleSimCore(scenario);
const startedAtMs = Date.now();
const samples: PhysicalSample[] = [];
const anomalies: PhysicalAnomaly[] = [];
const traces = new Map<string, VehicleTrace>();
const traceSnapshots: Array<{ sequence: number; simTimeSec: number; tickIndex: number; snapshot: ReturnType<ShuttleSimCore['createSnapshot']> }> = [];
const checkpointRecords: Array<{ sequence: number; reason: string; simTimeSec: number; path: string; mode: string }> = [];
let nextSampleSec = 0;
let nextCheckpointSec = 0;
let nextEventLogRetainSec = eventLogRetainSec;
let nextAuditSec = auditEverySec > 0 ? auditEverySec : Number.POSITIVE_INFINITY;
let checkpointSequence = 0;
let lastDeadlocks = 0;
let lastLivelocks = 0;
let maxPhysicalViolationCount = 0;
let physicalViolationStepCount = 0;
let physicalViolationFirstSec: number | null = null;
let physicalViolationSessions = 0;
let inPhysicalViolation = false;
let zeroThroughputWithWorkSinceSec: number | null = null;

sim.start();
recordCheckpoint('initial');
samples.push(createSample(sim.getState()));
nextSampleSec = sampleSec;
nextCheckpointSec = checkpointSec;
console.log(JSON.stringify({
  type: 'physical-long-start',
  durationSec,
  sampleSec,
  checkpointSec,
  regionCount,
  shuttleCount,
  inboundRatePerHour,
  outboundRatePerHour,
  initialStorageFillPolicy,
  storageSelectionPolicy,
  collisionAvoidance,
  auditEverySec,
  outputPath,
  tracePath
}));

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const nextBoundarySec = Math.min(
    durationSec,
    nextSampleSec,
    nextCheckpointSec,
    nextAuditSec,
    eventLogRetainSec > 0 ? nextEventLogRetainSec : Number.POSITIVE_INFINITY
  );
  const stepSec = Math.min(
    Math.max(scenario.timeStepSec, nextBoundarySec - clock.simTimeSec),
    durationSec - clock.simTimeSec
  );
  if (stepSec <= 1e-9 || !Number.isFinite(stepSec)) {
    break;
  }
  sim.advanceByInPlace(stepSec);
  let state: ShuttleSimState | null = null;
  const getCurrentState = () => {
    state ??= sim.getState();
    return state;
  };

  const simTimeSec = sim.getClock().simTimeSec;

  if (auditEverySec > 0 && simTimeSec + 1e-9 >= nextAuditSec) {
    auditState(getCurrentState());
    while (nextAuditSec <= simTimeSec + 1e-9) {
      nextAuditSec += auditEverySec;
    }
  }

  if (simTimeSec + 1e-9 >= nextSampleSec) {
    const sample = createSample(getCurrentState());
    samples.push(sample);
    console.log(JSON.stringify({ type: 'physical-sample', ...sample }));
    sim.retainRecentEventLog(eventLogRetain);
    nextSampleSec += sampleSec;
  }

  if (simTimeSec + 1e-9 >= nextCheckpointSec) {
    recordCheckpoint('periodic');
    sim.retainRecentEventLog(eventLogRetain);
    nextCheckpointSec += checkpointSec;
  }

  if (eventLogRetainSec > 0 && simTimeSec + 1e-9 >= nextEventLogRetainSec) {
    sim.retainRecentEventLog(eventLogRetain);
    while (nextEventLogRetainSec <= simTimeSec + 1e-9) {
      nextEventLogRetainSec += eventLogRetainSec;
    }
  }

  if (stopOnCritical && anomalies.some((anomaly) => anomaly.severity === 'critical')) {
    break;
  }
}

const finalState = sim.getState();
recordCheckpoint('final');

const result = {
  schemaVersion: 'shuttle.physicalLongRun.v1',
  scenarioId: scenario.id,
  scenarioName: scenario.name,
  scenarioHash: hashScenario(scenario),
  commitSha: process.env.SHUTTLE_COMMIT_SHA ?? process.env.GIT_COMMIT ?? 'unknown',
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  finalTickIndex: sim.getClock().tickIndex,
  status: finalState.status,
  wallClockMs: Date.now() - startedAtMs,
  avoidanceEnabled: finalState.traffic.collisionAvoidanceEnabled,
  controllerMode: scenario.trafficPolicy.controllerMode,
  layoutCalibrationProfile: scenario.layout.calibrationProfile?.id ?? null,
  assumptions: {
    initialOutboundFullColumns,
    initialStorageFillPolicy,
    storageSelectionPolicy,
    collisionAvoidance
  },
  pph: {
    inbound: finalState.kpis.inboundPph,
    outbound: finalState.kpis.outboundPph,
    total: finalState.kpis.totalPph,
    windowInbound: finalState.kpis.windowInboundPph,
    windowOutbound: finalState.kpis.windowOutboundPph,
    windowTotal: finalState.kpis.windowTotalPph,
    windowSec: finalState.kpis.pphWindowSec,
    demandOutbound: finalState.kpis.demandOutboundPph,
    demandTotal: finalState.kpis.demandTotalPph
  },
  completed: {
    inbound: finalState.kpis.completedInbound,
    outbound: finalState.kpis.completedOutbound,
    seededOutbound: finalState.kpis.completedSeededOutbound,
    demandOutbound: finalState.kpis.completedDemandOutbound
  },
  finalTasks: {
    active: finalState.kpis.activeTasks,
    queued: finalState.kpis.queuedTasks
  },
  traffic: {
    deadlocks: finalState.kpis.deadlockCount,
    livelocks: finalState.kpis.livelockCount,
    physicalViolations: finalState.traffic.physicalViolationCount,
    waitingVehicles: finalState.traffic.waitingVehicles.length,
    minVehicleSeparationM: finalState.traffic.minVehicleSeparationM,
    maxPhysicalViolationCount,
    physicalViolationStepCount,
    physicalViolationFirstSec,
    physicalViolationSessions
  },
  finalHash: {
    eventLogHash: finalState.kpis.eventLogHash,
    stateHash: null
  },
  anomalyCounts: countAnomalies(anomalies),
  anomalies,
  samples,
  tracePath,
  checkpointDir,
  checkpointMode,
  eventLogRetain
};

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(tracePath, `${JSON.stringify(inlineTrace
  ? {
      schemaVersion: 'shuttle.runTrace.v1',
      scenario,
      fixedDtSec: scenario.timeStepSec,
      commands: [],
      snapshots: traceSnapshots
    }
  : {
      schemaVersion: 'shuttle.physicalLongTraceManifest.v1',
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      scenarioHash: hashScenario(scenario),
      fixedDtSec: scenario.timeStepSec,
      checkpointMode,
      checkpointDir,
      checkpoints: checkpointRecords
    }, null, 2)}\n`);

console.log(JSON.stringify({
  type: 'physical-long-complete',
  outputPath,
  tracePath,
  wallClockMs: result.wallClockMs,
  finalSimTimeSec: result.finalSimTimeSec,
  totalPph: result.pph.total,
  windowTotalPph: result.pph.windowTotal,
  demandTotalPph: result.pph.demandTotal,
  deadlocks: result.traffic.deadlocks,
  livelocks: result.traffic.livelocks,
  physicalViolations: result.traffic.physicalViolations,
  anomalies: anomalies.length
}, null, 2));

if (anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function createSample(state: ShuttleSimState): PhysicalSample {
  const breakdowns = Object.values(state.kpis.vehicleUtilizationBreakdown);
  return {
    timeSec: round(state.simTimeSec),
    wallClockMs: Date.now() - startedAtMs,
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    inboundPph: round(state.kpis.inboundPph, 3),
    outboundPph: round(state.kpis.outboundPph, 3),
    totalPph: round(state.kpis.totalPph, 3),
    windowInboundPph: round(state.kpis.windowInboundPph, 3),
    windowOutboundPph: round(state.kpis.windowOutboundPph, 3),
    windowTotalPph: round(state.kpis.windowTotalPph, 3),
    pphWindowSec: round(state.kpis.pphWindowSec, 3),
    demandOutboundPph: round(state.kpis.demandOutboundPph, 3),
    demandTotalPph: round(state.kpis.demandTotalPph, 3),
    activeTasks: state.kpis.activeTasks,
    queuedTasks: state.kpis.queuedTasks,
    waitingVehicles: state.traffic.waitingVehicles.length,
    idleVehicles: state.vehicles.filter((vehicle) => vehicle.state === 'idle').length,
    blockedVehicles: state.vehicles.filter((vehicle) => vehicle.state === 'waiting-blocked').length,
    averageBusyPct: round(average(breakdowns.map((breakdown) => breakdown.busy)) * 100, 3),
    averageProductivePct: round(average(breakdowns.map((breakdown) => breakdown.productive)) * 100, 3),
    averageTasklessTravelPct: round(average(breakdowns.map((breakdown) => breakdown.tasklessTravel)) * 100, 3),
    averageQueueReserveTravelPct: round(average(breakdowns.map((breakdown) => breakdown.queueReserveTravel ?? 0)) * 100, 3),
    averageWasteRepositionPct: round(average(breakdowns.map((breakdown) => breakdown.wasteReposition ?? breakdown.tasklessTravel)) * 100, 3),
    averageWaitingPct: round(average(breakdowns.map((breakdown) => breakdown.waiting)) * 100, 3),
    averageIdlePct: round(average(breakdowns.map((breakdown) => breakdown.idle)) * 100, 3),
    deadlocks: state.kpis.deadlockCount,
    livelocks: state.kpis.livelockCount,
    physicalViolations: state.traffic.physicalViolationCount,
    topBlockedReasons: Object.entries(state.kpis.blockedTimeByReasonSec)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([reason, sec]) => ({ reason, sec: round(sec, 3) })),
    inboundColumnPredecessorWaitContexts: classifyInboundColumnPredecessorWaits(state)
  };
}

function classifyInboundColumnPredecessorWaits(state: ShuttleSimState): InboundColumnPredecessorWaitContexts {
  const totals: InboundColumnPredecessorWaitContexts = {
    total: 0,
    emptyToPickup: 0,
    loadedNearLift: 0,
    loadedAway: 0,
    noActivePredecessor: 0,
    examples: [],
    byColumn: []
  };
  const byColumn = new Map<number, Omit<InboundColumnPredecessorWaitContexts['byColumn'][number], 'column'>>();
  const activeInboundTasks = state.tasks.filter((task) =>
    task.kind === 'inbound' &&
    (task.state === 'assigned' || task.state === 'in-progress')
  );
  const waitingTasks = state.tasks.filter((task) =>
    task.kind === 'inbound' &&
    task.state === 'queued' &&
    task.waitReason === 'inbound-column-predecessor-wait'
  );

  for (const task of waitingTasks) {
    const target = storageGridPositionFromNodeId(task.dropoffNodeId);
    if (!target) {
      continue;
    }
    const bucket = byColumn.get(target.column) ?? {
      total: 0,
      emptyToPickup: 0,
      loadedNearLift: 0,
      loadedAway: 0,
      noActivePredecessor: 0
    };
    totals.total += 1;
    bucket.total += 1;

    const predecessor = activeInboundTasks
      .filter((candidate) => {
        const candidatePosition = storageGridPositionFromNodeId(candidate.dropoffNodeId);
        return candidatePosition &&
          candidatePosition.column === target.column &&
          candidatePosition.row > target.row;
      })
      .sort((left, right) =>
        (storageGridPositionFromNodeId(right.dropoffNodeId)?.row ?? 0) -
        (storageGridPositionFromNodeId(left.dropoffNodeId)?.row ?? 0)
      )[0];
    const predecessorVehicle = predecessor?.vehicleId
      ? state.vehicles.find((vehicle) => vehicle.id === predecessor.vehicleId)
      : null;
    const context = predecessorVehicle
      ? predecessorVehicle.loaded
        ? vehicleNearInboundLiftQueue(predecessorVehicle)
          ? 'loadedNearLift'
          : 'loadedAway'
        : 'emptyToPickup'
      : 'noActivePredecessor';

    totals[context] += 1;
    bucket[context] += 1;
    if (totals.examples.length < 6) {
      const inferredQueueNodeId = inboundQueueNodeIdFromPickup(task.pickupNodeId);
      const queueBlockingVehicleIds = inferredQueueNodeId
        ? state.vehicles
          .filter((vehicle) =>
            vehicle.currentNodeId === inferredQueueNodeId ||
            vehicle.targetNodeId === inferredQueueNodeId ||
            vehicle.plannedGoalNodeId === inferredQueueNodeId
          )
          .map((vehicle) => vehicle.id)
          .sort((left, right) => left.localeCompare(right))
        : [];
      totals.examples.push({
        taskId: task.id,
        dropoffNodeId: task.dropoffNodeId,
        column: target.column,
        row: target.row,
        context,
        inferredQueueNodeId,
        queueNodeStatus: inferredQueueNodeId
          ? queueBlockingVehicleIds.length > 0
            ? 'claimed'
            : 'free'
          : 'unknown',
        queueBlockingVehicleIds,
        predecessorTaskId: predecessor?.id ?? null,
        predecessorDropoffNodeId: predecessor?.dropoffNodeId ?? null,
        predecessorVehicleId: predecessorVehicle?.id ?? null,
        predecessorVehicleLoaded: predecessorVehicle?.loaded ?? null,
        predecessorCurrentNodeId: predecessorVehicle?.currentNodeId ?? null,
        predecessorTargetNodeId: predecessorVehicle?.targetNodeId ?? null,
        predecessorPlannedGoalNodeId: predecessorVehicle?.plannedGoalNodeId ?? null
      });
    }
    byColumn.set(target.column, bucket);
  }

  totals.byColumn = [...byColumn.entries()]
    .map(([column, counts]) => ({ column, ...counts }))
    .sort((left, right) => right.total - left.total || left.column - right.column)
    .slice(0, 8);
  return totals;
}

function inboundQueueNodeIdFromPickup(pickupNodeId: string): string | null {
  const match = /^lift-(\d+)-inbound-queue-\d+-service-exit$/.exec(pickupNodeId);
  return match ? `parking-lift-${match[1]}-inbound-queue` : null;
}

function storageGridPositionFromNodeId(nodeId: string): { row: number; column: number } | null {
  const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
  return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
}

function vehicleNearInboundLiftQueue(vehicle: VehicleState): boolean {
  return [vehicle.currentNodeId, vehicle.targetNodeId, vehicle.plannedGoalNodeId]
    .filter((nodeId): nodeId is string => Boolean(nodeId))
    .some((nodeId) => /lift-\d+-inbound-queue/.test(nodeId));
}

function auditState(state: ShuttleSimState): void {
  if (state.kpis.deadlockCount > lastDeadlocks) {
    addAnomaly(state.simTimeSec, 'critical', 'deadlock-count-increased', `${lastDeadlocks} -> ${state.kpis.deadlockCount}`);
    lastDeadlocks = state.kpis.deadlockCount;
  }
  if (state.kpis.livelockCount > lastLivelocks) {
    addAnomaly(state.simTimeSec, 'critical', 'livelock-count-increased', `${lastLivelocks} -> ${state.kpis.livelockCount}`);
    lastLivelocks = state.kpis.livelockCount;
  }
  if (state.traffic.physicalViolationCount > 0) {
    maxPhysicalViolationCount = Math.max(maxPhysicalViolationCount, state.traffic.physicalViolationCount);
    physicalViolationStepCount += 1;
    physicalViolationFirstSec ??= state.simTimeSec;
    if (!inPhysicalViolation) {
      physicalViolationSessions += 1;
      if (physicalViolationSessions <= maxPhysicalAnomalyEvents) {
        addAnomaly(
          state.simTimeSec,
          'critical',
          'physical-violation-active',
          `count=${state.traffic.physicalViolationCount} minSeparationM=${state.traffic.minVehicleSeparationM ?? 'unknown'}`
        );
      }
      inPhysicalViolation = true;
    }
  } else {
    inPhysicalViolation = false;
  }
  if (state.status === 'faulted') {
    addAnomaly(state.simTimeSec, 'critical', 'sim-faulted', state.error ?? 'unknown fault');
  }
  const hasOpenWork = state.kpis.activeTasks + state.kpis.queuedTasks > 0 ||
    state.vehicles.some((vehicle) => vehicle.taskId !== null || vehicle.state === 'waiting-blocked');
  if (hasOpenWork && state.kpis.windowTotalPph <= 1e-9 && state.simTimeSec >= state.kpis.pphWindowSec) {
    zeroThroughputWithWorkSinceSec ??= state.simTimeSec;
    if (state.simTimeSec - zeroThroughputWithWorkSinceSec >= 1800) {
      addAnomaly(
        state.simTimeSec,
        'critical',
        'throughput-zero-over-1800s-with-work',
        `windowTotalPph=0 for ${round(state.simTimeSec - zeroThroughputWithWorkSinceSec, 1)}s while active=${state.kpis.activeTasks} queued=${state.kpis.queuedTasks}`
      );
    }
  } else {
    zeroThroughputWithWorkSinceSec = null;
  }

  for (const vehicle of state.vehicles) {
    auditVehicle(state, vehicle);
  }
}

function auditVehicle(state: ShuttleSimState, vehicle: VehicleState): void {
  const signature = [
    vehicle.state,
    vehicle.currentNodeId,
    vehicle.targetNodeId ?? '',
    vehicle.currentEdgeId ?? '',
    vehicle.taskId ?? '',
    vehicle.loaded ? 'loaded' : 'empty',
    vehicle.waitReason ?? ''
  ].join('|');
  const trace = traces.get(vehicle.id) ?? {
    signature,
    sinceSec: state.simTimeSec,
    lastMovingSec: state.simTimeSec,
    idleSinceSec: null,
    edgeStallSinceSec: null,
    lastX: vehicle.x,
    lastZ: vehicle.z
  };

  if (trace.signature !== signature) {
    trace.signature = signature;
    trace.sinceSec = state.simTimeSec;
    trace.edgeStallSinceSec = null;
  }
  const movedSinceLastAudit = Math.hypot(vehicle.x - trace.lastX, vehicle.z - trace.lastZ) > 0.02;
  if (vehicle.speedMps > 0.02 && movedSinceLastAudit) {
    trace.lastMovingSec = state.simTimeSec;
  }
  if (vehicle.currentEdgeId !== null && !movedSinceLastAudit && vehicle.state !== 'waiting-blocked') {
    trace.edgeStallSinceSec ??= state.simTimeSec;
    if (state.simTimeSec - trace.edgeStallSinceSec >= 120) {
      addAnomaly(
        state.simTimeSec,
        'critical',
        `vehicle-edge-stalled-over-120s:${vehicle.id}`,
        `${vehicle.id} stayed on edge ${vehicle.currentEdgeId} for ${round(state.simTimeSec - trace.edgeStallSinceSec, 1)}s at ${vehicle.currentNodeId} -> ${vehicle.targetNodeId ?? '?'} x=${vehicle.x} z=${vehicle.z}`
      );
      trace.edgeStallSinceSec = state.simTimeSec;
    }
  } else {
    trace.edgeStallSinceSec = null;
  }
  trace.idleSinceSec = vehicle.state === 'idle'
    ? trace.idleSinceSec ?? state.simTimeSec
    : null;
  trace.lastX = vehicle.x;
  trace.lastZ = vehicle.z;

  if (
    vehicle.state === 'waiting-blocked' &&
    vehicle.waitingSinceSec !== null &&
    state.simTimeSec - vehicle.waitingSinceSec >= 300
  ) {
    addAnomaly(
      state.simTimeSec,
      'critical',
      `vehicle-blocked-over-300s:${vehicle.id}`,
      `${vehicle.id} blocked ${round(state.simTimeSec - vehicle.waitingSinceSec, 1)}s at ${vehicle.currentNodeId} -> ${vehicle.targetNodeId ?? '?'} reason=${vehicle.waitReason ?? '?'} blocker=${vehicle.blockingVehicleId ?? '?'}`
    );
  }
  if (
    vehicle.state === 'waiting-blocked' &&
    vehicle.targetNodeId !== vehicle.currentNodeId &&
    vehicle.waitReason !== 'inbound-lift-fifo-wait' &&
    vehicle.waitReason !== 'outbound-lift-fifo-wait' &&
    state.simTimeSec - trace.sinceSec >= 300
  ) {
    addAnomaly(
      state.simTimeSec,
      'critical',
      `vehicle-blocked-signature-over-300s:${vehicle.id}`,
      `${vehicle.id} blocked signature ${round(state.simTimeSec - trace.sinceSec, 1)}s at ${vehicle.currentNodeId} -> ${vehicle.targetNodeId ?? '?'} reason=${vehicle.waitReason ?? '?'} blocker=${vehicle.blockingVehicleId ?? '?'}`
    );
    trace.sinceSec = state.simTimeSec;
  }

  if (
    trace.idleSinceSec !== null &&
    state.kpis.queuedTasks + state.kpis.activeTasks > 0 &&
    state.simTimeSec - trace.idleSinceSec >= 600
  ) {
    addAnomaly(
      state.simTimeSec,
      'warn',
      `vehicle-idle-over-600s-with-work:${vehicle.id}`,
      `${vehicle.id} idle ${round(state.simTimeSec - trace.idleSinceSec, 1)}s while active=${state.kpis.activeTasks} queued=${state.kpis.queuedTasks}`
    );
    trace.idleSinceSec = state.simTimeSec;
  }

  traces.set(vehicle.id, trace);
}

function recordCheckpoint(reason: 'initial' | 'periodic' | 'final'): void {
  const state = sim.getState();
  const snapshot = inlineTrace ? sim.createSnapshot() : null;
  const snapshotTimeSec = snapshot?.simTimeSec ?? state.simTimeSec;
  const record = {
    sequence: checkpointSequence,
    reason,
    simTimeSec: snapshotTimeSec,
    tickIndex: snapshot?.tickIndex ?? null,
    snapshot: snapshot ?? undefined,
    state: snapshot ? undefined : compactCheckpointState(state)
  };
  const checkpointPath = resolve(
    checkpointDir,
    `${String(checkpointSequence).padStart(4, '0')}-${reason}-${Math.round(snapshotTimeSec)}s.json`
  );
  if (inlineTrace && snapshot) {
    traceSnapshots.push({
      sequence: checkpointSequence,
      simTimeSec: snapshot.simTimeSec,
      tickIndex: snapshot.tickIndex,
      snapshot
    });
  }
  checkpointRecords.push({
    sequence: checkpointSequence,
    reason,
    simTimeSec: round(snapshotTimeSec),
    path: checkpointPath,
    mode: inlineTrace ? 'full-snapshot' : 'compact-state'
  });
  writeFileSync(checkpointPath, `${JSON.stringify(record, null, 2)}\n`);
  checkpointSequence += 1;
}

function compactCheckpointState(state: ShuttleSimState) {
  return {
    status: state.status,
    simTimeSec: state.simTimeSec,
    durationSec: state.durationSec,
    kpis: state.kpis,
    traffic: state.traffic,
    vehicles: state.vehicles.map((vehicle) => ({
      id: vehicle.id,
      state: vehicle.state,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      currentEdgeId: vehicle.currentEdgeId,
      taskId: vehicle.taskId,
      loaded: vehicle.loaded,
      x: vehicle.x,
      z: vehicle.z,
      speedMps: vehicle.speedMps,
      waitReason: vehicle.waitReason,
      waitingSinceSec: vehicle.waitingSinceSec,
      blockingVehicleId: vehicle.blockingVehicleId,
      routeNodeIds: vehicle.routeNodeIds,
      plannedGoalNodeId: vehicle.plannedGoalNodeId
    })),
    tasks: state.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      state: task.state,
      pickupNodeId: task.pickupNodeId,
      dropoffNodeId: task.dropoffNodeId,
      vehicleId: task.vehicleId,
      waitReason: task.waitReason
    })),
    loads: {
      total: state.loads.length,
      byState: state.loads.reduce<Record<string, number>>((counts, load) => {
        counts[load.state] = (counts[load.state] ?? 0) + 1;
        return counts;
      }, {})
    },
    reservations: state.reservations,
    recentEvents: state.recentEvents
  };
}

function addAnomaly(timeSec: number, severity: PhysicalAnomaly['severity'], code: string, detail: string): void {
  const existing = anomalies.find((anomaly) =>
    anomaly.code === code &&
    Math.abs(anomaly.timeSec - timeSec) < 1e-6
  );
  if (!existing) {
    anomalies.push({ timeSec: round(timeSec), severity, code, detail });
    console.error(JSON.stringify({ type: 'physical-anomaly', timeSec: round(timeSec), severity, code, detail }));
  }
}

function countAnomalies(items: PhysicalAnomaly[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, anomaly) => {
    counts[anomaly.code] = (counts[anomaly.code] ?? 0) + 1;
    return counts;
  }, {});
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function durationArg(): number {
  const days = numberArg('--days', NaN);
  if (Number.isFinite(days)) {
    return days * 24 * 3600;
  }
  const hours = numberArg('--hours', NaN);
  if (Number.isFinite(hours)) {
    return hours * 3600;
  }
  return numberArg('--duration-sec', 24 * 3600);
}

function valueAfter(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function numberArg(name: string, fallback: number): number {
  const value = valueAfter(name);
  if (value === null || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.max(0, Math.round(numberArg(name, fallback)));
}

function enumArg<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const value = valueAfter(name);
  return value && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback;
}

function stringArg(name: string): string | null {
  const value = valueAfter(name);
  return value && value.trim() !== '' ? value : null;
}
