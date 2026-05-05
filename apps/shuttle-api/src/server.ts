import http from 'node:http';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { ShuttleCommandSchema, type ShuttleStreamMessage } from '@four-way-shuttle/schemas';
import { ShuttleSimCore, createDefaultShuttleScenario, hashEventLog } from '@four-way-shuttle/sim-core';

import { collectPrerequisites } from './prerequisites.js';
import { validatePhase0Scenario } from './validation.js';

const port = Number(process.env.SHUTTLE_PORT ?? process.env.PORT ?? 8791);
const tickMs = Number(process.env.SHUTTLE_TICK_MS ?? 250);

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

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

let sim = new ShuttleSimCore(createDefaultShuttleScenario());
const clients = new Set<WebSocket>();
let lastEventSequence = -1;

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

function broadcastState(): void {
  const state = sim.getState();
  broadcast({ type: 'simState', state });
  broadcast({ type: 'vehicleState', vehicles: state.vehicles, simTimeSec: state.simTimeSec });
  broadcast({ type: 'kpiUpdate', kpis: state.kpis, simTimeSec: state.simTimeSec });
  const newEvents = state.recentEvents.filter((event) => event.sequence > lastEventSequence);
  if (newEvents.length > 0) {
    lastEventSequence = Math.max(...newEvents.map((event) => event.sequence));
    broadcast({ type: 'taskEvent', events: newEvents, simTimeSec: state.simTimeSec });
  }
}

function commandResponse(response: Response): void {
  broadcastState();
  response.json({ ok: true, state: sim.getState() });
}

function advanceLiveSimulation(deltaSec: number): void {
  const maxStepSec = Math.max(0.001, sim.getScenario().timeStepSec);
  let remainingSec = deltaSec;
  while (remainingSec > 1e-9 && sim.getState().status === 'running') {
    const stepSec = Math.min(maxStepSec, remainingSec);
    sim.step(stepSec);
    remainingSec -= stepSec;
  }
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

app.get('/api/shuttle/state', (_request: Request, response: Response) => {
  response.json(sim.getState());
});

app.get('/api/shuttle/playbackSpeed', (_request: Request, response: Response) => {
  response.json({ speed: playbackSpeed });
});

app.post('/api/shuttle/playbackSpeed', (request: Request, response: Response) => {
  const speed = parsePlaybackSpeed(request.body?.speed);
  if (speed === null) {
    response.status(422).json({ ok: false, error: 'Playback speed must be greater than 0 and at most 20.' });
    return;
  }
  playbackSpeed = speed;
  response.json({ ok: true, speed: playbackSpeed, state: sim.getState() });
});

app.get('/api/shuttle/exportLog', (_request: Request, response: Response) => {
  response.json({ eventLog: sim.getEventLog(), hash: hashEventLog(sim.getEventLog()) });
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
    const command = ShuttleCommandSchema.parse({ type: 'loadScenario', scenario: request.body });
    if (command.type !== 'loadScenario') throw new Error('Invalid loadScenario command');
    sim.loadScenario(command.scenario);
    lastEventSequence = -1;
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/reset', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'reset', seed: request.body?.seed });
    if (command.type !== 'reset') throw new Error('Invalid reset command');
    sim.reset(command.seed);
    lastEventSequence = -1;
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/pause', (_request: Request, response: Response, next: NextFunction) => {
  try {
    sim.pause();
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/resume', (_request: Request, response: Response, next: NextFunction) => {
  try {
    sim.resume();
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/setParam', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'setParam', ...request.body });
    if (command.type !== 'setParam') throw new Error('Invalid setParam command');
    const result = sim.setParam(command.path, command.value);
    if (!result.accepted) {
      response.status(422).json({ ok: false, result });
      return;
    }
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
  if (sim.getState().status === 'running') {
    advanceLiveSimulation((tickMs / 1000) * playbackSpeed);
    broadcastState();
  }
}, tickMs).unref();

server.listen(port, () => {
  console.log(`Shuttle Phase 0 API listening on http://localhost:${port}`);
});
