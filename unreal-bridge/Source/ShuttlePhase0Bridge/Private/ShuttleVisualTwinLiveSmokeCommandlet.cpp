#include "ShuttleVisualTwinLiveSmokeCommandlet.h"

#include "Async/TaskGraphInterfaces.h"
#include "Containers/BackgroundableTicker.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "HAL/PlatformProcess.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "ShuttleStateSubscriberSubsystem.h"
#include "ShuttleVisualTwinActor.h"
#include "ShuttleVisualTwinRuntimeActor.h"

DEFINE_LOG_CATEGORY_STATIC(LogShuttleVisualTwinLiveSmoke, Log, All);

namespace
{
constexpr int32 MinimumVehicleStateUpdates = 4;

FVector ExpectedVehicleTargetCm(const AShuttleVisualTwinRuntimeActor* RuntimeActor, const FShuttleVisualVehicleState& VehicleState)
{
    const FVector RuntimeOffsetCm = RuntimeActor ? RuntimeActor->GetActorLocation() : FVector::ZeroVector;
    return RuntimeOffsetCm + FVector(VehicleState.Position.X * 100.0f, VehicleState.Position.Z * 100.0f, VehicleState.Position.Y * 100.0f);
}

void PumpLiveSmokeWorld(UWorld* World, const float DeltaSec)
{
    FTaskGraphInterface::Get().ProcessThreadUntilIdle(ENamedThreads::GameThread);
    FTSBackgroundableTicker::GetCoreTicker().Tick(DeltaSec);
    FTSTicker::GetCoreTicker().Tick(DeltaSec);
    if (World)
    {
        World->Tick(LEVELTICK_All, DeltaSec);
    }
}

TSharedPtr<FJsonObject> KpisToJson(const FShuttleBridgeKpiTelemetry& Kpis)
{
    TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetBoolField(TEXT("hasKpi"), Kpis.bHasKpi);
    Json->SetNumberField(TEXT("inboundPph"), Kpis.InboundPph);
    Json->SetNumberField(TEXT("outboundPph"), Kpis.OutboundPph);
    Json->SetNumberField(TEXT("totalPph"), Kpis.TotalPph);
    Json->SetNumberField(TEXT("completedInbound"), Kpis.CompletedInbound);
    Json->SetNumberField(TEXT("completedOutbound"), Kpis.CompletedOutbound);
    Json->SetNumberField(TEXT("averageTaskCycleSec"), Kpis.AverageTaskCycleSec);
    Json->SetNumberField(TEXT("averageTaskWaitSec"), Kpis.AverageTaskWaitSec);
    Json->SetNumberField(TEXT("reservationConflictCount"), Kpis.ReservationConflictCount);
    Json->SetNumberField(TEXT("deadlockCount"), Kpis.DeadlockCount);

    TSharedPtr<FJsonObject> BlockedTimeJson = MakeShared<FJsonObject>();
    for (const TPair<FString, float>& Entry : Kpis.BlockedTimeByReasonSec)
    {
        BlockedTimeJson->SetNumberField(Entry.Key, Entry.Value);
    }
    Json->SetObjectField(TEXT("blockedTimeByReasonSec"), BlockedTimeJson);
    return Json;
}

TSharedPtr<FJsonObject> MessageStatsToJson(const FShuttleBridgeMessageStats& Stats)
{
    TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetNumberField(TEXT("connectionRecovered"), Stats.ConnectionRecoveredMessages);
    Json->SetNumberField(TEXT("simState"), Stats.SimStateMessages);
    Json->SetNumberField(TEXT("vehicleState"), Stats.VehicleStateMessages);
    Json->SetNumberField(TEXT("kpiUpdate"), Stats.KpiUpdateMessages);
    Json->SetNumberField(TEXT("taskEvent"), Stats.TaskEventMessages);
    Json->SetNumberField(TEXT("vehicleUpdatesFromConnectionRecovered"), Stats.VehicleUpdatesFromConnectionRecovered);
    Json->SetNumberField(TEXT("vehicleUpdatesFromSimState"), Stats.VehicleUpdatesFromSimState);
    Json->SetNumberField(TEXT("vehicleUpdatesFromVehicleState"), Stats.VehicleUpdatesFromVehicleState);
    Json->SetNumberField(TEXT("totalVehicleUpdates"), Stats.TotalVehicleUpdates);
    Json->SetNumberField(TEXT("taskEvents"), Stats.TaskEvents);
    Json->SetNumberField(TEXT("completedTaskEvents"), Stats.CompletedTaskEvents);
    Json->SetBoolField(TEXT("hasSimTime"), Stats.bHasSimTime);
    Json->SetNumberField(TEXT("firstSimTimeSec"), Stats.FirstSimTimeSec);
    Json->SetNumberField(TEXT("lastSimTimeSec"), Stats.LastSimTimeSec);
    Json->SetNumberField(TEXT("simTimeSpanSec"), Stats.bHasSimTime ? Stats.LastSimTimeSec - Stats.FirstSimTimeSec : 0.0f);
    Json->SetObjectField(TEXT("lastKpis"), KpisToJson(Stats.LastKpis));
    return Json;
}

bool WriteJsonSummary(const FString& SummaryPath, const TSharedRef<FJsonObject>& Summary)
{
    if (SummaryPath.IsEmpty())
    {
        return true;
    }

    FString Output;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
    if (!FJsonSerializer::Serialize(Summary, Writer))
    {
        return false;
    }

    const FString Directory = FPaths::GetPath(SummaryPath);
    if (!Directory.IsEmpty())
    {
        IFileManager::Get().MakeDirectory(*Directory, true);
    }
    return FFileHelper::SaveStringToFile(Output, *SummaryPath);
}
}

