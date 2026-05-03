#include "ShuttleVisualTwinActor.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "UObject/ConstructorHelpers.h"

AShuttleVisualTwinActor::AShuttleVisualTwinActor()
{
    PrimaryActorTick.bCanEverTick = true;
    Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
    SetRootComponent(Root);

    BodyMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("BodyMesh"));
    BodyMesh->SetupAttachment(Root);

    CarriedPalletMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("CarriedPalletMesh"));
    CarriedPalletMesh->SetupAttachment(Root);

    static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (CubeMesh.Succeeded())
    {
        BodyMesh->SetStaticMesh(CubeMesh.Object);
        CarriedPalletMesh->SetStaticMesh(CubeMesh.Object);
    }

    BodyMesh->SetRelativeLocation(FVector(0.0f, 0.0f, 12.5f));
    BodyMesh->SetRelativeScale3D(FVector(1.09f, 1.03f, 0.25f));
    BodyMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);

    CarriedPalletMesh->SetRelativeLocation(FVector(0.0f, 0.0f, 42.0f));
    CarriedPalletMesh->SetRelativeScale3D(FVector(1.20f, 1.00f, 0.16f));
    CarriedPalletMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    CarriedPalletMesh->SetVisibility(false, true);
}

void AShuttleVisualTwinActor::BeginPlay()
{
    Super::BeginPlay();
    TargetPosition = GetActorLocation();
    TargetRotation = GetActorRotation();
}

void AShuttleVisualTwinActor::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);

    const float Alpha = FMath::Clamp(DeltaSeconds * InterpolationSpeed, 0.0f, 1.0f);
    SetActorLocation(FMath::Lerp(GetActorLocation(), TargetPosition, Alpha));
    SetActorRotation(FMath::RInterpTo(GetActorRotation(), TargetRotation, DeltaSeconds, InterpolationSpeed));
}

void AShuttleVisualTwinActor::ApplyAuthoritativeState(const FShuttleVisualVehicleState& NextState)
{
    if (!VehicleId.IsEmpty() && VehicleId != NextState.Id)
    {
        return;
    }

    CurrentState = NextState;
    VehicleId = NextState.Id;

    // SimCore uses meters with Z as floor-depth. Unreal uses centimeters with Z as vertical.
    TargetPosition = WorldOffsetCm + FVector(NextState.Position.X * 100.0f, NextState.Position.Z * 100.0f, NextState.Position.Y * 100.0f);
    TargetRotation = FRotator(0.0f, FMath::RadiansToDegrees(NextState.YawRadians) + MeshYawOffsetDegrees, 0.0f);
    if (CarriedPalletMesh)
    {
        CarriedPalletMesh->SetVisibility(NextState.bLoaded, true);
    }
}

FVector AShuttleVisualTwinActor::GetTargetPositionCmForSmoke() const
{
    return TargetPosition;
}

FRotator AShuttleVisualTwinActor::GetTargetRotationForSmoke() const
{
    return TargetRotation;
}

bool AShuttleVisualTwinActor::HasVisibleDefaultGeometryForSmoke() const
{
    return BodyMesh && BodyMesh->GetStaticMesh() && BodyMesh->IsVisible();
}

bool AShuttleVisualTwinActor::IsCarriedPalletVisibleForSmoke() const
{
    return CarriedPalletMesh && CarriedPalletMesh->IsVisible();
}
