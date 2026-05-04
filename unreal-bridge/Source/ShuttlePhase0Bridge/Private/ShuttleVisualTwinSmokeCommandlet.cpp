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
        !Contract.bDenseStorageBlock &&
        Contract.bOrthogonalTrackOnly &&
        Contract.bDedicatedLiftPorts &&
        Contract.StorageRows == 16 &&
        Contract.StorageColumns == 24 &&
        Contract.StorageCellCount == 384 &&
        Contract.TrackBedCount == 474 &&
        Contract.StorageLaneTrackCount == 400 &&
        Contract.SideAisleTrackCount == 42 &&
        Contract.CrossAisleTrackCount == 12 &&
        Contract.InboundConnectorTrackCount == 8 &&
        Contract.OutboundConnectorTrackCount == 8 &&
        Contract.ParkingConnectorTrackCount == 4 &&
        Contract.DiagonalTrackCount == 0 &&
        Contract.InboundLiftPadCount == 4 &&
        Contract.OutboundLiftPadCount == 4 &&
        Contract.ParkingPadCount == 4 &&
        Contract.FloorPlateCount == 1 &&
        Contract.StorageRailSegmentCount == 1536 &&
        Contract.RackPostCount == 504 &&
        Contract.TransferRollerCount == 48 &&
        Contract.LiftBlockCount == 8 &&
        Contract.StorageCells.Num() == 384 &&
        Contract.TrackBeds.Num() == 474 &&
        Contract.LiftPads.Num() == 8 &&
        Contract.ParkingPads.Num() == 4 &&
        Contract.bHasStorageRailGrid &&
        Contract.bHasTransferRollers &&
        Contract.bHasLiftBlackBoxes;
}

TSharedRef<FJsonObject> StorageCellToJson(const FShuttleStaticSceneStorageCellForSmoke& Cell)
{
    TSharedRef<FJsonObject> Output = MakeShared<FJsonObject>();
    Output->SetStringField(TEXT("id"), Cell.Id);
    Output->SetNumberField(TEXT("row"), Cell.Row);
    Output->SetNumberField(TEXT("column"), Cell.Column);
    Output->SetNumberField(TEXT("xM"), Cell.XM);
    Output->SetNumberField(TEXT("yM"), Cell.YM);
    Output->SetNumberField(TEXT("zM"), Cell.ZM);
    Output->SetNumberField(TEXT("lengthXM"), Cell.LengthXM);
    Output->SetNumberField(TEXT("lengthZM"), Cell.LengthZM);
    return Output;
}

TSharedRef<FJsonObject> TrackBedToJson(const FShuttleStaticSceneTrackBedForSmoke& TrackBed)
{
    TSharedRef<FJsonObject> Output = MakeShared<FJsonObject>();
    Output->SetStringField(TEXT("id"), TrackBed.Id);
    Output->SetStringField(TEXT("category"), TrackBed.Category);
    Output->SetNumberField(TEXT("xM"), TrackBed.XM);
    Output->SetNumberField(TEXT("yM"), TrackBed.YM);
    Output->SetNumberField(TEXT("zM"), TrackBed.ZM);
    Output->SetNumberField(TEXT("lengthXM"), TrackBed.LengthXM);
    Output->SetNumberField(TEXT("lengthZM"), TrackBed.LengthZM);
    Output->SetStringField(TEXT("orientation"), TrackBed.Orientation);
    Output->SetNumberField(TEXT("row"), TrackBed.Row);
    Output->SetStringField(TEXT("side"), TrackBed.Side);
    return Output;
}

TSharedRef<FJsonObject> PadToJson(const FShuttleStaticScenePadForSmoke& Pad)
{
    TSharedRef<FJsonObject> Output = MakeShared<FJsonObject>();
    Output->SetStringField(TEXT("id"), Pad.Id);
    Output->SetStringField(TEXT("category"), Pad.Category);
    Output->SetNumberField(TEXT("xM"), Pad.XM);
    Output->SetNumberField(TEXT("yM"), Pad.YM);
    Output->SetNumberField(TEXT("zM"), Pad.ZM);
    Output->SetNumberField(TEXT("lengthXM"), Pad.LengthXM);
    Output->SetNumberField(TEXT("lengthZM"), Pad.LengthZM);
    Output->SetStringField(TEXT("side"), Pad.Side);
    return Output;
}

template <typename ItemType, typename ConverterType>
TArray<TSharedPtr<FJsonValue>> ToJsonArray(const TArray<ItemType>& Items, ConverterType Converter)
{
    TArray<TSharedPtr<FJsonValue>> Output;
    Output.Reserve(Items.Num());
    for (const ItemType& Item : Items)
    {
        const TSharedRef<FJsonObject> Object = Converter(Item);
        Output.Add(MakeShared<FJsonValueObject>(Object.ToSharedPtr()));
    }
    return Output;
}

