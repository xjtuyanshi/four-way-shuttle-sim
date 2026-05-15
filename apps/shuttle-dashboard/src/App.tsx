import { lazy, Suspense, useEffect, useMemo, useRef, useState, useTransition, type MouseEvent } from 'react';

import type {
  EventLogEntry,
  KpiSnapshot,
  ShuttleScenario,
  ShuttleSimState,
  ShuttleStreamMessage,
  VehicleState
} from '@four-way-shuttle/schemas';
import {
  summarizeScenarioStaticSceneContract,
  type ShuttleStaticSceneCalibrationReadiness
} from '@four-way-shuttle/sim-core/static-scene';
import type { ShuttleSceneCameraView, ShuttleSceneRendererInfo } from './ShuttleScene3D.js';

const ShuttleScene3D = lazy(() =>
  import('./ShuttleScene3D.js').then((module) => ({ default: module.ShuttleScene3D }))
);

type PrerequisiteReport = {
  checkedAt: string;
  host: {
    modelName: string | null;
    modelIdentifier: string | null;
    chip: string | null;
    memory: string | null;
    metalSupport: string | null;
    macos: string | null;
  };
  unreal: {
    installedCandidates: string[];
    preferredVersion: '5.7.4';
    status: 'ready' | 'blocked';
    notes: string[];
  };
  xcode: {
    developerDir: string | null;
    version: string | null;
    status: 'ready' | 'blocked';
    notes: string[];
  };
  pixelStreaming: {
    status: 'pending-unreal' | 'ready';
    notes: string[];
  };
};

type CommandStatus = {
  label: string;
  tone: 'idle' | 'ok' | 'warn' | 'error';
};

type PlaybackSpeedResponse = {
  speed: number;
};

type LiveStreamSnapshot = {
  simTimeSec: number;
  vehicles: VehicleState[] | null;
  kpis: KpiSnapshot | null;
};

type MapViewMode = '3d' | 'lite' | '2d';

type BottleneckBreakdown = Record<string, number>;

type Phase0ValidationRun = {
  seed: number;
  durationSec: number;
  status: string;
  eventLogHash: string;
  eventCount: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  inboundPph: number;
  outboundPph: number;
  theoreticalFleetPph: number | null;
  theoreticalSingleShuttlePph: number | null;
  theoreticalIdealCycleSec: number | null;
  theoreticalLiftAndLowerSec: number | null;
  achievedInboundVsTheoryPct: number | null;
  inboundPphGapToTheory: number | null;
  averageVehicleUtilizationPct: number;
  averageVehicleProductivePct: number;
  averageVehicleWaitingPct: number;
  averageVehicleIdlePct: number;
  queuedTasks: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
  blockedTimeByReasonSec: Record<string, number>;
  blockedTimeByCategorySec?: BottleneckBreakdown;
  reservationConflictCount: number;
  deadlockCount: number;
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationCount: number;
};

type Phase0StressScenarioResult = {
  id: string;
  label: string;
  durationSec: number;
  seeds: number[];
  requestedTotalPph: number;
  requiresPositiveThroughput: boolean;
  totalPphMean: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
  observedBottleneckReasons: string[];
  blockedTimeByCategorySec?: BottleneckBreakdown;
  theoreticalFleetPphMean: number | null;
  achievedInboundVsTheoryPctMean: number | null;
  inboundPphGapToTheoryMean: number | null;
  averageVehicleUtilizationPctMean: number;
  averageVehicleProductivePctMean: number;
  averageVehicleWaitingPctMean: number;
  averageVehicleIdlePctMean: number;
  pass: boolean;
};

type Phase0ValidationResult = {
  checkedAt: string;
  scenarioId: string;
  layoutCalibrationReadiness?: ShuttleStaticSceneCalibrationReadiness;
  deterministic: {
    seed: number;
    repeatCount: number;
    pass: boolean;
    hashes: string[];
  };
  seedSweep: {
    seeds: number[];
    durationSec: number;
    runs: Phase0ValidationRun[];
    totalPphMean: number;
    totalPphMin: number;
    totalPphMax: number;
    totalPphRange: number;
  };
  longRun?: {
    seeds: number[];
    durationSec: number;
    runs: Phase0ValidationRun[];
    thresholds?: {
      minTotalPph: number;
      minInboundPph?: number;
      minOutboundPph?: number;
      maxQueuedTasks: number;
      maxWaitingVehicles: number;
      maxLiftPortQueueLength: number;
    };
    totalPphMean: number;
    maxQueuedTasks: number;
    maxWaitingVehicles: number;
    maxLiftPortQueueLength: number;
    blockedTimeByCategorySec?: BottleneckBreakdown;
  };
  stress?: {
    durationSec: number;
    seeds: number[];
    scenarios: Phase0StressScenarioResult[];
    pass: boolean;
    noStressDeadlocks: boolean;
    noStressPhysicalSafetyViolations: boolean;
    noStressReservationCoverageViolations: boolean;
    expectedBottlenecksObserved: boolean;
    positiveThroughputWhereRequired: boolean;
    blockedTimeByCategorySec?: BottleneckBreakdown;
  };
  acceptance: {
    sameSeedEventHashStable: boolean;
    noDeadlocksInSweep: boolean;
    eventLogsPresent: boolean;
    noPhysicalSafetyViolations: boolean;
    noReservationCoverageViolations: boolean;
    longRunEventLogsPresent?: boolean;
    longRunThroughputPositive?: boolean;
    longRunThroughputFloorMet?: boolean;
    longRunQueuesBounded?: boolean;
    noLongRunDeadlocks?: boolean;
    noLongRunPhysicalSafetyViolations?: boolean;
    noLongRunReservationCoverageViolations?: boolean;
    stressPass?: boolean;
    noStressDeadlocks?: boolean;
    noStressPhysicalSafetyViolations?: boolean;
    noStressReservationCoverageViolations?: boolean;
    expectedStressBottlenecksObserved?: boolean;
    positiveStressThroughputWhereRequired?: boolean;
    flowDebugObservationPass?: boolean;
    segmentSafeValidationPass?: boolean;
    ieValidationPass?: boolean;
    physicalSafetyPass?: boolean;
    stressPhysicalSafetyPass?: boolean;
    pass: boolean;
  };
};

type SceneLayers = {
  traffic: boolean;
  physics: boolean;
  loads: boolean;
  routes: boolean;
};

type ResourceUtilizationSummary = {
  storage: {
    totalCells: number;
    usedCells: number;
    storedCells: number;
    reservedInboundCells: number;
    utilizationPct: number;
  };
  shuttles: {
    total: number;
    active: number;
    idle: number;
    averageUtilizationPct: number;
    peakUtilizationPct: number;
    averageProductivePct: number;
    averageWaitingPct: number;
    averageIdlePct: number;
    averageTasklessTravelPct: number;
  };
  lifts: {
    total: number;
    active: number;
    approachOccupied: number;
    approachCapacity: number;
    inboundEnabled: number;
    outboundEnabled: number;
    queuedTasks: number;
    averageUtilizationPct: number;
    inboundAverageUtilizationPct: number;
    outboundAverageUtilizationPct: number;
  };
};

const COLLISION_AVOIDANCE_PARAM = '/trafficPolicy/collisionAvoidanceEnabled';

const CONTROLLED_PARAMS = [
  {
    label: 'Shuttle count',
    path: '/vehicles/count',
    min: 1,
    max: 32,
    step: 1,
    unit: 'units'
  },
  {
    label: 'Loaded speed',
    path: '/physicsParams/loadedSpeedMps',
    min: 0.4,
    max: 2.2,
    step: 0.05,
    unit: 'm/s'
  },
  {
    label: 'Empty speed',
    path: '/physicsParams/emptySpeedMps',
    min: 0.4,
    max: 2.6,
    step: 0.05,
    unit: 'm/s'
  },
  {
    label: 'Lift time',
    path: '/physicsParams/liftTimeSec',
    min: 0,
    max: 1,
    step: 0.01,
    unit: 's'
  },
  {
    label: 'Lower time',
    path: '/physicsParams/lowerTimeSec',
    min: 0,
    max: 1,
    step: 0.01,
    unit: 's'
  },
  {
    label: 'Lift approach',
    path: '/trafficPolicy/liftApproachCapacity',
    min: 1,
    max: 8,
    step: 1,
    unit: 'slots'
  },
  {
    label: 'Inbound rate',
    path: '/taskGeneration/inboundRatePerHour',
    min: 0,
    max: 7200,
    step: 1,
    unit: 'PPH'
  },
  {
    label: 'Outbound rate',
    path: '/taskGeneration/outboundRatePerHour',
    min: 0,
    max: 7200,
    step: 1,
    unit: 'PPH'
  }
] as const;

const PLAYBACK_SPEEDS = [1, 2, 4, 10] as const;
const API_BASE_URL = import.meta.env.VITE_SHUTTLE_API_TARGET?.replace(/\/$/, '') ?? '';
const DEFAULT_SCENE_CAMERA_VIEW: ShuttleSceneCameraView = {
  zoom: 1,
  yawOffsetRad: 0,
  pitchOffsetRad: 0
};

