#include "ShuttleVisualTwinSmokeCommandlet.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "ShuttleVisualTwinActor.h"
#include "ShuttleVisualTwinRuntimeActor.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinSmoke, Log, All);

namespace
{
bool IsNearlyEqual(const FVector& Actual, const FVector& Expected, const float ToleranceCm = 0.1f)
{
    return Actual.Equals(Expected, ToleranceCm);
}
}

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

        FShuttleVisualVehicleState FirstVehicleState;
        FirstVehicleState.Id = TEXT("SH-01");
        FirstVehicleState.State = EShuttleVisualOperationalState::MovingToPickup;
        FirstVehicleState.Position = FVector(2.5f, 0.0f, -1.2f);
        FirstVehicleState.YawRadians = PI / 2.0f;
        FirstVehicleState.SpeedMps = 1.0f;
        FirstVehicleState.bLoaded = false;
        FirstVehicleState.CurrentNodeId = TEXT("storage-r01-c01");
        RuntimeActor->ApplyVehicleState(FirstVehicleState);

        AShuttleVisualTwinActor* VehicleActor = RuntimeActor->FindVehicleActorById(TEXT("SH-01"));
        if (!VehicleActor || RuntimeActor->GetSpawnedVehicleActorCount() != 1)
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Synthetic vehicle state did not spawn exactly one actor."));
            Result = 1;
        }
        else if (!VehicleActor->HasVisibleDefaultGeometryForSmoke())
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Default shuttle actor has no visible placeholder geometry."));
            Result = 1;
        }
        else if (!IsNearlyEqual(VehicleActor->GetTargetPositionCmForSmoke(), FVector(250.0f, -120.0f, 0.0f)))
        {
            UE_LOG(
                LogShuttleVisualTwinSmoke,
                Error,
                TEXT("Synthetic vehicle target position mismatch: %s"),
                *VehicleActor->GetTargetPositionCmForSmoke().ToString()
            );
            Result = 1;
        }
        else if (!FMath::IsNearlyEqual(VehicleActor->GetTargetRotationForSmoke().Yaw, 90.0f, 0.1f))
        {
            UE_LOG(
                LogShuttleVisualTwinSmoke,
                Error,
                TEXT("Synthetic vehicle yaw mismatch: %f"),
                VehicleActor->GetTargetRotationForSmoke().Yaw
            );
            Result = 1;
        }
        else if (VehicleActor->IsCarriedPalletVisibleForSmoke())
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Unloaded synthetic vehicle should hide carried pallet."));
            Result = 1;
        }

        FShuttleVisualVehicleState LoadedVehicleState = FirstVehicleState;
        LoadedVehicleState.Position = FVector(3.5f, 0.2f, -1.2f);
        LoadedVehicleState.bLoaded = true;
        RuntimeActor->ApplyVehicleState(LoadedVehicleState);

        if (RuntimeActor->GetSpawnedVehicleActorCount() != 1)
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Synthetic vehicle update spawned a duplicate actor."));
            Result = 1;
        }
        else if (!VehicleActor->IsCarriedPalletVisibleForSmoke())
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Loaded synthetic vehicle should show carried pallet."));
            Result = 1;
        }
        else if (!IsNearlyEqual(VehicleActor->GetTargetPositionCmForSmoke(), FVector(350.0f, -120.0f, 20.0f)))
        {
            UE_LOG(
                LogShuttleVisualTwinSmoke,
                Error,
                TEXT("Loaded synthetic vehicle target position mismatch: %s"),
                *VehicleActor->GetTargetPositionCmForSmoke().ToString()
            );
            Result = 1;
        }
    }

    World->DestroyWorld(false);
    GEngine->DestroyWorldContext(World);
    return Result;
}
