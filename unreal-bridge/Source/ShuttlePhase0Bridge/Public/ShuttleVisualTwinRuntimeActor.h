#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleVisualTwinRuntimeActor.generated.h"

class AShuttleVisualTwinActor;
class UInstancedStaticMeshComponent;
class USceneComponent;
class UShuttleStateSubscriberSubsystem;

UCLASS()
class SHUTTLEPHASE0BRIDGE_API AShuttleVisualTwinRuntimeActor : public AActor
{
    GENERATED_BODY()

public:
    AShuttleVisualTwinRuntimeActor();

    virtual void OnConstruction(const FTransform& Transform) override;
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle|Runtime")
    FString WebSocketUrl = TEXT("ws://localhost:8791/shuttle-ws");

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle|Runtime")
    bool bAutoConnect = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle|Runtime")
    bool bDisconnectOnEndPlay = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle|Runtime")
    TSubclassOf<AShuttleVisualTwinActor> VehicleActorClass;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle|Runtime")
    float VehicleMeshYawOffsetDegrees = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category = "Shuttle|Runtime")
    bool bBridgeConnected = false;

    UPROPERTY(BlueprintReadOnly, Category = "Shuttle|Runtime")
    FString LastBridgeStatus;

    UFUNCTION(BlueprintCallable, Category = "Shuttle|Runtime")
    void RebuildStaticScene();

    UFUNCTION(BlueprintCallable, Category = "Shuttle|Runtime")
    void ConnectToBridge();

    UFUNCTION(BlueprintCallable, Category = "Shuttle|Runtime")
    void DisconnectFromBridge();

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    int32 GetStorageCellInstanceCount() const;

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    int32 GetTrackBedInstanceCount() const;

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    int32 GetInboundLiftPadInstanceCount() const;

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    int32 GetOutboundLiftPadInstanceCount() const;

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    int32 GetParkingPadInstanceCount() const;

    UFUNCTION(BlueprintCallable, Category = "Shuttle|Runtime")
    void ApplyVehicleState(const FShuttleVisualVehicleState& VehicleState);

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    int32 GetSpawnedVehicleActorCount() const;

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    AShuttleVisualTwinActor* FindVehicleActorById(const FString& VehicleId) const;

protected:
    UPROPERTY(VisibleAnywhere, Category = "Shuttle|Scene")
    USceneComponent* Root;

    UPROPERTY(VisibleAnywhere, Category = "Shuttle|Scene")
    UInstancedStaticMeshComponent* StorageCells;

    UPROPERTY(VisibleAnywhere, Category = "Shuttle|Scene")
    UInstancedStaticMeshComponent* TrackBeds;

    UPROPERTY(VisibleAnywhere, Category = "Shuttle|Scene")
    UInstancedStaticMeshComponent* InboundLiftPads;

    UPROPERTY(VisibleAnywhere, Category = "Shuttle|Scene")
    UInstancedStaticMeshComponent* OutboundLiftPads;

    UPROPERTY(VisibleAnywhere, Category = "Shuttle|Scene")
    UInstancedStaticMeshComponent* ParkingPads;

private:
    UFUNCTION()
    void HandleVehicleState(const FShuttleVisualVehicleState& VehicleState);

    UFUNCTION()
    void HandleBridgeStatus(bool bConnected, const FString& Detail);

    AShuttleVisualTwinActor* FindOrSpawnVehicleActor(const FString& VehicleId);
    void AddInstanceMeters(UInstancedStaticMeshComponent* Component, float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM) const;
    void SetInstancedMesh(UInstancedStaticMeshComponent* Component) const;
    void UnbindStateSubscriber(bool bDisconnect);

    TWeakObjectPtr<UShuttleStateSubscriberSubsystem> StateSubscriber;
    TMap<FString, TWeakObjectPtr<AShuttleVisualTwinActor>> VehicleActors;
};
