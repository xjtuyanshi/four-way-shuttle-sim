import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, TaskStateRecord, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type LayoutNode = ReturnType<typeof createInboundOutboundDemoScenario>['layout']['nodes'][number];
type LiftInfo = {
  id: string;
  pickupNodeId: string | null;
  queueNodeIds: Set<string>;
};
type Incident = {
  timeSec: number;
  vehicleId: string;
  taskId: string | null;
  liftId: string | null;
  code: string;
  detail: string;
  route: string[];
};
type PerLiftSample = {
  queueDepth: number;
  createdInbound: number;
  completedInbound: number;
  queuedInbound: number;
  assignedInbound: number;
  inProgressInbound: number;
  activeInboundEmpty: number;
  loadedInboundVehicles: number;
  waitingInboundVehicles: number;
  lowerStartInboundApproaches: number;
  vehicleWaitReasons: Record<string, number>;
  taskWaitReasons: Record<string, number>;
};

const durationSec = numberArg('--duration-sec', 1800);
const sampleSec = numberArg('--sample-sec', 5);
const dtSec = numberArg('--dt-sec', 0.2);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const outputPath = resolve(stringArg('--out') ?? `output/review/top-lift-queue-behavior-${Date.now()}.json`);
const quiet = process.argv.includes('--quiet');

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
const nodeById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
const inboundLifts = createInboundLiftInfo();
const incidents: Incident[] = [];
const incidentKeys = new Set<string>();
const samples: Array<{
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  queuedTasks: number;
  activeTasks: number;
  queueDepthByLift: Record<string, number>;
  tasklessQueueStandbyDepthByLift: Record<string, number>;
  totalVisibleQueueDepthByLift: Record<string, number>;
  perLift: Record<string, PerLiftSample>;
  fleetVisibleInboundQueueDepth: number;
  fleetTasklessQueueStandbyDepth: number;
  fleetTotalVisibleInboundQueueDepth: number;
  minVisibleInboundQueueDepthByLift: number;
  maxVisibleInboundQueueDepthByLift: number;
  minTotalVisibleInboundQueueDepthByLift: number;
  maxTotalVisibleInboundQueueDepthByLift: number;
  inboundEmptyAssigned: number;
  inboundEmptyNearQueue: number;
  inboundEmptyFarFromQueue: number;
  inboundEmptyLowerLevelApproach: number;
  inboundEmptyLowerLevelQueueApproach: number;
  inboundEmptyLowerLevelPickupApproach: number;
  inboundEmptyLowerLevelFromLowerStart: number;
  inboundEmptyTopToLowerDetour: number;
  inboundEmptyTopLevelDetour: number;
  waitingVehicles: number;
  farInboundWaits: number;
  tasklessTravelPct: number;
  topBlockedReasons: Array<{ reason: string; sec: number }>;
}> = [];
let nextSampleSec = 0;

sim.start();
for (let elapsedSec = 0; elapsedSec < durationSec - 1e-9 && sim.getClock().status === 'running'; elapsedSec += dtSec) {
  const state = sim.step(Math.min(dtSec, durationSec - elapsedSec));
  auditState(state);
  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    const sample = createSample(state);
    samples.push(sample);
    if (!quiet) {
      console.log(JSON.stringify({ type: 'top-lift-queue-sample', ...sample }));
    }
    nextSampleSec += sampleSec;
  }
}

