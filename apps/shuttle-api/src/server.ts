import http from 'node:http';
import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  ShuttleCommandSchema,
  type ShuttleSimState,
  type ShuttleStreamMessage,
  type VehicleState
} from '@four-way-shuttle/schemas';
import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashEventLog,
  hashScenario,
  runHeadlessDes,
  type ShuttleEngineSnapshotV1
} from '@four-way-shuttle/sim-core';

import { collectPrerequisites } from './prerequisites.js';
import { validatePhase0Scenario } from './validation.js';

const port = Number(process.env.SHUTTLE_PORT ?? process.env.PORT ?? 8791);
const tickMs = Number(process.env.SHUTTLE_TICK_MS ?? 100);
const streamBroadcastIntervalMs = Number(process.env.SHUTTLE_STREAM_TICK_MS ?? 250);
const fullStateBroadcastIntervalMs = Number(process.env.SHUTTLE_FULL_STATE_TICK_MS ?? 1000);
const traceSnapshotCadenceSec = Number(process.env.SHUTTLE_TRACE_SNAPSHOT_SEC ?? 0);
const maxTraceSnapshots = Number(process.env.SHUTTLE_TRACE_MAX_SNAPSHOTS ?? 1800);
const longRunTraceSnapshotThresholdSec = Number(process.env.SHUTTLE_LONG_RUN_TRACE_SNAPSHOT_THRESHOLD_SEC ?? 1800);
const maxPhysicalRecordingFrames = Number(process.env.SHUTTLE_PHYSICAL_RECORDING_MAX_FRAMES ?? 7200);
const physicalRecordingJobChunkFrames = Number(process.env.SHUTTLE_PHYSICAL_RECORDING_CHUNK_FRAMES ?? 80);
const maxRetainedPhysicalRecordings = Number(process.env.SHUTTLE_PHYSICAL_RECORDING_RETAIN ?? 3);

type ReplayCommandRecordV1 = {
  sequence: number;
  wallClockMs: number;
  receivedAtSimTimeSec: number;
  appliedTickIndex: number;
  type: 'loadScenario' | 'reset' | 'pause' | 'resume' | 'setParam' | 'playbackSpeed' | 'runToTime';
  payload: unknown;
  result: unknown;
  stateHashAfter: string;
};

type ReplaySnapshotRecordV1 = {
  sequence: number;
  reason: 'initial' | 'periodic' | 'command' | 'anomaly';
  wallClockMs: number;
  simTimeSec: number;
  tickIndex: number;
  snapshot: ShuttleEngineSnapshotV1;
  markerId?: string;
  note?: string;
};

type RunTraceV1 = {
  schemaVersion: 'shuttle.runTrace.v1';
  runId: string;
  createdAtIso: string;
  repoCommitSha: string;
  packageVersion: string;
  scenarioHash: string;
  scenario: ReturnType<ShuttleSimCore['getScenario']>;
  seed: number;
  fixedDtSec: number;
  initialSnapshot: ShuttleEngineSnapshotV1;
  commands: ReplayCommandRecordV1[];
  snapshots: ReplaySnapshotRecordV1[];
  eventLog: ReturnType<ShuttleSimCore['getEventLog']>;
  anomalyMarkers: ReplaySnapshotRecordV1[];
};

type ScenarioSetup = {
  regionCount: number;
  minRegionCount: number;
  maxRegionCount: number;
  shuttleCount: number;
  minShuttleCount: number;
  maxShuttleCount: number;
  storageColumns: number;
  storageRows: number;
  storageCapacity: number;
  physicalLiftCount: number;
  inboundLiftCount: number;
  outboundLiftCount: number;
  initialOutboundFullColumns: number;
  maxInitialOutboundFullColumns: number;
};

type PhysicalRecordingFrameV1 = Pick<
  ShuttleSimState,
  'simTimeSec' | 'status' | 'vehicles' | 'tasks' | 'loads' | 'reservations' | 'traffic' | 'kpis' | 'recentEvents' | 'error'
>;

type PhysicalRecordingMarkerV1 = {
  sequence: number;
  simTimeSec: number;
  kind: 'deadlock' | 'livelock' | 'physical-violation';
  note: string;
  vehicleIds: string[];
};

type PhysicalRecordingV1 = {
  schemaVersion: 'shuttle.physicalRecording.v1';
  id: string;
  createdAtIso: string;
  completedAtIso: string;
  scenarioHash: string;
  scenario: ReturnType<ShuttleSimCore['getScenario']>;
  durationSec: number;
  sampleIntervalSec: number;
  frameCount: number;
  elapsedMs: number;
  summary: {
    finalSimTimeSec: number;
    status: ShuttleSimState['status'];
    completedInbound: number;
    completedOutbound: number;
    inboundPph: number;
    outboundPph: number;
    totalPph: number;
    deadlocks: number;
    livelocks: number;
    physicalViolations: number;
  };
  anomalyMarkers: PhysicalRecordingMarkerV1[];
  frames: PhysicalRecordingFrameV1[];
};

