#include "ShuttleVisualTwinSmokeCommandlet.h"

#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "ShuttleVisualTwinActor.h"
#include "ShuttleVisualTwinRuntimeActor.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinSmoke, Log, All);

namespace
{
bool IsNearlyEqual(const FVector& Actual, const FVector& Expected, const float ToleranceCm = 0.1f)
{
    return Actual.Equals(Expected, ToleranceCm);
}

bool StaticSceneContractPass(const FShuttleStaticSceneContractForSmoke& Contract)
{
    return
        Contract.bSingleLevel &&
        Contract.bDenseStorageBlock &&
        Contract.bOrthogonalTrackOnly &&
        Contract.bDedicatedLiftPorts &&
        Contract.StorageRows == 6 &&
        Contract.StorageColumns == 8 &&
        Contract.StorageCellCount == 48 &&
        Contract.TrackBedCount == 16 &&
        Contract.StorageLaneTrackCount == 6 &&
        Contract.SideAisleTrackCount == 2 &&
        Contract.CrossAisleTrackCount == 2 &&
        Contract.InboundConnectorTrackCount == 2 &&
        Contract.OutboundConnectorTrackCount == 2 &&
        Contract.ParkingConnectorTrackCount == 2 &&
        Contract.DiagonalTrackCount == 0 &&
        Contract.InboundLiftPadCount == 2 &&
        Contract.OutboundLiftPadCount == 2 &&
        Contract.ParkingPadCount == 2;
}

TSharedRef<FJsonObject> StaticSceneContractToJson(const FShuttleStaticSceneContractForSmoke& Contract, const bool bPass)
{
    TSharedRef<FJsonObject> Summary = MakeShared<FJsonObject>();
    Summary->SetStringField(TEXT("schemaVersion"), TEXT("shuttle.unrealStaticScene.v1"));
    Summary->SetBoolField(TEXT("pass"), bPass);
    Summary->SetNumberField(TEXT("storageRows"), Contract.StorageRows);
    Summary->SetNumberField(TEXT("storageColumns"), Contract.StorageColumns);
    Summary->SetNumberField(TEXT("storageCellCount"), Contract.StorageCellCount);
    Summary->SetNumberField(TEXT("trackBedCount"), Contract.TrackBedCount);
    Summary->SetNumberField(TEXT("storageLaneTrackCount"), Contract.StorageLaneTrackCount);
    Summary->SetNumberField(TEXT("sideAisleTrackCount"), Contract.SideAisleTrackCount);
    Summary->SetNumberField(TEXT("crossAisleTrackCount"), Contract.CrossAisleTrackCount);
    Summary->SetNumberField(TEXT("inboundConnectorTrackCount"), Contract.InboundConnectorTrackCount);
    Summary->SetNumberField(TEXT("outboundConnectorTrackCount"), Contract.OutboundConnectorTrackCount);
    Summary->SetNumberField(TEXT("parkingConnectorTrackCount"), Contract.ParkingConnectorTrackCount);
    Summary->SetNumberField(TEXT("diagonalTrackCount"), Contract.DiagonalTrackCount);
    Summary->SetNumberField(TEXT("inboundLiftPadCount"), Contract.InboundLiftPadCount);
    Summary->SetNumberField(TEXT("outboundLiftPadCount"), Contract.OutboundLiftPadCount);
    Summary->SetNumberField(TEXT("parkingPadCount"), Contract.ParkingPadCount);
    Summary->SetNumberField(TEXT("storagePitchXM"), Contract.StoragePitchXM);
    Summary->SetNumberField(TEXT("storagePitchZM"), Contract.StoragePitchZM);
    Summary->SetNumberField(TEXT("storageBlockMinXM"), Contract.StorageBlockMinXM);
    Summary->SetNumberField(TEXT("storageBlockMaxXM"), Contract.StorageBlockMaxXM);
    Summary->SetNumberField(TEXT("storageBlockMinZM"), Contract.StorageBlockMinZM);
    Summary->SetNumberField(TEXT("storageBlockMaxZM"), Contract.StorageBlockMaxZM);
    Summary->SetNumberField(TEXT("inboundLiftXM"), Contract.InboundLiftXM);
    Summary->SetNumberField(TEXT("outboundLiftXM"), Contract.OutboundLiftXM);
    Summary->SetBoolField(TEXT("singleLevel"), Contract.bSingleLevel);
    Summary->SetBoolField(TEXT("denseStorageBlock"), Contract.bDenseStorageBlock);
    Summary->SetBoolField(TEXT("orthogonalTrackOnly"), Contract.bOrthogonalTrackOnly);
    Summary->SetBoolField(TEXT("dedicatedLiftPorts"), Contract.bDedicatedLiftPorts);
    Summary->SetStringField(TEXT("inboundSide"), Contract.InboundLiftXM > Contract.StorageBlockMaxXM ? TEXT("right") : TEXT("unknown"));
    Summary->SetStringField(TEXT("outboundSide"), Contract.OutboundLiftXM < Contract.StorageBlockMinXM ? TEXT("left") : TEXT("unknown"));
    return Summary;
}

bool WriteJsonSummary(const FString& SummaryPath, const TSharedRef<FJsonObject>& Summary)
{
    if (SummaryPath.IsEmpty())
    {
        return true;
    }

    FString Output;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
    if (!FJsonSerializer::Serialize(Summary, Writer))
    {
        return false;
    }

    const FString Directory = FPaths::GetPath(SummaryPath);
    if (!Directory.IsEmpty())
    {
        IFileManager::Get().MakeDirectory(*Directory, true);
    }
    return FFileHelper::SaveStringToFile(Output, *SummaryPath);
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

    FString StaticSceneSummaryPath;
    FParse::Value(*Params, TEXT("ShuttleStaticSceneSummaryPath="), StaticSceneSummaryPath);

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
        const FShuttleStaticSceneContractForSmoke StaticSceneContract = RuntimeActor->GetStaticSceneContractForSmoke();
        const bool bStaticScenePass = StaticSceneContractPass(StaticSceneContract);

        UE_LOG(
            LogShuttleVisualTwinSmoke,
            Display,
            TEXT("Static scene counts: pass=%s storage=%d track=%d inboundLift=%d outboundLift=%d parking=%d rows=%d columns=%d dense=%s orthogonal=%s dedicatedLift=%s summary='%s'"),
            bStaticScenePass ? TEXT("true") : TEXT("false"),
            StorageCells,
            TrackBeds,
            InboundLiftPads,
            OutboundLiftPads,
            ParkingPads,
            StaticSceneContract.StorageRows,
            StaticSceneContract.StorageColumns,
            StaticSceneContract.bDenseStorageBlock ? TEXT("true") : TEXT("false"),
            StaticSceneContract.bOrthogonalTrackOnly ? TEXT("true") : TEXT("false"),
            StaticSceneContract.bDedicatedLiftPorts ? TEXT("true") : TEXT("false"),
            *StaticSceneSummaryPath
        );

        if (!WriteJsonSummary(StaticSceneSummaryPath, StaticSceneContractToJson(StaticSceneContract, bStaticScenePass)))
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Failed to write static scene summary to %s"), *StaticSceneSummaryPath);
            Result = 1;
        }

        if (!bStaticScenePass)
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Unexpected static scene contract."));
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
