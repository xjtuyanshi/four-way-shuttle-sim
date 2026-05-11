import { createDefaultShuttleScenario } from '../packages/shuttle-sim-core/src/index.ts';

const API_BASE = process.env.SHUTTLE_API_BASE ?? 'http://localhost:8791/api/shuttle';

const scenario = createDefaultShuttleScenario({
  id: 'shuttle-all-inbound-8x-7200',
  name: 'All Inbound 8 Shuttle 7200 PPH Stress',
  liftMode: 'all-inbound',
  durationSec: 7200,
  vehicles: {
    count: 8,
    emptySpeedMps: 2,
    loadedSpeedMps: 1.5,
    accelerationMps2: 1.2,
    liftTimeSec: 0.01,
    lowerTimeSec: 0.01,
  },
  physicsParams: {
    emptySpeedMps: 2,
    loadedSpeedMps: 1.5,
    accelerationMps2: 1.2,
    liftTimeSec: 0.01,
    lowerTimeSec: 0.01,
  },
  taskGeneration: {
    inboundRatePerHour: 7200,
    outboundRatePerHour: 0,
    inboundOutboundMix: 1,
    arrivalDistribution: 'deterministic',
    maxTasks: 16,
  },
  trafficPolicy: {
    controllerMode: 'agent-simple',
    liftApproachCapacity: 8,
    minimumClearanceSec: 0.4,
    deadlockDetectSec: 20,
  },
});

async function postJson(path: string, body?: unknown) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response;
}

await postJson('/loadScenario', scenario);
await postJson('/playbackSpeed', { speed: 1 });
await postJson('/resume');

const state = await (await fetch(`${API_BASE}/state`)).json();
console.log(JSON.stringify({
  scenarioId: state.scenarioId,
  status: state.status,
  simTimeSec: state.simTimeSec,
  vehicleCount: state.vehicles?.length,
  inboundRatePerHour: scenario.taskGeneration.inboundRatePerHour,
  outboundRatePerHour: scenario.taskGeneration.outboundRatePerHour,
  maxTasks: scenario.taskGeneration.maxTasks,
}, null, 2));
