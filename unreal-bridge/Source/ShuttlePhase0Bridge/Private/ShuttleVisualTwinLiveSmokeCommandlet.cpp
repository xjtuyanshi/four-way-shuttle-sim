#include "ShuttleVisualTwinLiveSmokeCommandlet.h"

#include "Async/TaskGraphInterfaces.h"
#include "Containers/BackgroundableTicker.h"
#include "Containers/Ticker.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "HAL/PlatformProcess.h"
#include "Misc/Parse.h"
#include "ShuttleVisualTwinRuntimeActor.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinLiveSmoke, Log, All);

namespace
{
constexpr int32 MinimumVehicleStateUpdates = 4;

void PumpLiveSmokeWorld(UWorld* World, const float DeltaSec)
{
    FTaskGraphInterface::Get().ProcessThreadUntilIdle(ENamedThreads::GameThread);
    FTSBackgroundableTicker::GetCoreTicker().Tick(DeltaSec);
    FTSTicker::GetCoreTicker().Tick(DeltaSec);
    if (World)
    {
        World->Tick(LEVELTICK_All, DeltaSec);
    }
}
}

UShuttleVisualTwinLiveSmokeCommandlet::UShuttleVisualTwinLiveSmokeCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
}

int32 UShuttleVisualTwinLiveSmokeCommandlet::Main(const FString& Params)
{
    if (!GEngine)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Missing engine."));
        return 1;
    }

    FString WebSocketUrl = TEXT("ws://127.0.0.1:8791/shuttle-ws");
    FParse::Value(*Params, TEXT("ShuttleWsUrl="), WebSocketUrl);

    float TimeoutSec = 8.0f;
    FParse::Value(*Params, TEXT("ShuttleLiveSmokeTimeoutSec="), TimeoutSec);
    TimeoutSec = FMath::Clamp(TimeoutSec, 1.0f, 60.0f);

    UGameInstance* GameInstance = NewObject<UGameInstance>(GEngine, UGameInstance::StaticClass());
    if (!GameInstance)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to create game instance."));
        return 1;
    }

    GameInstance->InitializeStandalone(TEXT("ShuttleVisualTwinLiveSmokeWorld"));
    UWorld* World = GameInstance->GetWorld();
    if (!World)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to create live smoke world."));
        GameInstance->Shutdown();
        return 1;
    }

    int32 Result = 0;
    AShuttleVisualTwinRuntimeActor* RuntimeActor = World->SpawnActor<AShuttleVisualTwinRuntimeActor>();
    if (!RuntimeActor)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to spawn AShuttleVisualTwinRuntimeActor."));
        Result = 1;
    }
    else
    {
        RuntimeActor->bAutoConnect = false;
        RuntimeActor->WebSocketUrl = WebSocketUrl;
        RuntimeActor->RebuildStaticScene();
        RuntimeActor->ConnectToBridge();

        const double DeadlineSec = FPlatformTime::Seconds() + static_cast<double>(TimeoutSec);

        while (FPlatformTime::Seconds() < DeadlineSec)
        {
            PumpLiveSmokeWorld(World, 0.05f);

            if (RuntimeActor->bBridgeConnected &&
                RuntimeActor->GetSpawnedVehicleActorCount() > 0 &&
                RuntimeActor->GetReceivedVehicleStateCount() >= MinimumVehicleStateUpdates)
            {
                break;
            }

            FPlatformProcess::Sleep(0.05f);
        }

        UE_LOG(
            LogShuttleVisualTwinLiveSmoke,
            Display,
            TEXT("Live bridge smoke: connected=%s status='%s' vehicleActors=%d receivedVehicleStates=%d requiredVehicleStates=%d"),
            RuntimeActor->bBridgeConnected ? TEXT("true") : TEXT("false"),
            *RuntimeActor->LastBridgeStatus,
            RuntimeActor->GetSpawnedVehicleActorCount(),
            RuntimeActor->GetReceivedVehicleStateCount(),
            MinimumVehicleStateUpdates
        );

        if (!RuntimeActor->bBridgeConnected)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor did not connect to %s: %s"), *WebSocketUrl, *RuntimeActor->LastBridgeStatus);
            Result = 1;
        }
        else if (RuntimeActor->GetSpawnedVehicleActorCount() <= 0)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor did not spawn any vehicle actors from the live stream."));
            Result = 1;
        }
        else if (RuntimeActor->GetReceivedVehicleStateCount() < MinimumVehicleStateUpdates)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor received only %d vehicle state updates; expected at least %d."), RuntimeActor->GetReceivedVehicleStateCount(), MinimumVehicleStateUpdates);
            Result = 1;
        }

        RuntimeActor->DisconnectFromBridge();
    }

    if (World)
    {
        World->DestroyWorld(false);
        GEngine->DestroyWorldContext(World);
    }
    GameInstance->Shutdown();
    return Result;
}
