import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { accessSync, constants, existsSync } from 'node:fs';
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

async function assertExecutable(label, targetPath) {
  await assertPath(label, targetPath);
  try {
    accessSync(targetPath, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${targetPath}`);
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
    ...(project.Plugins ?? []).filter((plugin) => !['ShuttlePhase0Bridge', 'PixelStreaming', 'PixelStreaming2'].includes(plugin.Name)),
    { Name: 'ShuttlePhase0Bridge', Enabled: true },
    { Name: 'PixelStreaming2', Enabled: true }
  ];
  await writeFile(projectPath, `${JSON.stringify(project, null, '\t')}\n`);
}

async function writeRuntimeBootstrap(projectDir) {
  const moduleDir = path.join(projectDir, 'Source', projectName);
  const buildFilePath = path.join(moduleDir, `${projectName}.Build.cs`);
  let buildFile = await readFile(buildFilePath, 'utf8');
  if (!buildFile.includes('using System.IO;')) {
    buildFile = buildFile.replace('using UnrealBuildTool;\n', 'using UnrealBuildTool;\nusing System.IO;\n');
  }
  if (!buildFile.includes('"ShuttlePhase0Bridge"')) {
    buildFile = buildFile.replace('"EnhancedInput" });', '"EnhancedInput", "ShuttlePhase0Bridge" });');
  }
  if (!buildFile.includes('"PixelStreaming2"')) {
    buildFile = buildFile.replace(
      '"EnhancedInput", "ShuttlePhase0Bridge" });',
      '"EnhancedInput", "ShuttlePhase0Bridge", "PixelStreaming2", "PixelStreaming2Core" });'
    );
  }
  if (!buildFile.includes('PixelStreaming2/Source/PixelStreaming2/Internal')) {
    buildFile = buildFile.replace(
      'PrivateDependencyModuleNames.AddRange(new string[] {  });',
      `PrivateDependencyModuleNames.AddRange(new string[] {  });

\t\tPrivateIncludePaths.AddRange(new string[]
\t\t{
\t\t\tPath.Combine(EngineDirectory, "Plugins/Media/PixelStreaming2/Source/PixelStreaming2/Internal")
\t\t});`
    );
  }
  await writeFile(buildFilePath, buildFile);

  await writeFile(
    path.join(moduleDir, 'ShuttleVisualTwinBootstrapGameMode.h'),
    `#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "ShuttleVisualTwinBootstrapGameMode.generated.h"

class IPixelStreaming2Module;
class IPixelStreaming2VideoProducer;
class ASceneCapture2D;
class UTextureRenderTarget2D;

UCLASS()
class AShuttleVisualTwinBootstrapGameMode : public AGameModeBase
{
    GENERATED_BODY()

protected:
    virtual void BeginPlay() override;

private:
    void ConfigurePixelStreamingVideoProducer();
    void ApplyPixelStreamingVideoProducer(IPixelStreaming2Module& PixelStreaming);
    void ConfigurePixelStreamingRenderTarget(const FVector& CameraLocation, const FRotator& CameraRotation, float OrthoWidth);

    TSharedPtr<IPixelStreaming2VideoProducer> PixelStreamingVideoProducer;

    UPROPERTY()
    TObjectPtr<UTextureRenderTarget2D> PixelStreamingRenderTarget;

    UPROPERTY()
    TObjectPtr<ASceneCapture2D> PixelStreamingSceneCapture;
};
`
  );

  await writeFile(
    path.join(moduleDir, 'ShuttleVisualTwinBootstrapGameMode.cpp'),
    `#include "ShuttleVisualTwinBootstrapGameMode.h"

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/LightComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "IPixelStreaming2Module.h"
#include "IPixelStreaming2Streamer.h"
#include "Kismet/GameplayStatics.h"
#include "Modules/ModuleManager.h"
#include "ShuttleVisualTwinRuntimeActor.h"
#include "VideoProducerMediaCapture.h"
#include "VideoProducerRenderTarget.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinBootstrap, Log, All);

void AShuttleVisualTwinBootstrapGameMode::BeginPlay()
{
    Super::BeginPlay();

    UWorld* World = GetWorld();
    if (!World)
    {
        return;
    }

    FActorSpawnParameters RuntimeSpawnParameters;
    RuntimeSpawnParameters.Name = TEXT("ShuttleVisualTwinRuntime");
    RuntimeSpawnParameters.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    AShuttleVisualTwinRuntimeActor* RuntimeActor = World->SpawnActor<AShuttleVisualTwinRuntimeActor>(
        AShuttleVisualTwinRuntimeActor::StaticClass(),
        FVector::ZeroVector,
        FRotator::ZeroRotator,
        RuntimeSpawnParameters
    );
    if (RuntimeActor)
    {
        RuntimeActor->WebSocketUrl = TEXT("ws://localhost:8791/shuttle-ws");
    }

    FActorSpawnParameters LightSpawnParameters;
    LightSpawnParameters.Name = TEXT("ShuttleVisualTwinKeyLight");
    LightSpawnParameters.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    ADirectionalLight* KeyLight = World->SpawnActor<ADirectionalLight>(
        FVector(0.0f, 0.0f, 5000.0f),
        FRotator(-90.0f, 0.0f, 0.0f),
        LightSpawnParameters
    );
    if (KeyLight && KeyLight->GetLightComponent())
    {
        KeyLight->GetLightComponent()->SetIntensity(4.0f);
    }

    FActorSpawnParameters CameraSpawnParameters;
    CameraSpawnParameters.Name = TEXT("ShuttleVisualTwinTopCamera");
    CameraSpawnParameters.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    ACameraActor* CameraActor = World->SpawnActor<ACameraActor>(
        FVector(2050.0f, 0.0f, 4800.0f),
        FRotator(-90.0f, 0.0f, 0.0f),
        CameraSpawnParameters
    );
    if (!CameraActor)
    {
        return;
    }

    UCameraComponent* CameraComponent = CameraActor->GetCameraComponent();
    if (CameraComponent)
    {
        CameraComponent->SetProjectionMode(ECameraProjectionMode::Orthographic);
        CameraComponent->SetOrthoWidth(6400.0f);
    }

    if (APlayerController* PlayerController = UGameplayStatics::GetPlayerController(this, 0))
    {
        PlayerController->SetViewTarget(CameraActor);
    }

    ConfigurePixelStreamingRenderTarget(CameraActor->GetActorLocation(), CameraActor->GetActorRotation(), 6400.0f);
    ConfigurePixelStreamingVideoProducer();

    UE_LOG(LogShuttleVisualTwinBootstrap, Display, TEXT("Bootstrap scene ready; Pixel Streaming video producer is bound to a render target."));
}

void AShuttleVisualTwinBootstrapGameMode::ConfigurePixelStreamingRenderTarget(const FVector& CameraLocation, const FRotator& CameraRotation, float OrthoWidth)
{
    UWorld* World = GetWorld();
    if (!World)
    {
        return;
    }

    PixelStreamingRenderTarget = NewObject<UTextureRenderTarget2D>(this, TEXT("ShuttlePixelStreamingRenderTarget"));
    if (!PixelStreamingRenderTarget)
    {
        UE_LOG(LogShuttleVisualTwinBootstrap, Warning, TEXT("Could not create Pixel Streaming render target."));
        return;
    }

    PixelStreamingRenderTarget->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
    PixelStreamingRenderTarget->ClearColor = FLinearColor::Black;
    PixelStreamingRenderTarget->InitAutoFormat(1280, 720);
    PixelStreamingRenderTarget->UpdateResourceImmediate(true);

    FActorSpawnParameters CaptureSpawnParameters;
    CaptureSpawnParameters.Name = TEXT("ShuttleVisualTwinPixelStreamingCapture");
    CaptureSpawnParameters.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    PixelStreamingSceneCapture = World->SpawnActor<ASceneCapture2D>(
        ASceneCapture2D::StaticClass(),
        CameraLocation,
        CameraRotation,
        CaptureSpawnParameters
    );
    if (!PixelStreamingSceneCapture)
    {
        UE_LOG(LogShuttleVisualTwinBootstrap, Warning, TEXT("Could not create Pixel Streaming scene capture."));
        return;
    }

    USceneCaptureComponent2D* CaptureComponent = PixelStreamingSceneCapture->GetCaptureComponent2D();
    if (!CaptureComponent)
    {
        UE_LOG(LogShuttleVisualTwinBootstrap, Warning, TEXT("Pixel Streaming scene capture component is unavailable."));
        return;
    }

    CaptureComponent->TextureTarget = PixelStreamingRenderTarget;
    CaptureComponent->ProjectionType = ECameraProjectionMode::Orthographic;
    CaptureComponent->OrthoWidth = OrthoWidth;
    CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
    CaptureComponent->bCaptureEveryFrame = true;
    CaptureComponent->bCaptureOnMovement = false;
    CaptureComponent->CaptureScene();

    UE_LOG(LogShuttleVisualTwinBootstrap, Display, TEXT("Pixel Streaming render target capture is ready at 1280x720."));
}

void AShuttleVisualTwinBootstrapGameMode::ConfigurePixelStreamingVideoProducer()
{
    if (!FModuleManager::Get().IsModuleLoaded("PixelStreaming2"))
    {
        UE_LOG(LogShuttleVisualTwinBootstrap, Warning, TEXT("PixelStreaming2 module is not loaded; browser streaming will remain unavailable."));
        return;
    }

    IPixelStreaming2Module& PixelStreaming = IPixelStreaming2Module::Get();
    if (PixelStreaming.IsReady())
    {
        ApplyPixelStreamingVideoProducer(PixelStreaming);
        return;
    }

    PixelStreaming.OnReady().AddUObject(this, &AShuttleVisualTwinBootstrapGameMode::ApplyPixelStreamingVideoProducer);
}

void AShuttleVisualTwinBootstrapGameMode::ApplyPixelStreamingVideoProducer(IPixelStreaming2Module& PixelStreaming)
{
    TSharedPtr<IPixelStreaming2Streamer> Streamer = PixelStreaming.FindStreamer(PixelStreaming.GetDefaultStreamerID());
    if (!Streamer)
    {
        UE_LOG(LogShuttleVisualTwinBootstrap, Warning, TEXT("PixelStreaming2 default streamer is not available."));
        return;
    }

    if (PixelStreamingRenderTarget)
    {
        PixelStreamingVideoProducer = UE::PixelStreaming2::FVideoProducerRenderTarget::Create(PixelStreamingRenderTarget);
    }
    else
    {
        PixelStreamingVideoProducer = UE::PixelStreaming2::FVideoProducerMediaCapture::CreateActiveViewportCapture();
    }

    if (!PixelStreamingVideoProducer)
    {
        UE_LOG(LogShuttleVisualTwinBootstrap, Warning, TEXT("PixelStreaming2 video producer could not be created."));
        return;
    }

    Streamer->SetVideoProducer(PixelStreamingVideoProducer);
    Streamer->ForceKeyFrame();
    UE_LOG(LogShuttleVisualTwinBootstrap, Display, TEXT("PixelStreaming2 default streamer now captures the render target."));
}
`
  );

  const defaultEnginePath = path.join(projectDir, 'Config', 'DefaultEngine.ini');
  const gameDefaultMapLine = 'GameDefaultMap=/Engine/Maps/Entry';
  const gameModeLine = 'GlobalDefaultGameMode=/Script/ShuttleVisualTwin.ShuttleVisualTwinBootstrapGameMode';
  let defaultEngine = await readFile(defaultEnginePath, 'utf8');
  if (!defaultEngine.includes(gameDefaultMapLine)) {
    if (defaultEngine.includes('GameDefaultMap=')) {
      defaultEngine = defaultEngine.replace(/^GameDefaultMap=.*$/m, gameDefaultMapLine);
    } else {
      const sectionName = '[/Script/EngineSettings.GameMapsSettings]';
      const sectionStart = defaultEngine.indexOf(sectionName);
      if (sectionStart < 0) {
        defaultEngine = `${sectionName}\n${gameDefaultMapLine}\n\n${defaultEngine}`;
      } else {
        const sectionContentStart = sectionStart + sectionName.length;
        const nextSectionStart = defaultEngine.indexOf('\n[', sectionContentStart);
        const insertAt = nextSectionStart < 0 ? defaultEngine.length : nextSectionStart;
        defaultEngine = `${defaultEngine.slice(0, insertAt).trimEnd()}\n${gameDefaultMapLine}\n${defaultEngine.slice(insertAt)}`;
      }
    }
  }

  if (!defaultEngine.includes(gameModeLine)) {
    if (defaultEngine.includes('GlobalDefaultGameMode=')) {
      defaultEngine = defaultEngine.replace(/^GlobalDefaultGameMode=.*$/m, gameModeLine);
    } else {
      const sectionName = '[/Script/EngineSettings.GameMapsSettings]';
      const sectionStart = defaultEngine.indexOf(sectionName);
      if (sectionStart < 0) {
        defaultEngine = `${sectionName}\n${gameDefaultMapLine}\n${gameModeLine}\n\n${defaultEngine}`;
      } else {
        const sectionContentStart = sectionStart + sectionName.length;
        const nextSectionStart = defaultEngine.indexOf('\n[', sectionContentStart);
        const insertAt = nextSectionStart < 0 ? defaultEngine.length : nextSectionStart;
        defaultEngine = `${defaultEngine.slice(0, insertAt).trimEnd()}\n${gameModeLine}\n${defaultEngine.slice(insertAt)}`;
      }
    }
  }
  await writeFile(defaultEnginePath, defaultEngine);

  const defaultGamePath = path.join(projectDir, 'Config', 'DefaultGame.ini');
  let defaultGame = await readFile(defaultGamePath, 'utf8');
  const packagingSection = '[/Script/UnrealEd.ProjectPackagingSettings]';
  const shaderCodeLine = 'bShareMaterialShaderCode=False';
  if (!defaultGame.includes(shaderCodeLine)) {
    if (defaultGame.includes('bShareMaterialShaderCode=')) {
      defaultGame = defaultGame.replace(/^bShareMaterialShaderCode=.*$/m, shaderCodeLine);
    } else if (defaultGame.includes(packagingSection)) {
      const sectionStart = defaultGame.indexOf(packagingSection);
      const sectionContentStart = sectionStart + packagingSection.length;
      const nextSectionStart = defaultGame.indexOf('\n[', sectionContentStart);
      const insertAt = nextSectionStart < 0 ? defaultGame.length : nextSectionStart;
      defaultGame = `${defaultGame.slice(0, insertAt).trimEnd()}\n${shaderCodeLine}\n${defaultGame.slice(insertAt)}`;
    } else {
      defaultGame = `${defaultGame.trimEnd()}\n\n${packagingSection}\n${shaderCodeLine}\n`;
    }
    await writeFile(defaultGamePath, defaultGame);
  }

  const stagingSection = '[Staging]';
  const allowedPixelStreamingSamplesLine = '+AllowedDirectories=ShuttleVisualTwin/Samples/PixelStreaming2/WebServers/Extras';
  if (!defaultGame.includes(allowedPixelStreamingSamplesLine)) {
    if (defaultGame.includes(stagingSection)) {
      const sectionStart = defaultGame.indexOf(stagingSection);
      const sectionContentStart = sectionStart + stagingSection.length;
      const nextSectionStart = defaultGame.indexOf('\n[', sectionContentStart);
      const insertAt = nextSectionStart < 0 ? defaultGame.length : nextSectionStart;
      defaultGame = `${defaultGame.slice(0, insertAt).trimEnd()}\n${allowedPixelStreamingSamplesLine}\n${defaultGame.slice(insertAt)}`;
    } else {
      defaultGame = `${defaultGame.trimEnd()}\n\n${stagingSection}\n${allowedPixelStreamingSamplesLine}\n`;
    }
    await writeFile(defaultGamePath, defaultGame);
  }
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
  await writeRuntimeBootstrap(outputDir);
  const projectDescriptor = JSON.parse(await readFile(projectPath, 'utf8'));

  const summary = {
    project: projectPath,
    engineAssociation: projectDescriptor.EngineAssociation,
    plugin: path.join(pluginOutputDir, 'ShuttlePhase0Bridge.uplugin'),
    runtimeBootstrap: path.join(outputDir, 'Source', projectName, 'ShuttleVisualTwinBootstrapGameMode.cpp'),
    enabledPlugins: projectDescriptor.Plugins
      ?.filter((plugin) => ['ShuttlePhase0Bridge', 'PixelStreaming2'].includes(plugin.Name) && plugin.Enabled)
      .map((plugin) => plugin.Name) ?? [],
    unrealEditor: path.join(ueRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor')
  };
  await assertExecutable('UE 5.7 editor', summary.unrealEditor);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
