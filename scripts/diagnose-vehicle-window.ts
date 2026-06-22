import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createInboundOutboundDemoScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

type VehicleSample = {
  timeSec: number;
  id: string;
  taskId: string | null;
  state: string;
  loaded: boolean;
  currentNodeId: string;
  targetNodeId: string | null;
  plannedGoalNodeId: string | null;
  currentEdgeId: string | null;
  routeIndex: number | null;
  waitReason: string | null;
  blockingVehicleId: string | null;
  x: number;
  z: number;
  speedMps: number;
  routeNodeIds: string[];
  plannedRouteNodeIds: string[];
  localRouteNodeIds: string[];
  localRouteReason: string | null;
};

type MovementEvent = {
  timeSec: number;
  id: string;
  code: string;
  detail: string;
};

type TaskSample = {
  timeSec: number;
  id: string;
  kind: string;
  state: string;
  vehicleId: string | null;
  pickupNodeId: string;
  dropoffNodeId: string;
  waitReason: string | null;
};

const startSec = numberArg('--start-sec', 650);
const endSec = numberArg('--end-sec', 800);
const dtSec = numberArg('--dt-sec', 0.2);
const sampleSec = numberArg('--sample-sec', dtSec);
const taskSampleSec = numberArg('--task-sample-sec', 5);
const progressSec = numberArg('--progress-sec', 600);
const fastForwardChunkSec = numberArg('--fast-forward-chunk-sec', 30);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'zone-balanced-50');
const storageSelectionPolicy = enumArg('--storage-selection-policy', ['sequential', 'traffic-aware'] as const, 'sequential');
const vehicleIds = stringArg('--vehicles', 'SH-04,SH-06')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outPath = resolve(stringArg('--out') ?? 'output/review/vehicle-window-diagnosis.json');

mkdirSync(dirname(outPath), { recursive: true });

const scenario = createInboundOutboundDemoScenario({
  durationSec: endSec,
  timeStepSec: dtSec,
  vehicles: { count: shuttleCount },
  taskGeneration: {
    inboundRatePerHour,
    outboundRatePerHour,
    inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
      ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
      : 0.5,
    initialStorageFillPolicy,
    initialOutboundFullColumns,
    storageSelectionPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const sim = new ShuttleSimCore(scenario);
const samples: VehicleSample[] = [];
const taskSamples: TaskSample[] = [];
const events: MovementEvent[] = [];
const lastByVehicle = new Map<string, VehicleSample>();
const recentNodeChanges = new Map<string, Array<{ timeSec: number; nodeId: string }>>();
const recentAxisMove = new Map<string, { timeSec: number; axis: 'x' | 'z'; sign: -1 | 1; magnitude: number }>();
let nextTaskSampleSec = startSec;
let nextProgressSec = progressSec > 0 ? progressSec : Number.POSITIVE_INFINITY;

sim.start();
while (sim.getClock().simTimeSec < startSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const stepSec = Math.min(
    Math.max(scenario.timeStepSec, fastForwardChunkSec),
    startSec - clock.simTimeSec
  );
  sim.advanceByInPlace(stepSec);
  const nextClock = sim.getClock();
  if (progressSec > 0 && nextClock.simTimeSec + 1e-9 >= nextProgressSec) {
    console.error(JSON.stringify({
      type: 'vehicle-window-diagnosis-progress',
      timeSec: round(nextClock.simTimeSec),
      startSec,
      endSec,
      phase: 'fast-forward',
      samples: samples.length,
      events: events.length
    }));
    while (nextProgressSec <= nextClock.simTimeSec + 1e-9) {
      nextProgressSec += progressSec;
    }
  }
}

while (sim.getClock().simTimeSec < endSec - 1e-9 && sim.getClock().status === 'running') {
  const sampleStepSec = Math.min(
    Math.max(dtSec, sampleSec),
    endSec - sim.getClock().simTimeSec
  );
  sim.advanceByInPlace(sampleStepSec);
  const state = sim.getState();
  if (progressSec > 0 && state.simTimeSec + 1e-9 >= nextProgressSec) {
    console.error(JSON.stringify({
      type: 'vehicle-window-diagnosis-progress',
      timeSec: round(state.simTimeSec),
      startSec,
      endSec,
      phase: 'sample-window',
      samples: samples.length,
      events: events.length
    }));
    while (nextProgressSec <= state.simTimeSec + 1e-9) {
      nextProgressSec += progressSec;
    }
  }
  if (state.simTimeSec + 1e-9 < startSec) {
    continue;
  }

  for (const vehicle of state.vehicles) {
    if (!vehicleIds.includes(vehicle.id)) {
      continue;
    }
    const sample: VehicleSample = {
      timeSec: round(state.simTimeSec),
      id: vehicle.id,
      taskId: vehicle.taskId,
      state: vehicle.state,
      loaded: vehicle.loaded,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      currentEdgeId: vehicle.currentEdgeId,
      routeIndex: typeof (vehicle as { routeIndex?: unknown }).routeIndex === 'number'
        ? (vehicle as { routeIndex: number }).routeIndex
        : null,
      waitReason: vehicle.waitReason,
      blockingVehicleId: vehicle.blockingVehicleId,
      x: round(vehicle.x),
      z: round(vehicle.z),
      speedMps: round(vehicle.speedMps),
      routeNodeIds: [...vehicle.routeNodeIds],
      plannedRouteNodeIds: [...vehicle.plannedRouteNodeIds],
      localRouteNodeIds: [...vehicle.localRouteNodeIds],
      localRouteReason: vehicle.localRouteReason
    };
    samples.push(sample);
    auditSample(sample);
    lastByVehicle.set(vehicle.id, sample);
  }

  if (taskSampleSec > 0 && state.simTimeSec + 1e-9 >= nextTaskSampleSec) {
    for (const task of state.tasks) {
      if (task.vehicleId && vehicleIds.includes(task.vehicleId) && task.state !== 'completed' && task.state !== 'failed') {
        taskSamples.push({
          timeSec: round(state.simTimeSec),
          id: task.id,
          kind: task.kind,
          state: task.state,
          vehicleId: task.vehicleId,
          pickupNodeId: task.pickupNodeId,
          dropoffNodeId: task.dropoffNodeId,
          waitReason: task.waitReason
        });
      }
    }
    while (nextTaskSampleSec <= state.simTimeSec + 1e-9) {
      nextTaskSampleSec += taskSampleSec;
    }
  }
}

const state = sim.getState();
const relevantVehicleIds = new Set(vehicleIds);
const eventLog = sim.getEventLog()
  .filter((event) =>
    event.timeSec >= startSec &&
    event.timeSec <= endSec &&
    (event.vehicleId === null || relevantVehicleIds.has(event.vehicleId))
  )
  .map((event) => ({
    timeSec: event.timeSec,
    eventType: event.eventType,
    vehicleId: event.vehicleId,
    taskId: event.taskId,
    fromNodeId: event.fromNodeId,
    toNodeId: event.toNodeId,
    reason: event.reason,
    details: event.details
  }));
const report = {
  schemaVersion: 'shuttle.vehicleWindowDiagnosis.v1',
  startSec,
  endSec,
  dtSec,
  sampleSec,
  taskSampleSec,
  progressSec,
  fastForwardChunkSec,
  vehicleIds,
  summary: {
    finalSimTimeSec: state.simTimeSec,
    status: state.status,
    totalPph: state.kpis.totalPph,
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    waitingVehicles: state.traffic.waitingVehicles?.length ?? 0,
    blockedVehicles: state.traffic.blockedVehicles?.length ?? 0,
    physicalViolations: state.traffic.physicalViolationCount,
    eventCounts: countBy(events.map((event) => event.code))
  },
  events,
  eventLog,
  taskSamples,
  samples
};

writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  type: 'vehicle-window-diagnosis-complete',
  outPath,
  samples: samples.length,
  events: events.length,
  eventCounts: report.summary.eventCounts,
  summary: report.summary
}, null, 2));

