import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, TaskStateRecord, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = numberArg('--duration-sec', 1800);
const sampleSec = numberArg('--sample-sec', 5);
const dtSec = numberArg('--dt-sec', 0.2);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const outputPath = resolve(stringArg('--out') ?? `output/review/wait-reason-breakdown-${Date.now()}.json`);

mkdirSync(dirname(outputPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  timeStepSec: dtSec,
  vehicles: { count: shuttleCount },
  taskGeneration: {
    inboundRatePerHour,
    outboundRatePerHour,
    inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
      ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
      : 0.5,
    initialOutboundFullColumns,
    initialStorageFillPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const sim = new ShuttleSimCore(scenario);
const vehicleWaitSamples: Record<string, number> = {};
const taskWaitSamples: Record<string, number> = {};
const examples: Array<{
  timeSec: number;
  source: 'vehicle' | 'task';
  reason: string;
  category: string;
  id: string;
  currentNodeId?: string;
  targetNodeId?: string | null;
  plannedGoalNodeId?: string | null;
  blockingVehicleId?: string | null;
}> = [];
let nextSampleSec = 0;

sim.start();
for (let elapsedSec = 0; elapsedSec < durationSec - 1e-9 && sim.getClock().status === 'running'; elapsedSec += dtSec) {
  const state = sim.step(Math.min(dtSec, durationSec - elapsedSec));
  if (state.simTimeSec + 1e-9 < nextSampleSec) {
    continue;
  }
  sampleState(state);
  nextSampleSec += sampleSec;
}

const finalState = sim.getState();
const report = {
  schemaVersion: 'shuttle.waitReasonBreakdown.v1',
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  status: finalState.status,
  config: {
    regionCount,
    shuttleCount,
    inboundRatePerHour,
    outboundRatePerHour,
    initialOutboundFullColumns,
    initialStorageFillPolicy,
    sampleSec,
    dtSec
  },
  finalKpis: finalState.kpis,
  summary: {
    vehicleWaitSamples: sortedCounts(vehicleWaitSamples),
    taskWaitSamples: sortedCounts(taskWaitSamples),
    topBlockedReasons: Object.entries(finalState.kpis.blockedTimeByReasonSec)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([reason, sec]) => ({ reason, sec: round(sec, 3) }))
  },
  examples
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary: report.summary }, null, 2));

function sampleState(state: ShuttleSimState): void {
  for (const vehicle of state.vehicles) {
    if (!vehicle.waitReason) {
      continue;
    }
    const task = state.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null;
    const category = vehicleCategory(vehicle, task);
    increment(vehicleWaitSamples, `${vehicle.waitReason}|${category}`);
    addExample({
      timeSec: round(state.simTimeSec),
      source: 'vehicle',
      reason: vehicle.waitReason,
      category,
      id: vehicle.id,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      blockingVehicleId: vehicle.blockingVehicleId
    });
  }

  for (const task of state.tasks) {
    if (!task.waitReason || task.state === 'completed' || task.state === 'failed') {
      continue;
    }
    const category = `${task.kind}-${task.state}`;
    increment(taskWaitSamples, `${task.waitReason}|${category}`);
    addExample({
      timeSec: round(state.simTimeSec),
      source: 'task',
      reason: task.waitReason,
      category,
      id: task.id
    });
  }
}

function vehicleCategory(vehicle: VehicleState, task: TaskStateRecord | null): string {
  if (!task) {
    if (vehicle.localRouteReason === 'inbound-queue-standby') {
      return 'taskless-inbound-queue-reserve';
    }
    return vehicle.loaded ? 'taskless-loaded' : 'taskless-other';
  }
  return `${task.kind}-${vehicle.loaded ? 'loaded' : 'empty'}-${vehicle.state}`;
}

function addExample(example: typeof examples[number]): void {
  if (examples.length >= 80) {
    return;
  }
  if (examples.some((candidate) =>
    candidate.source === example.source &&
    candidate.reason === example.reason &&
    candidate.category === example.category &&
    candidate.id === example.id
  )) {
    return;
  }
  examples.push(example);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedCounts(record: Record<string, number>): Array<{ key: string; samples: number }> {
  return Object.entries(record)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, samples]) => ({ key, samples }));
}

function numberArg(name: string, fallback: number): number {
  const value = stringArg(name);
  return value === null ? fallback : Number(value);
}

function integerArg(name: string, fallback: number): number {
  return Math.trunc(numberArg(name, fallback));
}

function enumArg<const T extends readonly string[]>(name: string, values: T, fallback: T[number]): T[number] {
  const value = stringArg(name);
  if (value === null) {
    return fallback;
  }
  if (!values.includes(value as T[number])) {
    throw new Error(`${name} must be one of ${values.join(', ')}`);
  }
  return value as T[number];
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
