import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createInboundOutboundDemoScenario,
  hashScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

type LivenessSample = {
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  completedTotal: number;
  deltaCompleted: number;
  totalPph: number;
  deadlocks: number;
  livelocks: number;
  physicalViolations: number;
  waitingVehicles: number;
  activeTasks: number;
};

type LivenessAnomaly = {
  timeSec: number;
  code: string;
  severity: 'warn' | 'critical';
  detail: string;
};

const durationSec = numberArg('--duration-sec', 43_200);
const dtSec = numberArg('--dt-sec', 1);
const sampleSec = numberArg('--sample-sec', 300);
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const initialStorageFillPolicy = enumArg('--initial-fill-policy', ['full-columns', 'zone-balanced-50'] as const, 'full-columns');
const storageSelectionPolicy = enumArg('--storage-selection-policy', ['sequential', 'traffic-aware'] as const, 'sequential');
const maxStalledSampleWindows = integerArg('--max-stalled-sample-windows', 1);
const maxActiveVehicleStillSec = numberArg('--max-active-vehicle-still-sec', 180);
const maxZeroDisplayOutboundWindows = integerArg('--max-zero-display-outbound-windows', 1);
const outputPath = resolve(stringArg('--out') ?? `output/shuttle/yellow-grid-liveness-${Date.now()}.json`);

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
    initialStorageFillPolicy,
    storageSelectionPolicy
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const sim = new ShuttleSimCore(scenario);
const samples: LivenessSample[] = [];
const anomalies: LivenessAnomaly[] = [];
let nextSampleSec = 0;
let lastCompletedTotal = 0;
let stalledSampleWindows = 0;
let zeroDisplayOutboundWindows = 0;
const vehicleMotion = new Map<string, { x: number; z: number; nodeId: string; lastMovedSec: number }>();

sim.start();
for (const vehicle of sim.getState().vehicles) {
  vehicleMotion.set(vehicle.id, {
    x: vehicle.x,
    z: vehicle.z,
    nodeId: vehicle.currentNodeId,
    lastMovedSec: sim.getState().simTimeSec
  });
}

