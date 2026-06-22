import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type VehicleRuntimeState = VehicleState & { waitingSinceSec?: number | null };

type HourlyPphRow = {
  hour: number;
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  hourlyInbound: number;
  hourlyOutbound: number;
  hourlyTotal: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  windowInboundPph: number;
  windowOutboundPph: number;
  windowTotalPph: number;
  activeTasks: number;
  queuedTasks: number;
  waitingVehicles: number;
  blockedVehicles: number;
  idleVehicles: number;
  physicalViolations: number;
  deadlocks: number;
  livelocks: number;
  shadowLedgerViolations: number;
  shadowLedgerDuplicateResourceOwners: number;
  shadowLedgerBlockedWaiterFutureClaims: number;
  topBlockedReasons: Array<{ reason: string; sec: number }>;
  hourlyBlockedReasons: Array<{ reason: string; sec: number }>;
  taskStates: Array<{ state: string; count: number }>;
  taskWaitReasons: Array<{ reason: string; count: number }>;
};

type VehicleWindowRow = {
  windowIndex: number;
  startSec: number;
  endSec: number;
  vehicleId: string;
  startNodeId: string;
  endNodeId: string;
  startTargetNodeId: string | null;
  endTargetNodeId: string | null;
  endState: VehicleState['state'];
  endLoaded: boolean;
  endTaskId: string | null;
  endWaitReason: string | null;
  endBlockingVehicleId: string | null;
  pathLengthM: number;
  netDisplacementM: number;
  bboxDiagonalM: number;
  centroidX: number;
  centroidZ: number;
  uniqueNodeCount: number;
  nodeTransitions: number;
  maxStepM: number;
  movingSec: number;
  idleSec: number;
  blockedSec: number;
  loadedSec: number;
  completedTasks: number;
  completedInboundTasks: number;
  completedOutboundTasks: number;
  completedTaskIds: string[];
  waitReasonSec: Record<string, number>;
  loopinessIndex: number;
  confinementIndex: number;
  stationary: boolean;
  smallAreaLoop: boolean;
  nodePingPong: boolean;
  longWait: boolean;
  zeroTaskMoving: boolean;
  riskLevel: 'ok' | 'watch' | 'warn' | 'critical';
  riskCodes: string[];
};

type AmrSummaryRow = {
  vehicleId: string;
  totalPathM: number;
  movingSec: number;
  idleSec: number;
  blockedSec: number;
  loadedSec: number;
  flaggedWindows: number;
  criticalWindows: number;
  maxLoopinessIndex: number;
  maxConfinementIndex: number;
  maxStationaryWindowSec: number;
  maxConfinedRunSec: number;
  maxBlockedWindowSec: number;
  topWaitReasons: Array<{ reason: string; sec: number }>;
};

type AmrAnomaly = {
  timeSec: number;
  windowIndex: number | null;
  vehicleId: string | null;
  severity: 'watch' | 'warn' | 'critical';
  code: string;
  detail: string;
  metrics?: Record<string, number | string | boolean | null>;
};

type ShadowLedgerDiagnostics = ShuttleSimState['traffic']['shadowLedger'];
type ShadowLedgerInvariantCounts = ShadowLedgerDiagnostics['invariantCounts'];
type ShadowLedgerViolation = ShadowLedgerDiagnostics['violations'][number];
type ShadowLedgerHotspot = {
  key: string;
  samples: number;
  firstSec: number;
  lastSec: number;
  example: ShadowLedgerViolation & { timeSec: number };
};

type VehicleWindowAccumulator = {
  vehicleId: string;
  startSec: number;
  firstX: number;
  firstZ: number;
  lastX: number;
  lastZ: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  sumX: number;
  sumZ: number;
  sampleCount: number;
  pathLengthM: number;
  maxStepM: number;
  movingSec: number;
  idleSec: number;
  blockedSec: number;
  loadedSec: number;
  waitReasonSec: Map<string, number>;
  nodeIds: Set<string>;
  nodeTransitions: number;
  lastNodeId: string;
  startNodeId: string;
  startTargetNodeId: string | null;
};

type VehicleAggregate = {
  vehicleId: string;
  totalPathM: number;
  movingSec: number;
  idleSec: number;
  blockedSec: number;
  loadedSec: number;
  flaggedWindows: number;
  criticalWindows: number;
  maxLoopinessIndex: number;
  maxConfinementIndex: number;
  maxStationaryWindowSec: number;
  maxConfinedRunSec: number;
  currentConfinedRunSec: number;
  previousConfinedCentroid: { x: number; z: number } | null;
  maxBlockedWindowSec: number;
  waitReasonSec: Map<string, number>;
};

const durationSec = durationArg();
const tenMinuteSec = numberArg('--ten-minute-sec', 600);
const hourlySec = numberArg('--hourly-sec', 3600);
const auditEverySec = numberArg('--audit-every-sec', 5);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'zone-balanced-50');
const storageSelectionPolicy = enumArg('--storage-selection-policy', ['sequential', 'traffic-aware'] as const, 'sequential');
const collisionAvoidance = enumArg('--collision-avoidance', ['on', 'off'] as const, 'on');
const outputPath = resolve(stringArg('--out') ?? 'output/review/physical-24h-amr-audit.json');
const checkpointDir = resolve(stringArg('--checkpoint-dir') ?? outputPath.replace(/\.json$/i, '-checkpoints'));
const stopOnCritical = process.argv.includes('--stop-on-critical');
const quietCritical = process.argv.includes('--quiet-critical') || process.argv.includes('--quiet');