TSharedRef<FJsonObject> StaticSceneContractToJson(const FShuttleStaticSceneContractForSmoke& Contract, const bool bPass)
{
    TSharedRef<FJsonObject> Summary = MakeShared<FJsonObject>();
    Summary->SetStringField(TEXT("schemaVersion"), TEXT("shuttle.unrealStaticScene.v1"));
    Summary->SetBoolField(TEXT("pass"), bPass);
    Summary->SetArrayField(TEXT("storageCells"), ToJsonArray(Contract.StorageCells, StorageCellToJson));
    Summary->SetArrayField(TEXT("trackBeds"), ToJsonArray(Contract.TrackBeds, TrackBedToJson));
    Summary->SetArrayField(TEXT("liftPads"), ToJsonArray(Contract.LiftPads, PadToJson));
    Summary->SetArrayField(TEXT("parkingPads"), ToJsonArray(Contract.ParkingPads, PadToJson));
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
    Summary->SetNumberField(TEXT("floorPlateCount"), Contract.FloorPlateCount);
    Summary->SetNumberField(TEXT("storageRailSegmentCount"), Contract.StorageRailSegmentCount);
    Summary->SetNumberField(TEXT("rackPostCount"), Contract.RackPostCount);
    Summary->SetNumberField(TEXT("transferRollerCount"), Contract.TransferRollerCount);
    Summary->SetNumberField(TEXT("liftBlockCount"), Contract.LiftBlockCount);
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
    Summary->SetBoolField(TEXT("hasStorageRailGrid"), Contract.bHasStorageRailGrid);
    Summary->SetBoolField(TEXT("hasTransferRollers"), Contract.bHasTransferRollers);
    Summary->SetBoolField(TEXT("hasLiftBlackBoxes"), Contract.bHasLiftBlackBoxes);
    Summary->SetStringField(
        TEXT("inboundSide"),
        Contract.InboundLiftXM > Contract.StorageBlockMaxXM ? TEXT("right") : Contract.InboundLiftXM < Contract.StorageBlockMinXM ? TEXT("left") : TEXT("mixed")
    );
    Summary->SetStringField(
        TEXT("outboundSide"),
        Contract.OutboundLiftXM > Contract.StorageBlockMaxXM ? TEXT("right") : Contract.OutboundLiftXM < Contract.StorageBlockMinXM ? TEXT("left") : TEXT("mixed")
    );
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

bool ExpectLoadPalletCount(AShuttleVisualTwinRuntimeActor* RuntimeActor, const int32 ExpectedCount, const TCHAR* Context)
{
    const int32 ActualCount = RuntimeActor ? RuntimeActor->GetLoadPalletInstanceCount() : -1;
    if (ActualCount == ExpectedCount)
    {
        return true;
    }

    UE_LOG(
        LogShuttleVisualTwinSmoke,
        Error,
        TEXT("%s expected %d visible static load pallets, got %d."),
        Context,
        ExpectedCount,
        ActualCount
    );
    return false;
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
        const int32 FloorPlates = RuntimeActor->GetFloorPlateInstanceCount();
        const int32 StorageRails = RuntimeActor->GetStorageRailInstanceCount();
        const int32 RackPosts = RuntimeActor->GetRackPostInstanceCount();
        const int32 TransferRollers = RuntimeActor->GetTransferRollerInstanceCount();
        const int32 LiftBlocks = RuntimeActor->GetLiftBlockInstanceCount();
        const FShuttleStaticSceneContractForSmoke StaticSceneContract = RuntimeActor->GetStaticSceneContractForSmoke();
        const bool bStaticScenePass = StaticSceneContractPass(StaticSceneContract);

        UE_LOG(
            LogShuttleVisualTwinSmoke,
            Display,
            TEXT("Static scene counts: pass=%s storage=%d track=%d inboundLift=%d outboundLift=%d parking=%d floor=%d storageRails=%d rackPosts=%d rollers=%d liftBlocks=%d rows=%d columns=%d dense=%s orthogonal=%s dedicatedLift=%s summary='%s'"),
            bStaticScenePass ? TEXT("true") : TEXT("false"),
            StorageCells,
            TrackBeds,
            InboundLiftPads,
            OutboundLiftPads,
            ParkingPads,
            FloorPlates,
            StorageRails,
            RackPosts,
            TransferRollers,
            LiftBlocks,
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

        TArray<FShuttleVisualLoadState> SyntheticLoadStates;
        FShuttleVisualLoadState StoredLoad;
        StoredLoad.Id = TEXT("load-stored");
        StoredLoad.State = EShuttleVisualLoadStatus::Stored;
        StoredLoad.NodeId = TEXT("storage-r01-c01");
        StoredLoad.WeightKg = 1000.0f;
        SyntheticLoadStates.Add(StoredLoad);

        FShuttleVisualLoadState WaitingLoad;
        WaitingLoad.Id = TEXT("load-waiting");
        WaitingLoad.State = EShuttleVisualLoadStatus::Waiting;
        WaitingLoad.NodeId = TEXT("inbound-lift-top-01");
        WaitingLoad.WeightKg = 1000.0f;
        SyntheticLoadStates.Add(WaitingLoad);

        FShuttleVisualLoadState DeliveredLoad;
        DeliveredLoad.Id = TEXT("load-delivered");
        DeliveredLoad.State = EShuttleVisualLoadStatus::Delivered;
        DeliveredLoad.NodeId = TEXT("outbound-lift-bottom-02");
        DeliveredLoad.WeightKg = 1000.0f;
        SyntheticLoadStates.Add(DeliveredLoad);

        FShuttleVisualLoadState CarriedLoad;
        CarriedLoad.Id = TEXT("load-carried");
        CarriedLoad.State = EShuttleVisualLoadStatus::Carried;
        CarriedLoad.VehicleId = TEXT("SH-01");
        CarriedLoad.WeightKg = 1000.0f;
        SyntheticLoadStates.Add(CarriedLoad);

        RuntimeActor->ApplyLoadStates(SyntheticLoadStates);
        if (!ExpectLoadPalletCount(RuntimeActor, 3, TEXT("Synthetic mixed load-state application")))
        {
            Result = 1;
        }

        TArray<FShuttleVisualLoadState> LifecycleLoadStates;
        FShuttleVisualLoadState LifecycleLoad;
        LifecycleLoad.Id = TEXT("load-lifecycle");
        LifecycleLoad.WeightKg = 1000.0f;

        LifecycleLoad.State = EShuttleVisualLoadStatus::Waiting;
        LifecycleLoad.NodeId = TEXT("inbound-lift-top-01");
        LifecycleLoad.VehicleId.Reset();
        LifecycleLoadStates = {LifecycleLoad};
        RuntimeActor->ApplyLoadStates(LifecycleLoadStates);
        if (!ExpectLoadPalletCount(RuntimeActor, 1, TEXT("Waiting load lifecycle state")))
        {
            Result = 1;
        }

        LifecycleLoad.State = EShuttleVisualLoadStatus::Stored;
        LifecycleLoad.NodeId = TEXT("storage-r01-c01");
        LifecycleLoad.VehicleId.Reset();
        LifecycleLoadStates = {LifecycleLoad};
        RuntimeActor->ApplyLoadStates(LifecycleLoadStates);
        if (!ExpectLoadPalletCount(RuntimeActor, 1, TEXT("Stored load lifecycle state")))
        {
            Result = 1;
        }

        LoadedVehicleState.bLoaded = true;
        RuntimeActor->ApplyVehicleState(LoadedVehicleState);
        LifecycleLoad.State = EShuttleVisualLoadStatus::Carried;
        LifecycleLoad.NodeId = TEXT("storage-r01-c01");
        LifecycleLoad.VehicleId = TEXT("SH-01");
        LifecycleLoadStates = {LifecycleLoad};
        RuntimeActor->ApplyLoadStates(LifecycleLoadStates);
        if (!ExpectLoadPalletCount(RuntimeActor, 0, TEXT("Carried load lifecycle state")))
        {
            Result = 1;
        }
        else if (!VehicleActor->IsCarriedPalletVisibleForSmoke())
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Carried load lifecycle state should remain visible only on the shuttle actor."));
            Result = 1;
        }

        LoadedVehicleState.bLoaded = false;
        RuntimeActor->ApplyVehicleState(LoadedVehicleState);
        LifecycleLoad.State = EShuttleVisualLoadStatus::Delivered;
        LifecycleLoad.NodeId = TEXT("outbound-lift-bottom-02");
        LifecycleLoad.VehicleId.Reset();
        LifecycleLoadStates = {LifecycleLoad};
        RuntimeActor->ApplyLoadStates(LifecycleLoadStates);
        if (!ExpectLoadPalletCount(RuntimeActor, 1, TEXT("Delivered load lifecycle state")))
        {
            Result = 1;
        }
        else if (VehicleActor->IsCarriedPalletVisibleForSmoke())
        {
            UE_LOG(LogShuttleVisualTwinSmoke, Error, TEXT("Delivered load lifecycle state should hide the shuttle carried-pallet placeholder."));
            Result = 1;
        }
    }

    World->DestroyWorld(false);
    GEngine->DestroyWorldContext(World);
    return Result;
}
