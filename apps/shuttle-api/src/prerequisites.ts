import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ShuttlePrerequisiteReport = {
  checkedAt: string;
  host: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    totalMemoryGb: number;
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
    engineRoot: string | null;
    engineVersion: string | null;
    editorExecutable: string | null;
    buildScript: string | null;
    runUatScript: string | null;
    templatesReady: boolean;
    pixelStreaming2HeadersReady: boolean;
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
  windowsToolchain: {
    status: 'ready' | 'blocked' | 'not-applicable';
    visualStudioInstallPath: string | null;
    clPath: string | null;
    msbuildPath: string | null;
    cmakePath: string | null;
    windowsSdkIncludeDirs: string[];
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

function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function firstToolPath(text: string): string | null {
  const line = firstLine(text);
  if (!line || /could not find|enoent|not recognized|INFO:/i.test(line)) return null;
  return line;
}

function pathIfExists(candidate: string): string | null {
  return existsSync(candidate) ? candidate : null;
}

function readEngineVersion(engineRoot: string | null): string | null {
  if (!engineRoot) return null;
  const buildVersionPath = path.join(engineRoot, 'Engine', 'Build', 'Build.version');
  if (!existsSync(buildVersionPath)) return null;
  try {
    const version = JSON.parse(readFileSync(buildVersionPath, 'utf8')) as {
      MajorVersion?: number;
      MinorVersion?: number;
      PatchVersion?: number;
      Changelist?: number;
    };
    const semantic = [version.MajorVersion, version.MinorVersion, version.PatchVersion]
      .filter((value) => typeof value === 'number')
      .join('.');
    return version.Changelist ? `${semantic}+${version.Changelist}` : semantic || null;
  } catch {
    return null;
  }
}

function windowsUnrealCandidates(): string[] {
  const roots = [
    process.env.UE_5_7_ROOT,
    'C:\\Program Files\\Epic Games',
    'C:\\Program Files (x86)\\Epic Games',
    'D:\\Epic Games',
    'E:\\Epic Games'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const candidates = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (/UE_5/i.test(path.basename(root))) {
      candidates.add(root);
      continue;
    }
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^UE_5/i.test(entry.name)) {
          candidates.add(path.join(root, entry.name));
        }
      }
    } catch {
      // Ignore unreadable candidate roots.
    }
  }
  return [...candidates].sort();
}

