import type { ShuttleScenario, ShuttleSimState, TaskStateRecord, VehicleState } from '@four-way-shuttle/schemas';

import { createDefaultShuttleScenario, ShuttleSimCore } from '../packages/shuttle-sim-core/src/index.ts';

type Severity = 'info' | 'warn' | 'critical';

type Anomaly = {
  timeSec: number;
  vehicleId: string | null;
  code: string;
  severity: Severity;
  detail: string;
};

type VehicleTrace = {
  lastSignature: string;
  lastChangeSec: number;
  lastMovingPosition: { x: number; z: number };
  stoppedSinceSec: number;
  localRouteSignature: string;
  localRouteSinceSec: number;
  bestGoalDistanceM: number | null;
  noGoalProgressSinceSec: number;
  lastGoalNodeId: string | null;
  recentNodes: string[];
  recentTargets: string[];
  oscillationKeys: Set<string>;
  routeIssueKeys: Set<string>;
};

const durationSec = numberArg('--duration', 300);
const dtSec = numberArg('--dt', 0.2);
const sampleSec = numberArg('--sample', 1);
const stationaryWarnSec = numberArg('--stationary-warn', 30);
const detourWarnRatio = numberArg('--detour-ratio', 2.25);
const taskStoppedWarnSec = numberArg('--task-stopped-warn', 18);
const temporaryRouteWarnSec = numberArg('--temporary-route-warn', 20);
const noProgressWarnSec = numberArg('--no-progress-warn', 35);
const replanWarnCount = numberArg('--replan-warn', 8);

const scenario = createDefaultShuttleScenario({
  id: 'audit-agent-refresh-8-inbound',
  name: 'Audit Agent Refresh 8 Shuttle Inbound',
  liftMode: 'all-inbound',
  durationSec: Math.max(durationSec, 1),
  vehicles: {
    count: 8,
    emptySpeedMps: 2,
    loadedSpeedMps: 1.5,
    accelerationMps2: 1.2,
    liftTimeSec: 0.01,
    lowerTimeSec: 0.01
  },
  physicsParams: {
    emptySpeedMps: 2,
    loadedSpeedMps: 1.5,
    accelerationMps2: 1.2,
    liftTimeSec: 0.01,
    lowerTimeSec: 0.01
  },
  taskGeneration: {
    inboundRatePerHour: 7200,
    outboundRatePerHour: 0,
    inboundOutboundMix: 1,
    arrivalDistribution: 'deterministic',
    maxTasks: 16
  },
  trafficPolicy: {
    controllerMode: 'agent-refresh',
    liftApproachCapacity: 8,
    minimumClearanceSec: 0.4,
    dynamicAvoidanceClearanceM: 0.5,
    deadlockDetectSec: 2
  }
});

const graph = buildGraph(scenario);
const nodesById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
const inboundLiftNodeIds = scenario.layout.nodes
  .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
  .map((node) => node.id)
  .sort();
const storageNodeCount = scenario.layout.nodes.filter((node) => node.type === 'storage').length;
const sim = new ShuttleSimCore(scenario);
const traces = new Map<string, VehicleTrace>();
const anomalies: Anomaly[] = [];
const reportedTaskReplanKeys = new Set<string>();
const intentionalRetreatUntilSec = new Map<string, number>();

sim.start();
let state = sim.getState();
let nextSampleSec = 0;
for (let elapsedSec = 0; elapsedSec < durationSec; elapsedSec = Number((elapsedSec + dtSec).toFixed(6))) {
  sim.advanceByInPlace(dtSec);
  const clock = sim.getClock();
  if (clock.simTimeSec + 1e-6 >= nextSampleSec) {
    state = sim.getState();
    auditState(state);
    nextSampleSec = Number((nextSampleSec + sampleSec).toFixed(6));
  }
}

const finalState = sim.getState();
const utilization = utilizationAverages(finalState);
const report = {
  scenarioId: scenario.id,
  durationSec,
  summary: {
    completedInbound: finalState.kpis.completedInbound,
    inboundPph: finalState.kpis.inboundPph,
    totalPph: finalState.kpis.totalPph,
    activeTasks: finalState.kpis.activeTasks,
    queuedTasks: finalState.kpis.queuedTasks,
    deadlocks: finalState.kpis.deadlockCount,
    livelocks: finalState.kpis.livelockCount,
    physicalViolations: finalState.traffic.physicalViolationCount,
    minSeparationM: finalState.traffic.minVehicleSeparationM,
    avgBusy: utilization.busy,
    avgProductive: utilization.productive,
    avgTrafficHold: utilization.waiting,
    trafficHoldVehicles: finalState.traffic.waitingVehicles.length
  },
  anomalyCounts: anomalies.reduce<Record<string, number>>((counts, anomaly) => {
    counts[anomaly.code] = (counts[anomaly.code] ?? 0) + 1;
    return counts;
  }, {}),
  anomalies: anomalies.slice(0, 80)
};

console.log(JSON.stringify(report, null, 2));

