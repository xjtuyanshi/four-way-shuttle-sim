import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { EventLogEntry, ShuttleSimState, TaskStateRecord } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type SimWithEventLog = ShuttleSimCore & {
  eventLog: EventLogEntry[];
  assignmentHoldActive(vehicle: ShuttleSimState['vehicles'][number]): boolean;
  inboundDropoffStandbyHoldActive(vehicle: ShuttleSimState['vehicles'][number]): boolean;
  tasklessInboundQueueStandbyRerouteAllowed(vehicle: ShuttleSimState['vehicles'][number]): boolean;
  routeToInboundQueueStandby(
    vehicle: ShuttleSimState['vehicles'][number],
    fromNodeId?: string,
    options?: { allowTaskedVehicle?: boolean; liftNodeId?: string }
  ): string[] | null;
  tasklessInboundQueueStandbyRouteOriginAllowed(routeNodeIds: string[]): boolean;
  stationOwnedReserveAdmissionRouteAllowed(routeNodeIds: string[]): boolean;
};

type ReserveEligibleVehicle = {
  vehicleId: string;
  stationId: string;
  currentNodeId: string;
  routeLength: number;
  routeLevelPattern: string;
  topLane: boolean;
};

type PreAdmissionContext = {
  stationDemandCount: number;
  readyDemandCount: number;
  claimedDemandCount: number;
  physicalHeadReservationCount: number;
  queueReservationCount: number;
  activeServiceDepth: number;
  headGapCount: number;
  fleetBusyGapCount: number;
  gapCounts: Record<string, number>;
  headGapStationIds: string[];
  availableVehicleCount: number;
  reserveEligibleVehicleCount: number;
  shortReserveEligibleVehicleCount: number;
  topLaneReserveEligibleVehicleCount: number;
  reserveEligibleVehicleIds: string[];
  shortestReserveRouteLength: number | null;
  reserveEligibleVehicles: ReserveEligibleVehicle[];
};

type AssignmentAdmissionRecord = {
  timeSec: number;
  vehicleId: string | null;
  taskId: string;
  taskKind: 'inbound' | 'outbound' | 'unknown';
  taskStateBefore: string | null;
  taskLiftNodeId: string | null;
  pickupNodeId: string | null;
  dropoffNodeId: string | null;
  reason: string | null;
  routeLength: number | null;
  routeLevelPattern: string | null;
  preStationDemandCount: number;
  preReadyDemandCount: number;
  preClaimedDemandCount: number;
  prePhysicalHeadReservationCount: number;
  preQueueReservationCount: number;
  preActiveServiceDepth: number;
  preHeadGapCount: number;
  preFleetBusyGapCount: number;
  preGapCounts: Record<string, number>;
  preHeadGapStationIds: string[];
  preAvailableVehicleCount: number;
  preReserveEligibleVehicleCount: number;
  preShortReserveEligibleVehicleCount: number;
  preTopLaneReserveEligibleVehicleCount: number;
  preReserveEligibleVehicleIds: string[];
  preShortestReserveRouteLength: number | null;
  assignedVehicleWasReserveEligible: boolean;
  assignedVehicleReserveRouteLength: number | null;
  wouldReserveInsteadOfOutbound: boolean;
};

const durationSec = numberArg('--duration-sec', 600);
const dtSec = numberArg('--dt-sec', 0.2);
const progressSec = numberArg('--progress-sec', 0);
const outputPath = resolve(stringArg('--out') ?? `output/review/assignment-admission-diagnosis-${Date.now()}.json`);

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

const sim = new ShuttleSimCore(scenario) as SimWithEventLog;
const assignmentRecords: AssignmentAdmissionRecord[] = [];
let nextProgressSec = progressSec > 0 ? progressSec : Number.POSITIVE_INFINITY;
let eventCursor = 0;

