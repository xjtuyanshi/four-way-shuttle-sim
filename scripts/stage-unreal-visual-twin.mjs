import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const ueRoot = process.env.UE_5_7_ROOT ?? '/Users/Shared/Epic Games/UE_5.7';
const projectPath = path.resolve(
  process.env.SHUTTLE_UNREAL_PROJECT ?? path.join(repoRoot, 'output', 'unreal', 'ShuttleVisualTwin', 'ShuttleVisualTwin.uproject')
);
const runUat = path.join(ueRoot, 'Engine', 'Build', 'BatchFiles', 'RunUAT.command');
const stagedApp = path.join(
  path.dirname(projectPath),
  'Saved',
  'StagedBuilds',
  'Mac',
  'ShuttleVisualTwin.app'
);
const stagedExecutable = path.join(stagedApp, 'Contents', 'MacOS', 'ShuttleVisualTwin');

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

function assertXcodeReady() {
  const result = spawnSync('xcodebuild', ['-checkFirstLaunchStatus'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error([
      'Xcode first-launch status is not ready.',
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join('\n'));
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
  assertExecutable('UE RunUAT', runUat);
  assertPath('Generated Unreal project', projectPath);
  assertXcodeReady();

  await run(runUat, [
    'BuildCookRun',
    `-project=${projectPath}`,
    '-noP4',
    '-platform=Mac',
    '-clientconfig=Development',
    '-build',
    '-cook',
    '-stage',
    '-skippackage',
    '-pak',
    '-unattended',
    '-utf8output'
  ]);

  assertExecutable('Staged ShuttleVisualTwin app', stagedExecutable);
  console.log(JSON.stringify({
    unrealStage: {
      ok: true,
      projectPath,
      stagedApp,
      stagedExecutable
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
