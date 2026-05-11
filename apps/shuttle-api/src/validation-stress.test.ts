import { createDefaultShuttleScenario } from '@four-way-shuttle/sim-core';

import { validatePhase0Scenario } from './validation.js';

describe('phase 0 stress validation', () => {
  it('checks stress bottleneck and IE behavior gates', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 20 }), {
      durationSec: 20,
      longRunDurationSec: 20,
      stressDurationSec: 120,
      repeatCount: 1,
      sweepSeeds: [20260502],
      stressSeeds: [20260502]
    });

    expect(result.stress.scenarios.map((scenario) => scenario.id)).toEqual([
      'balanced-high-load',
      'inbound-only-saturation',
      'outbound-empty-store',
      'outbound-preloaded-pressure',
      'near-full-inbound-pressure'
    ]);
    expect(result.stress.scenarios.every((scenario) => scenario.runs.length === 1)).toBe(true);
    expect(result.stress.scenarios.every((scenario) => scenario.observedBottleneckReasons.length > 0)).toBe(true);
    expect(result.stress.scenarios.every((scenario) =>
      scenario.runs.every((run) => run.missingExpectedBottleneckReasonPrefixes.length === 0)
    )).toBe(true);
    expect(result.stress.blockedTimeByCategorySec.fifoLane).toBeGreaterThan(0);
    const inboundOnly = result.stress.scenarios.find((scenario) => scenario.id === 'inbound-only-saturation');
    expect(inboundOnly).toBeDefined();
    expect(inboundOnly!.blockedTimeByCategorySec.vehicleFleet).toBeGreaterThan(0);
    expect(inboundOnly!.theoreticalFleetPphMean ?? 0).toBeGreaterThan(0);
    expect(inboundOnly!.inboundPphGapToTheoryMean ?? 0).toBeGreaterThan(0);
    expect(inboundOnly!.averageVehicleUtilizationPctMean).toBeGreaterThan(0);
    expect(inboundOnly!.blockedTimeByCategorySec.liftPort).toBeLessThan(inboundOnly!.blockedTimeByCategorySec.vehicleFleet);
    expect(result.stress.scenarios.every((scenario) =>
      scenario.runs.every((run) => run.ieBehaviorAudit.routing.violationCount === 0)
    )).toBe(true);
    expect(result.stress.noStressDeadlocks).toBe(true);
    expect(result.stress.noStressPhysicalSafetyViolations).toBe(false);
    expect(result.stress.noStressReservationCoverageViolations).toBe(true);
    expect(result.stress.noStressIeBehaviorAuditViolations).toBe(true);
    expect(result.stress.expectedBottlenecksObserved).toBe(true);
    expect(result.stress.expectedDominantBottlenecksObserved).toBe(true);
    expect(result.stress.positiveThroughputWhereRequired).toBe(true);
    expect(inboundOnly!.runs.some((run) => run.physicalViolationsByCode.minSeparation > 0)).toBe(true);
    expect(result.acceptance.stressPass).toBe(false);
    expect(result.acceptance.flowDebugObservationPass).toBe(true);
    expect(result.acceptance.segmentSafeValidationPass).toBe(false);
    expect(result.acceptance.ieValidationPass).toBe(false);
    expect(result.acceptance.expectedStressDominantBottlenecksObserved).toBe(true);
  }, 120000);
});
