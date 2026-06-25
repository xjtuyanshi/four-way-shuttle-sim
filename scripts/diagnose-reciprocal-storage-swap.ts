import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type EventLogEntry = ReturnType<ShuttleSimCore['getEventLog']>[number];

type InternalVehicle = VehicleState & {
  localRouteReason: string | null;
  routeNodeIds: string[];
};

type InternalSim = ShuttleSimCore & {
  vehicles: InternalVehicle[];
  conflictSessions: Array<{
    id: string;
    state: string;
    resourceKey: string;
    participantVehicleIds: string[];
    winnerVehicleId: string;
    yielderVehicleId: string;
    createdAtSec: number;
    updatedAtSec: number;
    timeoutAtSec: number;
    trigger: string;
    closeReason: string | null;
  }>;
  agentRefreshLoadedStorageSwapCandidateVehicleIds(): string[];
  agentRefreshLoadedStorageSwapPairVehicleIds(candidateVehicleIds: string[]): string[];
  agentRefreshLoadedStorageSwapClearancePlan(
    vehicle: InternalVehicle,
    blocker: InternalVehicle
  ): { routeNodeIds: string[]; score: number } | null;
  tryBreakAgentRefreshLoadedStorageSwap(candidateVehicleIds: string[]): boolean;
};

type RunMode = 'current' | 'forced-loaded-storage-swap-first';

type CompactVehicle = {
  id: string;
  state: string;
  loaded: boolean;
  taskId: string | null;
  currentNodeId: string;
  targetNodeId: string | null;
  waitReason: string | null;
  blockingVehicleId: string | null;
  routeNodeIds: string[];
  localRouteReason: string | null;
  currentEdgeId: string | null;
  legRemainingM: number;
};

type ReplanEvent = {
  timeSec: number;
  vehicleId: string | null;
  reason: string;
  fromNodeId: string | null;
  toNodeId: string | null;
  route: string | null;
};

type Checkpoint = {
  timeSec: number;
  vehicles: CompactVehicle[];
  waitingVehicles: ShuttleSimState['traffic']['waitingVehicles'];
  physicalViolationCount: number;
  minVehicleSeparationM: number;
  deadlockCount: number;
  activeConflictSessions: InternalSim['conflictSessions'];
};

const durationSec = numberArg('--duration-sec', 15);
const stepSec = numberArg('--dt-sec', 0.2);
const outputPath = resolve(stringArg('--out') ?? 'output/review/reciprocal-storage-swap-first-divergence-v7.json');

const modes: RunMode[] = ['current', 'forced-loaded-storage-swap-first'];
const runs = modes.map(runScenario);
const result = {
  schemaVersion: 'reciprocal-storage-swap-diagnosis.v1',
  createdAt: new Date().toISOString(),
  durationSec,
  stepSec,
  scenarioHash: runs[0]?.scenarioHash ?? null,
  purpose: 'P0-A first-divergence evidence for the V7 reciprocal storage swap regression.',
  interpretationGuide: {
    staleExpectation:
      'Follower/queue movement is acceptable only if it is resource-disjoint from the swap, FIFO/physical ownership is preserved, the swap clears before the conflict-session deadline, and no wait-for SCC expands.',
    unsafeRegression:
      'Treat as unsafe when sessions remain unresolved, hard ownership conflicts appear, physical violations occur, or the follower consumes resources needed to clear the swap.'
  },
  runs
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  type: 'reciprocal-storage-swap-diagnosis-complete',
  outputPath,
  modes: runs.map((run) => ({
    mode: run.mode,
    firstReplanReason: run.replanEvents[0]?.reason ?? null,
    unresolvedConflictSessions: run.activeConflictSessions.length,
    finalWaitingVehicles: run.finalWaitingVehicles.length,
    physicalViolationCount: run.finalPhysicalViolationCount,
    hardFail: run.contractAssessment.hardFail,
    hardFailReasons: run.contractAssessment.hardFailReasons
  }))
}, null, 2));