type PhysicalRecordingJobStatus = 'queued' | 'running' | 'completed' | 'failed';

type PhysicalRecordingJobPublicV1 = {
  id: string;
  status: PhysicalRecordingJobStatus;
  createdAtIso: string;
  durationSec: number;
  sampleIntervalSec: number;
  latestSec: number;
  progressPct: number;
  framesRecorded: number;
  elapsedMs: number;
  scenarioHash: string;
  recordingId: string | null;
  summary: PhysicalRecordingV1['summary'] | null;
  error: string | null;
};

type PhysicalRecordingJobInternal = {
  id: string;
  status: PhysicalRecordingJobStatus;
  createdAtIso: string;
  startedAtMs: number;
  completedAtMs: number | null;
  durationSec: number;
  sampleIntervalSec: number;
  latestSec: number;
  nextSampleSec: number;
  scenarioHash: string;
  scenario: ReturnType<ShuttleSimCore['getScenario']>;
  sim: ShuttleSimCore;
  frames: PhysicalRecordingFrameV1[];
  anomalyMarkers: PhysicalRecordingMarkerV1[];
  markerSequence: number;
  lastDeadlockCount: number;
  lastLivelockCount: number;
  lastPhysicalViolationCount: number;
  summary: PhysicalRecordingV1['summary'] | null;
  recordingId: string | null;
  error: string | null;
};

function parsePlaybackSpeed(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0 && speed <= 100 ? speed : null;
}

let playbackSpeed = parsePlaybackSpeed(process.env.SHUTTLE_SPEED) ?? 1;

function parseFiniteNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseRegionCount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const regionCount = Number(value);
  return Number.isInteger(regionCount) && regionCount >= 1 && regionCount <= 8 ? regionCount : null;
}

function parseShuttleCount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const shuttleCount = Number(value);
  return Number.isInteger(shuttleCount) && shuttleCount >= 1 && shuttleCount <= 64 ? shuttleCount : null;
}

function parseInitialOutboundFullColumns(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const columnCount = Number(value);
  return Number.isInteger(columnCount) && columnCount >= 0 && columnCount <= 256 ? columnCount : null;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

let sim = new ShuttleSimCore(createInboundOutboundDemoScenario());
const clients = new Set<WebSocket>();
let lastEventSequence = -1;
let lastStreamBroadcastMs = 0;
let lastFullStateBroadcastMs = 0;
let liveTickCreditSec = 0;
let runId = randomUUID();
let traceCreatedAtIso = new Date().toISOString();
let traceCommandSequence = 0;
let traceSnapshotSequence = 0;
let traceCommands: ReplayCommandRecordV1[] = [];
let traceSnapshots: ReplaySnapshotRecordV1[] = [];
let anomalyMarkers: ReplaySnapshotRecordV1[] = [];
let lastTraceSnapshotSimTimeSec = -Infinity;
let traceInitialSnapshot: ShuttleEngineSnapshotV1 | null = null;
const physicalRecordings = new Map<string, PhysicalRecordingV1>();
const physicalRecordingJobs = new Map<string, PhysicalRecordingJobInternal>();

function inferTopLiftRegionCount(scenario: ReturnType<ShuttleSimCore['getScenario']>): number {
  const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
  const storageRows = new Set(storageNodes.map((node) => node.z)).size;
  const storageColumns = storageRows > 0 ? Math.round(storageNodes.length / storageRows) : 0;
  if (scenario.layout.calibrationProfile?.id === 'top-lift-column-v1' && storageColumns > 0) {
    return Math.max(1, Math.round(storageColumns / 14));
  }
  const inboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound').length;
  return Math.max(1, inboundLiftCount);
}

function setupFromScenario(scenario: ReturnType<ShuttleSimCore['getScenario']>): ScenarioSetup {
  const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
  const storageRows = new Set(storageNodes.map((node) => node.z)).size;
  const storageColumns = storageRows > 0 ? Math.round(storageNodes.length / storageRows) : 0;
  const inboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound').length;
  const outboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound').length;

  return {
    regionCount: inferTopLiftRegionCount(scenario),
    minRegionCount: 1,
    maxRegionCount: 8,
    shuttleCount: scenario.vehicles.count,
    minShuttleCount: 1,
    maxShuttleCount: 64,
    storageColumns,
    storageRows,
    storageCapacity: storageNodes.length,
    physicalLiftCount: inboundLiftCount + outboundLiftCount,
    inboundLiftCount,
    outboundLiftCount,
    initialOutboundFullColumns: scenario.taskGeneration.initialOutboundFullColumns,
    maxInitialOutboundFullColumns: storageColumns
  };
}

function createInboundSetupScenario(regionCount: number, shuttleCount: number, initialOutboundFullColumns: number): ReturnType<ShuttleSimCore['getScenario']> {
  const current = sim.getScenario();
  return createInboundOutboundDemoScenario({
    seed: current.seed,
    durationSec: current.durationSec,
    timeStepSec: current.timeStepSec,
    vehicles: {
      ...current.vehicles,
      count: shuttleCount
    },
    taskGeneration: {
      ...current.taskGeneration,
      initialOutboundFullColumns
    },
    physicsParams: current.physicsParams,
    routingPolicy: current.routingPolicy,
    trafficPolicy: current.trafficPolicy,
    layoutProfile: {
      layoutKind: 'top-lift-column',
      liftPairCount: regionCount
    }
  });
}

function normalizePhysicalRecordingOptions(input: {
  durationSec: unknown;
  sampleIntervalSec: unknown;
}): { durationSec: number; sampleIntervalSec: number } | { error: string } {
  const requestedDurationSec = input.durationSec === undefined ? 3 * 3600 : parseFiniteNonNegativeNumber(input.durationSec);
  if (requestedDurationSec === null || requestedDurationSec <= 0) {
    return { error: 'durationSec must be a finite positive number.' };
  }
  const requestedSampleIntervalSec = input.sampleIntervalSec === undefined ? 5 : parseFiniteNonNegativeNumber(input.sampleIntervalSec);
  if (requestedSampleIntervalSec === null || requestedSampleIntervalSec <= 0) {
    return { error: 'sampleIntervalSec must be a finite positive number.' };
  }
  const durationSec = Math.min(7 * 24 * 3600, requestedDurationSec);
  const targetMaxFrames = Math.max(60, Math.floor(maxPhysicalRecordingFrames));
  const minSampleForFrameCap = durationSec / targetMaxFrames;
  const sampleIntervalSec = Math.max(0.5, requestedSampleIntervalSec, minSampleForFrameCap);
  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    sampleIntervalSec: Math.round(sampleIntervalSec * 1000) / 1000
  };
}

