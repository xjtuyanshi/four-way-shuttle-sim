import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
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
      '-NullRHI',
      '-Unattended',
      '-NoSound',
      '-NoSplash',
      '-NoAssetRegistryCache',
      '-stdout',
      '-FullStdOutLogOutput'
    ]);
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

  await run(unrealEditor, [
    projectPath,
    '-run=ShuttleVisualTwinSmoke',
    '-NullRHI',
    '-Unattended',
    '-NoSound',
    '-NoSplash',
    '-NoAssetRegistryCache',
    '-stdout',
    '-FullStdOutLogOutput'
  ]);

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