function runScenario(mode: RunMode) {
  const sim = setupScenario();
  const scenarioHash = hashScenario(sim.scenario);
  const initialVehicles = compactVehicles(sim);
  const pairIds = sim.agentRefreshLoadedStorageSwapPairVehicleIds(
    sim.agentRefreshLoadedStorageSwapCandidateVehicleIds()
  );
  const initialSwapPlans = initialLoadedStorageSwapPlans(sim, pairIds);
  const forcedLoadedStorageSwap = mode === 'forced-loaded-storage-swap-first'
    ? sim.tryBreakAgentRefreshLoadedStorageSwap(pairIds)
    : false;

  sim.start();
  const checkpoints: Checkpoint[] = [];
  const checkpointTimes = new Set([0.2, 2, 4, 8, 12, durationSec].map(roundTime));
  while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
    sim.step(Math.min(stepSec, durationSec - sim.getClock().simTimeSec));
    const timeSec = roundTime(sim.getClock().simTimeSec);
    if (checkpointTimes.has(timeSec)) {
      checkpoints.push(checkpoint(sim));
    }
  }

  const finalState = sim.getState();
  const eventLog = sim.getEventLog();
  const replanEvents = routeReplans(eventLog);
  const firstFollowerReplan = replanEvents.find((event) => event.vehicleId === 'SH-03') ?? null;
  const firstSwapVehicleReplan = replanEvents.find((event) => event.vehicleId === 'SH-01' || event.vehicleId === 'SH-02') ?? null;
  const swapResolutionResources = resourceKeysForRoutes(initialSwapPlans.map((plan) => plan.routeNodeIds));
  const followerResources = resourceKeysForRouteString(firstFollowerReplan?.route ?? null);
  const followerSwapResourceIntersection = [...followerResources].filter((resourceKey) => swapResolutionResources.has(resourceKey)).sort();
  const activeConflictSessions = structuredClone(sim.conflictSessions.filter((session) => session.state !== 'cleared'));
  const repeatedSessionResourceKeys = repeatedResourceKeys(sim.conflictSessions.map((session) => session.resourceKey));
  const hardFailReasons = [
    finalState.traffic.physicalViolationCount > 0 ? 'physical-violation' : null,
    activeConflictSessions.length > 0 ? 'unresolved-conflict-session' : null,
    finalState.traffic.shadowLedger.invariantCounts.duplicateResourceOwner > 0 ? 'hard-duplicate-owner' : null,
    repeatedSessionResourceKeys.length > 0 ? 'repeated-conflict-session-resource' : null
  ].filter((reason): reason is string => Boolean(reason));

  return {
    mode,
    scenarioHash,
    forcedLoadedStorageSwap,
    initialVehicles,
    pairIds,
    initialSwapPlans,
    firstFollowerReplan,
    firstSwapVehicleReplan,
    followerSwapResourceIntersection,
    replanEvents,
    conflictSessionEvents: conflictSessionEvents(eventLog),
    checkpoints,
    finalVehicles: compactVehicles(sim),
    finalWaitingVehicles: finalState.traffic.waitingVehicles,
    activeConflictSessions,
    repeatedSessionResourceKeys,
    finalPhysicalViolationCount: finalState.traffic.physicalViolationCount,
    finalMinVehicleSeparationM: finalState.traffic.minVehicleSeparationM,
    finalDeadlockCount: finalState.kpis.deadlockCount,
    contractAssessment: {
      followerMoveWasResourceDisjoint: followerSwapResourceIntersection.length === 0,
      hardFail: hardFailReasons.length > 0,
      hardFailReasons
    }
  };
}

function setupScenario(): InternalSim {
  const scenario = createInboundOutboundDemoScenario({
    vehicles: { count: 3 },
    taskGeneration: {
      inboundRatePerHour: 0,
      outboundRatePerHour: 0,
      inboundOutboundMix: 0.5,
      arrivalDistribution: 'deterministic',
      maxTasks: 4,
      initialOutboundFullColumns: 0
    },
    trafficPolicy: {
      controllerMode: 'agent-refresh',
      sourceBufferCapacity: 4,
      dynamicAvoidanceClearanceM: 0.5,
      deadlockDetectSec: 120
    }
  });
  const sim = new ShuttleSimCore(scenario) as InternalSim;

  sim.addLoadForTest({ id: 'swap-priority-load', state: 'carried', nodeId: null, vehicleId: 'SH-01', weightKg: 100 });
  sim.addTaskForTest({
    id: 'swap-priority-outbound',
    kind: 'outbound',
    state: 'in-progress',
    createdAtSec: 0,
    assignedAtSec: 0,
    startedAtSec: 0,
    completedAtSec: null,
    pickupNodeId: 'storage-r02-c02',
    dropoffNodeId: 'column-top-a-c08',
    loadId: 'swap-priority-load',
    vehicleId: 'SH-01',
    replanCount: 0,
    waitReason: null
  });
  sim.setVehicleRouteForTest('SH-01', ['storage-r02-c02', 'storage-r03-c02']);
  sim.setVehicleTaskForTest('SH-01', 'swap-priority-outbound', true);
  sim.setVehicleRouteForTest('SH-02', ['storage-r03-c02', 'storage-r02-c02']);
  sim.setVehicleRouteForTest('SH-03', ['storage-r04-c02', 'storage-r03-c02']);

  for (const vehicle of sim.vehicles) {
    if (vehicle.id === 'SH-01') {
      Object.assign(vehicle, {
        state: 'waiting-blocked',
        targetNodeId: 'storage-r03-c02',
        waitReason: 'node-occupied',
        blockingVehicleId: 'SH-02',
        waitingSinceSec: 0
      });
    }
    if (vehicle.id === 'SH-02') {
      Object.assign(vehicle, {
        state: 'waiting-blocked',
        targetNodeId: 'storage-r02-c02',
        waitReason: 'node-occupied',
        blockingVehicleId: 'SH-01',
        waitingSinceSec: 0
      });
    }
    if (vehicle.id === 'SH-03') {
      Object.assign(vehicle, {
        state: 'waiting-blocked',
        targetNodeId: 'storage-r03-c02',
        waitReason: 'node-occupied',
        blockingVehicleId: 'SH-02',
        waitingSinceSec: 0
      });
    }
  }
  return sim;
}

