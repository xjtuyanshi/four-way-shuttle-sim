#pragma once

#include "Commandlets/Commandlet.h"
#include "ShuttleVisualTwinSmokeCommandlet.generated.h"

UCLASS()
class SHUTTLEPHASE0BRIDGE_API UShuttleVisualTwinSmokeCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UShuttleVisualTwinSmokeCommandlet();

    virtual int32 Main(const FString& Params) override;
};
