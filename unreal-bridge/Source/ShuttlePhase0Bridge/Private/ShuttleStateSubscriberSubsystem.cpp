#include "ShuttleStateSubscriberSubsystem.h"

#include "Dom/JsonObject.h"
#include "IWebSocket.h"
#include "JsonObjectConverter.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "WebSocketsModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleStateSubscriber, Log, All);

void UShuttleStateSubscriberSubsystem::Deinitialize()
{
    Disconnect();
    Super::Deinitialize();
}

void UShuttleStateSubscriberSubsystem::Connect(const FString& WebSocketUrl)
{
    Disconnect();
    MessageStats = FShuttleBridgeMessageStats();

    UE_LOG(LogShuttleStateSubscriber, Display, TEXT("Connecting to %s"), *WebSocketUrl);

    if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
    {
        FModuleManager::Get().LoadModule(TEXT("WebSockets"));
    }

    Socket = FWebSocketsModule::Get().CreateWebSocket(WebSocketUrl);
    if (!Socket.IsValid())
    {
        UE_LOG(LogShuttleStateSubscriber, Error, TEXT("Failed to create WebSocket for %s"), *WebSocketUrl);
        BroadcastBridgeStatus(false, TEXT("failed to create websocket"));
        return;
    }

    Socket->OnConnected().AddLambda([this]()
    {
        UE_LOG(LogShuttleStateSubscriber, Display, TEXT("Connected."));
        BroadcastBridgeStatus(true, TEXT("connected"));
    });
    Socket->OnConnectionError().AddLambda([this](const FString& Error)
    {
        UE_LOG(LogShuttleStateSubscriber, Warning, TEXT("Connection error: %s"), *Error);
        BroadcastBridgeStatus(false, Error);
    });
    Socket->OnClosed().AddLambda([this](int32 StatusCode, const FString& Reason, bool)
    {
        UE_LOG(LogShuttleStateSubscriber, Display, TEXT("Closed %d %s"), StatusCode, *Reason);
        BroadcastBridgeStatus(false, FString::Printf(TEXT("closed %d %s"), StatusCode, *Reason));
    });
    Socket->OnMessage().AddUObject(this, &UShuttleStateSubscriberSubsystem::HandleMessage);
    Socket->Connect();
}

