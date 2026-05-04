#include "ShuttleVisualTwinRuntimeActor.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Materials/MaterialInterface.h"
#include "ShuttleStateSubscriberSubsystem.h"
#include "ShuttleVisualTwinActor.h"
#include "UObject/ConstructorHelpers.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinRuntime, Log, All);

namespace
{
constexpr int32 StorageRowsPerBank = 8;
constexpr int32 StorageRowBanks = 2;
constexpr int32 StorageRows = StorageRowsPerBank * StorageRowBanks;
constexpr int32 StorageColumnsPerBay = 6;
constexpr int32 StorageColumnBays = 4;
constexpr int32 StorageColumns = StorageColumnsPerBay * StorageColumnBays;
constexpr float StoragePitchXM = 1.25f;
constexpr float StoragePitchZM = 1.2f;
constexpr float FirstStorageXM = 2.5f;
constexpr float StorageBayGapXM = 2.25f;
constexpr float StorageInnerRowZM = 2.2f;
constexpr float LeftSpineXM = 0.0f;
constexpr float SideClearanceXM = 2.5f;
constexpr float MainLaneNorthZM = -0.8f;
constexpr float MainLaneSouthZM = 0.8f;
constexpr float LiftStandoffZM = 1.8f;
constexpr float ParkingStandoffXM = 2.4f;

float RowZ(const int32 RowIndex)
{
    if (RowIndex < StorageRowsPerBank)
    {
        return -(StorageInnerRowZM + static_cast<float>(StorageRowsPerBank - RowIndex - 1) * StoragePitchZM);
    }
    return StorageInnerRowZM + static_cast<float>(RowIndex - StorageRowsPerBank) * StoragePitchZM;
}

float ColumnX(const int32 ColumnIndex)
{
    return FirstStorageXM +
        static_cast<float>(ColumnIndex) * StoragePitchXM +
        static_cast<float>(ColumnIndex / StorageColumnsPerBay) * StorageBayGapXM;
}

float RightSpineX()
{
    return ColumnX(StorageColumns - 1) + SideClearanceXM;
}

float TopZ()
{
    return RowZ(0) - StoragePitchZM * 1.5f;
}

float BottomZ()
{
    return RowZ(StorageRows - 1) + StoragePitchZM * 1.5f;
}

float TopLiftZ()
{
    return TopZ() - LiftStandoffZM;
}

float BottomLiftZ()
{
    return BottomZ() + LiftStandoffZM;
}

float LiftPortalX(const int32 PortalIndex)
{
    if (PortalIndex < StorageColumnBays - 1)
    {
        const int32 LeftColumnIndex = (PortalIndex + 1) * StorageColumnsPerBay - 1;
        const int32 RightColumnIndex = LeftColumnIndex + 1;
        return (ColumnX(LeftColumnIndex) + ColumnX(RightColumnIndex)) * 0.5f;
    }
    return (ColumnX(StorageColumns - 1) + RightSpineX()) * 0.5f;
}

float MainX(const int32 MainIndex)
{
    if (MainIndex == 0)
    {
        return LeftSpineXM;
    }
    if (MainIndex == StorageColumnBays + 1)
    {
        return RightSpineX();
    }
    return LiftPortalX(MainIndex - 1);
}

FString MainLaneNodeId(const TCHAR* Lane, const int32 Index)
{
    return FString::Printf(TEXT("main-%s-%02d"), Lane, Index);
}
}

AShuttleVisualTwinRuntimeActor::AShuttleVisualTwinRuntimeActor()
{
    PrimaryActorTick.bCanEverTick = false;

    Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
    SetRootComponent(Root);

    StorageCells = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("StorageCells"));
    StorageCells->SetupAttachment(Root);
    TrackBeds = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("TrackBeds"));
    TrackBeds->SetupAttachment(Root);
    InboundLiftPads = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("InboundLiftPads"));
    InboundLiftPads->SetupAttachment(Root);
    OutboundLiftPads = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("OutboundLiftPads"));
    OutboundLiftPads->SetupAttachment(Root);
    ParkingPads = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("ParkingPads"));
    ParkingPads->SetupAttachment(Root);
    FloorPlates = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("FloorPlates"));
    FloorPlates->SetupAttachment(Root);
    StorageRails = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("StorageRails"));
    StorageRails->SetupAttachment(Root);
    RackPosts = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("RackPosts"));
    RackPosts->SetupAttachment(Root);
    TransferRollers = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("TransferRollers"));
    TransferRollers->SetupAttachment(Root);
    LiftBlocks = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("LiftBlocks"));
    LiftBlocks->SetupAttachment(Root);
    LoadPallets = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("LoadPallets"));
    LoadPallets->SetupAttachment(Root);

    SetInstancedMesh(StorageCells, FLinearColor(0.22f, 0.15f, 0.38f, 1.0f));
    SetInstancedMesh(TrackBeds, FLinearColor(0.86f, 0.68f, 0.12f, 1.0f));
    SetInstancedMesh(InboundLiftPads, FLinearColor(0.62f, 0.82f, 0.96f, 1.0f));
    SetInstancedMesh(OutboundLiftPads, FLinearColor(0.90f, 0.68f, 0.16f, 1.0f));
    SetInstancedMesh(ParkingPads, FLinearColor(0.32f, 0.36f, 0.40f, 1.0f));
    SetInstancedMesh(FloorPlates, FLinearColor(0.05f, 0.07f, 0.09f, 1.0f));
    SetInstancedMesh(StorageRails, FLinearColor(0.50f, 0.36f, 1.0f, 1.0f));
    SetInstancedMesh(RackPosts, FLinearColor(0.70f, 0.44f, 1.0f, 1.0f));
    SetInstancedMesh(TransferRollers, FLinearColor(0.58f, 0.55f, 0.50f, 1.0f));
    SetInstancedMesh(LiftBlocks, FLinearColor(0.04f, 0.06f, 0.07f, 1.0f));
    SetInstancedMesh(LoadPallets, FLinearColor(0.68f, 0.50f, 0.25f, 1.0f));
}

