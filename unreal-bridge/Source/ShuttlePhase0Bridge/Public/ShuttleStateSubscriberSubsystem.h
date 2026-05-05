#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleStateSubscriberSubsystem.generated.h"

class IWebSocket;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnShuttleVehicleState, const FShuttleVisualVehicleState&, VehicleState);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnShuttleLoadStates, const TArray<FShuttleVisualLoadState>&, LoadStates);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnShuttleBridgeStatus, bool, bConnected, const FString&, Detail);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnShuttleVehicleStateNative, const FShuttleVisualVehicleState&);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnShuttleLoadStatesNative, const TArray<FShuttleVisualLoadState>&);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnShuttleBridgeStatusNative, bool, const FString&);

USTRUCT(BlueprintType)
struct FShuttleBridgeKpiTelemetry
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly)
    bool bHasKpi = false;

    UPROPERTY(BlueprintReadOnly)
    float InboundPph = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float OutboundPph = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float TotalPph = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    int32 CompletedInbound = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 CompletedOutbound = 0;

    UPROPERTY(BlueprintReadOnly)
    float AverageTaskCycleSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float AverageTaskWaitSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    int32 ReservationConflictCount = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 DeadlockCount = 0;

    UPROPERTY(BlueprintReadOnly)
    TMap<FString, float> BlockedTimeByReasonSec;
};

USTRUCT(BlueprintType)
struct FShuttleBridgeMessageStats
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly)
    int32 ConnectionRecoveredMessages = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 SimStateMessages = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 VehicleStateMessages = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 KpiUpdateMessages = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 TaskEventMessages = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 VehicleUpdatesFromConnectionRecovered = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 VehicleUpdatesFromSimState = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 VehicleUpdatesFromVehicleState = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 TotalVehicleUpdates = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 TaskEvents = 0;

    UPROPERTY(BlueprintReadOnly)
    int32 CompletedTaskEvents = 0;

    UPROPERTY(BlueprintReadOnly)
    bool bHasSimTime = false;

    UPROPERTY(BlueprintReadOnly)
    float FirstSimTimeSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    float LastSimTimeSec = 0.0f;

    UPROPERTY(BlueprintReadOnly)
    FShuttleBridgeKpiTelemetry LastKpis;
};

UCLASS()
class SHUTTLEPHASE0BRIDGE_API UShuttleStateSubscriberSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Deinitialize() override;

    UFUNCTION(BlueprintCallable, Category = "Shuttle")
    void Connect(const FString& WebSocketUrl = TEXT("ws://localhost:8791/shuttle-ws"));

    UFUNCTION(BlueprintCallable, Category = "Shuttle")
    void Disconnect();

    UPROPERTY(BlueprintAssignable)
    FOnShuttleVehicleState OnVehicleState;

    UPROPERTY(BlueprintAssignable)
    FOnShuttleLoadStates OnLoadStates;

    UPROPERTY(BlueprintAssignable)
    FOnShuttleBridgeStatus OnBridgeStatus;

    UFUNCTION(BlueprintPure, Category = "Shuttle")
    FShuttleBridgeMessageStats GetMessageStats() const;

    FOnShuttleVehicleStateNative OnVehicleStateNative;
    FOnShuttleLoadStatesNative OnLoadStatesNative;
    FOnShuttleBridgeStatusNative OnBridgeStatusNative;

private:
    void HandleMessage(const FString& Message);
    void BroadcastVehicleState(const FShuttleVisualVehicleState& VehicleState);
    void BroadcastLoadStates(const TArray<FShuttleVisualLoadState>& LoadStates);
    void BroadcastBridgeStatus(bool bConnected, const FString& Detail);
    bool TryParseVehicleState(const TSharedPtr<FJsonObject>& Object, FShuttleVisualVehicleState& OutState, FString& OutError) const;
    bool TryParseLoadState(const TSharedPtr<FJsonObject>& Object, FShuttleVisualLoadState& OutState, FString& OutError) const;
    TArray<FString> ParseStringArray(const TSharedPtr<FJsonObject>& Object, const FString& FieldName) const;
    bool TryParseStateValue(const FString& Value, EShuttleVisualOperationalState& OutState) const;
    bool TryParseLoadStateValue(const FString& Value, EShuttleVisualLoadStatus& OutState) const;
    void RecordSimTime(double SimTimeSec);
    void RecordKpis(const TSharedPtr<FJsonObject>& KpiObject);
    void RecordTaskEvents(const TArray<TSharedPtr<FJsonValue>>& Events);

    TSharedPtr<IWebSocket> Socket;
    FShuttleBridgeMessageStats MessageStats;
};