function physicalRecordingFrameFromState(state: ShuttleSimState): PhysicalRecordingFrameV1 {
  return {
    simTimeSec: state.simTimeSec,
    status: state.status,
    vehicles: state.vehicles.map((vehicle): VehicleState => ({ ...vehicle })),
    tasks: state.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed'),
    loads: state.loads.filter((load) => load.state !== 'delivered'),
    reservations: state.reservations,
    traffic: state.traffic,
    kpis: state.kpis,
    recentEvents: [],
    error: state.error
  };
}

function physicalRecordingSummaryFromState(state: ShuttleSimState): PhysicalRecordingV1['summary'] {
  return {
    finalSimTimeSec: state.simTimeSec,
    status: state.status,
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    inboundPph: state.kpis.inboundPph,
    outboundPph: state.kpis.outboundPph,
    totalPph: state.kpis.totalPph,
    deadlocks: state.kpis.deadlockCount,
    livelocks: state.kpis.livelockCount,
    physicalViolations: state.traffic.physicalViolationCount
  };
}

function appendPhysicalRecordingAnomalies(job: PhysicalRecordingJobInternal, state: ShuttleSimState): void {
  const marker = (
    kind: PhysicalRecordingMarkerV1['kind'],
    note: string,
    vehicleIds: string[] = []
  ) => {
    job.anomalyMarkers.push({
      sequence: job.markerSequence,
      simTimeSec: state.simTimeSec,
      kind,
      note,
      vehicleIds
    });
    job.markerSequence += 1;
  };

  if (state.kpis.deadlockCount > job.lastDeadlockCount) {
    marker('deadlock', `deadlock count ${job.lastDeadlockCount} -> ${state.kpis.deadlockCount}`, state.traffic.deadlockCandidateVehicleIds);
    job.lastDeadlockCount = state.kpis.deadlockCount;
  }
  if (state.kpis.livelockCount > job.lastLivelockCount) {
    marker('livelock', `livelock count ${job.lastLivelockCount} -> ${state.kpis.livelockCount}`);
    job.lastLivelockCount = state.kpis.livelockCount;
  }
  if (state.traffic.physicalViolationCount > job.lastPhysicalViolationCount) {
    marker(
      'physical-violation',
      `physical violation count ${job.lastPhysicalViolationCount} -> ${state.traffic.physicalViolationCount}`,
      state.vehicles.map((vehicle) => vehicle.id)
    );
    job.lastPhysicalViolationCount = state.traffic.physicalViolationCount;
  }
}

function prunePhysicalRecordings(): void {
  const excess = physicalRecordings.size - Math.max(1, Math.floor(maxRetainedPhysicalRecordings));
  if (excess <= 0) {
    return;
  }
  for (const id of [...physicalRecordings.keys()].slice(0, excess)) {
    physicalRecordings.delete(id);
  }
}

function publicPhysicalRecordingJob(job: PhysicalRecordingJobInternal): PhysicalRecordingJobPublicV1 {
  const nowMs = job.completedAtMs ?? Date.now();
  return {
    id: job.id,
    status: job.status,
    createdAtIso: job.createdAtIso,
    durationSec: job.durationSec,
    sampleIntervalSec: job.sampleIntervalSec,
    latestSec: job.latestSec,
    progressPct: job.durationSec > 0 ? Math.min(100, Math.max(0, (job.latestSec / job.durationSec) * 100)) : 0,
    framesRecorded: job.frames.length,
    elapsedMs: Math.max(0, nowMs - job.startedAtMs),
    scenarioHash: job.scenarioHash,
    recordingId: job.recordingId,
    summary: job.summary,
    error: job.error
  };
}

