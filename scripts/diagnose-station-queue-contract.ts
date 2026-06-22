import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type InternalSim = ShuttleSimCore & {
  assignmentHoldActive(vehicle: VehicleState): boolean;
  inboundDropoffStandbyHoldActive(vehicle: VehicleState): boolean;
  tasklessInboundQueueStandbyRerouteAllowed(vehicle: VehicleState): boolean;
  routeToInboundQueueStandby(vehicle: VehicleState): string[] | null;
  tasklessInboundQueueStandbyRouteOriginAllowed(routeNodeIds: string[]): boolean;
  topLiftInboundQueueStandbyTargetNodeId(vehicle: VehicleState): string | null;
  topLiftInboundApproachQueueSlot(nodeId: string): { liftNodeId: string; slotIndex: number } | null;
};

type CandidateRecord = {
  vehicleId: string;
  reason: string;
  currentNodeId: string;
  targetNodeId: string | null;
  plannedGoalNodeId: string | null;
  localRouteReason: string | null;
  routeLength: number | null;
  routeEndNodeId: string | null;
  routeEndSlot: string | null;
};

type Sample = {
  timeSec: number;
  stationContracts: ShuttleSimState['traffic']['shadowLedger']['stationContracts'];
  candidateReasons: Record<string, number>;
  candidates: CandidateRecord[];
};

const durationSec = numberArg('--duration-sec', 600);
const sampleSec = numberArg('--sample-sec', 10);
const dtSec = numberArg('--dt-sec', 0.2);
const progressSec = numberArg('--progress-sec', 0);
const outputPath = resolve(stringArg('--out') ?? `output/review/station-queue-contract-diagnosis-${Date.now()}.json`);

mkdirSync(dirname(outputPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  timeStepSec: dtSec,
  vehicles: { count: integerArg('--shuttles', 8) },
  taskGeneration: {
    inboundRatePerHour: numberArg('--inbound-pph', 3600),
    outboundRatePerHour: numberArg('--outbound-pph', 3600),
    inboundOutboundMix: 0.5,
    initialOutboundFullColumns: integerArg('--outbound-full-columns', 4),
    initialStorageFillPolicy: enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'zone-balanced-50')
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: integerArg('--regions', 2)
  }
});

const sim = new ShuttleSimCore(scenario);
const internals = sim as unknown as InternalSim;
const samples: Sample[] = [];
let nextSampleSec = 0;
let nextProgressSec = progressSec > 0 ? progressSec : Number.POSITIVE_INFINITY;

sim.start();
samples.push(sampleState(sim.getState()));
nextSampleSec = sampleSec;

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const nextBoundarySec = Math.min(durationSec, nextSampleSec, nextProgressSec);
  const stepSec = Math.min(Math.max(dtSec, nextBoundarySec - clock.simTimeSec), durationSec - clock.simTimeSec);
  if (stepSec <= 1e-9 || !Number.isFinite(stepSec)) {
    break;
  }
  sim.advanceByInPlace(stepSec);
  const nextClock = sim.getClock();
  if (progressSec > 0 && nextClock.simTimeSec + 1e-9 >= nextProgressSec) {
    console.error(JSON.stringify({ type: 'station-queue-contract-progress', timeSec: round(nextClock.simTimeSec), durationSec }));
    while (nextProgressSec <= nextClock.simTimeSec + 1e-9) {
      nextProgressSec += progressSec;
    }
  }
  if (nextClock.simTimeSec + 1e-9 >= nextSampleSec) {
    samples.push(sampleState(sim.getState()));
    while (nextSampleSec <= nextClock.simTimeSec + 1e-9) {
      nextSampleSec += sampleSec;
    }
  }
}

const finalState = sim.getState();
const summary = summarize(samples, finalState);
const report = {
  schemaVersion: 'shuttle.stationQueueContractDiagnosis.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  config: { durationSec, sampleSec, dtSec },
  summary,
  final: {
    simTimeSec: finalState.simTimeSec,
    status: finalState.status,
    kpis: finalState.kpis,
    stationContracts: finalState.traffic.shadowLedger.stationContracts
  },
  samples
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary }, null, 2));

