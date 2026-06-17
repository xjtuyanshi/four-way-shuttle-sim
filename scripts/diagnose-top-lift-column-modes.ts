import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type SimInternals = ShuttleSimCore & {
  topLiftColumnFlowModes: Map<number, 'inbound' | 'outbound'>;
  topLiftStorageColumnNumbers(): number[];
  topLiftStorageColumnNodeIds(column: number): string[];
  storedLoadIdAtNode(nodeId: string): string | null;
  loadById(loadId: string | null): { id: string; state: string; nodeId: string | null } | null;
  activeTasks(): Array<{ kind: 'inbound' | 'outbound'; state: string; pickupNodeId: string; dropoffNodeId: string }>;
  storageGridPosition(nodeId: string): { row: number; column: number } | null;
  outboundEligibleLoad(load: { id: string; state: string; nodeId: string | null }): boolean;
  topLiftColumnHasReachableInboundSlot(nodeIds: string[], occupancy: Map<string, string>): boolean;
  storageNodeLoadOccupancy(includeReserved: boolean): Map<string, string>;
};

const durationSec = numberArg('--duration-sec', 1800);
const sampleSec = numberArg('--sample-sec', 300);
const dtSec = numberArg('--dt-sec', 0.2);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const outputPath = resolve(stringArg('--out') ?? `output/review/top-lift-column-modes-${Date.now()}.json`);

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
    initialOutboundFullColumns
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const sim = new ShuttleSimCore(scenario);
const internals = sim as SimInternals;
const samples: unknown[] = [];
let nextSampleSec = 0;

sim.start();
for (let elapsedSec = 0; elapsedSec < durationSec - 1e-9 && sim.getClock().status === 'running'; elapsedSec += dtSec) {
  const state = sim.step(Math.min(dtSec, durationSec - elapsedSec));
  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    const sample = createSample();
    samples.push(sample);
    console.log(JSON.stringify({
      timeSec: sample.timeSec,
      completedInbound: sample.completedInbound,
      completedOutbound: sample.completedOutbound,
      totalPph: sample.totalPph,
      columns: sample.columns.filter((column) => column.stored > 0 || column.activeInbound > 0 || column.activeOutbound > 0)
    }));
    nextSampleSec += sampleSec;
  }
}

const finalState = sim.getState();
const report = {
  schemaVersion: 'shuttle.topLiftColumnModeDiagnosis.v1',
  scenarioId: scenario.id,
  durationSec,
  finalSimTimeSec: finalState.simTimeSec,
  status: finalState.status,
  config: {
    regionCount,
    shuttleCount,
    inboundRatePerHour,
    outboundRatePerHour,
    initialOutboundFullColumns,
    sampleSec,
    dtSec
  },
  finalKpis: finalState.kpis,
  samples
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ type: 'column-mode-diagnosis-complete', outputPath }, null, 2));

function createSample() {
  const state = sim.getState();
  const activeTasks = internals.activeTasks();
  const occupancy = internals.storageNodeLoadOccupancy(false);
  return {
    timeSec: round(state.simTimeSec),
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    totalPph: round(state.kpis.totalPph, 3),
    topBlockedReasons: Object.entries(state.kpis.blockedTimeByReasonSec)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([reason, sec]) => ({ reason, sec: round(sec, 3) })),
    columns: internals.topLiftStorageColumnNumbers().map((column) => {
      const nodeIds = internals.topLiftStorageColumnNodeIds(column);
      const loads = nodeIds
        .map((nodeId) => internals.loadById(internals.storedLoadIdAtNode(nodeId)))
        .filter((load): load is { id: string; state: string; nodeId: string | null } => Boolean(load));
      const activeInbound = activeTasks.filter((task) => task.kind === 'inbound' && taskColumn(task) === column).length;
      const activeOutbound = activeTasks.filter((task) => task.kind === 'outbound' && taskColumn(task) === column).length;
      const outboundEligible = loads.filter((load) => internals.outboundEligibleLoad(load)).length;
      return {
        column,
        mode: internals.topLiftColumnFlowModes.get(column) ?? null,
        stored: loads.length,
        outboundEligible,
        seedStored: loads.filter((load) => load.id.startsWith('outbound-seed-')).length,
        activeInbound,
        activeOutbound,
        reachableInboundSlot: internals.topLiftColumnHasReachableInboundSlot(nodeIds, occupancy)
      };
    })
  };
}

function taskColumn(task: { pickupNodeId: string; dropoffNodeId: string }): number | null {
  const pickupPosition = internals.storageGridPosition(task.pickupNodeId);
  if (pickupPosition) {
    return pickupPosition.column;
  }
  const dropoffPosition = internals.storageGridPosition(task.dropoffNodeId);
  return dropoffPosition?.column ?? null;
}

function numberArg(name: string, fallback: number): number {
  const value = stringArg(name);
  return value === null ? fallback : Number(value);
}

function integerArg(name: string, fallback: number): number {
  return Math.trunc(numberArg(name, fallback));
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