function completePhysicalRecordingJob(job: PhysicalRecordingJobInternal, finalState: ShuttleSimState): void {
  job.status = 'completed';
  job.completedAtMs = Date.now();
  job.latestSec = finalState.simTimeSec;
  job.summary = physicalRecordingSummaryFromState(finalState);
  const lastFrame = job.frames.at(-1);
  if (!lastFrame || Math.abs(lastFrame.simTimeSec - finalState.simTimeSec) > 1e-6) {
    job.frames.push(physicalRecordingFrameFromState(finalState));
  }
  const recording: PhysicalRecordingV1 = {
    schemaVersion: 'shuttle.physicalRecording.v1',
    id: job.id,
    createdAtIso: job.createdAtIso,
    completedAtIso: new Date(job.completedAtMs).toISOString(),
    scenarioHash: job.scenarioHash,
    scenario: job.scenario,
    durationSec: job.durationSec,
    sampleIntervalSec: job.sampleIntervalSec,
    frameCount: job.frames.length,
    elapsedMs: job.completedAtMs - job.startedAtMs,
    summary: job.summary,
    anomalyMarkers: job.anomalyMarkers,
    frames: job.frames
  };
  physicalRecordings.set(recording.id, recording);
  prunePhysicalRecordings();
  job.recordingId = recording.id;
  job.sim.retainRecentEventLog(0);
}

function processPhysicalRecordingJob(jobId: string): void {
  const job = physicalRecordingJobs.get(jobId);
  if (!job || job.status !== 'running') {
    return;
  }

  try {
    const frameBudget = Math.max(1, Math.floor(physicalRecordingJobChunkFrames));
    let framesThisChunk = 0;
    while (framesThisChunk < frameBudget && job.latestSec < job.durationSec - 1e-9 && job.sim.getClock().status === 'running') {
      const targetSec = Math.min(job.durationSec, job.nextSampleSec);
      const currentSec = job.sim.getClock().simTimeSec;
      if (targetSec > currentSec + 1e-9) {
        job.sim.advanceByInPlace(targetSec - currentSec);
      }
      const state = job.sim.getState();
      job.latestSec = state.simTimeSec;
      appendPhysicalRecordingAnomalies(job, state);
      job.frames.push(physicalRecordingFrameFromState(state));
      job.sim.retainRecentEventLog(2000);
      job.nextSampleSec = Math.min(job.durationSec, job.nextSampleSec + job.sampleIntervalSec);
      if (state.status !== 'running' || state.simTimeSec >= job.durationSec - 1e-9) {
        break;
      }
      framesThisChunk += 1;
    }

    const clock = job.sim.getClock();
    if (clock.simTimeSec >= job.durationSec - 1e-9 || clock.status !== 'running') {
      completePhysicalRecordingJob(job, job.sim.getState());
      return;
    }

    setImmediate(() => processPhysicalRecordingJob(jobId));
  } catch (error) {
    job.status = 'failed';
    job.completedAtMs = Date.now();
    job.error = error instanceof Error ? error.message : String(error);
  }
}

function startPhysicalRecordingJob(options: { durationSec: number; sampleIntervalSec: number; resetFirst: boolean }): PhysicalRecordingJobInternal {
  const existingActiveJob = [...physicalRecordingJobs.values()].find((job) => job.status === 'queued' || job.status === 'running');
  if (existingActiveJob) {
    throw new Error(`Physical recording job ${existingActiveJob.id} is already ${existingActiveJob.status}.`);
  }

  const sourceScenario = sim.getScenario();
  const scenario = {
    ...sourceScenario,
    durationSec: Math.max(options.durationSec, sourceScenario.durationSec)
  };
  const recordingSim = new ShuttleSimCore(scenario);
  if (!options.resetFirst) {
    recordingSim.restoreSnapshot(sim.createSnapshot());
    recordingSim.setDurationSec(Math.max(options.durationSec, recordingSim.getClock().simTimeSec));
  }
  recordingSim.start();
  const initialState = recordingSim.getState();
  const job: PhysicalRecordingJobInternal = {
    id: randomUUID(),
    status: 'running',
    createdAtIso: new Date().toISOString(),
    startedAtMs: Date.now(),
    completedAtMs: null,
    durationSec: options.durationSec,
    sampleIntervalSec: options.sampleIntervalSec,
    latestSec: initialState.simTimeSec,
    nextSampleSec: Math.min(options.durationSec, initialState.simTimeSec + options.sampleIntervalSec),
    scenarioHash: hashScenario(scenario),
    scenario,
    sim: recordingSim,
    frames: [physicalRecordingFrameFromState(initialState)],
    anomalyMarkers: [],
    markerSequence: 0,
    lastDeadlockCount: initialState.kpis.deadlockCount,
    lastLivelockCount: initialState.kpis.livelockCount,
    lastPhysicalViolationCount: initialState.traffic.physicalViolationCount,
    summary: null,
    recordingId: null,
    error: null
  };
  physicalRecordingJobs.set(job.id, job);
  if (initialState.simTimeSec >= options.durationSec - 1e-9) {
    completePhysicalRecordingJob(job, initialState);
  } else {
    setImmediate(() => processPhysicalRecordingJob(job.id));
  }
  return job;
}