if (anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function auditState(current: ShuttleSimState): void {
  trackIntentionalRetreats(current);
  if (current.kpis.deadlockCount > 0) {
    addAnomaly(current.simTimeSec, null, 'deadlock-count', 'critical', `deadlockCount=${current.kpis.deadlockCount}`);
  }
  if (current.kpis.livelockCount > 0) {
    addAnomaly(current.simTimeSec, null, 'livelock-count', 'critical', `livelockCount=${current.kpis.livelockCount}`);
  }
  if (current.traffic.physicalViolationCount > 0) {
    addAnomaly(current.simTimeSec, null, 'physical-violation', 'critical', `physicalViolationCount=${current.traffic.physicalViolationCount}`);
  }
  if (current.traffic.waitingVehicles.length === current.vehicles.length && current.vehicles.length > 0) {
    addAnomaly(current.simTimeSec, null, 'all-vehicles-held', 'critical', 'every shuttle is traffic-held');
  }

  auditPhysicalCommonSense(current);
  auditTaskCommonSense(current);
  auditInboundSourceBuffers(current);
  auditLoadedRoutesThroughStoredLoads(current);
  for (const vehicle of current.vehicles) {
    auditVehicleTrace(current, vehicle);
    auditVehicleCommonSense(current, vehicle);
    auditRouteDetour(current, vehicle);
  }
}

function auditInboundSourceBuffers(current: ShuttleSimState): void {
  if (scenario.taskGeneration.inboundRatePerHour <= 0 || inboundLiftNodeIds.length === 0) {
    return;
  }

  const inboundLiftIdSet = new Set(inboundLiftNodeIds);
  const waitingLoadsByLift = new Map<string, string[]>();
  for (const load of current.loads) {
    if (load.state !== 'waiting' || !load.nodeId || !inboundLiftIdSet.has(load.nodeId)) {
      continue;
    }
    waitingLoadsByLift.set(load.nodeId, [...(waitingLoadsByLift.get(load.nodeId) ?? []), load.id]);
  }

  for (const [liftNodeId, loadIds] of waitingLoadsByLift) {
    if (loadIds.length > 1) {
      addAnomaly(current.simTimeSec, null, 'lift-source-buffer-overfilled', 'critical', `${liftNodeId}: ${loadIds.join(',')}`);
    }
  }

  const storedCount = current.loads.filter((load) => load.state === 'stored' && load.nodeId?.startsWith('storage-')).length;
  const storageFull = storageNodeCount > 0 && storedCount >= storageNodeCount;
  if (!storageFull) {
    const emptyLiftIds = inboundLiftNodeIds.filter((liftNodeId) => (waitingLoadsByLift.get(liftNodeId) ?? []).length === 0);
    if (emptyLiftIds.length > 0) {
      addAnomaly(
        current.simTimeSec,
        null,
        'inbound-source-buffer-empty',
        'critical',
        `empty=${emptyLiftIds.join(',')} stored=${storedCount}/${storageNodeCount}`
      );
    }
  }

  const activeInboundTasks = current.tasks.filter((task) =>
    task.kind === 'inbound' &&
    task.state !== 'completed' &&
    task.state !== 'failed'
  );
  const tasksByLoadId = new Map<string, string[]>();
  for (const task of activeInboundTasks) {
    tasksByLoadId.set(task.loadId, [...(tasksByLoadId.get(task.loadId) ?? []), task.id]);
  }
  for (const [loadId, taskIds] of tasksByLoadId) {
    if (taskIds.length > 1) {
      addAnomaly(current.simTimeSec, null, 'duplicate-active-inbound-source-task', 'critical', `${loadId}: ${taskIds.join(',')}`);
    }
  }
}

function auditPhysicalCommonSense(current: ShuttleSimState): void {
  const stationaryByNode = new Map<string, string[]>();
  for (const vehicle of current.vehicles) {
    if (vehicle.currentEdgeId !== null) continue;
    const ids = stationaryByNode.get(vehicle.currentNodeId) ?? [];
    ids.push(vehicle.id);
    stationaryByNode.set(vehicle.currentNodeId, ids);
  }
  for (const [nodeId, vehicleIds] of stationaryByNode) {
    if (vehicleIds.length > 1) {
      addAnomaly(current.simTimeSec, null, 'duplicate-stationary-node-occupancy', 'critical', `${nodeId}: ${vehicleIds.join(',')}`);
    }
  }

  for (let leftIndex = 0; leftIndex < current.vehicles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < current.vehicles.length; rightIndex += 1) {
      const left = current.vehicles[leftIndex]!;
      const right = current.vehicles[rightIndex]!;
      if (vehicleFootprintsOverlap(left, right, scenario.vehicles)) {
        addAnomaly(
          current.simTimeSec,
          null,
          'vehicle-footprint-overlap',
          'critical',
          `${left.id}@${left.currentNodeId} overlaps ${right.id}@${right.currentNodeId}`
        );
      }
    }
  }
}