while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
  const clock = sim.getClock();
  const state = sim.step(Math.min(dtSec, durationSec - clock.simTimeSec));
  updateVehicleMotion(state);

  if (state.kpis.deadlockCount > 0) {
    addAnomaly(state.simTimeSec, 'deadlock-count-positive', 'critical', String(state.kpis.deadlockCount));
  }
  if (state.kpis.livelockCount > 0) {
    addAnomaly(state.simTimeSec, 'livelock-count-positive', 'critical', String(state.kpis.livelockCount));
  }
  if (state.traffic.physicalViolationCount > 0) {
    addAnomaly(
      state.simTimeSec,
      'physical-violation-count-positive',
      'critical',
      String(state.traffic.physicalViolationCount)
    );
  }

  if (state.simTimeSec + 1e-9 >= nextSampleSec) {
    const completedTotal = state.kpis.completedInbound + state.kpis.completedOutbound;
    const activeVehicleStalls = activeVehicleStallSummaries(state);
    const displayOutboundPph = displayWindowOrAveragePph(
      state.kpis.windowOutboundPph,
      state.kpis.outboundPph,
      state.kpis.completedOutbound,
      state.kpis.pphWindowSec
    );
    const sample = {
      timeSec: round(state.simTimeSec),
      completedInbound: state.kpis.completedInbound,
      completedOutbound: state.kpis.completedOutbound,
      completedTotal,
      deltaCompleted: completedTotal - lastCompletedTotal,
      totalPph: round(state.kpis.totalPph, 3),
      outboundPph: round(state.kpis.outboundPph, 3),
      windowOutboundPph: round(state.kpis.windowOutboundPph, 3),
      displayOutboundPph: round(displayOutboundPph, 3),
      deadlocks: state.kpis.deadlockCount,
      livelocks: state.kpis.livelockCount,
      physicalViolations: state.traffic.physicalViolationCount,
      waitingVehicles: state.traffic.waitingVehicles.length,
      activeTasks: state.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed').length,
      activeVehicleStalls
    };
    samples.push(sample);
    console.log(JSON.stringify({ type: 'yellow-grid-liveness-sample', ...sample }));
    if (sample.timeSec > sampleSec && sample.deltaCompleted === 0 && (sample.activeTasks > 0 || sample.waitingVehicles > 0)) {
      stalledSampleWindows += 1;
      if (stalledSampleWindows > maxStalledSampleWindows) {
        addAnomaly(
          state.simTimeSec,
          'active-work-stalled',
          'critical',
          `deltaCompleted=0 for ${stalledSampleWindows} sample windows; activeTasks=${sample.activeTasks}; waitingVehicles=${sample.waitingVehicles}`
        );
      }
    } else if (sample.deltaCompleted > 0) {
      stalledSampleWindows = 0;
    }
    for (const stall of activeVehicleStalls) {
      addAnomaly(
        state.simTimeSec,
        'active-vehicle-stalled',
        'critical',
        `${stall.vehicleId} stillFor=${stall.stillForSec}s state=${stall.state} loaded=${stall.loaded} task=${stall.taskId ?? 'none'} node=${stall.currentNodeId} target=${stall.targetNodeId ?? 'none'}`
      );
    }
    if (state.kpis.completedOutbound > 0 && state.kpis.outboundPph > 0 && displayOutboundPph <= 0) {
      zeroDisplayOutboundWindows += 1;
      if (zeroDisplayOutboundWindows > maxZeroDisplayOutboundWindows) {
        addAnomaly(
          state.simTimeSec,
          'display-outbound-pph-zero-while-outbound-completed',
          'critical',
          `displayOutboundPph=0; outboundPph=${round(state.kpis.outboundPph, 3)}; completedOutbound=${state.kpis.completedOutbound}`
        );
      }
    } else if (displayOutboundPph > 0) {
      zeroDisplayOutboundWindows = 0;
    }
    lastCompletedTotal = completedTotal;
    nextSampleSec += sampleSec;
  }
}

const finalState = sim.getState();
if (finalState.status !== 'completed') {
  addAnomaly(finalState.simTimeSec, 'simulation-did-not-complete-duration', 'critical', finalState.status);
}
const activeTaskIds = new Set(
  finalState.tasks
    .filter((task) => task.state !== 'completed' && task.state !== 'failed')
    .map((task) => task.id)
);
const activeVehicleIds = new Set(
  finalState.vehicles
    .filter((vehicle) => vehicle.taskId !== null || vehicle.state === 'waiting-blocked')
    .map((vehicle) => vehicle.id)
);

const report = {
  schemaVersion: 'shuttle.yellowGridLivenessAudit.v1',
  scenarioId: scenario.id,
  scenarioHash: hashScenario(scenario),
  durationSec,
  dtSec,
  finalSimTimeSec: finalState.simTimeSec,
  status: finalState.status,
  purpose: [
    'long-run liveness check for gridlock/livelock/system stoppage',
    'does not replace the strict yellow-grid physical contract audit'
  ],
  assumptions: {
    initialStorageFillPolicy,
    storageSelectionPolicy
  },
  summary: {
    completedInbound: finalState.kpis.completedInbound,
    completedOutbound: finalState.kpis.completedOutbound,
    completedTotal: finalState.kpis.completedInbound + finalState.kpis.completedOutbound,
    totalPph: finalState.kpis.totalPph,
    deadlocks: finalState.kpis.deadlockCount,
    livelocks: finalState.kpis.livelockCount,
    physicalViolations: finalState.traffic.physicalViolationCount,
    anomalyCounts: countAnomalies(anomalies)
  },
  finalDiagnostics: {
    blockedTimeByReasonSec: finalState.kpis.blockedTimeByReasonSec,
    waitingVehicles: finalState.traffic.waitingVehicles,
    deadlockCandidateVehicleIds: finalState.traffic.deadlockCandidateVehicleIds,
    activeVehicleStalls: activeVehicleStallSummaries(finalState),
    activeTasks: finalState.tasks
      .filter((task) => task.state !== 'completed' && task.state !== 'failed')
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        state: task.state,
        loadId: task.loadId,
        pickupNodeId: task.pickupNodeId,
        dropoffNodeId: task.dropoffNodeId,
        liftPortNodeId: task.liftPortNodeId ?? null,
        vehicleId: task.vehicleId
      })),
    vehicles: finalState.vehicles.map((vehicle) => ({
      id: vehicle.id,
      state: vehicle.state,
      loaded: vehicle.loaded,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      currentEdgeId: vehicle.currentEdgeId,
      loadId: vehicle.loadId,
      taskId: vehicle.taskId,
      routeNodeIds: vehicle.routeNodeIds
    })),
    activeVehicleEvents: sim.getEventLog().filter((event) =>
      (event.vehicleId !== null && activeVehicleIds.has(event.vehicleId)) ||
      (event.taskId !== null && activeTaskIds.has(event.taskId))
    ),
    recentEvents: sim.getEventLog().slice(-250)
  },
  samples,
  anomalies
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ type: 'yellow-grid-liveness-complete', outputPath, anomalies: anomalies.length }, null, 2));

