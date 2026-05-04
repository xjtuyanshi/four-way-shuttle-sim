import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const ueRoot = process.env.UE_5_7_ROOT ?? '/Users/Shared/Epic Games/UE_5.7';
const projectPath = path.resolve(
  process.env.SHUTTLE_UNREAL_PROJECT ?? path.join(repoRoot, 'output', 'unreal', 'ShuttleVisualTwin', 'ShuttleVisualTwin.uproject')
);
const buildOnly = process.argv.includes('--build-only');
const targetName = 'ShuttleVisualTwinEditor';
const buildScript = path.join(ueRoot, 'Engine', 'Build', 'BatchFiles', 'Mac', 'Build.sh');
const unrealEditor = path.join(ueRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor');
const projectDir = path.dirname(projectPath);
const bridgePluginDir = path.join(projectDir, 'Plugins', 'ShuttlePhase0Bridge');
const bridgePluginDescriptor = path.join(bridgePluginDir, 'ShuttlePhase0Bridge.uplugin');
const bridgeBinary = path.join(bridgePluginDir, 'Binaries', 'Mac', 'UnrealEditor-ShuttlePhase0Bridge.dylib');

function assertPath(label, targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function assertExecutable(label, targetPath) {
  assertPath(label, targetPath);
  try {
    accessSync(targetPath, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${targetPath}`);
  }
}

function readJson(label, targetPath) {
  assertPath(label, targetPath);
  return JSON.parse(readFileSync(targetPath, 'utf8'));
}

function readSimCoreStaticSceneContract() {
  const child = spawnSync('pnpm', ['exec', 'tsx', 'scripts/print-default-static-scene-contract.ts'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(`Could not read SimCore static scene contract.\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

function assertExactFieldParity(field, unrealSummary, simCoreContract) {
  if (unrealSummary[field] !== simCoreContract[field]) {
    throw new Error(`Unreal static scene ${field}=${JSON.stringify(unrealSummary[field])} does not match SimCore default ${field}=${JSON.stringify(simCoreContract[field])}.`);
  }
}

function assertCloseFieldParity(field, unrealSummary, simCoreContract, tolerance = 0.001) {
  const observed = Number(unrealSummary[field]);
  const expected = Number(simCoreContract[field]);
  if (!Number.isFinite(observed) || !Number.isFinite(expected) || Math.abs(observed - expected) > tolerance) {
    throw new Error(`Unreal static scene ${field}=${JSON.stringify(unrealSummary[field])} does not match SimCore default ${field}=${JSON.stringify(simCoreContract[field])} within ${tolerance}.`);
  }
}

function sortedItemsById(items) {
  return [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function assertStaticSceneElementArrayParity(arrayField, exactFields, numericFields, unrealSummary, simCoreContract, tolerance = 0.001) {
  const unrealItems = unrealSummary[arrayField];
  const simCoreItems = simCoreContract[arrayField];
  if (!Array.isArray(unrealItems) || !Array.isArray(simCoreItems)) {
    throw new Error(`Static scene ${arrayField} must be present on both Unreal and SimCore contracts.`);
  }
  if (unrealItems.length !== simCoreItems.length) {
    throw new Error(`Static scene ${arrayField} length mismatch: Unreal=${unrealItems.length} SimCore=${simCoreItems.length}.`);
  }

  const sortedUnrealItems = sortedItemsById(unrealItems);
  const sortedSimCoreItems = sortedItemsById(simCoreItems);
  for (let index = 0; index < sortedSimCoreItems.length; index += 1) {
    const unrealItem = sortedUnrealItems[index];
    const simCoreItem = sortedSimCoreItems[index];
    if (unrealItem.id !== simCoreItem.id) {
      throw new Error(`Static scene ${arrayField}[${index}] id mismatch: Unreal=${JSON.stringify(unrealItem.id)} SimCore=${JSON.stringify(simCoreItem.id)}.`);
    }
    for (const field of exactFields) {
      if (unrealItem[field] !== simCoreItem[field]) {
        throw new Error(`Static scene ${arrayField}.${unrealItem.id}.${field}=${JSON.stringify(unrealItem[field])} does not match SimCore ${JSON.stringify(simCoreItem[field])}.`);
      }
    }
    for (const field of numericFields) {
      const observed = Number(unrealItem[field]);
      const expected = Number(simCoreItem[field]);
      if (!Number.isFinite(observed) || !Number.isFinite(expected) || Math.abs(observed - expected) > tolerance) {
        throw new Error(`Static scene ${arrayField}.${unrealItem.id}.${field}=${JSON.stringify(unrealItem[field])} does not match SimCore ${JSON.stringify(simCoreItem[field])} within ${tolerance}.`);
      }
    }
  }
}

function assertStaticSceneParityWithSimCore(unrealSummary, simCoreContract) {
  for (const field of [
    'storageRows',
    'storageColumns',
    'storageCellCount',
    'trackBedCount',
    'storageLaneTrackCount',
    'sideAisleTrackCount',
    'crossAisleTrackCount',
    'inboundConnectorTrackCount',
    'outboundConnectorTrackCount',
    'parkingConnectorTrackCount',
    'diagonalTrackCount',
    'inboundLiftPadCount',
    'outboundLiftPadCount',
    'parkingPadCount',
    'singleLevel',
    'storageIslandCount',
    'denseStorageIslands',
    'denseStorageBlock',
    'orthogonalTrackOnly',
    'dedicatedLiftPorts',
    'inboundSide',
    'outboundSide'
  ]) {
    assertExactFieldParity(field, unrealSummary, simCoreContract);
  }

  for (const field of [
    'storagePitchXM',
    'storagePitchZM',
    'storageBlockMinXM',
    'storageBlockMaxXM',
    'storageBlockMinZM',
    'storageBlockMaxZM',
    'inboundLiftXM',
    'outboundLiftXM'
  ]) {
    assertCloseFieldParity(field, unrealSummary, simCoreContract);
  }

  assertStaticSceneElementArrayParity(
    'storageCells',
    ['id', 'row', 'column'],
    ['xM', 'yM', 'zM', 'lengthXM', 'lengthZM'],
    unrealSummary,
    simCoreContract
  );
  assertStaticSceneElementArrayParity(
    'trackBeds',
    ['id', 'category', 'orientation', 'row', 'side'],
    ['xM', 'yM', 'zM', 'lengthXM', 'lengthZM'],
    unrealSummary,
    simCoreContract
  );
  assertStaticSceneElementArrayParity(
    'liftPads',
    ['id', 'category', 'side'],
    ['xM', 'yM', 'zM', 'lengthXM', 'lengthZM'],
    unrealSummary,
    simCoreContract
  );
  assertStaticSceneElementArrayParity(
    'parkingPads',
    ['id', 'category', 'side'],
    ['xM', 'yM', 'zM', 'lengthXM', 'lengthZM'],
    unrealSummary,
    simCoreContract
  );
}

function assertPluginEnabled(project, pluginName) {
  const plugin = project.Plugins?.find((candidate) => candidate.Name === pluginName);
  if (!plugin?.Enabled) {
    throw new Error(`Generated Unreal project must enable ${pluginName}.`);
  }
}

function assertBridgeSourcePresent() {
  const requiredFiles = [
    'Source/ShuttlePhase0Bridge/ShuttlePhase0Bridge.Build.cs',
    'Source/ShuttlePhase0Bridge/Public/ShuttleStateSubscriberSubsystem.h',
    'Source/ShuttlePhase0Bridge/Public/ShuttleVisualTwinActor.h',
    'Source/ShuttlePhase0Bridge/Public/ShuttleVisualTwinLiveSmokeCommandlet.h',
    'Source/ShuttlePhase0Bridge/Public/ShuttleVisualTwinRuntimeActor.h',
    'Source/ShuttlePhase0Bridge/Public/ShuttleVisualTwinSmokeCommandlet.h',
    'Source/ShuttlePhase0Bridge/Private/ShuttleStateSubscriberSubsystem.cpp',
    'Source/ShuttlePhase0Bridge/Private/ShuttleVisualTwinActor.cpp',
    'Source/ShuttlePhase0Bridge/Private/ShuttleVisualTwinLiveSmokeCommandlet.cpp',
    'Source/ShuttlePhase0Bridge/Private/ShuttleVisualTwinRuntimeActor.cpp',
    'Source/ShuttlePhase0Bridge/Private/ShuttleVisualTwinSmokeCommandlet.cpp'
  ];
  for (const relativePath of requiredFiles) {
    assertPath('Copied Shuttle bridge source', path.join(bridgePluginDir, relativePath));
  }
  return requiredFiles;
}

function inspectGeneratedProject() {
  const project = readJson('Generated Unreal project', projectPath);
  const plugin = readJson('Generated Shuttle bridge plugin', bridgePluginDescriptor);
  assertPluginEnabled(project, 'ShuttlePhase0Bridge');
  assertPluginEnabled(project, 'PixelStreaming');
  const bridgeSourceFiles = assertBridgeSourcePresent();
  return {
    project: projectPath,
    engineAssociation: project.EngineAssociation,
    targetName,
    enabledPlugins: (project.Plugins ?? []).filter((candidate) =>
      ['ShuttlePhase0Bridge', 'PixelStreaming'].includes(candidate.Name)
    ).map((candidate) => candidate.Name),
    bridgePlugin: {
      descriptor: bridgePluginDescriptor,
      versionName: plugin.VersionName ?? null,
      sourceFilesChecked: bridgeSourceFiles
    }
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log([command, ...args].join(' '));
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
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
          reject(new Error('Could not allocate a local Unreal live-smoke API port.'));
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

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/shuttle/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true && body.protocol === 'shuttle.phase0.v0') {
          return;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`API did not become healthy for Unreal live smoke: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

async function runLiveBridgeSmoke() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/shuttle-ws`;
  const summaryPath = path.join('/tmp', `shuttle-live-bridge-smoke-${process.pid}.json`);
  rmSync(summaryPath, { force: true });
  const api = startApi(port);
  try {
    await waitForHealth(baseUrl);
    await postJson(baseUrl, '/api/shuttle/playbackSpeed', { speed: 4 });
    await postJson(baseUrl, '/api/shuttle/reset');
    await postJson(baseUrl, '/api/shuttle/resume');
    await run(unrealEditor, [
      projectPath,
      '-run=ShuttleVisualTwinLiveSmoke',
      `-ShuttleWsUrl=${wsUrl}`,
      '-ShuttleLiveSmokeTimeoutSec=10',
      '-ShuttleExpectedVehicleCount=2',
      '-ShuttleMinSimTimeAdvanceSec=0.1',
      '-ShuttlePoseToleranceCm=0.1',
      `-ShuttleLiveSmokeSummaryPath=${summaryPath}`,
      '-NullRHI',
      '-Unattended',
      '-NoSound',
      '-NoSplash',
      '-NoAssetRegistryCache',
      '-stdout',
      '-FullStdOutLogOutput'
    ]);
    const summary = readJson('Unreal live bridge smoke summary', summaryPath);
    if (summary.pass !== true) {
      throw new Error(`Unreal live bridge smoke summary did not pass: ${JSON.stringify(summary, null, 2)}`);
    }
    if (summary.messageStats?.vehicleState < 1) {
      throw new Error('Unreal live bridge smoke did not observe a root vehicleState stream message.');
    }
    if (summary.ieMetrics?.hasKpi !== true) {
      throw new Error('Unreal live bridge smoke did not parse KPI telemetry from the stream.');
    }
    console.log(JSON.stringify({ unrealLiveBridgeSmoke: summary }, null, 2));
  } catch (error) {
    if (existsSync(summaryPath)) {
      console.error(JSON.stringify({ unrealLiveBridgeSmokeFailureSummary: readJson('Unreal live bridge smoke summary', summaryPath) }, null, 2));
    }
    const apiOutput = api.getOutput();
    if (apiOutput) {
      console.error(apiOutput);
    }
    throw error;
  } finally {
    await stopApi(api.child);
  }
}

async function main() {
  assertPath('UE 5.7 build script', buildScript);
  assertExecutable('UE 5.7 editor', unrealEditor);
  assertPath('Generated Unreal project', projectPath);
  const readiness = inspectGeneratedProject();
  console.log(JSON.stringify({ unrealReadiness: readiness }, null, 2));

  await run(buildScript, [
    targetName,
    'Mac',
    'Development',
    `-Project=${projectPath}`,
    '-WaitMutex'
  ]);
  assertPath('Compiled Shuttle bridge plugin binary', bridgeBinary);

  if (buildOnly) {
    return;
  }

  const staticSceneSummaryPath = path.join('/tmp', `shuttle-static-scene-smoke-${process.pid}.json`);
  rmSync(staticSceneSummaryPath, { force: true });
  try {
    await run(unrealEditor, [
      projectPath,
      '-run=ShuttleVisualTwinSmoke',
      `-ShuttleStaticSceneSummaryPath=${staticSceneSummaryPath}`,
      '-NullRHI',
      '-Unattended',
      '-NoSound',
      '-NoSplash',
      '-NoAssetRegistryCache',
      '-stdout',
      '-FullStdOutLogOutput'
    ]);
  } catch (error) {
    if (existsSync(staticSceneSummaryPath)) {
      console.error(JSON.stringify({ unrealStaticSceneSmokeFailureSummary: readJson('Unreal static scene smoke summary', staticSceneSummaryPath) }, null, 2));
    }
    throw error;
  }
  const staticSceneSummary = readJson('Unreal static scene smoke summary', staticSceneSummaryPath);
  if (staticSceneSummary.pass !== true) {
    throw new Error(`Unreal static scene smoke summary did not pass: ${JSON.stringify(staticSceneSummary, null, 2)}`);
  }
  const simCoreStaticSceneContract = readSimCoreStaticSceneContract();
  if (
    simCoreStaticSceneContract.singleLevel !== true ||
    simCoreStaticSceneContract.storageRows !== 16 ||
    simCoreStaticSceneContract.storageColumns !== 24 ||
    simCoreStaticSceneContract.storageCellCount !== 384 ||
    simCoreStaticSceneContract.storageIslandCount !== 8 ||
    simCoreStaticSceneContract.denseStorageIslands !== true ||
    simCoreStaticSceneContract.denseStorageBlock !== false ||
    simCoreStaticSceneContract.orthogonalTrackOnly !== true ||
    simCoreStaticSceneContract.dedicatedLiftPorts !== true
  ) {
    throw new Error(`SimCore default scene contract is not the expected single-level multi-bank four-way shuttle layout: ${JSON.stringify(simCoreStaticSceneContract, null, 2)}`);
  }
  assertStaticSceneParityWithSimCore(staticSceneSummary, simCoreStaticSceneContract);
  console.log(JSON.stringify({ simCoreStaticSceneContract, unrealStaticSceneSmoke: staticSceneSummary }, null, 2));

  await run(unrealEditor, [
    projectPath,
    '-run=CompileAllBlueprints',
    '-NullRHI',
    '-Unattended',
    '-NoSound',
    '-NoSplash',
    '-NoAssetRegistryCache',
    '-stdout',
    '-FullStdOutLogOutput'
  ]);

  await runLiveBridgeSmoke();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
