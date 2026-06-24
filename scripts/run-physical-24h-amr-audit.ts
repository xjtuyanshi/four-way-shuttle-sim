import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { EventLogEntry, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

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
  assignedWithoutRoute: boolean;
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

type RunNarrative = {
  runReason: string;
  problemsObserved: string[];
  problemsSolved: string[];
  decision: string;
};

type RunShadowLedgerSummary = {
  invariantCounts: Record<string, number>;
  stationInvariantCounts: Record<string, number>;
  samplesWithViolations: number;
  topViolationCodes: Array<{ code: string; count: number }>;
  duplicateOwnerClasses: Array<{ className: string; samples: number }>;
  examples: string[];
  sampleExamples: string[];
};

type ShadowLedgerDiagnostics = ShuttleSimState['traffic']['shadowLedger'];
type ShadowLedgerInvariantCounts = ShadowLedgerDiagnostics['invariantCounts'];
type ShadowLedgerViolation = ShadowLedgerDiagnostics['violations'][number];
type ShadowLedgerViolationSample = ShadowLedgerViolation & {
  timeSec: number;
  duplicateOwnerClass?: string;
};
type ShadowLedgerHotspot = {
  key: string;
  samples: number;
  firstSec: number;
  lastSec: number;
  example: ShadowLedgerViolationSample;
};

const MAX_SHADOW_LEDGER_VIOLATION_CHECKPOINTS = 12;

type StationQueueLeaseTransitionSummary = {
  total: number;
  byReason: Array<{ reason: string; count: number }>;
  byStation: Array<{ stationId: string; count: number }>;
  byVehicle: Array<{ vehicleId: string; count: number }>;
  ageSec: {
    min: number | null;
    avg: number | null;
    max: number | null;
  };
  samples: Array<{
    timeSec: number;
    vehicleId: string | null;
    taskId: string | null;
    reason: string | null;
    stationId: string | null;
    targetNodeId: string | null;
    nextTaskKind: string | null;
    nextStationId: string | null;
    ageSec: number | null;
  }>;
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
const runChangeNote = stringArg('--change-note') ?? 'unspecified change';
const runReason = stringArg('--run-reason');
const runProblemsObserved = stringListArg('--problems-observed');
const runProblemsSolved = stringListArg('--problems-solved');
const runDecision = stringArg('--run-decision');
const rollingLogPath = resolve(stringArg('--run-log') ?? 'output/review/sim-run-rolling-log.json');
const rollingLogHtmlPath = resolve(stringArg('--run-log-html') ?? 'output/review/sim-run-rolling-log.html');
const stopOnCritical = process.argv.includes('--stop-on-critical');
const quietCritical = process.argv.includes('--quiet-critical') || process.argv.includes('--quiet');
const renderRunLogOnly = process.argv.includes('--render-run-log-only');

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

if (renderRunLogOnly) {
  rerenderRollingRunLog();
  process.exit(0);
}

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
const shadowLedgerViolationSamples = new Map<string, ShadowLedgerViolationSample>();
const shadowLedgerDuplicateResourceCounts = new Map<string, ShadowLedgerHotspot>();
const shadowLedgerDuplicatePairCounts = new Map<string, ShadowLedgerHotspot>();
const shadowLedgerDuplicateSourcePatternCounts = new Map<string, number>();
const shadowLedgerDuplicateOwnerClassCounts = new Map<string, number>();
const shadowLedgerViolationCheckpointKeys = new Set<string>();
const assignedWithoutRouteAnomalyKeys = new Set<string>();

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
const stationQueueLeaseTransitions = summarizeStationQueueLeaseTransitions(sim.getEventLog());
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
  stationQueueLeaseTransitions,
  hourlyPph,
  tenMinuteWindows,
  amrSummary: summarizeVehicles(),
  anomalies,
  finalWaitingVehicles: finalState.traffic.waitingVehicles.map((waiting) => ({
    ...waiting,
    currentWaitSec: waiting.waitingSinceSec === null
      ? 0
      : round(Math.max(0, finalState.simTimeSec - waiting.waitingSinceSec), 3)
  })),
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
try {
  appendRollingRunLog(result);
} catch (error) {
  console.warn(JSON.stringify({
    type: 'rolling-run-log-update-failed',
    message: error instanceof Error ? error.message : String(error)
  }));
}
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

function appendRollingRunLog(result: any): void {
  mkdirSync(dirname(rollingLogPath), { recursive: true });
  mkdirSync(dirname(rollingLogHtmlPath), { recursive: true });
  const existing = readRollingRunLog();
  const entry = {
    id: `${new Date().toISOString()}-${outputPath.split('/').pop() ?? 'audit'}`,
    createdAt: new Date().toISOString(),
    changeNote: runChangeNote,
    outputPath,
    checkpointDir,
    durationSec: result.durationSec,
    finalSimTimeSec: result.finalSimTimeSec,
    wallClockMs: result.wallClockMs,
    scenarioHash: result.scenarioHash,
    commitSha: result.commitSha,
    assumptions: result.assumptions,
    pph: result.pph,
    shadowLedgerSummary: summarizeRunShadowLedger(result.shadowLedger),
    narrative: buildRunNarrative(runChangeNote, result),
    hourlyPph: result.hourlyPph ?? [],
    tenMinuteWindows: result.tenMinuteWindows ?? [],
    amrSummary: result.amrSummary ?? [],
    anomalies: result.anomalies ?? [],
    finalWaitingVehicles: result.finalWaitingVehicles ?? []
  };
  const runs = [...existing.runs, entry];
  const updated = {
    schemaVersion: 'sim-run-rolling-log.v2',
    updatedAt: new Date().toISOString(),
    htmlPath: rollingLogHtmlPath,
    runs
  };
  writeFileSync(rollingLogPath, `${JSON.stringify(updated, null, 2)}\n`);
  writeFileSync(rollingLogHtmlPath, renderRollingRunLogHtml(updated));
  console.log(JSON.stringify({
    type: 'rolling-run-log-updated',
    jsonPath: rollingLogPath,
    htmlPath: rollingLogHtmlPath,
    runCount: runs.length
  }));
}

function rerenderRollingRunLog(): void {
  mkdirSync(dirname(rollingLogPath), { recursive: true });
  mkdirSync(dirname(rollingLogHtmlPath), { recursive: true });
  const existing = readRollingRunLog();
  const updated = {
    schemaVersion: 'sim-run-rolling-log.v2',
    updatedAt: new Date().toISOString(),
    htmlPath: rollingLogHtmlPath,
    runs: existing.runs
  };
  writeFileSync(rollingLogPath, `${JSON.stringify(updated, null, 2)}\n`);
  writeFileSync(rollingLogHtmlPath, renderRollingRunLogHtml(updated));
  console.log(JSON.stringify({
    type: 'rolling-run-log-rerendered',
    jsonPath: rollingLogPath,
    htmlPath: rollingLogHtmlPath,
    runCount: updated.runs.length
  }));
}

function readRollingRunLog(): { runs: any[] } {
  if (!existsSync(rollingLogPath)) {
    return { runs: [] };
  }
  const parsed = JSON.parse(readFileSync(rollingLogPath, 'utf8'));
  return {
    runs: Array.isArray(parsed.runs) ? parsed.runs.map(normalizeRollingRunEntry) : []
  };
}

function normalizeRollingRunEntry(run: any): any {
  const enrichedRun = enrichRollingRunEntry(run);
  const inferred = inferRunNarrative(enrichedRun);
  const explicit = typeof enrichedRun.narrative === 'object' && enrichedRun.narrative !== null ? enrichedRun.narrative : {};
  if (shouldRefreshAutoNarrative(enrichedRun, explicit, inferred)) {
    return {
      ...enrichedRun,
      narrative: inferred
    };
  }
  return {
    ...enrichedRun,
    narrative: {
      runReason: cleanText(explicit.runReason) ?? inferred.runReason,
      problemsObserved: mergeNarrativeTextList(
        cleanTextList(explicit.problemsObserved, []),
        inferred.problemsObserved
      ),
      problemsSolved: mergeNarrativeTextList(
        cleanTextList(explicit.problemsSolved, []),
        inferred.problemsSolved
      ),
      decision: mergeNarrativeDecision(cleanText(explicit.decision), inferred.decision, run)
    } satisfies RunNarrative
  };
}

function enrichRollingRunEntry(run: any): any {
  if (
    run.shadowLedgerSummary &&
    Number.isFinite(Number(run.shadowLedgerSummary.samplesWithViolations)) &&
    Array.isArray(run.shadowLedgerSummary.sampleExamples) &&
    Array.isArray(run.shadowLedgerSummary.duplicateOwnerClasses)
  ) {
    return run;
  }
  const outputPathForRun = cleanText(run.outputPath);
  if (!outputPathForRun || !existsSync(outputPathForRun)) {
    return run;
  }
  try {
    const parsed = JSON.parse(readFileSync(outputPathForRun, 'utf8'));
    return {
      ...run,
      shadowLedgerSummary: summarizeRunShadowLedger(parsed.shadowLedger)
    };
  } catch {
    return run;
  }
}

function shouldRefreshAutoNarrative(run: any, explicit: any, inferred: RunNarrative): boolean {
  const explicitDecision = cleanText(explicit.decision);
  const anomalies = Array.isArray(run.anomalies) ? run.anomalies : [];
  const waiting = Array.isArray(run.finalWaitingVehicles) ? run.finalWaitingVehicles : [];
  return explicitDecision !== null
    && explicitDecision.includes('如果 3 小时 gate 稳定')
    && (anomalies.length > 0 || waiting.length > 0)
    && explicitDecision !== inferred.decision;
}

function buildRunNarrative(changeNote: string, result: any): RunNarrative {
  const inferred = inferRunNarrative({
    changeNote,
    finalSimTimeSec: result.finalSimTimeSec,
    pph: result.pph,
    anomalies: result.anomalies,
    finalWaitingVehicles: result.finalWaitingVehicles,
    shadowLedgerSummary: summarizeRunShadowLedger(result.shadowLedger)
  });
  return {
    runReason: runReason ?? inferred.runReason,
    problemsObserved: mergeNarrativeTextList(runProblemsObserved, inferred.problemsObserved),
    problemsSolved: mergeNarrativeTextList(runProblemsSolved, inferred.problemsSolved),
    decision: mergeNarrativeDecision(runDecision, inferred.decision, result)
  };
}

function summarizeRunShadowLedger(shadowLedger: any): RunShadowLedgerSummary {
  const finalLedger = shadowLedger?.final ?? shadowLedger ?? {};
  const invariantCounts = numericRecord(finalLedger.invariantCounts);
  const stationInvariantCounts = numericRecord(finalLedger.stationContracts?.invariantCounts);
  const sampleViolations = Array.isArray(shadowLedger?.sampleViolations) ? shadowLedger.sampleViolations : [];
  const explicitTopCodes = Array.isArray(shadowLedger?.topViolationCodes)
    ? shadowLedger.topViolationCodes
      .map((row: any) => ({
        code: cleanText(row.code) ?? cleanText(row[0]) ?? 'unknown',
        count: Number(row.count ?? row[1] ?? 0)
      }))
      .filter((row: { code: string; count: number }) => row.count > 0)
    : [];
  const violations = Array.isArray(finalLedger.violations) ? finalLedger.violations : [];
  const countedTopCodes = explicitTopCodes.length > 0
    ? explicitTopCodes
    : countViolationCodes(violations);
  return {
    invariantCounts,
    stationInvariantCounts,
    samplesWithViolations: Number(shadowLedger?.samplesWithViolations ?? 0),
    topViolationCodes: countedTopCodes.slice(0, 5),
    duplicateOwnerClasses: duplicateOwnerClassesForShadowLedger(shadowLedger),
    examples: violations.slice(0, 3).map((violation: any) => {
      const code = cleanText(violation.code) ?? 'unknown';
      const resource = cleanText(violation.resourceKey);
      const vehicles = [cleanText(violation.vehicleId), cleanText(violation.otherVehicleId)]
        .filter((value): value is string => value !== null)
        .join('/');
      const suffix = [resource, vehicles].filter(Boolean).join(' ');
      return suffix ? `${code}: ${suffix}` : code;
    }),
    sampleExamples: sampleViolations.slice(0, 3).map((violation: any) => {
      const code = cleanText(violation.code) ?? 'unknown';
      const resource = cleanText(violation.resourceKey);
      const vehicles = [cleanText(violation.vehicleId), cleanText(violation.otherVehicleId)]
        .filter((value): value is string => value !== null)
        .join('/');
      const timeSec = Number.isFinite(Number(violation.timeSec)) ? `t=${formatNarrativeNumber(violation.timeSec)}s` : null;
      const suffix = [timeSec, resource, vehicles].filter(Boolean).join(' ');
      return suffix ? `${code}: ${suffix}` : code;
    })
  };
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key, Number(raw)])
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
  );
}