if (anomalies.some((anomaly) => anomaly.severity === 'critical')) {
  process.exitCode = 1;
}

function addAnomaly(timeSec: number, code: string, severity: LivenessAnomaly['severity'], detail: string): void {
  if (anomalies.some((anomaly) => anomaly.code === code && anomaly.detail === detail)) return;
  anomalies.push({
    timeSec: round(timeSec),
    code,
    severity,
    detail
  });
}

function updateVehicleMotion(state: ReturnType<ShuttleSimCore['getState']>): void {
  for (const vehicle of state.vehicles) {
    const previous = vehicleMotion.get(vehicle.id);
    if (
      !previous ||
      previous.nodeId !== vehicle.currentNodeId ||
      Math.hypot(previous.x - vehicle.x, previous.z - vehicle.z) > 0.02
    ) {
      vehicleMotion.set(vehicle.id, {
        x: vehicle.x,
        z: vehicle.z,
        nodeId: vehicle.currentNodeId,
        lastMovedSec: state.simTimeSec
      });
    }
  }
}

function activeVehicleStallSummaries(state: ReturnType<ShuttleSimCore['getState']>): Array<{
  vehicleId: string;
  stillForSec: number;
  state: string;
  loaded: boolean;
  taskId: string | null;
  currentNodeId: string;
  targetNodeId: string | null;
}> {
  return state.vehicles
    .filter((vehicle) => vehicle.taskId !== null || vehicle.loaded || vehicle.targetNodeId !== null)
    .map((vehicle) => {
      const motion = vehicleMotion.get(vehicle.id);
      return {
        vehicleId: vehicle.id,
        stillForSec: round(state.simTimeSec - (motion?.lastMovedSec ?? state.simTimeSec), 3),
        state: vehicle.state,
        loaded: vehicle.loaded,
        taskId: vehicle.taskId,
        currentNodeId: vehicle.currentNodeId,
        targetNodeId: vehicle.targetNodeId
      };
    })
    .filter((vehicle) => vehicle.stillForSec >= maxActiveVehicleStillSec);
}

function displayWindowOrAveragePph(windowPph: number, averagePph: number, completedCount: number, windowSec: number): number {
  if (windowSec <= 0) {
    return averagePph;
  }
  if (windowPph <= 0 && averagePph > 0 && completedCount > 0) {
    return averagePph;
  }
  return windowPph;
}

function countAnomalies(items: LivenessAnomaly[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.code] = (counts[item.code] ?? 0) + 1;
  }
  return counts;
}

function numberArg(flag: string, fallback: number): number {
  const raw = stringArg(flag);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function integerArg(flag: string, fallback: number): number {
  const parsed = numberArg(flag, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function stringArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function enumArg<T extends readonly string[]>(flag: string, values: T, fallback: T[number]): T[number] {
  const value = stringArg(flag);
  return values.includes(value ?? '') ? value as T[number] : fallback;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
