#pragma once

#include "CoreMinimal.h"
#include "ShuttleVisualStateTypes.generated.h"

UENUM(BlueprintType)
enum class EShuttleVisualOperationalState : uint8
{
    Idle,
    Assigned,
    MovingToPickup,
    AligningUnderLoad,
    Lifting,
    LoadedMoving,
    Lowering,
    Returning,
    Parking,
    WaitingBlocked,
    Charging,
    Faulted
};

USTRUCT(BlueprintType)
struct FShuttleVisualVehicleState
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly)
    FString Id;

    UPROPERTY(BlueprintReadOnly)
    EShuttleVisualOperationalState State = EShuttleVisualOperationalState::Idle;

    UPROPERTY(BlueprintReadOnly)
    FVector Position = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly)
    float YawRadians = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float SpeedMps = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    bool bLoaded = false;

    UPROPERTY(BlueprintReadOnly)
    FString TaskId;

    UPROPERTY(BlueprintReadOnly)
    FString CurrentNodeId;

    UPROPERTY(BlueprintReadOnly)
    FString CurrentEdgeId;

    UPROPERTY(BlueprintReadOnly)
    FString TargetNodeId;

    UPROPERTY(BlueprintReadOnly)
    TArray<FString> RouteNodeIds;

    UPROPERTY(BlueprintReadOnly)
    int32 RouteIndex = 0;

    UPROPERTY(BlueprintReadOnly)
    float LegRemainingM = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float LegElapsedSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float LegTravelSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float PhaseRemainingSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    FString WaitReason;

    UPROPERTY(BlueprintReadOnly)
    FString BlockingReservationId;

    UPROPERTY(BlueprintReadOnly)
    FString BlockingVehicleId;
};
