#include "ShuttleVisualTwinSmokeCommandlet.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "ShuttleVisualTwinRuntimeActor.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinSmoke, Log, All);

UShuttleVisualTwinSmokeCommandlet::UShuttleVisualTwinSmokeCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
}

int32 UShuttleVisualTwinSmokeCommandlet::Main(const FString& Params)
{
    if (!GEngine)
    {
        UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Missing engine."));
        return 1;
    }

    UWorld::InitializationValues InitializationValues;
    InitializationValues
        .AllowAudioPlayback(false)
        .RequiresHitProxies(false)
        .CreatePhysicsScene(false)
        .CreateNavigation(false)
        .CreateAISystem(false)
        .ShouldSimulatePhysics(false)
        .EnableTraceCollision(false)
        .SetTransactional(false)
        .CreateFXSystem(false)
        .CreateWorldPartition(false);

    UWorld* World = UWorld::CreateWorld(EWorldType::Game, false, TEXT("ShuttleVisualTwinSmokeWorld"), nullptr, true, ERHIFeatureLevel::Num, &InitializationValues);
    if (!World)
    {
        UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Failed to create smoke world."));
        return 1;
    }

    FWorldContext& WorldContext = GEngine->CreateNewWorldContext(EWorldType::Game);
    WorldContext.SetCurrentWorld(World);

    int32 Result = 0;
    AShuttleVisualTwinRuntimeActor* RuntimeActor = World->SpawnActor<AShuttleVisualTwinRuntimeActor>();
    if (!RuntimeActor)
    {
        UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Failed to spawn AShuttleVisualTwinRuntimeActor."));
        Result = 1;
    }
    else
    {
        RuntimeActor->bAutoConnect = false;
        RuntimeActor->RebuildStaticScene();

        const int32 StorageCells = RuntimeActor->GetStorageCellInstanceCount();
        const int32 TrackBeds = RuntimeActor->GetTrackBedInstanceCount();
        const int32 InboundLiftPads = RuntimeActor->GetInboundLiftPadInstanceCount();
        const int32 OutboundLiftPads = RuntimeActor->GetOutboundLiftPadInstanceCount();
        const int32 ParkingPads = RuntimeActor->GetParkingPadInstanceCount();

        UE_LOG(
            LogShuttleVisualTwinSmoke,
            Display,
            TEXT("Static scene counts: storage=%d track=%d inboundLift=%d outboundLift=%d parking=%d"),
            StorageCells,
            TrackBeds,
            InboundLiftPads,
            OutboundLiftPads,
            ParkingPads
        );

        if (StorageCells != 48 || TrackBeds != 16 || InboundLiftPads != 2 || OutboundLiftPads != 2 || ParkingPads != 2)
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Unexpected static scene instance counts."));
            Result = 1;
        }
    }

    World->DestroyWorld(false);
    GEngine->DestroyWorldContext(World);
    return Result;
}
