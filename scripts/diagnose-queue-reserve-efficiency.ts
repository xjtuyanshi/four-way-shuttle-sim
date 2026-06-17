import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type InternalSim = ShuttleSimCore & {
  inboundLiftNodes(): Array<{ id: string }>;
  taskLiftPortNodeId(task: unknown): string | null;
  topLiftInboundQueueReplenishDemand(liftNodeId: string): number;
  topLiftInboundQueueReplenishTargetDepth(liftNodeId: string): number;
  topLiftInboundQueueStandbyDepth(liftNodeId: string): number;
  topLiftInboundActiveEmptyQueueDepth(liftNodeId: string): number;
  topLiftInboundQueueCoveredDepth(liftNodeId: string): number;
  topLiftInboundApproachQueueSlot(nodeId: string): { liftNodeId: string; slotIndex: number } | null;
  topLiftInboundApproachQueueNodeIds(liftNodeId: string): string[];
};

type QueueSample = {
  timeSec: number;
  liftCoverage: Array<{
    liftNodeId: string;
    demand: number;
    targetDepth: number;
    standbyDepth: number;
    activeEmptyDepth: number;
    coveredDepth: number;
  }>;
  reserveVehicles: Array<{
    id: string;
    state: string;
    currentNodeId: string;
    targetNodeId: string | null;
    plannedGoalNodeId: string | null;
    currentLevel: string;
    targetLevel: string | null;
    goalLevel: string | null;
    currentSlot: string | null;
    targetSlot: string | null;
    goalSlot: string | null;
    plannedRouteLength: number;
    routeLevels: string[];
    inQueueSlotNow: boolean;
    inTransitToQueue: boolean;
  }>;
  activeInboundVehicles: Array<{
    id: string;
    taskId: string | null;
    taskState: string | null;
    liftNodeId: string | null;
    pickupNodeId: string | null;
    dropoffNodeId: string | null;
    state: string;
    currentNodeId: string;
    targetNodeId: string | null;
    plannedGoalNodeId: string | null;
    currentLevel: string;
    targetLevel: string | null;
    goalLevel: string | null;
    currentSlot: string | null;
    targetSlot: string | null;
    goalSlot: string | null;
    plannedRouteLength: number;
    routeLevels: string[];
    inQueueSlotNow: boolean;
    inTransitToQueue: boolean;
    goalIsPickup: boolean;
    routeLeavesTopLevel: boolean;
  }>;
  waitingVehicles: Array<{
    id: string;
    taskId: string | null;
    state: string;
    waitReason: string | null;
    currentNodeId: string;
    targetNodeId: string | null;
    plannedGoalNodeId: string | null;
    blockedTimeSec: number;
    currentLevel: string;
    targetLevel: string | null;
    goalLevel: string | null;
    nearInboundQueue: boolean;
  }>;
  fleetVehicles: Array<{
    id: string;
    taskId: string | null;
    loaded: boolean;
    state: string;
    currentNodeId: string;
    targetNodeId: string | null;
    plannedGoalNodeId: string | null;
    localRouteReason: string | null;
    waitReason: string | null;
    currentLevel: string;
    targetLevel: string | null;
    goalLevel: string | null;
  }>;
};

const durationSec = numberArg('--duration-sec', 3600);
const sampleSec = numberArg('--sample-sec', 10);
const dtSec = numberArg('--dt-sec', 0.2);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const outputPath = resolve(stringArg('--out') ?? `output/review/queue-reserve-efficiency-${Date.now()}.json`);

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
const internals = sim as unknown as InternalSim;
const samples: QueueSample[] = [];
let nextSampleSec = 0;

sim.start();
for (let elapsedSec = 0; elapsedSec < durationSec - 1e-9 && sim.getClock().status === 'running'; elapsedSec += dtSec) {
  const state = sim.step(Math.min(dtSec, durationSec - elapsedSec));
  if (state.simTimeSec + 1e-9 < nextSampleSec) {
    continue;
  }
  samples.push(sampleState(state));
  nextSampleSec += sampleSec;
}