const finalState = sim.getState();
const report = {
  schemaVersion: 'shuttle.topLiftQueueBehaviorAudit.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
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
  summary: {
    completedInbound: finalState.kpis.completedInbound,
    completedOutbound: finalState.kpis.completedOutbound,
    totalPph: round(finalState.kpis.totalPph, 3),
    averageTasklessTravelPct: round(average(samples.map((sample) => sample.tasklessTravelPct)), 3),
    averageMinVisibleInboundQueueDepthByLift: round(average(samples.map((sample) => sample.minVisibleInboundQueueDepthByLift)), 3),
    maxVisibleInboundQueueDepthByLift: max(samples.map((sample) => sample.maxVisibleInboundQueueDepthByLift)),
    averageVisibleInboundQueueDepthFleet: round(average(samples.map((sample) => sample.fleetVisibleInboundQueueDepth)), 3),
    averageTasklessQueueStandbyDepthFleet: round(average(samples.map((sample) => sample.fleetTasklessQueueStandbyDepth)), 3),
    averageTotalVisibleInboundQueueDepthFleet: round(average(samples.map((sample) => sample.fleetTotalVisibleInboundQueueDepth)), 3),
    pctSamplesWithTwoOrMoreAtAnyInboundLift: pct(samples, (sample) => sample.maxVisibleInboundQueueDepthByLift >= 2),
    pctSamplesWithTwoOrMoreAtEveryInboundLift: pct(samples, (sample) => sample.minVisibleInboundQueueDepthByLift >= 2),
    pctSamplesWithTotalTwoOrMoreAtAnyInboundLift: pct(samples, (sample) => sample.maxTotalVisibleInboundQueueDepthByLift >= 2),
    pctSamplesWithTotalTwoOrMoreAtEveryInboundLift: pct(samples, (sample) => sample.minTotalVisibleInboundQueueDepthByLift >= 2),
    pctSamplesWithOneOrLessAtAnyInboundLift: pct(samples, (sample) => sample.minVisibleInboundQueueDepthByLift <= 1),
    perLiftQueueDepth: Object.fromEntries(inboundLifts.map((lift) => [
      lift.id,
      {
        average: round(average(samples.map((sample) => sample.queueDepthByLift[lift.id] ?? 0)), 3),
        pctTwoOrMore: pct(samples, (sample) => (sample.queueDepthByLift[lift.id] ?? 0) >= 2),
        pctOneOrLess: pct(samples, (sample) => (sample.queueDepthByLift[lift.id] ?? 0) <= 1),
        pctZero: pct(samples, (sample) => (sample.queueDepthByLift[lift.id] ?? 0) === 0)
      }
    ])),
    perLiftFlow: Object.fromEntries(inboundLifts.map((lift) => [
      lift.id,
      {
        createdInbound: samples.at(-1)?.perLift[lift.id]?.createdInbound ?? 0,
        completedInbound: samples.at(-1)?.perLift[lift.id]?.completedInbound ?? 0,
        averageActiveInboundEmpty: round(average(samples.map((sample) => sample.perLift[lift.id]?.activeInboundEmpty ?? 0)), 3),
        averageLoadedInboundVehicles: round(average(samples.map((sample) => sample.perLift[lift.id]?.loadedInboundVehicles ?? 0)), 3),
        averageWaitingInboundVehicles: round(average(samples.map((sample) => sample.perLift[lift.id]?.waitingInboundVehicles ?? 0)), 3),
        averageLowerStartInboundApproaches: round(average(samples.map((sample) => sample.perLift[lift.id]?.lowerStartInboundApproaches ?? 0)), 3)
      }
    ])),
    pctSamplesWithInboundEmptyFarFromQueue: pct(samples, (sample) => sample.inboundEmptyFarFromQueue > 0),
    pctSamplesWithLowerLevelInboundApproach: pct(samples, (sample) => sample.inboundEmptyLowerLevelApproach > 0),
    pctSamplesWithLowerLevelInboundQueueApproach: pct(samples, (sample) => sample.inboundEmptyLowerLevelQueueApproach > 0),
    pctSamplesWithLowerLevelInboundPickupApproach: pct(samples, (sample) => sample.inboundEmptyLowerLevelPickupApproach > 0),
    pctSamplesWithLowerStartInboundApproach: pct(samples, (sample) => sample.inboundEmptyLowerLevelFromLowerStart > 0),
    pctSamplesWithTopToLowerInboundDetour: pct(samples, (sample) => sample.inboundEmptyTopToLowerDetour > 0),
    pctSamplesWithTopLevelInboundDetour: pct(samples, (sample) => sample.inboundEmptyTopLevelDetour > 0),
    pctSamplesWithFarInboundWait: pct(samples, (sample) => sample.farInboundWaits > 0),
    incidentCounts: countBy(incidents, (incident) => incident.code),
    topBlockedReasons: Object.entries(finalState.kpis.blockedTimeByReasonSec)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([reason, sec]) => ({ reason, sec: round(sec, 3) }))
  },
  lifts: inboundLifts.map((lift) => ({
    id: lift.id,
    pickupNodeId: lift.pickupNodeId,
    queueNodeIds: [...lift.queueNodeIds].sort()
  })),
  samples,
  incidents: incidents.slice(0, 200)
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ type: 'top-lift-queue-complete', outputPath, summary: report.summary }, null, 2));

