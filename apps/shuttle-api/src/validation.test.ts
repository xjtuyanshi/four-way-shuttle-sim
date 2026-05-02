import { createDefaultShuttleScenario } from '@four-way-shuttle/sim-core';

import { validatePhase0Scenario } from './validation.js';

describe('phase 0 validation', () => {
  it('checks same-seed hash stability and seed sweep health', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 120 }), {
      durationSec: 120,
      repeatCount: 3,
      sweepSeeds: [20260502, 20260503]
    });

    expect(result.deterministic.pass).toBe(true);
    expect(new Set(result.deterministic.hashes).size).toBe(1);
    expect(result.seedSweep.runs).toHaveLength(2);
    expect(result.acceptance.noPhysicalSafetyViolations).toBe(true);
    expect(result.acceptance.noReservationCoverageViolations).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationsByCode.unreservedEdgeOccupancy === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationExamples.length === 0)).toBe(true);
    expect(result.acceptance.pass).toBe(true);
  });
});