function auditTaskCommonSense(current: ShuttleSimState): void {
  const vehicleById = new Map(current.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const taskById = new Map(current.tasks.map((task) => [task.id, task]));
  const carriedLoadVehicleById = new Map(
    current.loads
      .filter((load) => load.state === 'carried' && load.vehicleId)
      .map((load) => [load.vehicleId!, load.id])
  );
  const storedLoadByNodeId = new Map(
    current.loads
      .filter((load) => load.state === 'stored' && load.nodeId)
      .map((load) => [load.nodeId!, load.id])
  );

  for (const vehicle of current.vehicles) {
    const task = vehicle.taskId ? taskById.get(vehicle.taskId) : null;
    if (vehicle.loaded && !vehicle.taskId) {
      addAnomaly(current.simTimeSec, vehicle.id, 'loaded-vehicle-without-task', 'critical', `${vehicle.currentNodeId} loaded=true taskId=null`);
    }
    if (vehicle.taskId && !task) {
      addAnomaly(current.simTimeSec, vehicle.id, 'vehicle-references-missing-task', 'critical', `taskId=${vehicle.taskId}`);
    }
    if (vehicle.loaded && !carriedLoadVehicleById.has(vehicle.id)) {
      addAnomaly(current.simTimeSec, vehicle.id, 'loaded-vehicle-without-carried-load', 'critical', `${vehicle.currentNodeId} taskId=${vehicle.taskId ?? 'none'}`);
    }
    if (!vehicle.loaded && carriedLoadVehicleById.has(vehicle.id)) {
      addAnomaly(current.simTimeSec, vehicle.id, 'carried-load-on-empty-vehicle', 'critical', `load=${carriedLoadVehicleById.get(vehicle.id)}`);
    }
  }

  for (const task of current.tasks) {
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'queued') {
      continue;
    }
    const vehicle = task.vehicleId ? vehicleById.get(task.vehicleId) : null;
    if (!vehicle) {
      addAnomaly(current.simTimeSec, null, 'active-task-without-vehicle', 'critical', `${task.id} state=${task.state}`);
      continue;
    }
    if (vehicle.taskId !== task.id) {
      addAnomaly(current.simTimeSec, vehicle.id, 'task-vehicle-link-mismatch', 'critical', `task=${task.id} vehicle.taskId=${vehicle.taskId ?? 'none'}`);
    }
    const expectedGoal = expectedTaskGoalNodeId(vehicle, task);
    if (
      vehicle.currentNodeId !== expectedGoal &&
      vehicle.state !== 'lifting' &&
      vehicle.state !== 'lowering' &&
      vehicle.plannedGoalNodeId !== expectedGoal
    ) {
      addAnomaly(
        current.simTimeSec,
        vehicle.id,
        'planned-goal-mismatch',
        'critical',
        `task=${task.id} expected=${expectedGoal} planned=${vehicle.plannedGoalNodeId ?? 'none'} loaded=${vehicle.loaded}`
      );
    }
    if (
      vehicle.currentNodeId !== expectedGoal &&
      vehicle.state !== 'lifting' &&
      vehicle.state !== 'lowering' &&
      vehicle.plannedRouteNodeIds.length < 2
    ) {
      addAnomaly(current.simTimeSec, vehicle.id, 'task-has-no-visible-planned-route', 'critical', `task=${task.id} expected=${expectedGoal}`);
    }
    if (task.kind === 'inbound') {
      const occupiedByLoadId = storedLoadByNodeId.get(task.dropoffNodeId);
      if (occupiedByLoadId && occupiedByLoadId !== task.loadId) {
        addAnomaly(
          current.simTimeSec,
          vehicle.id,
          'inbound-dropoff-already-occupied',
          'critical',
          `${task.dropoffNodeId} has ${occupiedByLoadId}, task=${task.id} load=${task.loadId}`
        );
      }
    }
    if (task.replanCount >= replanWarnCount) {
      const severity: Severity = task.replanCount >= replanWarnCount * 2 ? 'critical' : 'warn';
      const replanKey = `${task.id}:${severity}`;
      if (!reportedTaskReplanKeys.has(replanKey)) {
        reportedTaskReplanKeys.add(replanKey);
        addAnomaly(
          current.simTimeSec,
          vehicle.id,
          'excessive-task-replans',
          severity,
          `task=${task.id} replanCount=${task.replanCount}`
        );
      }
    }
  }

  for (const port of current.traffic.liftPorts) {
    if (port.kind === 'inbound' && port.queueLength > 1) {
      addAnomaly(current.simTimeSec, null, 'lift-port-overqueued', 'warn', `${port.nodeId} waitingTaskIds=${port.waitingTaskIds.join(',')}`);
    }
  }
}

function auditVehicleCommonSense(current: ShuttleSimState, vehicle: VehicleState): void {
  const node = nodesById.get(vehicle.currentNodeId);
  if (
    vehicle.state === 'idle' &&
    node &&
    (node.noStop || node.noParking || node.type === 'intersection' || node.type === 'aisle' || node.type === 'lift-blackbox')
  ) {
    addAnomaly(current.simTimeSec, vehicle.id, 'idle-in-non-idle-area', 'critical', `${vehicle.currentNodeId} type=${node.type}`);
  }

  const activeRoute = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
  if (vehicle.targetNodeId && activeRoute.length >= 2 && activeRoute[1] !== vehicle.targetNodeId) {
    addAnomaly(
      current.simTimeSec,
      vehicle.id,
      'target-not-next-route-node',
      'warn',
      `target=${vehicle.targetNodeId} next=${activeRoute[1]} route=${activeRoute.join('>')}`
    );
  }

  const trace = traces.get(vehicle.id);
  auditRouteShape(current, vehicle, activeRoute, 'active', trace);
  auditRouteShape(current, vehicle, vehicle.plannedRouteNodeIds, 'planned', trace);
  auditRouteShape(current, vehicle, vehicle.localRouteNodeIds, 'local', trace);

  const task = taskForVehicle(current, vehicle);
  if (task?.kind === 'inbound' && vehicle.loaded) {
    auditLoadedInboundApproach(current, vehicle, task, activeRoute, 'active');
    auditLoadedInboundApproach(current, vehicle, task, vehicle.plannedRouteNodeIds, 'planned');
    auditLoadedInboundApproach(current, vehicle, task, vehicle.localRouteNodeIds, 'local');
  }
}