function countViolationCodes(violations: any[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const code = cleanText(violation?.code) ?? 'unknown';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function shadowLedgerProblemSummaries(summary: unknown): string[] {
  if (!summary || typeof summary !== 'object') {
    return [];
  }
  const typed = summary as RunShadowLedgerSummary;
  const problems: string[] = [];
  const total = Number(typed.invariantCounts?.total ?? 0);
  if (total > 0) {
    const nonZeroCounts = Object.entries(typed.invariantCounts ?? {})
      .filter(([key, value]) => key !== 'total' && Number(value) > 0)
      .map(([key, value]) => `${key}=${value}`)
      .slice(0, 4);
    const examples = Array.isArray(typed.examples) && typed.examples.length > 0
      ? `；例子：${typed.examples.slice(0, 2).join('；')}`
      : '';
    problems.push(`Shadow ledger 仍有 ${total} 个 invariant violation：${nonZeroCounts.join(', ') || 'unknown'}${examples}。`);
  }
  const stationTotal = Number(typed.stationInvariantCounts?.total ?? 0);
  if (stationTotal > 0) {
    const nonZeroCounts = Object.entries(typed.stationInvariantCounts ?? {})
      .filter(([key, value]) => key !== 'total' && Number(value) > 0)
      .map(([key, value]) => `${key}=${value}`)
      .slice(0, 4);
    problems.push(`Station contract 仍有 ${stationTotal} 个 invariant violation：${nonZeroCounts.join(', ') || 'unknown'}。`);
  }
  const samplesWithViolations = Number(typed.samplesWithViolations ?? 0);
  if (samplesWithViolations > 0) {
    const examples = Array.isArray(typed.sampleExamples) && typed.sampleExamples.length > 0
      ? `；例子：${typed.sampleExamples.slice(0, 2).join('；')}`
      : '';
    problems.push(`运行期间有 ${samplesWithViolations} 次 shadow ledger sample 出现 watch violation${examples}。`);
  }
  if (Array.isArray(typed.duplicateOwnerClasses) && typed.duplicateOwnerClasses.length > 0) {
    const classText = typed.duplicateOwnerClasses
      .slice(0, 4)
      .map((row) => `${row.className}=${row.samples}`)
      .join(', ');
    problems.push(`duplicate-resource-owner 分类：${classText}。`);
  }
  return problems;
}

function inferRunNarrative(run: any): RunNarrative {
  const changeNote = String(run.changeNote ?? 'unspecified change');
  const normalizedChange = changeNote.toLowerCase();
  const anomalies = Array.isArray(run.anomalies) ? run.anomalies : [];
  const waiting = Array.isArray(run.finalWaitingVehicles) ? run.finalWaitingVehicles : [];
  const pph = run.pph ?? {};
  const anomalySummary = anomalies.length > 0
    ? `${anomalies.length} 个 anomaly：${anomalies.slice(0, 3).map((anomaly: any) => {
      const code = anomaly.code ?? 'unknown';
      const endWaitReason = anomaly.metrics?.endWaitReason;
      return endWaitReason ? `${code}/${endWaitReason}` : code;
    }).join(', ')}`
    : '本轮没有记录到 AMR anomaly。';
  const waitingSummary = waiting.length > 0
    ? `结束时还有 ${waiting.length} 台车在等待：${waiting.slice(0, 3).map((vehicle: any) => `${vehicle.vehicleId ?? 'unknown'}:${vehicle.waitReason ?? 'unknown'}`).join(', ')}`
    : '结束时没有车辆仍在等待。';
  const pphSummary = `PPH：total=${formatNarrativeNumber(pph.total)}, inbound=${formatNarrativeNumber(pph.inbound)}, outbound=${formatNarrativeNumber(pph.outbound)}。`;
  const shadowLedgerProblems = shadowLedgerProblemSummaries(run.shadowLedgerSummary);

  if (normalizedChange.includes('rolling log')) {
    return {
      runReason: '验证 rolling log 管道，保证每次仿真都追加到同一个实验记录里，而不是散落在不同输出文件。',
      problemsObserved: ['这是 log smoke run，不是模型质量候选方案。', waitingSummary],
      problemsSolved: ['确认 runtime、PPH、anomaly、最终等待车辆和输出路径都能写入 rolling log。'],
      decision: '只作为 logging evidence 保留，不参与 traffic-control 候选方案对比。'
    };
  }

  if (normalizedChange.includes('baseline after spine endpoint yield')) {
    return {
      runReason: '冻结 storage-prefix reachability 修复前的 physical-tick baseline，后续每次重跑都能和同一个失败模式对比。',
      problemsObserved: [anomalySummary, waitingSummary, 'baseline 复现了 inbound storage dropoff 附近 route-unavailable / node-occupied：目标点被分配后，物理访问前缀被堵住。'],
      problemsSolved: ['本轮没有应用模型修复；它是 before-state 证据。'],
      decision: '把这轮作为 control run。下一步要禁止 inbound 分配到访问前缀已经被堵住的 storage slot。'
    };
  }

  if (normalizedChange.includes('storage-prefix reachability fix')) {
    return {
      runReason: '验证 strict storage-prefix reachability fix 是否能消除 baseline 的 route-unavailable dead-end。',
      problemsObserved: [anomalySummary, waitingSummary, pphSummary, 'dead-end 症状改善了，但 inbound throughput 低于 baseline 目标。'],
      problemsSolved: ['阻止明显不可达的 storage assignment，并在测试窗口内消除了最终 stuck waiting vehicles。'],
      decision: '不能停在这里。保留稳定性收益，再测试更不保守的 access-path lease 来恢复吞吐。'
    };
  }

  if (normalizedChange.includes('storage access-path lease') && !normalizedChange.includes('committed-only')) {
    return {
      runReason: '测试 inbound allocation 阶段预留 storage access path，是否能防止后续车辆堵住已预留的 dropoff 路径。',
      problemsObserved: [anomalySummary, waitingSummary, pphSummary, '30 分钟窗口出现明显 inbound 下降，说明 queued-only task 太早占用 path cell。'],
      problemsSolved: ['结构上保持稳定，但过度约束系统，吞吐受损。'],
      decision: '拒绝这一版，原因是太保守。改成 committed-only access-path lease 后重新跑 A/B gate。'
    };
  }

  if (normalizedChange.includes('committed-only storage access-path lease')) {
    const longWindowFailed = run.finalSimTimeSec >= 3 * 3600 && (anomalies.length > 0 || waiting.length > 0);
    return {
      runReason: '验证当前候选方案：只有 assigned / in-progress / vehicle-owned 的 inbound task 才 lease storage access path。',
      problemsObserved: [
        anomalySummary,
        waitingSummary,
        pphSummary,
        ...(longWindowFailed ? ['长窗后半段出现持续 waiting/blocking 和 PPH 下滑，说明短窗通过不代表系统已经稳定。'] : [])
      ],
      problemsSolved: longWindowFailed
        ? ['短窗 no-dead-end 行为仍然改善，但长窗死锁/长等待没有被根治。']
        : ['保留 no-dead-end 行为，同时避免被拒绝版本里 queued task 过早占路的问题。'],
      decision: longWindowFailed
        ? '3 小时 gate 未通过。下一步不要扩大到 24h，先定位 SH-02 / SH-06 / SH-07 的 node-occupied 与 no-stop-continuation-blocked 死锁链。'
        : run.finalSimTimeSec >= 3 * 3600
        ? '如果 3 小时 gate 稳定，再进入 3D visual smoke 和 24 小时 evidence run。'
        : '短窗结果有希望，继续从 10m/30m/1h 扩大到 3h 和 24h gate。'
    };
  }

  if (normalizedChange.includes('no-stop middle-access clearing')) {
    const criticalAnomalyCount = anomalies.filter((anomaly: any) => anomaly.severity === 'critical').length;
    const routeUnavailable = anomalies.some((anomaly: any) =>
      String(anomaly.code ?? '').includes('route-unavailable') ||
      String(anomaly.detail ?? '').includes('route-unavailable') ||
      String(anomaly.metrics?.endWaitReason ?? '').includes('route-unavailable')
    );
    const hasRemainingProblem = criticalAnomalyCount > 0 || anomalies.length > 0 || waiting.length > 0;
    return {
      runReason: '验证 no-stop middle-access clearing：空车挡住满车 spine 通行时，必须移动到真实图上可达的合法 hold pocket。',
      problemsObserved: [
        anomalySummary,
        waitingSummary,
        pphSummary,
        ...(routeUnavailable ? ['本轮仍出现 route-unavailable 等待信号，需要确认它是短暂重规划等待，还是新的访问路径漏洞。'] : [])
      ],
      problemsSolved: hasRemainingProblem
        ? ['没有把这轮当作完成修复；它保留了剩余 anomaly / waiting 证据。']
        : ['本窗口没有复现 SH-02 / SH-06 / SH-07 mutual no-stop deadlock，也没有 final waiting。'],
      decision: criticalAnomalyCount > 0 || waiting.length > 0
        ? '停止扩大测试窗口，先回查 critical anomaly 或 final waiting 的 checkpoint。'
        : anomalies.length > 0
        ? '不要直接扩大到 1h/24h；先回查 watch anomaly，确认是否需要修 route-unavailable 或放宽 anomaly 判定。'
        : '本窗口通过；继续扩大到下一档 physical tick gate。'
    };
  }

  return {
    runReason: '记录一次 physical-tick simulation gate，包括 PPH、10 分钟 AMR task matrix、waiting state 和 anomaly evidence。',
    problemsObserved: [anomalySummary, waitingSummary, pphSummary, ...shadowLedgerProblems],
    problemsSolved: anomalies.length === 0 && waiting.length === 0
      ? ['本窗口没有出现 critical AMR stuck / final-wait 症状。']
      : ['本轮保留剩余问题证据，不把它当作已经解决。'],
    decision: '先和上一轮 baseline 对比，再决定保留、拒绝还是扩大测试窗口。'
  };
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function cleanTextList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => cleanText(item))
      .filter((item): item is string => item !== null);
    return cleaned.length > 0 ? cleaned : fallback;
  }
  const single = cleanText(value);
  return single ? splitNarrativeText(single) : fallback;
}