const thresholds = {
  stationaryPathM: numberArg('--stationary-path-m', 0.5),
  stationaryActiveSec: numberArg('--stationary-active-sec', 540),
  smallLoopBboxM: numberArg('--small-loop-bbox-m', 3),
  smallLoopPathM: numberArg('--small-loop-path-m', 8),
  smallLoopLoopiness: numberArg('--small-loop-loopiness', 6),
  pingPongUniqueNodes: integerArg('--pingpong-unique-nodes', 3),
  pingPongTransitions: integerArg('--pingpong-transitions', 6),
  longWaitSec: numberArg('--long-wait-sec', 300),
  zeroTaskMovingSec: numberArg('--zero-task-moving-sec', 300),
  confinedRunBboxM: numberArg('--confined-run-bbox-m', 3),
  confinedRunCenterM: numberArg('--confined-run-center-m', 2)
};

mkdirSync(dirname(outputPath), { recursive: true });
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
const hourlyPph: HourlyPphRow[] = [];
const tenMinuteWindows: VehicleWindowRow[] = [];
const anomalies: AmrAnomaly[] = [];
const windowAccumulators = new Map<string, VehicleWindowAccumulator>();
const vehicleAggregates = new Map<string, VehicleAggregate>();
const checkpoints: Array<{ timeSec: number; path: string }> = [];
let nextAuditSec = auditEverySec > 0 ? auditEverySec : Number.POSITIVE_INFINITY;
let nextTenMinuteSec = tenMinuteSec;
let nextHourlySec = hourlySec;
let lastFinalizedTenMinuteSec = 0;
let previousHourInbound = 0;
let previousHourOutbound = 0;
let previousHourBlockedByReasonSec = new Map<string, number>();
let lastAuditSec = 0;
let lastDeadlocks = 0;
let lastLivelocks = 0;
let lastPhysicalViolationCount = 0;
let physicalViolationFirstSec: number | null = null;
let physicalViolationSessions = 0;
let inPhysicalViolation = false;
let shadowLedgerSamples = 0;
let shadowLedgerSamplesWithViolations = 0;
let shadowLedgerFirstViolationSec: number | null = null;
const shadowLedgerMaxInvariantCounts: Partial<Record<keyof ShadowLedgerInvariantCounts, number>> = {};
const shadowLedgerViolationCodeCounts = new Map<string, number>();
const shadowLedgerViolationSamples = new Map<string, ShadowLedgerViolation & { timeSec: number }>();
const shadowLedgerDuplicateResourceCounts = new Map<string, ShadowLedgerHotspot>();
const shadowLedgerDuplicatePairCounts = new Map<string, ShadowLedgerHotspot>();
const shadowLedgerDuplicateSourcePatternCounts = new Map<string, number>();

sim.start();
const initialState = sim.getState();
primeWindowAccumulators(initialState, 0);
recordCheckpoint(initialState, 0);

console.log(JSON.stringify({
  type: 'amr-audit-start',
  durationSec,
  tenMinuteSec,
  hourlySec,
  auditEverySec,
  regionCount,
  shuttleCount,
  inboundRatePerHour,
  outboundRatePerHour,
  initialStorageFillPolicy,
  storageSelectionPolicy,
  collisionAvoidance,
  outputPath,
  checkpointDir
}));

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const nextBoundarySec = Math.min(durationSec, nextAuditSec, nextTenMinuteSec, nextHourlySec);
  const stepSec = Math.min(
    Math.max(scenario.timeStepSec, nextBoundarySec - clock.simTimeSec),
    durationSec - clock.simTimeSec
  );
  if (stepSec <= 1e-9 || !Number.isFinite(stepSec)) {
    break;
  }
  sim.advanceByInPlace(stepSec);
  const state = sim.getState();
  const simTimeSec = state.simTimeSec;

  if (auditEverySec > 0 && simTimeSec + 1e-9 >= nextAuditSec) {
    auditState(state, Math.max(0, simTimeSec - lastAuditSec));
    lastAuditSec = simTimeSec;
    while (nextAuditSec <= simTimeSec + 1e-9) {
      nextAuditSec += auditEverySec;
    }
  }

  if (simTimeSec + 1e-9 >= nextTenMinuteSec) {
    finalizeTenMinuteWindow(state, nextTenMinuteSec - tenMinuteSec, nextTenMinuteSec);
    lastFinalizedTenMinuteSec = nextTenMinuteSec;
    primeWindowAccumulators(state, nextTenMinuteSec);
    console.log(JSON.stringify(progressSample(state)));
    while (nextTenMinuteSec <= simTimeSec + 1e-9) {
      nextTenMinuteSec += tenMinuteSec;
    }
  }

  if (simTimeSec + 1e-9 >= nextHourlySec) {
    recordHourly(state);
    recordCheckpoint(state, nextHourlySec);
    while (nextHourlySec <= simTimeSec + 1e-9) {
      nextHourlySec += hourlySec;
    }
  }

  if (stopOnCritical && anomalies.some((anomaly) => anomaly.severity === 'critical')) {
    break;
  }
}

const finalState = sim.getState();
if (windowAccumulators.size > 0 && finalState.simTimeSec > lastFinalizedTenMinuteSec + 1e-9) {
  finalizeTenMinuteWindow(finalState, lastFinalizedTenMinuteSec, finalState.simTimeSec);
  lastFinalizedTenMinuteSec = finalState.simTimeSec;
}
if (hourlyPph.at(-1)?.timeSec !== finalState.simTimeSec && finalState.simTimeSec >= hourlySec) {
  recordHourly(finalState);
}
recordCheckpoint(finalState, finalState.simTimeSec);

