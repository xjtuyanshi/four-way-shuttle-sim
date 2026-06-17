import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type TaskLike = ShuttleSimState['tasks'][number];
type InternalSim = ShuttleSimCore & {
  queuedTasks(): TaskLike[];
  queuedTasksForAssignment(): Array<{ task: TaskLike; priority: number }>;
  canAcceptQueuedTask(vehicle: VehicleState): boolean;
  queuedTaskAssignmentPriority(task: TaskLike): number;
  taskAssignmentBlockReason(task: TaskLike): string | null;
  inboundTaskShouldWaitBeforePickup(task: TaskLike): boolean;
  taskLiftPortNodeId(task: TaskLike): string | null;
  taskAssignmentRoute(vehicle: VehicleState, task: TaskLike): string[];
  taskDispatchGoalNodeId(task: TaskLike, vehicle?: VehicleState | null): string;
  topLiftInboundQueueNodeIdForTask(task: TaskLike, vehicle?: VehicleState | null): string | null;
  topLiftInboundQueueSlotAvailableForTask(task: TaskLike): boolean;
  topLiftInboundQueueReplenishAssignmentBoost(task: TaskLike): boolean;
  topLiftInboundApproachQueueNodeIds(liftNodeId: string): string[];
  topLiftInboundActiveEmptyQueueDepth(liftNodeId: string): number;
  topLiftInboundOpenApproachQueueSlotCount(liftNodeId: string): number;
  topLiftInboundLiftContextForVehicle(vehicle: VehicleState): string | null;
  topLiftInboundCrossLiftAssignmentBlocked(vehicle: VehicleState, task: TaskLike): boolean;
  topLiftTasklessVehicleShouldReserveForInboundQueue(vehicle: VehicleState): boolean;
  topLiftInboundQueueStandbyTargetNodeId(vehicle: VehicleState): string | null;
  routeToInboundQueueStandby(vehicle: VehicleState): string[] | null;
  assignmentHoldActive(vehicle: VehicleState): boolean;
  inboundTaskHasEarlierPickupTask(task: TaskLike): boolean;
  inboundTaskPickupReleased(task: TaskLike): boolean;
  topLiftInboundColumnPredecessorPending(task: TaskLike): boolean;
  topLiftInboundColumnPredecessorTasks(task: TaskLike): TaskLike[];
  inboundTaskLoadReadyAtPickup(task: TaskLike): boolean;
  topLiftInboundQueueHoldReason(task: TaskLike): string;
  bestAvailableVehicleForTask(task: TaskLike, vehicleIds: Set<string>): { vehicle: VehicleState; route: string[]; pickupDistanceM: number; totalDistanceM: number } | null;
};

type AssignmentCandidate = {
  vehicleId: string;
  currentNodeId: string;
  localLiftContext: string | null;
  excludedBy: string | null;
  queueNodeId: string | null;
  routeEnd: string | null;
  routeLength: number;
  startsLowerSide: boolean;
  usesLowerLevelApproach: boolean;
  topToLowerDetour: boolean;
  selected: boolean;
};

type AssignmentOpportunity = {
  timeSec: number;
  taskId: string;
  liftNodeId: string | null;
  priority: number;
  queueDepth: number | null;
  queueNodeId: string | null;
  selectedVehicleId: string;
  selectedCurrentNodeId: string;
  selectedUsesLowerLevelApproach: boolean;
  selectedStartsLowerSide: boolean;
  anyLegalTopLevelCandidate: boolean;
  selectedLowerDespiteTopCandidate: boolean;
  legalCandidateCount: number;
  legalTopLevelCandidateCount: number;
  candidates: AssignmentCandidate[];
};

const durationSec = numberArg('--duration-sec', 830);
const sampleSec = numberArg('--sample-sec', 5);
const dtSec = numberArg('--dt-sec', 0.2);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const outputPath = resolve(stringArg('--out') ?? `output/review/fleet-availability-${Date.now()}.json`);