function mergeNarrativeTextList(primary: string[], measured: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...measured]) {
    const cleaned = cleanText(item);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    const anomalySummaryPrefix = cleaned.match(/^(\d+ 个 anomaly)：/)?.[1];
    if (anomalySummaryPrefix) {
      const existingIndex = merged.findIndex((existing) =>
        existing.startsWith(`${anomalySummaryPrefix}：`)
      );
      if (existingIndex >= 0) {
        if (cleaned.length > merged[existingIndex]!.length) {
          seen.delete(merged[existingIndex]!);
          merged[existingIndex] = cleaned;
          seen.add(cleaned);
        }
        continue;
      }
    }
    seen.add(cleaned);
    merged.push(cleaned);
  }
  return merged;
}

function mergeNarrativeDecision(explicitDecision: string | null | undefined, measuredDecision: string, run: any): string {
  const explicit = cleanText(explicitDecision);
  if (!explicit || explicit === measuredDecision) {
    return measuredDecision;
  }
  const measuredSuffix = ` 实测补充：${measuredDecision}`;
  const anomalies = Array.isArray(run.anomalies) ? run.anomalies : [];
  const waiting = Array.isArray(run.finalWaitingVehicles) ? run.finalWaitingVehicles : [];
  const benignFinalWaitReasons = new Set(['node-clearing', 'local-yield-hold']);
  const hasMeaningfulFinalWaiting = waiting.some((entry: any) => {
    const reason = String(entry.waitReason ?? '');
    const currentWaitSec = Number(entry.currentWaitSec ?? 0);
    return !benignFinalWaitReasons.has(reason) || currentWaitSec >= 30;
  });
  const hasMeasuredProblem = anomalies.length > 0 || hasMeaningfulFinalWaiting;
  if (explicit.includes(measuredSuffix)) {
    const [prefix] = explicit.split(measuredSuffix);
    return hasMeasuredProblem ? `${prefix}${measuredSuffix}` : prefix.trim();
  }
  if (explicit.includes(measuredDecision)) {
    return explicit;
  }
  const shouldAppendMeasuredDecision =
    hasMeasuredProblem &&
    (explicit.includes('如果') || explicit.includes('if') || explicit.includes('If') || explicit.includes('扩大'));
  return shouldAppendMeasuredDecision ? `${explicit} 实测补充：${measuredDecision}` : explicit;
}

