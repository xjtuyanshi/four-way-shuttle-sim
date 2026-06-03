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
import type { HeadlessDesResult } from '@four-way-shuttle/sim-core';
import type { ShuttleSceneCameraView, ShuttleSceneRendererInfo } from './ShuttleScene3D.js';
import { flowRgba, resolveLoadFlowRole, resolveVehicleTaskFlowRole, FLOW_VISUAL_COLORS } from './flowColors.js';
import { createStorageCellRects, createTrackAreaRects } from './layoutVisuals.js';

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

type RunToTimeResponse = {
  ok: boolean;
  targetSimTimeSec: number;
  resetFirst: boolean;
  elapsedMs: number;
  state: ShuttleSimState;
};

type HeadlessDesResponse = {
  ok: boolean;
  result: HeadlessDesResult;
};

type PhysicalRecordingFrame = Pick<
  ShuttleSimState,
  'simTimeSec' | 'status' | 'vehicles' | 'tasks' | 'loads' | 'reservations' | 'traffic' | 'kpis' | 'recentEvents' | 'error'
>;

type PhysicalRecordingMarker = {
  sequence: number;
  simTimeSec: number;
  kind: 'deadlock' | 'livelock' | 'physical-violation';
  note: string;
  vehicleIds: string[];
};

type PhysicalRecording = {
  schemaVersion: 'shuttle.physicalRecording.v1';
  id: string;
  createdAtIso: string;
  completedAtIso: string;
  scenarioHash: string;
  scenario: ShuttleScenario;
  durationSec: number;
  sampleIntervalSec: number;
  frameCount: number;
  elapsedMs: number;
  summary: {
    finalSimTimeSec: number;
    status: ShuttleSimState['status'];
    completedInbound: number;
    completedOutbound: number;
    inboundPph: number;
    outboundPph: number;
    totalPph: number;
    deadlocks: number;
    livelocks: number;
    physicalViolations: number;
  };
  anomalyMarkers: PhysicalRecordingMarker[];
  frames: PhysicalRecordingFrame[];
};

type PhysicalRecordingJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAtIso: string;
  durationSec: number;
  sampleIntervalSec: number;
  latestSec: number;
  progressPct: number;
  framesRecorded: number;
  elapsedMs: number;
  scenarioHash: string;
  recordingId: string | null;
  summary: PhysicalRecording['summary'] | null;
  error: string | null;
};

type PhysicalRecordingJobResponse = {
  ok: boolean;
  job: PhysicalRecordingJob;
};

type PhysicalRecordingResponse = {
  ok: boolean;
  recording: PhysicalRecording;
};

export type ScenarioSetup = {
  regionCount: number;
  minRegionCount: number;
  maxRegionCount: number;
  shuttleCount: number;
  minShuttleCount: number;
  maxShuttleCount: number;
  storageColumns: number;
  storageRows: number;
  storageCapacity: number;
  physicalLiftCount: number;
  inboundLiftCount: number;
  outboundLiftCount: number;
  initialOutboundFullColumns: number;
  maxInitialOutboundFullColumns: number;
};

type ScenarioSetupResponse = {
  ok: boolean;
  setup: ScenarioSetup;
  scenario: ShuttleScenario;
  state: ShuttleSimState;
};

type LiveStreamSnapshot = {
  simTimeSec: number;
  vehicles: VehicleState[] | null;
  kpis: KpiSnapshot | null;
};

type PphHistorySample = {
  simTimeSec: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  liftPph: Record<string, number>;
};

type FastRunProgress = {
  active: boolean;
  targetSec: number;
  latestSec: number;
  startedAtMs: number;
  elapsedMs: number;
  chunksCompleted: number;
};

type ReplayControlState = {
  active: boolean;
  playing: boolean;
  cursorSec: number;
  speed: number;
};

type MapViewMode = '3d' | 'lite' | '2d';
type WorkspaceTab = 'view' | 'statistics' | 'diagnostics';

const MAX_PPH_HISTORY_SAMPLES = 240;
const SIX_HOURS_SEC = 6 * 60 * 60;
const THREE_HOURS_SEC = 3 * 60 * 60;
const FAST_RUN_CHUNK_SEC = 10;
const RECORDING_SAMPLE_INTERVAL_SEC = 5;
const REPLAY_SPEEDS = [1, 2, 4, 10, 20] as const;

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
    sourceBufferOccupied: number;
    sourceBufferCapacity: number;
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
    label: 'Turn time',
    path: '/physicsParams/switchDirectionSec',
    min: 0,
    max: 2,
    step: 0.05,
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
    label: 'Source buffer',
    path: '/trafficPolicy/sourceBufferCapacity',
    min: 1,
    max: 8,
    step: 1,
    unit: 'loads'
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

const PLAYBACK_SPEEDS = [1, 2, 4, 10, 100] as const;
const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'view', label: '2D / 3D View' },
  { id: 'statistics', label: 'Statistics' },
  { id: 'diagnostics', label: 'Diagnostics' }
];
const API_BASE_URL = import.meta.env.VITE_SHUTTLE_API_TARGET?.replace(/\/$/, '') ?? '';
const DEFAULT_SCENE_CAMERA_VIEW: ShuttleSceneCameraView = {
  zoom: 1.28,
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

function formatVehicleOperationalLabel(vehicle: VehicleState): string {
  if (!vehicle.taskId && vehicle.localRouteReason === 'outbound-lift-clearance') {
    return 'clearing lift';
  }
  if (!vehicle.taskId && vehicle.localRouteReason === 'post-dropoff-column-exit') {
    return 'leaving storage';
  }
  if (!vehicle.taskId && vehicle.plannedGoalNodeId && vehicle.plannedGoalNodeId !== vehicle.currentNodeId) {
    return 'clearance move';
  }
  return formatVehicleState(vehicle.state);
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

export function inferTopLiftRegionCount(scenario: ShuttleScenario | null | undefined): number {
  if (!scenario) return 2;
  const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
  const storageRows = new Set(storageNodes.map((node) => node.z)).size;
  const storageColumns = storageRows > 0 ? Math.round(storageNodes.length / storageRows) : 0;
  if (scenario.layout.calibrationProfile?.id === 'top-lift-column-v1' && storageColumns > 0) {
    return Math.max(1, Math.round(storageColumns / 14));
  }
  const inboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound').length;
  return Math.max(1, inboundLiftCount);
}

export function summarizeScenarioSetup(scenario: ShuttleScenario | null | undefined): ScenarioSetup | null {
  if (!scenario) return null;
  const contract = summarizeScenarioStaticSceneContract(scenario);
  const inboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound').length;
  const outboundLiftCount = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound').length;

  return {
    regionCount: inferTopLiftRegionCount(scenario),
    minRegionCount: 1,
    maxRegionCount: 8,
    shuttleCount: scenario.vehicles.count,
    minShuttleCount: 1,
    maxShuttleCount: 64,
    storageColumns: contract.storageColumns,
    storageRows: contract.storageRows,
    storageCapacity: contract.storageCellCount,
    physicalLiftCount: inboundLiftCount + outboundLiftCount,
    inboundLiftCount,
    outboundLiftCount,
    initialOutboundFullColumns: scenario.taskGeneration.initialOutboundFullColumns,
    maxInitialOutboundFullColumns: contract.storageColumns
  };
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

function createPphHistorySample(simTimeSec: number, kpis: KpiSnapshot): PphHistorySample {
  const outboundPph = displayOutboundPph(kpis);
  return {
    simTimeSec,
    inboundPph: displayInboundPph(kpis),
    outboundPph,
    totalPph: displayTotalPph(kpis),
    liftPph: Object.fromEntries(Object.entries(kpis.liftPph ?? {}).map(([nodeId, value]) => [nodeId, value.pph]))
  };
}

function displayInboundPph(kpis: KpiSnapshot): number {
  return kpis.pphWindowSec > 0 ? kpis.windowInboundPph : kpis.inboundPph;
}

function displayOutboundPph(kpis: KpiSnapshot): number {
  return kpis.pphWindowSec > 0 ? kpis.windowOutboundPph : kpis.outboundPph;
}

function displayTotalPph(kpis: KpiSnapshot): number {
  return kpis.pphWindowSec > 0 ? kpis.windowTotalPph : kpis.totalPph;
}

function appendPphHistorySample(previous: PphHistorySample[], sample: PphHistorySample): PphHistorySample[] {
  const last = previous.at(-1);
  if (last && sample.simTimeSec < last.simTimeSec) {
    return [sample];
  }
  if (last && Math.abs(sample.simTimeSec - last.simTimeSec) < 0.25) {
    return [...previous.slice(0, -1), sample];
  }
  return [...previous, sample].slice(-MAX_PPH_HISTORY_SAMPLES);
}

function lerpNumber(left: number, right: number, alpha: number): number {
  return left + (right - left) * alpha;
}

function lerpAngleRad(left: number, right: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(right - left), Math.cos(right - left));
  return left + delta * alpha;
}

function physicalRecordingFramePair(
  recording: PhysicalRecording,
  cursorSec: number
): { before: PhysicalRecordingFrame; after: PhysicalRecordingFrame; alpha: number } {
  const frames = recording.frames;
  const first = frames[0]!;
  const last = frames.at(-1)!;
  if (cursorSec <= first.simTimeSec || frames.length === 1) {
    return { before: first, after: first, alpha: 0 };
  }
  if (cursorSec >= last.simTimeSec) {
    return { before: last, after: last, alpha: 0 };
  }

  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle]!.simTimeSec < cursorSec) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const after = frames[low] ?? last;
  const before = frames[Math.max(0, low - 1)] ?? first;
  const span = Math.max(1e-9, after.simTimeSec - before.simTimeSec);
  return { before, after, alpha: Math.min(1, Math.max(0, (cursorSec - before.simTimeSec) / span)) };
}

const MAX_VISUAL_INTERPOLATION_STEP_M = 3;

function vehicleCanInterpolateVisual(left: VehicleState, right: VehicleState): boolean {
  if (left.id !== right.id) {
    return false;
  }
  if (left.loaded !== right.loaded || left.taskId !== right.taskId) {
    return false;
  }
  const distanceM = Math.hypot(right.x - left.x, right.z - left.z);
  if (!Number.isFinite(distanceM) || distanceM > MAX_VISUAL_INTERPOLATION_STEP_M) {
    return false;
  }
  return true;
}