function createInboundLiftInfo(): LiftInfo[] {
  const topANodes = scenario.layout.nodes
    .filter((node) => /^column-top-a-c\d+$/.test(node.id))
    .sort((left, right) => left.x - right.x || left.id.localeCompare(right.id));

  return scenario.layout.nodes
    .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((lift) => {
      const pickupNode = topANodes
        .filter((node) => node.x > lift.x)
        .sort((left, right) => Math.abs(left.x - lift.x) - Math.abs(right.x - lift.x) || left.id.localeCompare(right.id))[0] ?? null;
      const queueNodeIds = new Set<string>();
      for (const node of scenario.layout.nodes) {
        if (
          node.id.startsWith(`${lift.id}-queue`) ||
          node.id.startsWith(`parking-${lift.id}-queue`) ||
          node.id === `${lift.id}-buffer-access`
        ) {
          queueNodeIds.add(node.id);
        }
      }
      if (pickupNode) {
        const pickupIndex = topANodes.findIndex((node) => node.id === pickupNode.id);
        for (const node of topANodes.slice(pickupIndex, pickupIndex + 4)) {
          queueNodeIds.add(node.id);
        }
      }
      return {
        id: lift.id,
        pickupNodeId: pickupNode?.id ?? null,
        queueNodeIds
      };
    });
}

function createSample(state: ShuttleSimState): typeof samples[number] {
  const activeInboundEmptyVehicles = inboundEmptyVehicles(state);
  const tasklessQueueStandbyVehicles = inboundTasklessQueueStandbyVehicles(state);
  const queueDepthByLift = inboundLifts.map((lift) =>
    activeInboundEmptyVehicles.filter(({ vehicle }) => vehicleTouchesLiftQueue(vehicle, lift)).length
  );
  const queueDepthByLiftId = Object.fromEntries(inboundLifts.map((lift, index) => [lift.id, queueDepthByLift[index] ?? 0]));
  const tasklessQueueStandbyDepthByLift = inboundLifts.map((lift) =>
    tasklessQueueStandbyVehicles.filter((vehicle) => vehicleTouchesLiftQueue(vehicle, lift)).length
  );
  const tasklessQueueStandbyDepthByLiftId = Object.fromEntries(inboundLifts.map((lift, index) => [lift.id, tasklessQueueStandbyDepthByLift[index] ?? 0]));
  const totalVisibleQueueDepthByLift = inboundLifts.map((_, index) =>
    (queueDepthByLift[index] ?? 0) + (tasklessQueueStandbyDepthByLift[index] ?? 0)
  );
  const totalVisibleQueueDepthByLiftId = Object.fromEntries(inboundLifts.map((lift, index) => [lift.id, totalVisibleQueueDepthByLift[index] ?? 0]));
  const perLift = createPerLiftSample(state, activeInboundEmptyVehicles, queueDepthByLiftId);
  const lowerLevelApproach = activeInboundEmptyVehicles.filter(({ vehicle }) =>
    routeHasLowerLevelApproach(vehicleRouteTail(vehicle))
  );
  const lowerLevelQueueApproach = lowerLevelApproach.filter(({ vehicle, task }) =>
    routeEndsAtInboundQueue(vehicleRouteTail(vehicle), task)
  );
  const lowerLevelPickupApproach = lowerLevelApproach.filter(({ vehicle, task }) =>
    routeEndsAtInboundPickup(vehicleRouteTail(vehicle), task)
  );
  const lowerLevelFromLowerStart = lowerLevelApproach.filter(({ vehicle }) =>
    routeStartsOnLowerSide(vehicleRouteTail(vehicle))
  );
  const topToLowerDetours = lowerLevelApproach.filter(({ vehicle }) =>
    routeHasTopLevelDetour(vehicleRouteTail(vehicle))
  );
  const topLevelDetours = activeInboundEmptyVehicles.filter(({ vehicle }) =>
    routeHasTopLevelDetour(vehicleRouteTail(vehicle))
  );
  const farFromQueue = activeInboundEmptyVehicles.filter(({ vehicle }) => !vehicleTouchesAnyLiftQueue(vehicle));
  const farWaits = activeInboundEmptyVehicles.filter(({ vehicle }) =>
    vehicle.state === 'waiting-blocked' &&
    !vehicleTouchesAnyLiftQueue(vehicle) &&
    routeDistanceToAnyLiftQueue(vehicle) >= 3
  );
  const breakdowns = Object.values(state.kpis.vehicleUtilizationBreakdown);

  return {
    timeSec: round(state.simTimeSec),
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    totalPph: round(state.kpis.totalPph, 3),
    queuedTasks: state.kpis.queuedTasks,
    activeTasks: state.kpis.activeTasks,
    queueDepthByLift: queueDepthByLiftId,
    tasklessQueueStandbyDepthByLift: tasklessQueueStandbyDepthByLiftId,
    totalVisibleQueueDepthByLift: totalVisibleQueueDepthByLiftId,
    perLift,
    fleetVisibleInboundQueueDepth: sum(queueDepthByLift),
    fleetTasklessQueueStandbyDepth: sum(tasklessQueueStandbyDepthByLift),
    fleetTotalVisibleInboundQueueDepth: sum(totalVisibleQueueDepthByLift),
    minVisibleInboundQueueDepthByLift: queueDepthByLift.length > 0 ? Math.min(...queueDepthByLift) : 0,
    maxVisibleInboundQueueDepthByLift: max(queueDepthByLift),
    minTotalVisibleInboundQueueDepthByLift: totalVisibleQueueDepthByLift.length > 0 ? Math.min(...totalVisibleQueueDepthByLift) : 0,
    maxTotalVisibleInboundQueueDepthByLift: max(totalVisibleQueueDepthByLift),
    inboundEmptyAssigned: activeInboundEmptyVehicles.length,
    inboundEmptyNearQueue: activeInboundEmptyVehicles.length - farFromQueue.length,
    inboundEmptyFarFromQueue: farFromQueue.length,
    inboundEmptyLowerLevelApproach: lowerLevelApproach.length,
    inboundEmptyLowerLevelQueueApproach: lowerLevelQueueApproach.length,
    inboundEmptyLowerLevelPickupApproach: lowerLevelPickupApproach.length,
    inboundEmptyLowerLevelFromLowerStart: lowerLevelFromLowerStart.length,
    inboundEmptyTopToLowerDetour: topToLowerDetours.length,
    inboundEmptyTopLevelDetour: topLevelDetours.length,
    waitingVehicles: state.traffic.waitingVehicles.length,
    farInboundWaits: farWaits.length,
    tasklessTravelPct: round(average(breakdowns.map((breakdown) => breakdown.tasklessTravel)) * 100, 3),
    topBlockedReasons: Object.entries(state.kpis.blockedTimeByReasonSec)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([reason, sec]) => ({ reason, sec: round(sec, 3) }))
  };
}