sim.start();
eventCursor = sim.eventLog.length;

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const preState = sim.getState();
  const preContext = admissionContext(preState);
  const stepSec = Math.min(dtSec, durationSec - sim.getClock().simTimeSec);
  if (stepSec <= 1e-9 || !Number.isFinite(stepSec)) {
    break;
  }
  sim.advanceByInPlace(stepSec);
  const newEvents = sim.eventLog.slice(eventCursor);
  eventCursor = sim.eventLog.length;
  const postState = sim.getState();
  const preTasksById = new Map(preState.tasks.map((task) => [task.id, task]));
  const postTasksById = new Map(postState.tasks.map((task) => [task.id, task]));
  for (const event of newEvents) {
    if (event.eventType !== 'task-assigned' || !event.taskId) {
      continue;
    }
    const task = preTasksById.get(event.taskId) ?? postTasksById.get(event.taskId) ?? null;
    assignmentRecords.push(recordAssignmentAdmission(event, task, preContext));
  }

  if (progressSec > 0 && postState.simTimeSec + 1e-9 >= nextProgressSec) {
    console.error(JSON.stringify({ type: 'assignment-admission-progress', timeSec: round(postState.simTimeSec), durationSec }));
    while (nextProgressSec <= postState.simTimeSec + 1e-9) {
      nextProgressSec += progressSec;
    }
  }
}

const finalState = sim.getState();
const summary = summarize(assignmentRecords, finalState);
const report = {
  schemaVersion: 'shuttle.assignmentAdmissionDiagnosis.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  config: { durationSec, dtSec },
  summary,
  final: {
    simTimeSec: finalState.simTimeSec,
    status: finalState.status,
    kpis: finalState.kpis,
    stationContracts: finalState.traffic.shadowLedger.stationContracts
  },
  assignments: assignmentRecords
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary }, null, 2));

function recordAssignmentAdmission(
  event: EventLogEntry,
  task: TaskStateRecord | null,
  preContext: PreAdmissionContext
): AssignmentAdmissionRecord {
  const route = typeof event.details.route === 'string' ? event.details.route.split('>').filter(Boolean) : [];
  const taskKind = task?.kind ?? 'unknown';
  const assignedReserveEligibility = preContext.reserveEligibleVehicles
    .filter((entry) => entry.vehicleId === event.vehicleId)
    .sort((left, right) => left.routeLength - right.routeLength || left.stationId.localeCompare(right.stationId))[0] ?? null;
  const wouldReserveInsteadOfOutbound = taskKind === 'outbound' && preContext.reserveEligibleVehicleCount > 0;
  return {
    timeSec: event.timeSec,
    vehicleId: event.vehicleId,
    taskId: event.taskId!,
    taskKind,
    taskStateBefore: task?.state ?? null,
    taskLiftNodeId: task ? liftNodeIdForTask(task) : null,
    pickupNodeId: task?.pickupNodeId ?? null,
    dropoffNodeId: task?.dropoffNodeId ?? null,
    reason: event.reason,
    routeLength: route.length > 0 ? route.length : null,
    routeLevelPattern: route.length > 0 ? routeLevelPattern(route) : null,
    preStationDemandCount: preContext.stationDemandCount,
    preReadyDemandCount: preContext.readyDemandCount,
    preClaimedDemandCount: preContext.claimedDemandCount,
    prePhysicalHeadReservationCount: preContext.physicalHeadReservationCount,
    preQueueReservationCount: preContext.queueReservationCount,
    preActiveServiceDepth: preContext.activeServiceDepth,
    preHeadGapCount: preContext.headGapCount,
    preFleetBusyGapCount: preContext.fleetBusyGapCount,
    preGapCounts: preContext.gapCounts,
    preHeadGapStationIds: preContext.headGapStationIds,
    preAvailableVehicleCount: preContext.availableVehicleCount,
    preReserveEligibleVehicleCount: preContext.reserveEligibleVehicleCount,
    preShortReserveEligibleVehicleCount: preContext.shortReserveEligibleVehicleCount,
    preTopLaneReserveEligibleVehicleCount: preContext.topLaneReserveEligibleVehicleCount,
    preReserveEligibleVehicleIds: preContext.reserveEligibleVehicleIds,
    preShortestReserveRouteLength: preContext.shortestReserveRouteLength,
    assignedVehicleWasReserveEligible: assignedReserveEligibility !== null,
    assignedVehicleReserveRouteLength: assignedReserveEligibility?.routeLength ?? null,
    wouldReserveInsteadOfOutbound
  };
}

