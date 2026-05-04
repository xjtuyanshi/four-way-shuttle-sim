import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const ueRoot = process.env.UE_5_7_ROOT ?? '/Users/Shared/Epic Games/UE_5.7';
const projectPath = path.resolve(
  process.env.SHUTTLE_UNREAL_PROJECT ?? path.join(repoRoot, 'output', 'unreal', 'ShuttleVisualTwin', 'ShuttleVisualTwin.uproject')
);
const requireInfra = process.argv.includes('--require-infra');

function isExecutable(targetPath) {
  if (!existsSync(targetPath)) {
    return false;
  }
  try {
    accessSync(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readProjectPlugins() {
  if (!existsSync(projectPath)) {
    return [];
  }
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  return (project.Plugins ?? [])
    .filter((plugin) => plugin.Enabled)
    .map((plugin) => plugin.Name)
    .sort();
}

function inspectPlugin(pluginName) {
  const pluginRoot = path.join(ueRoot, 'Engine', 'Plugins', 'Media', pluginName);
  const webServersRoot = path.join(pluginRoot, 'Resources', 'WebServers');
  const downloader = path.join(webServersRoot, 'get_ps_servers.sh');
  const entries = existsSync(webServersRoot) ? readdirSync(webServersRoot).sort() : [];
  const installedServerDirs = entries.filter((entry) =>
    ['Frontend', 'Matchmaker', 'SFU', 'SignallingWebServer', 'SignallingWebserver'].includes(entry)
  );
  const signallingWebServerDir = ['SignallingWebServer', 'SignallingWebserver']
    .map((entry) => path.join(webServersRoot, entry))
    .find((candidate) => existsSync(candidate)) ?? null;

  return {
    pluginName,
    pluginRoot,
    exists: existsSync(pluginRoot),
    webServersRoot,
    downloader,
    downloaderExists: existsSync(downloader),
    downloaderExecutable: isExecutable(downloader),
    installedServerDirs,
    signallingWebServerDir,
    infrastructureInstalled: installedServerDirs.includes('SignallingWebServer') || installedServerDirs.includes('SignallingWebserver')
  };
}

const plugins = [inspectPlugin('PixelStreaming'), inspectPlugin('PixelStreaming2')];
const enabledPlugins = readProjectPlugins();
const selectedPlugin = plugins.find((plugin) => enabledPlugins.includes(plugin.pluginName)) ?? plugins[0];
const infrastructurePlugin = selectedPlugin.infrastructureInstalled
  ? selectedPlugin
  : plugins.find((plugin) => plugin.infrastructureInstalled) ?? selectedPlugin;
const infrastructureCompatible =
  selectedPlugin.infrastructureInstalled ||
  (selectedPlugin.pluginName === 'PixelStreaming2' && infrastructurePlugin.infrastructureInstalled);
const unrealEditor = path.join(ueRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor');

const summary = {
  checkedAt: new Date().toISOString(),
  ueRoot,
  unrealEditor,
  unrealEditorExecutable: isExecutable(unrealEditor),
  projectPath,
  projectExists: existsSync(projectPath),
  enabledPlugins,
  selectedPixelStreamingPlugin: selectedPlugin.pluginName,
  selectedInfrastructurePlugin: infrastructurePlugin.pluginName,
  signallingWebServerDir: infrastructurePlugin.signallingWebServerDir,
  plugins,
  status: infrastructureCompatible
    ? selectedPlugin.pluginName === infrastructurePlugin.pluginName
      ? 'ready'
      : 'ready-with-shared-pixel-streaming-infrastructure'
    : 'needs-pixel-streaming-infrastructure',
  nextCommand: infrastructureCompatible ? null : `"${selectedPlugin.downloader}" -v 5.7`,
  note: infrastructureCompatible
    ? 'This check does not download or run Pixel Streaming infrastructure.'
    : 'This check does not download or run Pixel Streaming infrastructure. Run the nextCommand only after explicit confirmation.'
};

console.log(JSON.stringify(summary, null, 2));

if (requireInfra && !infrastructureCompatible) {
  process.exitCode = 1;
}