function createPerLiftSample(
  state: ShuttleSimState,
  activeInboundEmptyVehicles: Array<{ vehicle: VehicleState; task: TaskStateRecord }>,
  queueDepthByLift: Record<string, number>
): Record<string, PerLiftSample> {
  return Object.fromEntries(inboundLifts.map((lift) => {
    const tasks = state.tasks.filter((task) => task.kind === 'inbound' && liftForTask(task)?.id === lift.id);
    const vehicles = state.vehicles
      .map((vehicle) => ({ vehicle, task: state.tasks.find((task) => task.id === vehicle.taskId) ?? null }))
      .filter((entry): entry is { vehicle: VehicleState; task: TaskStateRecord } =>
        entry.task?.kind === 'inbound' && liftForTask(entry.task)?.id === lift.id
      );
    const activeEmpty = activeInboundEmptyVehicles.filter(({ task }) => liftForTask(task)?.id === lift.id);
    const waitingVehicles = vehicles.filter(({ vehicle }) => vehicle.state === 'waiting-blocked');

    return [lift.id, {
      queueDepth: queueDepthByLift[lift.id] ?? 0,
      createdInbound: tasks.length,
      completedInbound: tasks.filter((task) => task.state === 'completed').length,
      queuedInbound: tasks.filter((task) => task.state === 'queued').length,
      assignedInbound: tasks.filter((task) => task.state === 'assigned').length,
      inProgressInbound: tasks.filter((task) => task.state === 'in-progress').length,
      activeInboundEmpty: activeEmpty.length,
      loadedInboundVehicles: vehicles.filter(({ vehicle }) => vehicle.loaded).length,
      waitingInboundVehicles: waitingVehicles.length,
      lowerStartInboundApproaches: activeEmpty.filter(({ vehicle }) => routeStartsOnLowerSide(vehicleRouteTail(vehicle))).length,
      vehicleWaitReasons: countBy(waitingVehicles, ({ vehicle }) => vehicle.waitReason ?? 'unknown'),
      taskWaitReasons: countBy(tasks.filter((task) => task.waitReason), (task) => task.waitReason ?? 'unknown')
    }];
  }));
}