void AShuttleVisualTwinRuntimeActor::OnConstruction(const FTransform& Transform)
{
    Super::OnConstruction(Transform);
    RebuildStaticScene();
}

void AShuttleVisualTwinRuntimeActor::BeginPlay()
{
    Super::BeginPlay();
    RebuildStaticScene();

    if (bAutoConnect)
    {
        ConnectToBridge();
    }
}

void AShuttleVisualTwinRuntimeActor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    UnbindStateSubscriber(bDisconnectOnEndPlay);
    for (const TPair<FString, TWeakObjectPtr<AShuttleVisualTwinActor>>& Entry : VehicleActors)
    {
        AShuttleVisualTwinActor* SpawnedActor = Entry.Value.Get();
        if (IsValid(SpawnedActor) && SpawnedActor->GetOwner() == this && !SpawnedActor->IsActorBeingDestroyed())
        {
            SpawnedActor->Destroy();
        }
    }
    VehicleActors.Empty();
    LastAppliedVehicleStates.Empty();
    Super::EndPlay(EndPlayReason);
}

void AShuttleVisualTwinRuntimeActor::RebuildStaticScene()
{
    if (!StorageCells || !TrackBeds || !InboundLiftPads || !OutboundLiftPads || !ParkingPads ||
        !FloorPlates || !StorageRails || !RackPosts || !TransferRollers || !LiftBlocks || !LoadPallets)
    {
        return;
    }

    StorageCells->ClearInstances();
    TrackBeds->ClearInstances();
    InboundLiftPads->ClearInstances();
    OutboundLiftPads->ClearInstances();
    ParkingPads->ClearInstances();
    FloorPlates->ClearInstances();
    StorageRails->ClearInstances();
    RackPosts->ClearInstances();
    TransferRollers->ClearInstances();
    LiftBlocks->ClearInstances();
    LoadPallets->ClearInstances();
    StaticNodePositionsM.Empty();

    StaticSceneContract = FShuttleStaticSceneContractForSmoke();
    StaticSceneContract.StorageRows = StorageRows;
    StaticSceneContract.StorageColumns = StorageColumns;
    StaticSceneContract.StoragePitchXM = StoragePitchXM;
    StaticSceneContract.StoragePitchZM = StoragePitchZM;
    StaticSceneContract.StorageBlockMinXM = FirstStorageXM;
    StaticSceneContract.StorageBlockMaxXM = ColumnX(StorageColumns - 1);
    StaticSceneContract.StorageBlockMinZM = RowZ(0);
    StaticSceneContract.StorageBlockMaxZM = RowZ(StorageRows - 1);
    StaticSceneContract.InboundLiftXM = (LiftPortalX(0) + LiftPortalX(1) + LiftPortalX(2) + LiftPortalX(3)) * 0.25f;
    StaticSceneContract.OutboundLiftXM = StaticSceneContract.InboundLiftXM;
    StaticSceneContract.bSingleLevel = true;
    StaticSceneContract.StorageIslandCount = StorageColumnBays * StorageRowBanks;

    constexpr int32 MainNodeCount = StorageColumnBays + 2;
    const int32 LastMainIndex = MainNodeCount - 1;
    const float RightSpineXM = RightSpineX();
    const float StorageMaxXM = ColumnX(StorageColumns - 1);
    const float StorageMinZM = RowZ(0);
    const float StorageMaxZM = RowZ(StorageRows - 1);
    const auto TrackSide = [&](const float FromX, const float FromZ, const float ToX, const float ToZ) -> const TCHAR*
    {
        const float X = (FromX + ToX) * 0.5f;
        const float Z = (FromZ + ToZ) * 0.5f;
        if (X < FirstStorageXM)
        {
            return TEXT("left");
        }
        if (X > StorageMaxXM)
        {
            return TEXT("right");
        }
        if (Z < StorageMinZM)
        {
            return TEXT("top");
        }
        if (Z > StorageMaxZM)
        {
            return TEXT("bottom");
        }
        return TEXT("none");
    };
    const auto PadSide = [&](const float X) -> const TCHAR*
    {
        if (X < FirstStorageXM)
        {
            return TEXT("left");
        }
        if (X > StorageMaxXM)
        {
            return TEXT("right");
        }
        return TEXT("mixed");
    };
    const auto TrackCounterForCategory = [](const FString& Category) -> int32 FShuttleStaticSceneContractForSmoke::*
    {
        if (Category == TEXT("storageLane"))
        {
            return &FShuttleStaticSceneContractForSmoke::StorageLaneTrackCount;
        }
        if (Category == TEXT("sideAisle"))
        {
            return &FShuttleStaticSceneContractForSmoke::SideAisleTrackCount;
        }
        if (Category == TEXT("crossAisle"))
        {
            return &FShuttleStaticSceneContractForSmoke::CrossAisleTrackCount;
        }
        if (Category == TEXT("inboundConnector"))
        {
            return &FShuttleStaticSceneContractForSmoke::InboundConnectorTrackCount;
        }
        if (Category == TEXT("outboundConnector"))
        {
            return &FShuttleStaticSceneContractForSmoke::OutboundConnectorTrackCount;
        }
        return &FShuttleStaticSceneContractForSmoke::ParkingConnectorTrackCount;
    };
    const auto AddTrack = [&](
        const FString& Id,
        const FString& Category,
        const float FromX,
        const float FromZ,
        const float ToX,
        const float ToZ,
        const int32 Row
    )
    {
        const float DeltaX = FMath::Abs(ToX - FromX);
        const float DeltaZ = FMath::Abs(ToZ - FromZ);
        const bool bOrientationX = DeltaX >= DeltaZ;
        const float WidthM =
            Category == TEXT("storageLane")
                ? 0.08f
                : (Category == TEXT("inboundConnector") || Category == TEXT("outboundConnector") || Category == TEXT("parkingConnector"))
                    ? 0.12f
                    : 0.10f;
        AddTrackBedMeters(
            Id,
            Category,
            bOrientationX ? TEXT("x") : TEXT("z"),
            Row,
            TrackSide(FromX, FromZ, ToX, ToZ),
            (FromX + ToX) * 0.5f,
            (FromZ + ToZ) * 0.5f,
            bOrientationX ? DeltaX : WidthM,
            bOrientationX ? WidthM : DeltaZ,
            0.055f,
            TrackCounterForCategory(Category)
        );
    };

    const float FloorMinX = LeftSpineXM - ParkingStandoffXM;
    const float FloorMaxX = RightSpineXM + ParkingStandoffXM;
    const float FloorMinZ = TopLiftZ();
    const float FloorMaxZ = BottomLiftZ();
    AddInstanceMeters(
        FloorPlates,
        (FloorMinX + FloorMaxX) * 0.5f,
        (FloorMinZ + FloorMaxZ) * 0.5f,
        FloorMaxX - FloorMinX,
        FloorMaxZ - FloorMinZ,
        0.025f
    );
    StaticSceneContract.FloorPlateCount += 1;

    for (int32 Row = 0; Row < StorageRows; Row += 1)
    {
        const float Z = RowZ(Row);
        for (int32 Column = 0; Column < StorageColumns; Column += 1)
        {
            const float X = ColumnX(Column);
            AddStorageCellMeters(
                FString::Printf(TEXT("storage-r%02d-c%02d"), Row + 1, Column + 1),
                Row + 1,
                Column + 1,
                X,
                Z,
                1.12f,
                1.08f,
                0.04f
            );
        }
    }
    AddRackPostsForStorageGrid();

    AddTrack(TEXT("left-top-right-top"), TEXT("crossAisle"), LeftSpineXM, TopZ(), RightSpineXM, TopZ(), 0);
    AddTrack(TEXT("left-bottom-right-bottom"), TEXT("crossAisle"), LeftSpineXM, BottomZ(), RightSpineXM, BottomZ(), 0);

    for (int32 Index = 1; Index < MainNodeCount; Index += 1)
    {
        AddTrack(
            FString::Printf(TEXT("%s-%s"), *MainLaneNodeId(TEXT("north"), Index - 1), *MainLaneNodeId(TEXT("north"), Index)),
            TEXT("crossAisle"),
            MainX(Index - 1),
            MainLaneNorthZM,
            MainX(Index),
            MainLaneNorthZM,
            0
        );
        AddTrack(
            FString::Printf(TEXT("%s-%s"), *MainLaneNodeId(TEXT("south"), Index - 1), *MainLaneNodeId(TEXT("south"), Index)),
            TEXT("crossAisle"),
            MainX(Index - 1),
            MainLaneSouthZM,
            MainX(Index),
            MainLaneSouthZM,
            0
        );
    }
    for (int32 Index = 1; Index < LastMainIndex; Index += 1)
    {
        AddTrack(
            FString::Printf(TEXT("%s-%s"), *MainLaneNodeId(TEXT("north"), Index), *MainLaneNodeId(TEXT("south"), Index)),
            TEXT("sideAisle"),
            MainX(Index),
            MainLaneNorthZM,
            MainX(Index),
            MainLaneSouthZM,
            0
        );
    }

    const float RightParkingX = RightSpineXM + ParkingStandoffXM;
    const float LeftParkingX = LeftSpineXM - ParkingStandoffXM;
    AddTrack(TEXT("parking-a-main-north-right"), TEXT("parkingConnector"), RightParkingX, MainLaneNorthZM, RightSpineXM, MainLaneNorthZM, 0);
    AddTrack(TEXT("parking-b-main-south-right"), TEXT("parkingConnector"), RightParkingX, MainLaneSouthZM, RightSpineXM, MainLaneSouthZM, 0);
    AddTrack(TEXT("parking-c-main-north-left"), TEXT("parkingConnector"), LeftParkingX, MainLaneNorthZM, LeftSpineXM, MainLaneNorthZM, 0);
    AddTrack(TEXT("parking-d-main-south-left"), TEXT("parkingConnector"), LeftParkingX, MainLaneSouthZM, LeftSpineXM, MainLaneSouthZM, 0);

    struct FLiftPortDef
    {
        const TCHAR* Id;
        const TCHAR* Category;
        int32 PortalIndex;
        int32 MainIndex;
        float Z;
    };
    const FLiftPortDef LiftPorts[] = {
        { TEXT("inbound-lift-top-01"), TEXT("inboundConnector"), 0, 1, TopLiftZ() },
        { TEXT("outbound-lift-top-01"), TEXT("outboundConnector"), 1, 2, TopLiftZ() },
        { TEXT("inbound-lift-top-02"), TEXT("inboundConnector"), 2, 3, TopLiftZ() },
        { TEXT("outbound-lift-top-02"), TEXT("outboundConnector"), 3, 4, TopLiftZ() },
        { TEXT("outbound-lift-bottom-01"), TEXT("outboundConnector"), 0, 1, BottomLiftZ() },
        { TEXT("inbound-lift-bottom-01"), TEXT("inboundConnector"), 1, 2, BottomLiftZ() },
        { TEXT("outbound-lift-bottom-02"), TEXT("outboundConnector"), 2, 3, BottomLiftZ() },
        { TEXT("inbound-lift-bottom-02"), TEXT("inboundConnector"), 3, 4, BottomLiftZ() }
    };
    for (const FLiftPortDef& LiftPort : LiftPorts)
    {
        const float LiftX = LiftPortalX(LiftPort.PortalIndex);
        const FString NorthTargetNodeId = MainLaneNodeId(TEXT("north"), LiftPort.MainIndex);
        AddTrack(FString::Printf(TEXT("%s-%s"), LiftPort.Id, *NorthTargetNodeId), LiftPort.Category, LiftX, LiftPort.Z, MainX(LiftPort.MainIndex), MainLaneNorthZM, 0);
        const FString SouthTargetNodeId = MainLaneNodeId(TEXT("south"), LiftPort.MainIndex);
        AddTrack(FString::Printf(TEXT("%s-%s"), LiftPort.Id, *SouthTargetNodeId), LiftPort.Category, LiftX, LiftPort.Z, MainX(LiftPort.MainIndex), MainLaneSouthZM, 0);
    }

    struct FTrackPoint
    {
        FString Id;
        float X;
        float Z;
        int32 Row;
    };
    TArray<FTrackPoint> LeftSpinePoints;
    TArray<FTrackPoint> RightSpinePoints;
    LeftSpinePoints.Add({ TEXT("left-top"), LeftSpineXM, TopZ(), 0 });
    RightSpinePoints.Add({ TEXT("right-top"), RightSpineXM, TopZ(), 0 });
    for (int32 Row = 0; Row < StorageRowsPerBank; Row += 1)
    {
        LeftSpinePoints.Add({ FString::Printf(TEXT("left-row-%02d"), Row + 1), LeftSpineXM, RowZ(Row), Row + 1 });
        RightSpinePoints.Add({ FString::Printf(TEXT("right-row-%02d"), Row + 1), RightSpineXM, RowZ(Row), Row + 1 });
    }
    LeftSpinePoints.Add({ MainLaneNodeId(TEXT("north"), 0), LeftSpineXM, MainLaneNorthZM, 0 });
    LeftSpinePoints.Add({ MainLaneNodeId(TEXT("south"), 0), LeftSpineXM, MainLaneSouthZM, 0 });
    RightSpinePoints.Add({ MainLaneNodeId(TEXT("north"), LastMainIndex), RightSpineXM, MainLaneNorthZM, 0 });
    RightSpinePoints.Add({ MainLaneNodeId(TEXT("south"), LastMainIndex), RightSpineXM, MainLaneSouthZM, 0 });
    for (int32 Row = StorageRowsPerBank; Row < StorageRows; Row += 1)
    {
        LeftSpinePoints.Add({ FString::Printf(TEXT("left-row-%02d"), Row + 1), LeftSpineXM, RowZ(Row), Row + 1 });
        RightSpinePoints.Add({ FString::Printf(TEXT("right-row-%02d"), Row + 1), RightSpineXM, RowZ(Row), Row + 1 });
    }
    LeftSpinePoints.Add({ TEXT("left-bottom"), LeftSpineXM, BottomZ(), 0 });
    RightSpinePoints.Add({ TEXT("right-bottom"), RightSpineXM, BottomZ(), 0 });

    for (int32 Index = 1; Index < LeftSpinePoints.Num(); Index += 1)
    {
        const FTrackPoint& From = LeftSpinePoints[Index - 1];
        const FTrackPoint& To = LeftSpinePoints[Index];
        AddTrack(FString::Printf(TEXT("%s-%s"), *From.Id, *To.Id), TEXT("sideAisle"), From.X, From.Z, To.X, To.Z, FMath::Max(From.Row, To.Row));
    }
    for (int32 Index = 1; Index < RightSpinePoints.Num(); Index += 1)
    {
        const FTrackPoint& From = RightSpinePoints[Index - 1];
        const FTrackPoint& To = RightSpinePoints[Index];
        AddTrack(FString::Printf(TEXT("%s-%s"), *From.Id, *To.Id), TEXT("sideAisle"), From.X, From.Z, To.X, To.Z, FMath::Max(From.Row, To.Row));
    }

    for (int32 Row = 0; Row < StorageRows; Row += 1)
    {
        const float Z = RowZ(Row);
        const FString RowLabel = FString::Printf(TEXT("%02d"), Row + 1);
        const FString RightRowId = FString::Printf(TEXT("right-row-%s"), *RowLabel);
        const FString LeftRowId = FString::Printf(TEXT("left-row-%s"), *RowLabel);
        AddTrack(
            FString::Printf(TEXT("%s-storage-r%s-c%02d"), *RightRowId, *RowLabel, StorageColumns),
            TEXT("storageLane"),
            RightSpineXM,
            Z,
            ColumnX(StorageColumns - 1),
            Z,
            Row + 1
        );
        for (int32 Column = StorageColumns - 1; Column > 0; Column -= 1)
        {
            AddTrack(
                FString::Printf(TEXT("storage-r%s-c%02d-storage-r%s-c%02d"), *RowLabel, Column + 1, *RowLabel, Column),
                TEXT("storageLane"),
                ColumnX(Column),
                Z,
                ColumnX(Column - 1),
                Z,
                Row + 1
            );
        }
        AddTrack(
            FString::Printf(TEXT("storage-r%s-c01-%s"), *RowLabel, *LeftRowId),
            TEXT("storageLane"),
            ColumnX(0),
            Z,
            LeftSpineXM,
            Z,
            Row + 1
        );
    }

    AddInboundLiftPadMeters(TEXT("inbound-lift-top-01"), PadSide(LiftPortalX(0)), LiftPortalX(0), TopLiftZ(), 1.5f, 1.15f, 0.08f);
    AddInboundLiftPadMeters(TEXT("inbound-lift-top-02"), PadSide(LiftPortalX(2)), LiftPortalX(2), TopLiftZ(), 1.5f, 1.15f, 0.08f);
    AddInboundLiftPadMeters(TEXT("inbound-lift-bottom-01"), PadSide(LiftPortalX(1)), LiftPortalX(1), BottomLiftZ(), 1.5f, 1.15f, 0.08f);
    AddInboundLiftPadMeters(TEXT("inbound-lift-bottom-02"), PadSide(LiftPortalX(3)), LiftPortalX(3), BottomLiftZ(), 1.5f, 1.15f, 0.08f);
    AddOutboundLiftPadMeters(TEXT("outbound-lift-top-01"), PadSide(LiftPortalX(1)), LiftPortalX(1), TopLiftZ(), 1.5f, 1.15f, 0.08f);
    AddOutboundLiftPadMeters(TEXT("outbound-lift-top-02"), PadSide(LiftPortalX(3)), LiftPortalX(3), TopLiftZ(), 1.5f, 1.15f, 0.08f);
    AddOutboundLiftPadMeters(TEXT("outbound-lift-bottom-01"), PadSide(LiftPortalX(0)), LiftPortalX(0), BottomLiftZ(), 1.5f, 1.15f, 0.08f);
    AddOutboundLiftPadMeters(TEXT("outbound-lift-bottom-02"), PadSide(LiftPortalX(2)), LiftPortalX(2), BottomLiftZ(), 1.5f, 1.15f, 0.08f);
    AddParkingPadMeters(TEXT("parking-a"), TEXT("right"), RightParkingX, MainLaneNorthZM, 1.5f, 1.15f, 0.08f);
    AddParkingPadMeters(TEXT("parking-b"), TEXT("right"), RightParkingX, MainLaneSouthZM, 1.5f, 1.15f, 0.08f);
    AddParkingPadMeters(TEXT("parking-c"), TEXT("left"), LeftParkingX, MainLaneNorthZM, 1.5f, 1.15f, 0.08f);
    AddParkingPadMeters(TEXT("parking-d"), TEXT("left"), LeftParkingX, MainLaneSouthZM, 1.5f, 1.15f, 0.08f);
    FinalizeStaticSceneContract();
    RebuildLoadPalletInstances();
}