function clampSceneCameraView(view: ShuttleSceneCameraView): ShuttleSceneCameraView {
  return {
    zoom: Math.min(4, Math.max(0.45, view.zoom)),
    yawOffsetRad: view.yawOffsetRad,
    pitchOffsetRad: Math.min(0.78, Math.max(-0.78, view.pitchOffsetRad))
  };
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const target = typeof input === 'string' && input.startsWith('/') && API_BASE_URL
    ? `${API_BASE_URL}${input}`
    : input;
  const response = await fetch(target, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatNumber(value: number, digits = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

const BOTTLENECK_LABELS: Record<string, string> = {
  storageInventory: 'storage',
  fifoLane: 'FIFO lane',
  sideAisleNetwork: 'side aisle',
  liftPort: 'lift',
  vehicleFleet: 'shuttle fleet',
  reservationControl: 'reservation',
  other: 'other'
};

function topBottleneckCategory(breakdown: BottleneckBreakdown | null | undefined): { category: string; seconds: number } | null {
  let top: { category: string; seconds: number } | null = null;
  for (const [category, seconds] of Object.entries(breakdown ?? {})) {
    if (seconds <= 0) continue;
    if (!top || seconds > top.seconds) {
      top = { category, seconds };
    }
  }
  return top;
}

function formatBottleneckCategory(top: { category: string; seconds: number } | null): string {
  if (!top) return '--';
  return `${BOTTLENECK_LABELS[top.category] ?? top.category} ${formatNumber(top.seconds, 1)}s`;
}

function formatBlockedReason(reason: string): string {
  if (reason === 'avoidance-clearance') return 'close-range avoidance';
  if (reason.includes('lift-approach-full')) return 'lift approach';
  if (reason.includes('lift-busy')) return 'lift/portal';
  if (reason.startsWith('fifo-lane-busy:')) return reason.replace('fifo-lane-busy:', 'FIFO ');
  if (reason.startsWith('fifo-left-network')) return 'left FIFO network';
  if (reason.startsWith('storage-')) return reason.replace('storage-', 'storage ');
  if (reason.includes('zone')) return 'portal zone';
  if (reason.includes('node')) return 'node occupancy';
  if (reason.includes('edge')) return 'edge reservation';
  return reason;
}

function formatVehicleState(state: VehicleState['state']): string {
  const labels: Record<VehicleState['state'], string> = {
    idle: 'idle/no task',
    assigned: 'assigned',
    'moving-to-pickup': 'to pickup',
    'aligning-under-load': 'aligning',
    lifting: 'lifting',
    'loaded-moving': 'loaded to dropoff',
    lowering: 'lowering',
    returning: 'returning',
    parking: 'parking',
    'waiting-blocked': 'traffic hold',
    charging: 'charging',
    faulted: 'faulted'
  };
  return labels[state] ?? state;
}

function getPointerValue(source: unknown, pointer: string): unknown {
  const parts = pointer.split('/').slice(1);
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function websocketUrl(): string {
  if (API_BASE_URL) {
    return `${API_BASE_URL.replace(/^http/, 'ws')}/shuttle-ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/shuttle-ws`;
}

function mergeEvents(previous: EventLogEntry[], next: EventLogEntry[]): EventLogEntry[] {
  const bySequence = new Map<number, EventLogEntry>();
  for (const event of [...previous, ...next]) {
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-80);
}

export function mergeVehicleStateUpdate(
  previous: ShuttleSimState | null,
  vehicles: VehicleState[],
  simTimeSec: number
): ShuttleSimState | null {
  if (!previous) {
    return previous;
  }
  if (previous.simTimeSec > simTimeSec) {
    return previous;
  }
  const incomingById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const existingIds = new Set(previous.vehicles.map((vehicle) => vehicle.id));
  const nextVehicles = previous.vehicles.map((vehicle) => incomingById.get(vehicle.id) ?? vehicle);
  for (const vehicle of vehicles) {
    if (!existingIds.has(vehicle.id)) {
      nextVehicles.push(vehicle);
    }
  }
  return {
    ...previous,
    simTimeSec,
    vehicles: nextVehicles
  };
}

export function mergeKpiUpdate(
  previous: ShuttleSimState | null,
  kpis: KpiSnapshot,
  simTimeSec: number
): ShuttleSimState | null {
  if (!previous) {
    return previous;
  }
  if (previous.simTimeSec > simTimeSec) {
    return previous;
  }
  return {
    ...previous,
    simTimeSec,
    kpis
  };
}

export function shouldResetAfterParamUpdate(path: string, status: ShuttleSimState['status'] | null | undefined): boolean {
  return (
    path === '/vehicles/count' ||
    path === '/trafficPolicy/liftApproachCapacity' ||
    path === COLLISION_AVOIDANCE_PARAM ||
    path.startsWith('/taskGeneration/') ||
    status === 'completed'
  );
}

export function shouldResumeAfterParamUpdate(path: string, status: ShuttleSimState['status'] | null | undefined): boolean {
  return shouldResetAfterParamUpdate(path, status) && (status === 'running' || status === 'completed');
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function isAxisAlignedSegment(from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const tolerance = 1e-6;
  return Math.abs(from.x - to.x) <= tolerance || Math.abs(from.z - to.z) <= tolerance;
}

function remainingRouteNodeIds(vehicle: VehicleState, preferredNodeIds: string[]): string[] {
  const fallback = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
  const source = preferredNodeIds.length >= 2 ? preferredNodeIds : fallback;
  if (source.length < 2) {
    return source;
  }

  if (vehicle.currentEdgeId && vehicle.targetNodeId) {
    const targetIndex = source.indexOf(vehicle.targetNodeId);
    if (targetIndex >= 0) {
      return [vehicle.currentNodeId, ...source.slice(targetIndex)];
    }
  }

  const currentIndex = source.indexOf(vehicle.currentNodeId);
  if (currentIndex >= 0) {
    return source.slice(currentIndex);
  }

  return fallback.length >= 2 ? fallback : source;
}

export function summarizeResourceUtilization(
  scenario: ShuttleScenario | null,
  state: ShuttleSimState | null
): ResourceUtilizationSummary {
  const storageNodeIds = new Set((scenario?.layout.nodes ?? [])
    .filter((node) => node.type === 'storage')
    .map((node) => node.id));
  const activeTasks = state?.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed') ?? [];
  const storedNodeIds = new Set(
    (state?.loads ?? [])
      .filter((load) => load.state === 'stored' && load.nodeId && storageNodeIds.has(load.nodeId))
      .map((load) => load.nodeId!)
  );
  const reservedInboundNodeIds = new Set(
    activeTasks
      .filter((task) => task.kind === 'inbound' && storageNodeIds.has(task.dropoffNodeId))
      .map((task) => task.dropoffNodeId)
  );
  const usedStorageNodeIds = new Set([...storedNodeIds, ...reservedInboundNodeIds]);
  const vehicles = state?.vehicles ?? [];
  const utilizationByVehicle = state?.kpis.vehicleUtilization ?? {};
  const vehicleUtilizationValues = vehicles.map((vehicle) => utilizationByVehicle[vehicle.id] ?? 0);
  const utilizationBreakdownByVehicle = state?.kpis.vehicleUtilizationBreakdown ?? {};
  const vehicleBreakdowns = vehicles.map((vehicle) => utilizationBreakdownByVehicle[vehicle.id]);
  const liftPorts = state?.traffic.liftPorts ?? [];
  const liftUtilizationValues = liftPorts.map((port) => port.utilization);
  const inboundLiftUtilizationValues = liftPorts.filter((port) => port.kind === 'inbound').map((port) => port.utilization);
  const outboundLiftUtilizationValues = liftPorts.filter((port) => port.kind === 'outbound').map((port) => port.utilization);

  return {
    storage: {
      totalCells: storageNodeIds.size,
      usedCells: usedStorageNodeIds.size,
      storedCells: storedNodeIds.size,
      reservedInboundCells: reservedInboundNodeIds.size,
      utilizationPct: percent(usedStorageNodeIds.size, storageNodeIds.size)
    },
    shuttles: {
      total: vehicles.length,
      active: vehicles.filter((vehicle) => vehicle.state !== 'idle' || vehicle.taskId !== null).length,
      idle: vehicles.filter((vehicle) => vehicle.state === 'idle' && vehicle.taskId === null).length,
      averageUtilizationPct: average(vehicleUtilizationValues) * 100,
      peakUtilizationPct: Math.max(0, ...vehicleUtilizationValues) * 100,
      averageProductivePct: average(vehicleBreakdowns.map((breakdown) => breakdown?.productive ?? 0)) * 100,
      averageWaitingPct: average(vehicleBreakdowns.map((breakdown) => breakdown?.waiting ?? 0)) * 100,
      averageIdlePct: average(vehicleBreakdowns.map((breakdown) => breakdown?.idle ?? 0)) * 100,
      averageTasklessTravelPct: average(vehicleBreakdowns.map((breakdown) => breakdown?.tasklessTravel ?? 0)) * 100
    },
    lifts: {
      total: liftPorts.length,
      active: liftPorts.filter((port) => port.activeTaskId).length,
      approachOccupied: liftPorts.reduce((sum, port) => sum + (port.approachOccupancy ?? 0), 0),
      approachCapacity: liftPorts.reduce((sum, port) => sum + (port.approachCapacity ?? 1), 0),
      inboundEnabled: liftPorts.filter((port) => port.kind === 'inbound').length,
      outboundEnabled: liftPorts.filter((port) => port.kind === 'outbound').length,
      queuedTasks: liftPorts.reduce((sum, port) => sum + port.queueLength, 0),
      averageUtilizationPct: average(liftUtilizationValues) * 100,
      inboundAverageUtilizationPct: average(inboundLiftUtilizationValues) * 100,
      outboundAverageUtilizationPct: average(outboundLiftUtilizationValues) * 100
    }
  };
}

function KpiStrip({ kpis }: { kpis: KpiSnapshot | null }) {
  const averageUtilizationPct = kpis
    ? average(Object.values(kpis.vehicleUtilization)) * 100
    : 0;
  const utilizationBreakdowns = kpis ? Object.values(kpis.vehicleUtilizationBreakdown) : [];
  const averageWaitingPct = average(utilizationBreakdowns.map((breakdown) => breakdown.waiting)) * 100;
  const items = [
    ['Total PPH', kpis ? formatNumber(kpis.totalPph, 1) : '--'],
    ['Inbound PPH', kpis ? formatNumber(kpis.inboundPph, 1) : '--'],
    ['Active / queued', kpis ? `${kpis.activeTasks} / ${kpis.queuedTasks}` : '--'],
    ['Task assign wait', kpis ? `${formatNumber(kpis.averageTaskWaitSec, 1)}s` : '--'],
    ['Util / traffic hold', kpis ? `${formatNumber(averageUtilizationPct, 1)}% / ${formatNumber(averageWaitingPct, 1)}%` : '--'],
    ['Deadlocks', kpis ? String(kpis.deadlockCount) : '--']
  ];

  return (
    <section className="kpi-strip" aria-label="KPI summary">
      {items.map(([label, value]) => (
        <div className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function CapacityTheoryPanel({ kpis }: { kpis: KpiSnapshot | null }) {
  const theory = kpis?.theoreticalCapacity;
  const inboundGapPph = theory ? Math.max(0, theory.fleetPph - kpis.inboundPph) : 0;

  return (
    <section className="capacity-panel" aria-label="Theoretical capacity">
      <div>
        <span>Ideal / shuttle</span>
        <strong>{theory ? formatNumber(theory.singleShuttlePph, 1) : '--'} PPH</strong>
        <small>{theory ? `${formatNumber(theory.idealCycleSec, 1)}s avg cycle` : 'inbound ideal'}</small>
      </div>
      <div>
        <span>Fleet theory</span>
        <strong>{theory ? formatNumber(theory.fleetPph, 1) : '--'} PPH</strong>
        <small>{theory ? `${theory.shuttleCount} shuttles, no traffic hold` : 'same layout'}</small>
      </div>
      <div>
        <span>Actual vs theory</span>
        <strong>{theory ? `${formatNumber(theory.achievedInboundPct, 1)}%` : '--'}</strong>
        <small>{theory ? `${formatNumber(inboundGapPph, 1)} PPH gap` : 'needs running state'}</small>
      </div>
      <div>
        <span>Cycle split</span>
        <strong>{theory ? `${formatNumber(theory.loadedTravelSec, 1)}s / ${formatNumber(theory.emptyReturnSec, 1)}s` : '--'}</strong>
        <small>{theory ? `lift+lower ${formatNumber(theory.liftAndLowerSec, 2)}s, util ${formatNumber(theory.averageVehicleUtilizationPct, 1)}%` : 'loaded / empty'}</small>
      </div>
    </section>
  );
}

function ResourceUtilizationPanel({ scenario, state }: { scenario: ShuttleScenario | null; state: ShuttleSimState | null }) {
  const summary = useMemo(() => summarizeResourceUtilization(scenario, state), [scenario, state]);
  const liftTiming = scenario?.physicsParams;
  const items = [
    {
      label: 'Storage capacity',
      value: `${formatNumber(summary.storage.utilizationPct, 1)}%`,
      detail: `${summary.storage.usedCells}/${summary.storage.totalCells} cells, ${summary.storage.reservedInboundCells} reserved`
    },
    {
      label: 'Shuttle utilization',
      value: `${summary.shuttles.active}/${summary.shuttles.total}`,
      detail: `busy ${formatNumber(summary.shuttles.averageUtilizationPct, 1)}%, productive ${formatNumber(summary.shuttles.averageProductivePct, 1)}%, traffic hold ${formatNumber(summary.shuttles.averageWaitingPct, 1)}%`
    },
    {
      label: 'Shuttle idle/standby',
      value: `${formatNumber(summary.shuttles.averageIdlePct, 1)}%`,
      detail: `taskless travel ${formatNumber(summary.shuttles.averageTasklessTravelPct, 1)}%, peak busy ${formatNumber(summary.shuttles.peakUtilizationPct, 1)}%`
    },
    {
      label: 'Lift approach slots',
      value: `${summary.lifts.approachOccupied}/${summary.lifts.approachCapacity}`,
      detail: `${summary.lifts.inboundEnabled} inbound / ${summary.lifts.outboundEnabled} outbound enabled`
    },
    {
      label: 'Lift cycle active',
      value: `${summary.lifts.active}/${summary.lifts.total}`,
      detail: `avg cycle ${formatNumber(summary.lifts.averageUtilizationPct, 1)}%, q${summary.lifts.queuedTasks}`
    },
    {
      label: 'Lift cycle',
      value: liftTiming ? `${formatNumber(liftTiming.liftTimeSec, 2)}s` : '--',
      detail: liftTiming ? `lower ${formatNumber(liftTiming.lowerTimeSec, 2)}s` : 'loading'
    }
  ];

  return (
    <section className="resource-panel" aria-label="Resource utilization">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.detail}</small>
        </div>
      ))}
    </section>
  );
}

function VehicleTable({
  vehicles,
  selectedVehicleId,
  onSelectVehicle
}: {
  vehicles: VehicleState[];
  selectedVehicleId: string | null;
  onSelectVehicle: (vehicleId: string) => void;
}) {
  const routeLabel = (vehicle: VehicleState) => {
    const plannedLegs = Math.max(0, vehicle.plannedRouteNodeIds.length - 1);
    const localLegs = Math.max(0, vehicle.localRouteNodeIds.length - 1);
    return localLegs > 0 ? `local ${localLegs} / plan ${plannedLegs}` : plannedLegs > 0 ? `${plannedLegs} legs` : '--';
  };

  return (
    <section className="panel vehicle-panel">
      <div className="panel-head">
        <h2>Vehicle State</h2>
        <span>{vehicles.length} units</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>State</th>
              <th>Node</th>
              <th>Target</th>
              <th>Goal</th>
              <th>Path</th>
              <th>Speed</th>
              <th>Hold reason</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((vehicle) => (
              <tr
                className={selectedVehicleId === vehicle.id ? 'selected' : ''}
                key={vehicle.id}
                onClick={() => onSelectVehicle(vehicle.id)}
              >
                <td>{vehicle.id}</td>
                <td><span className={`state-pill ${vehicle.state}`}>{formatVehicleState(vehicle.state)}</span></td>
                <td>{vehicle.currentNodeId}</td>
                <td>{vehicle.targetNodeId ?? '--'}</td>
                <td>{vehicle.plannedGoalNodeId ?? '--'}</td>
                <td className={vehicle.localRouteNodeIds.length > 0 ? 'route-local' : ''}>{routeLabel(vehicle)}</td>
                <td>{vehicle.speedMps.toFixed(2)}</td>
                <td>{vehicle.waitReason ? formatBlockedReason(vehicle.waitReason) : vehicle.blockingVehicleId ?? vehicle.blockingReservationId ?? '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EventLog({ events }: { events: EventLogEntry[] }) {
  return (
    <section className="panel event-panel">
      <div className="panel-head">
        <h2>Event Log</h2>
        <span>latest {events.length}</span>
      </div>
      <div className="event-list">
        {[...events].slice(-18).reverse().map((event) => (
          <div className="event-row" key={event.sequence}>
            <time>{event.timeSec.toFixed(1)}s</time>
            <strong>{event.eventType}</strong>
            <span>{event.vehicleId ?? event.taskId ?? 'system'}</span>
            <small>{event.reason ?? ''}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatStorageCellLabel(nodeId: string): string {
  const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
  if (match) {
    return `R${Number(match[1])} C${Number(match[2])}`;
  }
  return nodeId.replace('storage-', '').toUpperCase();
}

function formatStoragePolicy(policy: string): string {
  return policy === 'rowContiguousLaneFill' ? 'row-contiguous lane-fill' : policy;
}

function formatStorageFlow(flow: string): string {
  if (flow === 'rightToLeft') return 'right-to-left';
  if (flow === 'leftPick') return 'left pick';
  return flow;
}

function vehicleDisplayNumber(vehicleId: string): string {
  const ordinal = Number(vehicleId.replace(/\D+/g, ''));
  return Number.isFinite(ordinal) && ordinal > 0 ? String(ordinal) : vehicleId.replace(/^SH-?/i, '');
}

function AuthoritativeMap({
  scenario,
  state,
  layers,
  selectedVehicleId,
  onSelectVehicle
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: SceneLayers;
  selectedVehicleId: string | null;
  onSelectVehicle: (vehicleId: string) => void;
}) {
  const geometry = useMemo(() => {
    const nodes = scenario?.layout.nodes ?? [];
    const xValues = nodes.map((node) => node.x);
    const zValues = nodes.map((node) => node.z);
    const minX = Math.min(...xValues, 0) - 2;
    const maxX = Math.max(...xValues, 1) + 2;
    const minZ = Math.min(...zValues, -1) - 2;
    const maxZ = Math.max(...zValues, 1) + 2;
    const width = Math.max(1, maxX - minX);
    const depth = Math.max(1, maxZ - minZ);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));

    const project = (point: { x: number; z: number }) => ({
      left: `${((point.x - minX) / width) * 100}%`,
      top: `${(1 - (point.z - minZ) / depth) * 100}%`
    });

    const routeSegmentStyle = (from: { x: number; z: number }, to: { x: number; z: number }) => {
      const fromPoint = project(from);
      const toPoint = project(to);
      const left = parseFloat(fromPoint.left);
      const top = parseFloat(fromPoint.top);
      const dx = parseFloat(toPoint.left) - left;
      const dy = parseFloat(toPoint.top) - top;
      return {
        left: fromPoint.left,
        top: fromPoint.top,
        width: `${Math.hypot(dx, dy)}%`,
        transform: `rotate(${Math.atan2(dy, dx)}rad)`
      };
    };

    return { nodes, nodeMap, edges: scenario?.layout.edges ?? [], project, routeSegmentStyle };
  }, [scenario]);

  const loads = state?.loads.filter((load) => load.nodeId && load.state !== 'carried') ?? [];
  const activeReservations = state?.reservations ?? [];
  const activeTasks = state?.tasks.filter((task) => task.vehicleId && task.state !== 'completed' && task.state !== 'failed') ?? [];
  const vehicleById = new Map((state?.vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const routeSegments = (vehicle: VehicleState, nodeIds: string[], kind: 'planned' | 'local') => {
    if (nodeIds.length < 2) {
      return [];
    }
    const points = [
      { x: vehicle.x, z: vehicle.z },
      ...nodeIds.slice(1).map((nodeId) => geometry.nodeMap.get(nodeId)).filter((node): node is ShuttleScenario['layout']['nodes'][number] => Boolean(node))
    ];
    return points.slice(1)
      .map((to, index) => ({
        key: `${vehicle.id}-${kind}-${index}`,
        vehicle,
        kind,
        from: points[index]!,
        to
      }))
      .filter((segment) => isAxisAlignedSegment(segment.from, segment.to));
  };

  return (
    <div className="authoritative-map" aria-label="Authoritative state map">
      {geometry.edges.map((edge) => {
        const from = geometry.nodeMap.get(edge.from);
        const to = geometry.nodeMap.get(edge.to);
        if (!from || !to) return null;
        const reserved = layers.traffic && activeReservations.some((reservation) => reservation.resourceId === edge.id);
        return (
          <span
            className={`map-edge ${reserved ? 'reserved' : ''}`}
            key={edge.id}
            style={geometry.routeSegmentStyle(from, to)}
          />
        );
      })}
      {layers.routes && (state?.vehicles ?? [])
        .flatMap((vehicle) => [
          ...routeSegments(vehicle, remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds), 'planned'),
          ...routeSegments(vehicle, vehicle.localRouteNodeIds, 'local')
        ])
        .map((segment) => (
          <span
            className={`map-route ${segment.kind} ${segment.vehicle.loaded ? 'loaded' : 'empty'} ${segment.vehicle.taskId ? 'tasked' : 'taskless'} ${selectedVehicleId === segment.vehicle.id ? 'selected' : ''}`}
            key={segment.key}
            style={geometry.routeSegmentStyle(segment.from, segment.to)}
          />
        ))}
      {geometry.nodes.map((node) => (
        <span className={`map-node ${node.type}`} key={node.id} style={geometry.project(node)}>
          {node.type === 'storage' ? '' : node.id.replace('inbound-lift-', 'in-').replace('outbound-lift-', 'out-')}
        </span>
      ))}
      {layers.loads && loads.map((load) => {
        const node = load.nodeId ? geometry.nodeMap.get(load.nodeId) : null;
        return node ? <span className={`map-load ${load.state}`} key={load.id} style={geometry.project(node)} /> : null;
      })}
      {activeTasks.map((task) => {
        const vehicle = task.vehicleId ? vehicleById.get(task.vehicleId) : null;
        const pickupNode = geometry.nodeMap.get(task.pickupNodeId);
        if (!vehicle || !pickupNode || vehicle.loaded) {
          return null;
        }
        return (
          <span className="map-task-badge pickup" key={task.id} style={geometry.project(pickupNode)}>
            {vehicleDisplayNumber(vehicle.id)}
          </span>
        );
      })}
      {(state?.vehicles ?? []).map((vehicle) => (
        <button
          className={`map-vehicle ${vehicle.state} ${vehicle.loaded ? 'loaded' : 'empty'} ${vehicle.taskId ? 'tasked' : 'taskless'} ${selectedVehicleId === vehicle.id ? 'selected' : ''}`}
          key={vehicle.id}
          type="button"
          onClick={() => onSelectVehicle(vehicle.id)}
          style={{
            ...geometry.project(vehicle),
            transform: 'translate(-50%, -50%)'
          }}
          title={`${vehicle.id} ${vehicle.loaded ? 'loaded' : vehicle.taskId ? 'to pickup' : 'available'} ${vehicle.currentNodeId}`}
        >
          {vehicleDisplayNumber(vehicle.id)}
        </button>
      ))}
    </div>
  );
}

function CanvasLiteMap({
  scenario,
  state,
  layers,
  selectedVehicleId,
  onSelectVehicle
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: SceneLayers;
  selectedVehicleId: string | null;
  onSelectVehicle: (vehicleId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geometry = useMemo(() => {
    const nodes = scenario?.layout.nodes ?? [];
    const xValues = nodes.map((node) => node.x);
    const zValues = nodes.map((node) => node.z);
    const minX = Math.min(...xValues, 0) - 2;
    const maxX = Math.max(...xValues, 1) + 2;
    const minZ = Math.min(...zValues, -1) - 2;
    const maxZ = Math.max(...zValues, 1) + 2;
    return {
      nodes,
      edges: scenario?.layout.edges ?? [],
      nodeMap: new Map(nodes.map((node) => [node.id, node])),
      minX,
      maxX,
      minZ,
      maxZ,
      width: Math.max(1, maxX - minX),
      depth: Math.max(1, maxZ - minZ)
    };
  }, [scenario]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const padding = 16;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#f5f7f8';
      context.fillRect(0, 0, width, height);

      context.strokeStyle = '#e3e8eb';
      context.lineWidth = 1;
      for (let x = 0; x <= width; x += 42) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = 0; y <= height; y += 42) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }

      const project = (point: { x: number; z: number }) => ({
        x: padding + ((point.x - geometry.minX) / geometry.width) * (width - padding * 2),
        y: height - padding - ((point.z - geometry.minZ) / geometry.depth) * (height - padding * 2)
      });

      const drawLine = (from: { x: number; z: number }, to: { x: number; z: number }, color: string, lineWidth: number, alpha = 1) => {
        const a = project(from);
        const b = project(to);
        context.globalAlpha = alpha;
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
        context.globalAlpha = 1;
      };

      const drawRoute = (vehicle: VehicleState, nodeIds: string[], color: string, lineWidth: number, alpha: number) => {
        if (nodeIds.length < 2) return;
        const points = [
          { x: vehicle.x, z: vehicle.z },
          ...nodeIds.slice(1).map((nodeId) => geometry.nodeMap.get(nodeId)).filter((node): node is ShuttleScenario['layout']['nodes'][number] => Boolean(node))
        ];
        if (points.length < 2) return;
        context.globalAlpha = alpha;
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        for (let index = 1; index < points.length; index += 1) {
          const from = points[index - 1]!;
          const to = points[index]!;
          if (!isAxisAlignedSegment(from, to)) {
            continue;
          }
          const start = project(from);
          const end = project(to);
          context.beginPath();
          context.moveTo(start.x, start.y);
          context.lineTo(end.x, end.y);
          context.stroke();
        }
        context.globalAlpha = 1;
      };

      const reservedEdgeIds = new Set(
        layers.traffic
          ? (state?.reservations ?? []).filter((reservation) => reservation.resourceType === 'edge').map((reservation) => reservation.resourceId)
          : []
      );

      for (const edge of geometry.edges) {
        const from = geometry.nodeMap.get(edge.from);
        const to = geometry.nodeMap.get(edge.to);
        if (!from || !to) continue;
        drawLine(from, to, reservedEdgeIds.has(edge.id) ? '#c28a12' : '#9da8b2', reservedEdgeIds.has(edge.id) ? 2.6 : 1.4, reservedEdgeIds.has(edge.id) ? 0.9 : 0.68);
      }

      if (geometry.nodes.length <= 2500) {
        context.globalAlpha = 0.95;
        for (const node of geometry.nodes) {
          const point = project(node);
          if (node.type === 'storage') {
            context.fillStyle = '#9d82cc';
            context.fillRect(point.x - 1.6, point.y - 1.6, 3.2, 3.2);
          } else if (node.type === 'intersection') {
            context.fillStyle = '#c8a53a';
            context.fillRect(point.x - 2.5, point.y - 2.5, 5, 5);
          }
        }
        context.globalAlpha = 1;
      }

      if (layers.loads) {
        for (const load of state?.loads ?? []) {
          if (!load.nodeId || load.state === 'carried') continue;
          const node = geometry.nodeMap.get(load.nodeId);
          if (!node) continue;
          const point = project(node);
          context.fillStyle = load.state === 'waiting' ? '#d09a3a' : '#8b96a0';
          context.strokeStyle = '#ffffff';
          context.lineWidth = 1.2;
          context.beginPath();
          context.roundRect(point.x - 4.2, point.y - 4.2, 8.4, 8.4, 1.2);
          context.fill();
          context.stroke();
        }
      }

      if (layers.routes) {
        for (const vehicle of state?.vehicles ?? []) {
          const selected = selectedVehicleId === vehicle.id;
          const plannedNodes = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
          const color = vehicle.loaded ? '#2f9e6d' : vehicle.taskId ? '#1976d2' : '#7c5ed8';
          drawRoute(vehicle, plannedNodes, color, selected ? 4.8 : 3, selected ? 0.98 : 0.76);
          drawRoute(vehicle, vehicle.localRouteNodeIds, '#d29b22', selected ? 5.5 : 4.2, selected ? 1 : 0.86);
        }
      }

      const activeTasks = state?.tasks.filter((task) => task.vehicleId && task.state !== 'completed' && task.state !== 'failed') ?? [];
      const vehicleById = new Map((state?.vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
      for (const task of activeTasks) {
        const vehicle = task.vehicleId ? vehicleById.get(task.vehicleId) : null;
        const pickupNode = geometry.nodeMap.get(task.pickupNodeId);
        if (!vehicle || !pickupNode || vehicle.loaded) continue;
        const point = project(pickupNode);
        context.fillStyle = '#1976d2';
        context.strokeStyle = '#ffffff';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(point.x, point.y - 12, 8, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.fillStyle = '#f8fbff';
        context.font = '700 10px system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(vehicleDisplayNumber(vehicle.id), point.x, point.y - 12);
      }

      for (const vehicle of state?.vehicles ?? []) {
        const point = project(vehicle);
        const selected = selectedVehicleId === vehicle.id;
        context.fillStyle = vehicle.state === 'waiting-blocked'
          ? '#b7892c'
          : vehicle.loaded
            ? '#2f9e6d'
            : vehicle.taskId
              ? '#1976d2'
              : vehicle.state === 'idle'
                ? '#66717b'
                : '#7c5ed8';
        context.strokeStyle = selected ? '#111820' : vehicle.loaded ? '#dff6e8' : '#e7f2ff';
        context.lineWidth = selected ? 3 : 1.6;
        context.shadowColor = 'rgba(20, 28, 34, 0.18)';
        context.shadowBlur = selected ? 10 : 5;
        context.shadowOffsetY = 1.5;
        context.beginPath();
        context.roundRect(point.x - 12, point.y - 9, 24, 18, 3);
        context.fill();
        context.shadowColor = 'transparent';
        context.stroke();
        context.fillStyle = '#f8fbff';
        context.font = '800 11px system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(vehicleDisplayNumber(vehicle.id), point.x, point.y + 0.5);
      }
    };

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [geometry, layers, selectedVehicleId, state]);

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !state) return;
    const rect = canvas.getBoundingClientRect();
    const padding = 16;
    const project = (point: { x: number; z: number }) => ({
      x: padding + ((point.x - geometry.minX) / geometry.width) * (rect.width - padding * 2),
      y: rect.height - padding - ((point.z - geometry.minZ) / geometry.depth) * (rect.height - padding * 2)
    });
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const hit = [...state.vehicles].reverse().find((vehicle) => {
      const point = project(vehicle);
      return Math.abs(clickX - point.x) <= 14 && Math.abs(clickY - point.y) <= 12;
    });
    if (hit) {
      onSelectVehicle(hit.id);
    }
  };

  return (
    <canvas
      aria-label="Lite canvas debug map"
      className="lite-map-canvas"
      onClick={handleClick}
      ref={canvasRef}
    />
  );
}

function formatRendererInfo(info: ShuttleSceneRendererInfo | null): string {
  if (!info) return 'GPU: checking';
  const device = info.renderer
    .replace(/^ANGLE \((.*)\)$/i, '$1')
    .replace(/\s+Direct3D\d+.*$/i, '')
    .replace(/\s+vs_.*$/i, '')
    .trim();
  return `${info.hardwareAccelerated ? 'GPU' : 'Software'}: ${info.webglVersion} ${device || info.renderer}`;
}

function StreamingPane({
  scenario,
  state,
  layers,
  selectedVehicleId,
  viewMode,
  cameraView,
  rendererInfo,
  onCameraViewChange,
  onToggleLayer,
  onSelectVehicle,
  onViewModeChange,
  onRendererInfo
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: SceneLayers;
  selectedVehicleId: string | null;
  viewMode: MapViewMode;
  cameraView: ShuttleSceneCameraView;
  rendererInfo: ShuttleSceneRendererInfo | null;
  onCameraViewChange: (view: ShuttleSceneCameraView) => void;
  onToggleLayer: (layer: keyof SceneLayers) => void;
  onSelectVehicle: (vehicleId: string) => void;
  onViewModeChange: (mode: MapViewMode) => void;
  onRendererInfo: (info: ShuttleSceneRendererInfo) => void;
}) {
  return (
    <section className="stream-pane">
      <div className="stream-header">
        <div>
          <h2>{viewMode === '3d' ? '3D Model' : viewMode === 'lite' ? '2D Lite Canvas' : '2D Debug Map'}</h2>
          <p>Live SimCore state stream.</p>
        </div>
        <div className="scene-layer-controls">
          <div className="view-toggle" aria-label="Map view mode">
            <button
              className={viewMode === '3d' ? 'active' : ''}
              type="button"
              onClick={() => onViewModeChange('3d')}
              aria-pressed={viewMode === '3d'}
            >
              3D
            </button>
            <button
              className={viewMode === 'lite' ? 'active' : ''}
              type="button"
              onClick={() => onViewModeChange('lite')}
              aria-pressed={viewMode === 'lite'}
            >
              2D Lite
            </button>
            <button
              className={viewMode === '2d' ? 'active' : ''}
              type="button"
              onClick={() => onViewModeChange('2d')}
              aria-pressed={viewMode === '2d'}
            >
              2D Debug
            </button>
          </div>
          {(Object.keys(layers) as Array<keyof SceneLayers>).map((layer) => (
            <button
              className={layers[layer] ? 'active' : ''}
              key={layer}
              type="button"
              onClick={() => onToggleLayer(layer)}
              aria-pressed={layers[layer]}
            >
              {layer}
            </button>
          ))}
          {viewMode === '3d' && <button type="button" onClick={() => onCameraViewChange(clampSceneCameraView({ ...cameraView, zoom: cameraView.zoom * 1.2 }))}>
            Zoom In
          </button>}
          {viewMode === '3d' && <button type="button" onClick={() => onCameraViewChange(clampSceneCameraView({ ...cameraView, zoom: cameraView.zoom / 1.2 }))}>
            Zoom Out
          </button>}
          {viewMode === '3d' && <button type="button" onClick={() => onCameraViewChange(clampSceneCameraView({ ...cameraView, yawOffsetRad: cameraView.yawOffsetRad - 0.28 }))}>
            Rotate Left
          </button>}
          {viewMode === '3d' && <button type="button" onClick={() => onCameraViewChange(clampSceneCameraView({ ...cameraView, yawOffsetRad: cameraView.yawOffsetRad + 0.28 }))}>
            Rotate Right
          </button>}
          {viewMode === '3d' && <button type="button" onClick={() => onCameraViewChange(DEFAULT_SCENE_CAMERA_VIEW)}>
            Reset View
          </button>}
          <span className="route-legend" aria-label="Route legend">
            <span><i className="planned-empty" />To pickup</span>
            <span><i className="planned-loaded" />Loaded</span>
            <span><i className="planned-taskless" />No task</span>
            <span><i className="local" />Local</span>
            <span><i className="goal" />Goal</span>
            <span><i className="pickup" />Pickup</span>
          </span>
          {viewMode === '3d' && <span
            className={`gpu-badge ${rendererInfo?.hardwareAccelerated === false ? 'software' : 'hardware'}`}
            title={rendererInfo ? `${rendererInfo.vendor} / ${rendererInfo.renderer}` : 'Waiting for WebGL renderer'}
          >
            {formatRendererInfo(rendererInfo)}
          </span>}
        </div>
      </div>
      <div className="stream-placeholder">
        {viewMode === 'lite' ? (
          <CanvasLiteMap
            scenario={scenario}
            state={state}
            layers={layers}
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={onSelectVehicle}
          />
        ) : viewMode === '2d' ? (
          <AuthoritativeMap
            scenario={scenario}
            state={state}
            layers={layers}
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={onSelectVehicle}
          />
        ) : (
          <Suspense fallback={<div className="shuttle-scene-loading" />}>
            <ShuttleScene3D
            scenario={scenario}
            state={state}
            layers={layers}
            selectedVehicleId={selectedVehicleId}
            cameraView={cameraView}
            onCameraViewChange={onCameraViewChange}
            onRendererInfo={onRendererInfo}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}

function TrafficDiagnosticsPanel({ state }: { state: ShuttleSimState | null }) {
  const traffic = state?.traffic;
  const trafficHolds = traffic?.waitingVehicles ?? [];
  const liftPorts = traffic?.liftPorts ?? [];
  const queuedLiftTasks = liftPorts.reduce((sum, port) => sum + port.queueLength, 0);
  const activeLiftPorts = liftPorts.filter((port) => port.activeTaskId).length;
  const approachOccupied = liftPorts.reduce((sum, port) => sum + (port.approachOccupancy ?? 0), 0);
  const approachCapacity = liftPorts.reduce((sum, port) => sum + (port.approachCapacity ?? 1), 0);
  const blockedReasons = Object.entries(state?.kpis.blockedTimeByReasonSec ?? {});
  const laneWaitSec = blockedReasons
    .filter(([reason]) => reason.startsWith('fifo-'))
    .reduce((sum, [, value]) => sum + value, 0);
  const storageWaitSec = blockedReasons
    .filter(([reason]) => reason.startsWith('storage-'))
    .reduce((sum, [, value]) => sum + value, 0);
  const liftWaitSec = blockedReasons
    .filter(([reason]) => reason.includes('lift') || reason.includes('port'))
    .reduce((sum, [, value]) => sum + value, 0);
  const fleetWaitSec = blockedReasons
    .filter(([reason]) => reason === 'vehicle-unavailable')
    .reduce((sum, [, value]) => sum + value, 0);
  const topBlockedReason = blockedReasons
    .filter(([, seconds]) => seconds > 0)
    .sort((left, right) => right[1] - left[1])[0] ?? null;
  const activePortalZones = (state?.reservations ?? []).filter(
    (reservation) => reservation.resourceType === 'zone' && reservation.resourceId.startsWith('zone-main-portal')
  ).length;

  return (
    <section className="traffic-diagnostics" aria-label="Traffic diagnostics">
      <div>
        <span>Bottleneck</span>
        <strong>{topBlockedReason ? formatBlockedReason(topBlockedReason[0]) : '--'}</strong>
        <small>{topBlockedReason ? `${formatNumber(topBlockedReason[1], 1)}s` : 'no blocked time'}</small>
      </div>
      <div>
        <span>Reservations</span>
        <strong>{traffic?.activeReservationCount ?? '--'}</strong>
      </div>
      <div>
        <span>Control</span>
        <strong>{traffic?.trafficMode ?? '--'}</strong>
        <small>{traffic?.trafficMode === 'agent-simple' || traffic?.trafficMode === 'agent-minimal' || traffic?.trafficMode === 'agent-refresh' ? 'vehicle-local routing' : 'reservation controller'}</small>
      </div>
      <div>
        <span>Avoidance</span>
        <strong className={traffic?.collisionAvoidanceEnabled === false ? 'blocked' : 'ready'}>
          {traffic?.collisionAvoidanceEnabled === false ? 'Off' : 'On'}
        </strong>
        <small>{traffic?.collisionAvoidanceEnabled === false ? 'UNSAFE DIAGNOSTIC - safety invalid' : 'safety gates active'}</small>
      </div>
      <div>
        <span>Traffic holds</span>
        <strong>{trafficHolds.length}</strong>
        <small>avoidance / resource holds</small>
      </div>
      <div>
        <span>Min separation</span>
        <strong>{traffic?.minVehicleSeparationM === null || traffic?.minVehicleSeparationM === undefined ? '--' : `${traffic.minVehicleSeparationM.toFixed(2)}m`}</strong>
      </div>
      <div>
        <span>Physical violations</span>
        <strong className={traffic?.physicalViolationCount ? 'blocked' : 'ready'}>{traffic?.physicalViolationCount ?? 0}</strong>
      </div>
      <div>
        <span>Lift cycles</span>
        <strong>{activeLiftPorts}/{liftPorts.length}</strong>
        <small>{queuedLiftTasks} queued</small>
      </div>
      <div>
        <span>Approach slots</span>
        <strong>{approachOccupied}/{approachCapacity}</strong>
        <small>{liftPorts.filter((port) => port.kind === 'inbound').length} in / {liftPorts.filter((port) => port.kind === 'outbound').length} out</small>
      </div>
      <div>
        <span>Lane holds</span>
        <strong>{formatNumber(laneWaitSec, 1)}s</strong>
      </div>
      <div>
        <span>Storage holds</span>
        <strong>{formatNumber(storageWaitSec, 1)}s</strong>
      </div>
      <div>
        <span>Lift holds</span>
        <strong>{formatNumber(liftWaitSec, 1)}s</strong>
      </div>
      <div>
        <span>Fleet holds</span>
        <strong>{formatNumber(fleetWaitSec, 1)}s</strong>
      </div>
      <div>
        <span>Portal zones</span>
        <strong>{activePortalZones}</strong>
      </div>
      <div className="traffic-wait-list">
        {trafficHolds.length === 0 ? (
          <small>No traffic-held vehicles</small>
        ) : (
          trafficHolds.map((vehicle) => (
            <small key={vehicle.vehicleId}>
              {vehicle.vehicleId} / {vehicle.waitReason ? formatBlockedReason(vehicle.waitReason) : 'blocked'} / {vehicle.blockingVehicleId ?? vehicle.blockingReservationId ?? 'resource'}
            </small>
          ))
        )}
      </div>
      <div className="traffic-lift-list">
        {liftPorts.length === 0 ? (
          <small>No lift ports</small>
        ) : (
          liftPorts.map((port) => (
            <small key={port.nodeId}>
              {port.nodeId} / {port.kind} / approach {port.approachOccupancy ?? 0}/{port.approachCapacity ?? 1} / q{port.queueLength} / cycle {Math.round(port.utilization * 100)}%
            </small>
          ))
        )}
      </div>
    </section>
  );
}

function FifoInventoryPanel({ scenario, state }: { scenario: ShuttleScenario | null; state: ShuttleSimState | null }) {
  const staticScene = useMemo(() => scenario ? summarizeScenarioStaticSceneContract(scenario) : null, [scenario]);
  const lanes = useMemo(() => {
    const storageNodes = (scenario?.layout.nodes ?? []).filter((node) => node.type === 'storage');
    const laneByZ = new Map<number, typeof storageNodes>();
    for (const node of storageNodes) {
      const lane = laneByZ.get(node.z) ?? [];
      lane.push(node);
      laneByZ.set(node.z, lane);
    }
    return [...laneByZ.entries()]
      .sort(([leftZ], [rightZ]) => leftZ - rightZ)
      .map(([z, lane]) => ({
        id: `lane-${z}`,
        z,
        cells: lane.sort((left, right) => left.x - right.x || left.id.localeCompare(right.id))
      }));
  }, [scenario]);

  const activeTasks = state?.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed') ?? [];
  const storedByNode = new Map(
    (state?.loads ?? [])
      .filter((load) => load.state === 'stored' && load.nodeId)
      .map((load) => [load.nodeId!, load])
  );
  const inboundTargets = new Set(
    activeTasks
      .filter((task) => task.kind === 'inbound')
      .map((task) => task.dropoffNodeId)
  );
  const outboundPickups = new Set(
    activeTasks
      .filter((task) => task.kind === 'outbound')
      .map((task) => task.pickupNodeId)
  );
  const storageEmptySec = state?.kpis.blockedTimeByReasonSec['storage-empty'] ?? 0;
  const storageFullSec = state?.kpis.blockedTimeByReasonSec['storage-full'] ?? 0;
  const totalCells = lanes.reduce((sum, lane) => sum + lane.cells.length, 0);
  const occupiedCount = lanes.reduce(
    (sum, lane) => sum + lane.cells.filter((cell) => storedByNode.has(cell.id) || inboundTargets.has(cell.id)).length,
    0
  );
  const laneDiagnostics = lanes.map((lane, laneIndex) => {
    const stored = lane.cells.filter((cell) => storedByNode.has(cell.id)).length;
    const reserved = lane.cells.filter((cell) => inboundTargets.has(cell.id)).length;
    const outbound = lane.cells.filter((cell) => outboundPickups.has(cell.id)).length;
    return {
      id: lane.id,
      label: `Row ${laneIndex + 1}`,
      stored,
      reserved,
      outbound,
      total: lane.cells.length
    };
  });
  const activeLaneDiagnostics = laneDiagnostics
    .filter((lane) => lane.stored + lane.reserved + lane.outbound > 0)
    .slice(0, 8);

  return (
    <section className="panel fifo-panel" aria-label="FIFO inventory">
      <div className="panel-head">
        <h2>FIFO Inventory</h2>
        <span>{occupiedCount}/{totalCells} cells</span>
      </div>
      <div className="fifo-body">
        <div className="fifo-lanes">
          {lanes.map((lane, laneIndex) => (
            <div className="fifo-lane" key={lane.id}>
              <span className="fifo-lane-label">Row {laneIndex + 1}</span>
              <div className="fifo-cells">
                {lane.cells.map((cell) => {
                  const storedLoad = storedByNode.get(cell.id);
                  const reserved = inboundTargets.has(cell.id);
                  const outbound = outboundPickups.has(cell.id);
                  const status = storedLoad ? 'stored' : reserved ? 'reserved' : 'empty';
                  return (
                    <div className={`fifo-cell ${status} ${outbound ? 'outbound' : ''}`} key={cell.id}>
                      <span>{formatStorageCellLabel(cell.id)}</span>
                      <strong>{storedLoad?.id ?? (reserved ? 'inbound' : '--')}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="fifo-reasons">
          <div className="fifo-policy-card">
            <span>Storage policy</span>
            <strong>{formatStoragePolicy(staticScene?.storagePolicy ?? 'rowContiguousLaneFill')}</strong>
            <small>
              Inbound {formatStorageFlow(staticScene?.inboundStorageFlow ?? 'rightToLeft')}.
              Outbound {formatStorageFlow(staticScene?.outboundStorageFlow ?? 'leftPick')}.
              No hidden compaction.
            </small>
          </div>
          <div className="fifo-row-summary">
            <span>Active rows</span>
            {activeLaneDiagnostics.length === 0 ? (
              <small>No active storage rows</small>
            ) : (
              activeLaneDiagnostics.map((lane) => (
                <small key={lane.id}>
                  {lane.label} {lane.stored + lane.reserved}/{lane.total}
                  {lane.outbound > 0 ? ` / pick ${lane.outbound}` : ''}
                </small>
              ))
            )}
          </div>
          <div>
            <span>Storage empty hold</span>
            <strong>{formatNumber(storageEmptySec, 1)}s</strong>
          </div>
          <div>
            <span>Storage full hold</span>
            <strong>{formatNumber(storageFullSec, 1)}s</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function PrerequisitePanel({ report }: { report: PrerequisiteReport | null }) {
  return (
    <section className="panel prereq-panel">
      <div className="panel-head">
        <h2>Mac / UE Gate</h2>
        <span>{report ? new Date(report.checkedAt).toLocaleTimeString() : 'checking'}</span>
      </div>
      {report ? (
        <div className="prereq-grid">
          <div>
            <span>Host</span>
            <strong>{[report.host.modelName, report.host.chip, report.host.memory].filter(Boolean).join(' / ')}</strong>
          </div>
          <div>
            <span>Unreal 5.7.4</span>
            <strong className={report.unreal.status}>{report.unreal.status}</strong>
          </div>
          <div>
            <span>Xcode</span>
            <strong className={report.xcode.status}>{report.xcode.status}</strong>
          </div>
          <div>
            <span>Pixel Streaming prereqs</span>
            <strong>{report.pixelStreaming.status}</strong>
          </div>
        </div>
      ) : (
        <p className="muted">Waiting for prerequisite report...</p>
      )}
    </section>
  );
}

function previewCalibrationKeys(keys: string[]): string {
  if (keys.length === 0) {
    return 'none';
  }
  const visibleKeys = keys.slice(0, 3).join(', ');
  return keys.length > 3 ? `${keys.length} missing: ${visibleKeys}...` : visibleKeys;
}

function CalibrationPanel({ scenario }: { scenario: ShuttleScenario | null }) {
  const readiness: ShuttleStaticSceneCalibrationReadiness | null = useMemo(
    () => scenario ? summarizeScenarioStaticSceneContract(scenario).calibrationReadiness : null,
    [scenario]
  );

  return (
    <section className="panel prereq-panel" aria-label="Layout calibration gate">
      <div className="panel-head">
        <h2>Calibration Gate</h2>
        <span>{readiness?.status ?? 'loading'}</span>
      </div>
      {readiness ? (
        <div className="prereq-grid">
          <div>
            <span>Throughput claim</span>
            <strong className={readiness.readyForIndustrialThroughputClaims ? 'ready' : 'blocked'}>
              {readiness.readyForIndustrialThroughputClaims ? 'ready' : 'blocked'}
            </strong>
          </div>
          <div>
            <span>CAD/vendor/site dimensions</span>
            <strong>{readiness.calibratedDimensionKeys.length}/{readiness.requiredDimensionKeys.length}</strong>
          </div>
          <div>
            <span>Missing dimensions</span>
            <strong>{previewCalibrationKeys(readiness.missingDimensionKeys)}</strong>
          </div>
          <div>
            <span>Assumed / low confidence</span>
            <strong>{readiness.assumedDimensionKeys.length} / {readiness.lowConfidenceDimensionKeys.length}</strong>
          </div>
        </div>
      ) : (
        <p className="muted">Waiting for scenario calibration profile...</p>
      )}
    </section>
  );
}

function ValidationPanel({
  validation,
  validating,
  onRun
}: {
  validation: Phase0ValidationResult | null;
  validating: boolean;
  onRun: () => void;
}) {
  const seedSweepMaxAccel = validation
    ? Math.max(0, ...validation.seedSweep.runs.map((run) => run.maxObservedAccelerationMps2))
    : 0;
  const longRun = validation?.longRun ?? null;
  const longRunThresholds = longRun?.thresholds ?? null;
  const stress = validation?.stress ?? null;
  const stressScenarioCount = stress?.scenarios.length ?? 0;
  const stressPassCount = stress?.scenarios.filter((scenario) => scenario.pass).length ?? 0;
  const stressWorstQueue = stress ? Math.max(0, ...stress.scenarios.map((scenario) => scenario.maxQueuedTasks)) : 0;
  const stressBottlenecks = stress
    ? [...new Set(stress.scenarios.flatMap((scenario) => scenario.observedBottleneckReasons))].slice(0, 4)
    : [];
  const inboundStress = stress?.scenarios.find((scenario) => scenario.id === 'inbound-only-saturation') ?? null;
  const longRunTopBottleneck = topBottleneckCategory(longRun?.blockedTimeByCategorySec);
  const stressTopBottleneck = topBottleneckCategory(stress?.blockedTimeByCategorySec);
  const longRunStatus = (value: boolean | undefined, okLabel: string, blockedLabel: string): string => {
    if (!longRun || value === undefined) return '--';
    return value ? okLabel : blockedLabel;
  };
  const longRunPass = validation
    ? Boolean(
        longRun &&
        validation.acceptance.longRunEventLogsPresent &&
        validation.acceptance.longRunThroughputPositive &&
        validation.acceptance.longRunThroughputFloorMet !== false &&
        validation.acceptance.longRunQueuesBounded &&
        validation.acceptance.noLongRunDeadlocks &&
        validation.acceptance.noLongRunPhysicalSafetyViolations &&
        validation.acceptance.noLongRunReservationCoverageViolations
      )
    : false;

  return (
    <section className="panel validation-panel">
      <div className="panel-head">
        <h2>Validation Gate</h2>
        <button type="button" onClick={onRun} disabled={validating}>{validating ? 'Running' : 'Run'}</button>
      </div>
      {validation ? (
        <div className="validation-grid">
          <div>
            <span>Acceptance</span>
            <strong className={validation.acceptance.pass ? 'ready' : 'blocked'}>{validation.acceptance.pass ? 'pass' : 'fail'}</strong>
          </div>
          <div>
            <span>Same-seed hash</span>
            <strong>{validation.deterministic.pass ? 'stable' : 'unstable'}</strong>
          </div>
          <div>
            <span>Seed sweep PPH</span>
            <strong>{formatNumber(validation.seedSweep.totalPphMean, 1)} avg</strong>
          </div>
          <div>
            <span>Physical safety</span>
            <strong>{validation.acceptance.noPhysicalSafetyViolations ? 'clear' : 'violations'}</strong>
          </div>
          <div>
            <span>Reservation coverage</span>
            <strong>{validation.acceptance.noReservationCoverageViolations ? 'clear' : 'violations'}</strong>
          </div>
          <div>
            <span>Max accel</span>
            <strong>{formatNumber(seedSweepMaxAccel, 2)} m/s2</strong>
          </div>
          <div>
            <span>Hash</span>
            <strong>{validation.deterministic.hashes[0]?.slice(0, 12) ?? '--'}</strong>
          </div>
          <div className="validation-divider">
            <span>Long run</span>
            <strong className={longRunPass ? 'ready' : 'blocked'}>{longRunPass ? 'clear' : 'check'}</strong>
          </div>
          <div>
            <span>Long-run PPH</span>
            <strong>
              {longRun
                ? `${formatNumber(longRun.totalPphMean, 1)} avg / min ${longRunThresholds ? formatNumber(longRunThresholds.minTotalPph, 1) : '--'}`
                : '--'}
            </strong>
          </div>
          <div>
            <span>Long-run by side</span>
            <strong>
              {longRunThresholds
                ? `${formatNumber(longRunThresholds.minInboundPph ?? 0, 1)} / ${formatNumber(longRunThresholds.minOutboundPph ?? 0, 1)} min`
                : '--'}
            </strong>
          </div>
          <div>
            <span>Long-run bottleneck</span>
            <strong>{formatBottleneckCategory(longRunTopBottleneck)}</strong>
          </div>
          <div>
            <span>Queue high water</span>
            <strong>{longRun ? `${longRun.maxQueuedTasks} / ${longRunThresholds?.maxQueuedTasks ?? '--'} tasks` : '--'}</strong>
          </div>
          <div>
            <span>Traffic hold high water</span>
            <strong>{longRun ? `${longRun.maxWaitingVehicles} / ${longRunThresholds?.maxWaitingVehicles ?? '--'} vehicles` : '--'}</strong>
          </div>
          <div>
            <span>Lift queue high water</span>
            <strong>{longRun ? `${longRun.maxLiftPortQueueLength} / ${longRunThresholds?.maxLiftPortQueueLength ?? '--'} tasks` : '--'}</strong>
          </div>
          <div>
            <span>Long-run deadlocks</span>
            <strong>{longRunStatus(validation.acceptance.noLongRunDeadlocks, 'clear', 'blocked')}</strong>
          </div>
          <div>
            <span>Long-run safety</span>
            <strong>{longRunStatus(validation.acceptance.noLongRunPhysicalSafetyViolations, 'clear', 'violations')}</strong>
          </div>
          <div>
            <span>Long-run coverage</span>
            <strong>{longRunStatus(validation.acceptance.noLongRunReservationCoverageViolations, 'clear', 'violations')}</strong>
          </div>
          <div className="validation-divider">
            <span>Stress suite</span>
            <strong className={stress?.pass ? 'ready' : 'blocked'}>{stress ? (stress.pass ? 'clear' : 'check') : '--'}</strong>
          </div>
          <div>
            <span>Stress scenarios</span>
            <strong>{stress ? `${stressPassCount}/${stressScenarioCount} pass` : '--'}</strong>
          </div>
          <div>
            <span>Stress safety</span>
            <strong>{stress ? (stress.noStressPhysicalSafetyViolations ? 'clear' : 'violations') : '--'}</strong>
          </div>
          <div>
            <span>Stress coverage</span>
            <strong>{stress ? (stress.noStressReservationCoverageViolations ? 'clear' : 'violations') : '--'}</strong>
          </div>
          <div>
            <span>Stress deadlocks</span>
            <strong>{stress ? (stress.noStressDeadlocks ? 'clear' : 'blocked') : '--'}</strong>
          </div>
          <div>
            <span>Stress bottlenecks</span>
            <strong>{stress ? (stress.expectedBottlenecksObserved ? 'observed' : 'missing') : '--'}</strong>
          </div>
          <div>
            <span>Stress queue high water</span>
            <strong>{stress ? `${stressWorstQueue} tasks` : '--'}</strong>
          </div>
          <div>
            <span>Stress bottleneck class</span>
            <strong>{formatBottleneckCategory(stressTopBottleneck)}</strong>
          </div>
          <div>
            <span>Stress reasons</span>
            <strong>{stressBottlenecks.length > 0 ? stressBottlenecks.join(', ') : '--'}</strong>
          </div>
          <div>
            <span>Inbound stress PPH gap</span>
            <strong>
              {inboundStress && inboundStress.inboundPphGapToTheoryMean !== null
                ? `${formatNumber(inboundStress.inboundPphGapToTheoryMean, 1)} PPH`
                : '--'}
            </strong>
          </div>
          <div>
            <span>Inbound actual / theory</span>
            <strong>
              {inboundStress && inboundStress.theoreticalFleetPphMean !== null
                ? `${formatNumber(inboundStress.totalPphMean, 1)} / ${formatNumber(inboundStress.theoreticalFleetPphMean, 1)}`
                : '--'}
            </strong>
          </div>
          <div>
            <span>Inbound stress utilization</span>
            <strong>{inboundStress ? `${formatNumber(inboundStress.averageVehicleUtilizationPctMean, 1)}%` : '--'}</strong>
          </div>
          <div>
            <span>Inbound productive / hold</span>
            <strong>
              {inboundStress
                ? `${formatNumber(inboundStress.averageVehicleProductivePctMean, 1)}% / ${formatNumber(inboundStress.averageVehicleWaitingPctMean, 1)}%`
                : '--'}
            </strong>
          </div>
        </div>
      ) : (
        <p className="muted">Run deterministic, seed-sweep, long-run, and stress gates before a Pixel Streaming test.</p>
      )}
    </section>
  );
}

export function App() {
  const [scenario, setScenario] = useState<ShuttleScenario | null>(null);
  const [state, setState] = useState<ShuttleSimState | null>(null);
  const [liveStream, setLiveStream] = useState<LiveStreamSnapshot | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [prerequisites, setPrerequisites] = useState<PrerequisiteReport | null>(null);
  const [validation, setValidation] = useState<Phase0ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>({ label: 'ready', tone: 'idle' });
  const [playbackSpeed, setPlaybackSpeedState] = useState(1);
  const [paramDraftValues, setParamDraftValues] = useState<Map<string, number>>(() => new Map());
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [rendererInfo, setRendererInfo] = useState<ShuttleSceneRendererInfo | null>(null);
  const [sceneLayers, setSceneLayers] = useState<SceneLayers>({
    traffic: false,
    physics: false,
    loads: true,
    routes: true
  });
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>('lite');
  const [sceneCameraView, setSceneCameraView] = useState<ShuttleSceneCameraView>(DEFAULT_SCENE_CAMERA_VIEW);
  const [isPending, startTransition] = useTransition();
  const reconnectAttemptRef = useRef(0);
  const playbackSpeedChangedRef = useRef(false);
  const paramUpdateTimersRef = useRef<Map<string, number>>(new Map());
  const pendingLiveStreamRef = useRef<LiveStreamSnapshot | null>(null);
  const liveStreamFrameRef = useRef<number | null>(null);

  function commitLiveStreamFromState(nextState: ShuttleSimState): void {
    const snapshot = {
      simTimeSec: nextState.simTimeSec,
      vehicles: nextState.vehicles,
      kpis: nextState.kpis
    };
    pendingLiveStreamRef.current = snapshot;
    setLiveStream(snapshot);
  }

  function scheduleLiveStreamPatch(patch: Partial<LiveStreamSnapshot> & { simTimeSec: number }): void {
    const previous = pendingLiveStreamRef.current ?? liveStream ?? {
      simTimeSec: state?.simTimeSec ?? 0,
      vehicles: state?.vehicles ?? null,
      kpis: state?.kpis ?? null
    };
    if (patch.simTimeSec < previous.simTimeSec) {
      return;
    }
    pendingLiveStreamRef.current = {
      simTimeSec: patch.simTimeSec,
      vehicles: patch.vehicles ?? previous.vehicles,
      kpis: patch.kpis ?? previous.kpis
    };
    if (liveStreamFrameRef.current !== null) {
      return;
    }
    liveStreamFrameRef.current = window.requestAnimationFrame(() => {
      liveStreamFrameRef.current = null;
      setLiveStream(pendingLiveStreamRef.current);
    });
  }

  const liveClockSec = liveStream?.simTimeSec ?? state?.simTimeSec ?? 0;
  const kpis = liveStream?.kpis ?? state?.kpis ?? null;
  const vehicles = liveStream?.vehicles ?? state?.vehicles ?? [];
  const sceneState = useMemo(() => {
    if (!state) return null;
    return {
      ...state,
      simTimeSec: liveClockSec,
      vehicles,
      kpis: kpis ?? state.kpis
    };
  }, [kpis, liveClockSec, state, vehicles]);
  const statusTone = state?.status === 'running' ? 'ok' : state?.status === 'paused' ? 'warn' : 'idle';

  useEffect(() => {
    if (vehicles.length === 0) {
      setSelectedVehicleId(null);
      return;
    }
    if (!selectedVehicleId || !vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) {
      setSelectedVehicleId(vehicles[0]!.id);
    }
  }, [selectedVehicleId, vehicles]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      requestJson<ShuttleScenario>('/api/shuttle/scenario'),
      requestJson<ShuttleSimState>('/api/shuttle/state'),
      requestJson<PrerequisiteReport>('/api/shuttle/prerequisites'),
      requestJson<PlaybackSpeedResponse>('/api/shuttle/playbackSpeed')
    ])
      .then(([nextScenario, nextState, report, speedReport]) => {
        if (cancelled) return;
        setScenario(nextScenario);
        setState(nextState);
        commitLiveStreamFromState(nextState);
        setEvents(nextState.recentEvents);
        setPrerequisites(report);
        if (!playbackSpeedChangedRef.current) {
          setPlaybackSpeedState(speedReport.speed);
        }
      })
      .catch((error) => setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(websocketUrl());
      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data as string) as ShuttleStreamMessage;
        if (message.type === 'connectionRecovered' || message.type === 'simState') {
          commitLiveStreamFromState(message.state);
          startTransition(() => {
            setState(message.state);
            setEvents(message.state.recentEvents);
          });
        }
        if (message.type === 'vehicleState') {
          scheduleLiveStreamPatch({ vehicles: message.vehicles, simTimeSec: message.simTimeSec });
        }
        if (message.type === 'kpiUpdate') {
          scheduleLiveStreamPatch({ kpis: message.kpis, simTimeSec: message.simTimeSec });
        }
        if (message.type === 'taskEvent') {
          setEvents((previous) => mergeEvents(previous, message.events));
        }
        if (message.type === 'error') {
          setCommandStatus({ label: message.message, tone: 'error' });
        }
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        reconnectAttemptRef.current += 1;
        const delay = Math.min(4000, 400 * reconnectAttemptRef.current);
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (liveStreamFrameRef.current !== null) {
        window.cancelAnimationFrame(liveStreamFrameRef.current);
        liveStreamFrameRef.current = null;
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of paramUpdateTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      paramUpdateTimersRef.current.clear();
    };
  }, []);

  const scenarioParamValues = useMemo(() => {
    if (!scenario) return new Map<string, number>();
    return new Map(CONTROLLED_PARAMS.map((param) => [param.path, Number(getPointerValue(scenario, param.path) ?? 0)]));
  }, [scenario]);

  const paramValues = useMemo(() => {
    const values = new Map(scenarioParamValues);
    for (const [path, value] of paramDraftValues) {
      values.set(path, value);
    }
    return values;
  }, [paramDraftValues, scenarioParamValues]);
  const collisionAvoidanceEnabled = scenario?.trafficPolicy.collisionAvoidanceEnabled ?? true;
  const controllerMode = scenario?.trafficPolicy.controllerMode ?? 'reservation-v2';
  const validationMode = validation?.acceptance.ieValidationPass
    ? { label: 'IE pass', tone: 'ok' }
    : validation?.acceptance.segmentSafeValidationPass
      ? { label: 'Segment safe', tone: 'ok' }
      : validation?.acceptance.flowDebugObservationPass
        ? { label: 'Flow debug only', tone: 'warn' }
        : { label: 'Not validated', tone: 'idle' };

  async function postCommand(path: string, body: unknown = {}): Promise<boolean> {
    const startedAt = performance.now();
    setCommandStatus({ label: 'sending command...', tone: 'idle' });
    try {
      const response = await requestJson<{ state?: ShuttleSimState; result?: unknown }>(path, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (response.state) {
        setState(response.state);
        commitLiveStreamFromState(response.state);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `ack ${elapsedMs} ms`, tone: 'ok' });
      return true;
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
      return false;
    }
  }

  async function updateParam(path: string, value: number | boolean): Promise<void> {
    const resetRun = shouldResetAfterParamUpdate(path, state?.status);
    const resumeRun = shouldResumeAfterParamUpdate(path, state?.status);
    const seed = state?.seed;
    const resetBeforeUpdate = path === COLLISION_AVOIDANCE_PARAM && (state?.simTimeSec ?? 0) > 0;
    if (resetBeforeUpdate) {
      const reset = await postCommand('/api/shuttle/reset', { seed });
      if (!reset) {
        return;
      }
    }
    const updated = await postCommand('/api/shuttle/setParam', { path, value });
    if (!updated) {
      return;
    }
    if (resetRun && !resetBeforeUpdate) {
      const reset = await postCommand('/api/shuttle/reset', { seed });
      if (!reset) {
        return;
      }
    }
    if (resetRun) {
      if (resumeRun) {
        const resumed = await postCommand('/api/shuttle/resume');
        if (!resumed) {
          return;
        }
        setCommandStatus({ label: 'updated + restarted', tone: 'ok' });
      } else {
        setCommandStatus({ label: 'updated + reset', tone: 'ok' });
      }
    }
    try {
      const nextScenario = await requestJson<ShuttleScenario>('/api/shuttle/scenario');
      setScenario(nextScenario);
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  function scheduleParamUpdate(path: string, value: number): void {
    setParamDraftValues((previous) => {
      const next = new Map(previous);
      next.set(path, value);
      return next;
    });

    const existingTimer = paramUpdateTimersRef.current.get(path);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      paramUpdateTimersRef.current.delete(path);
      void updateParam(path, value).finally(() => {
        setParamDraftValues((previous) => {
          if (previous.get(path) !== value) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(path);
          return next;
        });
      });
    }, 300);
    paramUpdateTimersRef.current.set(path, timer);
  }

  async function setPlaybackSpeed(speed: number): Promise<void> {
    playbackSpeedChangedRef.current = true;
    setPlaybackSpeedState(speed);
    const startedAt = performance.now();
    setCommandStatus({ label: 'sending command...', tone: 'idle' });
    try {
      const response = await requestJson<PlaybackSpeedResponse & { state?: ShuttleSimState }>('/api/shuttle/playbackSpeed', {
        method: 'POST',
        body: JSON.stringify({ speed })
      });
      setPlaybackSpeedState(response.speed);
      if (response.state) {
        setState(response.state);
        commitLiveStreamFromState(response.state);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `ack ${elapsedMs} ms`, tone: 'ok' });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  async function runValidation(): Promise<void> {
    setValidating(true);
    setCommandStatus({ label: 'running validation...', tone: 'idle' });
    try {
      const response = await requestJson<{ validation: Phase0ValidationResult }>('/api/shuttle/validatePhase0', {
        method: 'POST',
        body: JSON.stringify({ durationSec: 180, longRunDurationSec: 600, repeatCount: 3 })
      });
      setValidation(response.validation);
      setCommandStatus({
        label: response.validation.acceptance.pass ? 'validation passed' : 'validation failed',
        tone: response.validation.acceptance.pass ? 'ok' : 'warn'
      });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setValidating(false);
    }
  }

  function toggleSceneLayer(layer: keyof SceneLayers): void {
    setSceneLayers((current) => ({
      ...current,
      [layer]: !current[layer]
    }));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="mark" aria-hidden="true">S0</div>
          <div>
            <h1>Shuttle Sim</h1>
            <p>Local 3D operations test bench.</p>
          </div>
        </div>

        <section className="control-block">
          <div className="run-row">
            <button type="button" onClick={() => postCommand('/api/shuttle/resume')}>Resume</button>
            <button type="button" onClick={() => postCommand('/api/shuttle/pause')}>Pause</button>
            <button type="button" onClick={() => postCommand('/api/shuttle/reset', { seed: state?.seed })}>Reset</button>
          </div>
          <div className="speed-row" aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map((speed) => (
              <button
                className={playbackSpeed === speed ? 'active' : ''}
                key={speed}
                type="button"
                onClick={() => setPlaybackSpeed(speed)}
                aria-pressed={playbackSpeed === speed}
              >
                {speed}x
              </button>
            ))}
          </div>
          <div className={`status-line ${commandStatus.tone}`}>
            <span>{state?.status ?? 'loading'}</span>
            <strong>{commandStatus.label} / {playbackSpeed}x / {controllerMode}{isPending ? ' / rendering' : ''}</strong>
          </div>
        </section>

        <section className="control-block param-block">
          <h2>Scenario</h2>
          <div className="mode-toggle">
            <span>
              Collision avoidance
              <strong>{collisionAvoidanceEnabled ? 'On' : 'Off'}</strong>
            </span>
            <div className="mode-row" aria-label="Collision avoidance">
              <button
                className={collisionAvoidanceEnabled ? 'active' : ''}
                type="button"
                onClick={() => updateParam(COLLISION_AVOIDANCE_PARAM, true)}
                aria-pressed={collisionAvoidanceEnabled}
              >
                On
              </button>
              <button
                className={!collisionAvoidanceEnabled ? 'active danger' : ''}
                type="button"
                onClick={() => updateParam(COLLISION_AVOIDANCE_PARAM, false)}
                aria-pressed={!collisionAvoidanceEnabled}
              >
                Off
              </button>
            </div>
            {!collisionAvoidanceEnabled && (
              <p className="unsafe-note">
                UNSAFE DIAGNOSTIC - collision checks are bypassed. Physical and reservation audits still run; do not treat this as a safety pass.
              </p>
            )}
          </div>
          {CONTROLLED_PARAMS.map((param) => {
            const value = paramValues.get(param.path) ?? 0;
            return (
              <label key={param.path}>
                <span>
                  {param.label}
                  <strong>{formatNumber(value, 2)} {param.unit}</strong>
                </span>
                <input
                  type="range"
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={value}
                  onChange={(event) => scheduleParamUpdate(param.path, Number(event.currentTarget.value))}
                />
              </label>
            );
          })}
        </section>

        <details className="details-block">
          <summary>System details</summary>
          <PrerequisitePanel report={prerequisites} />
          <CalibrationPanel scenario={scenario} />
          <ValidationPanel validation={validation} validating={validating} onRun={runValidation} />
        </details>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="caption">SimCore / WCS-lite is source of truth</p>
            <h2>{scenario?.name ?? 'Phase 0 Scenario'}</h2>
          </div>
          <div className="header-status">
            <div className={`safety-chip ${collisionAvoidanceEnabled ? 'ok' : 'danger'}`}>
              <span>Avoidance</span>
              <strong>{collisionAvoidanceEnabled ? 'On' : 'Off'}</strong>
            </div>
            <div className={`safety-chip ${validationMode.tone}`}>
              <span>Validation</span>
              <strong>{validationMode.label}</strong>
            </div>
            <div className={`runtime-badge ${statusTone}`}>
              <span>{formatClock(liveClockSec)}</span>
              <strong>{state ? `${Math.round((liveClockSec / state.durationSec) * 100)}%` : '--'}</strong>
            </div>
          </div>
        </header>

        <StreamingPane
          scenario={scenario}
          state={sceneState}
          layers={sceneLayers}
          selectedVehicleId={selectedVehicleId}
          viewMode={mapViewMode}
          cameraView={sceneCameraView}
          rendererInfo={rendererInfo}
          onCameraViewChange={(view) => setSceneCameraView(clampSceneCameraView(view))}
          onToggleLayer={toggleSceneLayer}
          onSelectVehicle={setSelectedVehicleId}
          onViewModeChange={setMapViewMode}
          onRendererInfo={setRendererInfo}
        />
        <KpiStrip kpis={kpis} />
        <CapacityTheoryPanel kpis={kpis} />
        <ResourceUtilizationPanel scenario={scenario} state={state} />
        <TrafficDiagnosticsPanel state={state} />
        <div className="main-grid">
          <VehicleTable
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={setSelectedVehicleId}
          />
          <details className="diagnostics-details">
            <summary>Event log</summary>
            <EventLog events={events} />
          </details>
        </div>
        <details className="workspace-details">
          <summary>Inventory / FIFO details</summary>
          <FifoInventoryPanel scenario={scenario} state={state} />
        </details>
      </section>
    </main>
  );
}
