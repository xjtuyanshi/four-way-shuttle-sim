#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleVisualTwinActor.generated.h"

class UStaticMeshComponent;

UCLASS()
class SHUTTLEPHASE0BRIDGE_API AShuttleVisualTwinActor : public AActor
{
    GENERATED_BODY()

public:
    AShuttleVisualTwinActor();

    virtual void Tick(float DeltaSeconds) override;

    UFUNCTION(BlueprintCallable)
    void ApplyAuthoritativeState(const FShuttleVisualVehicleState& NextState);

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle")
    FString VehicleId;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle")
    float InterpolationSpeed = 8.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle")
    FVector WorldOffsetCm = FVector::ZeroVector;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle")
    float MeshYawOffsetDegrees = 0.0f;

    FVector GetTargetPositionCmForSmoke() const;
    FRotator GetTargetRotationForSmoke() const;
    bool HasVisibleDefaultGeometryForSmoke() const;
    bool IsCarriedPalletVisibleForSmoke() const;

protected:
    virtual void BeginPlay() override;

private:
    UPROPERTY()
    USceneComponent* Root;

    UPROPERTY()
    UStaticMeshComponent* BodyMesh;

    UPROPERTY()
    UStaticMeshComponent* CarriedPalletMesh;

    FShuttleVisualVehicleState CurrentState;
    FVector TargetPosition = FVector::ZeroVector;
    FRotator TargetRotation = FRotator::ZeroRotator;
};
