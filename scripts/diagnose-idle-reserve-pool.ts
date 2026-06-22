import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { EventLogEntry, ShuttleSimState, TaskStateRecord, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type InternalSim = ShuttleSimCore & {
  eventLog: EventLogEntry[];
  assignmentHoldActive(vehicle: VehicleState): boolean;
  inboundDropoffStandbyHoldActive(vehicle: VehicleState): boolean;
  tasklessInboundQueueStandbyRerouteAllowed(vehicle: VehicleState): boolean;
  routeToInboundQueueStandby(
    vehicle: VehicleState,
    fromNodeId?: string,
    options?: { allowTaskedVehicle?: boolean; liftNodeId?: string }
  ): string[] | null;
  tasklessInboundQueueStandbyRouteOriginAllowed(routeNodeIds: string[]): boolean;
  topLiftInboundQueueStandbyTargetNodeId(
    vehicle: VehicleState,
    fromNodeId?: string,
    options?: { allowTaskedVehicle?: boolean; liftNodeId?: string }
  ): string | null;
};

type HeadGapStation = {
  stationId: string;
  supplyGap: string;
  serviceGap: string;
};

type VehicleReserveClassification = {
  vehicleId: string;
  currentNodeId: string;
  level: string;
  taskId: string | null;
  taskKind: string | null;
  loaded: boolean;
  moving: boolean;
  state: string;
  waitReason: string | null;
  localRouteReason: string | null;
  plannedGoalNodeId: string | null;
  targetNodeId: string | null;
  candidateReason: string;
  reserveEligibleStationIds: string[];
  routeOriginDisallowedStationIds: string[];
  routeUnavailableStationIds: string[];
  noTargetStationIds: string[];
  shortestReserveRouteLength: number | null;
  shortestReserveRoutePattern: string | null;
};

type Sample = {
  timeSec: number;
  headGapStations: HeadGapStation[];
  vehicleClassifications: VehicleReserveClassification[];
  counts: {
    headGapCount: number;
    reserveEligibleVehicleCount: number;
    routeOriginDisallowedVehicleCount: number;
    idleTasklessVehicleCount: number;
    idleTasklessByLevel: Record<string, number>;
    candidateReasons: Record<string, number>;
    localRouteReasons: Record<string, number>;
  };
};

type CompletionDisposition = {
  timeSec: number;
  vehicleId: string;
  completedTaskId: string | null;
  completedTaskKind: string | null;
  currentNodeId: string;
  level: string;
  state: string;
  taskIdAfter: string | null;
  taskKindAfter: string | null;
  loadedAfter: boolean;
  movingAfter: boolean;
  waitReasonAfter: string | null;
  localRouteReasonAfter: string | null;
  plannedGoalNodeIdAfter: string | null;
  targetNodeIdAfter: string | null;
  headGapCountAfter: number;
  reserveEligibleStationIdsAfter: string[];
  routeOriginDisallowedStationIdsAfter: string[];
  routeUnavailableStationIdsAfter: string[];
  disposition: string;
};

const durationSec = numberArg('--duration-sec', 600);
const sampleSec = numberArg('--sample-sec', 10);
const dtSec = numberArg('--dt-sec', 0.2);
const progressSec = numberArg('--progress-sec', 0);
const outputPath = resolve(stringArg('--out') ?? `output/review/idle-reserve-pool-diagnosis-${Date.now()}.json`);

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

const sim = new ShuttleSimCore(scenario) as InternalSim;
const samples: Sample[] = [];
const completions: CompletionDisposition[] = [];
let nextSampleSec = 0;
let nextProgressSec = progressSec > 0 ? progressSec : Number.POSITIVE_INFINITY;
let eventCursor = 0;

sim.start();
eventCursor = sim.eventLog.length;
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
  const newEvents = sim.eventLog.slice(eventCursor);
  eventCursor = sim.eventLog.length;
  const state = sim.getState();
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const headGapStations = detectHeadGapStations(state);

  for (const event of newEvents) {
    if (event.eventType !== 'task-completed' || !event.vehicleId) {
      continue;
    }
    const vehicle = state.vehicles.find((candidate) => candidate.id === event.vehicleId);
    if (!vehicle) {
      continue;
    }
    completions.push(recordCompletionDisposition(event, vehicle, tasksById, headGapStations));
  }

  if (progressSec > 0 && state.simTimeSec + 1e-9 >= nextProgressSec) {
    console.error(JSON.stringify({ type: 'idle-reserve-pool-progress', timeSec: round(state.simTimeSec), durationSec }));
    while (nextProgressSec <= state.simTimeSec + 1e-9) {
      nextProgressSec += progressSec;
    }
  }

  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    samples.push(sampleState(state));
    while (nextSampleSec <= state.simTimeSec + 1e-9) {
      nextSampleSec += sampleSec;
    }
  }
}

