import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const requireFromApi = createRequire(path.join(repoRoot, 'apps/shuttle-api/package.json'));
const startupTimeoutMs = 20_000;
const streamTimeoutMs = 6_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error('Could not allocate a local smoke-test port.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/shuttle/health`);
      if (response.ok) {
        const body = await response.json();
        assert(body.ok === true, 'Health endpoint did not report ok=true.');
        assert(body.protocol === 'shuttle.phase0.v0', `Unexpected protocol: ${body.protocol}`);
        return body;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`API did not become healthy in ${deadlineMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function postJson(baseUrl, endpoint, body = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function parseMessage(data) {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  return JSON.parse(text);
}

async function createWebSocket(wsUrl) {
  if (typeof WebSocket === 'function') {
    return new WebSocket(wsUrl);
  }
  const wsModule = await import(requireFromApi.resolve('ws'));
  return new wsModule.WebSocket(wsUrl);
}

function onSocketEvent(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, handler);
    return;
  }
  if (eventName === 'message') {
    socket.on('message', (data) => handler({ data }));
    return;
  }
  socket.on(eventName, handler);
}

function assertFiniteNumber(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number.`);
}

function assertVehicleShape(vehicle, context) {
  assert(vehicle && typeof vehicle === 'object', `${context} vehicle must be an object.`);
  assert(typeof vehicle.id === 'string' && vehicle.id.length > 0, `${context} vehicle missing id.`);
  assert(typeof vehicle.state === 'string' && vehicle.state.length > 0, `${context} vehicle ${vehicle.id} missing state.`);
  assert(typeof vehicle.currentNodeId === 'string' && vehicle.currentNodeId.length > 0, `${context} vehicle ${vehicle.id} missing currentNodeId.`);
  assertFiniteNumber(vehicle.x, `${context} vehicle ${vehicle.id}.x`);
  assertFiniteNumber(vehicle.y, `${context} vehicle ${vehicle.id}.y`);
  assertFiniteNumber(vehicle.z, `${context} vehicle ${vehicle.id}.z`);
  assertFiniteNumber(vehicle.yaw, `${context} vehicle ${vehicle.id}.yaw`);
  assertFiniteNumber(vehicle.speedMps, `${context} vehicle ${vehicle.id}.speedMps`);
  assert(typeof vehicle.loaded === 'boolean', `${context} vehicle ${vehicle.id}.loaded must be boolean.`);
}

function assertStateShape(state, context) {
  assert(state && typeof state === 'object', `${context} state must be an object.`);
  assert(state.schemaVersion === 'shuttle.phase0.state.v0', `${context} state has unexpected schemaVersion.`);
  assertFiniteNumber(state.simTimeSec, `${context} state.simTimeSec`);
  assert(Array.isArray(state.vehicles), `${context} state.vehicles must be an array.`);
  assert(state.vehicles.length > 0, `${context} state.vehicles must not be empty.`);
  for (const vehicle of state.vehicles) {
    assertVehicleShape(vehicle, context);
  }
}