void AShuttleVisualTwinRuntimeActor::ConnectToBridge()
{
    UnbindStateSubscriber(false);

    UGameInstance* GameInstance = GetGameInstance();
    if (!GameInstance)
    {
        HandleBridgeStatus(false, TEXT("missing game instance"));
        return;
    }

    UShuttleStateSubscriberSubsystem* NextStateSubscriber = GameInstance->GetSubsystem<UShuttleStateSubscriberSubsystem>();
    if (!NextStateSubscriber)
    {
        HandleBridgeStatus(false, TEXT("missing shuttle state subscriber subsystem"));
        return;
    }

    StateSubscriber = NextStateSubscriber;
    StateSubscriber->OnVehicleStateNative.RemoveAll(this);
    StateSubscriber->OnLoadStatesNative.RemoveAll(this);
    StateSubscriber->OnBridgeStatusNative.RemoveAll(this);
    StateSubscriber->OnVehicleStateNative.AddUObject(this, &AShuttleVisualTwinRuntimeActor::HandleVehicleState);
    StateSubscriber->OnLoadStatesNative.AddUObject(this, &AShuttleVisualTwinRuntimeActor::HandleLoadStates);
    StateSubscriber->OnBridgeStatusNative.AddUObject(this, &AShuttleVisualTwinRuntimeActor::HandleBridgeStatus);
    StateSubscriber->Connect(WebSocketUrl);
}

