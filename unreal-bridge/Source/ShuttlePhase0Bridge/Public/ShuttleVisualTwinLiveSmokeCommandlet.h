#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "ShuttleVisualTwinLiveSmokeCommandlet.generated.h"

UCLASS()
class SHUTTLEPHASE0BRIDGE_API UShuttleVisualTwinLiveSmokeCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UShuttleVisualTwinLiveSmokeCommandlet();

    virtual int32 Main(const FString& Params) override;
};
