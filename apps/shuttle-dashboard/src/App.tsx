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
  initialStorageFillPolicy: ShuttleScenario['taskGeneration']['initialStorageFillPolicy'];
  storageSelectionPolicy: ShuttleScenario['taskGeneration']['storageSelectionPolicy'];
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
  completedInbound?: number;
  completedOutbound?: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  waitingPct: number;
  repositionPct: number;
  liftPph: Record<string, number>;
};

export type LiveTrendDiagnosis = {
  id: string;
  label: string;
  status: 'pass' | 'watch' | 'critical';
  value: string;
  detail: string;
  evidence: string;
};

export type ReviewTrafficReadout = {
  id: string;
  label: string;
  status: 'pass' | 'watch' | 'critical';
  value: string;
  detail: string;
  evidence: string;
};

export type ReviewDesEvidence = {
  routeStatus: 'pass' | 'watch' | 'critical';
  routeMisses: number;
  reservationWindows: number;
  tracedTasks: number;
  routePass: number;
  routeWatch: number;
  routeFail: number;
  trafficWaitHours: number;
  topBottleneck: string;
  topWaitTask: string;
  evidence: string;
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
type WorkspaceTab = 'review' | 'view' | 'statistics' | 'diagnostics';

const MAX_PPH_HISTORY_SAMPLES = 240;
const SIX_HOURS_SEC = 6 * 60 * 60;
const THREE_HOURS_SEC = 3 * 60 * 60;
const TWELVE_HOURS_SEC = 12 * 60 * 60;
const FAST_RUN_CHUNK_SEC = 10;
const RECORDING_SAMPLE_INTERVAL_SEC = 5;
const LONG_RECORDING_SAMPLE_INTERVAL_SEC = 60;
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
    max: 60,
    step: 1,
    unit: 's'
  },
  {
    label: 'Lower time',
    path: '/physicsParams/lowerTimeSec',
    min: 0,
    max: 60,
    step: 1,
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
  { id: 'review', label: 'Review Cockpit' },
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
    initialStorageFillPolicy: scenario.taskGeneration.initialStorageFillPolicy,
    storageSelectionPolicy: scenario.taskGeneration.storageSelectionPolicy,
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
  const utilizationBreakdowns = Object.values(kpis.vehicleUtilizationBreakdown ?? {});
  const waitingPct = average(utilizationBreakdowns.map((breakdown) => breakdown.waiting)) * 100;
  const repositionPct = average(utilizationBreakdowns.map((breakdown) => breakdown.tasklessTravel)) * 100;
  return {
    simTimeSec,
    completedInbound: kpis.completedInbound,
    completedOutbound: kpis.completedOutbound,
    inboundPph: displayInboundPph(kpis),
    outboundPph,
    totalPph: displayTotalPph(kpis),
    waitingPct,
    repositionPct,
    liftPph: Object.fromEntries(Object.entries(kpis.liftPph ?? {}).map(([nodeId, value]) => [nodeId, value.pph]))
  };
}

function displayInboundPph(kpis: KpiSnapshot): number {
  return displayWindowOrAveragePph(kpis.windowInboundPph, kpis.inboundPph, kpis.completedInbound, kpis.pphWindowSec);
}

function displayOutboundPph(kpis: KpiSnapshot): number {
  return displayWindowOrAveragePph(kpis.windowOutboundPph, kpis.outboundPph, kpis.completedOutbound, kpis.pphWindowSec);
}