const finalState = sim.getState();
const summary = summarize(samples, completions, finalState);
const report = {
  schemaVersion: 'shuttle.idleReservePoolDiagnosis.v1',
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
  samples,
  completions
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary }, null, 2));

function sampleState(state: ShuttleSimState): Sample {
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const headGapStations = detectHeadGapStations(state);
  const vehicleClassifications = state.vehicles.map((vehicle) =>
    classifyVehicleForReserve(vehicle, tasksById, headGapStations)
  );
  const idleTasklessVehicles = vehicleClassifications.filter((vehicle) =>
    vehicle.taskId === null &&
    !vehicle.loaded &&
    !vehicle.moving &&
    !vehicle.waitReason
  );
  return {
    timeSec: round(state.simTimeSec),
    headGapStations,
    vehicleClassifications,
    counts: {
      headGapCount: headGapStations.length,
      reserveEligibleVehicleCount: vehicleClassifications.filter((vehicle) => vehicle.reserveEligibleStationIds.length > 0).length,
      routeOriginDisallowedVehicleCount: vehicleClassifications.filter((vehicle) => vehicle.routeOriginDisallowedStationIds.length > 0).length,
      idleTasklessVehicleCount: idleTasklessVehicles.length,
      idleTasklessByLevel: countBy(idleTasklessVehicles, (vehicle) => vehicle.level),
      candidateReasons: countBy(vehicleClassifications, (vehicle) => vehicle.candidateReason),
      localRouteReasons: countBy(vehicleClassifications, (vehicle) => vehicle.localRouteReason ?? 'none')
    }
  };
}

function detectHeadGapStations(state: ShuttleSimState): HeadGapStation[] {
  return state.traffic.shadowLedger.stationContracts.stations
    .filter((station) =>
      station.headReservationSupply.gap === 'fleet-busy' ||
      station.headReservationSupply.gap === 'route-infeasible' ||
      station.headReservationSupply.gap === 'held-by-assignment' ||
      station.headReservationSupply.gap === 'dispatchable-candidate-available' ||
      station.serviceTransition.gap === 'waiting-for-head-reservation'
    )
    .map((station) => ({
      stationId: station.stationId,
      supplyGap: station.headReservationSupply.gap,
      serviceGap: station.serviceTransition.gap
    }))
    .sort((left, right) => left.stationId.localeCompare(right.stationId));
}

function classifyVehicleForReserve(
  vehicle: VehicleState,
  tasksById: Map<string, TaskStateRecord>,
  headGapStations: HeadGapStation[]
): VehicleReserveClassification {
  const moving = vehicle.currentEdgeId !== null || vehicle.legRemainingM > 0 || vehicle.phaseRemainingSec > 0;
  const task = vehicle.taskId ? tasksById.get(vehicle.taskId) ?? null : null;
  const routeChecks = headGapStations.map((station) => routeCheckForStation(vehicle, station.stationId));
  const reserveEligible = routeChecks.filter((check) => check.reason === 'reserve-eligible');
  const routeOriginDisallowed = routeChecks.filter((check) => check.reason === 'route-origin-disallowed');
  const routeUnavailable = routeChecks.filter((check) => check.reason === 'no-route');
  const noTarget = routeChecks.filter((check) => check.reason === 'no-target');
  const shortestReserve = reserveEligible
    .filter((check): check is RouteCheck & { routeLength: number; routePattern: string } =>
      check.routeLength !== null && check.routePattern !== null
    )
    .sort((left, right) => left.routeLength - right.routeLength || left.stationId.localeCompare(right.stationId))[0] ?? null;
  return {
    vehicleId: vehicle.id,
    currentNodeId: vehicle.currentNodeId,
    level: nodeLevel(vehicle.currentNodeId),
    taskId: vehicle.taskId,
    taskKind: task?.kind ?? null,
    loaded: vehicle.loaded,
    moving,
    state: vehicle.state,
    waitReason: vehicle.waitReason,
    localRouteReason: vehicle.localRouteReason,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    targetNodeId: vehicle.targetNodeId,
    candidateReason: candidateReason(vehicle, routeChecks),
    reserveEligibleStationIds: reserveEligible.map((check) => check.stationId).sort(),
    routeOriginDisallowedStationIds: routeOriginDisallowed.map((check) => check.stationId).sort(),
    routeUnavailableStationIds: routeUnavailable.map((check) => check.stationId).sort(),
    noTargetStationIds: noTarget.map((check) => check.stationId).sort(),
    shortestReserveRouteLength: shortestReserve?.routeLength ?? null,
    shortestReserveRoutePattern: shortestReserve?.routePattern ?? null
  };
}