FShuttleBridgeMessageStats UShuttleStateSubscriberSubsystem::GetMessageStats() const
{
    return MessageStats;
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
        BroadcastBridgeStatus(false, TEXT("invalid JSON"));
        return;
    }

    FString Type;
    if (!RootObject->TryGetStringField(TEXT("type"), Type))
    {
        BroadcastBridgeStatus(false, TEXT("missing message type"));
        return;
    }

    if (Type == TEXT("kpiUpdate") || Type == TEXT("taskEvent"))
    {
        double SimTimeSec = 0.0;
        if (RootObject->TryGetNumberField(TEXT("simTimeSec"), SimTimeSec))
        {
            RecordSimTime(SimTimeSec);
        }

        if (Type == TEXT("kpiUpdate"))
        {
            MessageStats.KpiUpdateMessages += 1;
            const TSharedPtr<FJsonObject>* KpiObject = nullptr;
            if (RootObject->TryGetObjectField(TEXT("kpis"), KpiObject) && KpiObject)
            {
                RecordKpis(*KpiObject);
            }
        }
        else
        {
            MessageStats.TaskEventMessages += 1;
            const TArray<TSharedPtr<FJsonValue>>* Events = nullptr;
            if (RootObject->TryGetArrayField(TEXT("events"), Events) && Events)
            {
                RecordTaskEvents(*Events);
            }
        }
        return;
    }

    const TSharedPtr<FJsonObject>* StateObject = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* Vehicles = nullptr;
    TArray<FShuttleVisualLoadState> ParsedLoadStates;
    bool bHasLoadStates = false;
    if (Type == TEXT("connectionRecovered") || Type == TEXT("simState"))
    {
        if (Type == TEXT("connectionRecovered"))
        {
            MessageStats.ConnectionRecoveredMessages += 1;
        }
        else
        {
            MessageStats.SimStateMessages += 1;
        }

        if (!RootObject->TryGetObjectField(TEXT("state"), StateObject))
        {
            BroadcastBridgeStatus(false, FString::Printf(TEXT("%s missing state"), *Type));
            return;
        }
        if (!StateObject || !(*StateObject)->TryGetArrayField(TEXT("vehicles"), Vehicles))
        {
            BroadcastBridgeStatus(false, FString::Printf(TEXT("%s missing state.vehicles"), *Type));
            return;
        }

        double SimTimeSec = 0.0;
        if ((*StateObject)->TryGetNumberField(TEXT("simTimeSec"), SimTimeSec))
        {
            RecordSimTime(SimTimeSec);
        }
        const TSharedPtr<FJsonObject>* KpiObject = nullptr;
        if ((*StateObject)->TryGetObjectField(TEXT("kpis"), KpiObject) && KpiObject)
        {
            RecordKpis(*KpiObject);
        }

        const TArray<TSharedPtr<FJsonValue>>* Loads = nullptr;
        if ((*StateObject)->TryGetArrayField(TEXT("loads"), Loads) && Loads)
        {
            bHasLoadStates = true;
            ParsedLoadStates.Reserve(Loads->Num());
            for (const TSharedPtr<FJsonValue>& LoadValue : *Loads)
            {
                const TSharedPtr<FJsonObject> LoadObject = LoadValue->AsObject();
                if (!LoadObject.IsValid())
                {
                    BroadcastBridgeStatus(false, TEXT("load entry is not an object"));
                    continue;
                }

                FShuttleVisualLoadState ParsedLoad;
                FString ParseError;
                if (TryParseLoadState(LoadObject, ParsedLoad, ParseError))
                {
                    ParsedLoadStates.Add(ParsedLoad);
                }
                else
                {
                    BroadcastBridgeStatus(false, ParseError);
                }
            }
        }
        else
        {
            BroadcastBridgeStatus(true, FString::Printf(TEXT("%s state.loads unavailable"), *Type));
        }
    }
    else if (Type == TEXT("vehicleState"))
    {
        MessageStats.VehicleStateMessages += 1;
        double SimTimeSec = 0.0;
        if (RootObject->TryGetNumberField(TEXT("simTimeSec"), SimTimeSec))
        {
            RecordSimTime(SimTimeSec);
        }
        if (!RootObject->TryGetArrayField(TEXT("vehicles"), Vehicles))
        {
            BroadcastBridgeStatus(false, TEXT("vehicleState missing vehicles"));
            return;
        }
    }
    else
    {
        return;
    }

    if (Type == TEXT("connectionRecovered"))
    {
        MessageStats.VehicleUpdatesFromConnectionRecovered += Vehicles->Num();
    }
    else if (Type == TEXT("simState"))
    {
        MessageStats.VehicleUpdatesFromSimState += Vehicles->Num();
    }
    else if (Type == TEXT("vehicleState"))
    {
        MessageStats.VehicleUpdatesFromVehicleState += Vehicles->Num();
    }
    MessageStats.TotalVehicleUpdates += Vehicles->Num();

    for (const TSharedPtr<FJsonValue>& VehicleValue : *Vehicles)
    {
        const TSharedPtr<FJsonObject> VehicleObject = VehicleValue->AsObject();
        if (VehicleObject.IsValid())
        {
            FShuttleVisualVehicleState ParsedState;
            FString ParseError;
            if (TryParseVehicleState(VehicleObject, ParsedState, ParseError))
            {
                BroadcastVehicleState(ParsedState);
            }
            else
            {
                BroadcastBridgeStatus(false, ParseError);
            }
        }
    }

    if (bHasLoadStates)
    {
        BroadcastLoadStates(ParsedLoadStates);
    }
}

void UShuttleStateSubscriberSubsystem::BroadcastVehicleState(const FShuttleVisualVehicleState& VehicleState)
{
    OnVehicleState.Broadcast(VehicleState);
    OnVehicleStateNative.Broadcast(VehicleState);
}