function admissionContext(state: ShuttleSimState): PreAdmissionContext {
  const stations = state.traffic.shadowLedger.stationContracts.stations;
  const headGapStations = stations.filter((station) =>
    station.headReservationSupply.gap === 'fleet-busy' ||
    station.headReservationSupply.gap === 'route-infeasible' ||
    station.headReservationSupply.gap === 'held-by-assignment' ||
    station.headReservationSupply.gap === 'dispatchable-candidate-available' ||
    station.serviceTransition.gap === 'waiting-for-head-reservation'
  );
  const availableVehicles = state.vehicles.filter((vehicle) =>
    !vehicle.taskId &&
    !vehicle.loaded &&
    vehicle.currentEdgeId === null &&
    vehicle.legRemainingM <= 0 &&
    vehicle.phaseRemainingSec <= 0 &&
    !sim.assignmentHoldActive(vehicle) &&
    !sim.inboundDropoffStandbyHoldActive(vehicle) &&
    sim.tasklessInboundQueueStandbyRerouteAllowed(vehicle)
  );
  const reserveEligibleVehicles = availableVehicles
    .flatMap((vehicle) => {
      return headGapStations.map((station) => {
        const route = sim.routeToInboundQueueStandby(vehicle, vehicle.currentNodeId, { liftNodeId: station.stationId });
        const reserveEligible = route &&
          route.length > 1 &&
          (
            sim.tasklessInboundQueueStandbyRouteOriginAllowed(route) ||
            sim.stationOwnedReserveAdmissionRouteAllowed(route)
          );
        if (!route || !reserveEligible) {
          return null;
        }
        const level = nodeLevel(vehicle.currentNodeId);
        return {
          vehicleId: vehicle.id,
          stationId: station.stationId,
          currentNodeId: vehicle.currentNodeId,
          routeLength: route.length,
          routeLevelPattern: routeLevelPattern(route),
          topLane: level === 'top-a' || level === 'top-b'
        };
      });
    })
    .filter((entry): entry is ReserveEligibleVehicle => entry !== null)
    .sort((left, right) =>
      left.routeLength - right.routeLength ||
      left.vehicleId.localeCompare(right.vehicleId) ||
      left.stationId.localeCompare(right.stationId)
    );
  const reserveEligibleVehicleIds = [...new Set(reserveEligibleVehicles.map((entry) => entry.vehicleId))].sort();
  const shortReserveEligibleVehicleIds = new Set(
    reserveEligibleVehicles.filter((entry) => entry.routeLength <= 8).map((entry) => entry.vehicleId)
  );
  const topLaneReserveEligibleVehicleIds = new Set(
    reserveEligibleVehicles.filter((entry) => entry.topLane).map((entry) => entry.vehicleId)
  );
  return {
    stationDemandCount: sum(stations.map((station) => station.demandCount)),
    readyDemandCount: sum(stations.map((station) => station.readyDemandCount)),
    claimedDemandCount: sum(stations.map((station) => station.claimedDemandCount)),
    physicalHeadReservationCount: sum(stations.map((station) => station.headReservationSupply.physicalHeadReservationVehicleId ? 1 : 0)),
    queueReservationCount: sum(stations.map((station) => station.queueReservationCount)),
    activeServiceDepth: sum(stations.map((station) => station.activeServiceDepth)),
    headGapCount: headGapStations.length,
    fleetBusyGapCount: headGapStations.filter((station) => station.headReservationSupply.gap === 'fleet-busy').length,
    gapCounts: countBy(headGapStations, (station) => station.headReservationSupply.gap),
    headGapStationIds: headGapStations.map((station) => station.stationId).sort(),
    availableVehicleCount: availableVehicles.length,
    reserveEligibleVehicleCount: reserveEligibleVehicleIds.length,
    shortReserveEligibleVehicleCount: shortReserveEligibleVehicleIds.size,
    topLaneReserveEligibleVehicleCount: topLaneReserveEligibleVehicleIds.size,
    reserveEligibleVehicleIds,
    shortestReserveRouteLength: reserveEligibleVehicles[0]?.routeLength ?? null,
    reserveEligibleVehicles
  };
}