mkdirSync(dirname(outputPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  timeStepSec: dtSec,
  vehicles: { count: shuttleCount },
  taskGeneration: {
    inboundRatePerHour: 3600,
    outboundRatePerHour: 3600,
    inboundOutboundMix: 0.5,
    initialOutboundFullColumns: 4,
    initialStorageFillPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const sim = new ShuttleSimCore(scenario);
const internals = sim as InternalSim;
const inboundLiftIds = scenario.layout.nodes
  .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
  .map((node) => node.id)
  .sort();

type Snapshot = {
  timeSec: number;
  minInboundQueueDepth: number;
  queueDepthByLift: Record<string, number>;
  queuedInbound: number;
  queuedInboundVehicleUnavailable: number;
  queuedInboundBlocked: Record<string, number>;
  assignedInboundQueueWaits: Array<{
    timeSec: number;
    vehicleId: string;
    taskId: string;
    liftNodeId: string | null;
    currentNodeId: string;
    plannedGoalNodeId: string | null;
    waitReason: string | null;
    computedHoldReason: string;
    hasEarlierPickupTask: boolean;
    hasColumnPredecessor: boolean;
    loadReadyAtPickup: boolean;
    columnPredecessors: Array<{
      taskId: string;
      state: string;
      vehicleId: string | null;
      dropoffNodeId: string;
      pickupReleased: boolean;
      vehicleCurrentNodeId: string | null;
      vehicleTargetNodeId: string | null;
      vehiclePlannedGoalNodeId: string | null;
      vehicleLoaded: boolean | null;
      vehicleWaitReason: string | null;
    }>;
  }>;
  activeInboundTasks: Array<{
    taskId: string;
    state: string;
    liftNodeId: string | null;
    vehicleId: string | null;
    pickupNodeId: string;
    dropoffNodeId: string;
    loadId: string;
    waitReason: string | null;
    pickupReleased: boolean;
    loadReadyAtPickup: boolean;
    hasEarlierPickupTask: boolean;
    hasColumnPredecessor: boolean;
    vehicleCurrentNodeId: string | null;
    vehicleTargetNodeId: string | null;
    vehiclePlannedGoalNodeId: string | null;
    vehicleLoaded: boolean | null;
    vehicleWaitReason: string | null;
    loadNodeId: string | null;
    loadState: string | null;
  }>;
  perLiftDiagnostics: Record<string, {
    queueDepth: number;
    openSlots: number;
    queueNodes: Array<{ nodeId: string; occupiedBy: string | null; claimedBy: string[] }>;
    queuedInbound: number;
    assignedInbound: number;
    inProgressInbound: number;
    queuedTasks: Array<{
      taskId: string;
      waitReason: string | null;
      priority: number;
      queueNodeId: string | null;
      queueSlotAvailable: boolean;
      replenishBoost: boolean;
      blockReason: string | null;
      bestVehicleId: string | null;
      bestRouteEnd: string | null;
      bestUsesLowerLevelApproach: boolean;
      anyLegalTopLevelCandidate: boolean;
      selectedLowerDespiteTopCandidate: boolean;
      hasEarlierPickupTask: boolean;
      hasColumnPredecessor: boolean;
      loadReadyAtPickup: boolean;
      queueNodeByAvailableVehicle: Record<string, string | null>;
      crossLiftBlockedAvailableVehicles: string[];
      assignmentCandidates: AssignmentCandidate[];
    }>;
  }>;
  availableVehicles: string[];
  vehicleCategories: Record<string, number>;
  vehicles: Array<{
    id: string;
    category: string;
    state: string;
    loaded: boolean;
    taskId: string | null;
    taskKind: string | null;
    currentNodeId: string;
    targetNodeId: string | null;
    plannedGoalNodeId: string | null;
    waitReason: string | null;
    localLiftContext: string | null;
  }>;
};

const snapshots: Snapshot[] = [];
const assignmentOpportunities: AssignmentOpportunity[] = [];
const assignmentOpportunityKeys = new Set<string>();
let nextSampleSec = 0;

sim.start();
for (let elapsedSec = 0; elapsedSec < durationSec - 1e-9 && sim.getClock().status === 'running'; elapsedSec += dtSec) {
  captureAssignmentOpportunities(sim.getState());
  const state = sim.step(Math.min(dtSec, durationSec - elapsedSec));
  if (state.simTimeSec + 1e-9 < nextSampleSec) {
    continue;
  }
  nextSampleSec += sampleSec;
  const snapshot = createSnapshot(state);
  if (
    snapshot.minInboundQueueDepth < 2 ||
    snapshot.queuedInboundVehicleUnavailable > 0 ||
    snapshot.assignedInboundQueueWaits.length > 0
  ) {
    snapshots.push(snapshot);
  }
}

const summary = summarize(snapshots);
const report = {
  schemaVersion: 'shuttle.fleetAvailabilityDiagnostic.v2',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  durationSec,
  finalSimTimeSec: sim.getState().simTimeSec,
  status: sim.getState().status,
  config: { regionCount, shuttleCount, sampleSec, dtSec, initialStorageFillPolicy },
  summary,
  assignmentOpportunities: assignmentOpportunities.slice(0, 400),
  snapshots: snapshots.slice(0, 240)
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary }, null, 2));

function createSnapshot(state: ShuttleSimState): Snapshot {
  const queueDepthByLift = Object.fromEntries(inboundLiftIds.map((liftId) => [
    liftId,
    internals.topLiftInboundActiveEmptyQueueDepth(liftId)
  ]));
  const queuedInboundTasks = internals.queuedTasks().filter((task) => task.kind === 'inbound');
  const availableVehicles = state.vehicles
    .filter((vehicle) => internals.canAcceptQueuedTask(vehicle))
    .map((vehicle) => vehicle.id);
  const queuedInboundBlocked = countBy(queuedInboundTasks, (task) =>
    task.waitReason ?? internals.taskAssignmentBlockReason(task) ?? `priority-${internals.queuedTaskAssignmentPriority(task)}`
  );
  const vehicles = state.vehicles.map((vehicle) => {
    const task = state.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null;
    const category = vehicleCategory(vehicle, task, availableVehicles.includes(vehicle.id));
    const internalVehicle = ((internals as unknown as { vehicles: Array<VehicleState & { assignmentHoldUntilSec?: number | null }> }).vehicles)
      .find((candidate) => candidate.id === vehicle.id) ?? vehicle;
    const reserveRoute = internals.routeToInboundQueueStandby(internalVehicle);
    return {
      id: vehicle.id,
      category,
      state: vehicle.state,
      loaded: vehicle.loaded,
      taskId: vehicle.taskId,
      taskKind: task?.kind ?? null,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      waitReason: vehicle.waitReason,
      localLiftContext: internals.topLiftInboundLiftContextForVehicle(vehicle),
      assignmentHoldUntilSec: internalVehicle.assignmentHoldUntilSec ?? null,
      assignmentHoldActive: internals.assignmentHoldActive(internalVehicle),
      tasklessReserveTargetNodeId: internals.topLiftInboundQueueStandbyTargetNodeId(internalVehicle),
      tasklessReserveRouteEnd: reserveRoute?.at(-1) ?? null,
      tasklessReserveRouteLength: reserveRoute?.length ?? null,
      tasklessShouldReserveForInboundQueue: internals.topLiftTasklessVehicleShouldReserveForInboundQueue(internalVehicle)
    };
  });
  const assignedInboundQueueWaits = state.vehicles
    .map((vehicle) => {
      const task = state.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null;
      if (
        !task ||
        task.kind !== 'inbound' ||
        vehicle.loaded ||
        vehicle.state !== 'waiting-blocked' ||
        !vehicle.waitReason?.startsWith('inbound-')
      ) {
        return null;
      }
      const liftNodeId = internals.taskLiftPortNodeId(task);
      return {
        timeSec: round(state.simTimeSec),
        vehicleId: vehicle.id,
        taskId: task.id,
        liftNodeId,
        currentNodeId: vehicle.currentNodeId,
        plannedGoalNodeId: vehicle.plannedGoalNodeId,
        waitReason: vehicle.waitReason,
        computedHoldReason: internals.topLiftInboundQueueHoldReason(task),
        hasEarlierPickupTask: internals.inboundTaskHasEarlierPickupTask(task),
        hasColumnPredecessor: internals.topLiftInboundColumnPredecessorPending(task),
        loadReadyAtPickup: internals.inboundTaskLoadReadyAtPickup(task),
        columnPredecessors: columnPredecessorsForTask(state, task)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const activeInboundTasks = state.tasks
    .filter((task) => task.kind === 'inbound' && task.state !== 'completed' && task.state !== 'failed')
    .map((task) => {
      const vehicle = state.vehicles.find((candidate) => candidate.id === task.vehicleId) ?? null;
      const load = state.loads.find((candidate) => candidate.id === task.loadId) ?? null;
      return {
        taskId: task.id,
        state: task.state,
        liftNodeId: internals.taskLiftPortNodeId(task),
        vehicleId: task.vehicleId,
        pickupNodeId: task.pickupNodeId,
        dropoffNodeId: task.dropoffNodeId,
        loadId: task.loadId,
        waitReason: task.waitReason,
        pickupReleased: internals.inboundTaskPickupReleased(task),
        loadReadyAtPickup: internals.inboundTaskLoadReadyAtPickup(task),
        hasEarlierPickupTask: internals.inboundTaskHasEarlierPickupTask(task),
        hasColumnPredecessor: internals.topLiftInboundColumnPredecessorPending(task),
        vehicleCurrentNodeId: vehicle?.currentNodeId ?? null,
        vehicleTargetNodeId: vehicle?.targetNodeId ?? null,
        vehiclePlannedGoalNodeId: vehicle?.plannedGoalNodeId ?? null,
        vehicleLoaded: vehicle?.loaded ?? null,
        vehicleWaitReason: vehicle?.waitReason ?? null,
        loadNodeId: load?.nodeId ?? null,
        loadState: load?.state ?? null
      };
    });
  const availableVehicleSet = new Set(availableVehicles);
  const perLiftDiagnostics = Object.fromEntries(inboundLiftIds.map((liftId) => {
    const liftTasks = state.tasks.filter((task) => task.kind === 'inbound' && internals.taskLiftPortNodeId(task) === liftId);
    const queuedTasks = queuedInboundTasks
      .filter((task) => internals.taskLiftPortNodeId(task) === liftId)
      .map((task) => {
        const bestAssignment = internals.bestAvailableVehicleForTask(task, new Set(availableVehicleSet));
        const assignmentCandidates = assignmentCandidatesForTask(state, task, availableVehicleSet, bestAssignment?.vehicle.id ?? null);
        const legalCandidates = assignmentCandidates.filter((candidate) => !candidate.excludedBy);
        const selectedCandidate = assignmentCandidates.find((candidate) => candidate.selected) ?? null;
        const anyLegalTopLevelCandidate = legalCandidates.some((candidate) => !candidate.usesLowerLevelApproach);
        const bestUsesLowerLevelApproach = selectedCandidate?.usesLowerLevelApproach ?? false;
        return {
          taskId: task.id,
          waitReason: task.waitReason,
          priority: internals.queuedTaskAssignmentPriority(task),
          queueNodeId: internals.topLiftInboundQueueNodeIdForTask(task),
          queueSlotAvailable: internals.topLiftInboundQueueSlotAvailableForTask(task),
          replenishBoost: internals.topLiftInboundQueueReplenishAssignmentBoost(task),
          blockReason: internals.taskAssignmentBlockReason(task),
          bestVehicleId: bestAssignment?.vehicle.id ?? null,
          bestRouteEnd: bestAssignment?.route.at(-1) ?? null,
          bestUsesLowerLevelApproach,
          anyLegalTopLevelCandidate,
          selectedLowerDespiteTopCandidate: bestUsesLowerLevelApproach && anyLegalTopLevelCandidate,
          hasEarlierPickupTask: internals.inboundTaskHasEarlierPickupTask(task),
          hasColumnPredecessor: internals.topLiftInboundColumnPredecessorPending(task),
          loadReadyAtPickup: internals.inboundTaskLoadReadyAtPickup(task),
          queueNodeByAvailableVehicle: Object.fromEntries(
            state.vehicles
              .filter((vehicle) => availableVehicleSet.has(vehicle.id))
              .map((vehicle) => [vehicle.id, internals.topLiftInboundQueueNodeIdForTask(task, vehicle)])
          ),
          crossLiftBlockedAvailableVehicles: state.vehicles
            .filter((vehicle) => availableVehicleSet.has(vehicle.id) && internals.topLiftInboundCrossLiftAssignmentBlocked(vehicle, task))
            .map((vehicle) => vehicle.id),
          assignmentCandidates
        };
      });
    return [liftId, {
      queueDepth: queueDepthByLift[liftId] ?? 0,
      openSlots: internals.topLiftInboundOpenApproachQueueSlotCount(liftId),
      queueNodes: internals.topLiftInboundApproachQueueNodeIds(liftId).map((nodeId) => ({
        nodeId,
        occupiedBy: state.vehicles.find((vehicle) => vehicle.currentNodeId === nodeId)?.id ?? null,
        claimedBy: state.vehicles
          .filter((vehicle) =>
            vehicle.targetNodeId === nodeId ||
            vehicle.plannedGoalNodeId === nodeId ||
            vehicle.routeNodeIds.includes(nodeId) ||
            vehicle.plannedRouteNodeIds.includes(nodeId) ||
            vehicle.localRouteNodeIds.includes(nodeId)
          )
          .map((vehicle) => vehicle.id)
      })),
      queuedInbound: liftTasks.filter((task) => task.state === 'queued').length,
      assignedInbound: liftTasks.filter((task) => task.state === 'assigned').length,
      inProgressInbound: liftTasks.filter((task) => task.state === 'in-progress').length,
      queuedTasks
    }];
  }));

  return {
    timeSec: round(state.simTimeSec),
    minInboundQueueDepth: Math.min(...Object.values(queueDepthByLift)),
    queueDepthByLift,
    queuedInbound: queuedInboundTasks.length,
    queuedInboundVehicleUnavailable: queuedInboundTasks.filter((task) => task.waitReason === 'vehicle-unavailable').length,
    queuedInboundBlocked,
    assignedInboundQueueWaits,
    activeInboundTasks,
    perLiftDiagnostics,
    availableVehicles,
    vehicleCategories: countBy(vehicles, (vehicle) => vehicle.category),
    vehicles
  };
}

function columnPredecessorsForTask(state: ShuttleSimState, task: TaskLike): Snapshot['assignedInboundQueueWaits'][number]['columnPredecessors'] {
  return internals.topLiftInboundColumnPredecessorTasks(task).map((predecessor) => {
    const vehicle = state.vehicles.find((candidate) => candidate.id === predecessor.vehicleId) ?? null;
    return {
      taskId: predecessor.id,
      state: predecessor.state,
      vehicleId: predecessor.vehicleId,
      dropoffNodeId: predecessor.dropoffNodeId,
      pickupReleased: internals.inboundTaskPickupReleased(predecessor),
      vehicleCurrentNodeId: vehicle?.currentNodeId ?? null,
      vehicleTargetNodeId: vehicle?.targetNodeId ?? null,
      vehiclePlannedGoalNodeId: vehicle?.plannedGoalNodeId ?? null,
      vehicleLoaded: vehicle?.loaded ?? null,
      vehicleWaitReason: vehicle?.waitReason ?? null
    };
  });
}

function captureAssignmentOpportunities(state: ShuttleSimState): void {
  if (assignmentOpportunities.length >= 4000) {
    return;
  }
  const availableVehicleSet = new Set(
    state.vehicles
      .filter((vehicle) => internals.canAcceptQueuedTask(vehicle))
      .map((vehicle) => vehicle.id)
  );
  if (availableVehicleSet.size === 0) {
    return;
  }

  for (const { task, priority } of internals.queuedTasksForAssignment()) {
    if (availableVehicleSet.size === 0) {
      return;
    }
    if (priority > 0) {
      continue;
    }
    if (internals.taskAssignmentBlockReason(task)) {
      continue;
    }
    const assignment = internals.bestAvailableVehicleForTask(task, availableVehicleSet);
    if (!assignment) {
      continue;
    }
    if (task.kind === 'inbound') {
      const candidates = assignmentCandidatesForTask(state, task, availableVehicleSet, assignment.vehicle.id);
      const legalCandidates = candidates.filter((candidate) => !candidate.excludedBy);
      const selected = candidates.find((candidate) => candidate.selected);
      const legalTopLevelCandidateCount = legalCandidates.filter((candidate) => !candidate.usesLowerLevelApproach).length;
      const liftNodeId = internals.taskLiftPortNodeId(task);
      const queueNodeId = internals.topLiftInboundQueueNodeIdForTask(task, assignment.vehicle);
      const opportunityKey = `${task.id}:${assignment.vehicle.id}:${queueNodeId ?? 'pickup'}`;
      if (assignmentOpportunityKeys.has(opportunityKey)) {
        availableVehicleSet.delete(assignment.vehicle.id);
        continue;
      }
      assignmentOpportunityKeys.add(opportunityKey);
      assignmentOpportunities.push({
        timeSec: round(state.simTimeSec),
        taskId: task.id,
        liftNodeId,
        priority,
        queueDepth: liftNodeId ? internals.topLiftInboundActiveEmptyQueueDepth(liftNodeId) : null,
        queueNodeId,
        selectedVehicleId: assignment.vehicle.id,
        selectedCurrentNodeId: assignment.vehicle.currentNodeId,
        selectedUsesLowerLevelApproach: selected?.usesLowerLevelApproach ?? false,
        selectedStartsLowerSide: selected?.startsLowerSide ?? false,
        anyLegalTopLevelCandidate: legalTopLevelCandidateCount > 0,
        selectedLowerDespiteTopCandidate: Boolean(selected?.usesLowerLevelApproach && legalTopLevelCandidateCount > 0),
        legalCandidateCount: legalCandidates.length,
        legalTopLevelCandidateCount,
        candidates: candidates.slice(0, 12)
      });
    }
    availableVehicleSet.delete(assignment.vehicle.id);
  }
}

function vehicleCategory(vehicle: VehicleState, task: TaskLike | null, available: boolean): string {
  if (available) {
    return 'taskless-available';
  }
  if (task) {
    return `${task.kind}-${vehicle.loaded ? 'loaded' : 'empty'}-${vehicle.state}`;
  }
  if (vehicle.currentEdgeId || vehicle.legRemainingM > 0) {
    return 'taskless-moving';
  }
  if (vehicle.phaseRemainingSec > 0) {
    return 'taskless-handling';
  }
  if (vehicle.waitReason) {
    return `taskless-wait-${vehicle.waitReason}`;
  }
  return `taskless-${vehicle.state}`;
}

function summarize(items: Snapshot[]) {
  const vehicleUnavailableSnapshots = items.filter((item) => item.queuedInboundVehicleUnavailable > 0);
  return {
    sampledProblemSnapshots: items.length,
    snapshotsWithQueuedInboundVehicleUnavailable: vehicleUnavailableSnapshots.length,
    averageMinInboundQueueDepth: round(average(items.map((item) => item.minInboundQueueDepth))),
    averageQueuedInbound: round(average(items.map((item) => item.queuedInbound))),
    averageAvailableVehiclesWhenInboundVehicleUnavailable: round(average(vehicleUnavailableSnapshots.map((item) => item.availableVehicles.length))),
    vehicleCategorySecondsWhenInboundVehicleUnavailable: sumCategoryCounts(vehicleUnavailableSnapshots, sampleSec),
    queuedInboundBlockedReasons: sumReasonCounts(items.map((item) => item.queuedInboundBlocked), sampleSec),
    assignedInboundQueueWaitSeconds: sumReasonCounts(
      items.map((item) => countBy(item.assignedInboundQueueWaits, (wait) =>
        [
          wait.waitReason,
          `computed=${wait.computedHoldReason}`,
          `earlier=${wait.hasEarlierPickupTask ? 'Y' : 'N'}`,
          `pred=${wait.hasColumnPredecessor ? 'Y' : 'N'}`,
          `ready=${wait.loadReadyAtPickup ? 'Y' : 'N'}`
        ].join('|')
      )),
      sampleSec
    ),
    assignmentCandidateDiagnostics: summarizeAssignmentCandidates(items),
    assignmentOpportunityDiagnostics: summarizeAssignmentOpportunities(),
    firstVehicleUnavailableSnapshots: vehicleUnavailableSnapshots.slice(0, 8).map((item) => ({
      timeSec: item.timeSec,
      minInboundQueueDepth: item.minInboundQueueDepth,
      queuedInbound: item.queuedInbound,
      queueDepthByLift: item.queueDepthByLift,
      availableVehicles: item.availableVehicles,
      vehicleCategories: item.vehicleCategories,
      assignedInboundQueueWaits: item.assignedInboundQueueWaits,
      vehicles: item.vehicles
    }))
  };
}

function summarizeAssignmentOpportunities() {
  const lowerSelected = assignmentOpportunities.filter((row) => row.selectedUsesLowerLevelApproach);
  const lowerDespiteTop = assignmentOpportunities.filter((row) => row.selectedLowerDespiteTopCandidate);
  const lowQueueAssignments = assignmentOpportunities.filter((row) => (row.queueDepth ?? 0) < 2);
  const lowerLowQueueAssignments = lowQueueAssignments.filter((row) => row.selectedUsesLowerLevelApproach);
  return {
    inboundAssignmentOpportunities: assignmentOpportunities.length,
    selectedLowerLevelApproach: lowerSelected.length,
    selectedTopLevelApproach: assignmentOpportunities.length - lowerSelected.length,
    selectedLowerDespiteTopCandidate: lowerDespiteTop.length,
    selectedLowerWithoutTopCandidate: lowerSelected.length - lowerDespiteTop.length,
    lowQueueInboundAssignments: lowQueueAssignments.length,
    lowQueueSelectedLowerLevelApproach: lowerLowQueueAssignments.length,
    byLift: Object.fromEntries(inboundLiftIds.map((liftId) => {
      const rows = assignmentOpportunities.filter((row) => row.liftNodeId === liftId);
      const lowerRows = rows.filter((row) => row.selectedUsesLowerLevelApproach);
      return [liftId, {
        assignments: rows.length,
        lowerSelected: lowerRows.length,
        lowerDespiteTop: rows.filter((row) => row.selectedLowerDespiteTopCandidate).length,
        lowQueueAssignments: rows.filter((row) => (row.queueDepth ?? 0) < 2).length
      }];
    })),
    firstSelectedLowerDespiteTopCandidate: lowerDespiteTop.slice(0, 8),
    firstSelectedLowerWithoutTopCandidate: lowerSelected
      .filter((row) => !row.selectedLowerDespiteTopCandidate)
      .slice(0, 8),
    firstLowQueueSelectedLowerLevelApproach: lowerLowQueueAssignments.slice(0, 8)
  };
}

function assignmentCandidatesForTask(
  state: ShuttleSimState,
  task: TaskLike,
  availableVehicleSet: Set<string>,
  selectedVehicleId: string | null
): AssignmentCandidate[] {
  return state.vehicles
    .filter((vehicle) => availableVehicleSet.has(vehicle.id))
    .map((vehicle) => {
      const queueNodeId = internals.topLiftInboundQueueNodeIdForTask(task, vehicle);
      if (internals.topLiftInboundCrossLiftAssignmentBlocked(vehicle, task)) {
        return candidateRow(vehicle, selectedVehicleId, 'cross-lift-blocked', queueNodeId, null, task);
      }
      if (internals.inboundTaskShouldWaitBeforePickup(task) && !queueNodeId) {
        return candidateRow(vehicle, selectedVehicleId, 'no-queue-node', queueNodeId, null, task);
      }
      try {
        const route = internals.taskAssignmentRoute(vehicle, task);
        return candidateRow(vehicle, selectedVehicleId, null, queueNodeId, route, task);
      } catch {
        return candidateRow(vehicle, selectedVehicleId, 'route-unavailable', queueNodeId, null, task);
      }
    });
}

function candidateRow(
  vehicle: VehicleState,
  selectedVehicleId: string | null,
  excludedBy: string | null,
  queueNodeId: string | null,
  route: string[] | null,
  task: TaskLike
): AssignmentCandidate {
  const dispatchGoalNodeId = route ? internals.taskDispatchGoalNodeId(task, vehicle) : null;
  const approachRoute = route && dispatchGoalNodeId
    ? routeToGoal(route, dispatchGoalNodeId)
    : [];
  return {
    vehicleId: vehicle.id,
    currentNodeId: vehicle.currentNodeId,
    localLiftContext: internals.topLiftInboundLiftContextForVehicle(vehicle),
    excludedBy,
    queueNodeId,
    routeEnd: route?.at(-1) ?? null,
    routeLength: route?.length ?? 0,
    startsLowerSide: routeStartsOnLowerSide(approachRoute),
    usesLowerLevelApproach: routeHasLowerLevelApproach(approachRoute),
    topToLowerDetour: routeHasTopLevelDetour(approachRoute),
    selected: vehicle.id === selectedVehicleId
  };
}

function summarizeAssignmentCandidates(items: Snapshot[]) {
  const taskRows = items.flatMap((item) =>
    Object.entries(item.perLiftDiagnostics).flatMap(([liftId, lift]) =>
      lift.queuedTasks
        .filter((task) => task.assignmentCandidates.length > 0)
        .map((task) => ({ timeSec: item.timeSec, liftId, task }))
    )
  );
  const selectedRows = taskRows
    .map((row) => ({
      ...row,
      selected: row.task.assignmentCandidates.find((candidate) => candidate.selected) ?? null,
      legalCandidates: row.task.assignmentCandidates.filter((candidate) => !candidate.excludedBy)
    }))
    .filter((row) => row.selected !== null);
  const lowerSelected = selectedRows.filter((row) => row.selected?.usesLowerLevelApproach);
  const lowerDespiteTop = lowerSelected.filter((row) =>
    row.legalCandidates.some((candidate) => !candidate.usesLowerLevelApproach)
  );
  const noLegalCandidate = taskRows.filter((row) =>
    row.task.assignmentCandidates.length > 0 &&
    row.task.assignmentCandidates.every((candidate) => candidate.excludedBy)
  );
  const excludedRows = taskRows.flatMap((row) =>
    row.task.assignmentCandidates.filter((candidate) => candidate.excludedBy)
  );
  return {
    queuedInboundTasksWithAvailableVehicles: taskRows.length,
    selectedCandidateRows: selectedRows.length,
    selectedLowerLevelApproach: lowerSelected.length,
    selectedTopLevelApproach: selectedRows.length - lowerSelected.length,
    selectedLowerDespiteTopCandidate: lowerDespiteTop.length,
    selectedLowerWithoutTopCandidate: lowerSelected.length - lowerDespiteTop.length,
    noLegalCandidateWithAvailableVehicles: noLegalCandidate.length,
    excludedCandidateCounts: countBy(excludedRows, (candidate) => candidate.excludedBy ?? 'unknown'),
    firstSelectedLowerDespiteTopCandidate: lowerDespiteTop.slice(0, 8).map((row) => ({
      timeSec: row.timeSec,
      liftId: row.liftId,
      taskId: row.task.taskId,
      selected: row.selected,
      legalTopCandidates: row.legalCandidates
        .filter((candidate) => !candidate.usesLowerLevelApproach)
        .slice(0, 4)
    })),
    firstSelectedLowerWithoutTopCandidate: lowerSelected
      .filter((row) => !row.legalCandidates.some((candidate) => !candidate.usesLowerLevelApproach))
      .slice(0, 8)
      .map((row) => ({
        timeSec: row.timeSec,
        liftId: row.liftId,
        taskId: row.task.taskId,
        selected: row.selected,
        legalCandidateCount: row.legalCandidates.length,
        legalCandidates: row.legalCandidates.slice(0, 4)
      }))
  };
}

function routeToGoal(route: string[], goalNodeId: string): string[] {
  const goalIndex = route.indexOf(goalNodeId);
  return goalIndex >= 0 ? route.slice(0, goalIndex + 1) : route;
}

function routeHasLowerLevelApproach(route: string[]): boolean {
  return route.some((nodeId) => isLowerLevelNode(nodeId));
}

function routeStartsOnLowerSide(route: string[]): boolean {
  const firstAisleNodeId = route.find((nodeId) => isTopLevelNode(nodeId) || isLowerLevelNode(nodeId));
  return firstAisleNodeId ? isLowerLevelNode(firstAisleNodeId) : false;
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

function isTopLevelNode(nodeId: string): boolean {
  return /(?:top-[ab])/.test(nodeId);
}

function isLowerLevelNode(nodeId: string): boolean {
  return /(?:bottom-[ab]|-middle)$/.test(nodeId) ||
    /^column-middle-c\d+$/.test(nodeId);
}

function sumCategoryCounts(items: Snapshot[], multiplier: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const [category, count] of Object.entries(item.vehicleCategories)) {
      counts[category] = round((counts[category] ?? 0) + count * multiplier);
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function sumReasonCounts(reasonCounts: Array<Record<string, number>>, multiplier: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of reasonCounts) {
    for (const [reason, count] of Object.entries(item)) {
      counts[reason] = round((counts[reason] ?? 0) + count * multiplier);
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.trunc(numberArg(name, fallback));
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function enumArg<T extends readonly string[]>(name: string, values: T, fallback: T[number]): T[number] {
  const value = stringArg(name);
  return values.includes(value ?? '') ? value as T[number] : fallback;
}