void UShuttleStateSubscriberSubsystem::BroadcastLoadStates(const TArray<FShuttleVisualLoadState>& LoadStates)
{
    OnLoadStates.Broadcast(LoadStates);
    OnLoadStatesNative.Broadcast(LoadStates);
}

void UShuttleStateSubscriberSubsystem::BroadcastBridgeStatus(bool bConnected, const FString& Detail)
{
    OnBridgeStatus.Broadcast(bConnected, Detail);
    OnBridgeStatusNative.Broadcast(bConnected, Detail);
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

    EShuttleVisualOperationalState ParsedState = EShuttleVisualOperationalState::Idle;
    if (!TryParseStateValue(StateValue, ParsedState))
    {
        OutError = FString::Printf(TEXT("vehicle %s has unknown state %s"), *Id, *StateValue);
        return false;
    }

    OutState.Id = Id;
    OutState.State = ParsedState;
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

bool UShuttleStateSubscriberSubsystem::TryParseLoadState(const TSharedPtr<FJsonObject>& Object, FShuttleVisualLoadState& OutState, FString& OutError) const
{
    FString Id;
    FString StateValue;
    double WeightKg = 0.0;
    if (!Object->TryGetStringField(TEXT("id"), Id) || Id.IsEmpty())
    {
        OutError = TEXT("load missing required id");
        return false;
    }
    if (!Object->TryGetStringField(TEXT("state"), StateValue))
    {
        OutError = FString::Printf(TEXT("load %s missing required state"), *Id);
        return false;
    }
    EShuttleVisualLoadStatus ParsedState = EShuttleVisualLoadStatus::Waiting;
    if (!TryParseLoadStateValue(StateValue, ParsedState))
    {
        OutError = FString::Printf(TEXT("load %s has unknown state %s"), *Id, *StateValue);
        return false;
    }
    if (!Object->TryGetNumberField(TEXT("weightKg"), WeightKg))
    {
        OutError = FString::Printf(TEXT("load %s missing required weightKg"), *Id);
        return false;
    }

    OutState.Id = Id;
    OutState.State = ParsedState;
    Object->TryGetStringField(TEXT("nodeId"), OutState.NodeId);
    Object->TryGetStringField(TEXT("vehicleId"), OutState.VehicleId);
    OutState.WeightKg = static_cast<float>(WeightKg);
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

bool UShuttleStateSubscriberSubsystem::TryParseStateValue(const FString& Value, EShuttleVisualOperationalState& OutState) const
{
    if (Value == TEXT("idle"))
    {
        OutState = EShuttleVisualOperationalState::Idle;
        return true;
    }
    if (Value == TEXT("assigned"))
    {
        OutState = EShuttleVisualOperationalState::Assigned;
        return true;
    }
    if (Value == TEXT("moving-to-pickup"))
    {
        OutState = EShuttleVisualOperationalState::MovingToPickup;
        return true;
    }
    if (Value == TEXT("aligning-under-load"))
    {
        OutState = EShuttleVisualOperationalState::AligningUnderLoad;
        return true;
    }
    if (Value == TEXT("lifting"))
    {
        OutState = EShuttleVisualOperationalState::Lifting;
        return true;
    }
    if (Value == TEXT("loaded-moving"))
    {
        OutState = EShuttleVisualOperationalState::LoadedMoving;
        return true;
    }
    if (Value == TEXT("lowering"))
    {
        OutState = EShuttleVisualOperationalState::Lowering;
        return true;
    }
    if (Value == TEXT("returning"))
    {
        OutState = EShuttleVisualOperationalState::Returning;
        return true;
    }
    if (Value == TEXT("parking"))
    {
        OutState = EShuttleVisualOperationalState::Parking;
        return true;
    }
    if (Value == TEXT("waiting-blocked"))
    {
        OutState = EShuttleVisualOperationalState::WaitingBlocked;
        return true;
    }
    if (Value == TEXT("charging"))
    {
        OutState = EShuttleVisualOperationalState::Charging;
        return true;
    }
    if (Value == TEXT("faulted"))
    {
        OutState = EShuttleVisualOperationalState::Faulted;
        return true;
    }
    return false;
}

bool UShuttleStateSubscriberSubsystem::TryParseLoadStateValue(const FString& Value, EShuttleVisualLoadStatus& OutState) const
{
    if (Value == TEXT("waiting"))
    {
        OutState = EShuttleVisualLoadStatus::Waiting;
        return true;
    }
    if (Value == TEXT("carried"))
    {
        OutState = EShuttleVisualLoadStatus::Carried;
        return true;
    }
    if (Value == TEXT("stored"))
    {
        OutState = EShuttleVisualLoadStatus::Stored;
        return true;
    }
    if (Value == TEXT("delivered"))
    {
        OutState = EShuttleVisualLoadStatus::Delivered;
        return true;
    }
    return false;
}

void UShuttleStateSubscriberSubsystem::RecordSimTime(const double SimTimeSec)
{
    const float SimTime = static_cast<float>(SimTimeSec);
    if (!MessageStats.bHasSimTime)
    {
        MessageStats.FirstSimTimeSec = SimTime;
        MessageStats.bHasSimTime = true;
    }
    MessageStats.LastSimTimeSec = SimTime;
}

void UShuttleStateSubscriberSubsystem::RecordKpis(const TSharedPtr<FJsonObject>& KpiObject)
{
    if (!KpiObject.IsValid())
    {
        return;
    }

    FShuttleBridgeKpiTelemetry NextKpis;
    NextKpis.bHasKpi = true;

    double NumberValue = 0.0;
    if (KpiObject->TryGetNumberField(TEXT("inboundPph"), NumberValue))
    {
        NextKpis.InboundPph = static_cast<float>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("outboundPph"), NumberValue))
    {
        NextKpis.OutboundPph = static_cast<float>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("totalPph"), NumberValue))
    {
        NextKpis.TotalPph = static_cast<float>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("completedInbound"), NumberValue))
    {
        NextKpis.CompletedInbound = static_cast<int32>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("completedOutbound"), NumberValue))
    {
        NextKpis.CompletedOutbound = static_cast<int32>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("averageTaskCycleSec"), NumberValue))
    {
        NextKpis.AverageTaskCycleSec = static_cast<float>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("averageTaskWaitSec"), NumberValue))
    {
        NextKpis.AverageTaskWaitSec = static_cast<float>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("reservationConflictCount"), NumberValue))
    {
        NextKpis.ReservationConflictCount = static_cast<int32>(NumberValue);
    }
    if (KpiObject->TryGetNumberField(TEXT("deadlockCount"), NumberValue))
    {
        NextKpis.DeadlockCount = static_cast<int32>(NumberValue);
    }

    const TSharedPtr<FJsonObject>* BlockedTimeObject = nullptr;
    if (KpiObject->TryGetObjectField(TEXT("blockedTimeByReasonSec"), BlockedTimeObject) && BlockedTimeObject && BlockedTimeObject->IsValid())
    {
        for (const TPair<FString, TSharedPtr<FJsonValue>>& Entry : (*BlockedTimeObject)->Values)
        {
            double BlockedTimeSec = 0.0;
            if (Entry.Value.IsValid() && Entry.Value->TryGetNumber(BlockedTimeSec))
            {
                NextKpis.BlockedTimeByReasonSec.Add(Entry.Key, static_cast<float>(BlockedTimeSec));
            }
        }
    }

    MessageStats.LastKpis = NextKpis;
}

void UShuttleStateSubscriberSubsystem::RecordTaskEvents(const TArray<TSharedPtr<FJsonValue>>& Events)
{
    MessageStats.TaskEvents += Events.Num();
    for (const TSharedPtr<FJsonValue>& EventValue : Events)
    {
        const TSharedPtr<FJsonObject> EventObject = EventValue.IsValid() ? EventValue->AsObject() : nullptr;
        FString EventType;
        if (EventObject.IsValid() && EventObject->TryGetStringField(TEXT("eventType"), EventType) && EventType == TEXT("task-completed"))
        {
            MessageStats.CompletedTaskEvents += 1;
        }
    }
}