type RouteCheck = {
  stationId: string;
  reason: 'reserve-eligible' | 'route-origin-disallowed' | 'no-route' | 'no-target' | 'not-applicable';
  routeLength: number | null;
  routePattern: string | null;
};

function routeCheckForStation(vehicle: VehicleState, stationId: string): RouteCheck {
  if (vehicle.taskId || vehicle.loaded || vehicle.currentEdgeId || vehicle.legRemainingM > 0 || vehicle.phaseRemainingSec > 0) {
    return { stationId, reason: 'not-applicable', routeLength: null, routePattern: null };
  }
  if (sim.assignmentHoldActive(vehicle) || sim.inboundDropoffStandbyHoldActive(vehicle)) {
    return { stationId, reason: 'not-applicable', routeLength: null, routePattern: null };
  }
  if (!sim.tasklessInboundQueueStandbyRerouteAllowed(vehicle)) {
    return { stationId, reason: 'not-applicable', routeLength: null, routePattern: null };
  }
  const targetNodeId = sim.topLiftInboundQueueStandbyTargetNodeId(vehicle, vehicle.currentNodeId, { liftNodeId: stationId });
  if (!targetNodeId) {
    return { stationId, reason: 'no-target', routeLength: null, routePattern: null };
  }
  const route = sim.routeToInboundQueueStandby(vehicle, vehicle.currentNodeId, { liftNodeId: stationId });
  if (!route || route.length <= 1) {
    return { stationId, reason: 'no-route', routeLength: null, routePattern: null };
  }
  if (!sim.tasklessInboundQueueStandbyRouteOriginAllowed(route)) {
    return {
      stationId,
      reason: 'route-origin-disallowed',
      routeLength: route.length,
      routePattern: routeLevelPattern(route)
    };
  }
  return {
    stationId,
    reason: 'reserve-eligible',
    routeLength: route.length,
    routePattern: routeLevelPattern(route)
  };
}

function candidateReason(vehicle: VehicleState, routeChecks: RouteCheck[]): string {
  if (vehicle.taskId) {
    return 'busy-task';
  }
  if (vehicle.loaded) {
    return 'busy-loaded';
  }
  if (vehicle.currentEdgeId || vehicle.legRemainingM > 0 || vehicle.phaseRemainingSec > 0) {
    return 'busy-moving';
  }
  if (sim.assignmentHoldActive(vehicle)) {
    return 'assignment-hold';
  }
  if (sim.inboundDropoffStandbyHoldActive(vehicle)) {
    return 'inbound-dropoff-standby-hold';
  }
  if (!sim.tasklessInboundQueueStandbyRerouteAllowed(vehicle)) {
    return 'standby-reroute-not-allowed';
  }
  if (routeChecks.length === 0) {
    return 'no-head-gap';
  }
  if (routeChecks.some((check) => check.reason === 'reserve-eligible')) {
    return 'reserve-eligible';
  }
  if (routeChecks.some((check) => check.reason === 'route-origin-disallowed')) {
    return 'route-origin-disallowed';
  }
  if (routeChecks.some((check) => check.reason === 'no-route')) {
    return 'no-route';
  }
  if (routeChecks.some((check) => check.reason === 'no-target')) {
    return 'no-target';
  }
  return 'not-applicable';
}

function recordCompletionDisposition(
  event: EventLogEntry,
  vehicle: VehicleState,
  tasksById: Map<string, TaskStateRecord>,
  headGapStations: HeadGapStation[]
): CompletionDisposition {
  const classification = classifyVehicleForReserve(vehicle, tasksById, headGapStations);
  const taskAfter = vehicle.taskId ? tasksById.get(vehicle.taskId) ?? null : null;
  return {
    timeSec: event.timeSec,
    vehicleId: vehicle.id,
    completedTaskId: event.taskId,
    completedTaskKind: typeof event.details.kind === 'string' ? event.details.kind : null,
    currentNodeId: vehicle.currentNodeId,
    level: classification.level,
    state: vehicle.state,
    taskIdAfter: vehicle.taskId,
    taskKindAfter: taskAfter?.kind ?? null,
    loadedAfter: vehicle.loaded,
    movingAfter: classification.moving,
    waitReasonAfter: vehicle.waitReason,
    localRouteReasonAfter: vehicle.localRouteReason,
    plannedGoalNodeIdAfter: vehicle.plannedGoalNodeId,
    targetNodeIdAfter: vehicle.targetNodeId,
    headGapCountAfter: headGapStations.length,
    reserveEligibleStationIdsAfter: classification.reserveEligibleStationIds,
    routeOriginDisallowedStationIdsAfter: classification.routeOriginDisallowedStationIds,
    routeUnavailableStationIdsAfter: classification.routeUnavailableStationIds,
    disposition: completionDisposition(vehicle, classification, taskAfter)
  };
}