function splitNarrativeText(value: string): string[] {
  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatNarrativeNumber(value: unknown): string {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? round(numberValue, 3).toString() : 'n/a';
}

function renderRollingRunLogHtml(log: { updatedAt: string; runs: any[] }): string {
  const normalizedLog = {
    ...log,
    runs: log.runs.map(normalizeRollingRunEntry)
  };
  const data = JSON.stringify(normalizedLog).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <title>Shuttle Sim 滚动实验日志</title>
  <script src="vendor/plotly-2.35.2.min.js"></script>
  <style>
    :root { color-scheme: dark; --bg:#071018; --panel:#111c26; --line:#263748; --text:#eaf2fb; --muted:#9fb2c3; --accent:#55d6be; --warn:#ffce5c; --bad:#ff7b72; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1280px; margin:0 auto; padding:24px; }
    h1, h2, h3 { margin:0; letter-spacing:0; }
    h1 { font-size:26px; }
    h2 { font-size:20px; margin-top:28px; }
    h3 { font-size:16px; margin-bottom:10px; }
    .subtle { color:var(--muted); }
    .run { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; margin-top:18px; }
    .latest-run { border-color:var(--accent); box-shadow:0 0 0 1px rgba(85,214,190,0.16); }
    .protocol { border:1px solid var(--line); background:#0b1520; border-radius:8px; padding:14px; margin-top:14px; }
    .protocol h2 { margin-top:0; font-size:18px; }
    .protocol ul { margin:8px 0 0; padding-left:20px; color:var(--muted); }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; margin:14px 0; }
    .narrative { border:1px solid var(--line); border-radius:6px; background:#0b1520; padding:12px; margin:14px 0; }
    .narrative-grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; }
    .narrative-action { grid-column:1 / -1; border-bottom:1px solid var(--line); padding-bottom:10px; }
    .narrative h3 { margin:0 0 10px; }
    .narrative strong { display:block; margin-bottom:4px; }
    .narrative p { margin:0; color:var(--muted); }
    .narrative ul { margin:0; padding-left:18px; color:var(--muted); }
    .metric { border:1px solid var(--line); border-radius:6px; padding:10px; background:#0b1520; }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; font-size:22px; margin-top:2px; }
    .charts { display:grid; grid-template-columns: 1fr; gap:14px; }
    .chart { height:330px; border:1px solid var(--line); border-radius:6px; background:#08131d; }
    table { width:100%; border-collapse:collapse; margin-top:10px; }
    .table-wrap { overflow-x:auto; }
    th, td { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    code { color:#c7eaff; }
    .ok { color:var(--accent); }
    .watch { color:var(--warn); }
    .critical, .warn { color:var(--bad); }
    @media (max-width: 1000px) { .narrative-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 800px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } main { padding:16px; } }
    @media (max-width: 640px) { .narrative-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Shuttle Sim 滚动实验日志</h1>
    <p class="subtle">每 30 秒自动刷新。更新时间 ${escapeHtml(log.updatedAt)}。最新运行在最上方。</p>
    <section class="protocol">
      <h2>实验日志规则</h2>
      <p class="subtle">每一轮仿真都必须留下可追责说明；如果没有真正解决，也要明确写成“本轮保留证据 / 不作为完成修复”。</p>
      <ul>
        <li><strong>为什么重新跑：</strong>上一轮暴露了什么、这一轮要验证哪个假设、和哪个 baseline 对比。</li>
        <li><strong>遇到的问题：</strong>本轮看到的 anomaly、waiting、PPH 变化、shadow/station invariant 或 10 分钟 AMR 异常。</li>
        <li><strong>解决的问题 / 验证的问题：</strong>这轮具体修了什么、证明了什么；如果没解决，必须写清楚还剩什么证据。</li>
        <li><strong>下一步决定：</strong>保留、拒绝、扩大测试窗口，还是停止继续跑并回查 checkpoint。</li>
      </ul>
    </section>
    <section id="runs"></section>
  </main>
  <script>
    const log = ${data};
    const runsEl = document.getElementById('runs');
    const runs = [...(log.runs || [])].reverse();
    const fmt = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits).replace(/\\.0$/, '') : 'n/a';
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const seconds = (sec) => {
      const value = Number(sec || 0);
      const h = Math.floor(value / 3600);
      const m = Math.floor((value % 3600) / 60);
      return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    };
    const renderTable = (headers, rows) => {
      if (!rows.length) return '<p class="subtle">None</p>';
      return '<div class="table-wrap"><table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + headers.map((h) => '<td>' + esc(row[h]) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    };
    const shortText = (value, max = 180) => {
      const text = String(value ?? '');
      return text.length > max ? text.slice(0, max - 1) + '...' : text;
    };
    const listHtml = (items) => {
      const rows = Array.isArray(items) ? items.filter((item) => String(item ?? '').trim() !== '') : [];
      if (!rows.length) return '<p>n/a</p>';
      return '<ul>' + rows.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>';
    };
    const renderNarrative = (run) => {
      const narrative = run?.narrative || {};
      const item = narrative || {};
      const externalReview = run?.externalReview;
      const externalReviewHtml = externalReview
        ? '<div class="narrative-action"><strong>外部 Review</strong><p>' +
          esc([
            externalReview.reviewer,
            externalReview.decision,
            externalReview.responsePath,
            externalReview.conversationUrl
          ].filter(Boolean).join(' | ')) +
          '</p></div>'
        : '';
      return '<section class="narrative">' +
        '<h3>本轮实验记录</h3>' +
        '<div class="narrative-grid">' +
          '<div class="narrative-action"><strong>本轮做了什么</strong><p>' + esc(run?.changeNote || 'n/a') + '</p></div>' +
          externalReviewHtml +
          '<div><strong>为什么重新跑</strong><p>' + esc(item.runReason || 'n/a') + '</p></div>' +
          '<div><strong>遇到的问题</strong>' + listHtml(item.problemsObserved) + '</div>' +
          '<div><strong>解决的问题 / 验证的问题</strong>' + listHtml(item.problemsSolved) + '</div>' +
          '<div><strong>下一步决定</strong><p>' + esc(item.decision || 'n/a') + '</p></div>' +
        '</div>' +
      '</section>';
    };
    const overviewRows = runs.map((run, index) => ({
      '#': runs.length - index,
      '记录时间': run.createdAt,
      '本轮做了什么': run.changeNote || 'unspecified change',
      '为什么重新跑': shortText(run.narrative?.runReason, 140),
      '遇到的问题': shortText((run.narrative?.problemsObserved || []).join(' '), 140),
      '解决的问题 / 验证的问题': shortText((run.narrative?.problemsSolved || []).join(' '), 140),
      '下一步决定': shortText(run.externalReview?.decision || run.narrative?.decision, 140),
      '仿真时长': seconds(run.finalSimTimeSec),
      '实际耗时': seconds((run.wallClockMs || 0) / 1000),
      In: fmt(run.pph?.inbound, 1),
      Out: fmt(run.pph?.outbound, 1),
      Total: fmt(run.pph?.total, 1),
      Anomalies: (run.anomalies || []).length,
      '输出文件': run.outputPath
    }));
    const overview = '<article class="run">' +
      '<h2>实验记录总览</h2>' +
      '<p class="subtle">每次运行都会追加到这里，新结果在最上方。总览表直接记录为什么重新跑、遇到的问题、解决/验证的问题和下一步决定，避免只看 PPH 数字却不知道为什么重跑。</p>' +
      renderTable(['#','记录时间','本轮做了什么','为什么重新跑','遇到的问题','解决的问题 / 验证的问题','下一步决定','仿真时长','实际耗时','In','Out','Total','Anomalies','输出文件'], overviewRows) +
      '</article>';
    const renderRunCard = (run, index, extraClass = '') => {
      const anomalies = run.anomalies || [];
      const waiting = run.finalWaitingVehicles || [];
      const duplicateOwnerClasses = run.shadowLedgerSummary?.duplicateOwnerClasses || [];
      const hourlyRows = (run.hourlyPph || []).map((row) => ({
        Hour: 'H' + row.hour,
        In: fmt(row.hourlyInbound, 0),
        Out: fmt(row.hourlyOutbound, 0),
        Total: fmt(row.hourlyTotal, 0),
        'Cum PPH': fmt(row.totalPph, 1),
        Waiting: row.waitingVehicles,
        Blocked: row.blockedVehicles
      }));
      return '<article class="run ' + esc(extraClass) + '">' +
        '<h2>' + (index === 0 ? '最新一轮：' : '') + esc(run.changeNote || 'unspecified change') + '</h2>' +
        '<p class="subtle">' + esc(run.createdAt) + ' · sim ' + seconds(run.finalSimTimeSec) + ' · wall ' + seconds((run.wallClockMs || 0) / 1000) + ' · <code>' + esc(run.outputPath) + '</code></p>' +
        renderNarrative(run) +
        '<div class="grid">' +
          '<div class="metric"><span>Total PPH</span><strong>' + fmt(run.pph?.total, 1) + '</strong></div>' +
          '<div class="metric"><span>Inbound PPH</span><strong>' + fmt(run.pph?.inbound, 1) + '</strong></div>' +
          '<div class="metric"><span>Outbound PPH</span><strong>' + fmt(run.pph?.outbound, 1) + '</strong></div>' +
          '<div class="metric"><span>Anomalies</span><strong class="' + (anomalies.length ? 'watch' : 'ok') + '">' + anomalies.length + '</strong></div>' +
        '</div>' +
        '<div class="charts">' +
          '<div id="hourly-' + index + '" class="chart"></div>' +
          '<div id="tenmin-' + index + '" class="chart"></div>' +
          '<div id="matrix-' + index + '" class="chart"></div>' +
        '</div>' +
        '<h3>Hourly PPH</h3>' + renderTable(['Hour','In','Out','Total','Cum PPH','Waiting','Blocked'], hourlyRows) +
        '<h3>Anomalies</h3>' + renderTable(['Time','Vehicle','Severity','Code','Detail'], anomalies.map((a) => ({ Time: seconds(a.timeSec), Vehicle: a.vehicleId || '', Severity: a.severity, Code: a.code, Detail: a.detail }))) +
        '<h3>Final Waiting Vehicles</h3>' + renderTable(['Vehicle','Node','Target','Reason','Wait Sec','Blocker'], waiting.map((v) => ({ Vehicle:v.vehicleId, Node:v.currentNodeId, Target:v.targetNodeId, Reason:v.waitReason, 'Wait Sec':fmt(v.currentWaitSec,1), Blocker:v.blockingVehicleId || '' }))) +
        '<h3>Duplicate Owner Classification</h3>' + renderTable(['Class','Samples'], duplicateOwnerClasses.map((row) => ({ Class: row.className, Samples: row.samples }))) +
      '</article>';
    };
    const runCards = runs.map((run, index) => renderRunCard(run, index, index === 0 ? 'latest-run' : ''));
    runsEl.innerHTML = (runCards[0] || '') + overview + runCards.slice(1).join('');
    const layoutBase = { paper_bgcolor:'#08131d', plot_bgcolor:'#08131d', font:{ color:'#eaf2fb' }, margin:{ l:50, r:20, t:42, b:45 }, xaxis:{ gridcolor:'#263748' }, yaxis:{ gridcolor:'#263748' } };
    runs.forEach((run, index) => {
      const hourly = run.hourlyPph || [];
      Plotly.newPlot('hourly-' + index, [
        { x: hourly.map((r) => 'H' + r.hour), y: hourly.map((r) => r.hourlyInbound), mode:'lines+markers', name:'Inbound' },
        { x: hourly.map((r) => 'H' + r.hour), y: hourly.map((r) => r.hourlyOutbound), mode:'lines+markers', name:'Outbound' },
        { x: hourly.map((r) => 'H' + r.hour), y: hourly.map((r) => r.hourlyTotal), mode:'lines+markers', name:'Total' }
      ], { ...layoutBase, title:'Hourly PPH' }, { responsive:true, displayModeBar:false });
      const windows = run.tenMinuteWindows || [];
      const windowIds = [...new Set(windows.map((r) => r.windowIndex))].sort((a,b) => a-b);
      const totalTasks = windowIds.map((id) => windows.filter((r) => r.windowIndex === id).reduce((sum, r) => sum + (r.completedTasks || 0), 0));
      Plotly.newPlot('tenmin-' + index, [
        { x: windowIds.map((id) => 'W' + id), y: totalTasks, mode:'lines+markers', name:'Completed tasks' }
      ], { ...layoutBase, title:'Completed Tasks Per 10 Minutes' }, { responsive:true, displayModeBar:false });
      const vehicles = [...new Set(windows.map((r) => r.vehicleId))].sort();
      const z = vehicles.map((vehicleId) => windowIds.map((id) => {
        const row = windows.find((r) => r.vehicleId === vehicleId && r.windowIndex === id);
        return row ? row.completedTasks : null;
      }));
      Plotly.newPlot('matrix-' + index, [
        { x: windowIds.map((id) => 'W' + id), y: vehicles, z, type:'heatmap', colorscale:'Viridis', hoverongaps:false }
      ], { ...layoutBase, title:'AMR Completed Tasks Per 10 Minutes', yaxis:{ ...layoutBase.yaxis, autorange:'reversed' } }, { responsive:true, displayModeBar:false });
    });
  </script>
</body>
</html>
`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function auditState(state: ShuttleSimState, dtSec: number): void {
  if (state.kpis.deadlockCount > lastDeadlocks) {
    const deadlockCandidateIds = state.traffic.deadlockCandidateVehicleIds ?? [];
    const maxCurrentWaitSec = maxCurrentWaitingSec(state);
    const deadlockEvent = latestDeadlockDetectedEvent(state.simTimeSec);
    const eventWaitingVehicles = deadlockEvent?.details.waitingVehicles ?? null;
    const severity = maxCurrentWaitSec >= thresholds.longWaitSec ? 'critical' : 'watch';
    addAnomaly(
      state.simTimeSec,
      null,
      null,
      severity,
      'deadlock-count-increased',
      `${lastDeadlocks} -> ${state.kpis.deadlockCount}; activeCandidates=${deadlockCandidateIds.join(',') || 'none'}; ` +
        `eventWaitingVehicles=${eventWaitingVehicles ?? 'unknown'}; eventTimeSec=${deadlockEvent ? round(deadlockEvent.timeSec, 3) : 'unknown'}; ` +
        `maxCurrentWaitSec=${round(maxCurrentWaitSec, 3)}`
    );
    recordCheckpoint(state, state.simTimeSec);
    lastDeadlocks = state.kpis.deadlockCount;
  }
  if (state.kpis.livelockCount > lastLivelocks) {
    addAnomaly(state.simTimeSec, null, null, 'critical', 'livelock-count-increased', `${lastLivelocks} -> ${state.kpis.livelockCount}`);
    recordCheckpoint(state, state.simTimeSec);
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
    const assignedWithoutRoute = assignedWithoutRouteIssue(state, vehicle as VehicleRuntimeState);
    if (assignedWithoutRoute) {
      const anomalyKey = `${vehicle.id}|${vehicle.taskId ?? 'none'}|${vehicle.currentNodeId}`;
      if (!assignedWithoutRouteAnomalyKeys.has(anomalyKey)) {
        assignedWithoutRouteAnomalyKeys.add(anomalyKey);
        addAnomaly(
          state.simTimeSec,
          null,
          vehicle.id,
          'critical',
          'assigned-without-route',
          assignedWithoutRoute.detail,
          assignedWithoutRoute.metrics
        );
        recordCheckpoint(state, state.simTimeSec);
      }
    }
    updateVehicleWindow(state, vehicle as VehicleRuntimeState, dtSec);
  }
}

function latestDeadlockDetectedEvent(timeSec: number): EventLogEntry | null {
  const eventLog = sim.getEventLog();
  for (let index = eventLog.length - 1; index >= 0; index -= 1) {
    const event = eventLog[index]!;
    if (event.timeSec > timeSec + 1e-9) {
      continue;
    }
    if (event.eventType === 'deadlock-detected') {
      return event;
    }
  }
  return null;
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
  let checkpointNeeded = false;
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
    const duplicateOwnerClass = violation.code === 'duplicate-resource-owner'
      ? shadowLedgerDuplicateOwnerClassForState(state, violation)
      : undefined;
    if (!shadowLedgerViolationSamples.has(sampleKey) && shadowLedgerViolationSamples.size < 50) {
      shadowLedgerViolationSamples.set(sampleKey, {
        ...violation,
        timeSec: round(state.simTimeSec),
        ...(duplicateOwnerClass ? { duplicateOwnerClass } : {})
      });
    }
    if (
      !shadowLedgerViolationCheckpointKeys.has(sampleKey) &&
      shadowLedgerViolationCheckpointKeys.size < MAX_SHADOW_LEDGER_VIOLATION_CHECKPOINTS
    ) {
      shadowLedgerViolationCheckpointKeys.add(sampleKey);
      checkpointNeeded = true;
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
      const className = duplicateOwnerClass ?? shadowLedgerDuplicateOwnerClass(sourcePattern);
      shadowLedgerDuplicateOwnerClassCounts.set(
        className,
        (shadowLedgerDuplicateOwnerClassCounts.get(className) ?? 0) + 1
      );
    }
  }
  if (checkpointNeeded) {
    recordCheckpoint(state, state.simTimeSec);
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

function shadowLedgerDuplicateOwnerClass(sourcePattern: string): string {
  const sources = sourcePattern
    .split(',')
    .map((source) => source.trim())
    .filter((source) => source.length > 0);
  const hardSources = sources.filter((source) => source !== 'plannedRouteNodeIds');
  if (hardSources.length === 0) {
    return 'soft-planned-vs-planned';
  }
  if (hardSources.length === 1) {
    return `soft-${hardSources[0]}-vs-planned`;
  }
  return `hard-multi-active-claim:${[...new Set(hardSources)].sort().join('+')}`;
}

function shadowLedgerDuplicateOwnerClassForState(state: ShuttleSimState, violation: ShadowLedgerViolation): string {
  const fallback = shadowLedgerDuplicateOwnerClass(shadowLedgerDuplicateSourcePattern(violation.detail));
  if (violation.code !== 'duplicate-resource-owner' || !violation.resourceKey?.startsWith('node:')) {
    return fallback;
  }
  const nodeId = violation.resourceKey.slice('node:'.length);
  const ownerIds = shadowLedgerDuplicateOwnerIds(violation);
  const owners = ownerIds
    .map((vehicleId) => state.vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null)
    .filter((vehicle): vehicle is VehicleState => vehicle !== null);
  if (owners.length < 2) {
    return fallback;
  }
  const roles = owners.map((vehicle) => shadowNodeOwnerRole(vehicle, nodeId));
  const sameEdgeFollowing =
    roles.every((role) => role === 'active-edge-target') &&
    new Set(owners.map((vehicle) => vehicle.currentEdgeId)).size === 1;
  if (sameEdgeFollowing) {
    return 'soft-same-edge-following-target';
  }
  if (
    roles.includes('active-edge-target') &&
    roles.some((role) => role === 'planned-future' || role === 'local-future')
  ) {
    return 'soft-future-route-vs-active-target';
  }
  if (
    roles.includes('current-node-stopped') &&
    roles.some((role) => role === 'active-edge-target' || role === 'target')
  ) {
    const occupant = owners.find((vehicle) => shadowNodeOwnerRole(vehicle, nodeId) === 'current-node-stopped') ?? null;
    const entrant = owners.find((vehicle) => shadowNodeOwnerRole(vehicle, nodeId) === 'active-edge-target') ?? null;
    const occupantWaitSec = occupant?.waitingSinceSec === null || occupant?.waitingSinceSec === undefined
      ? 0
      : Math.max(0, state.simTimeSec - occupant.waitingSinceSec);
    const pairDistanceM = occupant && entrant
      ? Math.hypot(occupant.x - entrant.x, occupant.z - entrant.z)
      : Number.POSITIVE_INFINITY;
    if (
      occupant?.state === 'waiting-blocked' &&
      (occupant.waitReason === 'node-clearing' || occupant.waitReason === 'node-target-near') &&
      occupantWaitSec <= 3 &&
      pairDistanceM >= 2
    ) {
      return 'soft-transient-clearance-overlap';
    }
    return 'hard-occupied-target';
  }
  if (roles.filter((role) => role === 'active-edge-target' || role === 'target').length >= 2) {
    return 'hard-competing-active-target';
  }
  return fallback;
}

function shadowLedgerDuplicateOwnerIds(violation: ShadowLedgerViolation): string[] {
  const match = violation.detail.match(/shadow owners:\s+(.+?)\s+via\s+/);
  if (match?.[1]) {
    return match[1]
      .split(',')
      .map((owner) => owner.trim())
      .filter((owner) => owner.length > 0);
  }
  return [violation.vehicleId, violation.otherVehicleId]
    .filter((vehicleId): vehicleId is string => Boolean(vehicleId));
}

function shadowNodeOwnerRole(vehicle: VehicleState, nodeId: string): string {
  if (vehicle.currentNodeId === nodeId && vehicle.currentEdgeId === null) {
    return 'current-node-stopped';
  }
  if (vehicle.currentNodeId === nodeId) {
    return 'current-node-moving';
  }
  if (vehicle.targetNodeId === nodeId && vehicle.currentEdgeId !== null) {
    return 'active-edge-target';
  }
  if (vehicle.targetNodeId === nodeId) {
    return 'target';
  }
  const localTail = shadowVehicleRouteTail(vehicle, vehicle.localRouteNodeIds);
  if (localTail[1] === nodeId) {
    return 'local-next';
  }
  if (localTail.slice(2).includes(nodeId)) {
    return 'local-future';
  }
  const plannedTail = shadowVehicleRouteTail(vehicle, vehicle.plannedRouteNodeIds);
  if (plannedTail[1] === nodeId) {
    return 'planned-next';
  }
  if (plannedTail.slice(2).includes(nodeId)) {
    return 'planned-future';
  }
  return 'unknown';
}

function shadowVehicleRouteTail(vehicle: VehicleState, routeNodeIds: string[]): string[] {
  if (routeNodeIds.length === 0) {
    return [];
  }
  const currentIndex = routeNodeIds.indexOf(vehicle.currentNodeId);
  if (currentIndex >= 0) {
    return routeNodeIds.slice(currentIndex);
  }
  if (vehicle.targetNodeId) {
    const targetIndex = routeNodeIds.indexOf(vehicle.targetNodeId);
    if (targetIndex >= 0) {
      return [vehicle.currentNodeId, ...routeNodeIds.slice(targetIndex)];
    }
  }
  return [vehicle.currentNodeId, ...routeNodeIds];
}

function duplicateOwnerClassesForShadowLedger(shadowLedger: any): Array<{ className: string; samples: number }> {
  const explicit = Array.isArray(shadowLedger?.duplicateOwnerClasses)
    ? shadowLedger.duplicateOwnerClasses
      .map((row: any) => ({
        className: cleanText(row.className) ?? cleanText(row.class) ?? 'unknown',
        samples: Number(row.samples ?? row.count ?? 0)
      }))
      .filter((row: { className: string; samples: number }) => row.samples > 0)
    : [];
  if (explicit.length > 0) {
    return explicit.slice(0, 12);
  }
  const sampleViolations = Array.isArray(shadowLedger?.sampleViolations) ? shadowLedger.sampleViolations : [];
  const counts = new Map<string, number>();
  for (const violation of sampleViolations) {
    if (violation?.code !== 'duplicate-resource-owner') {
      continue;
    }
    const className = cleanText(violation.duplicateOwnerClass) ??
      shadowLedgerDuplicateOwnerClass(shadowLedgerDuplicateSourcePattern(String(violation.detail ?? '')));
    counts.set(className, (counts.get(className) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([className, samples]) => ({ className, samples }));
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
  let checkpointRecordedForWindow = false;
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
      if (!checkpointRecordedForWindow) {
        recordCheckpoint(state, state.simTimeSec);
        checkpointRecordedForWindow = true;
      }
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
  const assignedWithoutRoute = assignedWithoutRouteIssue(state, vehicle) !== null;
  const riskCodes = [
    assignedWithoutRoute ? 'assigned-without-route' : null,
    stationary ? 'stationary-active-window' : null,
    smallAreaLoop ? 'small-area-loop' : null,
    nodePingPong ? 'node-ping-pong' : null,
    longWait ? 'long-wait-window' : null,
    zeroTaskMoving ? 'zero-task-moving-window' : null
  ].filter((code): code is string => code !== null);
  const riskLevel: VehicleWindowRow['riskLevel'] = assignedWithoutRoute || stationary
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
    assignedWithoutRoute,
    riskLevel,
    riskCodes
  };
}

function assignedWithoutRouteIssue(
  state: ShuttleSimState,
  vehicle: VehicleRuntimeState
): { detail: string; metrics: AmrAnomaly['metrics'] } | null {
  if (
    !vehicle.taskId ||
    vehicle.targetNodeId !== null ||
    vehicle.currentEdgeId !== null ||
    vehicle.legRemainingM > 0 ||
    vehicle.phaseRemainingSec > 0 ||
    vehicle.waitReason !== null ||
    vehicle.routeNodeIds.length > 1
  ) {
    return null;
  }
  const task = state.tasks.find((candidate) => candidate.id === vehicle.taskId);
  if (!task || task.state !== 'assigned') {
    return null;
  }
  const serviceNodeId = vehicle.loaded ? task.dropoffNodeId : task.pickupNodeId;
  if (vehicle.currentNodeId === serviceNodeId) {
    return null;
  }
  return {
    detail: `${vehicle.id} has assigned ${task.kind} task ${task.id} at ${vehicle.currentNodeId}, but no target route toward ${serviceNodeId}.`,
    metrics: {
      taskId: task.id,
      taskKind: task.kind,
      currentNodeId: vehicle.currentNodeId,
      serviceNodeId,
      loaded: vehicle.loaded,
      routeLength: vehicle.routeNodeIds.length,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      plannedRouteLength: vehicle.plannedRouteNodeIds.length
    }
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
    duplicateOwnerClasses: [...shadowLedgerDuplicateOwnerClassCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([className, samples]) => ({ className, samples })),
    sampleViolations: [...shadowLedgerViolationSamples.values()]
      .sort((left, right) => left.timeSec - right.timeSec || left.code.localeCompare(right.code))
  };
}

function summarizeStationQueueLeaseTransitions(eventLog: EventLogEntry[]): StationQueueLeaseTransitionSummary {
  const events = eventLog.filter((event) => event.eventType === 'station-queue-lease-transition');
  const byReason = new Map<string, number>();
  const byStation = new Map<string, number>();
  const byVehicle = new Map<string, number>();
  const ages = events
    .map((event) => numberDetail(event, 'ageSec'))
    .filter((ageSec): ageSec is number => ageSec !== null);

  for (const event of events) {
    byReason.set(event.reason ?? 'unknown', (byReason.get(event.reason ?? 'unknown') ?? 0) + 1);
    byStation.set(stringDetail(event, 'stationId') ?? 'unknown', (byStation.get(stringDetail(event, 'stationId') ?? 'unknown') ?? 0) + 1);
    byVehicle.set(event.vehicleId ?? 'unknown', (byVehicle.get(event.vehicleId ?? 'unknown') ?? 0) + 1);
  }

  return {
    total: events.length,
    byReason: rankedCountRows(byReason, 12, 'reason'),
    byStation: rankedCountRows(byStation, 12, 'stationId'),
    byVehicle: rankedCountRows(byVehicle, 20, 'vehicleId'),
    ageSec: {
      min: ages.length > 0 ? round(Math.min(...ages), 3) : null,
      avg: ages.length > 0 ? round(ages.reduce((sum, ageSec) => sum + ageSec, 0) / ages.length, 3) : null,
      max: ages.length > 0 ? round(Math.max(...ages), 3) : null
    },
    samples: events.slice(0, 50).map((event) => ({
      timeSec: event.timeSec,
      vehicleId: event.vehicleId,
      taskId: event.taskId,
      reason: event.reason,
      stationId: stringDetail(event, 'stationId'),
      targetNodeId: stringDetail(event, 'targetNodeId') ?? event.fromNodeId,
      nextTaskKind: stringDetail(event, 'nextTaskKind'),
      nextStationId: stringDetail(event, 'nextStationId'),
      ageSec: numberDetail(event, 'ageSec')
    }))
  };
}

function rankedCountRows<Key extends string>(
  map: Map<string, number>,
  limit: number,
  keyName: Key
): Array<Record<Key, string> & { count: number }> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ [keyName]: key, count }) as Record<Key, string> & { count: number });
}

function stringDetail(event: EventLogEntry, key: string): string | null {
  const value = event.details[key];
  return typeof value === 'string' ? value : null;
}

function numberDetail(event: EventLogEntry, key: string): number | null {
  const value = event.details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function stringListArg(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) {
      const next = process.argv[index + 1];
      if (next && !next.startsWith('--')) {
        values.push(...splitNarrativeText(next));
      }
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      values.push(...splitNarrativeText(arg.slice(name.length + 1)));
    }
  }
  return values.filter((value) => value.trim() !== '');
}
