#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleVisualTwinRuntimeActor.generated.h"

class AShuttleVisualTwinActor;
class UInstancedStaticMeshComponent;
class USceneComponent;
class UShuttleStateSubscriberSubsystem;

struct FShuttleStaticSceneContractForSmoke
{
    int32 StorageRows = 0;
    int32 StorageColumns = 0;
    int32 StorageCellCount = 0;
    int32 TrackBedCount = 0;
    int32 StorageLaneTrackCount = 0;
    int32 SideAisleTrackCount = 0;
    int32 CrossAisleTrackCount = 0;
    int32 InboundConnectorTrackCount = 0;
    int32 OutboundConnectorTrackCount = 0;
    int32 ParkingConnectorTrackCount = 0;
    int32 DiagonalTrackCount = 0;
    int32 InboundLiftPadCount = 0;
    int32 OutboundLiftPadCount = 0;
    int32 ParkingPadCount = 0;
    float StoragePitchXM = 0.0f;
    float StoragePitchZM = 0.0f;
    float StorageBlockMinXM = 0.0f;
    float StorageBlockMaxXM = 0.0f;
    float StorageBlockMinZM = 0.0f;
    float StorageBlockMaxZM = 0.0f;
    float InboundLiftXM = 0.0f;
    float OutboundLiftXM = 0.0f;
    bool bSingleLevel = false;
    bool bDenseStorageBlock = false;
    bool bOrthogonalTrackOnly = false;
    bool bDedicatedLiftPorts = false;
};

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

    UPROPERTY(BlueprintReadOnly, Category = "Shuttle|Runtime")
    int32 ReceivedVehicleStateCount = 0;

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
    int32 GetReceivedVehicleStateCount() const;

    UFUNCTION(BlueprintPure, Category = "Shuttle|Runtime")
    AShuttleVisualTwinActor* FindVehicleActorById(const FString& VehicleId) const;

    TArray<FString> GetObservedVehicleIdsForSmoke() const;
    bool TryGetLastAppliedVehicleStateForSmoke(const FString& VehicleId, FShuttleVisualVehicleState& OutState) const;
    int32 GetVehicleActorCreationCountForSmoke() const;
    int32 GetOwnedDuplicateVehicleActorCountForSmoke() const;
    FShuttleStaticSceneContractForSmoke GetStaticSceneContractForSmoke() const;

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
    void AddStorageCellMeters(float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM);
    void AddTrackBedMeters(float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM, int32 FShuttleStaticSceneContractForSmoke::*TrackCounter);
    void AddInboundLiftPadMeters(float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM);
    void AddOutboundLiftPadMeters(float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM);
    void AddParkingPadMeters(float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM);
    void AddInstanceMeters(UInstancedStaticMeshComponent* Component, float SimX, float SimZ, float SizeXM, float SizeZM, float HeightM) const;
    void SetInstancedMesh(UInstancedStaticMeshComponent* Component) const;
    void UnbindStateSubscriber(bool bDisconnect);
    void FinalizeStaticSceneContract();

    TWeakObjectPtr<UShuttleStateSubscriberSubsystem> StateSubscriber;
    TMap<FString, TWeakObjectPtr<AShuttleVisualTwinActor>> VehicleActors;
    TMap<FString, FShuttleVisualVehicleState> LastAppliedVehicleStates;
    int32 VehicleActorCreationCount = 0;
    FShuttleStaticSceneContractForSmoke StaticSceneContract;
};
