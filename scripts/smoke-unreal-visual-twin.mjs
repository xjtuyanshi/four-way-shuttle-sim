import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

function assertPath(label, targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
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
  assertPath('UE 5.7 editor', unrealEditor);
  assertPath('Generated Unreal project', projectPath);

  await run(buildScript, [
    targetName,
    'Mac',
    'Development',
    `-Project=${projectPath}`,
    '-WaitMutex'
  ]);

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
