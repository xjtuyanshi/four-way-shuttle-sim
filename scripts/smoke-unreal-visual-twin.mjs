import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
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
    'Source/ShuttlePhase0Bridge/Private/ShuttleStateSubscriberSubsystem.cpp',
    'Source/ShuttlePhase0Bridge/Private/ShuttleVisualTwinActor.cpp'
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
    '-run=CompileAllBlueprints',
    '-NullRHI',
    '-Unattended',
    '-NoSound',
    '-NoSplash',
    '-NoAssetRegistryCache',
    '-stdout',
    '-FullStdOutLogOutput'
  ]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