function resetTrace(reason: 'initial' | 'command' = 'initial'): void {
  runId = randomUUID();
  traceCreatedAtIso = new Date().toISOString();
  traceCommandSequence = 0;
  traceSnapshotSequence = 0;
  traceCommands = [];
  traceSnapshots = [];
  anomalyMarkers = [];
  lastTraceSnapshotSimTimeSec = -Infinity;
  const initial = recordTraceSnapshot(reason);
  traceInitialSnapshot = initial.snapshot;
}

function recordTraceSnapshot(reason: ReplaySnapshotRecordV1['reason'], options: { markerId?: string; note?: string } = {}): ReplaySnapshotRecordV1 {
  const snapshot = sim.createSnapshot();
  const record: ReplaySnapshotRecordV1 = {
    sequence: traceSnapshotSequence,
    reason,
    wallClockMs: Date.now(),
    simTimeSec: snapshot.simTimeSec,
    tickIndex: snapshot.tickIndex,
    snapshot,
    ...options
  };
  traceSnapshotSequence += 1;
  traceSnapshots.push(record);
  if (reason === 'anomaly') {
    anomalyMarkers.push(record);
  }
  if (traceSnapshots.length > maxTraceSnapshots) {
    traceSnapshots = traceSnapshots.slice(-maxTraceSnapshots);
  }
  lastTraceSnapshotSimTimeSec = snapshot.simTimeSec;
  return record;
}

function maybeRecordPeriodicTraceSnapshot(): void {
  if (!Number.isFinite(traceSnapshotCadenceSec) || traceSnapshotCadenceSec <= 0) {
    return;
  }
  const snapshot = sim.createSnapshot();
  if (snapshot.simTimeSec - lastTraceSnapshotSimTimeSec >= traceSnapshotCadenceSec - 1e-9) {
    const record: ReplaySnapshotRecordV1 = {
      sequence: traceSnapshotSequence,
      reason: 'periodic',
      wallClockMs: Date.now(),
      simTimeSec: snapshot.simTimeSec,
      tickIndex: snapshot.tickIndex,
      snapshot
    };
    traceSnapshotSequence += 1;
    traceSnapshots.push(record);
    if (traceSnapshots.length > maxTraceSnapshots) {
      traceSnapshots = traceSnapshots.slice(-maxTraceSnapshots);
    }
    lastTraceSnapshotSimTimeSec = snapshot.simTimeSec;
  }
}

function recordTraceCommand(
  type: ReplayCommandRecordV1['type'],
  payload: unknown,
  result: unknown,
  receivedAtSimTimeSec: number,
  options: { captureSnapshot?: boolean } = {}
): void {
  const captureSnapshot = options.captureSnapshot !== false;
  const snapshot = captureSnapshot ? sim.createSnapshot() : null;
  traceCommands.push({
    sequence: traceCommandSequence,
    wallClockMs: Date.now(),
    receivedAtSimTimeSec,
    appliedTickIndex: snapshot?.tickIndex ?? sim.getClock().tickIndex,
    type,
    payload,
    result,
    stateHashAfter: snapshot?.stateHash ?? 'not-captured'
  });
  traceCommandSequence += 1;
  if (captureSnapshot) {
    recordTraceSnapshot('command');
  }
}

function exportRunTrace(): RunTraceV1 {
  if (traceSnapshots.length === 0) {
    recordTraceSnapshot('initial');
  }
  const scenario = sim.getScenario();
  return {
    schemaVersion: 'shuttle.runTrace.v1',
    runId,
    createdAtIso: traceCreatedAtIso,
    repoCommitSha: process.env.SHUTTLE_COMMIT_SHA ?? process.env.GIT_COMMIT ?? 'unknown',
    packageVersion: process.env.npm_package_version ?? '0.1.0',
    scenarioHash: hashScenario(scenario),
    scenario,
    seed: scenario.seed,
    fixedDtSec: scenario.timeStepSec,
    initialSnapshot: traceInitialSnapshot ?? traceSnapshots[0]!.snapshot,
    commands: structuredClone(traceCommands),
    snapshots: structuredClone(traceSnapshots),
    eventLog: sim.getEventLog(),
    anomalyMarkers: structuredClone(anomalyMarkers)
  };
}

resetTrace('initial');

