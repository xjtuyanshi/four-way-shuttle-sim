import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const ueRoot = process.env.UE_5_7_ROOT ?? '/Users/Shared/Epic Games/UE_5.7';
const templateDir = path.join(ueRoot, 'Templates', 'TP_Blank');
const outputDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'output', 'unreal', 'ShuttleVisualTwin'));
const projectName = 'ShuttleVisualTwin';
const templateName = 'TP_Blank';

async function assertPath(label, targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

async function replaceTextInTree(rootDir, replacements) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await replaceTextInTree(entryPath, replacements);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!['.cs', '.cpp', '.h', '.ini', '.uproject'].includes(extension)) continue;
    let content = await readFile(entryPath, 'utf8');
    for (const [from, to] of replacements) {
      content = content.replaceAll(from, to);
    }
    await writeFile(entryPath, content);
  }
}

async function renameProjectFiles(projectDir) {
  const sourceDir = path.join(projectDir, 'Source');
  await rename(path.join(projectDir, `${templateName}.uproject`), path.join(projectDir, `${projectName}.uproject`));
  await rename(path.join(sourceDir, `${templateName}.Target.cs`), path.join(sourceDir, `${projectName}.Target.cs`));
  await rename(path.join(sourceDir, `${templateName}Editor.Target.cs`), path.join(sourceDir, `${projectName}Editor.Target.cs`));
  await rename(path.join(sourceDir, templateName), path.join(sourceDir, projectName));
  await rename(
    path.join(sourceDir, projectName, `${templateName}.Build.cs`),
    path.join(sourceDir, projectName, `${projectName}.Build.cs`)
  );
  await rename(path.join(sourceDir, projectName, `${templateName}.cpp`), path.join(sourceDir, projectName, `${projectName}.cpp`));
  await rename(path.join(sourceDir, projectName, `${templateName}.h`), path.join(sourceDir, projectName, `${projectName}.h`));
}

async function updateProjectDescriptor(projectPath) {
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.EngineAssociation = '5.7';
  project.Category = 'Simulation';
  project.Description = 'Generated four-way shuttle Unreal visual twin project.';
  project.Plugins = [
    ...(project.Plugins ?? []).filter((plugin) => !['ShuttlePhase0Bridge', 'PixelStreaming'].includes(plugin.Name)),
    { Name: 'ShuttlePhase0Bridge', Enabled: true },
    { Name: 'PixelStreaming', Enabled: true }
  ];
  await writeFile(projectPath, `${JSON.stringify(project, null, '\t')}\n`);
}

async function main() {
  await assertPath('UE 5.7 root', ueRoot);
  await assertPath('UE TP_Blank template', templateDir);
  await assertPath('Shuttle bridge source', path.join(repoRoot, 'unreal-bridge', 'ShuttlePhase0Bridge.uplugin'));

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.dirname(outputDir), { recursive: true });
  await cp(templateDir, outputDir, { recursive: true });

  await renameProjectFiles(outputDir);
  await replaceTextInTree(outputDir, [[templateName, projectName]]);

  const pluginOutputDir = path.join(outputDir, 'Plugins', 'ShuttlePhase0Bridge');
  await mkdir(path.dirname(pluginOutputDir), { recursive: true });
  await cp(path.join(repoRoot, 'unreal-bridge'), pluginOutputDir, { recursive: true });

  const projectPath = path.join(outputDir, `${projectName}.uproject`);
  await updateProjectDescriptor(projectPath);

  const summary = {
    project: projectPath,
    plugin: path.join(pluginOutputDir, 'ShuttlePhase0Bridge.uplugin'),
    unrealEditor: path.join(ueRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor')
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
