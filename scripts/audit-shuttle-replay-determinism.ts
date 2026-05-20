import {
  createInboundMvpBaselineScenario,
  hashDeterministicReplayState,
  hashScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = numberArg('--duration', 1800);
const splitSec = numberArg('--split', 600);
const dtSec = numberArg('--dt', 0.25);

if (splitSec <= 0 || splitSec >= durationSec) {
  throw new Error(`--split must be greater than 0 and less than --duration; got split=${splitSec}, duration=${durationSec}`);
}

const scenario = createInboundMvpBaselineScenario({
  id: 'audit-agent-refresh-replay-determinism',
  durationSec,
  timeStepSec: dtSec,
  trafficPolicy: {
    sourceBufferCapacity: 4
  }
});

const direct = new ShuttleSimCore(scenario);
direct.start();
runUntil(direct, durationSec, dtSec);
const directState = direct.getState();
const directSnapshot = direct.createSnapshot();

const checkpointSource = new ShuttleSimCore(scenario);
checkpointSource.start();
runUntil(checkpointSource, splitSec, dtSec);
const checkpoint = checkpointSource.createSnapshot();

const replay = new ShuttleSimCore(scenario);
replay.restoreSnapshot(checkpoint);
runUntil(replay, durationSec, dtSec);
const replayState = replay.getState();
const replaySnapshot = replay.createSnapshot();

const checks = {
  eventLogHash: directSnapshot.eventLogHash === replaySnapshot.eventLogHash,
  stateHash: hashDeterministicReplayState(directSnapshot) === hashDeterministicReplayState(replaySnapshot),
  completedInbound: directState.kpis.completedInbound === replayState.kpis.completedInbound,
  completedOutbound: directState.kpis.completedOutbound === replayState.kpis.completedOutbound,
  deadlocks: directState.kpis.deadlockCount === replayState.kpis.deadlockCount,
  livelocks: directState.kpis.livelockCount === replayState.kpis.livelockCount,
  physicalViolations: directState.traffic.physicalViolationCount === replayState.traffic.physicalViolationCount
};

const report = {
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  seed: scenario.seed,
  durationSec,
  splitSec,
  stepSec: dtSec,
  pass: Object.values(checks).every(Boolean),
  checks,
  direct: {
    finalSimTimeSec: directState.simTimeSec,
    finalTickIndex: directSnapshot.tickIndex,
    eventLogHash: directSnapshot.eventLogHash,
    stateHash: hashDeterministicReplayState(directSnapshot),
    completedInbound: directState.kpis.completedInbound,
    completedOutbound: directState.kpis.completedOutbound,
    deadlocks: directState.kpis.deadlockCount,
    livelocks: directState.kpis.livelockCount,
    physicalViolations: directState.traffic.physicalViolationCount
  },
  restored: {
    finalSimTimeSec: replayState.simTimeSec,
    finalTickIndex: replaySnapshot.tickIndex,
    eventLogHash: replaySnapshot.eventLogHash,
    stateHash: hashDeterministicReplayState(replaySnapshot),
    completedInbound: replayState.kpis.completedInbound,
    completedOutbound: replayState.kpis.completedOutbound,
    deadlocks: replayState.kpis.deadlockCount,
    livelocks: replayState.kpis.livelockCount,
    physicalViolations: replayState.traffic.physicalViolationCount
  }
};

console.log(JSON.stringify(report, null, 2));

if (!report.pass) {
  process.exitCode = 1;
}

function runUntil(sim: ShuttleSimCore, endSec: number, stepSec: number): void {
  while (sim.getClock().simTimeSec < endSec - 1e-9 && sim.getClock().status === 'running') {
    sim.step(Math.min(stepSec, endSec - sim.getClock().simTimeSec));
  }
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected numeric value for ${name}`);
  }
  return value;
}
