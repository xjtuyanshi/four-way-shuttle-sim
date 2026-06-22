import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, TaskStateRecord, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type InternalSim = ShuttleSimCore & {
  assignmentHoldActive(vehicle: VehicleState): boolean;
  inboundDropoffStandbyHoldActive(vehicle: VehicleState): boolean;
  tasklessInboundQueueStandbyRerouteAllowed(vehicle: VehicleState): boolean;
  routeToInboundQueueStandby(vehicle: VehicleState, fromNodeId?: string, options?: { allowTaskedVehicle?: boolean; liftNodeId?: string }): string[] | null;
  tasklessInboundQueueStandbyRouteOriginAllowed(routeNodeIds: string[]): boolean;
  topLiftInboundQueueStandbyTargetNodeId(vehicle: VehicleState, fromNodeId?: string, options?: { allowTaskedVehicle?: boolean; liftNodeId?: string }): string | null;
  topLiftInboundApproachQueueSlot(nodeId: string): { liftNodeId: string; slotIndex: number } | null;
  taskLiftPortNodeId(task: TaskStateRecord): string | null;
  topLiftInboundVehicleContributesQueueCoverage(vehicle: VehicleState, liftNodeId: string): boolean;
};

type CandidateRecord = {
  vehicleId: string;
  reason: string;
  currentNodeId: string;
  targetNodeId: string | null;
  plannedGoalNodeId: string | null;
  localRouteReason: string | null;
  taskId: string | null;
  taskKind: string | null;
  taskState: string | null;
  taskLiftNodeId: string | null;
  contributesInboundQueueCoverage: boolean | null;
  standbyTargetNodeId: string | null;
  standbyTargetSlot: string | null;
  releasedStandbyRouteLength: number | null;
  releasedStandbyRouteEndNodeId: string | null;
  releasedStandbyRouteEndSlot: string | null;
  releasedStandbyRouteOriginAllowed: boolean | null;
  releasedStandbyRouteLevelPattern: string | null;
  routeLength: number | null;
  routeEndNodeId: string | null;
  routeEndSlot: string | null;
  routeLevelPattern: string | null;
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
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const candidates = state.vehicles.map((vehicle) => diagnoseCandidate(vehicle, tasksById));
  const candidateReasons = countBy(candidates, (candidate) => candidate.reason);
  return {
    timeSec: round(state.simTimeSec),
    stationContracts: state.traffic.shadowLedger.stationContracts,
    candidateReasons,
    candidates
  };
}

function diagnoseCandidate(vehicle: VehicleState, tasksById: Map<string, TaskStateRecord>): CandidateRecord {
  if (vehicle.taskId) {
    return candidate(vehicle, 'busy-task', null, null, tasksById);
  }
  if (vehicle.loaded) {
    return candidate(vehicle, 'busy-loaded', null, null, tasksById);
  }
  if (vehicle.currentEdgeId || vehicle.legRemainingM > 0 || vehicle.phaseRemainingSec > 0) {
    return candidate(vehicle, 'busy-moving', null, null, tasksById);
  }
  if (internals.assignmentHoldActive(vehicle)) {
    return candidate(vehicle, 'assignment-hold', null, null, tasksById);
  }
  if (internals.inboundDropoffStandbyHoldActive(vehicle)) {
    return candidate(vehicle, 'inbound-dropoff-standby-hold', null, null, tasksById);
  }
  if (!internals.tasklessInboundQueueStandbyRerouteAllowed(vehicle)) {
    return candidate(vehicle, 'standby-reroute-not-allowed', null, null, tasksById);
  }
  const targetNodeId = internals.topLiftInboundQueueStandbyTargetNodeId(vehicle);
  if (!targetNodeId) {
    return candidate(vehicle, 'no-station-target', null, null, tasksById);
  }
  const route = internals.routeToInboundQueueStandby(vehicle);
  if (!route || route.length <= 1) {
    return candidate(vehicle, 'no-standby-route', targetNodeId, route, tasksById);
  }
  if (!internals.tasklessInboundQueueStandbyRouteOriginAllowed(route)) {
    return candidate(vehicle, 'route-origin-disallowed', targetNodeId, route, tasksById);
  }
  return candidate(vehicle, 'dispatchable-reserve', targetNodeId, route, tasksById);
}