const finalWaitingByVehicleId = waitingMapForState(finalState);
const result = {
  schemaVersion: 'shuttle.amrAudit24h.v1',
  scenarioId: scenario.id,
  scenarioName: scenario.name,
  scenarioHash: hashScenario(scenario),
  commitSha: process.env.SHUTTLE_COMMIT_SHA ?? process.env.GIT_COMMIT ?? 'unknown',
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  finalTickIndex: sim.getClock().tickIndex,
  status: finalState.status,
  wallClockMs: Date.now() - startedAtMs,
  assumptions: {
    shuttleCount,
    regionCount,
    inboundRatePerHour,
    outboundRatePerHour,
    initialOutboundFullColumns,
    initialStorageFillPolicy,
    storageSelectionPolicy,
    collisionAvoidance,
    auditEverySec,
    tenMinuteSec,
    hourlySec
  },
  thresholds,
  pph: {
    inbound: round(finalState.kpis.inboundPph, 3),
    outbound: round(finalState.kpis.outboundPph, 3),
    total: round(finalState.kpis.totalPph, 3),
    windowInbound: round(finalState.kpis.windowInboundPph, 3),
    windowOutbound: round(finalState.kpis.windowOutboundPph, 3),
    windowTotal: round(finalState.kpis.windowTotalPph, 3),
    windowSec: round(finalState.kpis.pphWindowSec, 3),
    demandOutbound: round(finalState.kpis.demandOutboundPph, 3),
    demandTotal: round(finalState.kpis.demandTotalPph, 3)
  },
  completed: {
    inbound: finalState.kpis.completedInbound,
    outbound: finalState.kpis.completedOutbound,
    seededOutbound: finalState.kpis.completedSeededOutbound,
    demandOutbound: finalState.kpis.completedDemandOutbound
  },
  traffic: {
    deadlocks: finalState.kpis.deadlockCount,
    livelocks: finalState.kpis.livelockCount,
    physicalViolations: finalState.traffic.physicalViolationCount,
    minVehicleSeparationM: finalState.traffic.minVehicleSeparationM,
    physicalViolationFirstSec,
    physicalViolationSessions
  },
  shadowLedger: summarizeShadowLedger(finalState),
  hourlyPph,
  tenMinuteWindows,
  amrSummary: summarizeVehicles(),
  anomalies,
  finalWaitingVehicles: finalState.traffic.waitingVehicles,
  finalVehicles: finalState.vehicles.map((vehicle) => compactVehicle(vehicle, finalState.simTimeSec, finalWaitingByVehicleId)),
  checkpointDir,
  checkpoints,
  methodology: {
    stuckDefinition: 'A vehicle is flagged when it moves less than stationaryPathM during a 10-minute window while not idle for most of that window.',
    smallAreaLoopDefinition: 'A vehicle is flagged when it travels at least smallLoopPathM within a bounding box no wider than smallLoopBboxM and has a high path/net-displacement ratio.',
    pingPongDefinition: 'A vehicle is flagged when it transitions repeatedly among a very small number of nodes.',
    precision: `Vehicle movement is audited every ${auditEverySec}s and rolled up into ${tenMinuteSec}s windows.`
  }
};

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  type: 'amr-audit-complete',
  outputPath,
  wallClockMs: result.wallClockMs,
  finalSimTimeSec: result.finalSimTimeSec,
  totalPph: result.pph.total,
  inboundPph: result.pph.inbound,
  outboundPph: result.pph.outbound,
  anomalies: result.anomalies.length,
  criticalAnomalies: result.anomalies.filter((anomaly) => anomaly.severity === 'critical').length
}, null, 2));

