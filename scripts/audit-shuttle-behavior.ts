import type { ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

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
  recentNodes: string[];
  recentTargets: string[];
  oscillationKeys: Set<string>;
};

const durationSec = numberArg('--duration', 300);
const dtSec = numberArg('--dt', 0.2);
const sampleSec = numberArg('--sample', 1);
const stationaryWarnSec = numberArg('--stationary-warn', 30);
const detourWarnRatio = numberArg('--detour-ratio', 2.25);

const scenario = createDefaultShuttleScenario({
  id: 'audit-agent-simple-8-inbound',
  name: 'Audit Agent Simple 8 Shuttle Inbound',
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
    controllerMode: 'agent-simple',
    liftApproachCapacity: 8,
    minimumClearanceSec: 0.4,
    deadlockDetectSec: 20
  }
});

const graph = buildGraph(scenario);
const sim = new ShuttleSimCore(scenario);
const traces = new Map<string, VehicleTrace>();
const anomalies: Anomaly[] = [];

sim.start();
let state = sim.getState();
let nextSampleSec = 0;
for (let elapsedSec = 0; elapsedSec < durationSec; elapsedSec = Number((elapsedSec + dtSec).toFixed(6))) {
  state = sim.step(dtSec);
  if (state.simTimeSec + 1e-6 >= nextSampleSec) {
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
    avgWaiting: utilization.waiting,
    waitingVehicles: finalState.traffic.waitingVehicles.length
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
    addAnomaly(current.simTimeSec, null, 'all-vehicles-waiting', 'critical', 'every shuttle is waiting-blocked');
  }

  auditLoadedRoutesThroughStoredLoads(current);
  for (const vehicle of current.vehicles) {
    auditVehicleTrace(current, vehicle);
    auditRouteDetour(current, vehicle);
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
    recentNodes: [],
    recentTargets: [],
    oscillationKeys: new Set<string>()
  };

  if (trace.lastSignature !== signature) {
    trace.lastSignature = signature;
    trace.lastChangeSec = current.simTimeSec;
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
      `${vehicle.currentNodeId} -> ${vehicle.targetNodeId ?? 'none'} ${vehicle.waitReason ?? 'waiting'} for ${stationarySec.toFixed(1)}s`
    );
    trace.lastChangeSec = current.simTimeSec;
  }

  const nodes = trace.recentNodes;
  if (nodes.length >= 5) {
    const tail = nodes.slice(-5);
    if (tail[0] === tail[2] && tail[1] === tail[3] && tail[2] === tail[4]) {
      const key = tail.join('>');
      if (!trace.oscillationKeys.has(key)) {
        trace.oscillationKeys.add(key);
        addAnomaly(current.simTimeSec, vehicle.id, 'node-oscillation', 'critical', key);
      }
    }
  }

  const targets = trace.recentTargets.filter(Boolean);
  if (targets.length >= 5) {
    const tail = targets.slice(-5);
    if (tail[0] === tail[2] && tail[1] === tail[3] && tail[2] === tail[4]) {
      const key = tail.join('>');
      if (!trace.oscillationKeys.has(`target:${key}`)) {
        trace.oscillationKeys.add(`target:${key}`);
        addAnomaly(current.simTimeSec, vehicle.id, 'target-oscillation', 'warn', key);
      }
    }
  }

  traces.set(vehicle.id, trace);
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
  const shortest = shortestAgentPath(vehicle.currentNodeId, goalNodeId, blockedNodesForVehicle(current, vehicle, goalNodeId));
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
    const edge = scenario.layout.edges.find((candidate) =>
      (candidate.from === from && candidate.to === to) ||
      (candidate.directionMode === 'twoWay' && candidate.from === to && candidate.to === from)
    );
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
  return /^storage-r(\d+)-c\d+$/.exec(nodeId)?.[1] ?? null;
}

function isStorageNode(nodeId: string): boolean {
  return /^storage-r\d+-c\d+$/.test(nodeId);
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