const finalState = sim.getState();
const summary = summarize(samples, finalState);
const report = {
  schemaVersion: 'shuttle.queueReserveEfficiency.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  config: {
    durationSec,
    sampleSec,
    dtSec,
    regionCount,
    shuttleCount,
    inboundRatePerHour,
    outboundRatePerHour,
    initialOutboundFullColumns,
    initialStorageFillPolicy
  },
  final: {
    simTimeSec: finalState.simTimeSec,
    status: finalState.status,
    kpis: finalState.kpis,
    traffic: finalState.traffic
  },
  summary,
  examples: {
    farReserveRoutes: samples
      .flatMap((sample) => sample.reserveVehicles
        .filter((vehicle) => vehicle.inTransitToQueue && (vehicle.currentLevel === 'middle' || vehicle.currentLevel.startsWith('bottom')))
        .map((vehicle) => ({ timeSec: sample.timeSec, ...vehicle }))
      )
      .slice(0, 40),
    farActiveInboundRoutes: samples
      .flatMap((sample) => sample.activeInboundVehicles
        .filter((vehicle) =>
          !vehicle.inQueueSlotNow &&
          (vehicle.currentLevel === 'storage' || vehicle.currentLevel === 'middle' || vehicle.currentLevel.startsWith('bottom') || vehicle.routeLeavesTopLevel)
        )
        .map((vehicle) => ({ timeSec: sample.timeSec, ...vehicle }))
      )
      .slice(0, 40),
    offQueueWaits: samples
      .flatMap((sample) => sample.waitingVehicles
        .filter((vehicle) => !vehicle.nearInboundQueue && vehicle.blockedTimeSec >= 2)
        .map((vehicle) => ({ timeSec: sample.timeSec, ...vehicle }))
      )
      .slice(0, 40),
    zeroCoverageFleet: samples
      .filter((sample) => sample.liftCoverage.some((lift) => lift.demand > 0 && lift.coveredDepth === 0))
      .slice(0, 8)
      .map((sample) => ({
        timeSec: sample.timeSec,
        liftCoverage: sample.liftCoverage,
        fleetVehicles: sample.fleetVehicles
      }))
      .slice(0, 40)
  },
  samples: samples.filter((sample) =>
    sample.reserveVehicles.some((vehicle) => vehicle.inTransitToQueue && (vehicle.currentLevel === 'middle' || vehicle.currentLevel.startsWith('bottom'))) ||
    sample.activeInboundVehicles.some((vehicle) =>
      !vehicle.inQueueSlotNow &&
      (vehicle.currentLevel === 'storage' || vehicle.currentLevel === 'middle' || vehicle.currentLevel.startsWith('bottom') || vehicle.routeLeavesTopLevel)
    ) ||
    sample.waitingVehicles.some((vehicle) => !vehicle.nearInboundQueue && vehicle.blockedTimeSec >= 2) ||
    sample.liftCoverage.some((lift) => lift.coveredDepth < lift.targetDepth)
  ).slice(0, 240)
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary }, null, 2));