function physicalRecordingStateAt(
  recording: PhysicalRecording,
  cursorSec: number,
  playing: boolean
): ShuttleSimState | null {
  if (recording.frames.length === 0) {
    return null;
  }

  const clampedSec = Math.min(recording.durationSec, Math.max(0, cursorSec));
  const { before, after, alpha } = physicalRecordingFramePair(recording, clampedSec);
  const beforeVehicleById = new Map(before.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const vehicles = after.vehicles.map((vehicle) => {
    const previous = beforeVehicleById.get(vehicle.id);
    if (!previous || alpha <= 0 || !vehicleCanInterpolateVisual(previous, vehicle)) {
      return vehicle;
    }
    return {
      ...vehicle,
      x: lerpNumber(previous.x, vehicle.x, alpha),
      y: lerpNumber(previous.y, vehicle.y, alpha),
      z: lerpNumber(previous.z, vehicle.z, alpha),
      yaw: lerpAngleRad(previous.yaw, vehicle.yaw, alpha)
    };
  });

  return {
    schemaVersion: 'shuttle.phase0.state.v0',
    scenarioId: recording.scenario.id,
    sessionId: `replay-${recording.id}`,
    status: playing ? 'running' : 'paused',
    simTimeSec: clampedSec,
    durationSec: recording.durationSec,
    seed: recording.scenario.seed,
    vehicles,
    tasks: after.tasks,
    loads: after.loads,
    reservations: after.reservations,
    traffic: after.traffic,
    kpis: after.kpis,
    recentEvents: after.recentEvents,
    error: after.error
  };
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
    path === '/trafficPolicy/sourceBufferCapacity' ||
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

function edgeTraversalKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}>${toNodeId}`;
}

function createEdgeTraversalKeys(edges: ShuttleScenario['layout']['edges']): Set<string> {
  const keys = new Set<string>();
  for (const edge of edges) {
    keys.add(edgeTraversalKey(edge.from, edge.to));
    if (edge.directionMode === 'twoWay') {
      keys.add(edgeTraversalKey(edge.to, edge.from));
    }
  }
  return keys;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapPointToAxisAlignedLeg(
  point: { x: number; z: number },
  from: { x: number; z: number },
  to: { x: number; z: number }
): { x: number; z: number } {
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minZ = Math.min(from.z, to.z);
  const maxZ = Math.max(from.z, to.z);
  if (Math.abs(from.x - to.x) <= Math.abs(from.z - to.z)) {
    return { x: from.x, z: clampNumber(point.z, minZ, maxZ) };
  }
  return { x: clampNumber(point.x, minX, maxX), z: from.z };
}

function routeRenderStartPoint(
  vehicle: VehicleState,
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>
): { x: number; z: number } {
  const currentNode = nodeMap.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? nodeMap.get(vehicle.targetNodeId) : null;
  if (vehicle.currentEdgeId && currentNode && targetNode) {
    return snapPointToAxisAlignedLeg(vehicle, currentNode, targetNode);
  }
  if (!vehicle.currentEdgeId && currentNode) {
    return { x: currentNode.x, z: currentNode.z };
  }
  return { x: vehicle.x, z: vehicle.z };
}

function isLiftRouteDisplaySnapNode(nodeId: string): boolean {
  return /^lift-\d{2}-(?:inbound|outbound)-(?:buffer-access|queue-access|queue-\d{2}-(?:access|entry-access|service-exit))$/.test(nodeId) ||
    /^parking-lift-\d{2}-(?:inbound|outbound)-queue(?:-\d{2})?$/.test(nodeId);
}

type TopLiftDisplayRailLevel = 'top-a' | 'top-b';

function topLiftDisplayRailLevel(nodeId: string): TopLiftDisplayRailLevel | null {
  const column = /^column-(top-[ab])-c\d+$/.exec(nodeId);
  if (column) {
    return column[1] as TopLiftDisplayRailLevel;
  }
  const spine = /^(?:module-\d+|module-boundary-\d+)-spine-(top-[ab])$/.exec(nodeId);
  return spine ? spine[1] as TopLiftDisplayRailLevel : null;
}

function isTopLiftDisplayRailNode(nodeId: string): boolean {
  return topLiftDisplayRailLevel(nodeId) !== null;
}

function defaultLiftRouteDisplaySnapLevel(nodeId: string): TopLiftDisplayRailLevel | null {
  const role = liftWorkcellNodeRole(nodeId);
  if (role === 'outbound') {
    return 'top-a';
  }
  if (role === 'inbound') {
    return 'top-b';
  }
  return null;
}

function isTopLiftDisplayRailLevelNode(nodeId: string, level: TopLiftDisplayRailLevel): boolean {
  return new RegExp(`^column-${level}-c\\d+$`).test(nodeId) ||
    new RegExp(`^(?:module-\\d+|module-boundary-\\d+)-spine-${level}$`).test(nodeId);
}

function liftDisplayLevelForRouteNode(nodeIds: string[], index: number): TopLiftDisplayRailLevel | null {
  const nodeId = nodeIds[index];
  if (!nodeId || !isLiftRouteDisplaySnapNode(nodeId)) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previousNodeId = nodeIds[cursor]!;
    const railLevel = topLiftDisplayRailLevel(previousNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftRouteDisplaySnapNode(previousNodeId)) {
      break;
    }
  }

  for (let cursor = index + 1; cursor < nodeIds.length; cursor += 1) {
    const nextNodeId = nodeIds[cursor]!;
    const railLevel = topLiftDisplayRailLevel(nextNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftRouteDisplaySnapNode(nextNodeId)) {
      break;
    }
  }

  return defaultLiftRouteDisplaySnapLevel(nodeId);
}

function liftDisplayLevelsForRoute(nodeIds: string[]): Array<TopLiftDisplayRailLevel | null> {
  return nodeIds.map((_, index) => liftDisplayLevelForRouteNode(nodeIds, index));
}

function routeDisplayPointForNode(
  nodeId: string,
  fallback: { x: number; z: number },
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>,
  preferredLevel: TopLiftDisplayRailLevel | null = null
): { x: number; z: number } {
  if (!isLiftRouteDisplaySnapNode(nodeId)) {
    return fallback;
  }
  let nearest: ShuttleScenario['layout']['nodes'][number] | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const displayLevel = preferredLevel ?? defaultLiftRouteDisplaySnapLevel(nodeId);
  for (const node of nodeMap.values()) {
    if (displayLevel ? !isTopLiftDisplayRailLevelNode(node.id, displayLevel) : !isTopLiftDisplayRailNode(node.id)) {
      continue;
    }
    const distance = Math.hypot(node.x - fallback.x, node.z - fallback.z);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest ? { x: nearest.x, z: nearest.z } : fallback;
}

function routeDisplayPointForVehicle(
  vehicle: VehicleState,
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>,
  currentPreferredLevel: TopLiftDisplayRailLevel | null = null,
  targetPreferredLevel: TopLiftDisplayRailLevel | null = null
): { x: number; z: number } {
  const rawPoint = { x: vehicle.x, z: vehicle.z };
  const currentNode = nodeMap.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? nodeMap.get(vehicle.targetNodeId) : null;
  if (
    vehicle.currentEdgeId &&
    currentNode &&
    targetNode &&
    (isLiftRouteDisplaySnapNode(currentNode.id) || isLiftRouteDisplaySnapNode(targetNode.id))
  ) {
    const dx = targetNode.x - currentNode.x;
    const dz = targetNode.z - currentNode.z;
    const lengthSq = dx * dx + dz * dz;
    const progress = lengthSq <= 1e-9
      ? 0
      : clampNumber(((rawPoint.x - currentNode.x) * dx + (rawPoint.z - currentNode.z) * dz) / lengthSq, 0, 1);
    const displayFrom = routeDisplayPointForNode(currentNode.id, { x: currentNode.x, z: currentNode.z }, nodeMap, currentPreferredLevel);
    const displayTo = routeDisplayPointForNode(targetNode.id, { x: targetNode.x, z: targetNode.z }, nodeMap, targetPreferredLevel);
    return {
      x: displayFrom.x + (displayTo.x - displayFrom.x) * progress,
      z: displayFrom.z + (displayTo.z - displayFrom.z) * progress
    };
  }
  return routeDisplayPointForNode(vehicle.currentNodeId, rawPoint, nodeMap, currentPreferredLevel);
}

function routeDisplayPointForVehicleState(
  vehicle: VehicleState,
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>
): { x: number; z: number } {
  const routeNodeIds = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
  const fallbackRouteNodeIds = routeNodeIds.length >= 2 ? routeNodeIds : remainingRouteNodeIds(vehicle, vehicle.routeNodeIds);
  const displayLevels = liftDisplayLevelsForRoute(fallbackRouteNodeIds);
  return routeDisplayPointForVehicle(vehicle, nodeMap, displayLevels[0] ?? null, displayLevels[1] ?? null);
}

function routeRenderSegments(
  vehicle: VehicleState,
  nodeIds: string[],
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>,
  edgeTraversalKeys: Set<string>
): Array<{ from: { x: number; z: number }; to: { x: number; z: number }; fromNodeId: string; toNodeId: string }> {
  if (nodeIds.length < 2) {
    return [];
  }
  const displayLevels = liftDisplayLevelsForRoute(nodeIds);
  const segments: Array<{ from: { x: number; z: number }; to: { x: number; z: number }; fromNodeId: string; toNodeId: string }> = [];
  let fromNodeId = nodeIds[0]!;
  let graphFromPoint = routeRenderStartPoint(vehicle, nodeMap);
  let displayFromPoint = routeDisplayPointForVehicle(vehicle, nodeMap, displayLevels[0] ?? null, displayLevels[1] ?? null);
  for (let index = 1; index < nodeIds.length; index += 1) {
    const toNodeId = nodeIds[index]!;
    const toNode = nodeMap.get(toNodeId);
    if (!toNode) {
      fromNodeId = toNodeId;
      continue;
    }
    const graphToPoint = { x: toNode.x, z: toNode.z };
    const displayToPoint = routeDisplayPointForNode(toNodeId, graphToPoint, nodeMap, displayLevels[index] ?? null);
    if (
      edgeTraversalKeys.has(edgeTraversalKey(fromNodeId, toNodeId)) &&
      isAxisAlignedSegment(graphFromPoint, graphToPoint) &&
      isAxisAlignedSegment(displayFromPoint, displayToPoint) &&
      Math.hypot(displayToPoint.x - displayFromPoint.x, displayToPoint.z - displayFromPoint.z) > 1e-6
    ) {
      segments.push({ from: displayFromPoint, to: displayToPoint, fromNodeId, toNodeId });
    }
    fromNodeId = toNodeId;
    graphFromPoint = graphToPoint;
    displayFromPoint = displayToPoint;
  }
  return segments;
}

function isModuleBoundaryEdge(edge: ShuttleScenario['layout']['edges'][number]): boolean {
  return edge.from.startsWith('module-boundary-') || edge.to.startsWith('module-boundary-');
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
      sourceBufferOccupied: liftPorts.reduce((sum, port) => sum + (port.sourceBufferOccupancy ?? 0), 0),
      sourceBufferCapacity: liftPorts.reduce((sum, port) => sum + (port.sourceBufferCapacity ?? 1), 0),
      inboundEnabled: liftPorts.filter((port) => port.kind === 'inbound').length,
      outboundEnabled: liftPorts.filter((port) => port.kind === 'outbound').length,
      queuedTasks: liftPorts.reduce((sum, port) => sum + port.queueLength, 0),
      averageUtilizationPct: average(liftUtilizationValues) * 100,
      inboundAverageUtilizationPct: average(inboundLiftUtilizationValues) * 100,
      outboundAverageUtilizationPct: average(outboundLiftUtilizationValues) * 100
    }
  };
}

function KpiStrip({ scenario, kpis }: { scenario: ShuttleScenario | null; kpis: KpiSnapshot | null }) {
  const averageUtilizationPct = kpis
    ? average(Object.values(kpis.vehicleUtilization)) * 100
    : 0;
  const utilizationBreakdowns = kpis ? Object.values(kpis.vehicleUtilizationBreakdown) : [];
  const averageWaitingPct = average(utilizationBreakdowns.map((breakdown) => breakdown.waiting)) * 100;
  const requestedTotalPph = scenario
    ? scenario.taskGeneration.inboundRatePerHour + scenario.taskGeneration.outboundRatePerHour
    : null;
  const seedNote = kpis && kpis.completedSeededOutbound > 0
    ? `${formatNumber(kpis.pphWindowSec, 0)}s rolling; ${kpis.completedSeededOutbound} seeded out raw`
    : null;
  const items = [
    ['Achieved total PPH', kpis ? formatNumber(displayTotalPph(kpis), 1) : '--'],
    ['Achieved inbound PPH', kpis ? formatNumber(displayInboundPph(kpis), 1) : '--'],
    ['Achieved outbound PPH', kpis ? formatNumber(displayOutboundPph(kpis), 1) : '--'],
    ['Requested total PPH', requestedTotalPph !== null ? formatNumber(requestedTotalPph, 0) : '--'],
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
          {label === 'Achieved outbound PPH' && seedNote ? <small>{seedNote}</small> : null}
          {label === 'Requested total PPH' ? <small>inbound + outbound task pressure</small> : null}
        </div>
      ))}
    </section>
  );
}

function DesSummaryPanel({ result }: { result: HeadlessDesResult | null }) {
  const durationHours = result ? result.durationSec / 3600 : 0;
  const items = [
    {
      label: 'Capacity horizon',
      value: result ? `${formatNumber(durationHours, durationHours >= 24 ? 0 : 1)}h` : '--',
      detail: result ? `${formatNumber(result.wallClockMs, 0)} ms wall clock, ${formatNumber(result.processedEvents, 0)} events` : 'capacity DES, not physical traffic'
    },
    {
      label: 'Capacity PPH',
      value: result ? formatNumber(result.totalPph, 1) : '--',
      detail: result ? `in ${formatNumber(result.inboundPph, 1)} / out ${formatNumber(result.outboundPph, 1)}` : 'excludes avoidance and deadlock risk'
    },
    {
      label: 'Capacity queues',
      value: result ? `${result.activeTasks}/${result.queuedTasks}` : '--',
      detail: result ? `active / queued, skipped ${formatNumber(result.skippedInbound + result.skippedOutbound, 0)} demand ticks` : 'skipped means not backlogged'
    },
    {
      label: 'Capacity storage',
      value: result ? `${formatNumber(result.storageUtilization * 100, 1)}%` : '--',
      detail: result ? `${result.storedLoads}/${result.storageCapacity} stored, anomalies ${result.anomalyMarkers.length}` : 'long-run inventory balance'
    }
  ];

  return (
    <section className="des-summary-panel" aria-label="Headless DES summary">
      <div className="panel-head compact">
        <div>
          <h2>Capacity DES</h2>
          <p>Fast capacity estimate for long horizons. It does not validate grid traffic, avoidance, queue behavior, or animation.</p>
        </div>
      </div>
      <div className="des-summary-grid">
        {items.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
          </div>
        ))}
      </div>
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
        <span>Ideal no-conflict fleet</span>
        <strong>{theory ? formatNumber(theory.fleetPph, 1) : '--'} PPH</strong>
        <small>{theory ? `${theory.shuttleCount} shuttles, no traffic hold` : 'same layout'}</small>
      </div>
      <div>
        <span>Achieved vs ideal</span>
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

function pphSeriesPoints(history: PphHistorySample[], valueForSample: (sample: PphHistorySample) => number): string {
  if (history.length === 0) {
    return '';
  }
  const minTime = history[0]!.simTimeSec;
  const maxTime = Math.max(minTime + 1, history.at(-1)!.simTimeSec);
  const maxValue = Math.max(1, ...history.map(valueForSample));
  return history
    .map((sample) => {
      const x = ((sample.simTimeSec - minTime) / (maxTime - minTime)) * 100;
      const y = 32 - (valueForSample(sample) / maxValue) * 28;
      return `${formatNumber(x, 2)},${formatNumber(y, 2)}`;
    })
    .join(' ');
}

function niceAxisCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 100;
  }
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * exponent;
}

function pphTrendPoints(
  history: PphHistorySample[],
  valueForSample: (sample: PphHistorySample) => number,
  maxValue: number
): string {
  if (history.length === 0) {
    return '';
  }
  const minTime = history[0]!.simTimeSec;
  const maxTime = Math.max(minTime + 1, history.at(-1)!.simTimeSec);
  const plotLeft = 14;
  const plotRight = 114;
  const plotTop = 6;
  const plotBottom = 50;
  return history
    .map((sample) => {
      const x = plotLeft + ((sample.simTimeSec - minTime) / (maxTime - minTime)) * (plotRight - plotLeft);
      const y = plotBottom - (Math.max(0, valueForSample(sample)) / maxValue) * (plotBottom - plotTop);
      return `${formatNumber(x, 2)},${formatNumber(y, 2)}`;
    })
    .join(' ');
}

function PphSparkline({ history, liftId, kind }: { history: PphHistorySample[]; liftId: string; kind: 'inbound' | 'outbound' }) {
  const points = pphSeriesPoints(history, (sample) => sample.liftPph[liftId] ?? 0);
  return (
    <svg className="pph-sparkline" viewBox="0 0 100 36" role="img" aria-label={`${liftId} PPH trend`}>
      <polyline className={`pph-line ${kind}`} points={points} />
    </svg>
  );
}

function PphTrendChart({ history }: { history: PphHistorySample[] }) {
  const maxPph = niceAxisCeil(Math.max(
    1,
    ...history.flatMap((sample) => [sample.totalPph, sample.inboundPph, sample.outboundPph])
  ));
  const totalPoints = pphTrendPoints(history, (sample) => sample.totalPph, maxPph);
  const inboundPoints = pphTrendPoints(history, (sample) => sample.inboundPph, maxPph);
  const outboundPoints = pphTrendPoints(history, (sample) => sample.outboundPph, maxPph);
  const latest = history.at(-1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: maxPph * ratio,
    y: 50 - ratio * 44
  }));

  return (
    <section className="pph-trend-panel" aria-label="PPH trend">
      <div className="panel-head compact">
        <h2>PPH Trend</h2>
        <span>{latest ? formatClock(latest.simTimeSec) : '--'}</span>
      </div>
      <svg className="pph-trend-chart" viewBox="0 0 120 64" role="img" aria-label="Total inbound outbound PPH time curve">
        {yTicks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid-line" x1="14" x2="114" y1={tick.y} y2={tick.y} />
            <text className="chart-axis-label y-axis" x="11" y={tick.y + 1.8}>
              {formatNumber(tick.value, tick.value >= 100 ? 0 : 1)}
            </text>
          </g>
        ))}
        <line className="chart-axis-line" x1="14" x2="114" y1="50" y2="50" />
        <line className="chart-axis-line" x1="14" x2="14" y1="6" y2="50" />
        <polyline className="pph-line total" points={totalPoints} />
        <polyline className="pph-line inbound" points={inboundPoints} />
        <polyline className="pph-line outbound" points={outboundPoints} />
        <text className="chart-axis-label x-axis" x="14" y="60">
          {history[0] ? formatClock(history[0].simTimeSec) : '--'}
        </text>
        <text className="chart-axis-label x-axis end" x="114" y="60">
          {latest ? formatClock(latest.simTimeSec) : '--'}
        </text>
      </svg>
      <div className="pph-legend">
        <span className="total">Total {latest ? formatNumber(latest.totalPph, 1) : '--'}</span>
        <span className="inbound">Inbound {latest ? formatNumber(latest.inboundPph, 1) : '--'}</span>
        <span className="outbound">Outbound {latest ? formatNumber(latest.outboundPph, 1) : '--'}</span>
      </div>
    </section>
  );
}

function VehicleTimeStackedBarChart({
  vehicles,
  kpis
}: {
  vehicles: VehicleState[];
  kpis: KpiSnapshot | null;
}) {
  const breakdownByVehicle = kpis?.vehicleUtilizationBreakdown ?? {};
  const segments = [
    { key: 'productiveMoving', label: 'Moving', className: 'moving' },
    { key: 'handling', label: 'Lift/handle', className: 'handling' },
    { key: 'waiting', label: 'Traffic wait', className: 'waiting' },
    { key: 'tasklessTravel', label: 'Reposition', className: 'taskless' },
    { key: 'idle', label: 'Idle', className: 'idle' }
  ] as const;
  const rows = vehicles.map((vehicle) => {
    const breakdown = breakdownByVehicle[vehicle.id];
    const productiveMoving = breakdown ? Math.max(0, breakdown.moving - breakdown.tasklessTravel) : 0;
    return {
      vehicle,
      values: {
        productiveMoving,
        handling: breakdown?.handling ?? 0,
        waiting: breakdown?.waiting ?? 0,
        tasklessTravel: breakdown?.tasklessTravel ?? 0,
        idle: breakdown?.idle ?? 0
      }
    };
  });

  return (
    <section className="vehicle-time-panel" aria-label="Shuttle time allocation">
      <div className="panel-head compact">
        <h2>Shuttle Time</h2>
        <span>{vehicles.length} units</span>
      </div>
      <div className="vehicle-time-legend">
        {segments.map((segment) => (
          <span className={segment.className} key={segment.key}>{segment.label}</span>
        ))}
      </div>
      <div className="vehicle-time-bars">
        {rows.map((row) => (
          <div className="vehicle-time-row" key={row.vehicle.id}>
            <div className="vehicle-time-label">
              <strong>{row.vehicle.id}</strong>
              <small>{formatVehicleState(row.vehicle.state)}</small>
            </div>
            <div className="vehicle-time-bar" aria-label={`${row.vehicle.id} time allocation`}>
              {segments.map((segment) => {
                const value = row.values[segment.key];
                return (
                  <span
                    className={`vehicle-time-segment ${segment.className}`}
                    key={segment.key}
                    style={{ width: `${Math.max(0, value) * 100}%` }}
                    title={`${segment.label}: ${formatNumber(value * 100, 1)}%`}
                  />
                );
              })}
            </div>
            <span className="vehicle-time-total">
              {formatNumber((kpis?.vehicleUtilization[row.vehicle.id] ?? 0) * 100, 1)}% busy
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiftPphPanel({
  state,
  kpis,
  history
}: {
  state: ShuttleSimState | null;
  kpis: KpiSnapshot | null;
  history: PphHistorySample[];
}) {
  const liftPorts = state?.traffic.liftPorts ?? [];
  const liftPph = kpis?.liftPph ?? {};
  const entries = liftPorts.map((port) => ({
    nodeId: port.nodeId,
    kind: port.kind,
    pph: port.pph ?? liftPph[port.nodeId]?.pph ?? 0,
    completed: port.completedTasks ?? liftPph[port.nodeId]?.completed ?? 0,
    activeTaskId: port.activeTaskId,
    approachOccupancy: port.approachOccupancy ?? 0,
    approachCapacity: port.approachCapacity ?? 1,
    queueLength: port.queueLength,
    sourceBufferOccupancy: port.sourceBufferOccupancy ?? 0,
    sourceBufferCapacity: port.sourceBufferCapacity ?? 1
  }));

  return (
    <section className="lift-pph-panel" aria-label="Per lift PPH">
      <div className="panel-head compact">
        <h2>Lift PPH</h2>
        <span>{entries.length} ports</span>
      </div>
      <div className="lift-pph-grid">
        {entries.length === 0 ? (
          <p className="muted">No lift diagnostics yet.</p>
        ) : (
          entries.map((entry) => (
            <div className={`lift-pph-card ${entry.kind}`} key={entry.nodeId}>
              <div>
                <span>{entry.nodeId}</span>
                <strong>{formatNumber(entry.pph, 1)} PPH</strong>
              </div>
              <PphSparkline history={history} liftId={entry.nodeId} kind={entry.kind} />
              <small>
                {entry.completed} done, approach {entry.approachOccupancy}/{entry.approachCapacity}, q{entry.queueLength}
                {entry.kind === 'inbound' ? `, buffer ${entry.sourceBufferOccupancy}/${entry.sourceBufferCapacity}` : ''}
                {entry.activeTaskId ? `, active ${entry.activeTaskId}` : ''}
              </small>
            </div>
          ))
        )}
      </div>
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
                <td><span className={`state-pill ${vehicle.state}`}>{formatVehicleOperationalLabel(vehicle)}</span></td>
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
  if (policy === 'rowContiguousLaneFill') return 'row-contiguous lane-fill';
  if (policy === 'columnContiguousBottomToTopFill') return 'column bottom-to-top fill';
  return policy;
}

function formatStorageFlow(flow: string): string {
  if (flow === 'rightToLeft') return 'right-to-left';
  if (flow === 'bottomToTop') return 'bottom-to-top';
  if (flow === 'leftPick') return 'left pick';
  return flow;
}

function vehicleDisplayNumber(vehicleId: string): string {
  const ordinal = Number(vehicleId.replace(/\D+/g, ''));
  return Number.isFinite(ordinal) && ordinal > 0 ? String(ordinal) : vehicleId.replace(/^SH-?/i, '');
}

function liftWorkcellNodeRole(nodeId: string): 'inbound' | 'outbound' | null {
  const match = /^(?:lift|parking-lift)-\d{2}-(inbound|outbound)(?:$|-)/.exec(nodeId);
  return match ? match[1] as 'inbound' | 'outbound' : null;
}

function isLiftServiceExitNode(nodeId: string): boolean {
  return /^lift-\d{2}-(?:inbound|outbound)-queue-\d{2}-service-exit$/.test(nodeId);
}

function isLiftWorkcellDisplayNode(node: ShuttleScenario['layout']['nodes'][number]): boolean {
  return node.type === 'inbound' ||
    node.type === 'outbound' ||
    node.type === 'lift-blackbox' ||
    node.id.startsWith('lift-') ||
    node.id.startsWith('parking-lift-');
}

type LiftVisualWorkcell = {
  key: string;
  role: 'inbound' | 'outbound';
  liftNodeId: string;
  bufferNodeIds: string[];
  dockNodeIds: string[];
  transferPairs: Array<{ fromNodeId: string; toNodeId: string }>;
};

function liftWorkcellKeyParts(nodeId: string): { number: string; role: 'inbound' | 'outbound'; key: string; prefix: string } | null {
  const match = /^(?:lift|parking-lift)-(\d{2})-(inbound|outbound)(?:$|-)/.exec(nodeId);
  if (!match) return null;
  const role = match[2] as 'inbound' | 'outbound';
  return {
    number: match[1]!,
    role,
    key: `lift-${match[1]}-${role}`,
    prefix: `lift-${match[1]}-${role}`
  };
}

function topRailDockLevel(nodeId: string): 'a' | 'b' | null {
  const match = /^column-top-([ab])-c\d+$/.exec(nodeId);
  return match ? match[1] as 'a' | 'b' : null;
}

function createLiftVisualWorkcells(
  nodes: ShuttleScenario['layout']['nodes'],
  edges: ShuttleScenario['layout']['edges']
): LiftVisualWorkcell[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const workcells = new Map<string, LiftVisualWorkcell>();
  const ensure = (parts: NonNullable<ReturnType<typeof liftWorkcellKeyParts>>, liftNodeId = '') => {
    const existing = workcells.get(parts.key);
    if (existing) {
      if (liftNodeId) existing.liftNodeId = liftNodeId;
      return existing;
    }
    const next: LiftVisualWorkcell = {
      key: parts.key,
      role: parts.role,
      liftNodeId,
      bufferNodeIds: [],
      dockNodeIds: [],
      transferPairs: []
    };
    workcells.set(parts.key, next);
    return next;
  };

  for (const node of nodes) {
    const parts = liftWorkcellKeyParts(node.id);
    if (!parts) continue;
    const visual = ensure(parts, node.type === 'lift-blackbox' ? node.id : '');
    if ((node.type === 'inbound' || node.type === 'outbound') && node.type === parts.role) {
      visual.bufferNodeIds.push(node.id);
    } else if (isLiftServiceExitNode(node.id)) {
      visual.dockNodeIds.push(node.id);
    }
  }

  for (const edge of edges) {
    for (const [liftSide, railSide] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      const parts = liftWorkcellKeyParts(liftSide);
      const railLevel = topRailDockLevel(railSide);
      if (!parts || !railLevel) continue;
      const expectedDockLevel = parts.role === 'inbound' ? 'b' : 'a';
      if (railLevel !== expectedDockLevel) continue;
      const visual = ensure(parts);
      if (!visual.dockNodeIds.length && !visual.dockNodeIds.includes(railSide)) {
        visual.dockNodeIds.push(railSide);
      }
    }
  }

  for (const visual of workcells.values()) {
    visual.bufferNodeIds.sort((leftId, rightId) => {
      const left = nodeMap.get(leftId);
      const right = nodeMap.get(rightId);
      return (right?.z ?? 0) - (left?.z ?? 0) || leftId.localeCompare(rightId);
    });
    visual.dockNodeIds.sort((leftId, rightId) => {
      const left = nodeMap.get(leftId);
      const right = nodeMap.get(rightId);
      return (left?.x ?? 0) - (right?.x ?? 0) || leftId.localeCompare(rightId);
    });
    const anchorNodeId = visual.bufferNodeIds[0] ?? visual.liftNodeId;
    visual.transferPairs = anchorNodeId
      ? visual.dockNodeIds.map((dockNodeId) => ({ fromNodeId: anchorNodeId, toNodeId: dockNodeId }))
      : [];
  }

  return [...workcells.values()]
    .filter((visual) => visual.liftNodeId)
    .sort((left, right) => left.key.localeCompare(right.key));
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
    const staticScene = scenario ? summarizeScenarioStaticSceneContract(scenario) : null;

    const project = (point: { x: number; z: number }) => ({
      left: `${((point.x - minX) / width) * 100}%`,
      top: `${(1 - (point.z - minZ) / depth) * 100}%`
    });

    const projectRect = (rect: { minX: number; maxX: number; minZ: number; maxZ: number }) => {
      const left = ((rect.minX - minX) / width) * 100;
      const right = ((rect.maxX - minX) / width) * 100;
      const top = (1 - (rect.maxZ - minZ) / depth) * 100;
      const bottom = (1 - (rect.minZ - minZ) / depth) * 100;
      return {
        left: `${left}%`,
        top: `${top}%`,
        width: `${right - left}%`,
        height: `${bottom - top}%`
      };
    };

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

    return {
      nodes,
      nodeMap,
      edges: scenario?.layout.edges ?? [],
      edgeTraversalKeys: createEdgeTraversalKeys(scenario?.layout.edges ?? []),
      aisleRects: staticScene ? createTrackAreaRects(staticScene, ['sideAisle', 'crossAisle']) : [],
      connectorRects: staticScene ? createTrackAreaRects(staticScene, ['inboundConnector', 'outboundConnector']) : [],
      storageCellRects: staticScene ? createStorageCellRects(staticScene) : [],
      liftVisuals: createLiftVisualWorkcells(nodes, scenario?.layout.edges ?? []),
      project,
      projectRect,
      routeSegmentStyle
    };
  }, [scenario]);

  const loads = state?.loads.filter((load) => load.nodeId && load.state !== 'carried') ?? [];
  const activeReservations = state?.reservations ?? [];
  const activeTasks = state?.tasks.filter((task) => task.vehicleId && task.state !== 'completed' && task.state !== 'failed') ?? [];
  const vehicleById = new Map((state?.vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const routeSegments = (vehicle: VehicleState, nodeIds: string[], kind: 'planned' | 'local') => {
    return routeRenderSegments(vehicle, nodeIds, geometry.nodeMap, geometry.edgeTraversalKeys)
      .map((segment, index) => ({
        key: `${vehicle.id}-${kind}-${index}`,
        vehicle,
        kind,
        from: segment.from,
        to: segment.to
      }));
  };

  return (
    <div className="authoritative-map" aria-label="Authoritative state map">
      {geometry.aisleRects.map((rect) => (
        <span className={`map-area ${rect.category}`} key={rect.id} style={geometry.projectRect(rect)} />
      ))}
      {layers.physics && geometry.connectorRects.map((rect) => (
        <span className={`map-area ${rect.category}`} key={rect.id} style={geometry.projectRect(rect)} />
      ))}
      {geometry.storageCellRects.map((rect) => (
        <span className="map-storage-cell" key={rect.id} style={geometry.projectRect(rect)} />
      ))}
      {geometry.liftVisuals.flatMap((visual) => visual.transferPairs.map((pair) => {
        const from = geometry.nodeMap.get(pair.fromNodeId);
        const to = geometry.nodeMap.get(pair.toNodeId);
        return from && to ? (
          <span
            className={`map-lift-transfer flow-${visual.role}`}
            key={`${visual.key}-transfer-${pair.toNodeId}`}
            style={geometry.routeSegmentStyle(from, to)}
          />
        ) : null;
      }))}
      {geometry.liftVisuals.flatMap((visual) => {
        const nodesToRender = [
          { nodeId: visual.liftNodeId, className: 'lift-main', label: visual.role === 'inbound' ? 'IN LIFT' : 'OUT LIFT' },
          ...visual.bufferNodeIds.map((nodeId, index) => ({ nodeId, className: 'lift-buffer', label: String(index + 1) })),
          ...visual.dockNodeIds.map((nodeId) => ({ nodeId, className: 'lift-dock', label: visual.role === 'inbound' ? 'P' : 'D' }))
        ];
        return nodesToRender.map((item) => {
          const node = geometry.nodeMap.get(item.nodeId);
          return node ? (
            <span
              className={`map-lift-equipment ${item.className} flow-${visual.role}`}
              key={`${visual.key}-${item.className}-${item.nodeId}`}
              style={geometry.project(node)}
            >
              {item.label}
            </span>
          ) : null;
        });
      })}
      {geometry.edges.map((edge) => {
        const from = geometry.nodeMap.get(edge.from);
        const to = geometry.nodeMap.get(edge.to);
        if (!from || !to) return null;
        const reserved = layers.traffic && activeReservations.some((reservation) => reservation.resourceId === edge.id);
        if (!reserved) return null;
        return (
          <span
            className={`map-edge ${reserved ? 'reserved' : ''} ${isModuleBoundaryEdge(edge) ? 'module-boundary' : ''}`}
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
        .map((segment) => {
          const taskRole = state ? resolveVehicleTaskFlowRole(state, segment.vehicle) : null;
          return (
            <span
              className={`map-route ${segment.kind} ${segment.vehicle.loaded ? 'loaded' : 'empty'} ${segment.vehicle.taskId ? 'tasked' : 'taskless'} ${taskRole ? `flow-${taskRole}` : ''} ${selectedVehicleId === segment.vehicle.id ? 'selected' : ''}`}
              key={segment.key}
              style={geometry.routeSegmentStyle(segment.from, segment.to)}
            />
          );
        })}
      {geometry.nodes
        .filter((node) => node.type !== 'storage' && node.type !== 'intersection' && node.type !== 'aisle' && !isLiftWorkcellDisplayNode(node))
        .map((node) => (
          <span className={`map-node ${node.type}`} key={node.id} style={geometry.project(node)}>
            {node.id.replace('inbound-lift-', 'in-').replace('outbound-lift-', 'out-')}
          </span>
        ))}
      {layers.loads && loads.map((load) => {
        const node = load.nodeId ? geometry.nodeMap.get(load.nodeId) : null;
        if (!node || (isLiftWorkcellDisplayNode(node) && load.state !== 'waiting')) {
          return null;
        }
        return <span className={`map-load ${load.state} flow-${resolveLoadFlowRole(state!, load)}`} key={load.id} style={geometry.project(node)} />;
      })}
      {activeTasks.map((task) => {
        const vehicle = task.vehicleId ? vehicleById.get(task.vehicleId) : null;
        const pickupNode = geometry.nodeMap.get(task.pickupNodeId);
        if (!vehicle || !pickupNode || vehicle.loaded) {
          return null;
        }
        const liftDockTarget = isLiftWorkcellDisplayNode(pickupNode);
        const pickupPoint = liftDockTarget ? pickupNode : routeDisplayPointForNode(pickupNode.id, pickupNode, geometry.nodeMap);
        return (
          <span
            className={`map-task-badge pickup flow-${task.kind} ${liftDockTarget ? 'lift-dock-target' : ''}`}
            key={task.id}
            style={geometry.project(pickupPoint)}
          >
            P{vehicleDisplayNumber(vehicle.id)}
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
            ...geometry.project(routeDisplayPointForVehicleState(vehicle, geometry.nodeMap)),
            transform: 'translate(-50%, -50%)'
          }}
          title={`${vehicle.id} ${vehicle.loaded ? 'loaded' : vehicle.taskId ? 'to pickup' : formatVehicleOperationalLabel(vehicle)} ${vehicle.currentNodeId}`}
        >
          {vehicleDisplayNumber(vehicle.id)}
        </button>
      ))}
    </div>
  );
}

type LiteMapSnapshot = {
  simTime: number;
  wallMs: number;
  vehicles: Map<string, VehicleState>;
};

type VisualClock = {
  latestSimTime: number | null;
  simTime: number | null;
  wallMs: number | null;
};

const MAX_VISUAL_SNAPSHOTS = 48;
const VISUAL_INTERPOLATION_DELAY_WALL_SEC = 0.45;

function appendLiteMapSnapshot(snapshots: LiteMapSnapshot[], snapshot: LiteMapSnapshot): LiteMapSnapshot[] {
  const latest = snapshots.at(-1);
  if (!latest || snapshot.simTime < latest.simTime - 1e-9) {
    return [snapshot];
  }
  if (Math.abs(snapshot.simTime - latest.simTime) < 1e-9) {
    return [...snapshots.slice(0, -1), snapshot];
  }
  return [...snapshots, snapshot].slice(-MAX_VISUAL_SNAPSHOTS);
}

function visualInterpolationDelaySimSec(playbackSpeed: number): number {
  return Math.min(6, Math.max(0.25, playbackSpeed * VISUAL_INTERPOLATION_DELAY_WALL_SEC));
}

function visualRenderSimTime(
  snapshots: LiteMapSnapshot[],
  playbackSpeed: number,
  running: boolean,
  nowMs: number,
  clock: VisualClock
): number {
  const latest = snapshots.at(-1);
  const oldest = snapshots[0];
  if (!latest || !oldest) return 0;
  const estimatedServerNowSec = latest.simTime + Math.max(0, (nowMs - latest.wallMs) / 1000) * playbackSpeed;
  const targetTimeSec = Math.min(
    latest.simTime,
    Math.max(oldest.simTime, estimatedServerNowSec - visualInterpolationDelaySimSec(playbackSpeed))
  );

  if (
    !running ||
    snapshots.length < 2 ||
    clock.simTime === null ||
    clock.wallMs === null ||
    clock.latestSimTime === null ||
    latest.simTime < clock.latestSimTime - 1e-9 ||
    clock.simTime < oldest.simTime - 1e-9 ||
    clock.simTime > latest.simTime + 1e-9
  ) {
    clock.simTime = running ? targetTimeSec : latest.simTime;
    clock.wallMs = nowMs;
    clock.latestSimTime = latest.simTime;
    return clock.simTime;
  }

  const elapsedWallSec = Math.max(0, (nowMs - clock.wallMs) / 1000);
  const nominalNextSec = clock.simTime + elapsedWallSec * playbackSpeed;
  const monotonicTargetSec = targetTimeSec < clock.simTime ? clock.simTime : targetTimeSec;
  const nextSec = Math.min(latest.simTime, Math.max(oldest.simTime, Math.min(nominalNextSec, monotonicTargetSec)));
  clock.simTime = nextSec;
  clock.wallMs = nowMs;
  clock.latestSimTime = latest.simTime;
  return nextSec;
}

function interpolateVehiclesForFrame(
  snapshots: LiteMapSnapshot[],
  playbackSpeed: number,
  running: boolean,
  nowMs: number,
  clock: VisualClock
): VehicleState[] {
  const latest = snapshots.at(-1);
  if (!latest) return [];
  const list = Array.from(latest.vehicles.values());
  if (!running || snapshots.length < 2) return list;

  const renderTime = visualRenderSimTime(snapshots, playbackSpeed, running, nowMs, clock);
  let afterIndex = snapshots.findIndex((snapshot) => snapshot.simTime >= renderTime - 1e-9);
  if (afterIndex < 0) afterIndex = snapshots.length - 1;
  const before = snapshots[Math.max(0, afterIndex - 1)] ?? latest;
  const after = snapshots[afterIndex] ?? latest;
  const snapshotDtSec = after.simTime - before.simTime;
  if (snapshotDtSec <= 0) return list;

  const alpha = Math.min(1, Math.max(0, (renderTime - before.simTime) / snapshotDtSec));
  return Array.from(after.vehicles.values()).map((vehicle) => {
    const previous = before.vehicles.get(vehicle.id);
    if (!previous) return vehicle;
    if (!vehicleCanInterpolateVisual(previous, vehicle)) return alpha >= 1 ? vehicle : previous;
    return {
      ...vehicle,
      x: previous.x + (vehicle.x - previous.x) * alpha,
      z: previous.z + (vehicle.z - previous.z) * alpha,
      yaw: lerpAngleRad(previous.yaw, vehicle.yaw, alpha)
    };
  });
}

function CanvasLiteMap({
  scenario,
  state,
  layers,
  selectedVehicleId,
  playbackSpeed,
  debugMode = false,
  onSelectVehicle
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: SceneLayers;
  selectedVehicleId: string | null;
  playbackSpeed: number;
  debugMode?: boolean;
  onSelectVehicle: (vehicleId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotsRef = useRef<LiteMapSnapshot[]>([]);
  const visualClockRef = useRef<VisualClock>({ latestSimTime: null, simTime: null, wallMs: null });
  const renderInputRef = useRef<{
    state: ShuttleSimState | null;
    layers: SceneLayers;
    selectedVehicleId: string | null;
    playbackSpeed: number;
    debugMode: boolean;
  }>({ state: null, layers, selectedVehicleId, playbackSpeed, debugMode });
  const geometry = useMemo(() => {
    const nodes = scenario?.layout.nodes ?? [];
    const staticScene = scenario ? summarizeScenarioStaticSceneContract(scenario) : null;
    const xValues = nodes.map((node) => node.x);
    const zValues = nodes.map((node) => node.z);
    const minX = Math.min(...xValues, 0) - 2;
    const maxX = Math.max(...xValues, 1) + 2;
    const minZ = Math.min(...zValues, -1) - 2;
    const maxZ = Math.max(...zValues, 1) + 2;
    return {
      nodes,
      edges: scenario?.layout.edges ?? [],
      edgeTraversalKeys: createEdgeTraversalKeys(scenario?.layout.edges ?? []),
      nodeMap: new Map(nodes.map((node) => [node.id, node])),
      aisleRects: staticScene ? createTrackAreaRects(staticScene, ['sideAisle', 'crossAisle']) : [],
      connectorRects: staticScene ? createTrackAreaRects(staticScene, ['inboundConnector', 'outboundConnector']) : [],
      storageCellRects: staticScene ? createStorageCellRects(staticScene) : [],
      liftVisuals: createLiftVisualWorkcells(nodes, scenario?.layout.edges ?? []),
      minX,
      maxX,
      minZ,
      maxZ,
      width: Math.max(1, maxX - minX),
      depth: Math.max(1, maxZ - minZ)
    };
  }, [scenario]);

  useEffect(() => {
    renderInputRef.current = { state, layers, selectedVehicleId, playbackSpeed, debugMode };
    if (state) {
      const snap: LiteMapSnapshot = {
        simTime: state.simTimeSec,
        wallMs: performance.now(),
        vehicles: new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle]))
      };
      snapshotsRef.current = appendLiteMapSnapshot(snapshotsRef.current, snap);
    }
  }, [debugMode, layers, playbackSpeed, selectedVehicleId, state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const { state, layers, selectedVehicleId, playbackSpeed, debugMode } = renderInputRef.current;
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
      context.fillStyle = '#101922';
      context.fillRect(0, 0, width, height);
      context.strokeStyle = 'rgba(178, 205, 223, 0.055)';
      context.lineWidth = 1;
      const guideStepPx = 32;
      for (let x = padding; x <= width - padding; x += guideStepPx) {
        context.beginPath();
        context.moveTo(x, padding);
        context.lineTo(x, height - padding);
        context.stroke();
      }
      for (let y = padding; y <= height - padding; y += guideStepPx) {
        context.beginPath();
        context.moveTo(padding, y);
        context.lineTo(width - padding, y);
        context.stroke();
      }

      const project = (point: { x: number; z: number }) => ({
        x: padding + ((point.x - geometry.minX) / geometry.width) * (width - padding * 2),
        y: padding + ((point.z - geometry.minZ) / geometry.depth) * (height - padding * 2)
      });

      const projectRect = (meterRect: { minX: number; maxX: number; minZ: number; maxZ: number }) => {
        const left = padding + ((meterRect.minX - geometry.minX) / geometry.width) * (width - padding * 2);
        const right = padding + ((meterRect.maxX - geometry.minX) / geometry.width) * (width - padding * 2);
        const top = padding + ((meterRect.minZ - geometry.minZ) / geometry.depth) * (height - padding * 2);
        const bottom = padding + ((meterRect.maxZ - geometry.minZ) / geometry.depth) * (height - padding * 2);
        return { left, top, width: right - left, height: bottom - top };
      };

      const fillMeterRect = (meterRect: { minX: number; maxX: number; minZ: number; maxZ: number }, color: string, alpha: number) => {
        const rect = projectRect(meterRect);
        context.globalAlpha = alpha;
        context.fillStyle = color;
        context.beginPath();
        context.roundRect(rect.left, rect.top, rect.width, rect.height, 3);
        context.fill();
        context.globalAlpha = 1;
      };

      const drawMeterRect = (
        meterRect: { minX: number; maxX: number; minZ: number; maxZ: number },
        fillColor: string,
        strokeColor: string,
        fillAlpha: number,
        strokeAlpha: number
      ) => {
        const rect = projectRect(meterRect);
        context.globalAlpha = fillAlpha;
        context.fillStyle = fillColor;
        context.beginPath();
        context.roundRect(rect.left, rect.top, rect.width, rect.height, 2);
        context.fill();
        context.globalAlpha = strokeAlpha;
        context.strokeStyle = strokeColor;
        context.lineWidth = 1;
        context.stroke();
        context.globalAlpha = 1;
      };

      const drawLiftEquipmentNode = (node: ShuttleScenario['layout']['nodes'][number]) => {
        const role = liftWorkcellNodeRole(node.id);
        if (!role) return;
        const point = project(node);
        context.save();
        if (node.type === 'lift-blackbox') {
          const widthPx = 86;
          const heightPx = 28;
          context.fillStyle = 'rgba(18, 28, 36, 0.94)';
          context.strokeStyle = flowRgba(role, 0.78);
          context.lineWidth = 2;
          context.beginPath();
          context.roundRect(point.x - widthPx / 2, point.y - heightPx / 2, widthPx, heightPx, 4);
          context.fill();
          context.stroke();
          context.fillStyle = flowRgba(role, 0.88);
          context.fillRect(point.x - widthPx / 2 + 3, point.y - heightPx / 2 + 3, widthPx - 6, 2.4);
          context.fillStyle = role === 'outbound' ? '#fff0bd' : '#dff4ff';
          context.font = '900 10px system-ui, sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(role === 'inbound' ? 'IN LIFT' : 'OUT LIFT', point.x + (role === 'inbound' ? -8 : 0), point.y + 1.8);
        } else if (node.type === 'inbound' || node.type === 'outbound' || isLiftServiceExitNode(node.id)) {
          const slotSize = isLiftServiceExitNode(node.id) ? 7.2 : 8.2;
          context.fillStyle = flowRgba(role, isLiftServiceExitNode(node.id) ? 0.72 : 0.52);
          context.strokeStyle = 'rgba(235, 245, 250, 0.78)';
          context.lineWidth = 1.1;
          context.beginPath();
          context.roundRect(point.x - slotSize / 2, point.y - slotSize / 2, slotSize, slotSize, 2);
          context.fill();
          context.stroke();
        }
        context.restore();
      };

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

      const drawLiftDockMarker = (node: ShuttleScenario['layout']['nodes'][number], role: 'inbound' | 'outbound') => {
        const point = project(node);
        context.save();
        context.fillStyle = role === 'inbound' ? 'rgba(18, 42, 62, 0.96)' : 'rgba(66, 49, 18, 0.96)';
        context.strokeStyle = flowRgba(role, 0.9);
        context.lineWidth = 1.8;
        context.beginPath();
        context.roundRect(point.x - 5.5, point.y - 5.5, 11, 11, 2.4);
        context.fill();
        context.stroke();
        context.fillStyle = role === 'outbound' ? '#171207' : '#f8fbff';
        context.font = '900 7px system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(role === 'inbound' ? 'P' : 'D', point.x, point.y + 0.2);
        context.fillStyle = flowRgba(role, 0.96);
        context.beginPath();
        context.arc(point.x, point.y + 8, 2.2, 0, Math.PI * 2);
        context.fill();
        context.restore();
      };

      const drawRoute = (vehicle: VehicleState, nodeIds: string[], color: string, lineWidth: number, alpha: number) => {
        if (nodeIds.length < 2) return;
        const segments = routeRenderSegments(vehicle, nodeIds, geometry.nodeMap, geometry.edgeTraversalKeys);
        if (segments.length === 0) return;
        context.globalAlpha = alpha;
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        for (const segment of segments) {
          const start = project(segment.from);
          const end = project(segment.to);
          context.beginPath();
          context.moveTo(start.x, start.y);
          context.lineTo(end.x, end.y);
          context.stroke();
        }
        context.globalAlpha = 1;
      };

      const drawPickupTargetBadge = (
        point: { x: number; y: number },
        taskKind: 'inbound' | 'outbound',
        vehicleId: string,
        liftDockTarget = false
      ) => {
        const label = `P${vehicleDisplayNumber(vehicleId)}`;
        const badgeWidth = liftDockTarget ? 34 : 22;
        const badgeHeight = liftDockTarget ? 18 : 14;
        const badgeX = point.x + (liftDockTarget ? 13 : 13);
        const badgeY = point.y - (liftDockTarget ? 36 : 23);
        const roleColor = FLOW_VISUAL_COLORS[taskKind].hex;
        context.save();
        context.strokeStyle = flowRgba(taskKind, liftDockTarget ? 0.78 : 0.46);
        context.lineWidth = liftDockTarget ? 2 : 1.2;
        context.beginPath();
        context.moveTo(point.x, point.y);
        context.lineTo(badgeX, badgeY + badgeHeight / 2);
        context.stroke();
        context.fillStyle = flowRgba(taskKind, 0.9);
        context.strokeStyle = '#ffffff';
        context.lineWidth = liftDockTarget ? 1.8 : 1.4;
        context.beginPath();
        context.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 4);
        context.fill();
        context.stroke();
        context.fillStyle = taskKind === 'outbound' ? '#15120b' : '#f8fbff';
        context.font = liftDockTarget ? '900 10px system-ui, sans-serif' : '800 9px system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, badgeX + badgeWidth / 2, badgeY + badgeHeight / 2 + 0.2);
        context.fillStyle = roleColor;
        context.beginPath();
        context.arc(point.x, point.y, 2.8, 0, Math.PI * 2);
        context.fill();
        context.restore();
      };

      const drawVehicleIdBadge = (point: { x: number; y: number }, vehicle: VehicleState, selected: boolean) => {
        const label = vehicleDisplayNumber(vehicle.id);
        const badgeX = point.x + 10;
        const badgeY = point.y - 12;
        context.save();
        context.fillStyle = selected ? '#111820' : 'rgba(17, 24, 32, 0.86)';
        context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        context.lineWidth = 1.2;
        context.beginPath();
        context.roundRect(badgeX - 6, badgeY - 6, 12, 12, 4);
        context.fill();
        context.stroke();
        context.fillStyle = '#f8fbff';
        context.font = '800 8.5px system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, badgeX, badgeY + 0.2);
        context.restore();
      };

      const reservedEdgeIds = new Set(
        layers.traffic
          ? (state?.reservations ?? []).filter((reservation) => reservation.resourceType === 'edge').map((reservation) => reservation.resourceId)
          : []
      );

      for (const rect of geometry.aisleRects) {
        fillMeterRect(rect, '#d6aa2f', 0.15);
      }

      if (layers.physics) {
        for (const rect of geometry.connectorRects) {
          const color = rect.category === 'inboundConnector' ? FLOW_VISUAL_COLORS.inbound.hex : FLOW_VISUAL_COLORS.outbound.hex;
          fillMeterRect(rect, color, 0.15);
        }
      }

      for (const rect of geometry.storageCellRects) {
        drawMeterRect(rect, '#8d78ff', '#b59aff', 0.22, 0.55);
      }

      for (const visual of geometry.liftVisuals) {
        context.save();
        context.setLineDash([4, 3]);
        for (const pair of visual.transferPairs) {
          const from = geometry.nodeMap.get(pair.fromNodeId);
          const to = geometry.nodeMap.get(pair.toNodeId);
          if (from && to) {
            drawLine(from, to, FLOW_VISUAL_COLORS[visual.role].hex, 1.4, 0.42);
          }
        }
        context.setLineDash([]);
        for (const bufferNodeId of visual.bufferNodeIds) {
          const bufferNode = geometry.nodeMap.get(bufferNodeId);
          if (bufferNode) {
            drawLiftEquipmentNode(bufferNode);
          }
        }
        const liftNode = geometry.nodeMap.get(visual.liftNodeId);
        if (liftNode) {
          drawLiftEquipmentNode(liftNode);
        }
        for (const dockNodeId of visual.dockNodeIds) {
          const dockNode = geometry.nodeMap.get(dockNodeId);
          if (dockNode) {
            drawLiftDockMarker(dockNode, visual.role);
          }
        }
        context.restore();
      }

      if (debugMode) {
        for (const edge of geometry.edges) {
          const from = geometry.nodeMap.get(edge.from);
          const to = geometry.nodeMap.get(edge.to);
          if (!from || !to) continue;
          if (!layers.physics && (isLiftWorkcellDisplayNode(from) || isLiftWorkcellDisplayNode(to))) continue;
          drawLine(from, to, edge.directionMode === 'oneWay' ? '#bfa65a' : '#8fa0aa', edge.directionMode === 'oneWay' ? 1.2 : 0.8, edge.directionMode === 'oneWay' ? 0.42 : 0.28);
        }
        context.globalAlpha = 0.58;
        context.fillStyle = '#355a70';
        for (const node of geometry.nodes) {
          if (node.type === 'storage') continue;
          if (!layers.physics && isLiftWorkcellDisplayNode(node)) continue;
          const point = project(node);
          const size = node.noStop ? 3 : 4;
          context.beginPath();
          context.roundRect(point.x - size / 2, point.y - size / 2, size, size, 1);
          context.fill();
        }
        context.globalAlpha = 1;
      }

      for (const edge of geometry.edges) {
        const from = geometry.nodeMap.get(edge.from);
        const to = geometry.nodeMap.get(edge.to);
        if (!from || !to) continue;
        const reserved = reservedEdgeIds.has(edge.id);
        if (!reserved) continue;
        if (!layers.physics && (isLiftWorkcellDisplayNode(from) || isLiftWorkcellDisplayNode(to))) continue;
        const moduleBoundary = isModuleBoundaryEdge(edge);
        drawLine(
          from,
          to,
          reserved ? '#c28a12' : moduleBoundary ? '#4f8fcb' : '#9da8b2',
          reserved ? 2.6 : moduleBoundary ? 2.4 : 1.4,
          reserved ? 0.9 : moduleBoundary ? 0.88 : 0.68
        );
      }

      if (geometry.nodes.length <= 2500) {
        context.globalAlpha = 0.95;
        for (const node of geometry.nodes) {
          if (node.type === 'storage' || node.type === 'intersection' || node.type === 'aisle') {
            continue;
          }
          if (node.type === 'inbound' || node.type === 'outbound') {
            continue;
          } else if (node.type === 'lift-blackbox') {
            continue;
          }
        }
        context.globalAlpha = 1;
      }

      if (layers.physics) {
        for (const node of geometry.nodes) {
          if (isLiftWorkcellDisplayNode(node) && node.type !== 'lift-blackbox' && node.type !== 'inbound' && node.type !== 'outbound') {
            drawLiftEquipmentNode(node);
          }
        }
      }

      if (layers.loads && state) {
        for (const load of state.loads) {
          if (!load.nodeId || load.state === 'carried') continue;
          const node = geometry.nodeMap.get(load.nodeId);
          if (!node) continue;
          if (isLiftWorkcellDisplayNode(node) && load.state !== 'waiting') continue;
          const point = project(node);
          const loadRole = resolveLoadFlowRole(state, load);
          const conveyorLoad = node.type === 'inbound' || node.type === 'outbound' || node.type === 'lift-blackbox' || isLiftServiceExitNode(node.id);
          const sizePx = conveyorLoad ? 5.8 : 8.4;
          context.fillStyle = flowRgba(loadRole, 0.88);
          context.strokeStyle = conveyorLoad ? flowRgba(loadRole, 0.5) : 'rgba(255,255,255,0.72)';
          context.lineWidth = conveyorLoad ? 0.8 : 1.1;
          context.beginPath();
          context.roundRect(point.x - sizePx / 2, point.y - sizePx / 2, sizePx, sizePx, 1.2);
          context.fill();
          context.stroke();
        }
      }

      const nowMs = performance.now();
      const running = state?.status === 'running';
      const renderVehicles = interpolateVehiclesForFrame(
        snapshotsRef.current,
        playbackSpeed,
        running,
        nowMs,
        visualClockRef.current
      );

      if (layers.routes) {
        for (const vehicle of renderVehicles) {
          const selected = selectedVehicleId === vehicle.id;
          const plannedNodes = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
          const taskRole = state ? resolveVehicleTaskFlowRole(state, vehicle) : null;
          const color = taskRole ? FLOW_VISUAL_COLORS[taskRole].hex : '#7c5ed8';
          drawRoute(vehicle, plannedNodes, color, selected ? 3.8 : 3, selected ? 0.96 : 0.76);
          drawRoute(vehicle, vehicle.localRouteNodeIds, '#d29b22', selected ? 4.8 : 4.2, selected ? 0.96 : 0.86);
        }
      }

      if (layers.traffic && state) {
        const vehicleByIdForTraffic = new Map(renderVehicles.map((vehicle) => [vehicle.id, vehicle]));
        for (const waitingVehicle of state.traffic.waitingVehicles) {
          const currentNode = geometry.nodeMap.get(waitingVehicle.currentNodeId);
          const targetNode = waitingVehicle.targetNodeId ? geometry.nodeMap.get(waitingVehicle.targetNodeId) : null;
          if (currentNode && targetNode) {
            const displayCurrent = routeDisplayPointForNode(currentNode.id, currentNode, geometry.nodeMap);
            const displayTarget = routeDisplayPointForNode(targetNode.id, targetNode, geometry.nodeMap);
            drawLine(displayCurrent, displayTarget, '#d65a4a', 3.4, 0.9);
          }
          const currentPoint = currentNode ? project(routeDisplayPointForNode(currentNode.id, currentNode, geometry.nodeMap)) : null;
          if (currentPoint) {
            context.strokeStyle = '#d65a4a';
            context.lineWidth = 2;
            context.globalAlpha = 0.92;
            context.beginPath();
            context.arc(currentPoint.x, currentPoint.y, 9, 0, Math.PI * 2);
            context.stroke();
            context.globalAlpha = 1;
          }
          const blocker = waitingVehicle.blockingVehicleId ? vehicleByIdForTraffic.get(waitingVehicle.blockingVehicleId) : null;
          if (currentNode && blocker) {
            drawLine(
              routeDisplayPointForNode(currentNode.id, currentNode, geometry.nodeMap),
              routeDisplayPointForVehicleState(blocker, geometry.nodeMap),
              '#b7892c',
              1.8,
              0.72
            );
          }
        }
      }

      const activeTasks = state?.tasks.filter((task) => task.vehicleId && task.state !== 'completed' && task.state !== 'failed') ?? [];
      const vehicleById = new Map(renderVehicles.map((vehicle) => [vehicle.id, vehicle]));
      for (const task of activeTasks) {
        const vehicle = task.vehicleId ? vehicleById.get(task.vehicleId) : null;
        const pickupNode = geometry.nodeMap.get(task.pickupNodeId);
        if (!vehicle || !pickupNode || vehicle.loaded) continue;
        const liftDockTarget = isLiftWorkcellDisplayNode(pickupNode);
        const displayPoint = liftDockTarget ? pickupNode : routeDisplayPointForNode(pickupNode.id, pickupNode, geometry.nodeMap);
        const point = project(displayPoint);
        drawPickupTargetBadge(point, task.kind, vehicle.id, liftDockTarget);
      }

      for (const vehicle of renderVehicles) {
        const displayPoint = routeDisplayPointForVehicleState(vehicle, geometry.nodeMap);
        const point = project(displayPoint);
        const selected = selectedVehicleId === vehicle.id;
        const pxPerMeter = Math.min(
          (width - padding * 2) / geometry.width,
          (height - padding * 2) / geometry.depth
        );
        const vehicleWidthPx = clampNumber((scenario?.vehicles.widthM ?? 1.03) * pxPerMeter, 15, 20);
        const vehicleHeightPx = vehicleWidthPx;
        if (layers.physics) {
          const safetyRadiusPx = clampNumber(
            ((scenario?.vehicles.safetyRadiusM ?? 0.4) + (scenario?.trafficPolicy.dynamicAvoidanceClearanceM ?? 0)) * pxPerMeter,
            8,
            34
          );
          const bodyLengthPx = clampNumber((scenario?.vehicles.lengthM ?? 1.03) * pxPerMeter, 15, 28);
          const bodyWidthPx = clampNumber((scenario?.vehicles.widthM ?? 1.03) * pxPerMeter, 15, 24);
          context.save();
          context.translate(point.x, point.y);
          context.strokeStyle = selected ? 'rgba(31, 116, 196, 0.95)' : 'rgba(31, 116, 196, 0.38)';
          context.lineWidth = selected ? 1.8 : 1;
          context.beginPath();
          context.arc(0, 0, safetyRadiusPx, 0, Math.PI * 2);
          context.stroke();
          context.rotate(-vehicle.yaw);
          context.strokeStyle = selected ? 'rgba(17, 24, 32, 0.95)' : 'rgba(17, 24, 32, 0.5)';
          context.strokeRect(-bodyLengthPx / 2, -bodyWidthPx / 2, bodyLengthPx, bodyWidthPx);
          context.restore();
        }
        context.fillStyle = vehicle.state === 'waiting-blocked'
          ? '#b7892c'
          : vehicle.loaded
            ? '#2f9e6d'
            : vehicle.taskId
              ? '#2f8cff'
              : vehicle.state === 'idle'
                ? '#6f7f8c'
                : '#9b83ff';
        context.strokeStyle = selected ? '#f8fbff' : vehicle.loaded ? '#dff6e8' : '#d7edff';
        context.lineWidth = selected ? 2 : 1.5;
        context.shadowColor = 'rgba(20, 28, 34, 0.18)';
        context.shadowBlur = selected ? 5 : 4;
        context.shadowOffsetY = 1.5;
        context.save();
        context.translate(point.x, point.y);
        context.rotate(-vehicle.yaw);
        context.beginPath();
        context.roundRect(-vehicleWidthPx / 2, -vehicleHeightPx / 2, vehicleWidthPx, vehicleHeightPx, 3);
        context.fill();
        context.shadowColor = 'transparent';
        context.stroke();
        context.fillStyle = vehicle.loaded ? '#dff6e8' : '#e7f2ff';
        context.globalAlpha = 0.94;
        context.beginPath();
        context.moveTo(vehicleWidthPx / 2 - 3, 0);
        context.lineTo(vehicleWidthPx / 2 - 9, -4);
        context.lineTo(vehicleWidthPx / 2 - 9, 4);
        context.closePath();
        context.fill();
        context.restore();
        context.shadowColor = 'transparent';
        drawVehicleIdBadge(point, vehicle, selected);
      }
    };

    let frameId = window.requestAnimationFrame(function loop() {
      draw();
      frameId = window.requestAnimationFrame(loop);
    });
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, [geometry]);

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !state) return;
    const rect = canvas.getBoundingClientRect();
    const padding = 16;
    const project = (point: { x: number; z: number }) => ({
      x: padding + ((point.x - geometry.minX) / geometry.width) * (rect.width - padding * 2),
      y: padding + ((point.z - geometry.minZ) / geometry.depth) * (rect.height - padding * 2)
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
  playbackSpeed,
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
  playbackSpeed: number;
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
            <span><i className="planned-taskless" />Clearance</span>
            <span><i className="local" />Local</span>
            <span><i className="goal" />Goal</span>
            <span><i className="pickup" />Pickup target</span>
          </span>
          <span className="vehicle-legend" aria-label="Shuttle state legend">
            <span><i className="vehicle-empty" />Empty task</span>
            <span><i className="vehicle-loaded" />Loaded</span>
            <span><i className="vehicle-waiting" />Waiting</span>
            <span><i className="vehicle-idle" />Idle</span>
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
        {viewMode === 'lite' || viewMode === '2d' ? (
          <CanvasLiteMap
            scenario={scenario}
            state={state}
            layers={layers}
            selectedVehicleId={selectedVehicleId}
            playbackSpeed={playbackSpeed}
            debugMode={viewMode === '2d'}
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
            playbackSpeed={playbackSpeed}
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
  const sourceBufferOccupied = liftPorts.reduce((sum, port) => sum + (port.sourceBufferOccupancy ?? 0), 0);
  const sourceBufferCapacity = liftPorts.reduce((sum, port) => sum + (port.sourceBufferCapacity ?? 1), 0);
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
        <span>Source buffers</span>
        <strong>{sourceBufferOccupied}/{sourceBufferCapacity}</strong>
        <small>waiting loads at inbound ports</small>
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
              {port.nodeId} / {port.kind} / {formatNumber(port.pph ?? 0, 1)} PPH / done {port.completedTasks ?? 0} / source {port.sourceBufferOccupancy ?? 0}/{port.sourceBufferCapacity ?? 1} / approach {port.approachOccupancy ?? 0}/{port.approachCapacity ?? 1} / q{port.queueLength} / cycle {Math.round(port.utilization * 100)}%
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

function TopBar({
  scenarioName,
  liveClockSec,
  durationSec,
  status,
  controllerMode,
  collisionAvoidanceEnabled,
  playbackSpeed,
  fastRun,
  setupDirty,
  isPending,
  kpis,
  trafficHoldsCount,
  onPlay,
  onPause,
  onReset,
  onSetSpeed
}: {
  scenarioName: string;
  liveClockSec: number;
  durationSec: number;
  status: ShuttleSimState['status'] | undefined;
  controllerMode: string;
  collisionAvoidanceEnabled: boolean;
  playbackSpeed: number;
  fastRun: FastRunProgress | null;
  setupDirty: boolean;
  isPending: boolean;
  kpis: KpiSnapshot | null;
  trafficHoldsCount: number;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSetSpeed: (speed: number) => void;
}) {
  const running = status === 'running';
  const paused = status === 'paused';
  const idle = status === 'idle' || status === undefined;
  const progressPct = durationSec > 0 ? Math.min(100, Math.max(0, (liveClockSec / durationSec) * 100)) : 0;
  const fastRunPct = fastRun && fastRun.targetSec > 0
    ? Math.min(100, Math.max(0, (fastRun.latestSec / fastRun.targetSec) * 100))
    : 0;
  const statusTone: 'ok' | 'warn' | 'idle' | 'danger' = fastRun?.active || running ? 'ok' : paused ? 'warn' : idle ? 'idle' : 'danger';
  const totalPph = kpis ? displayTotalPph(kpis) : 0;
  const inboundPph = kpis ? displayInboundPph(kpis) : 0;
  const outboundPph = kpis ? displayOutboundPph(kpis) : 0;
  const queued = kpis?.queuedTasks ?? 0;
  const utilization = kpis ? average(Object.values(kpis.vehicleUtilization)) * 100 : 0;
  const breakdowns = kpis ? Object.values(kpis.vehicleUtilizationBreakdown) : [];
  const productive = breakdowns.length > 0
    ? (breakdowns.reduce((sum, bd) => sum + bd.productive, 0) / breakdowns.length) * 100
    : 0;
  return (
    <header className="top-bar">
      <div className="top-brand">
        <div className="brand-mark" aria-hidden="true">S0</div>
        <div className="brand-text">
          <h1>Shuttle Sim</h1>
          <span className="brand-scenario">{scenarioName}</span>
        </div>
      </div>

      <div className="top-controls" aria-label="Playback controls">
        <button
          type="button"
          className={`play-toggle ${running ? 'is-running' : ''}`}
          onClick={running ? onPause : onPlay}
          disabled={setupDirty}
          title={running ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={running ? 'Pause' : 'Play'}
        >
          <span className="play-icon" aria-hidden="true">{running ? '⏸' : '▶'}</span>
          <span className="play-label">{running ? 'Pause' : paused ? 'Resume' : 'Start'}</span>
        </button>
        <button type="button" className="reset-btn" onClick={onReset} title="Reset (R)">
          <span aria-hidden="true">⟲</span>
          <span>Reset</span>
        </button>
        <div className="speed-group" role="group" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={playbackSpeed === speed ? 'speed-btn active' : 'speed-btn'}
              onClick={() => onSetSpeed(speed)}
              aria-pressed={playbackSpeed === speed}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>

      <div className="top-clock">
        <div className="clock-time">
          <span className="clock-value">{formatClock(liveClockSec)}</span>
          <span className="clock-total">/ {formatClock(durationSec)}</span>
        </div>
        <div className={`clock-status status-${statusTone}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>{fastRun?.active ? `Fast ${formatNumber(fastRunPct, 0)}%` : running ? 'Running' : paused ? 'Paused' : idle ? 'Idle' : status}</span>
          <span className="status-divider">·</span>
          <span>{controllerMode}</span>
          {isPending && <><span className="status-divider">·</span><span>rendering</span></>}
        </div>
        <div className="clock-progress" role="progressbar" aria-valuenow={Math.round(progressPct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="clock-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="top-kpis" aria-label="Live KPIs">
        <div className="kpi-cell">
          <span className="kpi-label">PPH</span>
          <strong className="kpi-value">{formatNumber(totalPph, 1)}</strong>
          <span className="kpi-sub">
            <em className="kpi-inbound">in {formatNumber(inboundPph, 0)}</em>
            <em className="kpi-outbound">out {formatNumber(outboundPph, 0)}</em>
          </span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Queue</span>
          <strong className="kpi-value">{queued}</strong>
          <span className="kpi-sub">tasks</span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Holds</span>
          <strong className="kpi-value">{trafficHoldsCount}</strong>
          <span className="kpi-sub">traffic</span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Util</span>
          <strong className="kpi-value">{formatNumber(productive, 1)}%</strong>
          <span className="kpi-sub">productive · {formatNumber(utilization, 0)}% busy</span>
        </div>
        <div className={`kpi-chip ${collisionAvoidanceEnabled ? 'ok' : 'danger'}`} title="Collision avoidance">
          <span>Avoid</span>
          <strong>{collisionAvoidanceEnabled ? 'On' : 'Off'}</strong>
        </div>
      </div>
    </header>
  );
}

function TimelineScrubber({
  liveClockSec,
  durationSec,
  status,
  fastRun,
  commandStatus,
  runToTargetSec,
  setupDirty,
  onScrubCommit,
  onSetTargetText,
  onJumpClick,
  onRunSixHoursClick,
  onRunDesClick,
  onCancelFastRun
}: {
  liveClockSec: number;
  durationSec: number;
  status: ShuttleSimState['status'] | undefined;
  fastRun: FastRunProgress | null;
  commandStatus: CommandStatus;
  runToTargetSec: string;
  setupDirty: boolean;
  onScrubCommit: (targetSec: number) => void;
  onSetTargetText: (text: string) => void;
  onJumpClick: () => void;
  onRunSixHoursClick: () => void;
  onRunDesClick: (durationSec: number) => void;
  onCancelFastRun: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const safeDur = durationSec > 0 ? durationSec : 1;
  const progressPct = Math.min(100, Math.max(0, (liveClockSec / safeDur) * 100));
  const hoverSec = hoverPct === null ? null : Math.round((hoverPct / 100) * safeDur);
  const fastRunPct = fastRun && fastRun.targetSec > 0
    ? Math.min(100, Math.max(0, (fastRun.latestSec / fastRun.targetSec) * 100))
    : 0;
  const statusLabel = fastRun
    ? `${fastRun.active ? 'fast' : 'fast paused'} ${formatClock(fastRun.latestSec)} / ${formatClock(fastRun.targetSec)} · ${formatNumber(fastRunPct, 0)}%`
    : commandStatus.label;

  const pctFromEvent = (event: { clientX: number }) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const x = event.clientX - rect.left;
    return Math.max(0, Math.min(100, (x / Math.max(1, rect.width)) * 100));
  };

  return (
    <div className="timeline-scrubber" aria-label="Simulation timeline">
      <div className="timeline-leader">
        <span className="timeline-label">Timeline</span>
        <span className="timeline-now">{formatClock(liveClockSec)}</span>
      </div>
      <div
        ref={trackRef}
        className={`timeline-track ${dragging ? 'is-dragging' : ''}`}
        onPointerDown={(event) => {
          if (setupDirty) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          const pct = pctFromEvent(event);
          setHoverPct(pct);
        }}
        onPointerMove={(event) => {
          const pct = pctFromEvent(event);
          setHoverPct(pct);
        }}
        onPointerUp={(event) => {
          if (!dragging) {
            setHoverPct(null);
            return;
          }
          const pct = pctFromEvent(event);
          setDragging(false);
          setHoverPct(null);
          const targetSec = (pct / 100) * safeDur;
          onScrubCommit(Math.max(0, Math.min(durationSec, targetSec)));
        }}
        onPointerLeave={() => {
          if (!dragging) setHoverPct(null);
        }}
        onPointerCancel={() => {
          setDragging(false);
          setHoverPct(null);
        }}
      >
        <div className="timeline-fill" style={{ width: `${progressPct}%` }} />
        <div className="timeline-cursor" style={{ left: `${progressPct}%` }}>
          <span className="timeline-cursor-tip" aria-hidden="true" />
        </div>
        {hoverPct !== null && hoverSec !== null && (
          <div className="timeline-ghost" style={{ left: `${hoverPct}%` }}>
            <span className="timeline-ghost-tip">{formatClock(hoverSec)}</span>
          </div>
        )}
        <div className="timeline-endpoints">
          <span>00:00</span>
          <span>{formatClock(durationSec)}</span>
        </div>
      </div>
      <div className="timeline-jump">
        <label>
          <span>Jump to</span>
          <input
            type="number"
            min={0}
            step={1}
            value={runToTargetSec}
            onChange={(event) => onSetTargetText(event.currentTarget.value)}
            placeholder="sec"
          />
        </label>
        <button type="button" onClick={onJumpClick} disabled={setupDirty || Boolean(fastRun?.active)}>Go</button>
        <button
          type="button"
          onClick={fastRun?.active ? onCancelFastRun : onRunSixHoursClick}
          disabled={setupDirty}
          className={fastRun?.active ? 'active-fast-run' : ''}
        >
          {fastRun?.active ? 'Pause Fast Run' : 'Run 6h Fast'}
        </button>
        <button type="button" onClick={() => onRunDesClick(SIX_HOURS_SEC)} disabled={setupDirty || Boolean(fastRun?.active)}>
          Capacity 6h
        </button>
        <button type="button" onClick={() => onRunDesClick(7 * 24 * 3600)} disabled={setupDirty || Boolean(fastRun?.active)}>
          Capacity 7d
        </button>
        <span className={`timeline-status ${status ?? ''}`}>
          {status ?? '--'}
        </span>
        <span className={`timeline-command-status tone-${fastRun?.active ? 'ok' : commandStatus.tone}`}>
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

function RecordingReplayPanel({
  recording,
  job,
  replay,
  setupDirty,
  onRecordThreeHours,
  onToggleReplay,
  onStopReplay,
  onSeek,
  onSetReplaySpeed
}: {
  recording: PhysicalRecording | null;
  job: PhysicalRecordingJob | null;
  replay: ReplayControlState;
  setupDirty: boolean;
  onRecordThreeHours: () => void;
  onToggleReplay: () => void;
  onStopReplay: () => void;
  onSeek: (seconds: number) => void;
  onSetReplaySpeed: (speed: number) => void;
}) {
  const jobActive = job?.status === 'queued' || job?.status === 'running';
  const durationSec = recording?.durationSec ?? job?.durationSec ?? THREE_HOURS_SEC;
  const cursorSec = Math.min(durationSec, Math.max(0, replay.cursorSec));
  const cursorPct = durationSec > 0 ? (cursorSec / durationSec) * 100 : 0;
  const progressPct = job?.progressPct ?? 0;
  const summary = recording?.summary ?? job?.summary ?? null;
  const markerCount = recording?.anomalyMarkers.length ?? 0;
  const anomalyCount = summary ? (markerCount || summary.deadlocks + summary.livelocks + summary.physicalViolations) : 0;

  return (
    <section className="recording-replay-panel" aria-label="Physical recording and replay">
      <div className="recording-head">
        <div>
          <span className="recording-eyebrow">Physical replay</span>
          <strong>{recording ? `${formatClock(recording.durationSec)} captured` : jobActive ? 'Recording physical run' : 'No recording loaded'}</strong>
        </div>
        <button type="button" onClick={onRecordThreeHours} disabled={setupDirty || jobActive}>
          {jobActive ? 'Recording...' : 'Record 3h Fast'}
        </button>
      </div>

      <div className="recording-track">
        <div className="recording-progress" style={{ width: `${jobActive ? progressPct : cursorPct}%` }} />
        {recording && (
          <input
            aria-label="Replay scrubber"
            type="range"
            min={0}
            max={recording.durationSec}
            step={recording.sampleIntervalSec}
            value={cursorSec}
            onChange={(event) => onSeek(Number(event.currentTarget.value))}
          />
        )}
      </div>

      <div className="recording-controls">
        <span className="recording-time">
          {recording ? `${formatClock(cursorSec)} / ${formatClock(recording.durationSec)}` : job ? `${formatClock(job.latestSec)} / ${formatClock(job.durationSec)}` : `00:00:00 / ${formatClock(THREE_HOURS_SEC)}`}
        </span>
        <button type="button" onClick={onToggleReplay} disabled={!recording}>
          {replay.playing ? 'Pause Replay' : replay.active && replay.cursorSec > 0 ? 'Resume Replay' : 'Play Replay'}
        </button>
        <button type="button" onClick={onStopReplay} disabled={!recording || (!replay.active && replay.cursorSec <= 0)}>
          Stop
        </button>
        <div className="replay-speed-group" role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={replay.speed === speed ? 'active' : ''}
              onClick={() => onSetReplaySpeed(speed)}
              disabled={!recording}
              aria-pressed={replay.speed === speed}
            >
              {speed}×
            </button>
          ))}
        </div>
        <span className={`recording-status ${job?.status ?? (recording ? 'completed' : 'idle')}`}>
          {jobActive
            ? `${formatNumber(progressPct, 0)}% · ${job.framesRecorded} frames`
            : recording
              ? `${recording.frameCount} frames · ${formatNumber(recording.elapsedMs / 1000, 1)}s compute`
              : 'ready'}
        </span>
      </div>

      {summary && (
        <div className="recording-metrics">
          <span><strong>{formatNumber(summary.totalPph, 1)}</strong> PPH</span>
          <span><strong>{formatNumber(summary.inboundPph, 1)}</strong> in</span>
          <span><strong>{formatNumber(summary.outboundPph, 1)}</strong> out</span>
          <span><strong>{anomalyCount}</strong> flags</span>
        </div>
      )}
    </section>
  );
}