function displayTotalPph(kpis: KpiSnapshot): number {
  return displayWindowOrAveragePph(
    kpis.windowTotalPph,
    kpis.totalPph,
    kpis.completedInbound + kpis.completedOutbound,
    kpis.pphWindowSec
  );
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

export function appendPphHistorySample(previous: PphHistorySample[], sample: PphHistorySample): PphHistorySample[] {
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
const VEHICLE_VISUAL_BODY_SCALE = 0.78;

function vehicleSquareFootprintSideM(scenario: ShuttleScenario | null | undefined): number {
  return Math.max(scenario?.vehicles.lengthM ?? 1.03, scenario?.vehicles.widthM ?? 1.03);
}

export function vehicleVisualBodySideM(scenario: ShuttleScenario | null | undefined): number {
  return vehicleSquareFootprintSideM(scenario) * VEHICLE_VISUAL_BODY_SCALE;
}

export function vehicleListHasSquareFootprintOverlap(
  vehicles: readonly VehicleState[],
  scenario: ShuttleScenario | null | undefined
): boolean {
  if (!scenario) {
    return false;
  }
  const sideM = vehicleSquareFootprintSideM(scenario);
  for (let leftIndex = 0; leftIndex < vehicles.length; leftIndex += 1) {
    const left = vehicles[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < vehicles.length; rightIndex += 1) {
      const right = vehicles[rightIndex]!;
      if (Math.abs(left.x - right.x) <= sideM + 1e-6 && Math.abs(left.z - right.z) <= sideM + 1e-6) {
        return true;
      }
    }
  }
  return false;
}

export function vehicleCanInterpolateVisual(left: VehicleState, right: VehicleState): boolean {
  if (left.id !== right.id) {
    return false;
  }
  if (
    left.loaded !== right.loaded ||
    left.taskId !== right.taskId ||
    left.currentEdgeId !== right.currentEdgeId ||
    left.currentNodeId !== right.currentNodeId ||
    left.targetNodeId !== right.targetNodeId
  ) {
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
  const displayVehicles =
    vehicleListHasSquareFootprintOverlap(vehicles, recording.scenario) &&
    !vehicleListHasSquareFootprintOverlap(after.vehicles, recording.scenario)
      ? after.vehicles
      : vehicles;

  return {
    schemaVersion: 'shuttle.phase0.state.v0',
    scenarioId: recording.scenario.id,
    sessionId: `replay-${recording.id}`,
    status: playing ? 'running' : 'paused',
    simTimeSec: clampedSec,
    durationSec: recording.durationSec,
    seed: recording.scenario.seed,
    vehicles: displayVehicles,
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
  return /^(?:lift|parking-lift)-\d{2}-(?:inbound|outbound)(?:$|-throat|-buffer-access|-buffer-\d{2}|-queue-access|-queue-\d{2}-(?:access|entry-access|service-exit)|-queue(?:-\d{2})?)$/.test(nodeId);
}

type LiftDisplayRailLevel = 'top-a' | 'top-b' | 'bottom-a' | 'bottom-b';

function liftDisplayRailLevel(nodeId: string): LiftDisplayRailLevel | null {
  const column = /^column-((?:top|bottom)-[ab])-c\d+$/.exec(nodeId);
  if (column) {
    return column[1] as LiftDisplayRailLevel;
  }
  const spine = /^(?:module-\d+|module-boundary-\d+)-spine-((?:top|bottom)-[ab])$/.exec(nodeId);
  return spine ? spine[1] as LiftDisplayRailLevel : null;
}

function isLiftDisplayRailNode(nodeId: string): boolean {
  return liftDisplayRailLevel(nodeId) !== null;
}

function isLiftDisplayRailLevelNode(nodeId: string, level: LiftDisplayRailLevel): boolean {
  return new RegExp(`^column-${level}-c\\d+$`).test(nodeId) ||
    new RegExp(`^(?:module-\\d+|module-boundary-\\d+)-spine-${level}$`).test(nodeId);
}

function liftDisplayLevelForRouteNode(nodeIds: string[], index: number): LiftDisplayRailLevel | null {
  const nodeId = nodeIds[index];
  if (!nodeId || !isLiftRouteDisplaySnapNode(nodeId)) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previousNodeId = nodeIds[cursor]!;
    const railLevel = liftDisplayRailLevel(previousNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftRouteDisplaySnapNode(previousNodeId)) {
      break;
    }
  }

  for (let cursor = index + 1; cursor < nodeIds.length; cursor += 1) {
    const nextNodeId = nodeIds[cursor]!;
    const railLevel = liftDisplayRailLevel(nextNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftRouteDisplaySnapNode(nextNodeId)) {
      break;
    }
  }

  return null;
}

function liftDisplayLevelsForRoute(nodeIds: string[]): Array<LiftDisplayRailLevel | null> {
  return nodeIds.map((_, index) => liftDisplayLevelForRouteNode(nodeIds, index));
}

function routeDisplayPointForNode(
  nodeId: string,
  fallback: { x: number; z: number },
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>,
  preferredLevel: LiftDisplayRailLevel | null = null
): { x: number; z: number } {
  if (!isLiftRouteDisplaySnapNode(nodeId)) {
    return fallback;
  }
  let nearest: ShuttleScenario['layout']['nodes'][number] | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const displayLevel = preferredLevel;
  for (const node of nodeMap.values()) {
    if (displayLevel ? !isLiftDisplayRailLevelNode(node.id, displayLevel) : !isLiftDisplayRailNode(node.id)) {
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
  currentPreferredLevel: LiftDisplayRailLevel | null = null,
  targetPreferredLevel: LiftDisplayRailLevel | null = null
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

function vehicleBodyDisplayPointForVehicleState(
  vehicle: VehicleState,
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>
): { x: number; z: number } {
  return routeDisplayPointForVehicleState(vehicle, nodeMap);
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

function routeDistanceFromVehicleM(
  vehicle: VehicleState,
  nodeIds: string[],
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>
): number {
  if (nodeIds.length < 2) {
    return 0;
  }
  let distanceM = 0;
  let cursor = { x: vehicle.x, z: vehicle.z };
  for (const nodeId of nodeIds.slice(1)) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      continue;
    }
    distanceM += Math.hypot(node.x - cursor.x, node.z - cursor.z);
    cursor = { x: node.x, z: node.z };
  }
  return distanceM;
}

function routeLowerBoundM(
  vehicle: VehicleState,
  goalNodeId: string,
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>
): number {
  const goalNode = nodeMap.get(goalNodeId);
  if (!goalNode) {
    return 0;
  }
  return Math.abs(goalNode.x - vehicle.x) + Math.abs(goalNode.z - vehicle.z);
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

function DesAnswerFirstPanel({ result }: { result: HeadlessDesResult | null }) {
  const rows = useMemo(() => buildDesPeriodRows(result), [result]);
  const latest = rows.at(-1) ?? null;
  const minRow = rows.reduce<DesPeriodThroughputRow | null>(
    (best, row) => (best === null || row.totalPph < best.totalPph ? row : best),
    null
  );
  const maxRow = rows.reduce<DesPeriodThroughputRow | null>(
    (best, row) => (best === null || row.totalPph > best.totalPph ? row : best),
    null
  );
  const topBottleneck = result?.trafficBottlenecks[0] ?? null;
  const criticalIssues = result?.issues.filter((issue) => issue.severity === 'critical').length ?? 0;
  const warningIssues = result?.issues.filter((issue) => issue.severity === 'warning').length ?? 0;
  const routeMisses = result?.routeModel.routeUnavailableCount ?? 0;
  const internalReady = Boolean(result) && criticalIssues === 0 && routeMisses === 0;

  return (
    <section className="des-answer-panel" aria-label="DES answer first summary">
      <div className="panel-head compact">
        <div>
          <h2>Answer First</h2>
          <p>{result
            ? `This DES run delivered ${formatNumber(result.totalPph, 1)} total PPH: inbound ${formatNumber(result.inboundPph, 1)} and outbound ${formatNumber(result.outboundPph, 1)}.`
            : 'Run DES 6h or DES 7d to generate the review summary.'}</p>
        </div>
        <span>{internalReady ? 'internal review ready' : result ? 'watch' : 'run DES first'}</span>
      </div>
      <div className="des-answer-grid">
        <div className="des-answer-primary">
          <span>Total PPH</span>
          <strong>{result ? formatNumber(result.totalPph, 1) : '--'}</strong>
          <small>{result ? `in ${formatNumber(result.inboundPph, 1)} / out ${formatNumber(result.outboundPph, 1)} · latest ${latest ? formatNumber(latest.totalPph, 1) : '--'}` : 'waiting for DES result'}</small>
        </div>
        <div>
          <span>Lowest Period</span>
          <strong>{minRow ? formatNumber(minRow.totalPph, 1) : '--'}</strong>
          <small>{minRow ? `${minRow.label} · wait ${formatNumber(minRow.waitingPct, 1)}%` : 'no period rows'}</small>
        </div>
        <div>
          <span>Highest Period</span>
          <strong>{maxRow ? formatNumber(maxRow.totalPph, 1) : '--'}</strong>
          <small>{maxRow ? `${maxRow.label} · in ${formatNumber(maxRow.inboundPph, 1)} / out ${formatNumber(maxRow.outboundPph, 1)}` : 'no period rows'}</small>
        </div>
        <div>
          <span>First Bottleneck</span>
          <strong>{topBottleneck ? formatNumber(topBottleneck.waitSec, 0) : '--'}s</strong>
          <small>{topBottleneck ? `${resourceShortName(topBottleneck.resourceId)} · ${topBottleneck.waitCount} waits` : 'no traffic wait recorded'}</small>
        </div>
        <div className="des-answer-boundary">
          <span>Review Boundary</span>
          <strong>{result ? 'site data needed' : '--'}</strong>
          <small>{result ? `${criticalIssues} critical, ${warningIssues} warning, ${routeMisses} route misses; customer data still required for site-calibrated claim` : 'run DES first'}</small>
        </div>
      </div>
    </section>
  );
}

function DesSummaryPanel({ result }: { result: HeadlessDesResult | null }) {
  const durationHours = result ? result.durationSec / 3600 : 0;
  const waitingPct = result?.averageWaitingPct ?? 0;
  const trafficWaitPct = result?.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0;
  const liftWaitPct = result?.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0;
  const items = [
    {
      label: 'DES horizon',
      value: result ? `${formatNumber(durationHours, durationHours >= 24 ? 0 : 1)}h` : '--',
      detail: result ? `${formatNumber(result.wallClockMs, 0)} ms wall clock, ${formatNumber(result.processedEvents, 0)} events` : 'event-driven analytical run'
    },
    {
      label: 'DES PPH',
      value: result ? formatNumber(result.totalPph, 1) : '--',
      detail: result ? `in ${formatNumber(result.inboundPph, 1)} / out ${formatNumber(result.outboundPph, 1)}` : 'inbound / outbound'
    },
    {
      label: 'Reservation wait',
      value: result ? `${formatNumber(waitingPct, 1)}%` : '--',
      detail: result ? `${formatNumber(trafficWaitPct, 1)}% traffic, ${formatNumber(liftWaitPct, 1)}% lift` : 'fleet time share'
    },
    {
      label: 'Control policy',
      value: result ? `cap ${result.controlPolicy.maxActiveTasks}` : '--',
      detail: result ? `${formatNumber(result.controlPolicy.backpressureHoldCount, 0)} backpressure holds` : 'review policy'
    },
    {
      label: 'Yellow-grid routes',
      value: result ? String(result.routeModel.routeUnavailableCount) : '--',
      detail: result ? `${result.routeModel.reservationWindowCount} reservation windows` : 'route misses / windows'
    },
    {
      label: 'DES issues',
      value: result ? String(result.issues.length) : '--',
      detail: result ? result.issues.map((issue) => issue.severity).join(', ') || 'none' : 'V&V flags'
    }
  ];

  return (
    <section className="des-summary-panel" aria-label="Headless DES summary">
      <div className="panel-head compact">
        <div>
          <h2>Reservation-Window DES</h2>
          <p>Event-driven long-run model with yellow-grid node/edge reservation windows. This is the analytical V&V view; physical replay remains the animated smoke check.</p>
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

type DesPeriodThroughputRow = {
  label: string;
  startSec: number;
  endSec: number;
  periodSec: number;
  inboundDelta: number;
  outboundDelta: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  waitingPct: number;
  repositionPct: number;
};

type LiveHourlyThroughputRow = {
  label: string;
  startSec: number;
  endSec: number;
  periodSec: number;
  inboundDelta: number;
  outboundDelta: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  completedInbound: number;
  completedOutbound: number;
  isPartial: boolean;
};

function DesPeriodPphPanel({ result }: { result: HeadlessDesResult | null }) {
  const rows = useMemo(() => buildDesPeriodRows(result), [result]);
  const latest = rows.at(-1) ?? null;
  const minRow = rows.reduce<DesPeriodThroughputRow | null>(
    (best, row) => (best === null || row.totalPph < best.totalPph ? row : best),
    null
  );
  const maxRow = rows.reduce<DesPeriodThroughputRow | null>(
    (best, row) => (best === null || row.totalPph > best.totalPph ? row : best),
    null
  );
  const periodMinutes = latest ? latest.periodSec / 60 : 0;
  const maxPph = niceAxisCeil(Math.max(1, ...rows.flatMap((row) => [row.totalPph, row.inboundPph, row.outboundPph])));
  const inboundPoints = desPeriodLinePoints(rows, (row) => row.inboundPph, maxPph);
  const outboundPoints = desPeriodLinePoints(rows, (row) => row.outboundPph, maxPph);
  const totalPoints = desPeriodLinePoints(rows, (row) => row.totalPph, maxPph);
  const callouts = [
    { key: 'latest', label: 'latest', row: latest, className: 'latest' },
    { key: 'low', label: 'low', row: minRow, className: 'low' },
    { key: 'high', label: 'high', row: maxRow, className: 'high' }
  ];

  return (
    <section className="des-hourly-panel" aria-label="DES period PPH">
      <div className="panel-head compact">
        <div>
          <h2>DES Period PPH</h2>
          <p>Completed loads inside each DES sample period. Total = Inbound + Outbound; this is the local service curve, not the cumulative average.</p>
        </div>
        <span>{rows.length > 0 ? `${rows.length} samples · ${formatNumber(periodMinutes, periodMinutes >= 10 ? 0 : 1)} min` : 'run DES first'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty-panel-note">Run DES 6h or DES 7d to show the period-by-period inbound/outbound/total curve.</p>
      ) : (
        <>
          <div className="des-hourly-chart-wrap">
            <svg className="des-hourly-chart" viewBox="0 0 120 68" role="img" aria-label="DES inbound outbound total period PPH curve">
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = 52 - ratio * 44;
                const value = maxPph * ratio;
                return (
                  <g key={ratio}>
                    <line className="chart-grid-line" x1="14" x2="114" y1={y} y2={y} />
                    <text className="chart-axis-label y-axis" x="11" y={y + 1.8}>{formatNumber(value, value >= 100 ? 0 : 1)}</text>
                  </g>
                );
              })}
              <line className="chart-axis-line" x1="14" x2="114" y1="52" y2="52" />
              <line className="chart-axis-line" x1="14" x2="14" y1="8" y2="52" />
              <polyline className="pph-line inbound" points={inboundPoints} />
              <polyline className="pph-line outbound" points={outboundPoints} />
              <polyline className="pph-line total" points={totalPoints} />
              {callouts.flatMap((callout) => {
                if (!callout.row) return [];
                const point = desPeriodPointForRow(rows, callout.row, callout.row.totalPph, maxPph);
                return (
                  <g className={`des-hourly-callout ${callout.className}`} key={callout.key}>
                    <circle cx={point.x} cy={point.y} r="1.6" />
                    <text x={Math.min(103, point.x + 2.2)} y={Math.max(9, point.y - 2)}>
                      {callout.label} {formatNumber(callout.row.totalPph, 1)}
                    </text>
                  </g>
                );
              })}
              <text className="chart-axis-label x-axis" x="14" y="64">{rows[0]?.label ?? '--'}</text>
              <text className="chart-axis-label x-axis end" x="114" y="64">{latest?.label ?? '--'}</text>
            </svg>
          </div>
          <div className="des-hourly-summary">
            <DesPeriodSummaryCard label="Latest" row={latest} />
            <DesPeriodSummaryCard label="Lowest total" row={minRow} />
            <DesPeriodSummaryCard label="Highest total" row={maxRow} />
          </div>
          <div className="des-hourly-table-wrap">
            <table className="des-hourly-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Total PPH</th>
                  <th>Waiting</th>
                  <th>Reposition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.startSec}-${row.endSec}`} className={row === minRow ? 'is-low' : row === maxRow ? 'is-high' : undefined}>
                    <td>{row.label}</td>
                    <td>{formatNumber(row.inboundPph, 1)} <small>({row.inboundDelta})</small></td>
                    <td>{formatNumber(row.outboundPph, 1)} <small>({row.outboundDelta})</small></td>
                    <td>{formatNumber(row.totalPph, 1)}</td>
                    <td>{formatNumber(row.waitingPct, 1)}%</td>
                    <td>{formatNumber(row.repositionPct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function LiveHourlyPphPanel({ history }: { history: PphHistorySample[] }) {
  const rows = useMemo(() => buildLiveHourlyRows(history), [history]);
  const latest = rows.at(-1) ?? null;
  const minRow = rows.reduce<LiveHourlyThroughputRow | null>(
    (best, row) => (best === null || row.totalPph < best.totalPph ? row : best),
    null
  );
  const maxRow = rows.reduce<LiveHourlyThroughputRow | null>(
    (best, row) => (best === null || row.totalPph > best.totalPph ? row : best),
    null
  );
  const maxPph = niceAxisCeil(Math.max(1, ...rows.flatMap((row) => [row.totalPph, row.inboundPph, row.outboundPph])));
  const inboundPoints = liveHourlyLinePoints(rows, (row) => row.inboundPph, maxPph);
  const outboundPoints = liveHourlyLinePoints(rows, (row) => row.outboundPph, maxPph);
  const totalPoints = liveHourlyLinePoints(rows, (row) => row.totalPph, maxPph);
  const sampleCount = history.filter((sample) => sample.completedInbound !== undefined && sample.completedOutbound !== undefined).length;
  const finalSample = history.at(-1);
  const firstSample = history[0];
  const netInboundMinusOutbound = firstSample && finalSample
    ? (finalSample.completedInbound ?? 0) - (firstSample.completedInbound ?? 0) -
      ((finalSample.completedOutbound ?? 0) - (firstSample.completedOutbound ?? 0))
    : 0;

  return (
    <section className="live-hourly-panel" aria-label="Live hourly PPH">
      <div className="panel-head compact">
        <div>
          <h2>Live Hourly PPH</h2>
          <p>Physical/3D tick run split into hourly buckets from cumulative completed counts. This is the live counterpart to DES Period PPH.</p>
        </div>
        <span>{rows.length > 0 ? `${rows.length} buckets · ${sampleCount} samples` : 'start or fast-run simulation'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty-panel-note">Run the physical/3D simulation past a few completed loads to build hourly inbound/outbound buckets.</p>
      ) : (
        <>
          <div className="des-hourly-chart-wrap">
            <svg className="des-hourly-chart" viewBox="0 0 120 68" role="img" aria-label="Live hourly inbound outbound total PPH curve">
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = 52 - ratio * 44;
                const value = maxPph * ratio;
                return (
                  <g key={ratio}>
                    <line className="chart-grid-line" x1="14" x2="114" y1={y} y2={y} />
                    <text className="chart-axis-label y-axis" x="11" y={y + 1.8}>{formatNumber(value, value >= 100 ? 0 : 1)}</text>
                  </g>
                );
              })}
              <line className="chart-axis-line" x1="14" x2="114" y1="52" y2="52" />
              <line className="chart-axis-line" x1="14" x2="14" y1="8" y2="52" />
              <polyline className="pph-line inbound" points={inboundPoints} />
              <polyline className="pph-line outbound" points={outboundPoints} />
              <polyline className="pph-line total" points={totalPoints} />
              <text className="chart-axis-label x-axis" x="14" y="64">{rows[0]?.label ?? '--'}</text>
              <text className="chart-axis-label x-axis end" x="114" y="64">{latest?.label ?? '--'}</text>
            </svg>
          </div>
          <div className="des-hourly-summary">
            <LiveHourlySummaryCard label="Latest bucket" row={latest} />
            <LiveHourlySummaryCard label="Lowest total" row={minRow} />
            <LiveHourlySummaryCard label="Highest total" row={maxRow} />
          </div>
          <div className="trend-readout-grid">
            <div className="trend-readout">
              <span>Live balance since reset</span>
              <strong>{formatNumber(netInboundMinusOutbound, 0)}</strong>
              <small>completed inbound minus outbound; negative means outbound is consuming initial inventory.</small>
            </div>
            <div className="trend-readout">
              <span>Completed so far</span>
              <strong>{formatNumber(finalSample?.completedInbound ?? 0, 0)} / {formatNumber(finalSample?.completedOutbound ?? 0, 0)}</strong>
              <small>cumulative inbound / outbound from the physical tick model.</small>
            </div>
          </div>
          <div className="des-hourly-table-wrap">
            <table className="des-hourly-table">
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Total PPH</th>
                  <th>Cum In</th>
                  <th>Cum Out</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.startSec}-${row.endSec}`} className={row === minRow ? 'is-low' : row === maxRow ? 'is-high' : undefined}>
                    <td>{row.label}{row.isPartial ? ' partial' : ''}</td>
                    <td>{formatNumber(row.inboundPph, 1)} <small>({row.inboundDelta})</small></td>
                    <td>{formatNumber(row.outboundPph, 1)} <small>({row.outboundDelta})</small></td>
                    <td>{formatNumber(row.totalPph, 1)}</td>
                    <td>{row.completedInbound}</td>
                    <td>{row.completedOutbound}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="trend-definition">Live hourly PPH = bucket completed load delta / bucket hours. The latest bucket may be partial until the next full hour closes.</p>
        </>
      )}
    </section>
  );
}

function LiveHourlySummaryCard({ label, row }: { label: string; row: LiveHourlyThroughputRow | null }) {
  return (
    <div className="des-hourly-summary-card">
      <span>{label}</span>
      <strong>{row ? formatNumber(row.totalPph, 1) : '--'} PPH</strong>
      <small>{row ? `${row.label}${row.isPartial ? ' partial' : ''} · in ${formatNumber(row.inboundPph, 1)} / out ${formatNumber(row.outboundPph, 1)}` : 'waiting for live history'}</small>
    </div>
  );
}

export function buildLiveHourlyRows(history: PphHistorySample[]): LiveHourlyThroughputRow[] {
  const samples = history
    .filter((sample) => sample.completedInbound !== undefined && sample.completedOutbound !== undefined)
    .sort((left, right) => left.simTimeSec - right.simTimeSec);
  if (samples.length < 2) {
    return [];
  }

  const first = samples[0]!;
  const last = samples.at(-1)!;
  if (last.simTimeSec <= first.simTimeSec) {
    return [];
  }

  const anchors: Array<{ timeSec: number; sample: PphHistorySample }> = [{ timeSec: first.simTimeSec, sample: first }];
  const firstBoundary = Math.floor(first.simTimeSec / 3600) * 3600 + 3600;
  for (let boundarySec = firstBoundary; boundarySec < last.simTimeSec - 1e-9; boundarySec += 3600) {
    const sample = latestSampleAtOrBefore(samples, boundarySec);
    const previousAnchor = anchors.at(-1)!;
    if (sample.simTimeSec > previousAnchor.sample.simTimeSec + 1e-9) {
      anchors.push({ timeSec: boundarySec, sample });
    }
  }
  if (last.simTimeSec > anchors.at(-1)!.timeSec + 1e-9) {
    anchors.push({ timeSec: last.simTimeSec, sample: last });
  }

  const rows: LiveHourlyThroughputRow[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]!;
    const current = anchors[index]!;
    const periodSec = Math.max(1, current.timeSec - previous.timeSec);
    const periodHours = periodSec / 3600;
    const inboundDelta = Math.max(0, (current.sample.completedInbound ?? 0) - (previous.sample.completedInbound ?? 0));
    const outboundDelta = Math.max(0, (current.sample.completedOutbound ?? 0) - (previous.sample.completedOutbound ?? 0));
    rows.push({
      label: liveHourlyLabel(current.timeSec),
      startSec: previous.timeSec,
      endSec: current.timeSec,
      periodSec,
      inboundDelta,
      outboundDelta,
      inboundPph: inboundDelta / periodHours,
      outboundPph: outboundDelta / periodHours,
      totalPph: (inboundDelta + outboundDelta) / periodHours,
      completedInbound: current.sample.completedInbound ?? 0,
      completedOutbound: current.sample.completedOutbound ?? 0,
      isPartial: Math.abs(current.timeSec % 3600) > 1e-6
    });
  }
  return rows;
}

function latestSampleAtOrBefore(samples: PphHistorySample[], timeSec: number): PphHistorySample {
  let selected = samples[0]!;
  for (const sample of samples) {
    if (sample.simTimeSec > timeSec + 1e-9) {
      break;
    }
    selected = sample;
  }
  return selected;
}

function liveHourlyLabel(timeSec: number): string {
  const hour = Math.max(1, Math.ceil(timeSec / 3600));
  return `H${String(hour).padStart(2, '0')}`;
}

function liveHourlyLinePoints(
  rows: LiveHourlyThroughputRow[],
  valueForRow: (row: LiveHourlyThroughputRow) => number,
  maxValue: number
): string {
  return rows.map((row) => {
    const point = liveHourlyPointForRow(rows, row, valueForRow(row), maxValue);
    return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(' ');
}

function liveHourlyPointForRow(
  rows: LiveHourlyThroughputRow[],
  row: LiveHourlyThroughputRow,
  value: number,
  maxValue: number
): { x: number; y: number } {
  const minTime = rows[0]?.endSec ?? row.endSec;
  const maxTime = Math.max(minTime + 1, rows.at(-1)?.endSec ?? row.endSec);
  const x = 14 + ((row.endSec - minTime) / (maxTime - minTime)) * 100;
  const y = 52 - Math.max(0, Math.min(1, value / Math.max(1, maxValue))) * 44;
  return { x, y };
}

function DesPeriodSummaryCard({ label, row }: { label: string; row: DesPeriodThroughputRow | null }) {
  return (
    <div className="des-hourly-summary-card">
      <span>{label}</span>
      <strong>{row ? formatNumber(row.totalPph, 1) : '--'} PPH</strong>
      <small>{row ? `${row.label} · in ${formatNumber(row.inboundPph, 1)} / out ${formatNumber(row.outboundPph, 1)}` : 'waiting for DES result'}</small>
    </div>
  );
}

function buildDesPeriodRows(result: HeadlessDesResult | null): DesPeriodThroughputRow[] {
  if (!result || result.samples.length < 2) {
    return [];
  }
  const samples = [...result.samples].sort((left, right) => left.timeSec - right.timeSec);
  const rows: DesPeriodThroughputRow[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const periodSec = Math.max(1, current.timeSec - previous.timeSec);
    const periodHours = periodSec / 3600;
    const inboundDelta = current.completedInbound - previous.completedInbound;
    const outboundDelta = current.completedOutbound - previous.completedOutbound;
    rows.push({
      label: desPeriodLabel(previous.timeSec, current.timeSec),
      startSec: previous.timeSec,
      endSec: current.timeSec,
      periodSec,
      inboundDelta,
      outboundDelta,
      inboundPph: inboundDelta / periodHours,
      outboundPph: outboundDelta / periodHours,
      totalPph: (inboundDelta + outboundDelta) / periodHours,
      waitingPct: current.averageWaitingPct,
      repositionPct: current.averageRepositionPct
    });
  }
  return rows;
}

function desPeriodLabel(startSec: number, endSec: number): string {
  const periodSec = Math.max(1, endSec - startSec);
  if (periodSec >= 3599) {
    const endHour = Math.round(endSec / 3600);
    const day = Math.floor((endHour - 1) / 24) + 1;
    const hourOfDay = ((endHour - 1) % 24) + 1;
    return `D${day} H${String(hourOfDay).padStart(2, '0')}`;
  }
  return `${formatClock(startSec)}-${formatClock(endSec)}`;
}

function desPeriodLinePoints(
  rows: DesPeriodThroughputRow[],
  valueForRow: (row: DesPeriodThroughputRow) => number,
  maxValue: number
): string {
  return rows.map((row) => {
    const point = desPeriodPointForRow(rows, row, valueForRow(row), maxValue);
    return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(' ');
}

function desPeriodPointForRow(
  rows: DesPeriodThroughputRow[],
  row: DesPeriodThroughputRow,
  value: number,
  maxValue: number
): { x: number; y: number } {
  const minTime = rows[0]?.endSec ?? row.endSec;
  const maxTime = Math.max(minTime + 1, rows.at(-1)?.endSec ?? row.endSec);
  const x = 14 + ((row.endSec - minTime) / (maxTime - minTime)) * 100;
  const y = 52 - Math.max(0, Math.min(1, value / Math.max(1, maxValue))) * 44;
  return { x, y };
}

type DesIntegrityCheck = {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  evidence: string;
  formula: string;
};

function DesDataIntegrityPanel({ result }: { result: HeadlessDesResult | null }) {
  const checks = useMemo(() => buildDesIntegrityChecks(result), [result]);
  const failCount = checks.filter((check) => check.status === 'fail').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  const statusLabel = !result ? 'run DES first' : failCount > 0 ? `${failCount} fail` : warnCount > 0 ? `${warnCount} warning` : 'all pass';

  return (
    <section className="des-integrity-panel" aria-label="DES data integrity checks">
      <div className="panel-head compact">
        <div>
          <h2>DES Data Integrity</h2>
          <p>Formula-level checks proving the DES totals, period deltas, and yellow-grid route contract are internally consistent before using the run for review.</p>
        </div>
        <span>{statusLabel}</span>
      </div>
      {!result ? (
        <p className="empty-panel-note">Run DES 6h or DES 7d to recompute the evidence checks.</p>
      ) : (
        <div className="des-integrity-grid">
          {checks.map((check) => (
            <div className={`des-integrity-card ${check.status}`} key={check.id}>
              <span>{check.label}</span>
              <strong>{check.status}</strong>
              <small>{check.evidence}</small>
              <em>{check.formula}</em>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type DesReadinessCard = {
  label: string;
  status: 'pass' | 'watch' | 'site-data';
  value: string;
  detail: string;
};

function DesReviewReadinessPanel({ result }: { result: HeadlessDesResult | null }) {
  const integrityChecks = useMemo(() => buildDesIntegrityChecks(result), [result]);
  const failedIntegrityChecks = integrityChecks.filter((check) => check.status === 'fail').length;
  const criticalIssues = result?.issues.filter((issue) => issue.severity === 'critical').length ?? 0;
  const warningIssues = result?.issues.filter((issue) => issue.severity === 'warning').length ?? 0;
  const routeMisses = result?.routeModel.routeUnavailableCount ?? null;
  const cards: DesReadinessCard[] = [
    {
      label: 'Metric Evidence',
      status: !result ? 'watch' : failedIntegrityChecks === 0 ? 'pass' : 'watch',
      value: result ? `${failedIntegrityChecks} fail` : '--',
      detail: result ? `${integrityChecks.length} formula checks recomputed from DES samples` : 'run DES first'
    },
    {
      label: 'Yellow-grid Contract',
      status: !result ? 'watch' : routeMisses === 0 ? 'pass' : 'watch',
      value: routeMisses === null ? '--' : String(routeMisses),
      detail: result ? `${result.routeModel.reservationWindowCount} node/edge reservation windows` : 'route misses'
    },
    {
      label: 'DES Issue Gate',
      status: !result ? 'watch' : criticalIssues === 0 && warningIssues === 0 ? 'pass' : criticalIssues === 0 ? 'watch' : 'watch',
      value: result ? `${criticalIssues} critical` : '--',
      detail: result ? `${warningIssues} warning; ${result.issues.length} total DES issue(s)` : 'critical issue gate'
    },
    {
      label: 'Site Calibration',
      status: 'site-data',
      value: 'needed',
      detail: 'capacity is internally verified, not customer site-calibrated until WCS/MES, PLC/video, CAD, motion, and controls data replace assumptions'
    }
  ];

  return (
    <section className="des-readiness-panel" aria-label="DES review readiness">
      <div className="panel-head compact">
        <div>
          <h2>Review Readiness</h2>
          <p>Pass/fail boundary for Monday review: internal DES evidence can be discussed, but site-calibrated capacity still needs customer data.</p>
        </div>
        <span>{result ? (failedIntegrityChecks === 0 && routeMisses === 0 && criticalIssues === 0 ? 'internal pass' : 'watch') : 'run DES first'}</span>
      </div>
      <div className="des-readiness-grid">
        {cards.map((card) => (
          <div className={`des-readiness-card ${card.status}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.detail}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function buildDesIntegrityChecks(result: HeadlessDesResult | null): DesIntegrityCheck[] {
  if (!result) return [];
  const samples = [...result.samples].sort((left, right) => left.timeSec - right.timeSec);
  const rows = buildDesPeriodRows(result);
  const firstSample = samples[0] ?? null;
  const finalSample = samples.at(-1) ?? null;
  const durationHours = Math.max(1e-9, result.durationSec / 3600);
  const inboundDeltaSum = rows.reduce((sum, row) => sum + row.inboundDelta, 0);
  const outboundDeltaSum = rows.reduce((sum, row) => sum + row.outboundDelta, 0);
  const finalCountsMatch = Boolean(finalSample)
    && finalSample!.completedInbound === result.completedInbound
    && finalSample!.completedOutbound === result.completedOutbound;
  const deltaCountsMatch = Boolean(firstSample)
    && inboundDeltaSum === result.completedInbound - firstSample!.completedInbound
    && outboundDeltaSum === result.completedOutbound - firstSample!.completedOutbound;
  const cumulativePphPass = closeEnough(result.inboundPph, result.completedInbound / durationHours)
    && closeEnough(result.outboundPph, result.completedOutbound / durationHours)
    && closeEnough(result.totalPph, (result.completedInbound + result.completedOutbound) / durationHours);
  const periodFormulaPass = rows.every((row) => {
    const periodHours = Math.max(1e-9, row.periodSec / 3600);
    return closeEnough(row.inboundPph, row.inboundDelta / periodHours)
      && closeEnough(row.outboundPph, row.outboundDelta / periodHours)
      && closeEnough(row.totalPph, (row.inboundDelta + row.outboundDelta) / periodHours)
      && closeEnough(row.totalPph, row.inboundPph + row.outboundPph);
  });
  const sampleMonotonicPass = samples.every((sample, index) => {
    if (index === 0) return Number.isFinite(sample.timeSec);
    const previous = samples[index - 1]!;
    return sample.timeSec > previous.timeSec
      && sample.completedInbound >= previous.completedInbound
      && sample.completedOutbound >= previous.completedOutbound;
  });
  const finiteMetricsPass = samples.every((sample) =>
    [
      sample.inboundPph,
      sample.outboundPph,
      sample.totalPph,
      sample.windowTotalPph,
      sample.averageWaitingPct,
      sample.averageRepositionPct
    ].every(Number.isFinite)
  ) && [
    result.inboundPph,
    result.outboundPph,
    result.totalPph,
    result.averageWaitingPct,
    result.averageRepositionPct
  ].every(Number.isFinite);
  const criticalIssueCount = result.issues.filter((issue) => issue.severity === 'critical').length;

  return [
    {
      id: 'final-counts',
      label: 'Final Counts',
      status: finalCountsMatch ? 'pass' : 'fail',
      evidence: `sample ${finalSample?.completedInbound ?? '-'} / ${finalSample?.completedOutbound ?? '-'}; result ${result.completedInbound} / ${result.completedOutbound}`,
      formula: 'final sample completed in/out = DES result completed in/out'
    },
    {
      id: 'period-deltas',
      label: 'Period Delta Sum',
      status: deltaCountsMatch ? 'pass' : 'fail',
      evidence: `delta sum in/out ${inboundDeltaSum} / ${outboundDeltaSum}; rows ${rows.length}`,
      formula: 'sum(period completed deltas) = final cumulative - first cumulative'
    },
    {
      id: 'cumulative-pph',
      label: 'Cumulative PPH',
      status: cumulativePphPass ? 'pass' : 'fail',
      evidence: `in ${formatNumber(result.inboundPph, 3)}, out ${formatNumber(result.outboundPph, 3)}, total ${formatNumber(result.totalPph, 3)}`,
      formula: 'PPH = completed loads / elapsed hours'
    },
    {
      id: 'period-pph',
      label: 'Period PPH',
      status: periodFormulaPass ? 'pass' : 'fail',
      evidence: `${rows.length} period rows recomputed from sample deltas`,
      formula: 'period PPH = period delta / period hours; total = inbound + outbound'
    },
    {
      id: 'samples-monotonic',
      label: 'Sample Order',
      status: sampleMonotonicPass ? 'pass' : 'fail',
      evidence: `${samples.length} samples; final time ${formatClock(finalSample?.timeSec ?? 0)}`,
      formula: 'time and completed counts are monotonic'
    },
    {
      id: 'finite-metrics',
      label: 'Finite Metrics',
      status: finiteMetricsPass ? 'pass' : 'fail',
      evidence: finiteMetricsPass ? 'all DES result and sample metrics are finite' : 'non-finite metric detected',
      formula: 'all displayed DES numeric fields must be finite'
    },
    {
      id: 'yellow-route-contract',
      label: 'Yellow-grid Routes',
      status: result.routeModel.routeUnavailableCount === 0 ? 'pass' : 'fail',
      evidence: `${result.routeModel.routeUnavailableCount} unavailable; ${result.routeModel.reservationWindowCount} reservation windows`,
      formula: 'every DES task endpoint must route on the verified yellow-grid graph'
    },
    {
      id: 'critical-issues',
      label: 'Critical Issues',
      status: criticalIssueCount === 0 ? (result.issues.length > 0 ? 'warn' : 'pass') : 'fail',
      evidence: `${criticalIssueCount} critical; ${result.issues.length} total DES issue(s)`,
      formula: 'critical DES issue count must be zero for review use'
    }
  ];
}

function closeEnough(actual: number, expected: number, tolerance = 0.02): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function DesIeFindingsPanel({ result }: { result: HeadlessDesResult | null }) {
  const issues = useMemo(() => (
    [...(result?.issues ?? [])].sort((left, right) => issueSeverityRank(left.severity) - issueSeverityRank(right.severity))
  ), [result]);
  const topBottlenecks = result?.trafficBottlenecks.slice(0, 6) ?? [];
  const trafficWaitPct = result?.waitReasonBreakdown['traffic-reservation-wait']?.pct ?? 0;
  const liftWaitPct = result?.waitReasonBreakdown['lift-resource-wait']?.pct ?? 0;
  const topResource = topBottlenecks[0] ?? null;
  const findingLabel = !result
    ? 'run DES first'
    : issues.some((issue) => issue.severity === 'critical')
      ? 'critical'
      : issues.some((issue) => issue.severity === 'warning')
        ? 'watch'
        : 'observation';

  return (
    <section className="des-findings-panel" aria-label="DES industrial engineering findings">
      <div className="panel-head compact">
        <div>
          <h2>DES IE Findings</h2>
          <p>Industrial-engineering readout from the DES run: what tripped, where traffic waits accumulate, and what to inspect first.</p>
        </div>
        <span>{findingLabel}</span>
      </div>
      {!result ? (
        <p className="empty-panel-note">Run DES 6h or DES 7d to generate findings and bottleneck evidence.</p>
      ) : (
        <div className="des-findings-layout">
          <div className="des-issue-list">
            {issues.map((issue) => (
              <article className={`des-issue-card ${issue.severity}`} key={issue.id}>
                <span>{issue.severity}</span>
                <h3>{issue.title}</h3>
                <strong>{issue.metric}</strong>
                <p>{issue.detail}</p>
                <em>{issue.recommendation}</em>
              </article>
            ))}
          </div>
          <div className="des-bottleneck-card">
            <div className="des-bottleneck-summary">
              <div>
                <span>Traffic Wait</span>
                <strong>{formatNumber(trafficWaitPct, 1)}%</strong>
              </div>
              <div>
                <span>Lift Wait</span>
                <strong>{formatNumber(liftWaitPct, 1)}%</strong>
              </div>
              <div>
                <span>First Inspect</span>
                <strong>{topResource ? resourceShortName(topResource.resourceId) : 'none'}</strong>
              </div>
            </div>
            <h3>Top Traffic Resources</h3>
            {topBottlenecks.length === 0 ? (
              <p className="muted">No traffic reservation waits recorded.</p>
            ) : (
              <table className="des-bottleneck-table">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Wait</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {topBottlenecks.map((resource) => (
                    <tr key={resource.resourceId}>
                      <td title={resource.resourceId}>{resourceShortName(resource.resourceId)}</td>
                      <td>{formatNumber(resource.waitSec, 1)}s</td>
                      <td>{resource.waitCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="trend-definition">
              Top traffic resources are yellow-grid node/edge reservation windows with the largest accumulated wait. Use these IDs to inspect the DES replay and route map around congestion periods.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export type DesDispatchAuditRow = {
  taskId: string;
  shuttleId: string;
  kind: HeadlessDesResult['reservationReplay']['tasks'][number]['kind'];
  dispatchSec: number;
  completeSec: number;
  emptyRouteNodeCount: number;
  loadedRouteNodeCount: number;
  routeNodeCount: number;
  movementSec: number;
  handlingSec: number;
  trafficWaitSec: number;
  liftWaitSec: number;
  totalWaitSec: number;
  primaryWaitResource: string;
  routeStatus: 'pass' | 'watch' | 'fail';
  routeEvidence: string;
  dispatchEvidence: string;
  avoidanceEvidence: string;
};

function DesDispatchAvoidanceAuditPanel({ scenario, result }: { scenario: ShuttleScenario | null; result: HeadlessDesResult | null }) {
  const rows = useMemo(() => buildDesDispatchAuditRows(scenario, result), [result, scenario]);
  const passCount = rows.filter((row) => row.routeStatus === 'pass').length;
  const watchCount = rows.filter((row) => row.routeStatus === 'watch').length;
  const failCount = rows.filter((row) => row.routeStatus === 'fail').length;
  const topWaitRow = rows.reduce<DesDispatchAuditRow | null>(
    (best, row) => (best === null || row.totalWaitSec > best.totalWaitSec ? row : best),
    null
  );
  const totalTraceWaitSec = rows.reduce((sum, row) => sum + row.totalWaitSec, 0);
  const rowLimit = rows.slice(0, 12);

  return (
    <section className="des-dispatch-audit-panel" aria-label="DES dispatch and avoidance audit">
      <div className="panel-head compact">
        <div>
          <h2>DES Dispatch & Avoidance Audit</h2>
          <p>Trace-level IE check of task assignment, yellow-grid route contract, and reservation waits. This is the table to use when a path looks wrong in 3D.</p>
        </div>
        <span>{result ? `${rows.length} traced tasks` : 'run DES first'}</span>
      </div>
      {!result ? (
        <p className="empty-panel-note">Run DES 6h or DES 7d to show dispatch and avoidance evidence.</p>
      ) : (
        <>
          <div className="des-dispatch-rule-grid">
            <div>
              <span>Dispatch Gate</span>
              <strong>cap {result.controlPolicy.maxActiveTasks}</strong>
              <small>{formatNumber(result.controlPolicy.backpressureHoldCount, 0)} held releases; active tasks are bounded before routing.</small>
            </div>
            <div>
              <span>Route Contract</span>
              <strong>{failCount === 0 ? 'yellow-grid pass' : 'route fail'}</strong>
              <small>{passCount} pass, {watchCount} watch, {failCount} fail across traced tasks.</small>
            </div>
            <div>
              <span>Avoidance Rule</span>
              <strong>capacity 1</strong>
              <small>Node/edge/lift reservation waits are explicit; shuttles wait instead of crossing occupied resources.</small>
            </div>
            <div>
              <span>Worst Trace Wait</span>
              <strong>{topWaitRow ? `${formatNumber(topWaitRow.totalWaitSec, 1)}s` : '--'}</strong>
              <small>{topWaitRow ? `${topWaitRow.shuttleId} ${topWaitRow.taskId} · ${topWaitRow.primaryWaitResource}` : `${formatNumber(totalTraceWaitSec, 1)}s traced wait`}</small>
            </div>
          </div>
          <div className="des-dispatch-table-wrap">
            <table className="des-dispatch-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Dispatch</th>
                  <th>Yellow Route</th>
                  <th>Wait / Avoidance</th>
                  <th>IE Read</th>
                </tr>
              </thead>
              <tbody>
                {rowLimit.map((row) => (
                  <tr className={`status-${row.routeStatus}`} key={row.taskId}>
                    <td>
                      <strong>{row.taskId}</strong>
                      <small>{row.shuttleId} · {row.kind}</small>
                    </td>
                    <td>
                      <strong>{formatClock(row.dispatchSec)}</strong>
                      <small>{row.dispatchEvidence}</small>
                    </td>
                    <td>
                      <strong>{row.routeStatus}</strong>
                      <small>{row.routeEvidence}</small>
                    </td>
                    <td>
                      <strong>{formatNumber(row.totalWaitSec, 1)}s</strong>
                      <small>{row.avoidanceEvidence}</small>
                    </td>
                    <td>
                      <strong>{row.primaryWaitResource}</strong>
                      <small>{formatNumber(row.movementSec, 1)}s move, {formatNumber(row.handlingSec, 1)}s handle</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > rowLimit.length ? (
            <p className="trend-definition">Showing first {rowLimit.length} traced tasks from the DES replay sample; aggregate bottlenecks remain summarized above and on the route map.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

export function buildDesDispatchAuditRows(
  scenario: ShuttleScenario | null,
  result: HeadlessDesResult | null,
  limit = 24
): DesDispatchAuditRow[] {
  if (!result) return [];
  const nodes = new Set((scenario?.layout.nodes ?? []).map((node) => node.id));
  const edgePairs = new Set<string>();
  for (const edge of scenario?.layout.edges ?? []) {
    edgePairs.add(`${edge.from}->${edge.to}`);
    edgePairs.add(`${edge.to}->${edge.from}`);
  }

  return result.reservationReplay.tasks.slice(0, limit).map((trace) => {
    const allRouteNodeIds = [...trace.emptyRouteNodeIds, ...trace.loadedRouteNodeIds];
    const missingNodes = allRouteNodeIds.filter((nodeId) => !nodes.has(nodeId));
    const missingEdges = [...adjacentPairs(trace.emptyRouteNodeIds), ...adjacentPairs(trace.loadedRouteNodeIds)]
      .filter(([from, to]) => !edgePairs.has(`${from}->${to}`));
    const waitPhases = trace.phases
      .filter((phase) => phase.kind === 'traffic-wait' || phase.kind === 'lift-wait')
      .map((phase) => ({
        ...phase,
        waitSec: Math.max(0, phase.endSec - phase.startSec)
      }))
      .sort((left, right) => right.waitSec - left.waitSec);
    const topWait = waitPhases[0] ?? null;
    const totalWaitSec = trace.trafficWaitSec + trace.liftWaitSec;
    const routeStatus: DesDispatchAuditRow['routeStatus'] = missingNodes.length > 0 || missingEdges.length > 0 || result.routeModel.routeUnavailableCount > 0
      ? 'fail'
      : totalWaitSec >= 30 || allRouteNodeIds.length >= 46
        ? 'watch'
        : 'pass';
    const routeEvidence = missingNodes.length > 0
      ? `off-grid nodes: ${missingNodes.slice(0, 3).join(', ')}`
      : missingEdges.length > 0
        ? `missing edge: ${missingEdges[0]![0]} -> ${missingEdges[0]![1]}`
        : `empty ${trace.emptyRouteNodeIds.length} nodes, loaded ${trace.loadedRouteNodeIds.length} nodes`;
    const primaryWaitResource = topWait?.resourceId
      ? resourceShortName(topWait.resourceId)
      : totalWaitSec > 0
        ? 'wait without resource id'
        : 'no wait';

    return {
      taskId: trace.taskId,
      shuttleId: trace.shuttleId,
      kind: trace.kind,
      dispatchSec: trace.dispatchSec,
      completeSec: trace.completeSec,
      emptyRouteNodeCount: trace.emptyRouteNodeIds.length,
      loadedRouteNodeCount: trace.loadedRouteNodeIds.length,
      routeNodeCount: allRouteNodeIds.length,
      movementSec: trace.emptyTravelSec + trace.loadedTravelSec,
      handlingSec: trace.handlingSec,
      trafficWaitSec: trace.trafficWaitSec,
      liftWaitSec: trace.liftWaitSec,
      totalWaitSec,
      primaryWaitResource,
      routeStatus,
      routeEvidence,
      dispatchEvidence: `released at ${formatClock(trace.dispatchSec)} under cap ${result.controlPolicy.maxActiveTasks}`,
      avoidanceEvidence: `${formatNumber(trace.trafficWaitSec, 1)}s traffic, ${formatNumber(trace.liftWaitSec, 1)}s lift`
    };
  });
}

function adjacentPairs(nodeIds: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 1; index < nodeIds.length; index += 1) {
    pairs.push([nodeIds[index - 1]!, nodeIds[index]!]);
  }
  return pairs;
}

function issueSeverityRank(severity: HeadlessDesResult['issues'][number]['severity']): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function resourceShortName(resourceId: string): string {
  return resourceId
    .replace(/^node:/, 'node ')
    .replace(/^edge:/, 'edge ')
    .replace(/^(.{38}).+$/, '$1...');
}

function bottleneckMarkerLabel(marker: DesReplayBottleneckMarker): string {
  return marker.rank <= 3
    ? `#${marker.rank} ${formatNumber(marker.waitSec, 0)}s`
    : `#${marker.rank}`;
}

function bottleneckLabelDx(rank: number): number {
  return rank === 2 || rank === 6 ? -0.5 : 0.55;
}

function bottleneckLabelOffset(rank: number): number {
  return (rank - 1) % 3 * 0.56;
}

function bottleneckLabelAnchor(rank: number): 'start' | 'end' {
  return rank === 2 || rank === 6 ? 'end' : 'start';
}

function DesReservationReplayPanel({ scenario, result }: { scenario: ShuttleScenario | null; result: HeadlessDesResult | null }) {
  const replay = result?.reservationReplay;
  const tasks = replay?.tasks ?? [];
  const [playheadSec, setPlayheadSec] = useState(0);
  const tracesByShuttle = new Map<string, typeof tasks>();
  for (const trace of tasks) {
    const rows = tracesByShuttle.get(trace.shuttleId) ?? [];
    rows.push(trace);
    tracesByShuttle.set(trace.shuttleId, rows);
  }
  const maxTraceSec = Math.max(1, ...tasks.map((trace) => trace.completeSec));
  const map = useMemo(
    () => createDesReplayStaticMapModel(scenario, tasks, result?.trafficBottlenecks ?? []),
    [result?.trafficBottlenecks, scenario, tasks]
  );
  const vehicles = useMemo(
    () => createDesReplayVehicles(tasks, playheadSec, map.nodeMap, map.edgeMap),
    [map, playheadSec, tasks]
  );
  useEffect(() => {
    if (!replay || tasks.length === 0) {
      setPlayheadSec(0);
      return undefined;
    }
    const startedAtMs = performance.now();
    const loopMs = 12000;
    const intervalId = window.setInterval(() => {
      const nowMs = performance.now();
      const ratio = ((nowMs - startedAtMs) % loopMs) / loopMs;
      setPlayheadSec(ratio * maxTraceSec);
    }, 125);
    return () => window.clearInterval(intervalId);
  }, [maxTraceSec, replay, tasks.length]);
  const visibleWaits = replay?.topWaitIntervals.slice(0, 8) ?? [];
  const waitSummary = useMemo(() => {
    const summary = tasks.reduce(
      (next, trace) => ({
        trafficWaitSec: next.trafficWaitSec + trace.trafficWaitSec,
        liftWaitSec: next.liftWaitSec + trace.liftWaitSec,
        travelSec: next.travelSec + trace.emptyTravelSec + trace.loadedTravelSec,
        handlingSec: next.handlingSec + trace.handlingSec,
        taskCount: next.taskCount + 1
      }),
      { trafficWaitSec: 0, liftWaitSec: 0, travelSec: 0, handlingSec: 0, taskCount: 0 }
    );
    const totalObservedSec = summary.trafficWaitSec + summary.liftWaitSec + summary.travelSec + summary.handlingSec;
    const totalWaitSec = summary.trafficWaitSec + summary.liftWaitSec;
    return {
      ...summary,
      totalWaitSec,
      totalObservedSec,
      waitSharePct: totalObservedSec > 0 ? totalWaitSec / totalObservedSec * 100 : 0,
      trafficWaitSharePct: totalWaitSec > 0 ? summary.trafficWaitSec / totalWaitSec * 100 : 0,
      liftWaitSharePct: totalWaitSec > 0 ? summary.liftWaitSec / totalWaitSec * 100 : 0,
      avgWaitPerTaskSec: summary.taskCount > 0 ? totalWaitSec / summary.taskCount : 0,
      dominantWait: summary.trafficWaitSec >= summary.liftWaitSec ? 'traffic reservation' : 'lift resource'
    };
  }, [tasks]);
  const phaseClass = (kind: HeadlessDesResult['reservationReplay']['tasks'][number]['phases'][number]['kind']): string => {
    if (kind === 'traffic-wait') return 'wait';
    if (kind === 'lift-wait') return 'lift-wait';
    if (kind === 'lift-handle' || kind === 'lower-handle') return 'handle';
    if (kind === 'loaded-travel') return 'loaded';
    return 'empty';
  };
  const phaseLabel = (kind: HeadlessDesResult['reservationReplay']['tasks'][number]['phases'][number]['kind']): string => {
    if (kind === 'traffic-wait') return 'traffic wait';
    if (kind === 'lift-wait') return 'lift wait';
    if (kind === 'lift-handle') return 'lift';
    if (kind === 'lower-handle') return 'lower';
    if (kind === 'loaded-travel') return 'loaded';
    return 'empty';
  };

  return (
    <section className="des-replay-panel" aria-label="DES reservation replay">
      <div className="panel-head compact">
        <div>
          <h2>DES Reservation Replay</h2>
          <p>Trace sample of yellow-grid node/edge reservation behavior. Orange bars are reservation waits; blue/green bars are travel and handling windows.</p>
        </div>
        <span>{replay ? `${replay.tracedTaskCount} traced / ${replay.omittedTaskCount} omitted` : 'run DES first'}</span>
      </div>
      {!replay || tasks.length === 0 ? (
        <p className="empty-panel-note">Run DES 6h or DES 7d to generate replay evidence.</p>
      ) : (
        <div className="des-replay-stack">
          <div className="des-route-playback">
            <div className="des-route-map">
              <svg viewBox={`${map.minX} ${-map.maxZ} ${map.width} ${map.depth}`} role="img" aria-label="Animated DES route playback">
                {map.edges.map((edge) => (
                  <line
                    className="des-route-grid-edge"
                    key={edge.id}
                    x1={edge.from.x}
                    y1={-edge.from.z}
                    x2={edge.to.x}
                    y2={-edge.to.z}
                  />
                ))}
                {map.routePolylines.map((route) => (
                  <polyline
                    className={`des-route-path ${route.kind}`}
                    key={route.id}
                    points={route.points.map((point) => `${point.x},${-point.z}`).join(' ')}
                  />
                ))}
                {map.bottleneckMarkers.map((marker) => (
                  marker.kind === 'edge' ? (
                    <g className="des-route-bottleneck edge" key={marker.id}>
                      <line
                        x1={marker.from.x}
                        y1={-marker.from.z}
                        x2={marker.to.x}
                        y2={-marker.to.z}
                      />
                      <text
                        x={(marker.from.x + marker.to.x) / 2 + bottleneckLabelDx(marker.rank)}
                        y={-(marker.from.z + marker.to.z) / 2 - 0.35 - bottleneckLabelOffset(marker.rank)}
                        textAnchor={bottleneckLabelAnchor(marker.rank)}
                      >
                        {bottleneckMarkerLabel(marker)}
                      </text>
                    </g>
                  ) : (
                    <g className="des-route-bottleneck node" key={marker.id}>
                      <circle cx={marker.point.x} cy={-marker.point.z} r={0.62} />
                      <text
                        x={marker.point.x + bottleneckLabelDx(marker.rank)}
                        y={-marker.point.z - 0.55 - bottleneckLabelOffset(marker.rank)}
                        textAnchor={bottleneckLabelAnchor(marker.rank)}
                      >
                        {bottleneckMarkerLabel(marker)}
                      </text>
                    </g>
                  )
                ))}
                {vehicles.map((vehicle) => (
                  <g className={`des-route-vehicle ${vehicle.kind} ${vehicle.phaseKind}`} key={vehicle.shuttleId}>
                    <circle cx={vehicle.point.x} cy={-vehicle.point.z} r={0.42} />
                    <text x={vehicle.point.x + 0.55} y={-vehicle.point.z - 0.42}>{vehicle.shuttleId.replace('SH-', '')}</text>
                  </g>
                ))}
              </svg>
            </div>
            <div className="des-route-readout">
              <span>Replay time</span>
              <strong>{formatClock(playheadSec)}</strong>
              <small>{vehicles.length} active DES vehicle traces</small>
              <div className="des-wait-mini">
                <b>{formatNumber(waitSummary.waitSharePct, 1)}%</b>
                <span>wait inside traced DES sample</span>
              </div>
            </div>
          </div>
          <div className="des-replay-layout">
          <div className="des-replay-timeline">
            <div className="des-replay-axis">
              <span>00:00</span>
              <span>{formatClock(maxTraceSec)}</span>
            </div>
            {[...tracesByShuttle.entries()].map(([shuttleId, traces]) => (
              <div className="des-replay-row" key={shuttleId}>
                <div className="des-replay-label">
                  <strong>{shuttleId}</strong>
                  <small>{traces.length} task traces</small>
                </div>
                <div className="des-replay-lane">
                  <span className="des-replay-cursor" aria-hidden="true" />
                  {traces.flatMap((trace) => trace.phases.map((phase, index) => {
                    const left = Math.max(0, Math.min(100, phase.startSec / maxTraceSec * 100));
                    const right = Math.max(left + 0.18, Math.min(100, phase.endSec / maxTraceSec * 100));
                    return (
                      <span
                        className={`des-replay-phase ${phaseClass(phase.kind)} ${trace.kind}`}
                        key={`${trace.taskId}-${phase.kind}-${index}`}
                        style={{ left: `${left}%`, width: `${Math.max(0.18, right - left)}%` }}
                        title={`${trace.shuttleId} ${trace.kind} ${phaseLabel(phase.kind)} ${formatClock(phase.startSec)}-${formatClock(phase.endSec)}${phase.resourceId ? ` / ${phase.resourceId}` : ''}`}
                      />
                    );
                  }))}
                </div>
              </div>
            ))}
            <div className="des-replay-legend">
              <span className="empty">Empty travel</span>
              <span className="loaded">Loaded travel</span>
              <span className="handle">Lift/lower</span>
              <span className="wait">Traffic wait</span>
              <span className="lift-wait">Lift wait</span>
              <span className="bottleneck">Top bottleneck</span>
            </div>
          </div>
          <div className="des-replay-waits">
            <div className="des-wait-summary">
              <h3>Wait Reason Summary</h3>
              <div className="des-wait-summary-grid">
                <div>
                  <span>Dominant</span>
                  <strong>{waitSummary.totalWaitSec > 0 ? waitSummary.dominantWait : 'none'}</strong>
                </div>
                <div>
                  <span>Traffic</span>
                  <strong>{formatNumber(waitSummary.trafficWaitSec, 1)}s</strong>
                  <small>{formatNumber(waitSummary.trafficWaitSharePct, 1)}% of wait</small>
                </div>
                <div>
                  <span>Lift</span>
                  <strong>{formatNumber(waitSummary.liftWaitSec, 1)}s</strong>
                  <small>{formatNumber(waitSummary.liftWaitSharePct, 1)}% of wait</small>
                </div>
                <div>
                  <span>Avg wait/task</span>
                  <strong>{formatNumber(waitSummary.avgWaitPerTaskSec, 1)}s</strong>
                </div>
              </div>
            </div>
            <h3>Top Wait Intervals</h3>
            {visibleWaits.length === 0 ? (
              <p>No reservation waits in traced horizon.</p>
            ) : (
              <table>
                <thead><tr><th>Time</th><th>Unit</th><th>Wait</th><th>Resource</th></tr></thead>
                <tbody>
                  {visibleWaits.map((wait) => (
                    <tr key={`${wait.taskId}-${wait.startSec}-${wait.endSec}`}>
                      <td>{formatClock(wait.startSec)}</td>
                      <td>{wait.shuttleId}</td>
                      <td>{formatNumber(wait.waitSec, 1)}s</td>
                      <td>{wait.resourceId ?? wait.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        </div>
      )}
    </section>
  );
}

type DesReplayTaskTrace = HeadlessDesResult['reservationReplay']['tasks'][number];
type DesReplayPoint = { x: number; z: number };
type DesReplayLayoutNode = ShuttleScenario['layout']['nodes'][number];
type DesReplayLayoutEdge = ShuttleScenario['layout']['edges'][number];
type DesReplayTrafficBottleneck = HeadlessDesResult['trafficBottlenecks'][number];
type DesReplayBottleneckMarker =
  | {
    kind: 'node';
    id: string;
    resourceId: string;
    rank: number;
    waitSec: number;
    waitCount: number;
    point: DesReplayPoint;
  }
  | {
    kind: 'edge';
    id: string;
    resourceId: string;
    rank: number;
    waitSec: number;
    waitCount: number;
    from: DesReplayPoint;
    to: DesReplayPoint;
  };

function createDesReplayStaticMapModel(
  scenario: ShuttleScenario | null,
  traces: DesReplayTaskTrace[],
  trafficBottlenecks: DesReplayTrafficBottleneck[]
) {
  const nodes = scenario?.layout.nodes ?? [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const edgeMap = new Map((scenario?.layout.edges ?? []).map((edge) => [edge.id, edge]));
  const replayNodeIds = new Set(traces.flatMap((trace) => [...trace.emptyRouteNodeIds, ...trace.loadedRouteNodeIds]));
  const replayNodes = nodes.filter((node) => replayNodeIds.has(node.id));
  const boundsNodes = replayNodes.length > 1 ? replayNodes : nodes;
  const xValues = boundsNodes.map((node) => node.x);
  const zValues = boundsNodes.map((node) => node.z);
  const minX = Math.min(...xValues, 0) - 2;
  const maxX = Math.max(...xValues, 1) + 2;
  const minZ = Math.min(...zValues, -1) - 2;
  const maxZ = Math.max(...zValues, 1) + 2;
  const edgeLimit = 600;
  const edges = (scenario?.layout.edges ?? [])
    .filter((edge) => replayNodeIds.has(edge.from) || replayNodeIds.has(edge.to))
    .slice(0, edgeLimit)
    .flatMap((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      return from && to ? [{ id: edge.id, from, to }] : [];
    });
  const routePolylines = traces.slice(0, 28).flatMap((trace) => [
    {
      id: `${trace.taskId}-empty`,
      kind: 'empty',
      points: routePoints(trace.emptyRouteNodeIds, nodeMap)
    },
    {
      id: `${trace.taskId}-loaded`,
      kind: trace.kind,
      points: routePoints(trace.loadedRouteNodeIds, nodeMap)
    }
  ]).filter((route) => route.points.length > 1);
  const bottleneckMarkers = trafficBottlenecks
    .slice(0, 6)
    .flatMap((resource, index) => createDesReplayBottleneckMarker(resource, index + 1, nodeMap, edgeMap));
  return {
    minX,
    maxZ,
    width: Math.max(1, maxX - minX),
    depth: Math.max(1, maxZ - minZ),
    edges,
    routePolylines,
    bottleneckMarkers,
    nodeMap,
    edgeMap
  };
}

function createDesReplayBottleneckMarker(
  resource: DesReplayTrafficBottleneck,
  rank: number,
  nodeMap: Map<string, DesReplayLayoutNode>,
  edgeMap: Map<string, DesReplayLayoutEdge>
): DesReplayBottleneckMarker[] {
  if (resource.resourceId.startsWith('node:')) {
    const nodeId = resource.resourceId.slice('node:'.length);
    const node = nodeMap.get(nodeId);
    return node
      ? [{
        kind: 'node',
        id: `${resource.resourceId}-${rank}`,
        resourceId: resource.resourceId,
        rank,
        waitSec: resource.waitSec,
        waitCount: resource.waitCount,
        point: { x: node.x, z: node.z }
      }]
      : [];
  }
  if (resource.resourceId.startsWith('edge:')) {
    const edgeId = resource.resourceId.slice('edge:'.length);
    const edge = edgeMap.get(edgeId);
    const from = edge ? nodeMap.get(edge.from) : null;
    const to = edge ? nodeMap.get(edge.to) : null;
    return from && to
      ? [{
        kind: 'edge',
        id: `${resource.resourceId}-${rank}`,
        resourceId: resource.resourceId,
        rank,
        waitSec: resource.waitSec,
        waitCount: resource.waitCount,
        from: { x: from.x, z: from.z },
        to: { x: to.x, z: to.z }
      }]
      : [];
  }
  return [];
}

function createDesReplayVehicles(
  traces: DesReplayTaskTrace[],
  playheadSec: number,
  nodeMap: Map<string, DesReplayLayoutNode>,
  edgeMap: Map<string, DesReplayLayoutEdge>
) {
  return [...new Set(traces.map((trace) => trace.shuttleId))]
    .flatMap((shuttleId) => {
      const trace = traces.find((candidate) => candidate.shuttleId === shuttleId && candidate.dispatchSec <= playheadSec && playheadSec <= candidate.completeSec);
      if (!trace) return [];
      const phase = trace.phases.find((candidate) => candidate.startSec <= playheadSec && playheadSec <= candidate.endSec) ?? trace.phases.at(-1);
      if (!phase) return [];
      return [{
        shuttleId,
        kind: trace.kind,
        phaseKind: phase.kind,
        point: pointForReplayPhase(trace, phase, playheadSec, nodeMap, edgeMap)
      }];
    });
}

function routePoints(
  nodeIds: string[],
  nodeMap: Map<string, DesReplayLayoutNode>
): DesReplayPoint[] {
  return nodeIds.flatMap((nodeId) => {
    const node = nodeMap.get(nodeId);
    return node ? [{ x: node.x, z: node.z }] : [];
  });
}

function pointForReplayPhase(
  trace: DesReplayTaskTrace,
  phase: DesReplayTaskTrace['phases'][number],
  timeSec: number,
  nodeMap: Map<string, DesReplayLayoutNode>,
  edgeMap: Map<string, DesReplayLayoutEdge>
): DesReplayPoint {
  if (phase.kind === 'empty-travel') {
    return interpolateRoutePoint(trace.emptyRouteNodeIds, phase, timeSec, nodeMap);
  }
  if (phase.kind === 'loaded-travel') {
    return interpolateRoutePoint(trace.loadedRouteNodeIds, phase, timeSec, nodeMap);
  }
  const resourcePoint = pointForResourceId(phase.resourceId, nodeMap, edgeMap);
  if (resourcePoint) {
    return resourcePoint;
  }
  const fallbackNode = nodeMap.get(trace.dropoffNodeId) ?? nodeMap.get(trace.pickupNodeId) ?? nodeMap.get(trace.storageNodeId);
  return fallbackNode ? { x: fallbackNode.x, z: fallbackNode.z } : { x: 0, z: 0 };
}

function interpolateRoutePoint(
  nodeIds: string[],
  phase: DesReplayTaskTrace['phases'][number],
  timeSec: number,
  nodeMap: Map<string, DesReplayLayoutNode>
): DesReplayPoint {
  const points = routePoints(nodeIds, nodeMap);
  if (points.length === 0) return { x: 0, z: 0 };
  if (points.length === 1) return points[0]!;
  const ratio = Math.max(0, Math.min(1, (timeSec - phase.startSec) / Math.max(0.001, phase.endSec - phase.startSec)));
  const segmentLengths = points.slice(1).map((point, index) => distance2d(points[index]!, point));
  const totalLength = Math.max(0.001, segmentLengths.reduce((sum, length) => sum + length, 0));
  let remaining = ratio * totalLength;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const length = segmentLengths[index]!;
    if (remaining <= length || index === segmentLengths.length - 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const localRatio = Math.max(0, Math.min(1, remaining / Math.max(0.001, length)));
      return {
        x: from.x + (to.x - from.x) * localRatio,
        z: from.z + (to.z - from.z) * localRatio
      };
    }
    remaining -= length;
  }
  return points.at(-1)!;
}

function pointForResourceId(
  resourceId: string | undefined,
  nodeMap: Map<string, DesReplayLayoutNode>,
  edgeMap: Map<string, DesReplayLayoutEdge>
): DesReplayPoint | null {
  if (!resourceId) return null;
  if (resourceId.startsWith('node:')) {
    const node = nodeMap.get(resourceId.slice('node:'.length));
    return node ? { x: node.x, z: node.z } : null;
  }
  if (resourceId.startsWith('edge:')) {
    const edge = edgeMap.get(resourceId.slice('edge:'.length));
    const from = edge ? nodeMap.get(edge.from) : null;
    const to = edge ? nodeMap.get(edge.to) : null;
    if (from && to) {
      return { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
    }
  }
  const node = nodeMap.get(resourceId);
  return node ? { x: node.x, z: node.z } : null;
}

function distance2d(left: DesReplayPoint, right: DesReplayPoint): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
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
  if (history.length === 1) {
    const value = valueForSample(history[0]!);
    const maxValue = Math.max(1, value);
    const y = 32 - (value / maxValue) * 28;
    return `0,${formatNumber(y, 2)} 100,${formatNumber(y, 2)}`;
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
  return pphTrendPointCoordinates(history, valueForSample, maxValue)
    .map((point) => `${formatNumber(point.x, 2)},${formatNumber(point.y, 2)}`)
    .join(' ');
}

function pphTrendPointCoordinates(
  history: PphHistorySample[],
  valueForSample: (sample: PphHistorySample) => number,
  maxValue: number
): Array<{ x: number; y: number; value: number; simTimeSec: number }> {
  if (history.length === 0) {
    return [];
  }
  const minTime = history[0]!.simTimeSec;
  const maxTime = Math.max(minTime + 1, history.at(-1)!.simTimeSec);
  const plotLeft = 14;
  const plotRight = 114;
  const plotTop = 6;
  const plotBottom = 50;
  if (history.length === 1) {
    const value = Math.max(0, valueForSample(history[0]!));
    const y = plotBottom - (value / maxValue) * (plotBottom - plotTop);
    return [
      { x: plotLeft, y, value, simTimeSec: history[0]!.simTimeSec },
      { x: plotRight, y, value, simTimeSec: history[0]!.simTimeSec }
    ];
  }
  return history
    .map((sample) => {
      const x = plotLeft + ((sample.simTimeSec - minTime) / (maxTime - minTime)) * (plotRight - plotLeft);
      const value = Math.max(0, valueForSample(sample));
      const y = plotBottom - (value / maxValue) * (plotBottom - plotTop);
      return { x, y, value, simTimeSec: sample.simTimeSec };
    });
}

export function trendStats(history: PphHistorySample[], valueForSample: (sample: PphHistorySample) => number): {
  current: number;
  min: number;
  max: number;
  average: number;
  minSimTimeSec: number;
  maxSimTimeSec: number;
} | null {
  if (history.length === 0) return null;
  const values = history.map((sample) => valueForSample(sample));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const minIndex = Math.max(0, values.findIndex((value) => value === min));
  const maxIndex = Math.max(0, values.findIndex((value) => value === max));
  return {
    current: values.at(-1) ?? 0,
    min,
    max,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    minSimTimeSec: history[minIndex]?.simTimeSec ?? history[0]!.simTimeSec,
    maxSimTimeSec: history[maxIndex]?.simTimeSec ?? history[0]!.simTimeSec
  };
}

function productiveTrendHistory(history: PphHistorySample[]): PphHistorySample[] {
  const productive = history.filter((sample) => sample.totalPph > 0 || sample.inboundPph > 0 || sample.outboundPph > 0);
  return productive.length > 0 ? productive : history;
}

export function liveTrendMarkers(history: PphHistorySample[]): {
  total: ReturnType<typeof trendStats>;
  inbound: ReturnType<typeof trendStats>;
  outbound: ReturnType<typeof trendStats>;
  waiting: ReturnType<typeof trendStats>;
  reposition: ReturnType<typeof trendStats>;
} {
  const productiveHistory = productiveTrendHistory(history);
  return {
    total: trendStats(productiveHistory, (sample) => sample.totalPph),
    inbound: trendStats(productiveHistory, (sample) => sample.inboundPph),
    outbound: trendStats(productiveHistory, (sample) => sample.outboundPph),
    waiting: trendStats(productiveHistory, (sample) => sample.waitingPct),
    reposition: trendStats(productiveHistory, (sample) => sample.repositionPct)
  };
}

export function buildLiveTrendDiagnosis(history: PphHistorySample[]): LiveTrendDiagnosis[] {
  const latest = history.at(-1);
  if (!latest) {
    return [{
      id: 'collecting-samples',
      label: 'Live Evidence',
      status: 'watch',
      value: '--',
      detail: 'Start or reset the simulation to collect KPI samples.',
      evidence: 'No live trend samples are available yet.'
    }];
  }

  const productiveHistory = productiveTrendHistory(history);
  const productiveLatest = productiveHistory.at(-1) ?? latest;
  const productiveTotalStats = trendStats(productiveHistory, (sample) => sample.totalPph);
  const waitingStats = trendStats(productiveHistory, (sample) => sample.waitingPct);
  const repositionStats = trendStats(productiveHistory, (sample) => sample.repositionPct);
  const imbalancePct = Math.abs(latest.inboundPph - latest.outboundPph) / Math.max(1, latest.totalPph) * 100;
  const totalRangePct = productiveTotalStats && productiveTotalStats.average > 0
    ? (productiveTotalStats.max - productiveTotalStats.min) / productiveTotalStats.average * 100
    : 0;
  const currentVsAveragePct = productiveTotalStats && productiveTotalStats.average > 0
    ? (latest.totalPph - productiveTotalStats.average) / productiveTotalStats.average * 100
    : 0;
  const statusForShare = (value: number): LiveTrendDiagnosis['status'] => (
    value >= 15 ? 'critical' : value >= 10 ? 'watch' : 'pass'
  );
  const throughputStatus: LiveTrendDiagnosis['status'] = history.length < 4
    ? 'watch'
    : currentVsAveragePct <= -10 || totalRangePct >= 18
      ? 'critical'
      : currentVsAveragePct <= -5 || totalRangePct >= 10
        ? 'watch'
        : 'pass';
  const imbalanceStatus: LiveTrendDiagnosis['status'] = imbalancePct >= 25
    ? 'critical'
    : imbalancePct >= 15
      ? 'watch'
      : 'pass';

  return [
    {
      id: 'window-throughput',
      label: 'Window PPH Stability',
      status: throughputStatus,
      value: `${formatNumber(latest.totalPph, 1)} PPH`,
      detail: `${formatNumber(currentVsAveragePct, 1)}% vs productive avg; range ${formatNumber(productiveTotalStats?.min ?? 0, 1)}-${formatNumber(productiveTotalStats?.max ?? 0, 1)}`,
      evidence: `${productiveHistory.length}/${history.length} productive samples; low ${formatClock(productiveTotalStats?.minSimTimeSec ?? productiveLatest.simTimeSec)}, high ${formatClock(productiveTotalStats?.maxSimTimeSec ?? productiveLatest.simTimeSec)}.`
    },
    {
      id: 'flow-balance',
      label: 'Inbound / Outbound Balance',
      status: imbalanceStatus,
      value: `${formatNumber(latest.inboundPph, 1)} / ${formatNumber(latest.outboundPph, 1)}`,
      detail: `${formatNumber(imbalancePct, 1)}% directional imbalance in the current live window.`,
      evidence: 'Large imbalance can mean demand mix, lift asymmetry, dispatch priority, or starvation is driving the trend.'
    },
    {
      id: 'waiting-share',
      label: 'Waiting Share',
      status: statusForShare(latest.waitingPct),
      value: `${formatNumber(latest.waitingPct, 1)}%`,
      detail: `Peak ${formatNumber(waitingStats?.max ?? latest.waitingPct, 1)}%; watch >=10%, critical >=15%.`,
      evidence: 'Waiting Share is fleet time spent blocked by lift or yellow-grid reservation resources, not a one-frame vehicle count.'
    },
    {
      id: 'reposition-share',
      label: 'Reposition Share',
      status: statusForShare(latest.repositionPct),
      value: `${formatNumber(latest.repositionPct, 1)}%`,
      detail: `Peak ${formatNumber(repositionStats?.max ?? latest.repositionPct, 1)}%; watch >=10%, critical >=15%.`,
      evidence: 'Reposition is empty travel to the next pickup; high share usually points to assignment, lift balance, or storage placement policy.'
    }
  ];
}

function latestTrendLabel(
  points: Array<{ x: number; y: number; value: number }>,
  className: string,
  unit: string,
  yOffset = 0
) {
  const latest = points.at(-1);
  if (!latest) return null;
  return (
    <text className={`chart-value-label ${className}`} x={Math.min(112, latest.x)} y={Math.max(8, Math.min(48, latest.y + yOffset))}>
      {formatNumber(latest.value, latest.value >= 100 ? 0 : 1)}{unit}
    </text>
  );
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
  const totalPointCoordinates = pphTrendPointCoordinates(history, (sample) => sample.totalPph, maxPph);
  const inboundPointCoordinates = pphTrendPointCoordinates(history, (sample) => sample.inboundPph, maxPph);
  const outboundPointCoordinates = pphTrendPointCoordinates(history, (sample) => sample.outboundPph, maxPph);
  const latest = history.at(-1);
  const totalStats = trendStats(history, (sample) => sample.totalPph);
  const inboundStats = trendStats(history, (sample) => sample.inboundPph);
  const outboundStats = trendStats(history, (sample) => sample.outboundPph);
  const markers = liveTrendMarkers(history);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: maxPph * ratio,
    y: 50 - ratio * 44
  }));

  return (
    <section className="pph-trend-panel" aria-label="PPH trend">
      <div className="panel-head compact">
        <h2>PPH Trend</h2>
        <span>{latest ? `${formatClock(latest.simTimeSec)} · ${history.length} samples since reset` : '--'}</span>
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
        {latestTrendLabel(totalPointCoordinates, 'total', '', -2)}
        {latestTrendLabel(inboundPointCoordinates, 'inbound', '', 4)}
        {latestTrendLabel(outboundPointCoordinates, 'outbound', '', 9)}
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
      <div className="live-trend-marker-grid" aria-label="Live PPH numeric markers">
        <LiveTrendMarker label="Lowest total" unit="PPH" stats={markers.total} pick="min" />
        <LiveTrendMarker label="Highest total" unit="PPH" stats={markers.total} pick="max" />
        <LiveTrendMarker label="Inbound high" unit="PPH" stats={markers.inbound} pick="max" />
        <LiveTrendMarker label="Outbound high" unit="PPH" stats={markers.outbound} pick="max" />
      </div>
      <div className="trend-readout-grid">
        <TrendReadout label="Window total" unit="PPH" stats={totalStats} focus="min" />
        <TrendReadout label="Window inbound" unit="PPH" stats={inboundStats} focus="min" />
        <TrendReadout label="Window outbound" unit="PPH" stats={outboundStats} focus="min" />
      </div>
      <p className="trend-definition">Window PPH = completed loads inside the current KPI window, not cumulative average. Use min/max to spot local dips before the long-run average hides them.</p>
    </section>
  );
}

function WaitingTrendChart({ history }: { history: PphHistorySample[] }) {
  const maxPct = niceAxisCeil(Math.max(
    20,
    ...history.flatMap((sample) => [sample.waitingPct, sample.repositionPct])
  ));
  const waitingPoints = pphTrendPoints(history, (sample) => sample.waitingPct, maxPct);
  const repositionPoints = pphTrendPoints(history, (sample) => sample.repositionPct, maxPct);
  const waitingPointCoordinates = pphTrendPointCoordinates(history, (sample) => sample.waitingPct, maxPct);
  const repositionPointCoordinates = pphTrendPointCoordinates(history, (sample) => sample.repositionPct, maxPct);
  const latest = history.at(-1);
  const waitingStats = trendStats(history, (sample) => sample.waitingPct);
  const repositionStats = trendStats(history, (sample) => sample.repositionPct);
  const markers = liveTrendMarkers(history);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: maxPct * ratio,
    y: 50 - ratio * 44
  }));
  const thresholdY = (value: number) => 50 - Math.min(1, value / maxPct) * 44;

  return (
    <section className="pph-trend-panel" aria-label="Waiting share trend">
      <div className="panel-head compact">
        <h2>Waiting Share Trend</h2>
        <span>{latest ? `${formatClock(latest.simTimeSec)} · ${history.length} samples since reset` : '--'}</span>
      </div>
      <svg className="pph-trend-chart" viewBox="0 0 120 64" role="img" aria-label="Waiting and reposition share time curve">
        {yTicks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid-line" x1="14" x2="114" y1={tick.y} y2={tick.y} />
            <text className="chart-axis-label y-axis" x="11" y={tick.y + 1.8}>
              {formatNumber(tick.value, tick.value >= 10 ? 0 : 1)}%
            </text>
          </g>
        ))}
        <line className="chart-threshold watch" x1="14" x2="114" y1={thresholdY(10)} y2={thresholdY(10)} />
        <line className="chart-threshold critical" x1="14" x2="114" y1={thresholdY(15)} y2={thresholdY(15)} />
        <text className="chart-threshold-label watch" x="114" y={thresholdY(10) - 1.5}>10%</text>
        <text className="chart-threshold-label critical" x="114" y={thresholdY(15) - 1.5}>15%</text>
        <line className="chart-axis-line" x1="14" x2="114" y1="50" y2="50" />
        <line className="chart-axis-line" x1="14" x2="14" y1="6" y2="50" />
        <polyline className="pph-line waiting" points={waitingPoints} />
        <polyline className="pph-line reposition" points={repositionPoints} />
        {latestTrendLabel(waitingPointCoordinates, 'waiting', '%', -3)}
        {latestTrendLabel(repositionPointCoordinates, 'reposition', '%', 6)}
        <text className="chart-axis-label x-axis" x="14" y="60">
          {history[0] ? formatClock(history[0].simTimeSec) : '--'}
        </text>
        <text className="chart-axis-label x-axis end" x="114" y="60">
          {latest ? formatClock(latest.simTimeSec) : '--'}
        </text>
      </svg>
      <div className="pph-legend">
        <span className="waiting">Waiting {latest ? `${formatNumber(latest.waitingPct, 1)}%` : '--'}</span>
        <span className="reposition">Reposition {latest ? `${formatNumber(latest.repositionPct, 1)}%` : '--'}</span>
      </div>
      <div className="live-trend-marker-grid" aria-label="Live waiting numeric markers">
        <LiveTrendMarker label="Peak waiting" unit="%" stats={markers.waiting} pick="max" />
        <LiveTrendMarker label="Lowest waiting" unit="%" stats={markers.waiting} pick="min" />
        <LiveTrendMarker label="Peak reposition" unit="%" stats={markers.reposition} pick="max" />
        <LiveTrendMarker label="Lowest reposition" unit="%" stats={markers.reposition} pick="min" />
      </div>
      <div className="trend-readout-grid">
        <TrendReadout label="Traffic wait" unit="%" stats={waitingStats} focus="max" />
        <TrendReadout label="Reposition" unit="%" stats={repositionStats} focus="max" />
      </div>
      <p className="trend-definition">Waiting Share = blocked/waiting shuttle time divided by available fleet time in the live KPI stream. Reposition = empty travel to the next pickup.</p>
    </section>
  );
}

function LiveTrendMarker({
  label,
  unit,
  stats,
  pick
}: {
  label: string;
  unit: string;
  stats: ReturnType<typeof trendStats>;
  pick: 'min' | 'max';
}) {
  const value = stats ? (pick === 'min' ? stats.min : stats.max) : null;
  const simTimeSec = stats ? (pick === 'min' ? stats.minSimTimeSec : stats.maxSimTimeSec) : null;
  return (
    <div className="live-trend-marker">
      <span>{label}</span>
      <strong>{value === null ? '--' : `${formatNumber(value, unit === 'PPH' ? 1 : 2)} ${unit}`}</strong>
      <small>{simTimeSec === null ? 'waiting for samples' : formatClock(simTimeSec)}</small>
    </div>
  );
}

function TrendReadout({
  label,
  unit,
  stats,
  focus
}: {
  label: string;
  unit: string;
  stats: {
    current: number;
    min: number;
    max: number;
    average: number;
    minSimTimeSec: number;
    maxSimTimeSec: number;
  } | null;
  focus: 'min' | 'max';
}) {
  const focusValue = stats ? (focus === 'min' ? stats.min : stats.max) : null;
  const focusTimeSec = stats ? (focus === 'min' ? stats.minSimTimeSec : stats.maxSimTimeSec) : null;
  const focusLabel = focus === 'min' ? 'low' : 'peak';
  return (
    <div className="trend-readout">
      <span>{label}</span>
      <strong>{stats ? `${formatNumber(stats.current, 1)} ${unit}` : '--'}</strong>
      <small>{stats ? `avg ${formatNumber(stats.average, 1)} · min ${formatNumber(stats.min, 1)} / max ${formatNumber(stats.max, 1)}` : 'waiting for samples'}</small>
      <em>{stats && focusValue !== null && focusTimeSec !== null ? `${focusLabel} ${formatNumber(focusValue, 1)} at ${formatClock(focusTimeSec)}` : 'collecting window evidence'}</em>
    </div>
  );
}

function LiveTrendDiagnosisPanel({ history }: { history: PphHistorySample[] }) {
  const diagnoses = buildLiveTrendDiagnosis(history);
  const latest = history.at(-1);
  return (
    <section className="live-diagnosis-panel" aria-label="Live trend industrial engineering diagnosis">
      <div className="panel-head compact">
        <div>
          <h2>IE Trend Diagnosis</h2>
          <p>Live operating readout for PPH stability, directional balance, waiting, and repositioning. Use this before trusting the animation by eye.</p>
        </div>
        <span>{latest ? `${formatClock(latest.simTimeSec)} · live KPI window` : 'collecting'}</span>
      </div>
      <div className="live-diagnosis-grid">
        {diagnoses.map((item) => (
          <article className={`live-diagnosis-card ${item.status}`} key={item.id}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
            <em>{item.evidence}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

export function buildReviewTrafficReadouts(state: ShuttleSimState | null): ReviewTrafficReadout[] {
  if (!state) {
    return [{
      id: 'traffic-state',
      label: 'Traffic Evidence',
      status: 'watch',
      value: '--',
      detail: 'Waiting for live simulation state.',
      evidence: 'No state snapshot has arrived from the API stream.'
    }];
  }

  const traffic = state.traffic;
  const waitingVehicles = traffic.waitingVehicles ?? [];
  const liftPorts = traffic.liftPorts ?? [];
  const queuedLiftTasks = liftPorts.reduce((sum, port) => sum + port.queueLength, 0);
  const activeLiftPorts = liftPorts.filter((port) => port.activeTaskId).length;
  const maxBlocked = waitingVehicles.reduce((max, vehicle) => Math.max(max, vehicle.blockedTimeSec), 0);
  const approachOccupied = liftPorts.reduce((sum, port) => sum + (port.approachOccupancy ?? 0), 0);
  const approachCapacity = liftPorts.reduce((sum, port) => sum + (port.approachCapacity ?? 1), 0);
  const approachPct = approachCapacity > 0 ? approachOccupied / approachCapacity * 100 : 0;
  const separation = traffic.minVehicleSeparationM;
  const reservationStatus: ReviewTrafficReadout['status'] = traffic.collisionAvoidanceEnabled === false
    ? 'critical'
    : traffic.activeReservationCount > 0 || traffic.activeFutureGrantCount > 0
      ? 'pass'
      : 'watch';
  const holdStatus: ReviewTrafficReadout['status'] = maxBlocked >= 60
    ? 'critical'
    : waitingVehicles.length > 0
      ? 'watch'
      : 'pass';
  const liftStatus: ReviewTrafficReadout['status'] = queuedLiftTasks > 0 || approachPct >= 90
    ? 'watch'
    : 'pass';

  return [
    {
      id: 'reservation-control',
      label: 'Reservation Control',
      status: reservationStatus,
      value: traffic.collisionAvoidanceEnabled === false ? 'Off' : String(traffic.activeReservationCount),
      detail: `${traffic.trafficMode}; ${traffic.activeFutureGrantCount} future grants.`,
      evidence: traffic.collisionAvoidanceEnabled === false
        ? 'Collision avoidance is disabled; this is not review-safe.'
        : 'Active node/edge reservations are the DES-style mechanism that prevents path crossing.'
    },
    {
      id: 'traffic-holds',
      label: 'Traffic Holds',
      status: holdStatus,
      value: String(waitingVehicles.length),
      detail: `Max blocked ${formatNumber(maxBlocked, 1)}s.`,
      evidence: waitingVehicles.length > 0
        ? 'A hold means a shuttle is waiting for a reservation, lift, or resource instead of crossing an unsafe path.'
        : 'No shuttle is currently held by traffic control in this snapshot.'
    },
    {
      id: 'physical-safety',
      label: 'Physical Safety',
      status: traffic.physicalViolationCount > 0 ? 'critical' : 'pass',
      value: String(traffic.physicalViolationCount),
      detail: `Min separation ${separation === null || separation === undefined ? '--' : `${formatNumber(separation, 2)}m`}.`,
      evidence: 'Physical violations must stay at zero; this is the live safety gate for animation credibility.'
    },
    {
      id: 'lift-port-pressure',
      label: 'Lift Port Pressure',
      status: liftStatus,
      value: `${activeLiftPorts}/${liftPorts.length}`,
      detail: `${queuedLiftTasks} queued; approach ${approachOccupied}/${approachCapacity}.`,
      evidence: 'Lift queues and approach occupancy explain whether PPH dips are material-flow constraints or dispatch symptoms.'
    }
  ];
}

function ReviewTrafficReadoutPanel({ state }: { state: ShuttleSimState | null }) {
  const readouts = buildReviewTrafficReadouts(state);
  return (
    <section className="review-traffic-panel" aria-label="Live DES avoidance and traffic readout">
      <div className="panel-head compact">
        <div>
          <h2>DES Avoidance Live</h2>
          <p>Reservation, traffic hold, safety, and lift-port evidence synchronized with the animated state.</p>
        </div>
        <span>{state ? `${formatClock(state.simTimeSec)} · ${state.traffic.trafficMode}` : 'waiting'}</span>
      </div>
      <div className="review-traffic-grid">
        {readouts.map((item) => (
          <article className={`review-traffic-card ${item.status}`} key={item.id}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
            <em>{item.evidence}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

export function buildReviewDesEvidence(
  scenario: ShuttleScenario | null,
  result: HeadlessDesResult | null
): ReviewDesEvidence | null {
  if (!result) return null;
  const auditRows = buildDesDispatchAuditRows(scenario, result, Math.max(24, result.reservationReplay.tasks.length));
  const routePass = auditRows.filter((row) => row.routeStatus === 'pass').length;
  const routeWatch = auditRows.filter((row) => row.routeStatus === 'watch').length;
  const routeFail = auditRows.filter((row) => row.routeStatus === 'fail').length;
  const topBottleneck = result.trafficBottlenecks[0] ?? null;
  const topWait = result.reservationReplay.topWaitIntervals[0] ?? null;
  const routeStatus: ReviewDesEvidence['routeStatus'] = result.routeModel.routeUnavailableCount > 0 || routeFail > 0
    ? 'critical'
    : routeWatch > 0 || result.issues.some((issue) => issue.severity === 'warning')
      ? 'watch'
      : 'pass';

  return {
    routeStatus,
    routeMisses: result.routeModel.routeUnavailableCount,
    reservationWindows: result.routeModel.reservationWindowCount,
    tracedTasks: result.reservationReplay.tracedTaskCount,
    routePass,
    routeWatch,
    routeFail,
    trafficWaitHours: result.routeModel.trafficWaitSec / 3600,
    topBottleneck: topBottleneck ? `${resourceShortName(topBottleneck.resourceId)} · ${formatNumber(topBottleneck.waitSec / 3600, 2)}h / ${topBottleneck.waitCount}` : 'none',
    topWaitTask: topWait ? `${topWait.shuttleId} ${topWait.taskId} · ${formatNumber(topWait.waitSec, 1)}s · ${resourceShortName(topWait.resourceId ?? topWait.reason)}` : 'none',
    evidence: `${result.routeModel.kind}; ${result.reservationReplay.tracedTaskCount} traced tasks; ${result.routeModel.routeUnavailableCount} route misses.`
  };
}

function ReviewDesEvidencePanel({
  scenario,
  result,
  onOpenStatistics
}: {
  scenario: ShuttleScenario | null;
  result: HeadlessDesResult | null;
  onOpenStatistics: () => void;
}) {
  const evidence = buildReviewDesEvidence(scenario, result);
  return (
    <section className="review-des-panel" aria-label="DES task-level avoidance evidence">
      <div className="panel-head compact">
        <div>
          <h2>DES Task Evidence</h2>
          <p>Task-level reservation replay summary for route validity, waits, and bottleneck resources.</p>
        </div>
        <span>{evidence ? evidence.routeStatus : 'run DES first'}</span>
      </div>
      {!evidence ? (
        <div className="review-des-empty">
          <strong>No DES replay loaded</strong>
          <small>Use DES 6h or DES 7d, then this panel will show route pass/watch/fail and top wait evidence.</small>
          <button type="button" onClick={onOpenStatistics}>Open Statistics</button>
        </div>
      ) : (
        <>
          <div className="review-des-grid">
            <article className={`review-des-card ${evidence.routeStatus}`}>
              <span>Route Audit</span>
              <strong>{evidence.routePass}/{evidence.routeWatch}/{evidence.routeFail}</strong>
              <small>pass / watch / fail across traced tasks</small>
            </article>
            <article className={evidence.routeMisses > 0 ? 'review-des-card critical' : 'review-des-card pass'}>
              <span>Route Misses</span>
              <strong>{evidence.routeMisses}</strong>
              <small>{evidence.reservationWindows} reservation windows</small>
            </article>
            <article className={evidence.trafficWaitHours >= 2 ? 'review-des-card watch' : 'review-des-card pass'}>
              <span>Traffic Wait</span>
              <strong>{formatNumber(evidence.trafficWaitHours, 2)}h</strong>
              <small>{evidence.tracedTasks} traced task sample</small>
            </article>
          </div>
          <div className="review-des-evidence">
            <div>
              <span>Top Bottleneck</span>
              <strong>{evidence.topBottleneck}</strong>
            </div>
            <div>
              <span>Top Wait Task</span>
              <strong>{evidence.topWaitTask}</strong>
            </div>
            <p>{evidence.evidence}</p>
          </div>
        </>
      )}
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

function RouteEfficiencyPanel({
  scenario,
  state
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
}) {
  const rows = useMemo(() => {
    if (!scenario || !state) {
      return [];
    }
    const nodeMap = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
    const taskByVehicleId = new Map(
      state.tasks
        .filter((task) => task.vehicleId && task.state !== 'completed' && task.state !== 'failed')
        .map((task) => [task.vehicleId!, task])
    );
    return state.vehicles
      .map((vehicle) => {
        const route = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
        const goalNodeId = vehicle.plannedGoalNodeId ?? route.at(-1) ?? null;
        if (!goalNodeId || route.length < 2) {
          return null;
        }
        const routeDistanceM = routeDistanceFromVehicleM(vehicle, route, nodeMap);
        const lowerBoundM = routeLowerBoundM(vehicle, goalNodeId, nodeMap);
        const ratio = lowerBoundM > 0.05 ? routeDistanceM / lowerBoundM : 1;
        const task = taskByVehicleId.get(vehicle.id);
        return {
          vehicle,
          task,
          goalNodeId,
          routeDistanceM,
          lowerBoundM,
          ratio,
          nodeCount: route.length,
          localRouteReason: vehicle.localRouteReason
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((left, right) =>
        right.ratio - left.ratio ||
        right.routeDistanceM - left.routeDistanceM ||
        left.vehicle.id.localeCompare(right.vehicle.id)
      )
      .slice(0, 8);
  }, [scenario, state]);

  return (
    <section className="route-efficiency-panel" aria-label="Route efficiency">
      <div className="panel-head compact">
        <h2>Route Efficiency</h2>
        <span>{rows.length} active routes</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No active route diagnostics yet.</p>
      ) : (
        <div className="route-efficiency-table">
          <div className="route-efficiency-header">
            <span>Unit</span>
            <span>Task</span>
            <span>Goal</span>
            <span>Route</span>
            <span>Ratio</span>
            <span>Reason</span>
          </div>
          {rows.map((row) => (
            <div className={row.ratio >= 2 ? 'route-efficiency-row warn' : 'route-efficiency-row'} key={row.vehicle.id}>
              <strong>{row.vehicle.id}</strong>
              <span>{row.task ? `${row.task.kind} ${row.task.id}` : 'standby'}</span>
              <span>{row.goalNodeId}</span>
              <span>{formatNumber(row.routeDistanceM, 1)}m / {row.nodeCount} nodes</span>
              <span>{formatNumber(row.ratio, 2)}x</span>
              <span>{row.localRouteReason ?? row.vehicle.waitReason ?? '-'}</span>
            </div>
          ))}
        </div>
      )}
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
    sourceBufferCapacity: port.sourceBufferCapacity ?? 1,
    utilization: port.utilization ?? 0
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
                {entry.completed} done, util {formatNumber(entry.utilization * 100, 1)}%, approach {entry.approachOccupancy}/{entry.approachCapacity}, q{entry.queueLength}
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

type LiftNoDriveRect = {
  id: string;
  role: 'inbound' | 'outbound';
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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

function liftGridDockNodeId(
  nodeMap: Map<string, ShuttleScenario['layout']['nodes'][number]>,
  liftNodeId: string,
  role: 'inbound' | 'outbound'
): string | null {
  const liftMatch = /^lift-(\d{2})-(?:inbound|outbound)$/.exec(liftNodeId);
  const moduleDockNodeId = liftMatch
    ? `module-${liftMatch[1]}-spine-${role === 'inbound' ? 'top-a' : 'bottom-b'}`
    : null;
  if (moduleDockNodeId && nodeMap.has(moduleDockNodeId)) {
    return moduleDockNodeId;
  }
  const entryNode = nodeMap.get(`${liftNodeId}-queue-01-entry-access`) ?? nodeMap.get(`${liftNodeId}-queue-access`);
  if (!entryNode) {
    return null;
  }
  const targetLevel = role === 'inbound' ? 'top-b' : 'bottom-b';
  let nearest: ShuttleScenario['layout']['nodes'][number] | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodeMap.values()) {
    if (!new RegExp(`^column-${targetLevel}-c\\d+$`).test(node.id)) {
      continue;
    }
    const distance = Math.hypot(node.x - entryNode.x, node.z - entryNode.z);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest?.id ?? null;
}

function createLiftNoDriveRects(
  nodes: ShuttleScenario['layout']['nodes'],
  liftVisuals: LiftVisualWorkcell[]
): LiftNoDriveRect[] {
  const dockNodeIds = new Set(liftVisuals.flatMap((visual) => visual.dockNodeIds));
  return liftVisuals.flatMap((visual) => {
    const workcellNodes = nodes.filter((node) => {
      if (dockNodeIds.has(node.id)) {
        return false;
      }
      const parts = liftWorkcellKeyParts(node.id);
      return parts?.key === visual.key;
    });
    if (workcellNodes.length === 0) {
      return [];
    }
    const padX = 0.78;
    const padZ = 0.62;
    return [{
      id: `${visual.key}-no-drive`,
      role: visual.role,
      minX: Math.min(...workcellNodes.map((node) => node.x)) - padX,
      maxX: Math.max(...workcellNodes.map((node) => node.x)) + padX,
      minZ: Math.min(...workcellNodes.map((node) => node.z)) - padZ,
      maxZ: Math.max(...workcellNodes.map((node) => node.z)) + padZ
    }];
  });
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
    const gridDockNodeId = liftGridDockNodeId(nodeMap, visual.liftNodeId, visual.role);
    if (gridDockNodeId) {
      visual.dockNodeIds = [gridDockNodeId];
    }
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

    const liftVisuals = createLiftVisualWorkcells(nodes, scenario?.layout.edges ?? []);
    return {
      nodes,
      nodeMap,
      edges: scenario?.layout.edges ?? [],
      edgeTraversalKeys: createEdgeTraversalKeys(scenario?.layout.edges ?? []),
      aisleRects: staticScene ? createTrackAreaRects(staticScene, ['sideAisle', 'crossAisle']) : [],
      connectorRects: staticScene ? createTrackAreaRects(staticScene, ['inboundConnector', 'outboundConnector']) : [],
      storageCellRects: staticScene ? createStorageCellRects(staticScene) : [],
      liftVisuals,
      liftNoDriveRects: createLiftNoDriveRects(nodes, liftVisuals),
      project,
      projectRect,
      routeSegmentStyle
    };
  }, [scenario]);

  const loads = state?.loads.filter((load) => load.nodeId && load.state !== 'carried' && load.state !== 'delivered') ?? [];
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
      {geometry.liftNoDriveRects.map((rect) => (
        <span className={`map-lift-wall flow-${rect.role}`} key={rect.id} style={geometry.projectRect(rect)} />
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
      {geometry.liftVisuals.flatMap((visual) => visual.dockNodeIds.map((dockNodeId) => {
        const node = geometry.nodeMap.get(dockNodeId);
        return node ? (
          <span
            aria-label={`${visual.role} lift legal grid target`}
            className={`map-lift-grid-target flow-${visual.role}`}
            key={`${visual.key}-grid-target-${dockNodeId}`}
            style={geometry.project(node)}
          />
        ) : null;
      }))}
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
        const pickupPoint = routeDisplayPointForNode(pickupNode.id, pickupNode, geometry.nodeMap);
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
  scenario: ShuttleScenario | null,
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
  const vehicles = Array.from(after.vehicles.values()).map((vehicle) => {
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
  const afterVehicles = Array.from(after.vehicles.values());
  if (
    vehicleListHasSquareFootprintOverlap(vehicles, scenario) &&
    !vehicleListHasSquareFootprintOverlap(afterVehicles, scenario)
  ) {
    return afterVehicles;
  }
  return vehicles;
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
    const liftVisuals = createLiftVisualWorkcells(nodes, scenario?.layout.edges ?? []);
    return {
      nodes,
      edges: scenario?.layout.edges ?? [],
      edgeTraversalKeys: createEdgeTraversalKeys(scenario?.layout.edges ?? []),
      nodeMap: new Map(nodes.map((node) => [node.id, node])),
      aisleRects: staticScene ? createTrackAreaRects(staticScene, ['sideAisle', 'crossAisle']) : [],
      connectorRects: staticScene ? createTrackAreaRects(staticScene, ['inboundConnector', 'outboundConnector']) : [],
      storageCellRects: staticScene ? createStorageCellRects(staticScene) : [],
      liftVisuals,
      liftNoDriveRects: createLiftNoDriveRects(nodes, liftVisuals),
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
        context.fillStyle = 'rgba(255, 58, 48, 0.14)';
        context.strokeStyle = 'rgba(255, 58, 48, 0.96)';
        context.lineWidth = 2.7;
        context.beginPath();
        context.arc(point.x, point.y, 8.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.fillStyle = role === 'inbound' ? 'rgba(18, 42, 62, 0.96)' : 'rgba(66, 49, 18, 0.96)';
        context.strokeStyle = 'rgba(255, 58, 48, 0.92)';
        context.lineWidth = 1.4;
        context.beginPath();
        context.roundRect(point.x - 5.4, point.y - 5.4, 10.8, 10.8, 2.4);
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

      for (const rect of geometry.liftNoDriveRects) {
        drawMeterRect(rect, '#4b1d22', '#ff5a4f', 0.16, 0.46);
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
          if (!load.nodeId || load.state === 'carried' || load.state === 'delivered') continue;
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
        scenario,
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
        const displayPoint = routeDisplayPointForNode(pickupNode.id, pickupNode, geometry.nodeMap);
        const point = project(displayPoint);
        drawPickupTargetBadge(point, task.kind, vehicle.id, liftDockTarget);
      }

      for (const vehicle of renderVehicles) {
        const displayPoint = vehicleBodyDisplayPointForVehicleState(vehicle, geometry.nodeMap);
        const point = project(displayPoint);
        const selected = selectedVehicleId === vehicle.id;
        const pxPerMeter = Math.min(
          (width - padding * 2) / geometry.width,
          (height - padding * 2) / geometry.depth
        );
        const visibleBodySideM = vehicleVisualBodySideM(scenario);
        const vehicleWidthPx = clampNumber(visibleBodySideM * pxPerMeter, 10, 18);
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
          DES 6h
        </button>
        <button type="button" onClick={() => onRunDesClick(7 * 24 * 3600)} disabled={setupDirty || Boolean(fastRun?.active)}>
          DES 7d
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
  onRecordTwelveHours,
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
  onRecordTwelveHours: () => void;
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
        <div className="recording-action-row">
          <button type="button" onClick={onRecordThreeHours} disabled={setupDirty || jobActive}>
            {jobActive ? 'Recording...' : 'Record 3h Replay'}
          </button>
          <button type="button" onClick={onRecordTwelveHours} disabled={setupDirty || jobActive}>
            Record 12h Hourly
          </button>
        </div>
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
              ? `${recording.frameCount} frames @ ${formatClock(recording.sampleIntervalSec)} · ${formatNumber(recording.elapsedMs / 1000, 1)}s compute`
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
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>('3d');
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('review');
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

  function replaceLiveStreamFromState(nextState: ShuttleSimState): void {
    const snapshot = {
      simTimeSec: nextState.simTimeSec,
      vehicles: nextState.vehicles,
      kpis: nextState.kpis
    };
    pendingLiveStreamRef.current = snapshot;
    setLiveStream(snapshot);
    setPphHistory([createPphHistorySample(nextState.simTimeSec, nextState.kpis)]);
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
  const physicalRecordingHistory = useMemo(() => (
    physicalRecording
      ? physicalRecording.frames.map((frame) => createPphHistorySample(frame.simTimeSec, frame.kpis))
      : null
  ), [physicalRecording]);
  const statisticsHistory = physicalRecordingHistory ?? pphHistory;
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
    if (!kpis) {
      return;
    }
    const sample = createPphHistorySample(liveClockSec, kpis);
    setPphHistory((previous) => {
      const last = previous.at(-1);
      if (!last) {
        return [sample];
      }
      if (sample.simTimeSec < last.simTimeSec) {
        return [sample];
      }
      if (Math.abs(sample.simTimeSec - last.simTimeSec) < 0.25) {
        return previous;
      }
      if (sample.simTimeSec - last.simTimeSec < 2) {
        return previous;
      }
      return appendPphHistorySample(previous, sample);
    });
  }, [kpis, liveClockSec]);

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
    const recordingId = new URLSearchParams(window.location.search).get('recordingId')?.trim();
    if (!recordingId) {
      return;
    }

    let cancelled = false;
    recordingPollTokenRef.current += 1;
    setCommandStatus({ label: `loading recording ${recordingId.slice(0, 8)}...`, tone: 'idle' });
    requestJson<PhysicalRecordingResponse>(`/api/shuttle/physicalRecordings/${encodeURIComponent(recordingId)}`)
      .then((response) => {
        if (cancelled) return;
        setPhysicalRecordingJob(null);
        setPhysicalRecording(response.recording);
        setReplay({ active: true, playing: false, cursorSec: 0, speed: 4 });
        setCommandStatus({
          label: `loaded ${formatClock(response.recording.durationSec)} replay · ${formatNumber(response.recording.summary.totalPph, 1)} PPH`,
          tone: response.recording.anomalyMarkers.length === 0 ? 'ok' : 'warn'
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
        }
      });

    return () => {
      cancelled = true;
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
        void resetSimulation();
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

  async function resetSimulation(): Promise<boolean> {
    const startedAt = performance.now();
    const seed = state?.seed;
    cancelFastRun();
    recordingPollTokenRef.current += 1;
    if (replayFrameRef.current !== null) {
      window.cancelAnimationFrame(replayFrameRef.current);
      replayFrameRef.current = null;
    }
    setPhysicalRecordingJob(null);
    setPhysicalRecording(null);
    setReplay({ active: false, playing: false, cursorSec: 0, speed: 4 });
    setDesResult(null);
    setFastRun(null);
    setCommandStatus({ label: 'resetting clean sim...', tone: 'idle' });
    try {
      const response = await requestJson<{ state: ShuttleSimState }>('/api/shuttle/reset', {
        method: 'POST',
        body: JSON.stringify({ seed })
      });
      setState(response.state);
      replaceLiveStreamFromState(response.state);
      setEvents(response.state.recentEvents);
      setSelectedVehicleId(response.state.vehicles[0]?.id ?? null);
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `clean reset ${elapsedMs} ms`, tone: 'ok' });
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
        body: JSON.stringify({
          regionCount,
          shuttleCount,
          initialOutboundFullColumns,
          initialStorageFillPolicy: 'zone-balanced-50',
          storageSelectionPolicy: 'traffic-aware'
        })
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
      setCommandStatus({ label: `${response.setup.regionCount} regions / ${response.setup.shuttleCount} shuttles loaded (${response.setup.initialStorageFillPolicy}, ${response.setup.storageSelectionPolicy}) in ${elapsedMs} ms`, tone: 'ok' });
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
    const sampleIntervalSec = durationSec >= 24 * 3600 ? 3600 : Math.max(60, Math.round(durationSec / 24));
    const maxActiveTasks = Math.min(activeScenario?.vehicles.count ?? setupSummary?.shuttleCount ?? 8, 6);
    setCommandStatus({ label: `running reservation-window DES to ${formatClock(durationSec)}...`, tone: 'idle' });
    try {
      const response = await requestJson<HeadlessDesResponse>('/api/shuttle/runHeadlessDes', {
        method: 'POST',
        body: JSON.stringify({
          durationSec,
          sampleIntervalSec,
          maxActiveTasks,
          initialStorageFillPolicy: 'zone-balanced-50',
          storageSelectionPolicy: 'traffic-aware'
        })
      });
      setDesResult(response.result);
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({
        label: `DES ${formatClock(durationSec)} traffic-aware: ${formatNumber(response.result.totalPph, 1)} PPH, wait ${formatNumber(response.result.averageWaitingPct, 1)}%, cap ${response.result.controlPolicy.maxActiveTasks}, ${elapsedMs} ms`,
        tone: response.result.anomalyMarkers.length === 0 ? 'ok' : 'warn'
      });
      setWorkspaceTab('statistics');
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  async function recordPhysicalRun(durationSec: number, sampleIntervalSec = RECORDING_SAMPLE_INTERVAL_SEC): Promise<void> {
    const token = recordingPollTokenRef.current + 1;
    recordingPollTokenRef.current = token;
    const startedAt = performance.now();
    setPhysicalRecording(null);
    setReplay((current) => ({ ...current, active: false, playing: false, cursorSec: 0 }));
    setCommandStatus({ label: `recording physical ${formatClock(durationSec)} at max speed...`, tone: 'idle' });
    try {
      const startResponse = await requestJson<PhysicalRecordingJobResponse>('/api/shuttle/physicalRecordingJobs', {
        method: 'POST',
        body: JSON.stringify({
          durationSec,
          sampleIntervalSec,
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
        label: `recorded ${formatClock(recordingResponse.recording.durationSec)} @ ${formatClock(recordingResponse.recording.sampleIntervalSec)} samples in ${elapsedMs} ms · ${formatNumber(recordingResponse.recording.summary.totalPph, 1)} PPH`,
        tone: recordingResponse.recording.anomalyMarkers.length === 0 ? 'ok' : 'warn'
      });
      setWorkspaceTab('statistics');
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
      setPhysicalRecordingJob((current) => current ? { ...current, status: 'failed', error: error instanceof Error ? error.message : String(error) } : current);
    }
  }

  async function recordPhysicalThreeHours(): Promise<void> {
    await recordPhysicalRun(THREE_HOURS_SEC, RECORDING_SAMPLE_INTERVAL_SEC);
  }

  async function recordPhysicalTwelveHours(): Promise<void> {
    await recordPhysicalRun(TWELVE_HOURS_SEC, LONG_RECORDING_SAMPLE_INTERVAL_SEC);
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
    void resetSimulation();
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
                <span><strong>{setupSummary?.initialStorageFillPolicy ?? '--'}</strong> fill</span>
                <span><strong>{setupSummary?.storageSelectionPolicy ?? '--'}</strong> select</span>
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
            {workspaceTab === 'review' && (
              <section className="tab-panel review-cockpit-panel" aria-label="Customer review live cockpit">
                <div className="review-cockpit-stage">
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
                </div>
                <aside className="review-cockpit-side" aria-label="Live review metrics and avoidance evidence">
                  <KpiStrip scenario={activeScenario} kpis={kpis} />
                  <LiveTrendDiagnosisPanel history={statisticsHistory} />
                  <ReviewTrafficReadoutPanel state={sceneState} />
                  <ReviewDesEvidencePanel scenario={activeScenario} result={desResult} onOpenStatistics={() => setWorkspaceTab('statistics')} />
                  <LiveHourlyPphPanel history={statisticsHistory} />
                  <PphTrendChart history={statisticsHistory} />
                  <WaitingTrendChart history={statisticsHistory} />
                </aside>
              </section>
            )}

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
                <LiveTrendDiagnosisPanel history={statisticsHistory} />
                <DesAnswerFirstPanel result={desResult} />
                <DesSummaryPanel result={desResult} />
                <DesPeriodPphPanel result={desResult} />
                <LiveHourlyPphPanel history={statisticsHistory} />
                <DesDataIntegrityPanel result={desResult} />
                <DesReviewReadinessPanel result={desResult} />
                <DesIeFindingsPanel result={desResult} />
                <DesDispatchAvoidanceAuditPanel scenario={activeScenario} result={desResult} />
                <DesReservationReplayPanel scenario={activeScenario} result={desResult} />
                <PphTrendChart history={statisticsHistory} />
                <WaitingTrendChart history={statisticsHistory} />
                <LiftPphPanel state={sceneState} kpis={kpis} history={statisticsHistory} />
                <CapacityTheoryPanel kpis={kpis} />
                <ResourceUtilizationPanel scenario={activeScenario} state={sceneState} />
                <RouteEfficiencyPanel scenario={activeScenario} state={sceneState} />
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
            onRecordTwelveHours={() => void recordPhysicalTwelveHours()}
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