function auditVehicleTrace(current: ShuttleSimState, vehicle: VehicleState): void {
  const signature = [
    vehicle.state,
    vehicle.currentNodeId,
    vehicle.currentEdgeId ?? '',
    vehicle.targetNodeId ?? '',
    vehicle.waitReason ?? '',
    vehicle.blockingVehicleId ?? ''
  ].join('|');
  const trace = traces.get(vehicle.id) ?? {
    lastSignature: signature,
    lastChangeSec: current.simTimeSec,
    lastMovingPosition: { x: vehicle.x, z: vehicle.z },
    stoppedSinceSec: current.simTimeSec,
    localRouteSignature: vehicle.localRouteNodeIds.join('>'),
    localRouteSinceSec: current.simTimeSec,
    bestGoalDistanceM: null,
    noGoalProgressSinceSec: current.simTimeSec,
    lastGoalNodeId: vehicle.plannedGoalNodeId,
    recentNodes: [],
    recentTargets: [],
    oscillationKeys: new Set<string>(),
    routeIssueKeys: new Set<string>()
  };

  if (trace.lastSignature !== signature) {
    trace.lastSignature = signature;
    trace.lastChangeSec = current.simTimeSec;
  }

  const movedM = Math.hypot(vehicle.x - trace.lastMovingPosition.x, vehicle.z - trace.lastMovingPosition.z);
  if (movedM >= 0.1 || vehicle.speedMps > 0.05 || vehicle.state === 'lifting' || vehicle.state === 'lowering') {
    trace.lastMovingPosition = { x: vehicle.x, z: vehicle.z };
    trace.stoppedSinceSec = current.simTimeSec;
  }

  const localRouteSignature = vehicle.localRouteNodeIds.join('>');
  if (localRouteSignature !== trace.localRouteSignature) {
    trace.localRouteSignature = localRouteSignature;
    trace.localRouteSinceSec = current.simTimeSec;
  }

  if (trace.recentNodes.at(-1) !== vehicle.currentNodeId) {
    trace.recentNodes.push(vehicle.currentNodeId);
    if (trace.recentNodes.length > 8) trace.recentNodes.shift();
  }
  const target = vehicle.targetNodeId ?? '';
  if (trace.recentTargets.at(-1) !== target) {
    trace.recentTargets.push(target);
    if (trace.recentTargets.length > 8) trace.recentTargets.shift();
  }

  const stationarySec = current.simTimeSec - trace.lastChangeSec;
  if (stationarySec >= stationaryWarnSec && vehicle.state === 'waiting-blocked') {
    addAnomaly(
      current.simTimeSec,
      vehicle.id,
      'long-stationary-wait',
      stationarySec >= stationaryWarnSec * 2 ? 'critical' : 'warn',
      `${vehicle.currentNodeId} -> ${vehicle.targetNodeId ?? 'none'} ${vehicle.waitReason ?? 'traffic-hold'} for ${stationarySec.toFixed(1)}s`
    );
    trace.lastChangeSec = current.simTimeSec;
  }

  const task = taskForVehicle(current, vehicle);
  const stoppedSec = current.simTimeSec - trace.stoppedSinceSec;
  if (
    task &&
    stoppedSec >= taskStoppedWarnSec &&
    vehicle.state !== 'waiting-blocked' &&
    vehicle.state !== 'lifting' &&
    vehicle.state !== 'lowering' &&
    vehicle.currentNodeId !== expectedTaskGoalNodeId(vehicle, task)
  ) {
    addAnomaly(
      current.simTimeSec,
      vehicle.id,
      'tasked-vehicle-stopped-without-wait',
      stoppedSec >= taskStoppedWarnSec * 2 ? 'critical' : 'warn',
      `${vehicle.state} at ${vehicle.currentNodeId} for ${stoppedSec.toFixed(1)}s with task=${task.id}`
    );
    trace.stoppedSinceSec = current.simTimeSec;
  }

  if (vehicle.localRouteNodeIds.length > 1) {
    const temporarySec = current.simTimeSec - trace.localRouteSinceSec;
    if (temporarySec >= temporaryRouteWarnSec) {
      addAnomaly(
        current.simTimeSec,
        vehicle.id,
        'temporary-route-too-long',
        temporarySec >= temporaryRouteWarnSec * 2 ? 'critical' : 'warn',
        `${vehicle.localRouteReason ?? 'temporary-route'} active for ${temporarySec.toFixed(1)}s route=${vehicle.localRouteNodeIds.join('>')}`
      );
      trace.localRouteSinceSec = current.simTimeSec;
    }
  }

  const goalNodeId = task ? expectedTaskGoalNodeId(vehicle, task) : null;
  const goalDistance = goalNodeId ? nominalShortestDistance(current, vehicle, goalNodeId) : null;
  if (goalNodeId !== trace.lastGoalNodeId) {
    trace.lastGoalNodeId = goalNodeId;
    trace.bestGoalDistanceM = goalDistance;
    trace.noGoalProgressSinceSec = current.simTimeSec;
  } else if (goalDistance !== null && Number.isFinite(goalDistance)) {
    const previousBest = trace.bestGoalDistanceM ?? goalDistance;
    if (goalDistance < previousBest - 0.5) {
      trace.bestGoalDistanceM = goalDistance;
      trace.noGoalProgressSinceSec = current.simTimeSec;
    } else if (
      task &&
      current.simTimeSec - trace.noGoalProgressSinceSec >= noProgressWarnSec &&
      vehicle.state !== 'waiting-blocked' &&
      vehicle.state !== 'lifting' &&
      vehicle.state !== 'lowering' &&
      stoppedSec >= noProgressWarnSec &&
      vehicle.speedMps <= 0.05 &&
      vehicle.currentNodeId !== goalNodeId
    ) {
      addAnomaly(
        current.simTimeSec,
        vehicle.id,
        'no-progress-to-task-goal',
        current.simTimeSec - trace.noGoalProgressSinceSec >= noProgressWarnSec * 2 ? 'critical' : 'warn',
        `goal=${goalNodeId} best=${previousBest.toFixed(1)}m current=${goalDistance.toFixed(1)}m state=${vehicle.state}`
      );
      trace.noGoalProgressSinceSec = current.simTimeSec;
      trace.bestGoalDistanceM = goalDistance;
    }
  } else {
    trace.bestGoalDistanceM = null;
    trace.noGoalProgressSinceSec = current.simTimeSec;
  }

  const nodes = trace.recentNodes;
  if (nodes.length >= 5) {
    const tail = nodes.slice(-5);
    if (tail[0] === tail[2] && tail[1] === tail[3] && tail[2] === tail[4]) {
      const key = tail.join('>');
      if (!trace.oscillationKeys.has(key) && !hasRecentIntentionalRetreat(current, vehicle.id)) {
        trace.oscillationKeys.add(key);
        addAnomaly(current.simTimeSec, vehicle.id, 'node-oscillation', vehicle.speedMps <= 0.05 || vehicle.state === 'waiting-blocked' ? 'critical' : 'warn', key);
      }
    }
  }

  const targets = trace.recentTargets.filter(Boolean);
  if (targets.length >= 5) {
    const tail = targets.slice(-5);
    if (tail[0] === tail[2] && tail[1] === tail[3] && tail[2] === tail[4]) {
      const key = tail.join('>');
      if (!trace.oscillationKeys.has(`target:${key}`) && !hasRecentIntentionalRetreat(current, vehicle.id)) {
        trace.oscillationKeys.add(`target:${key}`);
        addAnomaly(current.simTimeSec, vehicle.id, 'target-oscillation', 'warn', key);
      }
    }
  }

  traces.set(vehicle.id, trace);
}