function sampleState(state: ShuttleSimState): QueueSample {
  const liftCoverage = internals.inboundLiftNodes().map((lift) => ({
    liftNodeId: lift.id,
    demand: internals.topLiftInboundQueueReplenishDemand(lift.id),
    targetDepth: internals.topLiftInboundQueueReplenishTargetDepth(lift.id),
    standbyDepth: internals.topLiftInboundQueueStandbyDepth(lift.id),
    activeEmptyDepth: internals.topLiftInboundActiveEmptyQueueDepth(lift.id),
    coveredDepth: internals.topLiftInboundQueueCoveredDepth(lift.id)
  }));
  const reserveVehicles = state.vehicles
    .filter((vehicle) => !vehicle.loaded && vehicle.taskId === null && vehicle.localRouteReason === 'inbound-queue-standby')
    .map((vehicle) => {
      const currentSlot = slotLabel(vehicle.currentNodeId);
      const targetSlot = slotLabel(vehicle.targetNodeId);
      const goalSlot = slotLabel(vehicle.plannedGoalNodeId);
      return {
        id: vehicle.id,
        state: vehicle.state,
        currentNodeId: vehicle.currentNodeId,
        targetNodeId: vehicle.targetNodeId,
        plannedGoalNodeId: vehicle.plannedGoalNodeId,
        currentLevel: nodeLevel(vehicle.currentNodeId),
        targetLevel: vehicle.targetNodeId ? nodeLevel(vehicle.targetNodeId) : null,
        goalLevel: vehicle.plannedGoalNodeId ? nodeLevel(vehicle.plannedGoalNodeId) : null,
        currentSlot,
        targetSlot,
        goalSlot,
        plannedRouteLength: vehicle.plannedRouteNodeIds.length,
        routeLevels: vehicle.plannedRouteNodeIds.map(nodeLevel),
        inQueueSlotNow: currentSlot !== null,
        inTransitToQueue: currentSlot === null && goalSlot !== null
      };
    });
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const activeInboundVehicles = state.vehicles
    .map((vehicle) => {
      const task = vehicle.taskId ? tasksById.get(vehicle.taskId) ?? null : null;
      if (!task || task.kind !== 'inbound' || vehicle.loaded) {
        return null;
      }
      const currentSlot = slotLabel(vehicle.currentNodeId);
      const targetSlot = slotLabel(vehicle.targetNodeId);
      const goalSlot = slotLabel(vehicle.plannedGoalNodeId);
      const routeLevels = vehicle.plannedRouteNodeIds.map(nodeLevel);
      return {
        id: vehicle.id,
        taskId: vehicle.taskId,
        taskState: task.state,
        liftNodeId: internals.taskLiftPortNodeId(task),
        pickupNodeId: task.pickupNodeId,
        dropoffNodeId: task.dropoffNodeId,
        state: vehicle.state,
        currentNodeId: vehicle.currentNodeId,
        targetNodeId: vehicle.targetNodeId,
        plannedGoalNodeId: vehicle.plannedGoalNodeId,
        currentLevel: nodeLevel(vehicle.currentNodeId),
        targetLevel: vehicle.targetNodeId ? nodeLevel(vehicle.targetNodeId) : null,
        goalLevel: vehicle.plannedGoalNodeId ? nodeLevel(vehicle.plannedGoalNodeId) : null,
        currentSlot,
        targetSlot,
        goalSlot,
        plannedRouteLength: vehicle.plannedRouteNodeIds.length,
        routeLevels,
        inQueueSlotNow: currentSlot !== null,
        inTransitToQueue: currentSlot === null && goalSlot !== null,
        goalIsPickup: vehicle.plannedGoalNodeId === task.pickupNodeId,
        routeLeavesTopLevel: routeLevels.some((level) =>
          level === 'storage' ||
          level === 'middle' ||
          level === 'bottom-a' ||
          level === 'bottom-b'
        )
      };
    })
    .filter((vehicle): vehicle is QueueSample['activeInboundVehicles'][number] => vehicle !== null);
  const waitingVehicles = state.vehicles
    .filter((vehicle) => vehicle.waitReason !== null)
    .map((vehicle) => ({
      id: vehicle.id,
      taskId: vehicle.taskId,
      state: vehicle.state,
      waitReason: vehicle.waitReason,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      blockedTimeSec: vehicle.blockedTimeSec,
      currentLevel: nodeLevel(vehicle.currentNodeId),
      targetLevel: vehicle.targetNodeId ? nodeLevel(vehicle.targetNodeId) : null,
      goalLevel: vehicle.plannedGoalNodeId ? nodeLevel(vehicle.plannedGoalNodeId) : null,
      nearInboundQueue: [vehicle.currentNodeId, vehicle.targetNodeId, vehicle.plannedGoalNodeId]
        .some((nodeId) => slotLabel(nodeId) !== null)
    }));
  const fleetVehicles = state.vehicles.map((vehicle) => ({
    id: vehicle.id,
    taskId: vehicle.taskId,
    loaded: vehicle.loaded,
    state: vehicle.state,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    plannedGoalNodeId: vehicle.plannedGoalNodeId,
    localRouteReason: vehicle.localRouteReason,
    waitReason: vehicle.waitReason,
    currentLevel: nodeLevel(vehicle.currentNodeId),
    targetLevel: vehicle.targetNodeId ? nodeLevel(vehicle.targetNodeId) : null,
    goalLevel: vehicle.plannedGoalNodeId ? nodeLevel(vehicle.plannedGoalNodeId) : null
  }));
  return {
    timeSec: round(state.simTimeSec),
    liftCoverage,
    reserveVehicles,
    activeInboundVehicles,
    waitingVehicles,
    fleetVehicles
  };
}