function inspectUnrealInstall(platform: NodeJS.Platform): ShuttlePrerequisiteReport['unreal'] {
  const macCandidates: string[] = [];
  if (platform === 'darwin') {
    return {
      installedCandidates: macCandidates,
      preferredVersion: '5.7.4',
      status: 'blocked',
      engineRoot: null,
      engineVersion: null,
      editorExecutable: null,
      buildScript: null,
      runUatScript: null,
      templatesReady: false,
      pixelStreaming2HeadersReady: false,
      notes: ['Mac Unreal discovery is handled by the platform-specific collector below.']
    };
  }

  const installedCandidates = platform === 'win32' ? windowsUnrealCandidates() : [];
  const engineRoot = process.env.UE_5_7_ROOT && existsSync(process.env.UE_5_7_ROOT)
    ? process.env.UE_5_7_ROOT
    : installedCandidates.find((candidate) => /UE_5\.7/i.test(candidate)) ?? installedCandidates[0] ?? null;
  const editorExecutable = engineRoot
    ? pathIfExists(path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'))
    : null;
  const buildScript = engineRoot
    ? pathIfExists(path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat'))
    : null;
  const runUatScript = engineRoot
    ? pathIfExists(path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat'))
    : null;
  const templatesReady = engineRoot
    ? existsSync(path.join(engineRoot, 'Templates', 'TP_Blank'))
    : false;
  const pixelStreaming2HeadersReady = engineRoot
    ? [
      path.join(engineRoot, 'Engine', 'Plugins', 'Media', 'PixelStreaming2', 'Source', 'PixelStreaming2', 'Public', 'IPixelStreaming2Module.h'),
      path.join(engineRoot, 'Engine', 'Plugins', 'Media', 'PixelStreaming2', 'Source', 'PixelStreaming2Core', 'Public', 'IPixelStreaming2Streamer.h'),
      path.join(engineRoot, 'Engine', 'Plugins', 'Media', 'PixelStreaming2', 'Source', 'PixelStreaming2', 'Internal', 'VideoProducerRenderTarget.h'),
      path.join(engineRoot, 'Engine', 'Plugins', 'Media', 'PixelStreaming2', 'Source', 'PixelStreaming2', 'Internal', 'VideoProducerMediaCapture.h')
    ].every((candidate) => existsSync(candidate))
    : false;
  const status = editorExecutable && buildScript && runUatScript && templatesReady ? 'ready' : 'blocked';
  const notes = status === 'ready'
    ? ['Windows Unreal editor, build scripts, and TP_Blank template are present. Verify VS/SDK readiness separately before compiling C++ plugins.']
    : [
      engineRoot
        ? 'A Windows Unreal candidate was found, but one or more required editor/build/template paths are missing.'
        : 'No Windows Unreal Engine 5.x installation was found through UE_5_7_ROOT or common Epic Games directories.',
      'Unreal visualization checks remain separate from SimCore/API IE validation.'
    ];

  return {
    installedCandidates,
    preferredVersion: '5.7.4',
    status,
    engineRoot,
    engineVersion: readEngineVersion(engineRoot),
    editorExecutable,
    buildScript,
    runUatScript,
    templatesReady,
    pixelStreaming2HeadersReady,
    notes
  };
}

function windowsSdkIncludeDirs(): string[] {
  const includeRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\Include';
  if (!existsSync(includeRoot)) return [];
  try {
    return readdirSync(includeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(includeRoot, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function collectWindowsToolchain(): Promise<ShuttlePrerequisiteReport['windowsToolchain']> {
  if (process.platform !== 'win32') {
    return {
      status: 'not-applicable',
      visualStudioInstallPath: null,
      clPath: null,
      msbuildPath: null,
      cmakePath: null,
      windowsSdkIncludeDirs: [],
      notes: ['Windows MSVC/SDK readiness is not applicable on this platform.']
    };
  }

  const vswherePath = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  const visualStudioInstallPath = existsSync(vswherePath)
    ? firstLine(await commandOutput(vswherePath, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath'
    ]))
    : null;
  const clPath = firstToolPath(await commandOutput('where', ['cl']));
  const msbuildPath = firstToolPath(await commandOutput('where', ['msbuild']));
  const cmakePath = firstToolPath(await commandOutput('where', ['cmake']));
  const sdkDirs = windowsSdkIncludeDirs();
  const status = visualStudioInstallPath && clPath && msbuildPath && sdkDirs.length > 0 ? 'ready' : 'blocked';

  return {
    status,
    visualStudioInstallPath,
    clPath,
    msbuildPath,
    cmakePath,
    windowsSdkIncludeDirs: sdkDirs,
    notes: status === 'ready'
      ? ['Visual Studio C++ tools and Windows SDK include directories are visible to this shell.']
      : ['Visual Studio C++ tools and/or Windows SDK are not visible. Install the Desktop development with C++ workload before Unreal C++ bridge builds.']
  };
}

async function collectMacPrerequisites(): Promise<Pick<ShuttlePrerequisiteReport, 'host' | 'unreal' | 'xcode' | 'pixelStreaming'>> {
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
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
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
      engineRoot: installedCandidates.find((candidate) => /\/UE_5\.7(?:\/)?$/i.test(candidate)) ?? null,
      engineVersion: null,
      editorExecutable: installedCandidates.find((candidate) => /UnrealEditor\.app\/Contents\/MacOS\/UnrealEditor$/i.test(candidate)) ?? null,
      buildScript: null,
      runUatScript: null,
      templatesReady: installedCandidates.some((candidate) => /\/UE_5\.7(?:\/)?$/i.test(candidate)),
      pixelStreaming2HeadersReady: false,
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

export async function collectPrerequisites(): Promise<ShuttlePrerequisiteReport> {
  if (process.platform === 'darwin') {
    const mac = await collectMacPrerequisites();
    return {
      checkedAt: new Date().toISOString(),
      ...mac,
      windowsToolchain: await collectWindowsToolchain()
    };
  }

  const unreal = inspectUnrealInstall(process.platform);
  const windowsToolchain = await collectWindowsToolchain();
  return {
    checkedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      modelName: null,
      modelIdentifier: null,
      chip: os.cpus()[0]?.model ?? null,
      memory: `${Math.round((os.totalmem() / 1024 ** 3) * 10) / 10} GB`,
      metalSupport: null,
      macos: null
    },
    unreal,
    xcode: {
      developerDir: null,
      version: null,
      status: 'blocked',
      notes: ['Xcode is not applicable on Windows; Unreal Windows builds use Visual Studio C++ tools and Windows SDK.']
    },
    pixelStreaming: {
      status: unreal.status === 'ready' && windowsToolchain.status === 'ready' && unreal.pixelStreaming2HeadersReady ? 'ready' : 'pending-unreal',
      notes: [
        'Pixel Streaming browser validation requires a UE runtime path such as UnrealEditor -game or a staged app with PixelStreaming2 enabled.',
        'The API/dashboard protocol can be validated independently before Unreal is installed.',
        unreal.pixelStreaming2HeadersReady
          ? 'PixelStreaming2 public/internal capture headers were found.'
          : 'PixelStreaming2 public/internal capture headers were not found; keep this out of IE acceptance until UE readiness is green.'
      ]
    },
    windowsToolchain
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await collectPrerequisites(), null, 2));
}