function auditState(state: ShuttleSimState): void {
  for (const { vehicle, task } of inboundEmptyVehicles(state)) {
    const lift = liftForTask(task);
    const route = vehicleRouteTail(vehicle);
    if (vehicle.state === 'waiting-blocked' && !vehicleTouchesAnyLiftQueue(vehicle) && routeDistanceToAnyLiftQueue(vehicle) >= 3) {
      addIncident(state.simTimeSec, vehicle, task, lift?.id ?? null, 'far-inbound-wait', `${vehicle.currentNodeId} -> ${vehicle.targetNodeId ?? '?'} wait=${vehicle.waitReason ?? '?'} planned=${vehicle.plannedGoalNodeId ?? '?'}`, route);
    }
    if (routeHasLowerLevelApproach(route)) {
      const classification = routeStartsOnLowerSide(route) ? 'lower-start' : routeHasTopLevelDetour(route) ? 'top-to-lower-detour' : 'mixed-storage';
      const endCode = routeEndsAtInboundPickup(route, task)
        ? 'pickup'
        : routeEndsAtInboundQueue(route, task)
          ? 'queue'
          : 'other';
      addIncident(state.simTimeSec, vehicle, task, lift?.id ?? null, `lower-level-inbound-${endCode}-approach`, `${classification}: ${vehicle.currentNodeId} -> ${vehicle.plannedGoalNodeId ?? task.pickupNodeId}`, route);
    }
    if (routeHasTopLevelDetour(route)) {
      addIncident(state.simTimeSec, vehicle, task, lift?.id ?? null, 'top-level-inbound-detour', `${vehicle.currentNodeId} -> ${vehicle.plannedGoalNodeId ?? task.pickupNodeId}`, route);
    }
    if (hasImmediateTurnback(route)) {
      addIncident(state.simTimeSec, vehicle, task, lift?.id ?? null, 'route-immediate-turnback', `${vehicle.currentNodeId} planned=${vehicle.plannedGoalNodeId ?? '?'}`, route);
    }
  }
}

function inboundEmptyVehicles(state: ShuttleSimState): Array<{ vehicle: VehicleState; task: TaskStateRecord }> {
  return state.vehicles
    .map((vehicle) => ({ vehicle, task: state.tasks.find((task) => task.id === vehicle.taskId) ?? null }))
    .filter((entry): entry is { vehicle: VehicleState; task: TaskStateRecord } =>
      entry.task?.kind === 'inbound' &&
      (entry.task.state === 'assigned' || entry.task.state === 'in-progress') &&
      !entry.vehicle.loaded
    );
}

function inboundTasklessQueueStandbyVehicles(state: ShuttleSimState): VehicleState[] {
  return state.vehicles.filter((vehicle) =>
    !vehicle.loaded &&
    vehicle.taskId === null &&
    vehicle.localRouteReason === 'inbound-queue-standby'
  );
}

function vehicleTouchesAnyLiftQueue(vehicle: VehicleState): boolean {
  return inboundLifts.some((lift) => vehicleTouchesLiftQueue(vehicle, lift));
}

function vehicleTouchesLiftQueue(vehicle: VehicleState, lift: LiftInfo): boolean {
  return vehicleNodeIds(vehicle).some((nodeId) => lift.queueNodeIds.has(nodeId));
}

function vehicleNodeIds(vehicle: VehicleState): string[] {
  return [
    vehicle.currentNodeId,
    vehicle.targetNodeId,
    vehicle.plannedGoalNodeId,
    ...vehicleRouteTail(vehicle),
    ...vehicle.plannedRouteNodeIds,
    ...vehicle.localRouteNodeIds
  ].filter((nodeId): nodeId is string => Boolean(nodeId));
}

