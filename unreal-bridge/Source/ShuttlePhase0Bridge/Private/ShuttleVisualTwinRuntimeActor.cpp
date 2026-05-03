#include "ShuttleVisualTwinRuntimeActor.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "ShuttleStateSubscriberSubsystem.h"
#include "ShuttleVisualTwinActor.h"
#include "UObject/ConstructorHelpers.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinRuntime, Log, All);

namespace
{
constexpr int32 StorageRows = 6;
constexpr int32 StorageColumns = 8;
constexpr float StoragePitchXM = 1.25f;
constexpr float StoragePitchZM = 1.2f;
constexpr float FirstStorageXM = 2.5f;
constexpr float LeftSpineXM = 0.0f;
constexpr float RightSpineXM = 14.0f;
constexpr float InboundXM = 18.0f;
constexpr float OutboundXM = -4.0f;
constexpr float TopZM = -4.8f;
constexpr float BottomZM = 4.8f;
constexpr float ParkingTopZM = -7.2f;
constexpr float ParkingBottomZM = 7.2f;

float RowZ(const int32 RowIndex)
{
    return (static_cast<float>(RowIndex) - (static_cast<float>(StorageRows - 1) / 2.0f)) * StoragePitchZM;
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

    SetInstancedMesh(StorageCells);
    SetInstancedMesh(TrackBeds);
    SetInstancedMesh(InboundLiftPads);
    SetInstancedMesh(OutboundLiftPads);
    SetInstancedMesh(ParkingPads);
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
    if (!StorageCells || !TrackBeds || !InboundLiftPads || !OutboundLiftPads || !ParkingPads)
    {
        return;
    }

    StorageCells->ClearInstances();
    TrackBeds->ClearInstances();
    InboundLiftPads->ClearInstances();
    OutboundLiftPads->ClearInstances();
    ParkingPads->ClearInstances();

    StaticSceneContract = FShuttleStaticSceneContractForSmoke();
    StaticSceneContract.StorageRows = StorageRows;
    StaticSceneContract.StorageColumns = StorageColumns;
    StaticSceneContract.StoragePitchXM = StoragePitchXM;
    StaticSceneContract.StoragePitchZM = StoragePitchZM;
    StaticSceneContract.StorageBlockMinXM = FirstStorageXM;
    StaticSceneContract.StorageBlockMaxXM = FirstStorageXM + static_cast<float>(StorageColumns - 1) * StoragePitchXM;
    StaticSceneContract.StorageBlockMinZM = RowZ(0);
    StaticSceneContract.StorageBlockMaxZM = RowZ(StorageRows - 1);
    StaticSceneContract.InboundLiftXM = InboundXM;
    StaticSceneContract.OutboundLiftXM = OutboundXM;
    StaticSceneContract.bSingleLevel = true;

    for (int32 Row = 0; Row < StorageRows; Row += 1)
    {
        const float Z = RowZ(Row);
        AddTrackBedMeters(
            FString::Printf(TEXT("storage-lane-r%02d"), Row + 1),
            TEXT("storageLane"),
            TEXT("x"),
            Row + 1,
            TEXT("none"),
            (LeftSpineXM + RightSpineXM) * 0.5f,
            Z,
            RightSpineXM - LeftSpineXM,
            0.08f,
            0.05f,
            &FShuttleStaticSceneContractForSmoke::StorageLaneTrackCount
        );

        for (int32 Column = 0; Column < StorageColumns; Column += 1)
        {
            const float X = FirstStorageXM + static_cast<float>(Column) * StoragePitchXM;
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

    AddTrackBedMeters(TEXT("side-aisle-left"), TEXT("sideAisle"), TEXT("z"), 0, TEXT("left"), LeftSpineXM, (TopZM + BottomZM) * 0.5f, 0.10f, BottomZM - TopZM, 0.055f, &FShuttleStaticSceneContractForSmoke::SideAisleTrackCount);
    AddTrackBedMeters(TEXT("side-aisle-right"), TEXT("sideAisle"), TEXT("z"), 0, TEXT("right"), RightSpineXM, (TopZM + BottomZM) * 0.5f, 0.10f, BottomZM - TopZM, 0.055f, &FShuttleStaticSceneContractForSmoke::SideAisleTrackCount);
    AddTrackBedMeters(TEXT("cross-aisle-top"), TEXT("crossAisle"), TEXT("x"), 0, TEXT("top"), (LeftSpineXM + RightSpineXM) * 0.5f, TopZM, RightSpineXM - LeftSpineXM, 0.10f, 0.055f, &FShuttleStaticSceneContractForSmoke::CrossAisleTrackCount);
    AddTrackBedMeters(TEXT("cross-aisle-bottom"), TEXT("crossAisle"), TEXT("x"), 0, TEXT("bottom"), (LeftSpineXM + RightSpineXM) * 0.5f, BottomZM, RightSpineXM - LeftSpineXM, 0.10f, 0.055f, &FShuttleStaticSceneContractForSmoke::CrossAisleTrackCount);

    AddTrackBedMeters(TEXT("inbound-lift-a-right-row-01"), TEXT("inboundConnector"), TEXT("x"), 1, TEXT("right"), (RightSpineXM + InboundXM) * 0.5f, RowZ(0), InboundXM - RightSpineXM, 0.12f, 0.055f, &FShuttleStaticSceneContractForSmoke::InboundConnectorTrackCount);
    AddTrackBedMeters(FString::Printf(TEXT("inbound-lift-b-right-row-%02d"), StorageRows), TEXT("inboundConnector"), TEXT("x"), StorageRows, TEXT("right"), (RightSpineXM + InboundXM) * 0.5f, RowZ(StorageRows - 1), InboundXM - RightSpineXM, 0.12f, 0.055f, &FShuttleStaticSceneContractForSmoke::InboundConnectorTrackCount);
    AddTrackBedMeters(TEXT("outbound-lift-a-left-row-01"), TEXT("outboundConnector"), TEXT("x"), 1, TEXT("left"), (OutboundXM + LeftSpineXM) * 0.5f, RowZ(0), LeftSpineXM - OutboundXM, 0.12f, 0.055f, &FShuttleStaticSceneContractForSmoke::OutboundConnectorTrackCount);
    AddTrackBedMeters(FString::Printf(TEXT("outbound-lift-b-left-row-%02d"), StorageRows), TEXT("outboundConnector"), TEXT("x"), StorageRows, TEXT("left"), (OutboundXM + LeftSpineXM) * 0.5f, RowZ(StorageRows - 1), LeftSpineXM - OutboundXM, 0.12f, 0.055f, &FShuttleStaticSceneContractForSmoke::OutboundConnectorTrackCount);

    AddTrackBedMeters(TEXT("parking-a-right-top"), TEXT("parkingConnector"), TEXT("z"), 0, TEXT("right"), RightSpineXM, (ParkingTopZM + TopZM) * 0.5f, 0.12f, TopZM - ParkingTopZM, 0.055f, &FShuttleStaticSceneContractForSmoke::ParkingConnectorTrackCount);
    AddTrackBedMeters(TEXT("parking-b-right-bottom"), TEXT("parkingConnector"), TEXT("z"), 0, TEXT("right"), RightSpineXM, (BottomZM + ParkingBottomZM) * 0.5f, 0.12f, ParkingBottomZM - BottomZM, 0.055f, &FShuttleStaticSceneContractForSmoke::ParkingConnectorTrackCount);

    AddInboundLiftPadMeters(TEXT("inbound-lift-a"), TEXT("right"), InboundXM, RowZ(0), 1.5f, 1.15f, 0.08f);
    AddInboundLiftPadMeters(TEXT("inbound-lift-b"), TEXT("right"), InboundXM, RowZ(StorageRows - 1), 1.5f, 1.15f, 0.08f);
    AddOutboundLiftPadMeters(TEXT("outbound-lift-a"), TEXT("left"), OutboundXM, RowZ(0), 1.5f, 1.15f, 0.08f);
    AddOutboundLiftPadMeters(TEXT("outbound-lift-b"), TEXT("left"), OutboundXM, RowZ(StorageRows - 1), 1.5f, 1.15f, 0.08f);
    AddParkingPadMeters(TEXT("parking-a"), TEXT("right"), RightSpineXM, ParkingTopZM, 1.5f, 1.15f, 0.08f);
    AddParkingPadMeters(TEXT("parking-b"), TEXT("right"), RightSpineXM, ParkingBottomZM, 1.5f, 1.15f, 0.08f);
    FinalizeStaticSceneContract();
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
    StateSubscriber->OnBridgeStatusNative.RemoveAll(this);
    StateSubscriber->OnVehicleStateNative.AddUObject(this, &AShuttleVisualTwinRuntimeActor::HandleVehicleState);
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

void AShuttleVisualTwinRuntimeActor::HandleVehicleState(const FShuttleVisualVehicleState& VehicleState)
{
    ApplyVehicleState(VehicleState);
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

void AShuttleVisualTwinRuntimeActor::FinalizeStaticSceneContract()
{
    const int32 ExpectedStorageCells = StaticSceneContract.StorageRows * StaticSceneContract.StorageColumns;
    StaticSceneContract.bDenseStorageBlock =
        StaticSceneContract.StorageRows == StorageRows &&
        StaticSceneContract.StorageColumns == StorageColumns &&
        StaticSceneContract.StorageCellCount == ExpectedStorageCells &&
        StaticSceneContract.StorageCells.Num() == ExpectedStorageCells &&
        StaticSceneContract.StoragePitchXM > 0.0f &&
        StaticSceneContract.StoragePitchZM > 0.0f;

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
        StaticSceneContract.InboundLiftPadCount == 2 &&
        StaticSceneContract.OutboundLiftPadCount == 2 &&
        StaticSceneContract.LiftPads.Num() == 4 &&
        StaticSceneContract.ParkingPads.Num() == StaticSceneContract.ParkingPadCount &&
        StaticSceneContract.InboundLiftXM > StaticSceneContract.StorageBlockMaxXM &&
        StaticSceneContract.OutboundLiftXM < StaticSceneContract.StorageBlockMinXM;
}

void AShuttleVisualTwinRuntimeActor::SetInstancedMesh(UInstancedStaticMeshComponent* Component) const
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
    StateSubscriber->OnBridgeStatusNative.RemoveAll(this);
    if (bDisconnect)
    {
        StateSubscriber->Disconnect();
        bBridgeConnected = false;
    }
    StateSubscriber.Reset();
    ReceivedVehicleStateCount = 0;
    LastAppliedVehicleStates.Empty();
}