function auditSample(sample: VehicleSample): void {
  const previous = lastByVehicle.get(sample.id);
  if (!previous) {
    return;
  }

  if (sample.currentNodeId !== previous.currentNodeId) {
    const changes = recentNodeChanges.get(sample.id) ?? [];
    changes.push({ timeSec: sample.timeSec, nodeId: sample.currentNodeId });
    const recent = changes.filter((change) => sample.timeSec - change.timeSec <= 20);
    recentNodeChanges.set(sample.id, recent);
    const uniqueNodes = new Set(recent.map((change) => change.nodeId));
    if (recent.length >= 6 && uniqueNodes.size <= 3) {
      events.push({
        timeSec: sample.timeSec,
        id: sample.id,
        code: 'repeated-node-jitter',
        detail: recent.map((change) => `${change.timeSec}:${change.nodeId}`).join(' > ')
      });
      recentNodeChanges.set(sample.id, recent.slice(-2));
    }
  }

  const previousRouteSignature = previous.routeNodeIds.join('>');
  const currentRouteSignature = sample.routeNodeIds.join('>');
  if (currentRouteSignature !== previousRouteSignature) {
    events.push({
      timeSec: sample.timeSec,
      id: sample.id,
      code: 'route-signature-changed',
      detail: `routeIndex ${previous.routeIndex ?? '?'}->${sample.routeIndex ?? '?'} ${previousRouteSignature} => ${currentRouteSignature}`
    });
  }

  const dx = sample.x - previous.x;
  const dz = sample.z - previous.z;
  const absX = Math.abs(dx);
  const absZ = Math.abs(dz);
  if (Math.max(absX, absZ) <= 0.08) {
    return;
  }
  const axis = absX >= absZ ? 'x' : 'z';
  const sign = (axis === 'x' ? dx : dz) < 0 ? -1 : 1;
  const magnitude = axis === 'x' ? absX : absZ;
  const last = recentAxisMove.get(sample.id);
  if (
    last &&
    last.axis === axis &&
    last.sign !== sign &&
    last.magnitude > 0.08 &&
    sample.timeSec - last.timeSec <= 8
  ) {
    events.push({
      timeSec: sample.timeSec,
      id: sample.id,
      code: 'axis-turnback-under-8s',
      detail: `${sample.id} reversed ${axis} after ${round(sample.timeSec - last.timeSec)}s from ${previous.currentNodeId}->${sample.currentNodeId}, target=${sample.targetNodeId ?? '?'} wait=${sample.waitReason ?? 'none'} blocker=${sample.blockingVehicleId ?? 'none'}`
    });
  }
  recentAxisMove.set(sample.id, { timeSec: sample.timeSec, axis, sign, magnitude });
}

function numberArg(name: string, fallback: number): number {
  const value = stringArg(name, null);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.max(0, Math.round(numberArg(name, fallback)));
}

function enumArg<const T extends readonly string[]>(name: string, values: T, fallback: T[number]): T[number] {
  const value = stringArg(name, fallback);
  return values.includes(value as T[number]) ? value as T[number] : fallback;
}

function stringArg(name: string, fallback: string | null): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return process.argv[index + 1] ?? fallback;
  }
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  return fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
