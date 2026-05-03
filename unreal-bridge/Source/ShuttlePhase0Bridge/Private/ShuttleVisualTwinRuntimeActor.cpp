#include "ShuttleVisualTwinRuntimeActor.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
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

    for (int32 Row = 0; Row < StorageRows; Row += 1)
    {
        const float Z = RowZ(Row);
        AddInstanceMeters(TrackBeds, (LeftSpineXM + RightSpineXM) * 0.5f, Z, RightSpineXM - LeftSpineXM, 0.08f, 0.05f);

        for (int32 Column = 0; Column < StorageColumns; Column += 1)
        {
            const float X = FirstStorageXM + static_cast<float>(Column) * StoragePitchXM;
            AddInstanceMeters(StorageCells, X, Z, 1.12f, 1.08f, 0.04f);
        }
    }

    AddInstanceMeters(TrackBeds, LeftSpineXM, (TopZM + BottomZM) * 0.5f, 0.10f, BottomZM - TopZM, 0.055f);
    AddInstanceMeters(TrackBeds, RightSpineXM, (TopZM + BottomZM) * 0.5f, 0.10f, BottomZM - TopZM, 0.055f);
    AddInstanceMeters(TrackBeds, (LeftSpineXM + RightSpineXM) * 0.5f, TopZM, RightSpineXM - LeftSpineXM, 0.10f, 0.055f);
    AddInstanceMeters(TrackBeds, (LeftSpineXM + RightSpineXM) * 0.5f, BottomZM, RightSpineXM - LeftSpineXM, 0.10f, 0.055f);

    AddInstanceMeters(TrackBeds, (RightSpineXM + InboundXM) * 0.5f, RowZ(0), InboundXM - RightSpineXM, 0.12f, 0.055f);
    AddInstanceMeters(TrackBeds, (RightSpineXM + InboundXM) * 0.5f, RowZ(StorageRows - 1), InboundXM - RightSpineXM, 0.12f, 0.055f);
    AddInstanceMeters(TrackBeds, (OutboundXM + LeftSpineXM) * 0.5f, RowZ(0), LeftSpineXM - OutboundXM, 0.12f, 0.055f);
    AddInstanceMeters(TrackBeds, (OutboundXM + LeftSpineXM) * 0.5f, RowZ(StorageRows - 1), LeftSpineXM - OutboundXM, 0.12f, 0.055f);

    AddInstanceMeters(TrackBeds, RightSpineXM, (ParkingTopZM + TopZM) * 0.5f, 0.12f, TopZM - ParkingTopZM, 0.055f);
    AddInstanceMeters(TrackBeds, RightSpineXM, (BottomZM + ParkingBottomZM) * 0.5f, 0.12f, ParkingBottomZM - BottomZM, 0.055f);

    AddInstanceMeters(InboundLiftPads, InboundXM, RowZ(0), 1.5f, 1.15f, 0.08f);
    AddInstanceMeters(InboundLiftPads, InboundXM, RowZ(StorageRows - 1), 1.5f, 1.15f, 0.08f);
    AddInstanceMeters(OutboundLiftPads, OutboundXM, RowZ(0), 1.5f, 1.15f, 0.08f);
    AddInstanceMeters(OutboundLiftPads, OutboundXM, RowZ(StorageRows - 1), 1.5f, 1.15f, 0.08f);
    AddInstanceMeters(ParkingPads, RightSpineXM, ParkingTopZM, 1.5f, 1.15f, 0.08f);
    AddInstanceMeters(ParkingPads, RightSpineXM, ParkingBottomZM, 1.5f, 1.15f, 0.08f);
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
    StateSubscriber->OnVehicleState.RemoveDynamic(this, &AShuttleVisualTwinRuntimeActor::HandleVehicleState);
    StateSubscriber->OnBridgeStatus.RemoveDynamic(this, &AShuttleVisualTwinRuntimeActor::HandleBridgeStatus);
    StateSubscriber->OnVehicleState.AddDynamic(this, &AShuttleVisualTwinRuntimeActor::HandleVehicleState);
    StateSubscriber->OnBridgeStatus.AddDynamic(this, &AShuttleVisualTwinRuntimeActor::HandleBridgeStatus);
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

AShuttleVisualTwinActor* AShuttleVisualTwinRuntimeActor::FindVehicleActorById(const FString& VehicleId) const
{
    if (const TWeakObjectPtr<AShuttleVisualTwinActor>* ExistingActor = VehicleActors.Find(VehicleId))
    {
        return ExistingActor->Get();
    }
    return nullptr;
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
    return NewActor;
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

    StateSubscriber->OnVehicleState.RemoveDynamic(this, &AShuttleVisualTwinRuntimeActor::HandleVehicleState);
    StateSubscriber->OnBridgeStatus.RemoveDynamic(this, &AShuttleVisualTwinRuntimeActor::HandleBridgeStatus);
    if (bDisconnect)
    {
        StateSubscriber->Disconnect();
        bBridgeConnected = false;
    }
    StateSubscriber.Reset();
}
