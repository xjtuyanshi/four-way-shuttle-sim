#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleStateSubscriberSubsystem.generated.h"

class IWebSocket;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnShuttleVehicleState, const FShuttleVisualVehicleState&, VehicleState);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnShuttleBridgeStatus, bool, bConnected, const FString&, Detail);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnShuttleVehicleStateNative, const FShuttleVisualVehicleState&);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnShuttleBridgeStatusNative, bool, const FString&);

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
    FOnShuttleBridgeStatus OnBridgeStatus;

    FOnShuttleVehicleStateNative OnVehicleStateNative;
    FOnShuttleBridgeStatusNative OnBridgeStatusNative;

private:
    void HandleMessage(const FString& Message);
    void BroadcastVehicleState(const FShuttleVisualVehicleState& VehicleState);
    void BroadcastBridgeStatus(bool bConnected, const FString& Detail);
    bool TryParseVehicleState(const TSharedPtr<FJsonObject>& Object, FShuttleVisualVehicleState& OutState, FString& OutError) const;
    TArray<FString> ParseStringArray(const TSharedPtr<FJsonObject>& Object, const FString& FieldName) const;
    EShuttleVisualOperationalState ParseState(const FString& Value) const;

    TSharedPtr<IWebSocket> Socket;
};
