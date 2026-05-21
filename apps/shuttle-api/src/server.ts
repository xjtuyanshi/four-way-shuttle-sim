import http from 'node:http';
import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { ShuttleCommandSchema, type ShuttleStreamMessage } from '@four-way-shuttle/schemas';
import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashEventLog,
  hashScenario,
  type ShuttleEngineSnapshotV1
} from '@four-way-shuttle/sim-core';

import { collectPrerequisites } from './prerequisites.js';
import { validatePhase0Scenario } from './validation.js';

const port = Number(process.env.SHUTTLE_PORT ?? process.env.PORT ?? 8791);
const tickMs = Number(process.env.SHUTTLE_TICK_MS ?? 100);
const streamBroadcastIntervalMs = Number(process.env.SHUTTLE_STREAM_TICK_MS ?? 250);
const fullStateBroadcastIntervalMs = Number(process.env.SHUTTLE_FULL_STATE_TICK_MS ?? 1000);
const traceSnapshotCadenceSec = Number(process.env.SHUTTLE_TRACE_SNAPSHOT_SEC ?? 1);
const maxTraceSnapshots = Number(process.env.SHUTTLE_TRACE_MAX_SNAPSHOTS ?? 1800);

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

function parsePlaybackSpeed(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0 && speed <= 20 ? speed : null;
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

function inferTopLiftRegionCount(scenario: ReturnType<ShuttleSimCore['getScenario']>): number {
  const inboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound').length;
  return Math.max(1, Math.round(inboundLiftCount / 2));
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
    physicalLiftCount: Math.max(inboundLiftCount, outboundLiftCount),
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
  receivedAtSimTimeSec: number
): void {
  const snapshot = sim.createSnapshot();
  traceCommands.push({
    sequence: traceCommandSequence,
    wallClockMs: Date.now(),
    receivedAtSimTimeSec,
    appliedTickIndex: snapshot.tickIndex,
    type,
    payload,
    result,
    stateHashAfter: snapshot.stateHash
  });
  traceCommandSequence += 1;
  recordTraceSnapshot('command');
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
    response.status(422).json({ ok: false, error: 'Playback speed must be greater than 0 and at most 20.' });
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
    const scenario = sim.getScenario();
    const targetSimTimeSec = Math.min(requestedTargetSec, scenario.durationSec);
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
    recordTraceCommand('runToTime', { targetSimTimeSec, resetFirst }, traceResult, receivedAtSimTimeSec);
    broadcastState({ full: true });
    response.json(result);
  } catch (error) {
    next(error);
  }
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