function summarize(records: AssignmentAdmissionRecord[], finalState: ShuttleSimState): Record<string, unknown> {
  const outboundRecords = records.filter((record) => record.taskKind === 'outbound');
  const inboundRecords = records.filter((record) => record.taskKind === 'inbound');
  const outboundHeadGapRecords = outboundRecords.filter((record) => record.preHeadGapCount > 0);
  const outboundWouldReserve = outboundRecords.filter((record) => record.wouldReserveInsteadOfOutbound);
  const outboundAssignedReserveEligible = outboundRecords.filter((record) => record.assignedVehicleWasReserveEligible);
  return {
    totalAssignments: records.length,
    inboundAssignments: inboundRecords.length,
    outboundAssignments: outboundRecords.length,
    outboundWhileHeadGap: outboundHeadGapRecords.length,
    outboundWhileFleetBusyGap: outboundHeadGapRecords.filter((record) => record.preFleetBusyGapCount > 0).length,
    outboundWhileReserveEligible: outboundWouldReserve.length,
    outboundAssignedReserveEligible: outboundAssignedReserveEligible.length,
    outboundWhileReserveEligiblePct: round(outboundWouldReserve.length / Math.max(1, outboundRecords.length), 4),
    outboundAssignedReserveEligiblePct: round(outboundAssignedReserveEligible.length / Math.max(1, outboundRecords.length), 4),
    averagePreReadyDemandForOutbound: round(average(outboundRecords.map((record) => record.preReadyDemandCount)), 3),
    averagePreHeadGapCountForOutbound: round(average(outboundRecords.map((record) => record.preHeadGapCount)), 3),
    averagePreAvailableVehicleCountForOutbound: round(average(outboundRecords.map((record) => record.preAvailableVehicleCount)), 3),
    averagePreReserveEligibleVehicleCountForOutbound: round(average(outboundRecords.map((record) => record.preReserveEligibleVehicleCount)), 3),
    averagePreTopLaneReserveEligibleVehicleCountForOutbound: round(average(outboundRecords.map((record) => record.preTopLaneReserveEligibleVehicleCount)), 3),
    shortestReserveRouteLengthForOutbound: minNullable(outboundRecords.map((record) => record.preShortestReserveRouteLength)),
    outboundAssignedReserveEligibleRoutePatterns: countBy(outboundAssignedReserveEligible, (record) => record.routeLevelPattern ?? 'unknown'),
    outboundWhileHeadGapRoutePatterns: countBy(outboundHeadGapRecords, (record) => record.routeLevelPattern ?? 'unknown'),
    outboundWhileHeadGapStationCounts: outboundHeadGapRecords.reduce<Record<string, number>>((accumulator, record) => {
      for (const stationId of record.preHeadGapStationIds) {
        accumulator[stationId] = (accumulator[stationId] ?? 0) + 1;
      }
      return accumulator;
    }, {}),
    assignmentKindCounts: countBy(records, (record) => record.taskKind),
    outboundReasonCounts: countBy(outboundRecords, (record) => record.reason ?? 'none'),
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

function minNullable(values: Array<number | null>): number | null {
  const numericValues = values.filter((value): value is number => value !== null);
  return numericValues.length > 0 ? Math.min(...numericValues) : null;
}

function liftNodeIdForTask(task: TaskStateRecord): string | null {
  const nodeId = task.kind === 'inbound' ? task.pickupNodeId : task.dropoffNodeId;
  const direct = /^(lift-\d{2}-(?:inbound|outbound))/.exec(nodeId);
  if (direct) {
    return direct[1]!;
  }
  const buffer = /^(lift-\d{2}-(?:inbound|outbound))-buffer-\d+$/.exec(nodeId);
  if (buffer) {
    return buffer[1]!;
  }
  const queue = /^(lift-\d{2}-(?:inbound|outbound))-queue-/.exec(nodeId);
  return queue?.[1] ?? null;
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
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