function hasRecentIntentionalRetreat(current: ShuttleSimState, vehicleId: string): boolean {
  return (intentionalRetreatUntilSec.get(vehicleId) ?? -Infinity) >= current.simTimeSec;
}

function trackIntentionalRetreats(current: ShuttleSimState): void {
  for (const event of current.recentEvents) {
    if (
      event.vehicleId &&
      event.eventType === 'route-replanned' &&
      (event.reason === 'loaded-retreats-from-faceoff' || event.reason === 'empty-retreats-to-local-yield')
    ) {
      intentionalRetreatUntilSec.set(event.vehicleId, Math.max(intentionalRetreatUntilSec.get(event.vehicleId) ?? 0, event.timeSec + 30));
    }
  }
}

function auditRouteDetour(current: ShuttleSimState, vehicle: VehicleState): void {
  const route = vehicle.plannedRouteNodeIds.length >= 2
    ? vehicle.plannedRouteNodeIds
    : vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
  if (route.length < 3) return;
  const goalNodeId = route.at(-1);
  if (!goalNodeId) return;
  const plannedDistance = routeDistance(route);
  if (!Number.isFinite(plannedDistance) || plannedDistance <= 0) return;
  const shortest = nominalShortestAgentPath(current, vehicle, goalNodeId);
  if (!shortest) return;
  const shortestDistance = routeDistance(shortest);
  if (!Number.isFinite(shortestDistance) || shortestDistance <= 0) return;
  const ratio = plannedDistance / shortestDistance;
  const extraM = plannedDistance - shortestDistance;
  if (ratio >= detourWarnRatio && extraM >= 10) {
    addAnomaly(
      current.simTimeSec,
      vehicle.id,
      'route-detour',
      ratio >= detourWarnRatio * 1.5 ? 'critical' : 'warn',
      `ratio=${ratio.toFixed(2)} extraM=${extraM.toFixed(1)} route=${route.join('>')}`
    );
  }
}

