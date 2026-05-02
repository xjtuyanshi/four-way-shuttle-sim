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

    FString Type;
    if (!RootObject->TryGetStringField(TEXT("type"), Type))
    {
        OnBridgeStatus.Broadcast(false, TEXT("missing message type"));
        return;
    }

    if (Type == TEXT("kpiUpdate") || Type == TEXT("taskEvent"))
    {
        return;
    }

    const TSharedPtr<FJsonObject>* StateObject = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* Vehicles = nullptr;
    if (Type == TEXT("connectionRecovered") || Type == TEXT("simState"))
    {
        if (!RootObject->TryGetObjectField(TEXT("state"), StateObject))
        {
            OnBridgeStatus.Broadcast(false, FString::Printf(TEXT("%s missing state"), *Type));
            return;
        }
        if (!StateObject || !(*StateObject)->TryGetArrayField(TEXT("vehicles"), Vehicles))
        {
            OnBridgeStatus.Broadcast(false, FString::Printf(TEXT("%s missing state.vehicles"), *Type));
            return;
        }
    }
    else if (Type == TEXT("vehicleState"))
    {
        if (!RootObject->TryGetArrayField(TEXT("vehicles"), Vehicles))
        {
            OnBridgeStatus.Broadcast(false, TEXT("vehicleState missing vehicles"));
            return;
        }
    }
    else
    {
        return;
    }

    for (const TSharedPtr<FJsonValue>& VehicleValue : *Vehicles)
    {
        const TSharedPtr<FJsonObject> VehicleObject = VehicleValue->AsObject();
        if (VehicleObject.IsValid())
        {
            FShuttleVisualVehicleState ParsedState;
            FString ParseError;
            if (TryParseVehicleState(VehicleObject, ParsedState, ParseError))
            {
                OnVehicleState.Broadcast(ParsedState);
            }
            else
            {
                OnBridgeStatus.Broadcast(false, ParseError);
            }
        }
    }
}

bool UShuttleStateSubscriberSubsystem::TryParseVehicleState(const TSharedPtr<FJsonObject>& Object, FShuttleVisualVehicleState& OutState, FString& OutError) const
{
    FString Id;
    FString StateValue;
    FString CurrentNodeId;
    double X = 0.0;
    double Y = 0.0;
    double Z = 0.0;
    double Yaw = 0.0;
    double Speed = 0.0;
    bool bLoaded = false;
    if (!Object->TryGetStringField(TEXT("id"), Id) || Id.IsEmpty())
    {
        OutError = TEXT("vehicle missing required id");
        return false;
    }
    if (!Object->TryGetStringField(TEXT("state"), StateValue))
    {
        OutError = FString::Printf(TEXT("vehicle %s missing required state"), *Id);
        return false;
    }
    if (!Object->TryGetNumberField(TEXT("x"), X) ||
        !Object->TryGetNumberField(TEXT("y"), Y) ||
        !Object->TryGetNumberField(TEXT("z"), Z) ||
        !Object->TryGetNumberField(TEXT("yaw"), Yaw) ||
        !Object->TryGetNumberField(TEXT("speedMps"), Speed) ||
        !Object->TryGetBoolField(TEXT("loaded"), bLoaded))
    {
        OutError = FString::Printf(TEXT("vehicle %s missing required pose/speed/load fields"), *Id);
        return false;
    }
    if (!Object->TryGetStringField(TEXT("currentNodeId"), CurrentNodeId))
    {
        OutError = FString::Printf(TEXT("vehicle %s missing required currentNodeId"), *Id);
        return false;
    }

    OutState.Id = Id;
    OutState.State = ParseState(StateValue);
    OutState.Position = FVector(X, Y, Z);
    OutState.YawRadians = static_cast<float>(Yaw);
    OutState.SpeedMps = static_cast<float>(Speed);
    OutState.bLoaded = bLoaded;
    Object->TryGetStringField(TEXT("taskId"), OutState.TaskId);
    OutState.CurrentNodeId = CurrentNodeId;
    Object->TryGetStringField(TEXT("currentEdgeId"), OutState.CurrentEdgeId);
    Object->TryGetStringField(TEXT("targetNodeId"), OutState.TargetNodeId);
    OutState.RouteNodeIds = ParseStringArray(Object, TEXT("routeNodeIds"));
    double NumberValue = 0.0;
    if (Object->TryGetNumberField(TEXT("routeIndex"), NumberValue))
    {
        OutState.RouteIndex = static_cast<int32>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("legRemainingM"), NumberValue))
    {
        OutState.LegRemainingM = static_cast<float>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("legElapsedSec"), NumberValue))
    {
        OutState.LegElapsedSec = static_cast<float>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("legTravelSec"), NumberValue))
    {
        OutState.LegTravelSec = static_cast<float>(NumberValue);
    }
    if (Object->TryGetNumberField(TEXT("phaseRemainingSec"), NumberValue))
    {
        OutState.PhaseRemainingSec = static_cast<float>(NumberValue);
    }
    Object->TryGetStringField(TEXT("waitReason"), OutState.WaitReason);
    Object->TryGetStringField(TEXT("blockingReservationId"), OutState.BlockingReservationId);
    Object->TryGetStringField(TEXT("blockingVehicleId"), OutState.BlockingVehicleId);
    return true;
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
