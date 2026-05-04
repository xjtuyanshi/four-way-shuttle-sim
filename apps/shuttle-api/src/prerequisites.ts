import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ShuttlePrerequisiteReport = {
  checkedAt: string;
  host: {
    modelName: string | null;
    modelIdentifier: string | null;
    chip: string | null;
    memory: string | null;
    metalSupport: string | null;
    macos: string | null;
  };
  unreal: {
    installedCandidates: string[];
    preferredVersion: '5.7.4';
    status: 'ready' | 'blocked';
    notes: string[];
  };
  xcode: {
    developerDir: string | null;
    version: string | null;
    status: 'ready' | 'blocked';
    notes: string[];
  };
  pixelStreaming: {
    status: 'pending-unreal' | 'ready';
    notes: string[];
  };
};

async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 10000 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const failed = error as { stdout?: string; stderr?: string; message?: string };
      return `${failed.stdout ?? ''}${failed.stderr ?? ''}${failed.message ?? ''}`.trim();
    }
    return String(error);
  }
}

function extractLineValue(text: string, label: string): string | null {
  const line = text.split('\n').find((candidate) => candidate.trim().startsWith(`${label}:`));
  return line ? line.split(':').slice(1).join(':').trim() : null;
}

export async function collectPrerequisites(): Promise<ShuttlePrerequisiteReport> {
  const [hardware, displays, swVers, xcodeSelect, xcodeBuild, applications] = await Promise.all([
    commandOutput('system_profiler', ['SPHardwareDataType']),
    commandOutput('system_profiler', ['SPDisplaysDataType']),
    commandOutput('sw_vers', []),
    commandOutput('xcode-select', ['-p']),
    commandOutput('xcodebuild', ['-version']),
    commandOutput('sh', [
      '-lc',
      "find /Applications -maxdepth 2 \\( -name 'Epic Games Launcher.app' -o -name 'Xcode.app' -o -name 'Unreal*.app' \\) -print 2>/dev/null; find '/Users/Shared/Epic Games' -maxdepth 5 \\( -name 'UE_5*' -o -name 'UnrealEditor.app' \\) -print 2>/dev/null; for editor in '/Users/Shared/Epic Games'/UE_5*/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor; do [ -x \"$editor\" ] && printf '%s\\n' \"$editor\"; done; true"
    ])
  ]);

  const installedCandidates = applications.split('\n').filter(Boolean).sort();
  const hasEpicLauncher = installedCandidates.some((candidate) => /Epic Games Launcher\.app/i.test(candidate));
  const hasUnrealInstallDir = installedCandidates.some((candidate) => /\/UE_5\.7(?:\/)?$/i.test(candidate));
  const hasUnrealEditorExecutable = installedCandidates.some((candidate) => /UnrealEditor\.app\/Contents\/MacOS\/UnrealEditor$/i.test(candidate));
  const hasFullXcode = /^Xcode\s+\d+/m.test(xcodeBuild);
  const activeDeveloperDir = xcodeSelect.includes('xcode-select: error') ? null : xcodeSelect.split('\n')[0] ?? null;

  return {
    checkedAt: new Date().toISOString(),
    host: {
      modelName: extractLineValue(hardware, 'Model Name'),
      modelIdentifier: extractLineValue(hardware, 'Model Identifier'),
      chip: extractLineValue(hardware, 'Chip'),
      memory: extractLineValue(hardware, 'Memory'),
      metalSupport: extractLineValue(displays, 'Metal Support'),
      macos: extractLineValue(swVers, 'ProductVersion')
    },
    unreal: {
      installedCandidates,
      preferredVersion: '5.7.4',
      status: hasUnrealEditorExecutable ? 'ready' : 'blocked',
      notes: hasUnrealEditorExecutable
        ? ['UnrealEditor executable found under a UE 5.7 installation candidate. Verify the exact patch version before Pixel Streaming validation.']
        : hasUnrealInstallDir
          ? ['Unreal Engine 5.7 install directory exists, but UnrealEditor is not executable yet. Installation may still be in progress.']
          : hasEpicLauncher
          ? ['Epic Games Launcher is installed, but Unreal Engine 5.7 is not installed yet. Use the launcher to install UE 5.7.4 or the closest available 5.7 patch.']
          : ['No Unreal Engine 5.7 installation or Epic Games Launcher application was found during this check.']
    },
    xcode: {
      developerDir: activeDeveloperDir,
      version: hasFullXcode ? xcodeBuild.split('\n')[0] ?? null : null,
      status: hasFullXcode ? 'ready' : 'blocked',
      notes: hasFullXcode
        ? ['Full Xcode toolchain is available.']
        : ['xcodebuild did not report a full Xcode installation; the active developer directory appears to be Command Line Tools only.']
    },
    pixelStreaming: {
      status: hasUnrealEditorExecutable && hasFullXcode ? 'ready' : 'pending-unreal',
      notes: [
        'Pixel Streaming browser validation requires a UE runtime path such as UnrealEditor -game or a staged app with PixelStreaming2 enabled.',
        'The API/dashboard protocol can be validated independently before Unreal is installed.'
      ]
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await collectPrerequisites(), null, 2));
}