if (result.anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function auditState(state: ShuttleSimState, dtSec: number): void {
  if (state.kpis.deadlockCount > lastDeadlocks) {
    const deadlockCandidateIds = state.traffic.deadlockCandidateVehicleIds ?? [];
    const maxCurrentWaitSec = maxCurrentWaitingSec(state);
    const severity = maxCurrentWaitSec >= thresholds.longWaitSec ? 'critical' : 'watch';
    addAnomaly(
      state.simTimeSec,
      null,
      null,
      severity,
      'deadlock-count-increased',
      `${lastDeadlocks} -> ${state.kpis.deadlockCount}; activeCandidates=${deadlockCandidateIds.join(',') || 'none'}; maxCurrentWaitSec=${round(maxCurrentWaitSec, 3)}`
    );
    lastDeadlocks = state.kpis.deadlockCount;
  }
  if (state.kpis.livelockCount > lastLivelocks) {
    addAnomaly(state.simTimeSec, null, null, 'critical', 'livelock-count-increased', `${lastLivelocks} -> ${state.kpis.livelockCount}`);
    lastLivelocks = state.kpis.livelockCount;
  }
  if (state.traffic.physicalViolationCount > 0) {
    physicalViolationFirstSec ??= state.simTimeSec;
    if (!inPhysicalViolation || state.traffic.physicalViolationCount > lastPhysicalViolationCount) {
      physicalViolationSessions += inPhysicalViolation ? 0 : 1;
      addAnomaly(
        state.simTimeSec,
        null,
        null,
        'critical',
        'physical-violation-active',
        `count=${state.traffic.physicalViolationCount} minSeparationM=${state.traffic.minVehicleSeparationM ?? 'unknown'}`
      );
    }
    inPhysicalViolation = true;
    lastPhysicalViolationCount = state.traffic.physicalViolationCount;
  } else {
    inPhysicalViolation = false;
  }
  if (state.status === 'error') {
    addAnomaly(state.simTimeSec, null, null, 'critical', 'simulation-error', state.error ?? 'unknown error');
  }
  auditShadowLedger(state);
  for (const vehicle of state.vehicles) {
    updateVehicleWindow(state, vehicle as VehicleRuntimeState, dtSec);
  }
}

function maxCurrentWaitingSec(state: ShuttleSimState): number {
  return Math.max(
    0,
    ...state.traffic.waitingVehicles.map((vehicle) =>
      vehicle.waitingSinceSec === null ? 0 : Math.max(0, state.simTimeSec - vehicle.waitingSinceSec)
    )
  );
}

function auditShadowLedger(state: ShuttleSimState): void {
  const ledger = state.traffic.shadowLedger;
  shadowLedgerSamples += 1;
  if (ledger.invariantCounts.total > 0) {
    shadowLedgerSamplesWithViolations += 1;
    shadowLedgerFirstViolationSec ??= state.simTimeSec;
  }
  for (const [key, value] of Object.entries(ledger.invariantCounts) as Array<[keyof ShadowLedgerInvariantCounts, number]>) {
    shadowLedgerMaxInvariantCounts[key] = Math.max(shadowLedgerMaxInvariantCounts[key] ?? 0, value);
  }
  for (const violation of ledger.violations) {
    shadowLedgerViolationCodeCounts.set(violation.code, (shadowLedgerViolationCodeCounts.get(violation.code) ?? 0) + 1);
    const sampleKey = `${violation.code}|${violation.resourceKey ?? 'none'}|${violation.vehicleId ?? 'none'}|${violation.otherVehicleId ?? 'none'}`;
    if (!shadowLedgerViolationSamples.has(sampleKey) && shadowLedgerViolationSamples.size < 50) {
      shadowLedgerViolationSamples.set(sampleKey, { ...violation, timeSec: round(state.simTimeSec) });
    }
    if (violation.code === 'duplicate-resource-owner') {
      recordShadowLedgerHotspot(
        shadowLedgerDuplicateResourceCounts,
        violation.resourceKey ?? 'none',
        violation,
        state.simTimeSec
      );
      recordShadowLedgerHotspot(
        shadowLedgerDuplicatePairCounts,
        `${violation.vehicleId ?? 'none'}+${violation.otherVehicleId ?? 'none'}`,
        violation,
        state.simTimeSec
      );
      const sourcePattern = shadowLedgerDuplicateSourcePattern(violation.detail);
      shadowLedgerDuplicateSourcePatternCounts.set(
        sourcePattern,
        (shadowLedgerDuplicateSourcePatternCounts.get(sourcePattern) ?? 0) + 1
      );
    }
  }
}

function recordShadowLedgerHotspot(
  map: Map<string, ShadowLedgerHotspot>,
  key: string,
  violation: ShadowLedgerViolation,
  timeSec: number
): void {
  const roundedTimeSec = round(timeSec);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      key,
      samples: 1,
      firstSec: roundedTimeSec,
      lastSec: roundedTimeSec,
      example: { ...violation, timeSec: roundedTimeSec }
    });
    return;
  }
  existing.samples += 1;
  existing.firstSec = Math.min(existing.firstSec, roundedTimeSec);
  existing.lastSec = Math.max(existing.lastSec, roundedTimeSec);
}

function shadowLedgerDuplicateSourcePattern(detail: string): string {
  const match = detail.match(/\bvia\s+(.+)\.$/);
  return match?.[1] ?? 'unknown';
}

function updateVehicleWindow(state: ShuttleSimState, vehicle: VehicleRuntimeState, dtSec: number): void {
  const accumulator = windowAccumulators.get(vehicle.id) ?? createWindowAccumulator(vehicle, state.simTimeSec);
  const stepM = Math.hypot(vehicle.x - accumulator.lastX, vehicle.z - accumulator.lastZ);
  accumulator.pathLengthM += stepM;
  accumulator.maxStepM = Math.max(accumulator.maxStepM, stepM);
  accumulator.lastX = vehicle.x;
  accumulator.lastZ = vehicle.z;
  accumulator.minX = Math.min(accumulator.minX, vehicle.x);
  accumulator.maxX = Math.max(accumulator.maxX, vehicle.x);
  accumulator.minZ = Math.min(accumulator.minZ, vehicle.z);
  accumulator.maxZ = Math.max(accumulator.maxZ, vehicle.z);
  accumulator.sumX += vehicle.x;
  accumulator.sumZ += vehicle.z;
  accumulator.sampleCount += 1;
  accumulator.nodeIds.add(vehicle.currentNodeId);
  if (vehicle.currentNodeId !== accumulator.lastNodeId) {
    accumulator.nodeTransitions += 1;
    accumulator.lastNodeId = vehicle.currentNodeId;
  }
  if (vehicle.speedMps > 0.02 || stepM > 0.02) {
    accumulator.movingSec += dtSec;
  }
  if (vehicle.state === 'idle') {
    accumulator.idleSec += dtSec;
  }
  if (vehicle.state === 'waiting-blocked') {
    accumulator.blockedSec += dtSec;
  }
  if (vehicle.loaded) {
    accumulator.loadedSec += dtSec;
  }
  if (vehicle.waitReason) {
    accumulator.waitReasonSec.set(vehicle.waitReason, round((accumulator.waitReasonSec.get(vehicle.waitReason) ?? 0) + dtSec));
  }
  windowAccumulators.set(vehicle.id, accumulator);
}