function auditRouteShape(
  current: ShuttleSimState,
  vehicle: VehicleState,
  route: string[],
  label: string,
  trace: VehicleTrace | undefined
): void {
  if (route.length < 2) return;
  const routeKey = `${label}:${route.join('>')}`;
  if (trace?.routeIssueKeys.has(routeKey)) return;

  for (let index = 1; index < route.length; index += 1) {
    if (!edgeFor(route[index - 1]!, route[index]!)) {
      trace?.routeIssueKeys.add(routeKey);
      addAnomaly(
        current.simTimeSec,
        vehicle.id,
        'route-has-non-adjacent-hop',
        'critical',
        `${label} ${route[index - 1]} -> ${route[index]} route=${route.join('>')}`
      );
      return;
    }
  }

  const task = taskForVehicle(current, vehicle);
  const allowedBounceNodeIds = new Set([task?.pickupNodeId, task?.dropoffNodeId].filter((nodeId): nodeId is string => Boolean(nodeId)));
  for (let index = 2; index < route.length; index += 1) {
    const a = route[index - 2]!;
    const b = route[index - 1]!;
    const c = route[index]!;
    if (a === c && !allowedBounceNodeIds.has(b)) {
      trace?.routeIssueKeys.add(routeKey);
      addAnomaly(
        current.simTimeSec,
        vehicle.id,
        'route-immediate-backtrack',
        label === 'planned' ? 'critical' : 'warn',
        `${label} ${a}>${b}>${c} route=${route.join('>')}`
      );
      return;
    }
  }
}

function auditLoadedInboundApproach(
  current: ShuttleSimState,
  vehicle: VehicleState,
  task: TaskStateRecord,
  route: string[],
  label: string
): void {
  if (route.length < 2) return;
  const dropoffIndex = route.indexOf(task.dropoffNodeId);
  if (dropoffIndex < 0) return;
  const dropoffPosition = storagePosition(task.dropoffNodeId);
  if (!dropoffPosition) return;
  const rowText = String(dropoffPosition.row).padStart(2, '0');
  const routeToDropoff = route.slice(0, dropoffIndex + 1);
  const leftRowIndex = routeToDropoff.indexOf(`left-row-${rowText}`);
  if (leftRowIndex >= 0) {
    addAnomaly(
      current.simTimeSec,
      vehicle.id,
      'loaded-inbound-wrong-side-approach',
      'critical',
      `${label} approaches ${task.dropoffNodeId} via left-row-${rowText}: ${route.join('>')}`
    );
  }

  const storageColumns = routeToDropoff
    .map((nodeId) => storagePosition(nodeId))
    .filter((position): position is { row: number; column: number } => position !== null && position.row === dropoffPosition.row)
    .map((position) => position.column);
  for (let index = 1; index < storageColumns.length; index += 1) {
    if (storageColumns[index]! > storageColumns[index - 1]!) {
      addAnomaly(
        current.simTimeSec,
        vehicle.id,
        'loaded-inbound-storage-left-to-right',
        'critical',
        `${label} columns=${storageColumns.join('>')} dropoff=${task.dropoffNodeId} route=${route.join('>')}`
      );
      return;
    }
  }
}

function auditLoadedRoutesThroughStoredLoads(current: ShuttleSimState): void {
  const storedNodeIds = new Set(
    current.loads
      .filter((load) => load.state === 'stored' && load.nodeId?.startsWith('storage-'))
      .flatMap((load) => load.nodeId ? [load.nodeId] : [])
  );
  const taskById = new Map(current.tasks.map((task) => [task.id, task]));
  for (const vehicle of current.vehicles.filter((candidate) => candidate.loaded && candidate.taskId)) {
    const task = taskById.get(vehicle.taskId!);
    if (!task) continue;
    const route = vehicle.routeNodeIds.length > 1 ? vehicle.routeNodeIds : vehicle.plannedRouteNodeIds;
    const dropoffIndex = route.indexOf(task.dropoffNodeId, Math.max(0, vehicle.routeIndex));
    const loadedPath = dropoffIndex >= 0
      ? route.slice(Math.max(0, vehicle.routeIndex) + 1, dropoffIndex)
      : route.slice(Math.max(0, vehicle.routeIndex) + 1);
    const blockers = loadedPath.filter((nodeId) => storedNodeIds.has(nodeId));
    if (blockers.length > 0) {
      addAnomaly(current.simTimeSec, vehicle.id, 'loaded-route-through-stored-load', 'critical', blockers.join(','));
    }
  }
}

