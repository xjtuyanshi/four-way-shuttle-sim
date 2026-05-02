import type { ShuttleScenario, ShuttleSimState } from '@four-way-shuttle/schemas';
import { ShuttleSimCore, hashEventLog } from '@four-way-shuttle/sim-core';

export type Phase0ValidationRun = {
  seed: number;
  durationSec: number;
  status: string;
  eventLogHash: string;
  eventCount: number;
  totalPph: number;
  inboundPph: number;
  outboundPph: number;
  reservationConflictCount: number;
  deadlockCount: number;
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationCount: number;
};

export type Phase0ValidationResult = {
  checkedAt: string;
  scenarioId: string;
  deterministic: {
    seed: number;
    repeatCount: number;
    pass: boolean;
    hashes: string[];
  };
  seedSweep: {
    seeds: number[];
    durationSec: number;
    runs: Phase0ValidationRun[];
    totalPphMean: number;
    totalPphMin: number;
    totalPphMax: number;
    totalPphRange: number;
  };
  acceptance: {
    sameSeedEventHashStable: boolean;
    noDeadlocksInSweep: boolean;
    eventLogsPresent: boolean;
    noPhysicalSafetyViolations: boolean;
    pass: boolean;
  };
};

type Phase0ValidationOptions = {
  durationSec?: number;
  repeatCount?: number;
  sweepSeeds?: number[];
};

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function inspectPhysicalState(scenario: ShuttleScenario, state: ShuttleSimState): {
  maxObservedSpeedMps: number;
  minVehicleSeparationM: number | null;
  violationCount: number;
} {
  void scenario;

  return {
    maxObservedSpeedMps: round(state.traffic.maxObservedSpeedMps),
    minVehicleSeparationM: state.traffic.minVehicleSeparationM,
    violationCount: state.traffic.physicalViolationCount
  };
}

function runOnce(scenario: ShuttleScenario, seed: number, durationSec: number): Phase0ValidationRun {
  const sim = new ShuttleSimCore({ ...scenario, seed, durationSec });
  sim.start();
  let maxObservedSpeedMps = 0;
  let maxObservedAccelerationMps2 = 0;
  let minVehicleSeparationM: number | null = null;
  let physicalViolationCount = 0;
  let previousSpeeds = new Map<string, number>();
  while (sim.getState().status === 'running') {
    const state = sim.step(scenario.timeStepSec);
    const physical = inspectPhysicalState(scenario, state);
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, physical.maxObservedSpeedMps);
    for (const vehicle of state.vehicles) {
      const previousSpeed = previousSpeeds.get(vehicle.id) ?? vehicle.speedMps;
      const accelerationMps2 = Math.abs(vehicle.speedMps - previousSpeed) / scenario.timeStepSec;
      maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, accelerationMps2);
      if (accelerationMps2 > scenario.physicsParams.accelerationMps2 + 1e-6) {
        physicalViolationCount += 1;
      }
    }
    previousSpeeds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.speedMps]));
    minVehicleSeparationM =
      physical.minVehicleSeparationM === null
        ? minVehicleSeparationM
        : minVehicleSeparationM === null
          ? physical.minVehicleSeparationM
          : Math.min(minVehicleSeparationM, physical.minVehicleSeparationM);
    physicalViolationCount += physical.violationCount;
  }
  const state = sim.getState();
  const eventLog = sim.getEventLog();

  return {
    seed,
    durationSec,
    status: state.status,
    eventLogHash: hashEventLog(eventLog),
    eventCount: eventLog.length,
    totalPph: state.kpis.totalPph,
    inboundPph: state.kpis.inboundPph,
    outboundPph: state.kpis.outboundPph,
    reservationConflictCount: state.kpis.reservationConflictCount,
    deadlockCount: state.kpis.deadlockCount,
    maxObservedSpeedMps: round(maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(maxObservedAccelerationMps2),
    minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
    physicalViolationCount
  };
}

export function validatePhase0Scenario(
  scenario: ShuttleScenario,
  options: Phase0ValidationOptions = {}
): Phase0ValidationResult {
  const durationSec = options.durationSec ?? Math.min(240, scenario.durationSec);
  const repeatCount = options.repeatCount ?? 3;
  const sweepSeeds = options.sweepSeeds ?? [scenario.seed, scenario.seed + 1, scenario.seed + 2];

  const repeatRuns = Array.from({ length: repeatCount }, () => runOnce(scenario, scenario.seed, durationSec));
  const hashes = repeatRuns.map((run) => run.eventLogHash);
  const seedSweepRuns = sweepSeeds.map((seed) => runOnce(scenario, seed, durationSec));
  const totalPphValues = seedSweepRuns.map((run) => run.totalPph);
  const totalPphMin = Math.min(...totalPphValues);
  const totalPphMax = Math.max(...totalPphValues);
  const sameSeedEventHashStable = new Set(hashes).size === 1;
  const noDeadlocksInSweep = seedSweepRuns.every((run) => run.deadlockCount === 0);
  const eventLogsPresent = [...repeatRuns, ...seedSweepRuns].every((run) => run.eventCount > 0);
  const noPhysicalSafetyViolations = [...repeatRuns, ...seedSweepRuns].every((run) => run.physicalViolationCount === 0);

  return {
    checkedAt: new Date().toISOString(),
    scenarioId: scenario.id,
    deterministic: {
      seed: scenario.seed,
      repeatCount,
      pass: sameSeedEventHashStable,
      hashes
    },
    seedSweep: {
      seeds: sweepSeeds,
      durationSec,
      runs: seedSweepRuns,
      totalPphMean: round(totalPphValues.reduce((sum, value) => sum + value, 0) / Math.max(1, totalPphValues.length)),
      totalPphMin: round(totalPphMin),
      totalPphMax: round(totalPphMax),
      totalPphRange: round(totalPphMax - totalPphMin)
    },
    acceptance: {
      sameSeedEventHashStable,
      noDeadlocksInSweep,
      eventLogsPresent,
      noPhysicalSafetyViolations,
      pass: sameSeedEventHashStable && noDeadlocksInSweep && eventLogsPresent && noPhysicalSafetyViolations
    }
  };
}