function send(socket: WebSocket, message: ShuttleStreamMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(message: ShuttleStreamMessage): void {
  for (const client of clients) {
    send(client, message);
  }
}

function broadcastState(options: { full?: boolean } = {}): void {
  const nowMs = Date.now();
  const shouldBroadcastStream =
    options.full === true ||
    nowMs - lastStreamBroadcastMs >= streamBroadcastIntervalMs;
  const shouldBroadcastFull =
    options.full === true ||
    nowMs - lastFullStateBroadcastMs >= fullStateBroadcastIntervalMs;
  if (!shouldBroadcastStream && !shouldBroadcastFull) {
    return;
  }
  const state = sim.getState();
  if (shouldBroadcastFull) {
    lastFullStateBroadcastMs = nowMs;
    broadcast({ type: 'simState', state });
  }
  if (shouldBroadcastStream) {
    lastStreamBroadcastMs = nowMs;
    broadcast({ type: 'vehicleState', vehicles: state.vehicles, simTimeSec: state.simTimeSec });
    broadcast({ type: 'kpiUpdate', kpis: state.kpis, simTimeSec: state.simTimeSec });
    const newEvents = state.recentEvents.filter((event) => event.sequence > lastEventSequence);
    if (newEvents.length > 0) {
      lastEventSequence = Math.max(...newEvents.map((event) => event.sequence));
      broadcast({ type: 'taskEvent', events: newEvents, simTimeSec: state.simTimeSec });
    }
  }
}

function commandResponse(response: Response): void {
  broadcastState({ full: true });
  response.json({ ok: true, state: sim.getState() });
}

function advanceLiveSimulation(deltaSec: number): void {
  liveTickCreditSec += deltaSec;
  const fixedDtSec = sim.getScenario().timeStepSec;
  let guard = 0;
  while (liveTickCreditSec + 1e-9 >= fixedDtSec && sim.getStatus() === 'running') {
    sim.advanceByInPlace(fixedDtSec);
    liveTickCreditSec = Math.max(0, liveTickCreditSec - fixedDtSec);
    guard += 1;
    if (guard > 1000) {
      throw new Error('Live simulation tick guard tripped; playback speed or tick interval is too high.');
    }
  }
  maybeRecordPeriodicTraceSnapshot();
}

app.get('/api/shuttle/health', (_request: Request, response: Response) => {
  response.json({ ok: true, service: 'shuttle-api', protocol: 'shuttle.phase0.v0' });
});

app.get('/api/shuttle/prerequisites', async (_request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await collectPrerequisites());
  } catch (error) {
    next(error);
  }
});

app.get('/api/shuttle/scenario', (_request: Request, response: Response) => {
  response.json(sim.getScenario());
});

app.get('/api/shuttle/setup', (_request: Request, response: Response) => {
  const scenario = sim.getScenario();
  const state = sim.getState();
  response.json({ ok: true, setup: setupFromScenario(scenario), scenario, state });
});

app.get('/api/shuttle/state', (_request: Request, response: Response) => {
  response.json(sim.getState());
});

app.get('/api/shuttle/playbackSpeed', (_request: Request, response: Response) => {
  response.json({ speed: playbackSpeed });
});

app.post('/api/shuttle/playbackSpeed', (request: Request, response: Response) => {
  const receivedAtSimTimeSec = sim.getClock().simTimeSec;
  const speed = parsePlaybackSpeed(request.body?.speed);
  if (speed === null) {
    response.status(422).json({ ok: false, error: 'Playback speed must be greater than 0 and at most 100.' });
    return;
  }
  playbackSpeed = speed;
  recordTraceCommand('playbackSpeed', { speed }, { ok: true, speed: playbackSpeed }, receivedAtSimTimeSec);
  response.json({ ok: true, speed: playbackSpeed, state: sim.getState() });
});