function addAnomaly(timeSec: number, vehicleId: string | null, code: string, severity: Severity, detail: string): void {
  const previous = anomalies.at(-1);
  if (
    previous &&
    previous.vehicleId === vehicleId &&
    previous.code === code &&
    previous.detail === detail &&
    timeSec - previous.timeSec < sampleSec * 2
  ) {
    return;
  }
  anomalies.push({ timeSec: round(timeSec), vehicleId, code, severity, detail });
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function taskForVehicle(current: ShuttleSimState, vehicle: VehicleState): TaskStateRecord | null {
  if (!vehicle.taskId) return null;
  const task = current.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null;
  if (!task || task.state === 'completed' || task.state === 'failed') return null;
  return task;
}

function expectedTaskGoalNodeId(vehicle: VehicleState, task: TaskStateRecord): string {
  return vehicle.loaded || vehicle.state === 'lowering' ? task.dropoffNodeId : task.pickupNodeId;
}

function nominalShortestDistance(current: ShuttleSimState, vehicle: VehicleState, toNodeId: string): number | null {
  const route = nominalShortestAgentPath(current, vehicle, toNodeId);
  return route ? routeDistance(route) : null;
}

function nominalShortestAgentPath(current: ShuttleSimState, vehicle: VehicleState, goalNodeId: string): string[] | null {
  const task = taskForVehicle(current, vehicle);
  if (task?.kind === 'inbound' && vehicle.loaded && goalNodeId === task.dropoffNodeId) {
    return nominalLoadedInboundPath(current, vehicle, task);
  }
  return shortestAgentPath(vehicle.currentNodeId, goalNodeId, blockedNodesForVehicle(current, vehicle, goalNodeId));
}

function nominalLoadedInboundPath(current: ShuttleSimState, vehicle: VehicleState, task: TaskStateRecord): string[] | null {
  const route = [vehicle.currentNodeId];
  const rightSideNodeId = storageSideNodeId(task.dropoffNodeId, 'right');
  const dropoffRow = storageRow(task.dropoffNodeId);
  const currentRow = storageRow(vehicle.currentNodeId);
  const alreadyInRightEntryLane =
    vehicle.currentNodeId === rightSideNodeId ||
    (isStorageNode(vehicle.currentNodeId) && currentRow !== null && currentRow === dropoffRow);
  const targets = alreadyInRightEntryLane ? [task.dropoffNodeId] : [rightSideNodeId, task.dropoffNodeId];
  for (const target of targets) {
    if (!target || target === route.at(-1)) continue;
    const routeVehicle = { ...vehicle, currentNodeId: route.at(-1)! };
    const segment = shortestAgentPath(routeVehicle.currentNodeId, target, blockedNodesForVehicle(current, routeVehicle, target));
    if (!segment) return null;
    route.push(...segment.slice(1));
  }
  return route;
}

function edgeFor(fromNodeId: string, toNodeId: string): ShuttleScenario['layout']['edges'][number] | undefined {
  return scenario.layout.edges.find((edge) =>
    (edge.from === fromNodeId && edge.to === toNodeId) ||
    (edge.directionMode === 'twoWay' && edge.from === toNodeId && edge.to === fromNodeId)
  );
}

function buildGraph(currentScenario: ShuttleScenario): Map<string, Array<{ nodeId: string; lengthM: number }>> {
  const byNode = new Map<string, Array<{ nodeId: string; lengthM: number }>>();
  const add = (from: string, to: string, lengthM: number) => {
    const neighbors = byNode.get(from) ?? [];
    neighbors.push({ nodeId: to, lengthM });
    byNode.set(from, neighbors);
  };
  for (const edge of currentScenario.layout.edges) {
    add(edge.from, edge.to, edge.lengthM);
    if (edge.directionMode === 'twoWay') {
      add(edge.to, edge.from, edge.lengthM);
    }
  }
  return byNode;
}

function shortestAgentPath(fromNodeId: string, toNodeId: string, blockedNodeIds: Set<string>): string[] | null {
  if (fromNodeId === toNodeId) return [fromNodeId];
  const open = new Set<string>([fromNodeId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[fromNodeId, 0]]);

  while (open.size > 0) {
    const current = [...open].sort((left, right) => (gScore.get(left) ?? Infinity) - (gScore.get(right) ?? Infinity) || left.localeCompare(right))[0]!;
    if (current === toNodeId) {
      const path = [current];
      while (cameFrom.has(path[0]!)) {
        path.unshift(cameFrom.get(path[0]!)!);
      }
      return path;
    }
    open.delete(current);
    for (const neighbor of graph.get(current) ?? []) {
      if (blockedNodeIds.has(neighbor.nodeId) || !agentEdgeDirectionAllowed(current, neighbor.nodeId, toNodeId)) continue;
      const tentative = (gScore.get(current) ?? Infinity) + neighbor.lengthM;
      if (tentative < (gScore.get(neighbor.nodeId) ?? Infinity)) {
        cameFrom.set(neighbor.nodeId, current);
        gScore.set(neighbor.nodeId, tentative);
        open.add(neighbor.nodeId);
      }
    }
  }
  return null;
}

function blockedNodesForVehicle(current: ShuttleSimState, vehicle: VehicleState, goalNodeId: string): Set<string> {
  const blocked = new Set<string>();
  const fromRow = storageRow(vehicle.currentNodeId);
  const goalRow = storageRow(goalNodeId);
  const fromIsStorage = isStorageNode(vehicle.currentNodeId);
  const goalIsStorage = isStorageNode(goalNodeId);
  const allowedRow = fromIsStorage && goalIsStorage
    ? fromRow === goalRow ? fromRow : null
    : fromIsStorage
      ? fromRow
      : goalIsStorage
        ? goalRow
        : null;

  for (const node of scenario.layout.nodes) {
    if (node.type !== 'storage') continue;
    if (node.id !== vehicle.currentNodeId && node.id !== goalNodeId && storageRow(node.id) !== allowedRow) {
      blocked.add(node.id);
    }
  }

  if (vehicle.loaded) {
    for (const load of current.loads) {
      if (load.state === 'stored' && load.nodeId && load.nodeId !== vehicle.currentNodeId && load.nodeId !== goalNodeId) {
        blocked.add(load.nodeId);
      }
    }
  }

  return blocked;
}

function routeDistance(routeNodeIds: string[]): number {
  let distance = 0;
  for (let index = 1; index < routeNodeIds.length; index += 1) {
    const from = routeNodeIds[index - 1]!;
    const to = routeNodeIds[index]!;
    const edge = edgeFor(from, to);
    if (!edge) return Number.POSITIVE_INFINITY;
    distance += edge.lengthM;
  }
  return distance;
}

function agentEdgeDirectionAllowed(fromNodeId: string, toNodeId: string, goalNodeId: string): boolean {
  const fromMain = /^main-(north|south)-(\d+)$/.exec(fromNodeId);
  const toMain = /^main-(north|south)-(\d+)$/.exec(toNodeId);
  if (!fromMain || !toMain || fromMain[1] !== toMain[1]) return true;
  const fromIndex = Number(fromMain[2]);
  const toIndex = Number(toMain[2]);
  const preferredDirection = fromMain[1] === 'north' ? toIndex >= fromIndex : toIndex <= fromIndex;
  if (preferredDirection) return true;
  const goalNode = scenario.layout.nodes.find((node) => node.id === goalNodeId);
  const goalIsLiftPort = goalNode?.type === 'inbound' || goalNode?.type === 'outbound' || goalNode?.type === 'lift-blackbox';
  return Boolean(goalIsLiftPort && (graph.get(toNodeId) ?? []).some((neighbor) => neighbor.nodeId === goalNodeId));
}

function storageRow(nodeId: string): string | null {
  const position = storagePosition(nodeId);
  return position ? String(position.row).padStart(2, '0') : null;
}

function isStorageNode(nodeId: string): boolean {
  return /^storage-r\d+-c\d+$/.test(nodeId);
}

function storageSideNodeId(storageNodeId: string, side: 'left' | 'right'): string | null {
  const row = storageRow(storageNodeId);
  if (!row) return null;
  const sideNodeId = `${side}-row-${row}`;
  return nodesById.has(sideNodeId) ? sideNodeId : null;
}

function storagePosition(nodeId: string): { row: number; column: number } | null {
  const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
  return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
}

type FootprintPose = Pick<VehicleState, 'x' | 'z' | 'yaw'>;
type Axis2 = { x: number; z: number };

function footprintAxes(yaw: number): [Axis2, Axis2] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [
    { x: cos, z: sin },
    { x: -sin, z: cos }
  ];
}