async function collectStream(baseUrl, port) {
  const wsUrl = `ws://127.0.0.1:${port}/shuttle-ws`;
  const socket = await createWebSocket(wsUrl);
  const observed = {
    connectionRecovered: null,
    simState: null,
    vehicleState: null,
    kpiUpdate: null,
    taskEvent: null,
    firstVehicleStateTimeSec: null,
    lastVehicleStateTimeSec: null,
    messageCount: 0
  };

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for live stream coverage from ${wsUrl}.`));
    }, streamTimeoutMs);

    onSocketEvent(socket, 'open', async () => {
      try {
        await postJson(baseUrl, '/api/shuttle/playbackSpeed', { speed: 4 });
        await postJson(baseUrl, '/api/shuttle/resume');
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });

    onSocketEvent(socket, 'message', (event) => {
      try {
        const message = parseMessage(event.data);
        observed.messageCount += 1;

        if (message.type === 'connectionRecovered') {
          assertStateShape(message.state, 'connectionRecovered');
          observed.connectionRecovered = message;
        } else if (message.type === 'simState') {
          assertStateShape(message.state, 'simState');
          observed.simState = message;
        } else if (message.type === 'vehicleState') {
          assert(Array.isArray(message.vehicles), 'vehicleState.vehicles must be an array.');
          assert(message.vehicles.length > 0, 'vehicleState.vehicles must not be empty.');
          assertFiniteNumber(message.simTimeSec, 'vehicleState.simTimeSec');
          for (const vehicle of message.vehicles) {
            assertVehicleShape(vehicle, 'vehicleState');
          }
          observed.vehicleState = message;
          observed.firstVehicleStateTimeSec ??= message.simTimeSec;
          observed.lastVehicleStateTimeSec = message.simTimeSec;
        } else if (message.type === 'kpiUpdate') {
          assert(message.kpis && typeof message.kpis === 'object', 'kpiUpdate.kpis must be an object.');
          assertFiniteNumber(message.simTimeSec, 'kpiUpdate.simTimeSec');
          observed.kpiUpdate = message;
        } else if (message.type === 'taskEvent') {
          assert(Array.isArray(message.events), 'taskEvent.events must be an array.');
          assertFiniteNumber(message.simTimeSec, 'taskEvent.simTimeSec');
          observed.taskEvent = message;
        } else if (message.type === 'error') {
          throw new Error(`API streamed error message: ${message.message}`);
        }

        const hasRequiredCoverage = observed.connectionRecovered && observed.simState && observed.vehicleState && observed.kpiUpdate;
        const timeAdvanced = observed.firstVehicleStateTimeSec !== null &&
          observed.lastVehicleStateTimeSec !== null &&
          observed.lastVehicleStateTimeSec > observed.firstVehicleStateTimeSec;
        if (hasRequiredCoverage && timeAdvanced) {
          clearTimeout(timer);
          resolve(observed);
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });

    onSocketEvent(socket, 'error', () => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to ${wsUrl}.`));
    });
  });

  try {
    return await done;
  } finally {
    socket.close();
  }
}

function startApi(port) {
  const child = spawn('pnpm', ['--filter', 'shuttle-api', 'dev'], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      SHUTTLE_PORT: String(port),
      SHUTTLE_TICK_MS: '50',
      SHUTTLE_SPEED: '4'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      output += `\nAPI process exited with code ${code}.`;
    }
    if (signal) {
      output += `\nAPI process exited with signal ${signal}.`;
    }
  });

  return {
    child,
    getOutput: () => output.trim().split('\n').slice(-40).join('\n')
  };
}

async function stopApi(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3_000).then(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    })
  ]);
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = startApi(port);

  try {
    await waitForHealth(baseUrl, startupTimeoutMs);
    const observed = await collectStream(baseUrl, port);
    const speedResponse = await fetch(`${baseUrl}/api/shuttle/playbackSpeed`).then((response) => response.json());
    assert(speedResponse.speed === 4, `Playback speed smoke expected 4x, got ${speedResponse.speed}.`);
    console.log(JSON.stringify({
      shuttleWsSmoke: {
        ok: true,
        baseUrl,
        messageCount: observed.messageCount,
        sawConnectionRecovered: Boolean(observed.connectionRecovered),
        sawSimState: Boolean(observed.simState),
        sawVehicleState: Boolean(observed.vehicleState),
        sawKpiUpdate: Boolean(observed.kpiUpdate),
        sawTaskEvent: Boolean(observed.taskEvent),
        firstVehicleStateTimeSec: observed.firstVehicleStateTimeSec,
        lastVehicleStateTimeSec: observed.lastVehicleStateTimeSec,
        playbackSpeed: speedResponse.speed
      }
    }, null, 2));
  } catch (error) {
    const apiOutput = api.getOutput();
    if (apiOutput) {
      console.error(apiOutput);
    }
    throw error;
  } finally {
    await stopApi(api.child);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