function completionDisposition(
  vehicle: VehicleState,
  classification: VehicleReserveClassification,
  taskAfter: TaskStateRecord | null
): string {
  if (taskAfter) {
    return `assigned-${taskAfter.kind}`;
  }
  if (vehicle.loaded) {
    return 'loaded-without-task';
  }
  if (classification.moving && vehicle.localRouteReason) {
    return `moving-${vehicle.localRouteReason}`;
  }
  if (classification.moving) {
    return 'moving-taskless';
  }
  if (vehicle.localRouteReason === 'inbound-queue-standby') {
    return 'idle-inbound-queue-standby';
  }
  if (classification.reserveEligibleStationIds.length > 0) {
    return 'idle-reserve-eligible';
  }
  if (classification.routeOriginDisallowedStationIds.length > 0) {
    return 'idle-route-origin-disallowed';
  }
  if (vehicle.waitReason) {
    return `idle-wait-${vehicle.waitReason}`;
  }
  return `idle-${classification.level}`;
}

function summarize(
  samples: Sample[],
  completions: CompletionDisposition[],
  finalState: ShuttleSimState
): Record<string, unknown> {
  const samplesWithHeadGap = samples.filter((sample) => sample.counts.headGapCount > 0);
  const zeroReserveDuringHeadGap = samplesWithHeadGap.filter((sample) => sample.counts.reserveEligibleVehicleCount === 0);
  const vehicleEntries = samples.flatMap((sample) => sample.vehicleClassifications);
  const headGapVehicleEntries = samplesWithHeadGap.flatMap((sample) => sample.vehicleClassifications);
  const zeroReserveVehicleEntries = zeroReserveDuringHeadGap.flatMap((sample) => sample.vehicleClassifications);
  const idleTasklessEntries = vehicleEntries.filter((vehicle) =>
    vehicle.taskId === null &&
    !vehicle.loaded &&
    !vehicle.moving &&
    !vehicle.waitReason
  );
  const zeroReserveIdleTasklessEntries = zeroReserveVehicleEntries.filter((vehicle) =>
    vehicle.taskId === null &&
    !vehicle.loaded &&
    !vehicle.moving &&
    !vehicle.waitReason
  );
  return {
    samples: samples.length,
    samplesWithHeadGap: samplesWithHeadGap.length,
    samplesWithZeroReserveDuringHeadGap: zeroReserveDuringHeadGap.length,
    zeroReserveDuringHeadGapPct: round(zeroReserveDuringHeadGap.length / Math.max(1, samplesWithHeadGap.length), 4),
    averageHeadGapCount: round(average(samples.map((sample) => sample.counts.headGapCount)), 3),
    averageReserveEligibleVehicleCount: round(average(samples.map((sample) => sample.counts.reserveEligibleVehicleCount)), 3),
    averageRouteOriginDisallowedVehicleCount: round(average(samples.map((sample) => sample.counts.routeOriginDisallowedVehicleCount)), 3),
    averageIdleTasklessVehicleCount: round(average(samples.map((sample) => sample.counts.idleTasklessVehicleCount)), 3),
    idleTasklessByLevel: countBy(idleTasklessEntries, (vehicle) => vehicle.level),
    zeroReserveHeadGapIdleTasklessByLevel: countBy(zeroReserveIdleTasklessEntries, (vehicle) => vehicle.level),
    candidateReasonCounts: countBy(vehicleEntries, (vehicle) => vehicle.candidateReason),
    headGapCandidateReasonCounts: countBy(headGapVehicleEntries, (vehicle) => vehicle.candidateReason),
    zeroReserveHeadGapCandidateReasonCounts: countBy(zeroReserveVehicleEntries, (vehicle) => vehicle.candidateReason),
    localRouteReasonCounts: countBy(vehicleEntries, (vehicle) => vehicle.localRouteReason ?? 'none'),
    completionCount: completions.length,
    completionDispositionCounts: countBy(completions, (completion) => completion.disposition),
    completionDispositionByCompletedKind: countBy(
      completions,
      (completion) => `${completion.completedTaskKind ?? 'unknown'}:${completion.disposition}`
    ),
    completionHeadGapDispositionCounts: countBy(
      completions.filter((completion) => completion.headGapCountAfter > 0),
      (completion) => completion.disposition
    ),
    completionRouteOriginDisallowedAfterHeadGap: completions.filter((completion) =>
      completion.headGapCountAfter > 0 && completion.routeOriginDisallowedStationIdsAfter.length > 0
    ).length,
    completionReserveEligibleAfterHeadGap: completions.filter((completion) =>
      completion.headGapCountAfter > 0 && completion.reserveEligibleStationIdsAfter.length > 0
    ).length,
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
  if (nodeId.includes('parking')) {
    return 'parking';
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
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
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