function candidate(
  vehicle: VehicleState,
  reason: string,
  standbyTargetNodeId: string | null,
  route: string[] | null,
  tasksById: Map<string, TaskStateRecord>
): CandidateRecord {
  const routeEndNodeId = route?.at(-1) ?? null;
  const routeEndSlot = routeEndNodeId ? internals.topLiftInboundApproachQueueSlot(routeEndNodeId) : null;
  const standbyTargetSlot = standbyTargetNodeId
    ? internals.topLiftInboundApproachQueueSlot(standbyTargetNodeId)
    : null;
  const task = vehicle.taskId ? tasksById.get(vehicle.taskId) ?? null : null;
  const taskLiftNodeId = task ? internals.taskLiftPortNodeId(task) : null;
  const contributesInboundQueueCoverage = task?.kind === 'inbound' && taskLiftNodeId
    ? internals.topLiftInboundVehicleContributesQueueCoverage(vehicle, taskLiftNodeId)
    : null;
  const releasedStandbyRoute = task?.kind === 'outbound' && !vehicle.loaded
    ? internals.routeToInboundQueueStandby(vehicle, vehicle.currentNodeId, { allowTaskedVehicle: true })
    : null;
  const releasedStandbyRouteEndNodeId = releasedStandbyRoute?.at(-1) ?? null;
  const releasedStandbyRouteEndSlot = releasedStandbyRouteEndNodeId
    ? internals.topLiftInboundApproachQueueSlot(releasedStandbyRouteEndNodeId)
    : null;
  return {
    vehicleId: vehicle.id,
    reason,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    localRouteReason: vehicle.localRouteReason,
    taskId: vehicle.taskId,
    taskKind: task?.kind ?? null,
    taskState: task?.state ?? null,
    taskLiftNodeId,
    contributesInboundQueueCoverage,
    standbyTargetNodeId,
    standbyTargetSlot: standbyTargetSlot ? `${standbyTargetSlot.liftNodeId}:s${standbyTargetSlot.slotIndex}` : null,
    releasedStandbyRouteLength: releasedStandbyRoute?.length ?? null,
    releasedStandbyRouteEndNodeId,
    releasedStandbyRouteEndSlot: releasedStandbyRouteEndSlot
      ? `${releasedStandbyRouteEndSlot.liftNodeId}:s${releasedStandbyRouteEndSlot.slotIndex}`
      : null,
    releasedStandbyRouteOriginAllowed: releasedStandbyRoute
      ? internals.tasklessInboundQueueStandbyRouteOriginAllowed(releasedStandbyRoute)
      : null,
    releasedStandbyRouteLevelPattern: releasedStandbyRoute ? routeLevelPattern(releasedStandbyRoute) : null,
    routeLength: route?.length ?? null,
    routeEndNodeId,
    routeEndSlot: routeEndSlot ? `${routeEndSlot.liftNodeId}:s${routeEndSlot.slotIndex}` : null,
    routeLevelPattern: route ? routeLevelPattern(route) : null
  };
}