function finalizeTenMinuteWindow(state: ShuttleSimState, startSec: number, endSec: number): void {
  const windowIndex = Math.round(endSec / tenMinuteSec);
  for (const vehicle of state.vehicles as VehicleRuntimeState[]) {
    const accumulator = windowAccumulators.get(vehicle.id) ?? createWindowAccumulator(vehicle, startSec);
    const row = createVehicleWindowRow(windowIndex, startSec, endSec, state, vehicle, accumulator);
    tenMinuteWindows.push(row);
    updateAggregate(row);
    for (const code of row.riskCodes) {
      const severity = row.riskLevel === 'critical' ? 'critical' : code === 'small-area-loop' || code === 'node-ping-pong' ? 'warn' : 'watch';
      addAnomaly(
        row.endSec,
        row.windowIndex,
        row.vehicleId,
        severity,
        code,
        `${row.vehicleId} ${code} ${formatWindow(row)} from ${row.startNodeId} to ${row.endNodeId}`,
        {
          pathLengthM: row.pathLengthM,
          netDisplacementM: row.netDisplacementM,
          bboxDiagonalM: row.bboxDiagonalM,
          loopinessIndex: row.loopinessIndex,
          blockedSec: row.blockedSec,
          idleSec: row.idleSec,
          uniqueNodeCount: row.uniqueNodeCount,
          nodeTransitions: row.nodeTransitions,
          endWaitReason: row.endWaitReason,
          endBlockingVehicleId: row.endBlockingVehicleId
        }
      );
    }
  }
  windowAccumulators.clear();
}

function createVehicleWindowRow(
  windowIndex: number,
  startSec: number,
  endSec: number,
  state: ShuttleSimState,
  vehicle: VehicleRuntimeState,
  accumulator: VehicleWindowAccumulator
): VehicleWindowRow {
  const duration = Math.max(1e-9, endSec - startSec);
  const netDisplacementM = Math.hypot(vehicle.x - accumulator.firstX, vehicle.z - accumulator.firstZ);
  const bboxDiagonalM = Math.hypot(accumulator.maxX - accumulator.minX, accumulator.maxZ - accumulator.minZ);
  const centroidX = accumulator.sumX / Math.max(1, accumulator.sampleCount);
  const centroidZ = accumulator.sumZ / Math.max(1, accumulator.sampleCount);
  const loopinessIndex = accumulator.pathLengthM <= 1e-9 ? 0 : accumulator.pathLengthM / Math.max(netDisplacementM, 0.25);
  const confinementIndex = accumulator.pathLengthM <= 1e-9 ? 0 : accumulator.pathLengthM / Math.max(bboxDiagonalM, 0.25);
  const activeSec = duration - accumulator.idleSec;
  const stationary = accumulator.pathLengthM <= thresholds.stationaryPathM && activeSec >= thresholds.stationaryActiveSec;
  const completedTasks = completedTasksForVehicle(state, vehicle.id, startSec, endSec);
  const smallAreaLoop = accumulator.pathLengthM >= thresholds.smallLoopPathM &&
    bboxDiagonalM <= thresholds.smallLoopBboxM &&
    loopinessIndex >= thresholds.smallLoopLoopiness;
  const nodePingPong = accumulator.nodeIds.size <= thresholds.pingPongUniqueNodes &&
    accumulator.nodeTransitions >= thresholds.pingPongTransitions &&
    accumulator.pathLengthM >= thresholds.smallLoopPathM;
  const longWait = accumulator.blockedSec >= thresholds.longWaitSec;
  const zeroTaskMoving = completedTasks.length === 0 &&
    accumulator.movingSec >= thresholds.zeroTaskMovingSec &&
    bboxDiagonalM <= thresholds.smallLoopBboxM &&
    accumulator.pathLengthM >= thresholds.smallLoopPathM;
  const riskCodes = [
    stationary ? 'stationary-active-window' : null,
    smallAreaLoop ? 'small-area-loop' : null,
    nodePingPong ? 'node-ping-pong' : null,
    longWait ? 'long-wait-window' : null,
    zeroTaskMoving ? 'zero-task-moving-window' : null
  ].filter((code): code is string => code !== null);
  const riskLevel: VehicleWindowRow['riskLevel'] = stationary
    ? 'critical'
    : smallAreaLoop || nodePingPong || longWait
      ? 'warn'
      : bboxDiagonalM <= thresholds.confinedRunBboxM && accumulator.pathLengthM > 1
        ? 'watch'
        : 'ok';
  return {
    windowIndex,
    startSec: round(startSec),
    endSec: round(endSec),
    vehicleId: vehicle.id,
    startNodeId: accumulator.startNodeId,
    endNodeId: vehicle.currentNodeId,
    startTargetNodeId: accumulator.startTargetNodeId,
    endTargetNodeId: vehicle.targetNodeId,
    endState: vehicle.state,
    endLoaded: vehicle.loaded,
    endTaskId: vehicle.taskId,
    endWaitReason: vehicle.waitReason,
    endBlockingVehicleId: vehicle.blockingVehicleId,
    pathLengthM: round(accumulator.pathLengthM, 3),
    netDisplacementM: round(netDisplacementM, 3),
    bboxDiagonalM: round(bboxDiagonalM, 3),
    centroidX: round(centroidX, 3),
    centroidZ: round(centroidZ, 3),
    uniqueNodeCount: accumulator.nodeIds.size,
    nodeTransitions: accumulator.nodeTransitions,
    maxStepM: round(accumulator.maxStepM, 3),
    movingSec: round(accumulator.movingSec, 3),
    idleSec: round(accumulator.idleSec, 3),
    blockedSec: round(accumulator.blockedSec, 3),
    loadedSec: round(accumulator.loadedSec, 3),
    completedTasks: completedTasks.length,
    completedInboundTasks: completedTasks.filter((task) => task.kind === 'inbound').length,
    completedOutboundTasks: completedTasks.filter((task) => task.kind === 'outbound').length,
    completedTaskIds: completedTasks.map((task) => task.id),
    waitReasonSec: Object.fromEntries([...accumulator.waitReasonSec.entries()].sort(([left], [right]) => left.localeCompare(right))),
    loopinessIndex: round(loopinessIndex, 3),
    confinementIndex: round(confinementIndex, 3),
    stationary,
    smallAreaLoop,
    nodePingPong,
    longWait,
    zeroTaskMoving,
    riskLevel,
    riskCodes
  };
}