function summarize(samples: QueueSample[], finalState: ShuttleSimState): Record<string, unknown> {
  const nonZeroSamples = samples.filter((sample) => sample.timeSec > 0);
  const liftEntries = nonZeroSamples.flatMap((sample) => sample.liftCoverage);
  const reserveEntries = nonZeroSamples.flatMap((sample) => sample.reserveVehicles);
  const activeInboundEntries = nonZeroSamples.flatMap((sample) => sample.activeInboundVehicles);
  const waitingEntries = nonZeroSamples.flatMap((sample) => sample.waitingVehicles);
  const fleetEntries = nonZeroSamples.flatMap((sample) => sample.fleetVehicles);
  return {
    samples: nonZeroSamples.length,
    averageCoveredDepth: round(average(liftEntries.map((lift) => lift.coveredDepth)), 3),
    averageStandbyDepth: round(average(liftEntries.map((lift) => lift.standbyDepth)), 3),
    pctLiftSamplesAtTargetDepth: round(percent(liftEntries.filter((lift) => lift.coveredDepth >= lift.targetDepth).length, liftEntries.length), 3),
    pctLiftSamplesWithTwoOrMoreCovered: round(percent(liftEntries.filter((lift) => lift.coveredDepth >= 2).length, liftEntries.length), 3),
    averageReserveVehicles: round(reserveEntries.length / Math.max(1, nonZeroSamples.length), 3),
    averageReserveInQueueSlot: round(nonZeroSamples.reduce((sum, sample) => sum + sample.reserveVehicles.filter((vehicle) => vehicle.inQueueSlotNow).length, 0) / Math.max(1, nonZeroSamples.length), 3),
    averageReserveInTransitToQueue: round(nonZeroSamples.reduce((sum, sample) => sum + sample.reserveVehicles.filter((vehicle) => vehicle.inTransitToQueue).length, 0) / Math.max(1, nonZeroSamples.length), 3),
    farReserveRouteSamples: reserveEntries.filter((vehicle) => vehicle.inTransitToQueue && (vehicle.currentLevel === 'middle' || vehicle.currentLevel.startsWith('bottom'))).length,
    averageActiveInboundEmptyVehicles: round(activeInboundEntries.length / Math.max(1, nonZeroSamples.length), 3),
    averageActiveInboundInQueueSlot: round(nonZeroSamples.reduce((sum, sample) => sum + sample.activeInboundVehicles.filter((vehicle) => vehicle.inQueueSlotNow).length, 0) / Math.max(1, nonZeroSamples.length), 3),
    averageActiveInboundInTransitToQueue: round(nonZeroSamples.reduce((sum, sample) => sum + sample.activeInboundVehicles.filter((vehicle) => vehicle.inTransitToQueue).length, 0) / Math.max(1, nonZeroSamples.length), 3),
    averageActiveInboundGoingDirectToPickup: round(nonZeroSamples.reduce((sum, sample) => sum + sample.activeInboundVehicles.filter((vehicle) => vehicle.goalIsPickup).length, 0) / Math.max(1, nonZeroSamples.length), 3),
    farActiveInboundRouteSamples: activeInboundEntries.filter((vehicle) =>
      !vehicle.inQueueSlotNow &&
      (vehicle.currentLevel === 'storage' || vehicle.currentLevel === 'middle' || vehicle.currentLevel.startsWith('bottom') || vehicle.routeLeavesTopLevel)
    ).length,
    offQueueWaitingSamples: waitingEntries.filter((vehicle) => !vehicle.nearInboundQueue && vehicle.blockedTimeSec >= 2).length,
    averageTasklessVehicles: round(fleetEntries.filter((vehicle) => !vehicle.loaded && vehicle.taskId === null).length / Math.max(1, nonZeroSamples.length), 3),
    averageTasklessTopVehicles: round(fleetEntries.filter((vehicle) =>
      !vehicle.loaded &&
      vehicle.taskId === null &&
      (vehicle.currentLevel === 'top-a' || vehicle.currentLevel === 'top-b' || vehicle.targetLevel === 'top-a' || vehicle.targetLevel === 'top-b')
    ).length / Math.max(1, nonZeroSamples.length), 3),
    finalKpis: {
      inboundPph: finalState.kpis.inboundPph,
      demandOutboundPph: finalState.kpis.demandOutboundPph,
      totalPph: finalState.kpis.totalPph,
      queueReserveTravelPct: round(average(Object.values(finalState.kpis.vehicleUtilizationBreakdown).map((breakdown) => breakdown.queueReserveTravel ?? 0)) * 100, 3),
      wasteRepositionPct: round(average(Object.values(finalState.kpis.vehicleUtilizationBreakdown).map((breakdown) => breakdown.wasteReposition ?? 0)) * 100, 3)
    },
    finalTraffic: {
      deadlocks: finalState.kpis.deadlockCount,
      livelocks: finalState.kpis.livelockCount,
      physicalViolations: finalState.traffic.physicalViolationCount
    }
  };
}

function slotLabel(nodeId: string | null | undefined): string | null {
  if (!nodeId) {
    return null;
  }
  const slot = internals.topLiftInboundApproachQueueSlot(nodeId);
  return slot ? `${slot.liftNodeId}:s${slot.slotIndex}` : null;
}

function nodeLevel(nodeId: string): string {
  if (nodeId.startsWith('storage-')) {
    return 'storage';
  }
  if (nodeId.includes('-top-a')) {
    return 'top-a';
  }
  if (nodeId.includes('-top-b')) {
    return 'top-b';
  }
  if (nodeId.includes('-middle')) {
    return 'middle';
  }
  if (nodeId.includes('-bottom-a')) {
    return 'bottom-a';
  }
  if (nodeId.includes('-bottom-b')) {
    return 'bottom-b';
  }
  if (slotLabel(nodeId)) {
    return 'queue';
  }
  return 'other';
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
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
