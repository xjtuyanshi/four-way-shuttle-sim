import { createInboundMvpBaselineScenario } from '../packages/shuttle-sim-core/src/index.ts';

const API_BASE = process.env.SHUTTLE_API_BASE ?? 'http://localhost:8791/api/shuttle';

const scenario = createInboundMvpBaselineScenario();

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