function completedTasksForVehicle(state: ShuttleSimState, vehicleId: string, startSec: number, endSec: number) {
  return state.tasks
    .filter((task) =>
      task.state === 'completed' &&
      task.vehicleId === vehicleId &&
      task.completedAtSec !== null &&
      task.completedAtSec > startSec + 1e-9 &&
      task.completedAtSec <= endSec + 1e-9
    )
    .sort((left, right) => (left.completedAtSec ?? 0) - (right.completedAtSec ?? 0));
}

function updateAggregate(row: VehicleWindowRow): void {
  const aggregate = vehicleAggregates.get(row.vehicleId) ?? {
    vehicleId: row.vehicleId,
    totalPathM: 0,
    movingSec: 0,
    idleSec: 0,
    blockedSec: 0,
    loadedSec: 0,
    flaggedWindows: 0,
    criticalWindows: 0,
    maxLoopinessIndex: 0,
    maxConfinementIndex: 0,
    maxStationaryWindowSec: 0,
    maxConfinedRunSec: 0,
    currentConfinedRunSec: 0,
    previousConfinedCentroid: null,
    maxBlockedWindowSec: 0,
    waitReasonSec: new Map<string, number>()
  };
  aggregate.totalPathM += row.pathLengthM;
  aggregate.movingSec += row.movingSec;
  aggregate.idleSec += row.idleSec;
  aggregate.blockedSec += row.blockedSec;
  aggregate.loadedSec += row.loadedSec;
  aggregate.maxLoopinessIndex = Math.max(aggregate.maxLoopinessIndex, row.loopinessIndex);
  aggregate.maxConfinementIndex = Math.max(aggregate.maxConfinementIndex, row.confinementIndex);
  aggregate.maxBlockedWindowSec = Math.max(aggregate.maxBlockedWindowSec, row.blockedSec);
  if (row.riskCodes.length > 0) {
    aggregate.flaggedWindows += 1;
  }
  if (row.riskLevel === 'critical') {
    aggregate.criticalWindows += 1;
    aggregate.maxStationaryWindowSec = Math.max(aggregate.maxStationaryWindowSec, row.endSec - row.startSec);
  }
  const confined = row.bboxDiagonalM <= thresholds.confinedRunBboxM && (row.pathLengthM > 1 || row.blockedSec >= thresholds.longWaitSec);
  if (confined) {
    const previous = aggregate.previousConfinedCentroid;
    const sameArea = previous === null ||
      Math.hypot(row.centroidX - previous.x, row.centroidZ - previous.z) <= thresholds.confinedRunCenterM;
    aggregate.currentConfinedRunSec = sameArea
      ? aggregate.currentConfinedRunSec + (row.endSec - row.startSec)
      : row.endSec - row.startSec;
    aggregate.previousConfinedCentroid = { x: row.centroidX, z: row.centroidZ };
  } else {
    aggregate.currentConfinedRunSec = 0;
    aggregate.previousConfinedCentroid = null;
  }
  aggregate.maxConfinedRunSec = Math.max(aggregate.maxConfinedRunSec, aggregate.currentConfinedRunSec);
  for (const [reason, sec] of Object.entries(row.waitReasonSec)) {
    aggregate.waitReasonSec.set(reason, round((aggregate.waitReasonSec.get(reason) ?? 0) + sec));
  }
  vehicleAggregates.set(row.vehicleId, aggregate);
}

function summarizeVehicles(): AmrSummaryRow[] {
  return [...vehicleAggregates.values()]
    .map((aggregate) => ({
      vehicleId: aggregate.vehicleId,
      totalPathM: round(aggregate.totalPathM, 3),
      movingSec: round(aggregate.movingSec, 3),
      idleSec: round(aggregate.idleSec, 3),
      blockedSec: round(aggregate.blockedSec, 3),
      loadedSec: round(aggregate.loadedSec, 3),
      flaggedWindows: aggregate.flaggedWindows,
      criticalWindows: aggregate.criticalWindows,
      maxLoopinessIndex: round(aggregate.maxLoopinessIndex, 3),
      maxConfinementIndex: round(aggregate.maxConfinementIndex, 3),
      maxStationaryWindowSec: round(aggregate.maxStationaryWindowSec, 3),
      maxConfinedRunSec: round(aggregate.maxConfinedRunSec, 3),
      maxBlockedWindowSec: round(aggregate.maxBlockedWindowSec, 3),
      topWaitReasons: [...aggregate.waitReasonSec.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([reason, sec]) => ({ reason, sec: round(sec, 3) }))
    }))
    .sort((left, right) => left.vehicleId.localeCompare(right.vehicleId));
}

