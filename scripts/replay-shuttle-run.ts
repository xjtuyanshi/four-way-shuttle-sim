import { readFileSync, writeFileSync } from 'node:fs';

import { ShuttleSimCore, type ShuttleEngineSnapshotV1 } from '../packages/shuttle-sim-core/src/index.ts';

type ReplayCommandRecordV1 = {
  sequence: number;
  appliedTickIndex: number;
  type: 'loadScenario' | 'reset' | 'pause' | 'resume' | 'setParam' | 'playbackSpeed';
  payload: unknown;
  stateHashAfter: string;
};

type ReplaySnapshotRecordV1 = {
  sequence: number;
  simTimeSec: number;
  tickIndex: number;
  snapshot: ShuttleEngineSnapshotV1;
};

type RunTraceV1 = {
  schemaVersion: 'shuttle.runTrace.v1';
  scenario: ConstructorParameters<typeof ShuttleSimCore>[0];
  fixedDtSec: number;
  initialSnapshot: ShuttleEngineSnapshotV1;
  commands: ReplayCommandRecordV1[];
  snapshots: ReplaySnapshotRecordV1[];
};

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function unwrapSnapshot(value: unknown): ShuttleEngineSnapshotV1 {
  const maybeRecord = value as { snapshot?: ShuttleEngineSnapshotV1 };
  return maybeRecord.snapshot ?? value as ShuttleEngineSnapshotV1;
}

function applyCommand(sim: ShuttleSimCore, command: ReplayCommandRecordV1): void {
  if (command.type === 'playbackSpeed') {
    return;
  }
  if (command.type === 'loadScenario') {
    sim.loadScenario(command.payload as ConstructorParameters<typeof ShuttleSimCore>[0]);
    return;
  }
  if (command.type === 'reset') {
    const payload = command.payload as { seed?: number };
    sim.reset(payload.seed);
    return;
  }
  if (command.type === 'pause') {
    sim.pause();
    return;
  }
  if (command.type === 'resume') {
    sim.resume();
    return;
  }
  if (command.type === 'setParam') {
    const payload = command.payload as { path: string; value: string | number | boolean | null };
    const result = sim.setParam(payload.path, payload.value);
    if (!result.accepted) {
      throw new Error(`Replay setParam rejected: ${payload.path}=${String(payload.value)} ${result.reason ?? ''}`);
    }
  }
}

const tracePath = argValue('--trace');
if (!tracePath) {
  throw new Error('Usage: pnpm shuttle:replay --trace <run-trace.json> [--from <sec>] [--to <sec>] [--snapshot <snapshot.json>] [--assert] [--emit <snapshot.json>]');
}

const trace = readJson<RunTraceV1>(tracePath);
if (trace.schemaVersion !== 'shuttle.runTrace.v1') {
  throw new Error(`Unsupported trace schema ${String((trace as { schemaVersion?: unknown }).schemaVersion)}`);
}

const fromSec = Number(argValue('--from') ?? '0');
const toSec = Number(argValue('--to') ?? String(fromSec));
const assertHashes = hasFlag('--assert');
const emitPath = argValue('--emit');
const explicitSnapshotPath = argValue('--snapshot');
const fixedDtSec = trace.fixedDtSec || trace.scenario.timeStepSec;
const snapshots = [...(trace.snapshots ?? [])].sort((left, right) => left.tickIndex - right.tickIndex);
const startSnapshot = explicitSnapshotPath
  ? unwrapSnapshot(readJson<unknown>(explicitSnapshotPath))
  : snapshots
      .filter((record) => record.simTimeSec <= fromSec + 1e-9)
      .at(-1)?.snapshot ?? trace.initialSnapshot;

const sim = new ShuttleSimCore(trace.scenario);
sim.restoreSnapshot(startSnapshot);

let commandIndex = 0;
const commands = [...(trace.commands ?? [])].sort((left, right) => left.appliedTickIndex - right.appliedTickIndex || left.sequence - right.sequence);
while (commandIndex < commands.length && commands[commandIndex]!.appliedTickIndex <= startSnapshot.tickIndex) {
  commandIndex += 1;
}

let snapshotIndex = snapshots.findIndex((record) => record.tickIndex > startSnapshot.tickIndex);
if (snapshotIndex < 0) snapshotIndex = snapshots.length;

function applyDueCommands(): void {
  const tickIndex = sim.createSnapshot().tickIndex;
  while (commandIndex < commands.length && commands[commandIndex]!.appliedTickIndex <= tickIndex) {
    const command = commands[commandIndex]!;
    applyCommand(sim, command);
    if (assertHashes) {
      const actualHash = sim.createSnapshot().stateHash;
      if (actualHash !== command.stateHashAfter) {
        throw new Error(`Command ${command.sequence} state hash mismatch: expected ${command.stateHashAfter}, got ${actualHash}`);
      }
    }
    commandIndex += 1;
  }
}

function assertDueSnapshots(): void {
  if (!assertHashes) {
    return;
  }
  const current = sim.createSnapshot();
  while (snapshotIndex < snapshots.length && snapshots[snapshotIndex]!.tickIndex <= current.tickIndex) {
    const expected = snapshots[snapshotIndex]!;
    if (expected.tickIndex === current.tickIndex) {
      const actualHash = current.stateHash;
      if (actualHash !== expected.snapshot.stateHash) {
        throw new Error(`Snapshot ${expected.sequence} hash mismatch at t=${expected.simTimeSec}s: expected ${expected.snapshot.stateHash}, got ${actualHash}`);
      }
    }
    snapshotIndex += 1;
  }
}

applyDueCommands();
assertDueSnapshots();

while (sim.createSnapshot().simTimeSec < toSec - 1e-9) {
  const state = sim.getState();
  if (state.status === 'idle' || state.status === 'paused') {
    sim.resume();
  }
  sim.step(fixedDtSec);
  applyDueCommands();
  assertDueSnapshots();
}

const finalSnapshot = sim.createSnapshot();
if (emitPath) {
  writeFileSync(emitPath, JSON.stringify(finalSnapshot, null, 2));
}

console.log(JSON.stringify({
  ok: true,
  fromSec,
  toSec,
  finalSimTimeSec: finalSnapshot.simTimeSec,
  finalTickIndex: finalSnapshot.tickIndex,
  stateHash: finalSnapshot.stateHash,
  eventLogHash: finalSnapshot.eventLogHash,
  commandsApplied: commandIndex
}, null, 2));