function vehicleRouteTail(vehicle: VehicleState): string[] {
  const route = vehicle.routeNodeIds.length > 0 ? vehicle.routeNodeIds : vehicle.plannedRouteNodeIds;
  return route.slice(Math.max(0, vehicle.routeIndex));
}

function routeDistanceToAnyLiftQueue(vehicle: VehicleState): number {
  const route = vehicleRouteTail(vehicle);
  const firstQueueIndex = route.findIndex((nodeId) => inboundLifts.some((lift) => lift.queueNodeIds.has(nodeId)));
  return firstQueueIndex >= 0 ? firstQueueIndex : Number.POSITIVE_INFINITY;
}

function routeHasLowerLevelApproach(route: string[]): boolean {
  const firstTopQueueIndex = route.findIndex((nodeId) =>
    /^column-top-[ab]-c\d+$/.test(nodeId) ||
    /^lift-\d{2}-inbound-queue-\d{2}-(?:access|entry-access|service-exit)$/.test(nodeId)
  );
  if (firstTopQueueIndex < 0) {
    return false;
  }
  return route.slice(0, firstTopQueueIndex).some((nodeId) =>
    /(?:bottom-[ab]|-middle)$/.test(nodeId) ||
    /^column-middle-c\d+$/.test(nodeId)
  );
}

function routeHasTopLevelDetour(route: string[]): boolean {
  if (route.length < 4 || !isTopLevelNode(route[0]!)) {
    return false;
  }
  const firstLowerIndex = route.findIndex((nodeId, index) => index > 0 && isLowerLevelNode(nodeId));
  if (firstLowerIndex < 0) {
    return false;
  }
  return route.slice(firstLowerIndex + 1).some((nodeId) => isTopLevelNode(nodeId));
}

function routeStartsOnLowerSide(route: string[]): boolean {
  const firstAisleNodeId = route.find((nodeId) => isTopLevelNode(nodeId) || isLowerLevelNode(nodeId));
  return firstAisleNodeId ? isLowerLevelNode(firstAisleNodeId) : false;
}

function routeEndsAtInboundPickup(route: string[], task: TaskStateRecord): boolean {
  return route.at(-1) === task.pickupNodeId;
}

function routeEndsAtInboundQueue(route: string[], task: TaskStateRecord): boolean {
  const endNodeId = route.at(-1);
  if (!endNodeId || endNodeId === task.pickupNodeId) {
    return false;
  }
  const lift = liftForTask(task);
  return Boolean(lift?.queueNodeIds.has(endNodeId));
}

function isTopLevelNode(nodeId: string): boolean {
  return /(?:top-[ab])/.test(nodeId);
}

function isLowerLevelNode(nodeId: string): boolean {
  return /(?:bottom-[ab]|-middle)$/.test(nodeId) ||
    /^column-middle-c\d+$/.test(nodeId);
}

function hasImmediateTurnback(route: string[]): boolean {
  for (let index = 0; index + 2 < route.length; index += 1) {
    if (route[index] === route[index + 2]) {
      return true;
    }
  }
  return false;
}

function liftForTask(task: TaskStateRecord): LiftInfo | null {
  const pickupNode = nodeById.get(task.pickupNodeId);
  if (!pickupNode) {
    return null;
  }
  return inboundLifts
    .map((lift) => ({
      lift,
      pickupDistance: lift.pickupNodeId ? Math.abs((nodeById.get(lift.pickupNodeId)?.x ?? 0) - pickupNode.x) : Number.POSITIVE_INFINITY
    }))
    .sort((left, right) => left.pickupDistance - right.pickupDistance || left.lift.id.localeCompare(right.lift.id))[0]?.lift ?? null;
}

function addIncident(timeSec: number, vehicle: VehicleState, task: TaskStateRecord, liftId: string | null, code: string, detail: string, route: string[]): void {
  const key = `${code}:${vehicle.id}:${task.id}:${Math.floor(timeSec / 10)}`;
  if (incidentKeys.has(key)) {
    return;
  }
  incidentKeys.add(key);
  incidents.push({
    timeSec: round(timeSec),
    vehicleId: vehicle.id,
    taskId: task.id,
    liftId,
    code,
    detail,
    route
  });
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
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

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function pct<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.length === 0
    ? 0
    : round((items.filter(predicate).length / items.length) * 100, 3);
}