UShuttleVisualTwinLiveSmokeCommandlet::UShuttleVisualTwinLiveSmokeCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
}

int32 UShuttleVisualTwinLiveSmokeCommandlet::Main(const FString& Params)
{
    if (!GEngine)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Missing engine."));
        return 1;
    }

    FString WebSocketUrl = TEXT("ws://127.0.0.1:8791/shuttle-ws");
    FParse::Value(*Params, TEXT("ShuttleWsUrl="), WebSocketUrl);

    float TimeoutSec = 8.0f;
    FParse::Value(*Params, TEXT("ShuttleLiveSmokeTimeoutSec="), TimeoutSec);
    TimeoutSec = FMath::Clamp(TimeoutSec, 1.0f, 60.0f);

    int32 ExpectedVehicleCount = 2;
    FParse::Value(*Params, TEXT("ShuttleExpectedVehicleCount="), ExpectedVehicleCount);
    ExpectedVehicleCount = FMath::Max(0, ExpectedVehicleCount);

    float MinSimTimeAdvanceSec = 0.1f;
    FParse::Value(*Params, TEXT("ShuttleMinSimTimeAdvanceSec="), MinSimTimeAdvanceSec);
    MinSimTimeAdvanceSec = FMath::Clamp(MinSimTimeAdvanceSec, 0.0f, 10.0f);

    float PoseToleranceCm = 0.1f;
    FParse::Value(*Params, TEXT("ShuttlePoseToleranceCm="), PoseToleranceCm);
    PoseToleranceCm = FMath::Clamp(PoseToleranceCm, 0.0f, 100.0f);

    FString SummaryPath;
    FParse::Value(*Params, TEXT("ShuttleLiveSmokeSummaryPath="), SummaryPath);

    UGameInstance* GameInstance = NewObject<UGameInstance>(GEngine, UGameInstance::StaticClass());
    if (!GameInstance)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to create game instance."));
        return 1;
    }

    GameInstance->InitializeStandalone(TEXT("ShuttleVisualTwinLiveSmokeWorld"));
    UWorld* World = GameInstance->GetWorld();
    if (!World)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to create live smoke world."));
        GameInstance->Shutdown();
        return 1;
    }

    int32 Result = 0;
    AShuttleVisualTwinRuntimeActor* RuntimeActor = World->SpawnActor<AShuttleVisualTwinRuntimeActor>();
    if (!RuntimeActor)
    {
        UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to spawn AShuttleVisualTwinRuntimeActor."));
        Result = 1;
    }
    else
    {
        RuntimeActor->bAutoConnect = false;
        RuntimeActor->WebSocketUrl = WebSocketUrl;
        RuntimeActor->RebuildStaticScene();
        RuntimeActor->ConnectToBridge();
        UShuttleStateSubscriberSubsystem* StateSubscriber = GameInstance->GetSubsystem<UShuttleStateSubscriberSubsystem>();

        const double DeadlineSec = FPlatformTime::Seconds() + static_cast<double>(TimeoutSec);

        while (FPlatformTime::Seconds() < DeadlineSec)
        {
            PumpLiveSmokeWorld(World, 0.05f);
            const FShuttleBridgeMessageStats Stats = StateSubscriber ? StateSubscriber->GetMessageStats() : FShuttleBridgeMessageStats();
            const float SimTimeSpanSec = Stats.bHasSimTime ? Stats.LastSimTimeSec - Stats.FirstSimTimeSec : 0.0f;

            if (RuntimeActor->bBridgeConnected &&
                (ExpectedVehicleCount == 0 || RuntimeActor->GetSpawnedVehicleActorCount() == ExpectedVehicleCount) &&
                Stats.ConnectionRecoveredMessages > 0 &&
                Stats.SimStateMessages > 0 &&
                Stats.VehicleStateMessages > 0 &&
                Stats.KpiUpdateMessages > 0 &&
                Stats.LastKpis.bHasKpi &&
                SimTimeSpanSec >= MinSimTimeAdvanceSec &&
                RuntimeActor->GetReceivedVehicleStateCount() >= MinimumVehicleStateUpdates)
            {
                break;
            }

            FPlatformProcess::Sleep(0.05f);
        }

        const FShuttleBridgeMessageStats Stats = StateSubscriber ? StateSubscriber->GetMessageStats() : FShuttleBridgeMessageStats();
        const float SimTimeSpanSec = Stats.bHasSimTime ? Stats.LastSimTimeSec - Stats.FirstSimTimeSec : 0.0f;
        const int32 SpawnedVehicleActorCount = RuntimeActor->GetSpawnedVehicleActorCount();
        const int32 DuplicateVehicleActorCount = RuntimeActor->GetOwnedDuplicateVehicleActorCountForSmoke();
        const TArray<FString> ObservedVehicleIds = RuntimeActor->GetObservedVehicleIdsForSmoke();

        float MaxTargetPoseErrorCm = 0.0f;
        float MaxTargetYawErrorDeg = 0.0f;
        int32 MissingVehicleActorCount = 0;
        int32 LoadMismatchCount = 0;
        TArray<TSharedPtr<FJsonValue>> PoseChecksJson;

        for (const FString& VehicleId : ObservedVehicleIds)
        {
            FShuttleVisualVehicleState LastState;
            const bool bHasState = RuntimeActor->TryGetLastAppliedVehicleStateForSmoke(VehicleId, LastState);
            AShuttleVisualTwinActor* VehicleActor = RuntimeActor->FindVehicleActorById(VehicleId);
            if (!bHasState || !VehicleActor)
            {
                MissingVehicleActorCount += 1;
                continue;
            }

            const FVector ExpectedPositionCm = ExpectedVehicleTargetCm(RuntimeActor, LastState);
            const float TargetPoseErrorCm = FVector::Dist(ExpectedPositionCm, VehicleActor->GetTargetPositionCmForSmoke());
            const float ExpectedYawDeg = FMath::RadiansToDegrees(LastState.YawRadians) + RuntimeActor->VehicleMeshYawOffsetDegrees;
            const float TargetYawErrorDeg = FMath::Abs(FMath::FindDeltaAngleDegrees(ExpectedYawDeg, VehicleActor->GetTargetRotationForSmoke().Yaw));
            const bool bLoadVisible = VehicleActor->IsCarriedPalletVisibleForSmoke();
            if (bLoadVisible != LastState.bLoaded)
            {
                LoadMismatchCount += 1;
            }

            MaxTargetPoseErrorCm = FMath::Max(MaxTargetPoseErrorCm, TargetPoseErrorCm);
            MaxTargetYawErrorDeg = FMath::Max(MaxTargetYawErrorDeg, TargetYawErrorDeg);

            TSharedPtr<FJsonObject> PoseCheckJson = MakeShared<FJsonObject>();
            PoseCheckJson->SetStringField(TEXT("vehicleId"), VehicleId);
            PoseCheckJson->SetNumberField(TEXT("targetPoseErrorCm"), TargetPoseErrorCm);
            PoseCheckJson->SetNumberField(TEXT("targetYawErrorDeg"), TargetYawErrorDeg);
            PoseCheckJson->SetBoolField(TEXT("expectedLoaded"), LastState.bLoaded);
            PoseCheckJson->SetBoolField(TEXT("palletVisible"), bLoadVisible);
            PoseChecksJson.Add(MakeShared<FJsonValueObject>(PoseCheckJson));
        }

        const int32 CompletedTasksFromKpi = Stats.LastKpis.CompletedInbound + Stats.LastKpis.CompletedOutbound;
        FString KpiParityStatus = Stats.LastKpis.bHasKpi ? TEXT("streamed-kpi-captured") : TEXT("missing-kpi");
        if (Stats.CompletedTaskEvents > 0)
        {
            KpiParityStatus = Stats.CompletedTaskEvents == CompletedTasksFromKpi ? TEXT("matched") : TEXT("mismatch");
        }

        const bool bExpectedVehicleCountOk = ExpectedVehicleCount == 0 || SpawnedVehicleActorCount == ExpectedVehicleCount;
        const bool bPass =
            RuntimeActor->bBridgeConnected &&
            bExpectedVehicleCountOk &&
            RuntimeActor->GetReceivedVehicleStateCount() >= MinimumVehicleStateUpdates &&
            Stats.ConnectionRecoveredMessages > 0 &&
            Stats.SimStateMessages > 0 &&
            Stats.VehicleStateMessages > 0 &&
            Stats.KpiUpdateMessages > 0 &&
            Stats.LastKpis.bHasKpi &&
            SimTimeSpanSec >= MinSimTimeAdvanceSec &&
            DuplicateVehicleActorCount == 0 &&
            MissingVehicleActorCount == 0 &&
            MaxTargetPoseErrorCm <= PoseToleranceCm &&
            MaxTargetYawErrorDeg <= 0.1f &&
            LoadMismatchCount == 0;

        TSharedRef<FJsonObject> Summary = MakeShared<FJsonObject>();
        Summary->SetStringField(TEXT("schemaVersion"), TEXT("shuttle.unrealLiveSmoke.v1"));
        Summary->SetBoolField(TEXT("pass"), bPass);
        Summary->SetStringField(TEXT("webSocketUrl"), WebSocketUrl);
        Summary->SetBoolField(TEXT("connected"), RuntimeActor->bBridgeConnected);
        Summary->SetStringField(TEXT("bridgeStatus"), RuntimeActor->LastBridgeStatus);
        Summary->SetNumberField(TEXT("expectedVehicleCount"), ExpectedVehicleCount);
        Summary->SetNumberField(TEXT("vehicleActorCount"), SpawnedVehicleActorCount);
        Summary->SetNumberField(TEXT("vehicleActorCreationCount"), RuntimeActor->GetVehicleActorCreationCountForSmoke());
        Summary->SetNumberField(TEXT("duplicateVehicleActorCount"), DuplicateVehicleActorCount);
        Summary->SetNumberField(TEXT("receivedVehicleStateCount"), RuntimeActor->GetReceivedVehicleStateCount());
        Summary->SetNumberField(TEXT("requiredVehicleStateCount"), MinimumVehicleStateUpdates);
        Summary->SetNumberField(TEXT("minSimTimeAdvanceSec"), MinSimTimeAdvanceSec);
        Summary->SetNumberField(TEXT("poseToleranceCm"), PoseToleranceCm);
        Summary->SetNumberField(TEXT("maxTargetPoseErrorCm"), MaxTargetPoseErrorCm);
        Summary->SetNumberField(TEXT("maxTargetYawErrorDeg"), MaxTargetYawErrorDeg);
        Summary->SetNumberField(TEXT("loadMismatchCount"), LoadMismatchCount);
        Summary->SetNumberField(TEXT("missingVehicleActorCount"), MissingVehicleActorCount);
        Summary->SetStringField(TEXT("kpiParityStatus"), KpiParityStatus);

        TArray<TSharedPtr<FJsonValue>> VehicleIdsJson;
        for (const FString& VehicleId : ObservedVehicleIds)
        {
            VehicleIdsJson.Add(MakeShared<FJsonValueString>(VehicleId));
        }
        Summary->SetArrayField(TEXT("observedVehicleIds"), VehicleIdsJson);
        Summary->SetArrayField(TEXT("poseChecks"), PoseChecksJson);
        Summary->SetObjectField(TEXT("messageStats"), MessageStatsToJson(Stats));
        Summary->SetObjectField(TEXT("ieMetrics"), KpisToJson(Stats.LastKpis));

        if (!WriteJsonSummary(SummaryPath, Summary))
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Failed to write live smoke summary to %s"), *SummaryPath);
            Result = 1;
        }

        UE_LOG(
            LogShuttleVisualTwinLiveSmoke,
            Display,
            TEXT("Live bridge smoke: pass=%s connected=%s status='%s' vehicleActors=%d expectedVehicleActors=%d receivedVehicleStates=%d requiredVehicleStates=%d connectionRecovered=%d simState=%d vehicleState=%d kpiUpdate=%d hasKpi=%s simTimeSpanSec=%.3f duplicateVehicleActors=%d maxTargetPoseErrorCm=%.3f loadMismatches=%d summary='%s'"),
            bPass ? TEXT("true") : TEXT("false"),
            RuntimeActor->bBridgeConnected ? TEXT("true") : TEXT("false"),
            *RuntimeActor->LastBridgeStatus,
            SpawnedVehicleActorCount,
            ExpectedVehicleCount,
            RuntimeActor->GetReceivedVehicleStateCount(),
            MinimumVehicleStateUpdates,
            Stats.ConnectionRecoveredMessages,
            Stats.SimStateMessages,
            Stats.VehicleStateMessages,
            Stats.KpiUpdateMessages,
            Stats.LastKpis.bHasKpi ? TEXT("true") : TEXT("false"),
            SimTimeSpanSec,
            DuplicateVehicleActorCount,
            MaxTargetPoseErrorCm,
            LoadMismatchCount,
            *SummaryPath
        );

        if (!RuntimeActor->bBridgeConnected)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor did not connect to %s: %s"), *WebSocketUrl, *RuntimeActor->LastBridgeStatus);
            Result = 1;
        }
        else if (RuntimeActor->GetSpawnedVehicleActorCount() <= 0)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor did not spawn any vehicle actors from the live stream."));
            Result = 1;
        }
        else if (!bExpectedVehicleCountOk)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor spawned %d vehicle actors; expected %d."), SpawnedVehicleActorCount, ExpectedVehicleCount);
            Result = 1;
        }
        else if (RuntimeActor->GetReceivedVehicleStateCount() < MinimumVehicleStateUpdates)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor received only %d vehicle state updates; expected at least %d."), RuntimeActor->GetReceivedVehicleStateCount(), MinimumVehicleStateUpdates);
            Result = 1;
        }
        else if (Stats.ConnectionRecoveredMessages <= 0 || Stats.SimStateMessages <= 0 || Stats.VehicleStateMessages <= 0 || Stats.KpiUpdateMessages <= 0)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor did not observe all required stream message types."));
            Result = 1;
        }
        else if (!Stats.LastKpis.bHasKpi)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor observed kpiUpdate but did not parse KPI telemetry."));
            Result = 1;
        }
        else if (SimTimeSpanSec < MinSimTimeAdvanceSec)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime stream advanced %.3fs; expected at least %.3fs."), SimTimeSpanSec, MinSimTimeAdvanceSec);
            Result = 1;
        }
        else if (DuplicateVehicleActorCount > 0)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor produced %d duplicate owned vehicle actors."), DuplicateVehicleActorCount);
            Result = 1;
        }
        else if (MissingVehicleActorCount > 0)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor has %d observed vehicle states without matching actors."), MissingVehicleActorCount);
            Result = 1;
        }
        else if (MaxTargetPoseErrorCm > PoseToleranceCm || MaxTargetYawErrorDeg > 0.1f || LoadMismatchCount > 0)
        {
            UE_LOG(LogShuttleVisualTwinLiveSmoke, Error, TEXT("Runtime actor pose/load binding failed: maxTargetPoseErrorCm=%.3f maxTargetYawErrorDeg=%.3f loadMismatches=%d."), MaxTargetPoseErrorCm, MaxTargetYawErrorDeg, LoadMismatchCount);
            Result = 1;
        }

        RuntimeActor->DisconnectFromBridge();
    }

    if (World)
    {
        World->DestroyWorld(false);
        GEngine->DestroyWorldContext(World);
    }
    GameInstance->Shutdown();
    return Result;
}