function summarize(samples: Sample[], finalState: ShuttleSimState): Record<string, unknown> {
  const stationEntries = samples.flatMap((sample) => sample.stationContracts.stations);
  const coordinatorEntries = stationEntries.map((station) => station.coordinator);
  const ledgerEntries = samples.map((sample) => sample.stationContracts.inboundDemandLedger);
  const candidateEntries = samples.flatMap((sample) => sample.candidates);
  const releasedRouteCandidates = candidateEntries.filter((candidate) => candidate.releasedStandbyRouteLength !== null);
  const releasedOriginAllowed = releasedRouteCandidates.filter((candidate) => candidate.releasedStandbyRouteOriginAllowed);
  const noStationTargetWithUncoveredReadyDemand = samples.reduce((count, sample) => {
    const hasUncoveredReadyDemand = sample.stationContracts.stations.some((station) =>
      station.readyDemandCount > 0 && station.nearCoveredDepth < station.targetDepth
    );
    if (!hasUncoveredReadyDemand) {
      return count;
    }
    return count + sample.candidates.filter((candidate) => candidate.reason === 'no-station-target').length;
  }, 0);
  const reasonCounts = samples.reduce<Record<string, number>>((accumulator, sample) => {
    for (const [reason, count] of Object.entries(sample.candidateReasons)) {
      accumulator[reason] = (accumulator[reason] ?? 0) + count;
    }
    return accumulator;
  }, {});
  return {
    samples: samples.length,
    candidateReasons: reasonCounts,
    busyTaskKindCounts: countBy(
      candidateEntries.filter((candidate) => candidate.reason === 'busy-task'),
      (candidate) => candidate.taskKind ?? 'unknown'
    ),
    busyInboundCoverageCounts: countBy(
      candidateEntries.filter((candidate) => candidate.reason === 'busy-task' && candidate.taskKind === 'inbound'),
      (candidate) => candidate.contributesInboundQueueCoverage ? 'queue-covered' : 'not-queue-covered'
    ),
    noStationTargetWithUncoveredReadyDemand,
    releasedStandbyRouteSummary: {
      total: releasedRouteCandidates.length,
      originAllowed: releasedOriginAllowed.length,
      originAllowedLengthLe8: releasedOriginAllowed.filter((candidate) =>
        (candidate.releasedStandbyRouteLength ?? Number.POSITIVE_INFINITY) <= 8
      ).length,
      byLength: countBy(releasedRouteCandidates, (candidate) => String(candidate.releasedStandbyRouteLength)),
      byLevelPattern: countBy(releasedRouteCandidates, (candidate) => candidate.releasedStandbyRouteLevelPattern ?? 'none')
    },
    stationInvariantCounts: finalState.traffic.shadowLedger.stationContracts.invariantCounts,
    finalInboundDemandLedgerStatusCounts: finalState.traffic.shadowLedger.stationContracts.inboundDemandLedger.statusCounts,
    finalInboundDemandLedgerEntryCount: finalState.traffic.shadowLedger.stationContracts.inboundDemandLedger.entryCount,
    averageInboundDemandLedgerEntryCount: round(average(ledgerEntries.map((ledger) => ledger.entryCount)), 3),
    averageInboundDemandLedgerReadyCount: round(average(ledgerEntries.map((ledger) => ledger.statusCounts.ready)), 3),
    averageInboundDemandLedgerClaimedCount: round(average(ledgerEntries.map((ledger) => ledger.statusCounts.claimed)), 3),
    averageInboundDemandLedgerCompletedCount: round(average(ledgerEntries.map((ledger) => ledger.statusCounts.completed)), 3),
    averageQueueReservationCount: round(average(stationEntries.map((station) => station.queueReservationCount)), 3),
    averageNearCoveredDepth: round(average(stationEntries.map((station) => station.nearCoveredDepth)), 3),
    averageReadyDemandCount: round(average(stationEntries.map((station) => station.readyDemandCount)), 3),
    averageClaimedDemandCount: round(average(stationEntries.map((station) => station.claimedDemandCount)), 3),
    averageActiveServiceDepth: round(average(stationEntries.map((station) => station.activeServiceDepth)), 3),
    averageActiveAssignmentQueueLeaseCount: round(average(stationEntries.map((station) => station.activeAssignmentQueueLeaseCount)), 3),
    averageFarForecastDepth: round(average(stationEntries.map((station) => station.farForecastDepth)), 3),
    coordinatorDecisionCounts: countBy(coordinatorEntries, (coordinator) => coordinator.decision),
    averageCoordinatorQueueCoverageGap: round(average(coordinatorEntries.map((coordinator) => coordinator.queueCoverageGap)), 3),
    averageCoordinatorActiveServiceGap: round(average(coordinatorEntries.map((coordinator) => coordinator.activeServiceGap)), 3),
    averageCoordinatorDispatchableReserveCandidateCount: round(average(coordinatorEntries.map((coordinator) => coordinator.dispatchableReserveCandidateCount)), 3),
    coordinatorCandidateReasonCounts: coordinatorEntries.reduce<Record<string, number>>((accumulator, coordinator) => {
      for (const [reason, count] of Object.entries(coordinator.candidateReasonCounts)) {
        accumulator[reason] = (accumulator[reason] ?? 0) + count;
      }
      return accumulator;
    }, {}),
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

function routeLevelPattern(routeNodeIds: string[]): string {
  const levels = routeNodeIds.map(nodeLevel);
  return levels
    .filter((level, index) => index === 0 || level !== levels[index - 1])
    .join('>');
}

function nodeLevel(nodeId: string): string {
  if (nodeId.startsWith('storage-')) {
    return 'storage';
  }
  if (nodeId.includes('top-a')) {
    return 'top-a';
  }
  if (nodeId.includes('top-b')) {
    return 'top-b';
  }
  if (nodeId.includes('middle')) {
    return 'middle';
  }
  if (nodeId.includes('bottom-a')) {
    return 'bottom-a';
  }
  if (nodeId.includes('bottom-b')) {
    return 'bottom-b';
  }
  if (nodeId.includes('inbound')) {
    return 'inbound-port';
  }
  if (nodeId.includes('outbound')) {
    return 'outbound-port';
  }
  return 'other';
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