export function App() {
  const [scenario, setScenario] = useState<ShuttleScenario | null>(null);
  const [state, setState] = useState<ShuttleSimState | null>(null);
  const [liveStream, setLiveStream] = useState<LiveStreamSnapshot | null>(null);
  const [pphHistory, setPphHistory] = useState<PphHistorySample[]>([]);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [prerequisites, setPrerequisites] = useState<PrerequisiteReport | null>(null);
  const [validation, setValidation] = useState<Phase0ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>({ label: 'ready', tone: 'idle' });
  const [playbackSpeed, setPlaybackSpeedState] = useState(1);
  const [fastRun, setFastRun] = useState<FastRunProgress | null>(null);
  const [desResult, setDesResult] = useState<HeadlessDesResult | null>(null);
  const [physicalRecordingJob, setPhysicalRecordingJob] = useState<PhysicalRecordingJob | null>(null);
  const [physicalRecording, setPhysicalRecording] = useState<PhysicalRecording | null>(null);
  const [replay, setReplay] = useState<ReplayControlState>({ active: false, playing: false, cursorSec: 0, speed: 4 });
  const [runToTargetSec, setRunToTargetSec] = useState('2400');
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
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('view');
  const [regionDraftCount, setRegionDraftCount] = useState(2);
  const [shuttleDraftCount, setShuttleDraftCount] = useState(8);
  const [initialOutboundDraftColumns, setInitialOutboundDraftColumns] = useState(4);
  const [sceneCameraView, setSceneCameraView] = useState<ShuttleSceneCameraView>(DEFAULT_SCENE_CAMERA_VIEW);
  const [isPending, startTransition] = useTransition();
  const reconnectAttemptRef = useRef(0);
  const playbackSpeedChangedRef = useRef(false);
  const fastRunControlRef = useRef<{ token: number; cancelled: boolean; controller: AbortController | null } | null>(null);
  const fastRunTokenRef = useRef(0);
  const paramUpdateTimersRef = useRef<Map<string, number>>(new Map());
  const pendingLiveStreamRef = useRef<LiveStreamSnapshot | null>(null);
  const liveStreamFrameRef = useRef<number | null>(null);
  const recordingPollTokenRef = useRef(0);
  const replayFrameRef = useRef<number | null>(null);

  function commitLiveStreamFromState(nextState: ShuttleSimState): void {
    const snapshot = {
      simTimeSec: nextState.simTimeSec,
      vehicles: nextState.vehicles,
      kpis: nextState.kpis
    };
    pendingLiveStreamRef.current = snapshot;
    setLiveStream(snapshot);
    setPphHistory((previous) => appendPphHistorySample(previous, createPphHistorySample(nextState.simTimeSec, nextState.kpis)));
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
    if (patch.kpis) {
      setPphHistory((previousHistory) => appendPphHistorySample(previousHistory, createPphHistorySample(patch.simTimeSec, patch.kpis!)));
    }
    if (liveStreamFrameRef.current !== null) {
      return;
    }
    liveStreamFrameRef.current = window.requestAnimationFrame(() => {
      liveStreamFrameRef.current = null;
      setLiveStream(pendingLiveStreamRef.current);
    });
  }

  const replaySceneState = useMemo(() => (
    replay.active && physicalRecording
      ? physicalRecordingStateAt(physicalRecording, replay.cursorSec, replay.playing)
      : null
  ), [physicalRecording, replay.active, replay.cursorSec, replay.playing]);
  const activeScenario = replaySceneState && physicalRecording ? physicalRecording.scenario : scenario;
  const liveClockSec = replaySceneState?.simTimeSec ?? liveStream?.simTimeSec ?? state?.simTimeSec ?? 0;
  const kpis = replaySceneState?.kpis ?? liveStream?.kpis ?? state?.kpis ?? null;
  const vehicles = replaySceneState?.vehicles ?? liveStream?.vehicles ?? state?.vehicles ?? [];
  const sceneState = useMemo(() => {
    if (replaySceneState) return replaySceneState;
    if (!state) return null;
    return {
      ...state,
      simTimeSec: liveClockSec,
      vehicles,
      kpis: kpis ?? state.kpis
    };
  }, [kpis, liveClockSec, replaySceneState, state, vehicles]);
  const displayStatus = replaySceneState?.status ?? state?.status;
  const statusTone = displayStatus === 'running' ? 'ok' : displayStatus === 'paused' ? 'warn' : 'idle';

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
    if (scenario) {
      setRegionDraftCount(inferTopLiftRegionCount(scenario));
      setShuttleDraftCount(scenario.vehicles.count);
      setInitialOutboundDraftColumns(scenario.taskGeneration.initialOutboundFullColumns);
    }
  }, [scenario]);

  useEffect(() => {
    let cancelled = false;
    requestJson<ScenarioSetupResponse>('/api/shuttle/setup')
      .then((response) => {
        if (cancelled) return;
        setScenario(response.scenario);
        setState(response.state);
        commitLiveStreamFromState(response.state);
        setEvents(response.state.recentEvents);
      })
      .catch((error) => setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' }));
    requestJson<PrerequisiteReport>('/api/shuttle/prerequisites')
      .then((report) => {
        if (cancelled) return;
        setPrerequisites(report);
      })
      .catch(() => {
        if (!cancelled) setPrerequisites(null);
      });
    requestJson<PlaybackSpeedResponse>('/api/shuttle/playbackSpeed')
      .then((speedReport) => {
        if (cancelled) return;
        if (!playbackSpeedChangedRef.current) {
          setPlaybackSpeedState(speedReport.speed);
        }
      })
      .catch(() => {
        if (!cancelled && !playbackSpeedChangedRef.current) {
          setPlaybackSpeedState(1);
        }
      });
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
      const fastRunControl = fastRunControlRef.current;
      if (fastRunControl) {
        fastRunControl.cancelled = true;
        fastRunControl.controller?.abort();
      }
      for (const timer of paramUpdateTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      paramUpdateTimersRef.current.clear();
      recordingPollTokenRef.current += 1;
      if (replayFrameRef.current !== null) {
        window.cancelAnimationFrame(replayFrameRef.current);
        replayFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!physicalRecording || !replay.active || !replay.playing) {
      if (replayFrameRef.current !== null) {
        window.cancelAnimationFrame(replayFrameRef.current);
        replayFrameRef.current = null;
      }
      return;
    }

    let previousWallMs = performance.now();
    const tick = (nowMs: number) => {
      const deltaSec = Math.max(0, (nowMs - previousWallMs) / 1000);
      previousWallMs = nowMs;
      setReplay((current) => {
        if (!current.active || !current.playing) {
          return current;
        }
        const nextCursorSec = Math.min(physicalRecording.durationSec, current.cursorSec + deltaSec * current.speed);
        return {
          ...current,
          cursorSec: nextCursorSec,
          playing: nextCursorSec < physicalRecording.durationSec - 1e-6
        };
      });
      replayFrameRef.current = window.requestAnimationFrame(tick);
    };
    replayFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (replayFrameRef.current !== null) {
        window.cancelAnimationFrame(replayFrameRef.current);
        replayFrameRef.current = null;
      }
    };
  }, [physicalRecording, replay.active, replay.playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        const running = state?.status === 'running';
        void postCommand(running ? '/api/shuttle/pause' : '/api/shuttle/resume');
      } else if (event.key === 'r' || event.key === 'R') {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        void postCommand('/api/shuttle/reset', { seed: state?.seed });
      } else if (event.key === '[') {
        const idx = PLAYBACK_SPEEDS.indexOf(playbackSpeed as typeof PLAYBACK_SPEEDS[number]);
        const next = PLAYBACK_SPEEDS[Math.max(0, idx - 1)] ?? PLAYBACK_SPEEDS[0];
        void setPlaybackSpeed(next);
      } else if (event.key === ']') {
        const idx = PLAYBACK_SPEEDS.indexOf(playbackSpeed as typeof PLAYBACK_SPEEDS[number]);
        const next = PLAYBACK_SPEEDS[Math.min(PLAYBACK_SPEEDS.length - 1, idx + 1)] ?? PLAYBACK_SPEEDS[PLAYBACK_SPEEDS.length - 1];
        void setPlaybackSpeed(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playbackSpeed, state?.status, state?.seed]);

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
  const setupSummary = useMemo(() => summarizeScenarioSetup(scenario), [scenario]);
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

  async function applyScenarioSetup(): Promise<void> {
    const minRegionCount = setupSummary?.minRegionCount ?? 1;
    const maxRegionCount = setupSummary?.maxRegionCount ?? 8;
    const minShuttleCount = setupSummary?.minShuttleCount ?? 1;
    const maxShuttleCount = setupSummary?.maxShuttleCount ?? 64;
    const regionCount = Math.min(maxRegionCount, Math.max(minRegionCount, Math.round(regionDraftCount)));
    const shuttleCount = Math.min(maxShuttleCount, Math.max(minShuttleCount, Math.round(shuttleDraftCount)));
    const maxInitialOutboundFullColumns = regionCount * 14;
    const initialOutboundFullColumns = Math.min(maxInitialOutboundFullColumns, Math.max(0, Math.round(initialOutboundDraftColumns)));
    const startedAt = performance.now();
    setCommandStatus({ label: `building ${regionCount} region / ${shuttleCount} shuttle layout...`, tone: 'idle' });
    try {
      const response = await requestJson<ScenarioSetupResponse>('/api/shuttle/setup', {
        method: 'POST',
        body: JSON.stringify({ regionCount, shuttleCount, initialOutboundFullColumns })
      });
      setScenario(response.scenario);
      setState(response.state);
      commitLiveStreamFromState(response.state);
      setEvents(response.state.recentEvents);
      setValidation(null);
      setRegionDraftCount(response.setup.regionCount);
      setShuttleDraftCount(response.setup.shuttleCount);
      setInitialOutboundDraftColumns(response.setup.initialOutboundFullColumns);
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `${response.setup.regionCount} regions / ${response.setup.shuttleCount} shuttles loaded in ${elapsedMs} ms`, tone: 'ok' });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
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

  function applyRunToTimeResponse(response: RunToTimeResponse): void {
    setState(response.state);
    commitLiveStreamFromState(response.state);
    setEvents(response.state.recentEvents);
  }

  async function requestRunToTime(targetSimTimeSec: number, signal?: AbortSignal): Promise<RunToTimeResponse> {
    return requestJson<RunToTimeResponse>('/api/shuttle/runToTime', {
      method: 'POST',
      body: JSON.stringify({ targetSimTimeSec }),
      signal
    });
  }

  async function runHeadlessDes(durationSec: number): Promise<void> {
    const startedAt = performance.now();
    const sampleIntervalSec = durationSec >= 24 * 3600 ? 24 * 3600 : Math.max(60, Math.round(durationSec / 24));
      setCommandStatus({ label: `running capacity DES to ${formatClock(durationSec)}...`, tone: 'idle' });
    try {
      const response = await requestJson<HeadlessDesResponse>('/api/shuttle/runHeadlessDes', {
        method: 'POST',
        body: JSON.stringify({
          durationSec,
          sampleIntervalSec
        })
      });
      setDesResult(response.result);
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({
        label: `capacity ${formatClock(durationSec)}: ${formatNumber(response.result.totalPph, 1)} PPH in ${elapsedMs} ms`,
        tone: response.result.anomalyMarkers.length === 0 ? 'ok' : 'warn'
      });
      setWorkspaceTab('statistics');
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  async function recordPhysicalThreeHours(): Promise<void> {
    const token = recordingPollTokenRef.current + 1;
    recordingPollTokenRef.current = token;
    const startedAt = performance.now();
    setPhysicalRecording(null);
    setReplay((current) => ({ ...current, active: false, playing: false, cursorSec: 0 }));
    setCommandStatus({ label: `recording physical ${formatClock(THREE_HOURS_SEC)} at max speed...`, tone: 'idle' });
    try {
      const startResponse = await requestJson<PhysicalRecordingJobResponse>('/api/shuttle/physicalRecordingJobs', {
        method: 'POST',
        body: JSON.stringify({
          durationSec: THREE_HOURS_SEC,
          sampleIntervalSec: RECORDING_SAMPLE_INTERVAL_SEC,
          resetFirst: true
        })
      });
      let job = startResponse.job;
      setPhysicalRecordingJob(job);

      while (recordingPollTokenRef.current === token && (job.status === 'queued' || job.status === 'running')) {
        setCommandStatus({
          label: `recording ${formatClock(job.latestSec)} / ${formatClock(job.durationSec)} · ${formatNumber(job.progressPct, 0)}%`,
          tone: 'idle'
        });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        const pollResponse = await requestJson<PhysicalRecordingJobResponse>(`/api/shuttle/physicalRecordingJobs/${job.id}`);
        job = pollResponse.job;
        setPhysicalRecordingJob(job);
      }

      if (recordingPollTokenRef.current !== token) {
        return;
      }
      if (job.status !== 'completed' || !job.recordingId) {
        throw new Error(job.error ?? 'Physical recording failed.');
      }

      setCommandStatus({ label: 'loading recorded frames...', tone: 'idle' });
      const recordingResponse = await requestJson<PhysicalRecordingResponse>(`/api/shuttle/physicalRecordings/${job.recordingId}`);
      setPhysicalRecording(recordingResponse.recording);
      setReplay({ active: true, playing: false, cursorSec: 0, speed: 4 });
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({
        label: `recorded ${formatClock(recordingResponse.recording.durationSec)} in ${elapsedMs} ms · ${formatNumber(recordingResponse.recording.summary.totalPph, 1)} PPH`,
        tone: recordingResponse.recording.anomalyMarkers.length === 0 ? 'ok' : 'warn'
      });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
      setPhysicalRecordingJob((current) => current ? { ...current, status: 'failed', error: error instanceof Error ? error.message : String(error) } : current);
    }
  }

  function toggleReplay(): void {
    if (!physicalRecording) {
      return;
    }
    setReplay((current) => {
      const cursorAtEnd = current.cursorSec >= physicalRecording.durationSec - 1e-6;
      return {
        ...current,
        active: true,
        playing: !current.playing,
        cursorSec: cursorAtEnd ? 0 : current.cursorSec
      };
    });
  }

  function stopReplay(): void {
    setReplay((current) => ({ ...current, active: false, playing: false, cursorSec: 0 }));
  }

  function seekReplay(seconds: number): void {
    if (!physicalRecording) {
      return;
    }
    setReplay((current) => ({
      ...current,
      active: true,
      playing: false,
      cursorSec: Math.min(physicalRecording.durationSec, Math.max(0, seconds))
    }));
  }

  function cancelFastRun(): void {
    const control = fastRunControlRef.current;
    if (control) {
      control.cancelled = true;
      control.controller?.abort();
    }
    setFastRun((current) => current ? { ...current, active: false, elapsedMs: Math.round(performance.now() - current.startedAtMs) } : current);
    setCommandStatus({ label: 'fast run pause requested', tone: 'warn' });
  }

  async function runToTime(explicitTargetSec?: number, options: { progressive?: boolean } = {}): Promise<void> {
    const targetSimTimeSec = explicitTargetSec !== undefined ? explicitTargetSec : Number(runToTargetSec);
    if (!Number.isFinite(targetSimTimeSec) || targetSimTimeSec < 0) {
      setCommandStatus({ label: 'enter a non-negative second', tone: 'error' });
      return;
    }

    const startedAt = performance.now();
    const currentSec = liveClockSec;
    const shouldRunProgressively = options.progressive === true && targetSimTimeSec > currentSec + FAST_RUN_CHUNK_SEC;
    if (shouldRunProgressively) {
      const token = fastRunTokenRef.current + 1;
      fastRunTokenRef.current = token;
      const control = { token, cancelled: false, controller: null as AbortController | null };
      fastRunControlRef.current = control;
      setFastRun({
        active: true,
        targetSec: targetSimTimeSec,
        latestSec: currentSec,
        startedAtMs: startedAt,
        elapsedMs: 0,
        chunksCompleted: 0
      });
      setCommandStatus({ label: `fast run ${formatClock(currentSec)} / ${formatClock(targetSimTimeSec)}`, tone: 'idle' });
      let latestSec = currentSec;
      let chunksCompleted = 0;
      try {
        while (!control.cancelled && latestSec < targetSimTimeSec - 1e-9) {
          const chunkTargetSec = Math.min(targetSimTimeSec, Math.max(latestSec + FAST_RUN_CHUNK_SEC, latestSec + 1));
          const controller = new AbortController();
          control.controller = controller;
          const response = await requestRunToTime(chunkTargetSec, controller.signal);
          if (control.cancelled || fastRunControlRef.current?.token !== token) {
            break;
          }
          applyRunToTimeResponse(response);
          latestSec = response.state.simTimeSec;
          chunksCompleted += 1;
          const elapsedMs = Math.round(performance.now() - startedAt);
          setFastRun({
            active: true,
            targetSec: targetSimTimeSec,
            latestSec,
            startedAtMs: startedAt,
            elapsedMs,
            chunksCompleted
          });
          const pct = targetSimTimeSec > 0 ? (latestSec / targetSimTimeSec) * 100 : 100;
          setCommandStatus({
            label: `fast run ${formatClock(latestSec)} / ${formatClock(targetSimTimeSec)} · ${formatNumber(pct, 0)}%`,
            tone: 'idle'
          });
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (control.cancelled) {
          setFastRun((current) => current ? { ...current, active: false, latestSec, elapsedMs, chunksCompleted } : null);
          await postCommand('/api/shuttle/pause');
          setCommandStatus({ label: `fast run paused at ${formatClock(latestSec)}`, tone: 'warn' });
          return;
        }
        setFastRun(null);
        setCommandStatus({ label: `fast run reached ${formatClock(latestSec)} in ${elapsedMs} ms`, tone: 'ok' });
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (control.cancelled || (error instanceof Error && error.name === 'AbortError')) {
          setFastRun((current) => current ? { ...current, active: false, latestSec, elapsedMs, chunksCompleted } : null);
          await postCommand('/api/shuttle/pause');
          setCommandStatus({ label: `fast run paused at ${formatClock(latestSec)}`, tone: 'warn' });
          return;
        }
        setFastRun((current) => current ? { ...current, active: false, elapsedMs, chunksCompleted } : null);
        setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
      } finally {
        if (fastRunControlRef.current?.token === token) {
          fastRunControlRef.current = null;
        }
      }
      return;
    }

    setCommandStatus({ label: `fast-forwarding to ${formatNumber(targetSimTimeSec, 1)}s...`, tone: 'idle' });
    try {
      const response = await requestRunToTime(targetSimTimeSec);
      applyRunToTimeResponse(response);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const prefix = response.resetFirst ? 'reset + jumped' : 'jumped';
      setCommandStatus({
        label: `${prefix} to ${formatClock(response.state.simTimeSec)} in ${elapsedMs} ms`,
        tone: 'ok'
      });
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

  const appliedRegionCount = setupSummary?.regionCount ?? 2;
  const appliedShuttleCount = setupSummary?.shuttleCount ?? 8;
  const appliedInitialOutboundFullColumns = setupSummary?.initialOutboundFullColumns ?? 4;
  const draftMaxInitialOutboundFullColumns = Math.max(1, Math.round(regionDraftCount)) * 14;
  const regionSetupDirty = regionDraftCount !== appliedRegionCount;
  const shuttleSetupDirty = shuttleDraftCount !== appliedShuttleCount;
  const initialOutboundSetupDirty = initialOutboundDraftColumns !== appliedInitialOutboundFullColumns;
  const setupDirty = regionSetupDirty || shuttleSetupDirty || initialOutboundSetupDirty;
  const displayDurationSec = replaySceneState
    ? replaySceneState.durationSec
    : Math.max(state?.durationSec ?? 0, fastRun?.targetSec ?? 0);

  const trafficHoldsCount = sceneState?.traffic?.waitingVehicles?.length ?? 0;
  const handlePlay = () => {
    if (replay.active && physicalRecording) {
      toggleReplay();
      return;
    }
    void postCommand('/api/shuttle/resume');
  };
  const handlePause = () => {
    if (replay.active && physicalRecording) {
      toggleReplay();
      return;
    }
    if (fastRun?.active) {
      cancelFastRun();
      return;
    }
    void postCommand('/api/shuttle/pause');
  };
  const handleReset = () => {
    if (replay.active && physicalRecording) {
      stopReplay();
      return;
    }
    void postCommand('/api/shuttle/reset', { seed: state?.seed });
  };
  const handleScrubCommit = (targetSec: number) => {
    if (replay.active && physicalRecording) {
      seekReplay(Math.round(targetSec));
      return;
    }
    setRunToTargetSec(String(Math.round(targetSec)));
    void runToTime(Math.round(targetSec));
  };

  return (
    <div className="app-root">
      <TopBar
        scenarioName={activeScenario?.name ?? 'Phase 0 Scenario'}
        liveClockSec={liveClockSec}
        durationSec={displayDurationSec}
        status={displayStatus}
        controllerMode={controllerMode}
        collisionAvoidanceEnabled={collisionAvoidanceEnabled}
        playbackSpeed={playbackSpeed}
        fastRun={fastRun}
        setupDirty={setupDirty}
        isPending={isPending}
        kpis={kpis}
        trafficHoldsCount={trafficHoldsCount}
        onPlay={handlePlay}
        onPause={handlePause}
        onReset={handleReset}
        onSetSpeed={setPlaybackSpeed}
      />
      <main className="app-shell">
        <aside className="sidebar">
          <section className="control-block param-block">
            <div className="block-head">
              <h2>Scenario</h2>
              <span className="block-validation">{validationMode.label}</span>
            </div>
            <div className="setup-panel">
              <div className="setup-control">
                <div className="setup-panel-head">
                  <span>Top-lift regions</span>
                  <strong>{appliedRegionCount} active</strong>
                </div>
                <div className="stepper-row" aria-label="Region count setup">
                  <button type="button" onClick={() => setRegionDraftCount((value) => Math.max(setupSummary?.minRegionCount ?? 1, value - 1))} disabled={regionDraftCount <= (setupSummary?.minRegionCount ?? 1)} aria-label="Decrease region count">−</button>
                  <input min={setupSummary?.minRegionCount ?? 1} max={setupSummary?.maxRegionCount ?? 8} step="1" type="number" value={regionDraftCount} onChange={(event) => setRegionDraftCount(Number(event.currentTarget.value))} />
                  <button type="button" onClick={() => setRegionDraftCount((value) => Math.min(setupSummary?.maxRegionCount ?? 8, value + 1))} disabled={regionDraftCount >= (setupSummary?.maxRegionCount ?? 8)} aria-label="Increase region count">+</button>
                </div>
              </div>
              <div className="setup-control">
                <div className="setup-panel-head">
                  <span>Shuttles</span>
                  <strong>{appliedShuttleCount} active</strong>
                </div>
                <div className="stepper-row" aria-label="Shuttle count setup">
                  <button type="button" onClick={() => setShuttleDraftCount((value) => Math.max(setupSummary?.minShuttleCount ?? 1, value - 1))} disabled={shuttleDraftCount <= (setupSummary?.minShuttleCount ?? 1)} aria-label="Decrease shuttle count">−</button>
                  <input min={setupSummary?.minShuttleCount ?? 1} max={setupSummary?.maxShuttleCount ?? 64} step="1" type="number" value={shuttleDraftCount} onChange={(event) => setShuttleDraftCount(Number(event.currentTarget.value))} />
                  <button type="button" onClick={() => setShuttleDraftCount((value) => Math.min(setupSummary?.maxShuttleCount ?? 64, value + 1))} disabled={shuttleDraftCount >= (setupSummary?.maxShuttleCount ?? 64)} aria-label="Increase shuttle count">+</button>
                </div>
              </div>
              <div className="setup-control">
                <div className="setup-panel-head">
                  <span>Outbound full columns</span>
                  <strong>{appliedInitialOutboundFullColumns} seeded</strong>
                </div>
                <div className="stepper-row" aria-label="Initial outbound full columns setup">
                  <button type="button" onClick={() => setInitialOutboundDraftColumns((value) => Math.max(0, value - 1))} disabled={initialOutboundDraftColumns <= 0} aria-label="Decrease initial outbound full columns">−</button>
                  <input min="0" max={draftMaxInitialOutboundFullColumns} step="1" type="number" value={initialOutboundDraftColumns} onChange={(event) => setInitialOutboundDraftColumns(Number(event.currentTarget.value))} />
                  <button type="button" onClick={() => setInitialOutboundDraftColumns((value) => Math.min(draftMaxInitialOutboundFullColumns, value + 1))} disabled={initialOutboundDraftColumns >= draftMaxInitialOutboundFullColumns} aria-label="Increase initial outbound full columns">+</button>
                </div>
              </div>
              <button className={setupDirty ? 'primary-action apply-setup' : 'apply-setup'} type="button" onClick={() => void applyScenarioSetup()} disabled={!scenario || !setupDirty}>
                {setupDirty ? 'Apply setup ▸' : 'Setup applied'}
              </button>
              <div className="setup-metrics">
                <span><strong>{setupSummary?.storageCapacity ?? '--'}</strong> cells</span>
                <span><strong>{setupSummary ? setupSummary.regionCount * 4 : '--'}</strong> zones</span>
                <span><strong>{setupSummary?.physicalLiftCount ?? '--'}</strong> lifts</span>
                <span><strong>{setupSummary?.shuttleCount ?? '--'}</strong> shuttles</span>
                <span><strong>{setupSummary?.inboundLiftCount ?? '--'}/{setupSummary?.outboundLiftCount ?? '--'}</strong> in/out</span>
                <span><strong>{setupSummary?.initialOutboundFullColumns ?? '--'}</strong> out cols</span>
              </div>
            </div>

            <div className="mode-toggle">
              <span>
                Collision avoidance
                <strong>{collisionAvoidanceEnabled ? 'On' : 'Off'}</strong>
              </span>
              <div className="mode-row" aria-label="Collision avoidance">
                <button className={collisionAvoidanceEnabled ? 'active' : ''} type="button" onClick={() => updateParam(COLLISION_AVOIDANCE_PARAM, true)} aria-pressed={collisionAvoidanceEnabled}>On</button>
                <button className={!collisionAvoidanceEnabled ? 'active danger' : ''} type="button" onClick={() => updateParam(COLLISION_AVOIDANCE_PARAM, false)} aria-pressed={!collisionAvoidanceEnabled}>Off</button>
              </div>
              {!collisionAvoidanceEnabled && (
                <p className="unsafe-note">UNSAFE DIAGNOSTIC — collision checks bypassed. Audits still run.</p>
              )}
            </div>

            <details className="params-details" open>
              <summary>Parameters</summary>
              <div className="params-list">
                {CONTROLLED_PARAMS.map((param) => {
                  const value = paramValues.get(param.path) ?? 0;
                  return (
                    <label key={param.path}>
                      <span>
                        {param.label}
                        <strong>{formatNumber(value, 2)} {param.unit}</strong>
                      </span>
                      <input type="range" min={param.min} max={param.max} step={param.step} value={value} onChange={(event) => scheduleParamUpdate(param.path, Number(event.currentTarget.value))} />
                    </label>
                  );
                })}
              </div>
            </details>
          </section>

          <details className="details-block">
            <summary>System details</summary>
            <PrerequisitePanel report={prerequisites} />
            <CalibrationPanel scenario={scenario} />
            <ValidationPanel validation={validation} validating={validating} onRun={runValidation} />
          </details>
        </aside>

        <section className="workspace">
          <nav className="workspace-tabs" aria-label="Workspace sections">
            {WORKSPACE_TABS.map((tab) => (
              <button className={workspaceTab === tab.id ? 'active' : ''} key={tab.id} type="button" onClick={() => setWorkspaceTab(tab.id)} aria-pressed={workspaceTab === tab.id}>
                {tab.label}
              </button>
            ))}
            <div className="workspace-tab-spacer" />
            <div className={`tab-status-chip tone-${statusTone}`}>
              <span className="status-dot" aria-hidden="true" />
              <span>{displayStatus ?? 'loading'}</span>
            </div>
          </nav>

          <div className="workspace-body">
            {workspaceTab === 'view' && (
              <section className="tab-panel view-panel" aria-label="2D and 3D simulation view">
                <StreamingPane
                  scenario={activeScenario}
                  state={sceneState}
                  layers={sceneLayers}
                  selectedVehicleId={selectedVehicleId}
                  viewMode={mapViewMode}
                  cameraView={sceneCameraView}
                  playbackSpeed={playbackSpeed}
                  rendererInfo={rendererInfo}
                  onCameraViewChange={(view) => setSceneCameraView(clampSceneCameraView(view))}
                  onToggleLayer={toggleSceneLayer}
                  onSelectVehicle={setSelectedVehicleId}
                  onViewModeChange={setMapViewMode}
                  onRendererInfo={setRendererInfo}
                />
              </section>
            )}

            {workspaceTab === 'statistics' && (
              <section className="tab-panel statistics-panel" aria-label="Simulation statistics">
                <KpiStrip scenario={activeScenario} kpis={kpis} />
                <DesSummaryPanel result={desResult} />
                <PphTrendChart history={pphHistory} />
                <LiftPphPanel state={sceneState} kpis={kpis} history={pphHistory} />
                <CapacityTheoryPanel kpis={kpis} />
                <ResourceUtilizationPanel scenario={activeScenario} state={sceneState} />
                <VehicleTimeStackedBarChart vehicles={vehicles} kpis={kpis} />
              </section>
            )}

            {workspaceTab === 'diagnostics' && (
              <section className="tab-panel diagnostics-panel" aria-label="Traffic and inventory diagnostics">
                <TrafficDiagnosticsPanel state={sceneState} />
                <div className="main-grid">
                  <VehicleTable vehicles={vehicles} selectedVehicleId={selectedVehicleId} onSelectVehicle={setSelectedVehicleId} />
                  <details className="diagnostics-details" open>
                    <summary>Event log</summary>
                    <EventLog events={events} />
                  </details>
                </div>
                <details className="workspace-details">
                  <summary>Inventory / FIFO details</summary>
                  <FifoInventoryPanel scenario={activeScenario} state={sceneState} />
                </details>
              </section>
            )}
          </div>

          <TimelineScrubber
            liveClockSec={liveClockSec}
            durationSec={displayDurationSec}
            status={displayStatus}
            fastRun={fastRun}
            commandStatus={commandStatus}
            runToTargetSec={runToTargetSec}
            setupDirty={setupDirty}
            onScrubCommit={handleScrubCommit}
            onSetTargetText={setRunToTargetSec}
            onJumpClick={() => void runToTime()}
            onRunSixHoursClick={() => {
              setRunToTargetSec(String(SIX_HOURS_SEC));
              void runToTime(SIX_HOURS_SEC, { progressive: true });
            }}
            onRunDesClick={(durationSec) => void runHeadlessDes(durationSec)}
            onCancelFastRun={cancelFastRun}
          />
          <RecordingReplayPanel
            recording={physicalRecording}
            job={physicalRecordingJob}
            replay={replay}
            setupDirty={setupDirty}
            onRecordThreeHours={() => void recordPhysicalThreeHours()}
            onToggleReplay={toggleReplay}
            onStopReplay={stopReplay}
            onSeek={seekReplay}
            onSetReplaySpeed={(speed) => setReplay((current) => ({ ...current, speed }))}
          />
        </section>
      </main>
    </div>
  );
}