function recordHourly(state: ShuttleSimState): void {
  const completedInbound = state.kpis.completedInbound;
  const completedOutbound = state.kpis.completedOutbound;
  const hour = Math.round(state.simTimeSec / hourlySec);
  hourlyPph.push({
    hour,
    timeSec: round(state.simTimeSec),
    completedInbound,
    completedOutbound,
    hourlyInbound: completedInbound - previousHourInbound,
    hourlyOutbound: completedOutbound - previousHourOutbound,
    hourlyTotal: completedInbound - previousHourInbound + completedOutbound - previousHourOutbound,
    inboundPph: round(state.kpis.inboundPph, 3),
    outboundPph: round(state.kpis.outboundPph, 3),
    totalPph: round(state.kpis.totalPph, 3),
    windowInboundPph: round(state.kpis.windowInboundPph, 3),
    windowOutboundPph: round(state.kpis.windowOutboundPph, 3),
    windowTotalPph: round(state.kpis.windowTotalPph, 3),
    activeTasks: state.kpis.activeTasks,
    queuedTasks: state.kpis.queuedTasks,
    waitingVehicles: state.traffic.waitingVehicles.length,
    blockedVehicles: state.vehicles.filter((vehicle) => vehicle.state === 'waiting-blocked').length,
    idleVehicles: state.vehicles.filter((vehicle) => vehicle.state === 'idle').length,
    physicalViolations: state.traffic.physicalViolationCount,
    deadlocks: state.kpis.deadlockCount,
    livelocks: state.kpis.livelockCount,
    shadowLedgerViolations: state.traffic.shadowLedger.invariantCounts.total,
    shadowLedgerDuplicateResourceOwners: state.traffic.shadowLedger.invariantCounts.duplicateResourceOwner,
    shadowLedgerBlockedWaiterFutureClaims: state.traffic.shadowLedger.invariantCounts.blockedWaiterFutureClaim,
    topBlockedReasons: topBlockedReasons(state),
    hourlyBlockedReasons: hourlyBlockedReasonDeltas(state),
    taskStates: taskStateCounts(state),
    taskWaitReasons: taskWaitReasonCounts(state)
  });
  previousHourInbound = completedInbound;
  previousHourOutbound = completedOutbound;
  previousHourBlockedByReasonSec = new Map(Object.entries(state.kpis.blockedTimeByReasonSec));
}

function recordCheckpoint(state: ShuttleSimState, timeSec: number): void {
  const checkpointPath = resolve(checkpointDir, `${String(checkpoints.length).padStart(4, '0')}-${Math.round(timeSec)}s.json`);
  const waitingByVehicleId = waitingMapForState(state);
  const compact = {
    timeSec: round(state.simTimeSec),
    status: state.status,
    kpis: state.kpis,
    traffic: state.traffic,
    vehicles: state.vehicles.map((vehicle) => compactVehicle(vehicle, state.simTimeSec, waitingByVehicleId)),
    tasks: state.tasks
      .filter((task) => task.state !== 'completed')
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        state: task.state,
        pickupNodeId: task.pickupNodeId,
        dropoffNodeId: task.dropoffNodeId,
        vehicleId: task.vehicleId,
        waitReason: task.waitReason
      }))
  };
  writeFileSync(checkpointPath, `${JSON.stringify(compact, null, 2)}\n`);
  checkpoints.push({ timeSec: round(state.simTimeSec), path: checkpointPath });
}

function waitingMapForState(state: ShuttleSimState): Map<string, ShuttleSimState['traffic']['waitingVehicles'][number]> {
  return new Map(state.traffic.waitingVehicles.map((waiting) => [waiting.vehicleId, waiting]));
}

function primeWindowAccumulators(state: ShuttleSimState, startSec: number): void {
  for (const vehicle of state.vehicles as VehicleRuntimeState[]) {
    windowAccumulators.set(vehicle.id, createWindowAccumulator(vehicle, startSec));
    if (!vehicleAggregates.has(vehicle.id)) {
      vehicleAggregates.set(vehicle.id, {
        vehicleId: vehicle.id,
        totalPathM: 0,
        movingSec: 0,
        idleSec: 0,
        blockedSec: 0,
        loadedSec: 0,
        flaggedWindows: 0,
        criticalWindows: 0,
        maxLoopinessIndex: 0,
        maxConfinementIndex: 0,
        maxStationaryWindowSec: 0,
        maxConfinedRunSec: 0,
        currentConfinedRunSec: 0,
        previousConfinedCentroid: null,
        maxBlockedWindowSec: 0,
        waitReasonSec: new Map()
      });
    }
  }
}

function createWindowAccumulator(vehicle: VehicleRuntimeState, startSec: number): VehicleWindowAccumulator {
  return {
    vehicleId: vehicle.id,
    startSec,
    firstX: vehicle.x,
    firstZ: vehicle.z,
    lastX: vehicle.x,
    lastZ: vehicle.z,
    minX: vehicle.x,
    maxX: vehicle.x,
    minZ: vehicle.z,
    maxZ: vehicle.z,
    sumX: vehicle.x,
    sumZ: vehicle.z,
    sampleCount: 1,
    pathLengthM: 0,
    maxStepM: 0,
    movingSec: 0,
    idleSec: 0,
    blockedSec: 0,
    loadedSec: 0,
    waitReasonSec: new Map(),
    nodeIds: new Set([vehicle.currentNodeId]),
    nodeTransitions: 0,
    lastNodeId: vehicle.currentNodeId,
    startNodeId: vehicle.currentNodeId,
    startTargetNodeId: vehicle.targetNodeId
  };
}

function progressSample(state: ShuttleSimState) {
  const recentRows = tenMinuteWindows.filter((row) => row.endSec === round(state.simTimeSec));
  return {
    type: 'amr-10m-sample',
    timeSec: round(state.simTimeSec),
    hour: round(state.simTimeSec / 3600, 2),
    inboundPph: round(state.kpis.inboundPph, 3),
    outboundPph: round(state.kpis.outboundPph, 3),
    totalPph: round(state.kpis.totalPph, 3),
    waitingVehicles: state.traffic.waitingVehicles.length,
    blockedVehicles: state.vehicles.filter((vehicle) => vehicle.state === 'waiting-blocked').length,
    shadowLedgerViolations: state.traffic.shadowLedger.invariantCounts.total,
    newRiskWindows: recentRows.filter((row) => row.riskCodes.length > 0).length,
    maxLoopiness: round(Math.max(0, ...recentRows.map((row) => row.loopinessIndex)), 3),
    anomalies: anomalies.length
  };
}