function footprintCorners(
  vehicle: FootprintPose,
  config: ShuttleScenario['vehicles']
): Array<{ x: number; z: number }> {
  const [forward, lateral] = footprintAxes(vehicle.yaw);
  const halfLengthM = config.lengthM / 2 + config.safetyRadiusM / 2;
  const halfWidthM = config.widthM / 2 + config.safetyRadiusM / 2;
  return [
    { x: vehicle.x + forward.x * halfLengthM + lateral.x * halfWidthM, z: vehicle.z + forward.z * halfLengthM + lateral.z * halfWidthM },
    { x: vehicle.x + forward.x * halfLengthM - lateral.x * halfWidthM, z: vehicle.z + forward.z * halfLengthM - lateral.z * halfWidthM },
    { x: vehicle.x - forward.x * halfLengthM + lateral.x * halfWidthM, z: vehicle.z - forward.z * halfLengthM + lateral.z * halfWidthM },
    { x: vehicle.x - forward.x * halfLengthM - lateral.x * halfWidthM, z: vehicle.z - forward.z * halfLengthM - lateral.z * halfWidthM }
  ];
}

function projectionRange(corners: Array<{ x: number; z: number }>, axis: Axis2): { min: number; max: number } {
  const values = corners.map((corner) => corner.x * axis.x + corner.z * axis.z);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function vehicleFootprintsOverlap(
  left: FootprintPose,
  right: FootprintPose,
  config: ShuttleScenario['vehicles']
): boolean {
  const leftCorners = footprintCorners(left, config);
  const rightCorners = footprintCorners(right, config);
  const axes = [...footprintAxes(left.yaw), ...footprintAxes(right.yaw)];
  return axes.every((axis) => {
    const leftRange = projectionRange(leftCorners, axis);
    const rightRange = projectionRange(rightCorners, axis);
    return leftRange.max + 1e-6 >= rightRange.min && rightRange.max + 1e-6 >= leftRange.min;
  });
}

function utilizationAverages(current: ShuttleSimState): { busy: number; productive: number; waiting: number } {
  const breakdowns = Object.values(current.kpis.vehicleUtilizationBreakdown ?? {});
  if (breakdowns.length === 0) return { busy: 0, productive: 0, waiting: 0 };
  return {
    busy: round(breakdowns.reduce((sum, value) => sum + value.busy, 0) / breakdowns.length),
    productive: round(breakdowns.reduce((sum, value) => sum + value.productive, 0) / breakdowns.length),
    waiting: round(breakdowns.reduce((sum, value) => sum + value.waiting, 0) / breakdowns.length)
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