function sampleState(state: ShuttleSimState): Sample {
  const candidates = state.vehicles.map((vehicle) => diagnoseCandidate(vehicle));
  const candidateReasons = countBy(candidates, (candidate) => candidate.reason);
  return {
    timeSec: round(state.simTimeSec),
    stationContracts: state.traffic.shadowLedger.stationContracts,
    candidateReasons,
    candidates
  };
}

function diagnoseCandidate(vehicle: VehicleState): CandidateRecord {
  if (vehicle.taskId) {
    return candidate(vehicle, 'busy-task', null);
  }
  if (vehicle.loaded) {
    return candidate(vehicle, 'busy-loaded', null);
  }
  if (vehicle.currentEdgeId || vehicle.legRemainingM > 0 || vehicle.phaseRemainingSec > 0) {
    return candidate(vehicle, 'busy-moving', null);
  }
  if (internals.assignmentHoldActive(vehicle)) {
    return candidate(vehicle, 'assignment-hold', null);
  }
  if (internals.inboundDropoffStandbyHoldActive(vehicle)) {
    return candidate(vehicle, 'inbound-dropoff-standby-hold', null);
  }
  if (!internals.tasklessInboundQueueStandbyRerouteAllowed(vehicle)) {
    return candidate(vehicle, 'standby-reroute-not-allowed', null);
  }
  const targetNodeId = internals.topLiftInboundQueueStandbyTargetNodeId(vehicle);
  if (!targetNodeId) {
    return candidate(vehicle, 'no-station-target', null);
  }
  const route = internals.routeToInboundQueueStandby(vehicle);
  if (!route || route.length <= 1) {
    return candidate(vehicle, 'no-standby-route', route);
  }
  if (!internals.tasklessInboundQueueStandbyRouteOriginAllowed(route)) {
    return candidate(vehicle, 'route-origin-disallowed', route);
  }
  return candidate(vehicle, 'dispatchable-reserve', route);
}

function candidate(vehicle: VehicleState, reason: string, route: string[] | null): CandidateRecord {
  const routeEndNodeId = route?.at(-1) ?? null;
  const routeEndSlot = routeEndNodeId ? internals.topLiftInboundApproachQueueSlot(routeEndNodeId) : null;
  return {
    vehicleId: vehicle.id,
    reason,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    localRouteReason: vehicle.localRouteReason,
    routeLength: route?.length ?? null,
    routeEndNodeId,
    routeEndSlot: routeEndSlot ? `${routeEndSlot.liftNodeId}:s${routeEndSlot.slotIndex}` : null
  };
}

function summarize(samples: Sample[], finalState: ShuttleSimState): Record<string, unknown> {
  const stationEntries = samples.flatMap((sample) => sample.stationContracts.stations);
  const reasonCounts = samples.reduce<Record<string, number>>((accumulator, sample) => {
    for (const [reason, count] of Object.entries(sample.candidateReasons)) {
      accumulator[reason] = (accumulator[reason] ?? 0) + count;
    }
    return accumulator;
  }, {});
  return {
    samples: samples.length,
    candidateReasons: reasonCounts,
    stationInvariantCounts: finalState.traffic.shadowLedger.stationContracts.invariantCounts,
    averageQueueReservationCount: round(average(stationEntries.map((station) => station.queueReservationCount)), 3),
    averageNearCoveredDepth: round(average(stationEntries.map((station) => station.nearCoveredDepth)), 3),
    averageReadyDemandCount: round(average(stationEntries.map((station) => station.readyDemandCount)), 3),
    finalKpis: {
      inboundPph: finalState.kpis.inboundPph,
      demandOutboundPph: finalState.kpis.demandOutboundPph,
      totalPph: finalState.kpis.totalPph
    },
    finalTraffic: {
      deadlocks: finalState.kpis.deadlockCount,
      livelocks: finalState.kpis.livelockCount,
      physicalViolations: finalState.traffic.physicalViolationCount
    }
  };
}

function countBy<T>(values: T[], selector: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    const key = selector(value);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
