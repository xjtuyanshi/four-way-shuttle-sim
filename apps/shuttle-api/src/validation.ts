import type { ShuttleScenario } from '@four-way-shuttle/schemas';
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

function runOnce(scenario: ShuttleScenario, seed: number, durationSec: number): Phase0ValidationRun {
  const sim = new ShuttleSimCore({ ...scenario, seed, durationSec });
  sim.runToEnd(durationSec);
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
    deadlockCount: state.kpis.deadlockCount
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
      pass: sameSeedEventHashStable && noDeadlocksInSweep && eventLogsPresent
    }
  };
}