function initialLoadedStorageSwapPlans(sim: InternalSim, pairIds: string[]) {
  const vehiclesById = new Map(sim.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const plans: Array<{ vehicleId: string; blockerVehicleId: string; routeNodeIds: string[]; score: number }> = [];
  for (const vehicleId of pairIds) {
    const vehicle = vehiclesById.get(vehicleId);
    const blocker = vehicle?.blockingVehicleId ? vehiclesById.get(vehicle.blockingVehicleId) : null;
    if (!vehicle || !blocker) {
      continue;
    }
    const plan = sim.agentRefreshLoadedStorageSwapClearancePlan(vehicle, blocker);
    if (plan) {
      plans.push({
        vehicleId,
        blockerVehicleId: blocker.id,
        routeNodeIds: [...plan.routeNodeIds],
        score: plan.score
      });
    }
  }
  return plans;
}

function checkpoint(sim: InternalSim): Checkpoint {
  const state = sim.getState();
  return {
    timeSec: state.simTimeSec,
    vehicles: compactVehicles(sim),
    waitingVehicles: state.traffic.waitingVehicles,
    physicalViolationCount: state.traffic.physicalViolationCount,
    minVehicleSeparationM: state.traffic.minVehicleSeparationM,
    deadlockCount: state.kpis.deadlockCount,
    activeConflictSessions: structuredClone(sim.conflictSessions.filter((session) => session.state !== 'cleared'))
  };
}

function compactVehicles(sim: InternalSim): CompactVehicle[] {
  return sim.vehicles.map((vehicle) => ({
    id: vehicle.id,
    state: vehicle.state,
    loaded: vehicle.loaded,
    taskId: vehicle.taskId,
    currentNodeId: vehicle.currentNodeId,
    targetNodeId: vehicle.targetNodeId,
    waitReason: vehicle.waitReason,
    blockingVehicleId: vehicle.blockingVehicleId,
    routeNodeIds: [...vehicle.routeNodeIds],
    localRouteReason: vehicle.localRouteReason,
    currentEdgeId: vehicle.currentEdgeId,
    legRemainingM: vehicle.legRemainingM
  }));
}

function routeReplans(eventLog: EventLogEntry[]): ReplanEvent[] {
  return eventLog
    .filter((event) => event.eventType === 'route-replanned')
    .map((event) => ({
      timeSec: event.timeSec,
      vehicleId: event.vehicleId,
      reason: event.reason,
      fromNodeId: event.fromNodeId,
      toNodeId: event.toNodeId,
      route: typeof event.details.route === 'string' ? event.details.route : null
    }));
}

function conflictSessionEvents(eventLog: EventLogEntry[]) {
  return eventLog
    .filter((event) => event.eventType === 'conflict-session-opened' || event.eventType === 'conflict-session-closed')
    .map((event) => ({
      timeSec: event.timeSec,
      eventType: event.eventType,
      vehicleId: event.vehicleId,
      reason: event.reason,
      fromNodeId: event.fromNodeId,
      toNodeId: event.toNodeId,
      sessionId: typeof event.details.sessionId === 'string' ? event.details.sessionId : null
    }));
}

function resourceKeysForRoutes(routes: string[][]): Set<string> {
  const resources = new Set<string>();
  for (const route of routes) {
    for (const resource of resourceKeysForRoute(route)) {
      resources.add(resource);
    }
  }
  return resources;
}

function resourceKeysForRouteString(route: string | null): Set<string> {
  return route ? resourceKeysForRoute(route.split('>')) : new Set<string>();
}

function resourceKeysForRoute(route: string[]): Set<string> {
  const resources = new Set<string>();
  for (const nodeId of route) {
    resources.add(`node:${nodeId}`);
  }
  for (let index = 0; index < route.length - 1; index += 1) {
    const left = route[index]!;
    const right = route[index + 1]!;
    resources.add(`edge:${[left, right].sort().join('<->')}`);
  }
  return resources;
}

function repeatedResourceKeys(resourceKeys: string[]): string[] {
  const counts = new Map<string, number>();
  for (const resourceKey of resourceKeys) {
    counts.set(resourceKey, (counts.get(resourceKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([resourceKey]) => resourceKey)
    .sort();
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function numberArg(name: string, fallback: number): number {
  const value = stringArg(name);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }
  return parsed;
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}