void AShuttleVisualTwinRuntimeActor::DisconnectFromBridge()
{
    UnbindStateSubscriber(true);
}

int32 AShuttleVisualTwinRuntimeActor::GetStorageCellInstanceCount() const
{
    return StorageCells ? StorageCells->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetTrackBedInstanceCount() const
{
    return TrackBeds ? TrackBeds->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetInboundLiftPadInstanceCount() const
{
    return InboundLiftPads ? InboundLiftPads->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetOutboundLiftPadInstanceCount() const
{
    return OutboundLiftPads ? OutboundLiftPads->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetParkingPadInstanceCount() const
{
    return ParkingPads ? ParkingPads->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetFloorPlateInstanceCount() const
{
    return FloorPlates ? FloorPlates->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetStorageRailInstanceCount() const
{
    return StorageRails ? StorageRails->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetRackPostInstanceCount() const
{
    return RackPosts ? RackPosts->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetTransferRollerInstanceCount() const
{
    return TransferRollers ? TransferRollers->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetLiftBlockInstanceCount() const
{
    return LiftBlocks ? LiftBlocks->GetInstanceCount() : 0;
}

int32 AShuttleVisualTwinRuntimeActor::GetLoadPalletInstanceCount() const
{
    return LoadPallets ? LoadPallets->GetInstanceCount() : 0;
}

void AShuttleVisualTwinRuntimeActor::HandleVehicleState(const FShuttleVisualVehicleState& VehicleState)
{
    ApplyVehicleState(VehicleState);
}

void AShuttleVisualTwinRuntimeActor::HandleLoadStates(const TArray<FShuttleVisualLoadState>& LoadStates)
{
    ApplyLoadStates(LoadStates);
}

void AShuttleVisualTwinRuntimeActor::ApplyVehicleState(const FShuttleVisualVehicleState& VehicleState)
{
    AShuttleVisualTwinActor* VehicleActor = FindOrSpawnVehicleActor(VehicleState.Id);
    if (VehicleActor)
    {
        ReceivedVehicleStateCount += 1;
        LastAppliedVehicleStates.Add(VehicleState.Id, VehicleState);
        VehicleActor->ApplyAuthoritativeState(VehicleState);
    }
}

void AShuttleVisualTwinRuntimeActor::ApplyLoadStates(const TArray<FShuttleVisualLoadState>& LoadStates)
{
    LastAppliedLoadStates = LoadStates;
    RebuildLoadPalletInstances();
}

int32 AShuttleVisualTwinRuntimeActor::GetSpawnedVehicleActorCount() const
{
    int32 Count = 0;
    for (const TPair<FString, TWeakObjectPtr<AShuttleVisualTwinActor>>& Entry : VehicleActors)
    {
        if (Entry.Value.IsValid())
        {
            Count += 1;
        }
    }
    return Count;
}

int32 AShuttleVisualTwinRuntimeActor::GetReceivedVehicleStateCount() const
{
    return ReceivedVehicleStateCount;
}

AShuttleVisualTwinActor* AShuttleVisualTwinRuntimeActor::FindVehicleActorById(const FString& VehicleId) const
{
    if (const TWeakObjectPtr<AShuttleVisualTwinActor>* ExistingActor = VehicleActors.Find(VehicleId))
    {
        return ExistingActor->Get();
    }
    return nullptr;
}

TArray<FString> AShuttleVisualTwinRuntimeActor::GetObservedVehicleIdsForSmoke() const
{
    TArray<FString> VehicleIds;
    LastAppliedVehicleStates.GetKeys(VehicleIds);
    VehicleIds.Sort();
    return VehicleIds;
}

bool AShuttleVisualTwinRuntimeActor::TryGetLastAppliedVehicleStateForSmoke(const FString& VehicleId, FShuttleVisualVehicleState& OutState) const
{
    if (const FShuttleVisualVehicleState* State = LastAppliedVehicleStates.Find(VehicleId))
    {
        OutState = *State;
        return true;
    }
    return false;
}

int32 AShuttleVisualTwinRuntimeActor::GetVehicleActorCreationCountForSmoke() const
{
    return VehicleActorCreationCount;
}

int32 AShuttleVisualTwinRuntimeActor::GetOwnedDuplicateVehicleActorCountForSmoke() const
{
    const UWorld* World = GetWorld();
    if (!World)
    {
        return 0;
    }

    TSet<FString> SeenIds;
    int32 DuplicateCount = 0;
    for (TActorIterator<AShuttleVisualTwinActor> ActorIt(World); ActorIt; ++ActorIt)
    {
        const AShuttleVisualTwinActor* Actor = *ActorIt;
        if (!IsValid(Actor) || Actor->GetOwner() != this || Actor->VehicleId.IsEmpty())
        {
            continue;
        }
        if (SeenIds.Contains(Actor->VehicleId))
        {
            DuplicateCount += 1;
        }
        else
        {
            SeenIds.Add(Actor->VehicleId);
        }
    }
    return DuplicateCount;
}

FShuttleStaticSceneContractForSmoke AShuttleVisualTwinRuntimeActor::GetStaticSceneContractForSmoke() const
{
    return StaticSceneContract;
}

void AShuttleVisualTwinRuntimeActor::HandleBridgeStatus(bool bConnected, const FString& Detail)
{
    bBridgeConnected = bConnected;
    LastBridgeStatus = Detail;
    UE_LOG(LogShuttleVisualTwinRuntime, Display, TEXT("Shuttle bridge %s: %s"), bConnected ? TEXT("connected") : TEXT("not connected"), *Detail);
}

AShuttleVisualTwinActor* AShuttleVisualTwinRuntimeActor::FindOrSpawnVehicleActor(const FString& VehicleId)
{
    if (VehicleId.IsEmpty())
    {
        return nullptr;
    }

    if (const TWeakObjectPtr<AShuttleVisualTwinActor>* ExistingActor = VehicleActors.Find(VehicleId))
    {
        if (ExistingActor->IsValid())
        {
            return ExistingActor->Get();
        }
    }

    UWorld* World = GetWorld();
    if (!World)
    {
        return nullptr;
    }

    TSubclassOf<AShuttleVisualTwinActor> SpawnClass = VehicleActorClass;
    if (!SpawnClass)
    {
        SpawnClass = AShuttleVisualTwinActor::StaticClass();
    }
    FActorSpawnParameters SpawnParameters;
    SpawnParameters.Owner = this;
    SpawnParameters.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    AShuttleVisualTwinActor* NewActor = World->SpawnActor<AShuttleVisualTwinActor>(
        SpawnClass,
        GetActorLocation(),
        GetActorRotation(),
        SpawnParameters
    );
    if (!NewActor)
    {
        return nullptr;
    }

    NewActor->VehicleId = VehicleId;
    NewActor->WorldOffsetCm = GetActorLocation();
    NewActor->MeshYawOffsetDegrees = VehicleMeshYawOffsetDegrees;
    VehicleActors.Add(VehicleId, NewActor);
    VehicleActorCreationCount += 1;
    return NewActor;
}

void AShuttleVisualTwinRuntimeActor::AddStorageCellMeters(
    const FString& Id,
    const int32 Row,
    const int32 Column,
    float SimX,
    float SimZ,
    float SizeXM,
    float SizeZM,
    float HeightM
)
{
    AddInstanceMeters(StorageCells, SimX, SimZ, SizeXM, SizeZM, HeightM);
    AddStaticNodePosition(Id, SimX, SimZ);
    AddStorageRailGridForCellMeters(SimX, SimZ, SizeXM, SizeZM);
    FShuttleStaticSceneStorageCellForSmoke Cell;
    Cell.Id = Id;
    Cell.Row = Row;
    Cell.Column = Column;
    Cell.XM = SimX;
    Cell.YM = 0.0f;
    Cell.ZM = SimZ;
    Cell.LengthXM = SizeXM;
    Cell.LengthZM = SizeZM;
    StaticSceneContract.StorageCells.Add(Cell);
    StaticSceneContract.StorageCellCount += 1;
}

void AShuttleVisualTwinRuntimeActor::AddTrackBedMeters(
    const FString& Id,
    const FString& Category,
    const FString& Orientation,
    const int32 Row,
    const FString& Side,
    float SimX,
    float SimZ,
    float SizeXM,
    float SizeZM,
    float HeightM,
    int32 FShuttleStaticSceneContractForSmoke::*TrackCounter
)
{
    AddInstanceMeters(TrackBeds, SimX, SimZ, SizeXM, SizeZM, HeightM);
    FShuttleStaticSceneTrackBedForSmoke TrackBed;
    TrackBed.Id = Id;
    TrackBed.Category = Category;
    TrackBed.XM = SimX;
    TrackBed.YM = 0.0f;
    TrackBed.ZM = SimZ;
    TrackBed.LengthXM = SizeXM;
    TrackBed.LengthZM = SizeZM;
    TrackBed.Orientation = Orientation;
    TrackBed.Row = Row;
    TrackBed.Side = Side;
    StaticSceneContract.TrackBeds.Add(TrackBed);
    StaticSceneContract.TrackBedCount += 1;
    if (TrackCounter)
    {
        StaticSceneContract.*TrackCounter += 1;
    }
}

void AShuttleVisualTwinRuntimeActor::AddInboundLiftPadMeters(const FString& Id, const FString& Side, float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM)
{
    AddInstanceMeters(InboundLiftPads, SimX, SimZ, SizeXM, SizeZM, HeightM);
    AddStaticNodePosition(Id, SimX, SimZ);
    AddTransferRollersMeters(SimX, SimZ, SizeXM, SizeZM);
    AddLiftBlockMeters(SimX, SimZ, SizeXM, SizeZM);
    FShuttleStaticScenePadForSmoke Pad;
    Pad.Id = Id;
    Pad.Category = TEXT("inboundLift");
    Pad.XM = SimX;
    Pad.YM = 0.0f;
    Pad.ZM = SimZ;
    Pad.LengthXM = SizeXM;
    Pad.LengthZM = SizeZM;
    Pad.Side = Side;
    StaticSceneContract.LiftPads.Add(Pad);
    StaticSceneContract.InboundLiftPadCount += 1;
}

void AShuttleVisualTwinRuntimeActor::AddOutboundLiftPadMeters(const FString& Id, const FString& Side, float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM)
{
    AddInstanceMeters(OutboundLiftPads, SimX, SimZ, SizeXM, SizeZM, HeightM);
    AddStaticNodePosition(Id, SimX, SimZ);
    AddTransferRollersMeters(SimX, SimZ, SizeXM, SizeZM);
    AddLiftBlockMeters(SimX, SimZ, SizeXM, SizeZM);
    FShuttleStaticScenePadForSmoke Pad;
    Pad.Id = Id;
    Pad.Category = TEXT("outboundLift");
    Pad.XM = SimX;
    Pad.YM = 0.0f;
    Pad.ZM = SimZ;
    Pad.LengthXM = SizeXM;
    Pad.LengthZM = SizeZM;
    Pad.Side = Side;
    StaticSceneContract.LiftPads.Add(Pad);
    StaticSceneContract.OutboundLiftPadCount += 1;
}

void AShuttleVisualTwinRuntimeActor::AddParkingPadMeters(const FString& Id, const FString& Side, float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM)
{
    AddInstanceMeters(ParkingPads, SimX, SimZ, SizeXM, SizeZM, HeightM);
    AddStaticNodePosition(Id, SimX, SimZ);
    FShuttleStaticScenePadForSmoke Pad;
    Pad.Id = Id;
    Pad.Category = TEXT("parking");
    Pad.XM = SimX;
    Pad.YM = 0.0f;
    Pad.ZM = SimZ;
    Pad.LengthXM = SizeXM;
    Pad.LengthZM = SizeZM;
    Pad.Side = Side;
    StaticSceneContract.ParkingPads.Add(Pad);
    StaticSceneContract.ParkingPadCount += 1;
}

void AShuttleVisualTwinRuntimeActor::AddInstanceMeters(
    UInstancedStaticMeshComponent* Component,
    float SimX,
    float SimZ,
    float SizeXM,
    float SizeZM,
    float HeightM
) const
{
    if (!Component)
    {
        return;
    }

    const FVector LocationCm(SimX * 100.0f, SimZ * 100.0f, HeightM * 50.0f);
    const FVector Scale(SizeXM, SizeZM, HeightM);
    Component->AddInstance(FTransform(FRotator::ZeroRotator, LocationCm, Scale));
}

void AShuttleVisualTwinRuntimeActor::AddStorageRailGridForCellMeters(float SimX, float SimZ, float SizeXM, float SizeZM)
{
    if (!StorageRails)
    {
        return;
    }

    const float RailHeightM = 0.055f;
    const float RailWidthM = 0.035f;
    const float XRailLengthM = SizeXM * 0.92f;
    const float ZRailLengthM = SizeZM * 0.92f;
    const float RailOffsetXM = SizeXM * 0.34f;
    const float RailOffsetZM = SizeZM * 0.34f;

    AddInstanceMeters(StorageRails, SimX, SimZ - RailOffsetZM, XRailLengthM, RailWidthM, RailHeightM);
    AddInstanceMeters(StorageRails, SimX, SimZ + RailOffsetZM, XRailLengthM, RailWidthM, RailHeightM);
    AddInstanceMeters(StorageRails, SimX - RailOffsetXM, SimZ, RailWidthM, ZRailLengthM, RailHeightM);
    AddInstanceMeters(StorageRails, SimX + RailOffsetXM, SimZ, RailWidthM, ZRailLengthM, RailHeightM);
    StaticSceneContract.StorageRailSegmentCount += 4;
}

void AShuttleVisualTwinRuntimeActor::AddRackPostsForStorageGrid()
{
    if (!RackPosts)
    {
        return;
    }

    for (int32 Bank = 0; Bank < StorageRowBanks; Bank += 1)
    {
        const int32 FirstRow = Bank * StorageRowsPerBank;
        const int32 LastRow = FirstRow + StorageRowsPerBank - 1;
        const float MinZ = RowZ(FirstRow) - StoragePitchZM * 0.5f;
        const float MaxZ = RowZ(LastRow) + StoragePitchZM * 0.5f;
        for (int32 Bay = 0; Bay < StorageColumnBays; Bay += 1)
        {
            const int32 FirstColumn = Bay * StorageColumnsPerBay;
            const int32 LastColumn = FirstColumn + StorageColumnsPerBay - 1;
            const float MinX = ColumnX(FirstColumn) - StoragePitchXM * 0.5f;
            const float MaxX = ColumnX(LastColumn) + StoragePitchXM * 0.5f;
            for (int32 Column = 0; Column <= StorageColumnsPerBay; Column += 1)
            {
                const float X = MinX + static_cast<float>(Column) * ((MaxX - MinX) / static_cast<float>(StorageColumnsPerBay));
                for (int32 Row = 0; Row <= StorageRowsPerBank; Row += 1)
                {
                    const float Z = MinZ + static_cast<float>(Row) * ((MaxZ - MinZ) / static_cast<float>(StorageRowsPerBank));
                    AddInstanceMeters(RackPosts, X, Z, 0.045f, 0.045f, 0.24f);
                    StaticSceneContract.RackPostCount += 1;
                }
            }
        }
    }
}

void AShuttleVisualTwinRuntimeActor::AddTransferRollersMeters(float SimX, float SimZ, float SizeXM, float SizeZM)
{
    if (!TransferRollers)
    {
        return;
    }

    constexpr int32 RollerCount = 6;
    for (int32 RollerIndex = 0; RollerIndex < RollerCount; RollerIndex += 1)
    {
        const float Ratio = RollerCount <= 1 ? 0.5f : static_cast<float>(RollerIndex) / static_cast<float>(RollerCount - 1);
        const float OffsetX = FMath::Lerp(-SizeXM * 0.36f, SizeXM * 0.36f, Ratio);
        AddInstanceMeters(TransferRollers, SimX + OffsetX, SimZ, 0.045f, SizeZM * 0.78f, 0.06f);
        StaticSceneContract.TransferRollerCount += 1;
    }
}

void AShuttleVisualTwinRuntimeActor::AddLiftBlockMeters(float SimX, float SimZ, float SizeXM, float SizeZM)
{
    if (!LiftBlocks)
    {
        return;
    }

    const float SideDirection = SimX > ColumnX(StorageColumns - 1) ? 1.0f : (SimX < FirstStorageXM ? -1.0f : (SimZ >= 0.0f ? 1.0f : -1.0f));
    AddInstanceMeters(LiftBlocks, SimX + SideDirection * SizeXM * 0.55f, SimZ, SizeXM * 0.28f, SizeZM * 0.78f, 0.62f);
    StaticSceneContract.LiftBlockCount += 1;
}

void AShuttleVisualTwinRuntimeActor::AddStaticNodePosition(const FString& NodeId, float SimX, float SimZ)
{
    StaticNodePositionsM.Add(NodeId, FVector2D(SimX, SimZ));
}

void AShuttleVisualTwinRuntimeActor::RebuildLoadPalletInstances()
{
    if (!LoadPallets)
    {
        return;
    }

    LoadPallets->ClearInstances();
    for (const FShuttleVisualLoadState& LoadState : LastAppliedLoadStates)
    {
        if (LoadState.State == EShuttleVisualLoadStatus::Carried || LoadState.NodeId.IsEmpty())
        {
            continue;
        }

        const FVector2D* NodePosition = StaticNodePositionsM.Find(LoadState.NodeId);
        if (!NodePosition)
        {
            continue;
        }

        const bool bStorageLoad = LoadState.NodeId.StartsWith(TEXT("storage-"));
        AddInstanceMeters(
            LoadPallets,
            NodePosition->X,
            NodePosition->Y,
            bStorageLoad ? 1.04f : 0.82f,
            bStorageLoad ? 0.88f : 0.64f,
            0.18f
        );
    }
}

void AShuttleVisualTwinRuntimeActor::FinalizeStaticSceneContract()
{
    const int32 ExpectedStorageCells = StaticSceneContract.StorageRows * StaticSceneContract.StorageColumns;
    StaticSceneContract.bDenseStorageIslands =
        StaticSceneContract.StorageIslandCount == StorageColumnBays * StorageRowBanks &&
        StaticSceneContract.StorageCellCount == ExpectedStorageCells;
    StaticSceneContract.bDenseStorageBlock = false;

    StaticSceneContract.bOrthogonalTrackOnly =
        StaticSceneContract.DiagonalTrackCount == 0 &&
        StaticSceneContract.TrackBeds.Num() == StaticSceneContract.TrackBedCount &&
        StaticSceneContract.TrackBedCount ==
            StaticSceneContract.StorageLaneTrackCount +
            StaticSceneContract.SideAisleTrackCount +
            StaticSceneContract.CrossAisleTrackCount +
            StaticSceneContract.InboundConnectorTrackCount +
            StaticSceneContract.OutboundConnectorTrackCount +
            StaticSceneContract.ParkingConnectorTrackCount;

    StaticSceneContract.bDedicatedLiftPorts =
        StaticSceneContract.InboundLiftPadCount == 4 &&
        StaticSceneContract.OutboundLiftPadCount == 4 &&
        StaticSceneContract.LiftPads.Num() == 8 &&
        StaticSceneContract.ParkingPads.Num() == StaticSceneContract.ParkingPadCount;

    StaticSceneContract.bHasStorageRailGrid =
        StaticSceneContract.StorageRailSegmentCount == ExpectedStorageCells * 4 &&
        StaticSceneContract.StorageRailSegmentCount == (StorageRails ? StorageRails->GetInstanceCount() : 0);

    StaticSceneContract.bHasTransferRollers =
        StaticSceneContract.TransferRollerCount == 48 &&
        StaticSceneContract.TransferRollerCount == (TransferRollers ? TransferRollers->GetInstanceCount() : 0);

    StaticSceneContract.bHasLiftBlackBoxes =
        StaticSceneContract.LiftBlockCount == StaticSceneContract.InboundLiftPadCount + StaticSceneContract.OutboundLiftPadCount &&
        StaticSceneContract.LiftBlockCount == (LiftBlocks ? LiftBlocks->GetInstanceCount() : 0);
}

void AShuttleVisualTwinRuntimeActor::SetInstancedMesh(UInstancedStaticMeshComponent* Component, const FLinearColor& Color) const
{
    if (!Component)
    {
        return;
    }

    static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (CubeMesh.Succeeded())
    {
        Component->SetStaticMesh(CubeMesh.Object);
    }
    static ConstructorHelpers::FObjectFinder<UMaterialInterface> ShapeMaterial(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
    if (ShapeMaterial.Succeeded())
    {
        Component->SetMaterial(0, ShapeMaterial.Object);
        Component->SetVectorParameterValueOnMaterials(TEXT("Color"), FVector(Color.R, Color.G, Color.B));
    }
    Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void AShuttleVisualTwinRuntimeActor::UnbindStateSubscriber(const bool bDisconnect)
{
    if (!StateSubscriber.IsValid())
    {
        StateSubscriber.Reset();
        return;
    }

    StateSubscriber->OnVehicleStateNative.RemoveAll(this);
    StateSubscriber->OnLoadStatesNative.RemoveAll(this);
    StateSubscriber->OnBridgeStatusNative.RemoveAll(this);
    if (bDisconnect)
    {
        StateSubscriber->Disconnect();
        bBridgeConnected = false;
    }
    StateSubscriber.Reset();
    ReceivedVehicleStateCount = 0;
    LastAppliedVehicleStates.Empty();
    LastAppliedLoadStates.Empty();
    if (LoadPallets)
    {
        LoadPallets->ClearInstances();
    }
}