function summarizeShadowLedger(finalState: ShuttleSimState) {
  return {
    final: finalState.traffic.shadowLedger,
    samples: shadowLedgerSamples,
    samplesWithViolations: shadowLedgerSamplesWithViolations,
    firstViolationSec: shadowLedgerFirstViolationSec,
    maxInvariantCounts: Object.fromEntries(
      Object.entries(shadowLedgerMaxInvariantCounts)
        .sort(([left], [right]) => left.localeCompare(right))
    ),
    topViolationCodes: [...shadowLedgerViolationCodeCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([code, samples]) => ({ code, samples })),
    topDuplicateResources: topShadowLedgerHotspots(shadowLedgerDuplicateResourceCounts, 20),
    topDuplicateVehiclePairs: topShadowLedgerHotspots(shadowLedgerDuplicatePairCounts, 20),
    topDuplicateSourcePatterns: [...shadowLedgerDuplicateSourcePatternCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([pattern, samples]) => ({ pattern, samples })),
    sampleViolations: [...shadowLedgerViolationSamples.values()]
      .sort((left, right) => left.timeSec - right.timeSec || left.code.localeCompare(right.code))
  };
}

function topShadowLedgerHotspots(map: Map<string, ShadowLedgerHotspot>, limit: number) {
  return [...map.values()]
    .sort((left, right) => right.samples - left.samples || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map((hotspot) => ({
      key: hotspot.key,
      samples: hotspot.samples,
      firstSec: hotspot.firstSec,
      lastSec: hotspot.lastSec,
      example: hotspot.example
    }));
}

function topBlockedReasons(state: ShuttleSimState): Array<{ reason: string; sec: number }> {
  return Object.entries(state.kpis.blockedTimeByReasonSec)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([reason, sec]) => ({ reason, sec: round(sec, 3) }));
}

function hourlyBlockedReasonDeltas(state: ShuttleSimState): Array<{ reason: string; sec: number }> {
  const current = state.kpis.blockedTimeByReasonSec;
  const reasons = new Set([...Object.keys(current), ...previousHourBlockedByReasonSec.keys()]);
  return [...reasons]
    .map((reason) => ({
      reason,
      sec: round((current[reason] ?? 0) - (previousHourBlockedByReasonSec.get(reason) ?? 0), 3)
    }))
    .filter((row) => row.sec > 1e-9)
    .sort((left, right) => right.sec - left.sec || left.reason.localeCompare(right.reason))
    .slice(0, 12);
}

function taskStateCounts(state: ShuttleSimState): Array<{ state: string; count: number }> {
  const counts = new Map<string, number>();
  for (const task of state.tasks) {
    if (task.state === 'completed' || task.state === 'failed') {
      continue;
    }
    counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([stateName, count]) => ({ state: stateName, count }));
}

function taskWaitReasonCounts(state: ShuttleSimState): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const task of state.tasks) {
    if (task.state === 'completed' || task.state === 'failed' || !task.waitReason) {
      continue;
    }
    counts.set(task.waitReason, (counts.get(task.waitReason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }));
}

function compactVehicle(
  vehicle: VehicleState,
  simTimeSec: number,
  waitingByVehicleId: Map<string, ShuttleSimState['traffic']['waitingVehicles'][number]>
) {
  const runtime = vehicle as VehicleRuntimeState;
  const waiting = waitingByVehicleId.get(vehicle.id) ?? null;
  const waitingSinceSec = runtime.waitingSinceSec ?? waiting?.waitingSinceSec ?? null;
  return {
    id: vehicle.id,
    state: vehicle.state,
    loaded: vehicle.loaded,
    taskId: vehicle.taskId,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    currentEdgeId: vehicle.currentEdgeId,
    routeIndex: vehicle.routeIndex,
    routeNodeIds: vehicle.routeNodeIds,
    plannedRouteNodeIds: vehicle.plannedRouteNodeIds,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    localRouteNodeIds: vehicle.localRouteNodeIds,
    localRouteReason: vehicle.localRouteReason,
    waitReason: vehicle.waitReason,
    waitingSinceSec,
    currentWaitSec: waitingSinceSec === null ? 0 : round(Math.max(0, simTimeSec - waitingSinceSec), 3),
    blockingVehicleId: vehicle.blockingVehicleId,
    blockedTimeSec: vehicle.blockedTimeSec,
    idleTimeSec: vehicle.idleTimeSec,
    busyTimeSec: vehicle.busyTimeSec,
    legRemainingM: vehicle.legRemainingM,
    phaseRemainingSec: vehicle.phaseRemainingSec,
    directionSwitchReadyNodeId: vehicle.directionSwitchReadyNodeId,
    x: round(vehicle.x, 3),
    z: round(vehicle.z, 3),
    speedMps: round(vehicle.speedMps, 3)
  };
}

function addAnomaly(
  timeSec: number,
  windowIndex: number | null,
  vehicleId: string | null,
  severity: AmrAnomaly['severity'],
  code: string,
  detail: string,
  metrics?: AmrAnomaly['metrics']
): void {
  anomalies.push({
    timeSec: round(timeSec),
    windowIndex,
    vehicleId,
    severity,
    code,
    detail,
    metrics
  });
  if (severity === 'critical' && !quietCritical) {
    console.error(JSON.stringify({ type: 'amr-anomaly', timeSec: round(timeSec), windowIndex, vehicleId, severity, code, detail, metrics }));
  }
}

function formatWindow(row: VehicleWindowRow): string {
  return `path=${row.pathLengthM}m net=${row.netDisplacementM}m bbox=${row.bboxDiagonalM}m loopiness=${row.loopinessIndex}`;
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
