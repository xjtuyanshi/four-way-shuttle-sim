#include "ShuttleStateSubscriberSubsystem.h"

#include "Dom/JsonObject.h"
#include "IWebSocket.h"
#include "JsonObjectConverter.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "WebSocketsModule.h"

void UShuttleStateSubscriberSubsystem::Deinitialize()
{
    Disconnect();
    Super::Deinitialize();
}

void UShuttleStateSubscriberSubsystem::Connect(const FString& WebSocketUrl)
{
    Disconnect();

    if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
    {
        FModuleManager::Get().LoadModule(TEXT("WebSockets"));
    }

    Socket = FWebSocketsModule::Get().CreateWebSocket(WebSocketUrl);
    Socket->OnConnected().AddLambda([this]()
    {
        OnBridgeStatus.Broadcast(true, TEXT("connected"));
    });
    Socket->OnConnectionError().AddLambda([this](const FString& Error)
    {
        OnBridgeStatus.Broadcast(false, Error);
    });
    Socket->OnClosed().AddLambda([this](int32 StatusCode, const FString& Reason, bool)
    {
        OnBridgeStatus.Broadcast(false, FString::Printf(TEXT("closed %d %s"), StatusCode, *Reason));
    });
    Socket->OnMessage().AddUObject(this, &UShuttleStateSubscriberSubsystem::HandleMessage);
    Socket->Connect();
}

void UShuttleStateSubscriberSubsystem::Disconnect()
{
    if (Socket.IsValid())
    {
        Socket->Close();
        Socket.Reset();
    }
}

void UShuttleStateSubscriberSubsystem::HandleMessage(const FString& Message)
{
    TSharedPtr<FJsonObject> RootObject;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
    if (!FJsonSerializer::Deserialize(Reader, RootObject) || !RootObject.IsValid())
    {
        OnBridgeStatus.Broadcast(false, TEXT("invalid JSON"));
        return;
    }

    const FString Type = RootObject->GetStringField(TEXT("type"));
    const TSharedPtr<FJsonObject>* StateObject = nullptr;
    if (Type == TEXT("connectionRecovered") || Type == TEXT("simState"))
    {
        if (!RootObject->TryGetObjectField(TEXT("state"), StateObject))
        {
            return;
        }
    }
    else
    {
        return;
    }

    const TArray<TSharedPtr<FJsonValue>>* Vehicles = nullptr;
    if (!StateObject || !(*StateObject)->TryGetArrayField(TEXT("vehicles"), Vehicles))
    {
        return;
    }

    for (const TSharedPtr<FJsonValue>& VehicleValue : *Vehicles)
    {
        const TSharedPtr<FJsonObject> VehicleObject = VehicleValue->AsObject();
        if (VehicleObject.IsValid())
        {
            OnVehicleState.Broadcast(ParseVehicleState(VehicleObject));
        }
    }
}

FShuttleVisualVehicleState UShuttleStateSubscriberSubsystem::ParseVehicleState(const TSharedPtr<FJsonObject>& Object) const
{
    FShuttleVisualVehicleState State;
    State.Id = Object->GetStringField(TEXT("id"));
    State.State = ParseState(Object->GetStringField(TEXT("state")));
    State.Position = FVector(
        Object->GetNumberField(TEXT("x")),
        Object->GetNumberField(TEXT("y")),
        Object->GetNumberField(TEXT("z"))
    );
    State.YawRadians = Object->GetNumberField(TEXT("yaw"));
    State.SpeedMps = Object->GetNumberField(TEXT("speedMps"));
    State.bLoaded = Object->GetBoolField(TEXT("loaded"));
    Object->TryGetStringField(TEXT("taskId"), State.TaskId);
    Object->TryGetStringField(TEXT("currentNodeId"), State.CurrentNodeId);
    Object->TryGetStringField(TEXT("currentEdgeId"), State.CurrentEdgeId);
    Object->TryGetStringField(TEXT("targetNodeId"), State.TargetNodeId);
    State.RouteNodeIds = ParseStringArray(Object, TEXT("routeNodeIds"));
    double NumberValue = 0.0;
    if (Object->TryGetNumberField(TEXT("routeIndex"), NumberValue))
    {
        State.RouteIndex = static_cast<int32>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("legRemainingM"), NumberValue))
    {
        State.LegRemainingM = static_cast<float>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("legElapsedSec"), NumberValue))
    {
        State.LegElapsedSec = static_cast<float>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("legTravelSec"), NumberValue))
    {
        State.LegTravelSec = static_cast<float>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("phaseRemainingSec"), NumberValue))
    {
        State.PhaseRemainingSec = static_cast<float>(NumberValue);
    }
    Object->TryGetStringField(TEXT("waitReason"), State.WaitReason);
    Object->TryGetStringField(TEXT("blockingReservationId"), State.BlockingReservationId);
    Object->TryGetStringField(TEXT("blockingVehicleId"), State.BlockingVehicleId);
    return State;
}

TArray<FString> UShuttleStateSubscriberSubsystem::ParseStringArray(const TSharedPtr<FJsonObject>& Object, const FString& FieldName) const
{
    TArray<FString> Values;
    const TArray<TSharedPtr<FJsonValue>>* JsonValues = nullptr;
    if (!Object->TryGetArrayField(FieldName, JsonValues))
    {
        return Values;
    }

    for (const TSharedPtr<FJsonValue>& JsonValue : *JsonValues)
    {
        FString Value;
        if (JsonValue.IsValid() && JsonValue->TryGetString(Value))
        {
            Values.Add(Value);
        }
    }
    return Values;
}

EShuttleVisualOperationalState UShuttleStateSubscriberSubsystem::ParseState(const FString& Value) const
{
    if (Value == TEXT("assigned")) return EShuttleVisualOperationalState::Assigned;
    if (Value == TEXT("moving-to-pickup")) return EShuttleVisualOperationalState::MovingToPickup;
    if (Value == TEXT("aligning-under-load")) return EShuttleVisualOperationalState::AligningUnderLoad;
    if (Value == TEXT("lifting")) return EShuttleVisualOperationalState::Lifting;
    if (Value == TEXT("loaded-moving")) return EShuttleVisualOperationalState::LoadedMoving;
    if (Value == TEXT("lowering")) return EShuttleVisualOperationalState::Lowering;
    if (Value == TEXT("returning")) return EShuttleVisualOperationalState::Returning;
    if (Value == TEXT("parking")) return EShuttleVisualOperationalState::Parking;
    if (Value == TEXT("waiting-blocked")) return EShuttleVisualOperationalState::WaitingBlocked;
    if (Value == TEXT("charging")) return EShuttleVisualOperationalState::Charging;
    if (Value == TEXT("faulted")) return EShuttleVisualOperationalState::Faulted;
    return EShuttleVisualOperationalState::Idle;
}