app.post('/api/shuttle/runToTime', (request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    const requestedTargetSec = parseFiniteNonNegativeNumber(request.body?.targetSimTimeSec);
    if (requestedTargetSec === null) {
      response.status(422).json({ ok: false, error: 'targetSimTimeSec must be a finite non-negative number.' });
      return;
    }

    const startedAtMs = Date.now();
    if (requestedTargetSec > sim.getScenario().durationSec) {
      sim.setDurationSec(requestedTargetSec);
    }
    const scenario = sim.getScenario();
    const targetSimTimeSec = requestedTargetSec;
    const resetFirst = request.body?.resetFirst === true || targetSimTimeSec + 1e-9 < sim.getClock().simTimeSec;
    if (resetFirst) {
      sim.reset(scenario.seed);
      resetTrace('command');
      lastEventSequence = -1;
    }

    if (sim.getClock().simTimeSec + 1e-9 < targetSimTimeSec) {
      sim.resume();
      sim.advanceByInPlace(targetSimTimeSec - sim.getClock().simTimeSec);
    } else if (sim.getStatus() === 'idle') {
      sim.resume();
    }

    sim.pause();
    liveTickCreditSec = 0;
    maybeRecordPeriodicTraceSnapshot();

    const state = sim.getState();
    const traceResult = {
      ok: true,
      targetSimTimeSec,
      resetFirst,
      elapsedMs: Date.now() - startedAtMs,
      simTimeSec: state.simTimeSec,
      status: state.status
    };
    const result = {
      ok: true,
      targetSimTimeSec,
      resetFirst,
      elapsedMs: traceResult.elapsedMs,
      state
    };
    recordTraceCommand(
      'runToTime',
      { targetSimTimeSec, resetFirst },
      traceResult,
      receivedAtSimTimeSec,
      { captureSnapshot: targetSimTimeSec <= longRunTraceSnapshotThresholdSec }
    );
    broadcastState({ full: true });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/runHeadlessDes', (request: Request, response: Response, next: NextFunction) => {
  try {
    const requestedDurationSec = parseFiniteNonNegativeNumber(request.body?.durationSec);
    const sampleIntervalSec = parseFiniteNonNegativeNumber(request.body?.sampleIntervalSec);
    const maxQueuedTasks = parseFiniteNonNegativeNumber(request.body?.maxQueuedTasks);
    const liftBufferCapacity = parseFiniteNonNegativeNumber(request.body?.liftBufferCapacity);
    const durationSec = requestedDurationSec ?? sim.getScenario().durationSec;
    const scenario = {
      ...sim.getScenario(),
      durationSec
    };
    const result = runHeadlessDes({
      scenario,
      durationSec,
      sampleIntervalSec: sampleIntervalSec ?? undefined,
      maxQueuedTasks: maxQueuedTasks === null ? undefined : Math.max(1, Math.round(maxQueuedTasks)),
      liftBufferCapacity: liftBufferCapacity === null ? undefined : Math.max(1, Math.round(liftBufferCapacity))
    });
    response.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/physicalRecordingJobs', (request: Request, response: Response, next: NextFunction) => {
  try {
    const options = normalizePhysicalRecordingOptions({
      durationSec: request.body?.durationSec,
      sampleIntervalSec: request.body?.sampleIntervalSec
    });
    if ('error' in options) {
      response.status(422).json({ ok: false, error: options.error });
      return;
    }

    const job = startPhysicalRecordingJob({
      durationSec: options.durationSec,
      sampleIntervalSec: options.sampleIntervalSec,
      resetFirst: request.body?.resetFirst !== false
    });
    response.json({ ok: true, job: publicPhysicalRecordingJob(job) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/shuttle/physicalRecordingJobs/:id', (request: Request, response: Response) => {
  const id = String(request.params.id ?? '');
  const job = physicalRecordingJobs.get(id);
  if (!job) {
    response.status(404).json({ ok: false, error: `Physical recording job ${id} was not found.` });
    return;
  }
  response.json({ ok: true, job: publicPhysicalRecordingJob(job) });
});

app.get('/api/shuttle/physicalRecordings/:id', (request: Request, response: Response) => {
  const id = String(request.params.id ?? '');
  const recording = physicalRecordings.get(id);
  if (!recording) {
    response.status(404).json({ ok: false, error: `Physical recording ${id} was not found or is not complete yet.` });
    return;
  }
  response.json({ ok: true, recording });
});

app.get('/api/shuttle/exportLog', (_request: Request, response: Response) => {
  const collisionAvoidanceEnabled = sim.getScenario().trafficPolicy.collisionAvoidanceEnabled !== false;
  response.json({
    collisionAvoidanceEnabled,
    safetyValidated: false,
    safetyValidationNote: collisionAvoidanceEnabled
      ? 'Run log export is not an IE or mechanical safety certificate.'
      : 'UNSAFE DIAGNOSTIC - collision avoidance is disabled.',
    eventLog: sim.getEventLog(),
    hash: hashEventLog(sim.getEventLog())
  });
});

app.get('/api/shuttle/exportTrace', (_request: Request, response: Response) => {
  response.json(exportRunTrace());
});

app.post('/api/shuttle/markAnomaly', (request: Request, response: Response) => {
  const markerId = typeof request.body?.markerId === 'string' && request.body.markerId.trim()
    ? request.body.markerId.trim()
    : `marker-${Date.now()}`;
  const note = typeof request.body?.note === 'string' ? request.body.note : undefined;
  const marker = recordTraceSnapshot('anomaly', { markerId, note });
  response.json({ ok: true, markerId, marker, state: sim.getState() });
});

app.post('/api/shuttle/validatePhase0', async (request: Request, response: Response, next: NextFunction) => {
  try {
    const durationSec = Number.isFinite(Number(request.body?.durationSec)) ? Number(request.body.durationSec) : undefined;
    const longRunDurationSec = Number.isFinite(Number(request.body?.longRunDurationSec)) ? Number(request.body.longRunDurationSec) : undefined;
    const stressDurationSec = Number.isFinite(Number(request.body?.stressDurationSec)) ? Number(request.body.stressDurationSec) : undefined;
    const repeatCount = Number.isFinite(Number(request.body?.repeatCount)) ? Number(request.body.repeatCount) : undefined;
    const sweepSeeds = Array.isArray(request.body?.sweepSeeds)
      ? request.body.sweepSeeds.map(Number).filter((value: number) => Number.isInteger(value) && value >= 0)
      : undefined;
    const stressSeeds = Array.isArray(request.body?.stressSeeds)
      ? request.body.stressSeeds.map(Number).filter((value: number) => Number.isInteger(value) && value >= 0)
      : undefined;
    response.json({
      ok: true,
      prerequisites: await collectPrerequisites(),
      validation: validatePhase0Scenario(sim.getScenario(), { durationSec, longRunDurationSec, stressDurationSec, repeatCount, sweepSeeds, stressSeeds })
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/loadScenario', (request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    const command = ShuttleCommandSchema.parse({ type: 'loadScenario', scenario: request.body });
    if (command.type !== 'loadScenario') throw new Error('Invalid loadScenario command');
    sim.loadScenario(command.scenario);
    liveTickCreditSec = 0;
    resetTrace('command');
    recordTraceCommand('loadScenario', command.scenario, { ok: true }, receivedAtSimTimeSec);
    lastEventSequence = -1;
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/setup', (request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    const regionCount = parseRegionCount(request.body?.regionCount);
    const currentScenario = sim.getScenario();
    const shuttleCount = request.body?.shuttleCount === undefined
      ? currentScenario.vehicles.count
      : parseShuttleCount(request.body?.shuttleCount);
    const requestedInitialOutboundFullColumns = request.body?.initialOutboundFullColumns === undefined
      ? currentScenario.taskGeneration.initialOutboundFullColumns
      : parseInitialOutboundFullColumns(request.body?.initialOutboundFullColumns);
    if (regionCount === null) {
      response.status(422).json({ ok: false, error: 'regionCount must be an integer from 1 to 8.' });
      return;
    }
    if (shuttleCount === null) {
      response.status(422).json({ ok: false, error: 'shuttleCount must be an integer from 1 to 64.' });
      return;
    }
    if (requestedInitialOutboundFullColumns === null) {
      response.status(422).json({ ok: false, error: 'initialOutboundFullColumns must be an integer from 0 to 256.' });
      return;
    }

    const maxInitialOutboundFullColumns = regionCount * 14;
    const initialOutboundFullColumns = Math.min(maxInitialOutboundFullColumns, requestedInitialOutboundFullColumns);
    const scenario = createInboundSetupScenario(regionCount, shuttleCount, initialOutboundFullColumns);
    sim.loadScenario(scenario);
    liveTickCreditSec = 0;
    resetTrace('command');
    recordTraceCommand('loadScenario', scenario, { ok: true, setup: { regionCount, shuttleCount, initialOutboundFullColumns } }, receivedAtSimTimeSec);
    lastEventSequence = -1;
    const state = sim.getState();
    broadcastState({ full: true });
    response.json({ ok: true, setup: setupFromScenario(scenario), scenario, state });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/reset', (request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    const command = ShuttleCommandSchema.parse({ type: 'reset', seed: request.body?.seed });
    if (command.type !== 'reset') throw new Error('Invalid reset command');
    sim.reset(command.seed);
    liveTickCreditSec = 0;
    resetTrace('command');
    recordTraceCommand('reset', { seed: command.seed }, { ok: true }, receivedAtSimTimeSec);
    lastEventSequence = -1;
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/pause', (_request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    sim.pause();
    recordTraceCommand('pause', {}, { ok: true }, receivedAtSimTimeSec);
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/resume', (_request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    sim.resume();
    recordTraceCommand('resume', {}, { ok: true }, receivedAtSimTimeSec);
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/setParam', (request: Request, response: Response, next: NextFunction) => {
  try {
    const receivedAtSimTimeSec = sim.getClock().simTimeSec;
    const command = ShuttleCommandSchema.parse({ type: 'setParam', ...request.body });
    if (command.type !== 'setParam') throw new Error('Invalid setParam command');
    const result = sim.setParam(command.path, command.value);
    if (!result.accepted) {
      response.status(422).json({ ok: false, result });
      return;
    }
    recordTraceCommand('setParam', { path: command.path, value: command.value }, result, receivedAtSimTimeSec);
    broadcastState();
    response.json({ ok: true, result, state: sim.getState() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/startRun', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'startRun', durationSec: request.body?.durationSec, seed: request.body?.seed });
    if (command.type !== 'startRun') throw new Error('Invalid startRun command');
    const scenario = sim.getScenario();
    const runSim = new ShuttleSimCore(command.seed === undefined ? scenario : { ...scenario, seed: command.seed });
    runSim.runToEnd(command.durationSec ?? scenario.durationSec);
    response.json({
      ok: true,
      state: runSim.getState(),
      eventLogHash: hashEventLog(runSim.getEventLog()),
      eventLog: runSim.getEventLog()
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  broadcast({ type: 'error', message });
  response.status(500).json({ ok: false, error: message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/shuttle-ws' });

wss.on('connection', (socket) => {
  clients.add(socket);
  send(socket, { type: 'connectionRecovered', state: sim.getState() });
  socket.on('close', () => {
    clients.delete(socket);
  });
});

setInterval(() => {
  if (sim.getStatus() === 'running') {
    advanceLiveSimulation((tickMs / 1000) * playbackSpeed);
    broadcastState();
  }
}, tickMs).unref();

server.listen(port, () => {
  console.log(`Shuttle Phase 0 API listening on http://localhost:${port}`);
});
