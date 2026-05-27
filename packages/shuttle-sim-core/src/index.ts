import { createHash, randomUUID } from 'node:crypto';

import {
  EventLogEntrySchema,
  LoadStateRecordSchema,
  ReservationSchema,
  ShuttleScenarioSchema,
  TaskStateRecordSchema,
  type EventLogEntry,
  type KpiSnapshot,
  type LoadStateRecord,
  type Reservation,
  type ShuttleScenario,
  type ShuttleSimState,
  type TaskStateRecord,
  type VehicleState
} from '@four-way-shuttle/schemas';

import { summarizeScenarioStaticSceneContract as summarizeStaticSceneContract, type ShuttleStaticSceneContract } from './static-scene.js';
import {
  DEFAULT_SHUTTLE_LAYOUT_PROFILE,
  createShuttleLayoutProfile,
  type ShuttleLayoutGeometryProfile,
  type ShuttleLayoutGeometryProfileOverride
} from './layout-profile.js';
export {
  runHeadlessDes,
  type HeadlessDesOptions,
  type HeadlessDesResult,
  type HeadlessDesSample
} from './headless-des.js';
export type {
  ShuttleStaticSceneCalibrationReadiness,
  ShuttleStaticSceneContract,
  ShuttleStaticSceneBlockedCell,
  ShuttleStaticSceneLayoutCalibrationProfile,
  ShuttleStaticScenePad,
  ShuttleStaticSceneStorageCell,
  ShuttleStaticSceneTrackBed,
  ShuttleStaticSceneTrackCategory
} from './static-scene.js';
export { REQUIRED_CALIBRATION_DIMENSION_KEYS } from './static-scene.js';
export {
  DEFAULT_SHUTTLE_LAYOUT_PROFILE,
  createShuttleLayoutProfile,
  type ShuttleLayoutGeometryProfile,
  type ShuttleLayoutGeometryProfileOverride
} from './layout-profile.js';

type RuntimeStatus = ShuttleSimState['status'];

const COLLISION_AVOIDANCE_PARAM = '/trafficPolicy/collisionAvoidanceEnabled';
const TOP_LIFT_COLUMN_LAYOUT_PROFILE_ID = 'top-lift-column-v1';

type PriorityQueueEntry = {
  nodeId: string;
  priority: number;
};

class MinPriorityQueue {
  private readonly entries: PriorityQueueEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: PriorityQueueEntry): void {
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
  }

  pop(): PriorityQueueEntry | null {
    if (this.entries.length === 0) {
      return null;
    }
    const first = this.entries[0]!;
    const last = this.entries.pop()!;
    if (this.entries.length > 0) {
      this.entries[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.compare(this.entries[cursor]!, this.entries[parent]!) >= 0) {
        break;
      }
      this.swap(cursor, parent);
      cursor = parent;
    }
  }

  private bubbleDown(index: number): void {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      let next = cursor;
      if (left < this.entries.length && this.compare(this.entries[left]!, this.entries[next]!) < 0) {
        next = left;
      }
      if (right < this.entries.length && this.compare(this.entries[right]!, this.entries[next]!) < 0) {
        next = right;
      }
      if (next === cursor) {
        break;
      }
      this.swap(cursor, next);
      cursor = next;
    }
  }

  private compare(left: PriorityQueueEntry, right: PriorityQueueEntry): number {
    return left.priority - right.priority || left.nodeId.localeCompare(right.nodeId);
  }

  private swap(leftIndex: number, rightIndex: number): void {
    const left = this.entries[leftIndex]!;
    this.entries[leftIndex] = this.entries[rightIndex]!;
    this.entries[rightIndex] = left;
  }
}

function isTopLiftColumnLayout(scenario: ShuttleScenario): boolean {
  return scenario.layout.calibrationProfile?.id === TOP_LIFT_COLUMN_LAYOUT_PROFILE_ID;
}

export type MutableVehicle = VehicleState & {
  targetSpeedMps: number;
  waitingSinceSec: number | null;
  lastMovementAxis: 'x' | 'z' | null;
  directionSwitchReadyNodeId: string | null;
  legMotionMode: 'profile' | 'cruise';
  movingTimeSec: number;
  handlingTimeSec: number;
  tasklessTravelTimeSec: number;
  yieldHoldUntilSec: number | null;
  yieldHoldNodeId: string | null;
};

export type ConflictSessionV1 = {
  id: string;
  kind: 'pair' | 'resource';
  resourceKey: string;
  state: 'open' | 'yielding' | 'holding-pocket' | 'returning' | 'cleared' | 'timed-out';
  participantVehicleIds: string[];
  winnerVehicleId: string;
  yielderVehicleId: string;
  createdAtSec: number;
  createdAtTick: number;
  updatedAtSec: number;
  expiresAtSec: number;
  timeoutAtSec: number;
  trigger: 'head-on' | 'same-node' | 'column-exit' | 'swept-footprint' | 'deadlock-break';
  initialBlockerVehicleId: string;
  blockerVehicleId: string;
  yielderOriginalNodeId: string;
  yielderPocketNodeId: string | null;
  yielderLocalRouteNodeIds: string[];
  resumeNodeId: string | null;
  clearancePolicy: 'immediate-next-move' | 'short-horizon' | 'full-route';
  closeReason: string | null;
};

type SetParamResult = {
  accepted: boolean;
  path: string;
  previousValue: unknown;
  value: unknown;
  reason?: string;
};

type ShuttleScenarioOverrides = Partial<Omit<
  ShuttleScenario,
  'vehicles' | 'layout' | 'taskGeneration' | 'physicsParams' | 'routingPolicy' | 'trafficPolicy'
>> & {
  layoutProfile?: ShuttleLayoutGeometryProfileOverride;
  liftMode?: DefaultLiftMode;
  vehicles?: Partial<ShuttleScenario['vehicles']>;
  layout?: Partial<ShuttleScenario['layout']>;
  taskGeneration?: Partial<ShuttleScenario['taskGeneration']>;
  physicsParams?: Partial<ShuttleScenario['physicsParams']>;
  routingPolicy?: Partial<ShuttleScenario['routingPolicy']>;
  trafficPolicy?: Partial<ShuttleScenario['trafficPolicy']>;
};

type ReservationAttempt =
  | { ok: true; reservations: Reservation[] }
  | { ok: false; reasonCode: string; blockingReservationId: string | null };

type RouteLegAuthorization =
  | {
      ok: true;
      edge: ShuttleScenario['layout']['edges'][number];
      speedMps: number;
      travelSec: number;
      motionMode: MutableVehicle['legMotionMode'];
      reservations: Reservation[];
      horizonLegCount: number;
      reusedExisting: boolean;
    }
  | { ok: false; reasonCode: string; blockingReservationId: string | null };

type MoveReservationInstall = {
  installed: Reservation[];
  removed: Array<{ index: number; reservation: Reservation }>;
};

export type ShuttleSimDebugState = {
  currentNodeOccupancy: Array<{ nodeId: string; vehicleId: string }>;
  storageNodeOccupancy: Array<{ nodeId: string; loadId: string }>;
};

type Rng = {
  next: () => number;
  getState: () => number;
  setState: (state: number) => void;
};

export type ShuttleEngineSnapshotV1 = {
  schemaVersion: 'shuttle.engineSnapshot.v1';
  simTimeSec: number;
  tickIndex: number;
  status: RuntimeStatus;
  sessionId: string;
  rngState: number;
  eventSequence: number;
  taskSequence: number;
  sourceLoadSequence: number;
  nextInboundSec: number | null;
  nextOutboundSec: number | null;
  vehicles: MutableVehicle[];
  tasks: TaskStateRecord[];
  loads: LoadStateRecord[];
  reservations: Reservation[];
  completedTaskCycleTimes: number[];
  completedTaskWaitTimes: number[];
  completedInbound: number;
  completedOutbound: number;
  completedByLiftPort?: Array<[string, { kind: LiftKind; completed: number }]>;
  reservationConflictCount: number;
  replanCount: number;
  deadlockCount: number;
  livelockCount: number;
  deadlockCandidateSignature: string | null;
  deadlockCandidateSinceSec: number | null;
  blockedTimeByReasonSec: Array<[string, number]>;
  deferredTaskReasons: Record<'inbound' | 'outbound', string | null>;
  liftPortBusyTimeSec: Array<[string, number]>;
  currentNodeOccupancy: Array<{ nodeId: string; vehicleId: string }>;
  storageNodeOccupancy: Array<{ nodeId: string; loadId: string }>;
  conflictSessions: ConflictSessionV1[];
  recentEvents: EventLogEntry[];
  eventLog: EventLogEntry[];
  error: string | null;
  eventLogHash: string;
  stateHash: string;
};

const SHUTTLE_Y_M = 0.08;
const DEFAULT_RECENT_EVENTS = 80;
const MAX_CLEAR_THROUGH_HORIZON_LEGS = 8;
const MAX_CLEAR_THROUGH_HORIZON_SEC = 2.4;
const OUTBOUND_SEED_LOAD_PREFIX = 'outbound-seed-';

function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0x100000000;
    },
    getState: () => state >>> 0,
    setState: (nextState: number) => {
      state = nextState >>> 0;
    }
  };
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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
  config: ShuttleScenario['vehicles'],
  paddingM = config.safetyRadiusM / 2
): Array<{ x: number; z: number }> {
  const [forward, lateral] = footprintAxes(vehicle.yaw);
  const halfLengthM = config.lengthM / 2 + paddingM;
  const halfWidthM = config.widthM / 2 + paddingM;
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

function vehicleFootprintClearanceM(
  left: FootprintPose,
  right: FootprintPose,
  config: ShuttleScenario['vehicles']
): number {
  const leftCorners = footprintCorners(left, config, 0);
  const rightCorners = footprintCorners(right, config, 0);
  const axes = [...footprintAxes(left.yaw), ...footprintAxes(right.yaw)];
  let separationM = 0;
  for (const axis of axes) {
    const leftRange = projectionRange(leftCorners, axis);
    const rightRange = projectionRange(rightCorners, axis);
    const axisSeparationM = Math.max(rightRange.min - leftRange.max, leftRange.min - rightRange.max);
    if (axisSeparationM > 0) {
      separationM = Math.max(separationM, axisSeparationM);
    }
  }
  return separationM;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

export function hashEventLog(events: EventLogEntry[]): string {
  const projected = events.map((event) => ({
    sequence: event.sequence,
    timeSec: round(event.timeSec, 3),
    eventType: event.eventType,
    vehicleId: event.vehicleId,
    taskId: event.taskId,
    loadId: event.loadId,
    fromNodeId: event.fromNodeId,
    toNodeId: event.toNodeId,
    reason: event.reason,
    details: event.details
  }));
  return createHash('sha256').update(stableJson(projected)).digest('hex');
}

export function hashScenario(scenario: ShuttleScenario): string {
  return createHash('sha256').update(stableJson(scenario)).digest('hex');
}

export function hashEngineSnapshot(snapshot: Omit<ShuttleEngineSnapshotV1, 'stateHash'> | ShuttleEngineSnapshotV1): string {
  const { stateHash: _stateHash, ...projected } = snapshot as ShuttleEngineSnapshotV1;
  return createHash('sha256').update(stableJson(projected)).digest('hex');
}

export function hashDeterministicReplayState(snapshot: ShuttleEngineSnapshotV1): string {
  return hashEngineSnapshot({
    ...snapshot,
    sessionId: 'deterministic-replay-session'
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const nodePositionCacheByScenario = new WeakMap<ShuttleScenario, Map<string, { x: number; y: number; z: number }>>();

function nodePosition(scenario: ShuttleScenario, nodeId: string): { x: number; y: number; z: number } {
  let cache = nodePositionCacheByScenario.get(scenario);
  if (!cache) {
    cache = new Map(scenario.layout.nodes.map((node) => [node.id, { x: node.x, y: node.y, z: node.z }]));
    nodePositionCacheByScenario.set(scenario, cache);
  }
  const node = cache.get(nodeId);
  if (!node) {
    throw new Error(`Unknown node ${nodeId}`);
  }
  return node;
}

function liftKindForNode(node: LayoutNode): LiftKind | null {
  if (node.type !== 'lift-blackbox') {
    return null;
  }
  return node.liftKind ?? null;
}

function buildEdgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function reverseEdgeKey(from: string, to: string): string {
  return `${to}->${from}`;
}

export function calculateTravelTimeSec(distanceM: number, maxSpeedMps: number, accelerationMps2: number): number {
  const acceleration = Math.max(0.001, accelerationMps2);
  const speed = Math.max(0.001, maxSpeedMps);
  const accelerateDistanceM = (speed * speed) / (2 * acceleration);
  if (distanceM <= accelerateDistanceM * 2) {
    return 2 * Math.sqrt(distanceM / acceleration);
  }
  return (2 * speed) / acceleration + (distanceM - accelerateDistanceM * 2) / speed;
}

export function motionProfileAt(
  elapsedSec: number,
  distanceM: number,
  maxSpeedMps: number,
  accelerationMps2: number
): { distanceM: number; speedMps: number } {
  const acceleration = Math.max(0.001, accelerationMps2);
  const speed = Math.max(0.001, maxSpeedMps);
  const accelerateDistanceM = (speed * speed) / (2 * acceleration);
  if (distanceM <= accelerateDistanceM * 2) {
    const peakSpeedMps = Math.sqrt(distanceM * acceleration);
    const accelerateTimeSec = peakSpeedMps / acceleration;
    const totalTimeSec = accelerateTimeSec * 2;
    const elapsed = Math.min(totalTimeSec, Math.max(0, elapsedSec));
    if (elapsed <= accelerateTimeSec) {
      return {
        distanceM: 0.5 * acceleration * elapsed * elapsed,
        speedMps: acceleration * elapsed
      };
    }
    const decelElapsedSec = elapsed - accelerateTimeSec;
    return {
      distanceM: distanceM - 0.5 * acceleration * Math.max(0, totalTimeSec - elapsed) ** 2,
      speedMps: Math.max(0, peakSpeedMps - acceleration * decelElapsedSec)
    };
  }

  const accelerateTimeSec = speed / acceleration;
  const cruiseDistanceM = distanceM - accelerateDistanceM * 2;
  const cruiseTimeSec = cruiseDistanceM / speed;
  const totalTimeSec = accelerateTimeSec * 2 + cruiseTimeSec;
  const elapsed = Math.min(totalTimeSec, Math.max(0, elapsedSec));
  if (elapsed <= accelerateTimeSec) {
    return {
      distanceM: 0.5 * acceleration * elapsed * elapsed,
      speedMps: acceleration * elapsed
    };
  }
  if (elapsed <= accelerateTimeSec + cruiseTimeSec) {
    return {
      distanceM: accelerateDistanceM + (elapsed - accelerateTimeSec) * speed,
      speedMps: speed
    };
  }
  const remainingSec = totalTimeSec - elapsed;
  return {
    distanceM: distanceM - 0.5 * acceleration * remainingSec * remainingSec,
    speedMps: Math.max(0, acceleration * remainingSec)
  };
}

type LayoutNode = ShuttleScenario['layout']['nodes'][number];
type LiftKind = NonNullable<LayoutNode['liftKind']>;
type LayoutEdge = ShuttleScenario['layout']['edges'][number];
type LayoutZone = ShuttleScenario['layout']['zones'][number];
type DefaultLiftMode = 'balanced' | 'all-inbound';
type TopLiftColumnFlowMode = 'inbound' | 'outbound';

function storageNodeId(rowIndex: number, columnIndex: number): string {
  return `storage-r${String(rowIndex + 1).padStart(2, '0')}-c${String(columnIndex + 1).padStart(2, '0')}`;
}

function defaultStorageRowZs(profile: ShuttleLayoutGeometryProfile): number[] {
  const topRows = Array.from({ length: profile.storageRowsPerBank }, (_, rowIndex) =>
    round(-(profile.storageInnerRowZM + (profile.storageRowsPerBank - rowIndex - 1) * profile.storageCellPitchZM), 3)
  );
  const bottomRows = Array.from({ length: profile.storageRowsPerBank }, (_, rowIndex) =>
    round(profile.storageInnerRowZM + rowIndex * profile.storageCellPitchZM, 3)
  );
  return [...topRows, ...bottomRows];
}

function defaultStorageColumnXs(profile: ShuttleLayoutGeometryProfile): number[] {
  const storageColumns = profile.storageColumnsPerBay * profile.storageColumnBays;
  return Array.from({ length: storageColumns }, (_, columnIndex) =>
    round(
      profile.firstStorageXM +
        columnIndex * profile.storageCellPitchXM +
        Math.floor(columnIndex / profile.storageColumnsPerBay) * profile.storageBayGapXM,
      3
    )
  );
}

function defaultLiftPortalXs(columnXs: number[], rightSpineX: number, profile: ShuttleLayoutGeometryProfile): number[] {
  const portalXs: number[] = [];
  for (let bayIndex = 0; bayIndex < profile.storageColumnBays - 1; bayIndex += 1) {
    const leftColumnIndex = (bayIndex + 1) * profile.storageColumnsPerBay - 1;
    const rightColumnIndex = leftColumnIndex + 1;
    portalXs.push(round((columnXs[leftColumnIndex]! + columnXs[rightColumnIndex]!) / 2, 3));
  }
  portalXs.push(round((columnXs[columnXs.length - 1]! + rightSpineX) / 2, 3));
  return portalXs;
}

function mainLaneNodeId(lane: 'north' | 'south', index: number): string {
  return `main-${lane}-${String(index).padStart(2, '0')}`;
}

function columnAccessNodeId(level: 'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b', columnIndex: number): string {
  return `column-${level}-c${String(columnIndex + 1).padStart(2, '0')}`;
}

function moduleSpineNodeId(moduleIndex: number, level: 'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b'): string {
  return `module-${String(moduleIndex + 1).padStart(2, '0')}-spine-${level}`;
}

function moduleBoundarySpineNodeId(boundaryIndex: number, level: 'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b'): string {
  return `module-boundary-${String(boundaryIndex + 1).padStart(2, '0')}-spine-${level}`;
}

function isTopLiftColumnAccessNodeId(nodeId: string): boolean {
  return /^(?:column-(?:top-a|top-b|middle|bottom-a|bottom-b)-c\d+|(?:module-\d+|module-boundary-\d+)-spine-(?:top-a|top-b|middle|bottom-a|bottom-b))$/.test(nodeId);
}

type TopLiftAisleLevel = 'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b';

function topLiftAisleLevel(nodeId: string): TopLiftAisleLevel | null {
  const match = /^(?:column-(top-a|top-b|middle|bottom-a|bottom-b)-c\d+|(?:module-\d+|module-boundary-\d+)-spine-(top-a|top-b|middle|bottom-a|bottom-b))$/.exec(nodeId);
  return (match?.[1] ?? match?.[2] ?? null) as TopLiftAisleLevel | null;
}

function isTopLiftAisleLevelNodeId(nodeId: string, level: TopLiftAisleLevel): boolean {
  return topLiftAisleLevel(nodeId) === level;
}

function isTopLiftSpineLevelNodeId(nodeId: string, level: TopLiftAisleLevel): boolean {
  const match = /^(?:module-\d+|module-boundary-\d+)-spine-(top-a|top-b|middle|bottom-a|bottom-b)$/.exec(nodeId);
  return match?.[1] === level;
}

function topLiftSpineKey(nodeId: string): string | null {
  return /^(module-\d+|module-boundary-\d+)-spine-(?:top-a|top-b|middle|bottom-a|bottom-b)$/.exec(nodeId)?.[1] ?? null;
}

function liftBufferNodeId(liftNodeId: string, slotIndex: number): string {
  return `${liftNodeId}-buffer-${String(slotIndex).padStart(2, '0')}`;
}

function liftBufferAccessNodeId(liftNodeId: string): string {
  return `${liftNodeId}-buffer-access`;
}

function liftQueueAccessNodeId(liftNodeId: string): string {
  return `${liftNodeId}-queue-access`;
}

function liftQueueTailAccessNodeId(liftNodeId: string, slotIndex = 1): string {
  return `${liftNodeId}-queue-${String(slotIndex).padStart(2, '0')}-access`;
}

function liftQueueServiceExitNodeId(liftNodeId: string, slotIndex = 1): string {
  return `${liftNodeId}-queue-${String(slotIndex).padStart(2, '0')}-service-exit`;
}

function liftQueueTailEntryNodeId(liftNodeId: string, slotIndex = 1): string {
  return `${liftNodeId}-queue-${String(slotIndex).padStart(2, '0')}-entry-access`;
}

function liftQueueNodeId(liftNodeId: string, slotIndex = 1): string {
  return slotIndex <= 1
    ? `parking-${liftNodeId}-queue`
    : `parking-${liftNodeId}-queue-${String(slotIndex).padStart(2, '0')}`;
}

const topLiftQueueParkingSlotCache = new Map<string, { liftNodeId: string; slotIndex: number } | null>();

function liftBufferParentNodeId(nodeId: string): { liftNodeId: string; kind: LiftKind; slotIndex: number } | null {
  const match = /^(lift-\d{2}-(inbound|outbound))-buffer-(\d{2})$/.exec(nodeId);
  if (!match) {
    return null;
  }
  return {
    liftNodeId: match[1]!,
    kind: match[2]! as LiftKind,
    slotIndex: Number(match[3]!)
  };
}

function isTopLiftQueueParkingNodeId(nodeId: string): boolean {
  return /^parking-lift-\d{2}-(?:inbound|outbound)-queue(?:-\d{2})?$/.test(nodeId);
}

function topLiftQueueParkingSlot(nodeId: string): { liftNodeId: string; slotIndex: number } | null {
  if (topLiftQueueParkingSlotCache.has(nodeId)) {
    return topLiftQueueParkingSlotCache.get(nodeId) ?? null;
  }
  const match = /^parking-(lift-\d{2}-(?:inbound|outbound))-queue(?:-(\d{2}))?$/.exec(nodeId);
  if (!match) {
    topLiftQueueParkingSlotCache.set(nodeId, null);
    return null;
  }
  const slot = {
    liftNodeId: match[1]!,
    slotIndex: match[2] ? Number(match[2]) : 1
  };
  topLiftQueueParkingSlotCache.set(nodeId, slot);
  return slot;
}

function topLiftQueueAisleAccess(nodeId: string): { liftNodeId: string; slotIndex: number } | null {
  const match = /^(lift-\d{2}-(?:inbound|outbound))-queue(?:-(\d{2}))?-access$/.exec(nodeId);
  if (!match) {
    return null;
  }
  return {
    liftNodeId: match[1]!,
    slotIndex: match[2] ? Number(match[2]) : 0
  };
}

function topLiftQueueEntrySlot(nodeId: string): { liftNodeId: string; slotIndex: number } | null {
  const match = /^(lift-\d{2}-(?:inbound|outbound))-queue-(\d{2})-entry-access$/.exec(nodeId);
  return match ? { liftNodeId: match[1]!, slotIndex: Number(match[2]!) } : null;
}

function createTopLiftColumnLayout(
  profile: ShuttleLayoutGeometryProfile,
  _liftMode: DefaultLiftMode = 'balanced'
): ShuttleScenario['layout'] {
  const rowsPerZone = profile.storageRowsPerZone;
  const columnsPerZone = profile.storageColumnsPerZone;
  const liftPairCount = profile.liftPairCount;
  const rowsPerModule = rowsPerZone * 2;
  const columnsPerModule = columnsPerZone * 2;
  const totalRows = rowsPerModule;
  const totalColumns = columnsPerModule * liftPairCount;
  const topAisleZM = 0;
  const topLaneSpacingZM = Math.abs(profile.mainLaneSouthZM - profile.mainLaneNorthZM);
  const topLaneAZM = round(topAisleZM - topLaneSpacingZM / 2, 3);
  const topLaneBZM = round(topAisleZM + topLaneSpacingZM / 2, 3);
  const upperFirstRowZ = round(topLaneBZM + profile.storageCellPitchZM, 3);
  const upperLastRowZ = round(upperFirstRowZ + (rowsPerZone - 1) * profile.storageCellPitchZM, 3);
  const middleAisleZ = round(upperLastRowZ + profile.storageCellPitchZM, 3);
  const lowerFirstRowZ = round(middleAisleZ + profile.storageCellPitchZM, 3);
  const lowerLastRowZ = round(lowerFirstRowZ + (rowsPerZone - 1) * profile.storageCellPitchZM, 3);
  const bottomLaneAZM = round(lowerLastRowZ + profile.storageCellPitchZM, 3);
  const bottomLaneBZM = round(bottomLaneAZM + topLaneSpacingZM, 3);
  const liftZ = round(topLaneAZM - profile.liftStandoffZM, 3);
  const columnXs = Array.from({ length: totalColumns }, (_, columnIndex) => {
    return round(
      profile.firstStorageXM +
        columnIndex * profile.storageCellPitchXM +
        Math.floor(columnIndex / columnsPerZone) * profile.storageBayGapXM,
      3
    );
  });
  const rowZ = (rowIndex: number): number => rowIndex < rowsPerZone
    ? round(upperFirstRowZ + rowIndex * profile.storageCellPitchZM, 3)
    : round(lowerFirstRowZ + (rowIndex - rowsPerZone) * profile.storageCellPitchZM, 3);

  const nodes: LayoutNode[] = [];
  const addNode = (node: LayoutNode): void => {
    nodes.push(node);
  };

  for (let columnIndex = 0; columnIndex < totalColumns; columnIndex += 1) {
    const x = columnXs[columnIndex]!;
    addNode({ id: columnAccessNodeId('top-a', columnIndex), type: 'intersection', x, y: 0, z: topLaneAZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
    addNode({ id: columnAccessNodeId('top-b', columnIndex), type: 'intersection', x, y: 0, z: topLaneBZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
    addNode({ id: columnAccessNodeId('middle', columnIndex), type: 'intersection', x, y: 0, z: middleAisleZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
    addNode({ id: columnAccessNodeId('bottom-a', columnIndex), type: 'intersection', x, y: 0, z: bottomLaneAZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
    addNode({ id: columnAccessNodeId('bottom-b', columnIndex), type: 'intersection', x, y: 0, z: bottomLaneBZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
  }

  for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
    const rowLabel = String(rowIndex + 1).padStart(2, '0');
    const z = rowZ(rowIndex);
    addNode({ id: `left-row-${rowLabel}`, type: 'intersection', x: round(columnXs[0]! - profile.sideClearanceXM, 3), y: 0, z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
    addNode({ id: `right-row-${rowLabel}`, type: 'intersection', x: round(columnXs[totalColumns - 1]! + profile.sideClearanceXM, 3), y: 0, z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
    for (let columnIndex = 0; columnIndex < totalColumns; columnIndex += 1) {
      addNode({
        id: storageNodeId(rowIndex, columnIndex),
        type: 'storage',
        x: columnXs[columnIndex]!,
        y: 0,
        z,
        noStop: false,
        noParking: false,
        capacity: 1,
        allowedDirections: []
      });
    }
  }

  const liftNodes: Array<{
    id: string;
    x: number;
    z: number;
    kind: LiftKind;
    throatId: string;
    bufferAccessId: string;
    bufferNodeIds: string[];
    queueAccessId: string | null;
    queueAccessNodeIds: string[];
    queueServiceExitNodeIds: string[];
    queueEntryNodeIds: string[];
    queuePickupAccessId: string | null;
    queueNodeId: string | null;
    queueNodeIds: string[];
  }> = [];
  const moduleSpineNodeIds: Record<'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b', string[]> = {
    'top-a': [],
    'top-b': [],
    middle: [],
    'bottom-a': [],
    'bottom-b': []
  };
  const moduleBoundarySpineNodeIds: Record<'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b', string[]> = {
    'top-a': [],
    'top-b': [],
    middle: [],
    'bottom-a': [],
    'bottom-b': []
  };
  const spineLevels = [
    { level: 'top-a' as const, z: topLaneAZM },
    { level: 'top-b' as const, z: topLaneBZM },
    { level: 'middle' as const, z: middleAisleZ },
    { level: 'bottom-a' as const, z: bottomLaneAZM },
    { level: 'bottom-b' as const, z: bottomLaneBZM }
  ];
  for (let moduleIndex = 0; moduleIndex < liftPairCount; moduleIndex += 1) {
    const moduleFirstColumn = moduleIndex * columnsPerModule;
    const leftZoneStartX = columnXs[moduleFirstColumn]!;
    const leftZoneEndX = columnXs[moduleFirstColumn + columnsPerZone - 1]!;
    const rightZoneStartX = columnXs[moduleFirstColumn + columnsPerZone]!;
    const rightZoneEndX = columnXs[moduleFirstColumn + columnsPerModule - 1]!;
    const moduleSpineX = round((leftZoneEndX + rightZoneStartX) / 2, 3);
    for (const spine of spineLevels) {
      const id = moduleSpineNodeId(moduleIndex, spine.level);
      addNode({ id, type: 'intersection', x: moduleSpineX, y: 0, z: spine.z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
      moduleSpineNodeIds[spine.level].push(id);
    }
    const physicalLiftXs = [
      round((leftZoneStartX + leftZoneEndX) / 2, 3),
      round((rightZoneStartX + rightZoneEndX) / 2, 3)
    ];
    const liftNumber = moduleIndex + 1;
    const portDefinitions = [
      { suffix: 'inbound', kind: 'inbound' as const, x: physicalLiftXs[0]! },
      { suffix: 'outbound', kind: 'outbound' as const, x: physicalLiftXs[1]! }
    ];
    for (const port of portDefinitions) {
      const id = `lift-${String(liftNumber).padStart(2, '0')}-${port.suffix}`;
      const throatId = `${id}-throat`;
      const bufferAccessId = liftBufferAccessNodeId(id);
      const bufferNodeIds: string[] = [];
      const queueAccessId = liftQueueAccessNodeId(id);
      const queuePickupAccessId: string | null = null;
      const queueNodeId = liftQueueNodeId(id);
      const queueNodeIds = Array.from({ length: 3 }, (_, index) => liftQueueNodeId(id, index + 1));
      const queueAccessNodeIds = Array.from({ length: 3 }, (_, index) => liftQueueTailAccessNodeId(id, index + 1));
      const queueServiceExitNodeIds = Array.from({ length: 3 }, (_, index) => liftQueueServiceExitNodeId(id, index + 1));
      const queueEntryNodeIds = Array.from({ length: 3 }, (_, index) => liftQueueTailEntryNodeId(id, index + 1));
      addNode({ id, type: 'lift-blackbox', liftKind: port.kind, x: port.x, y: 0, z: liftZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
      addNode({ id: throatId, type: 'intersection', x: port.x, y: 0, z: topLaneAZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
      const conveyorSideX = round(port.x + (port.kind === 'inbound' ? profile.liftPortSpacingXM : -profile.liftPortSpacingXM), 3);
      const conveyorPitchZ = round(Math.abs(topLaneAZM - liftZ) / Math.max(1, profile.liftBufferCapacity), 3);
      addNode({ id: bufferAccessId, type: 'intersection', x: conveyorSideX, y: 0, z: topLaneAZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
      if (queueAccessId && queueNodeId) {
        const queueSlotPitchXM = Math.max(profile.storageCellPitchXM, profile.liftPortSpacingXM);
        const queueDirection = port.kind === 'inbound' ? 1 : -1;
        const queueAccessX = round(conveyorSideX + queueSlotPitchXM * queueDirection, 3);
        const queueSlotPitchZM = Math.max(profile.storageCellPitchZM, topLaneSpacingZM * 0.75);
        addNode({ id: queueAccessId, type: 'intersection', x: queueAccessX, y: 0, z: topLaneAZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
        for (let queueIndex = 0; queueIndex < queueNodeIds.length; queueIndex += 1) {
          const queueSlotZ = round(topLaneAZM - queueSlotPitchZM * (queueIndex + 1), 3);
          addNode({
            id: queueAccessNodeIds[queueIndex]!,
            type: 'intersection',
            x: queueAccessX,
            y: 0,
            z: queueSlotZ,
            noStop: true,
            noParking: true,
            capacity: 1,
            allowedDirections: []
          });
          addNode({
            id: queueNodeIds[queueIndex]!,
            type: 'parking',
            x: round(queueAccessX + queueSlotPitchXM * queueDirection, 3),
            y: 0,
            z: queueSlotZ,
            noStop: true,
            noParking: true,
            capacity: 1,
            allowedDirections: []
          });
          addNode({
            id: queueServiceExitNodeIds[queueIndex]!,
            type: 'intersection',
            x: conveyorSideX,
            y: 0,
            z: queueSlotZ,
            noStop: true,
            noParking: true,
            capacity: 1,
            allowedDirections: []
          });
          const queueEntryTargetX = round(queueAccessX + queueSlotPitchXM * queueDirection, 3);
          const queueEntryX = columnXs
            .map((x, columnIndex) => ({ x, columnIndex }))
            .sort((left, right) =>
              Math.abs(left.x - queueEntryTargetX) - Math.abs(right.x - queueEntryTargetX) ||
              left.columnIndex - right.columnIndex
            )[0]!.x;
          addNode({
            id: queueEntryNodeIds[queueIndex]!,
            type: 'intersection',
            x: queueEntryX,
            y: 0,
            z: queueSlotZ,
            noStop: true,
            noParking: true,
            capacity: 1,
            allowedDirections: []
          });
        }
      }
      for (let bufferIndex = 1; bufferIndex <= profile.liftBufferCapacity; bufferIndex += 1) {
        const bufferId = liftBufferNodeId(id, bufferIndex);
        bufferNodeIds.push(bufferId);
        addNode({
          id: bufferId,
          type: port.kind,
          x: conveyorSideX,
          y: 0,
          z: round(liftZ + conveyorPitchZ * (bufferIndex - 1), 3),
          noStop: true,
          noParking: true,
          capacity: 1,
          allowedDirections: []
        });
      }
      liftNodes.push({ id, x: port.x, z: liftZ, kind: port.kind, throatId, bufferAccessId, bufferNodeIds, queueAccessId, queueAccessNodeIds, queueServiceExitNodeIds, queueEntryNodeIds, queuePickupAccessId, queueNodeId, queueNodeIds });
    }
  }
  for (let boundaryIndex = 0; boundaryIndex < liftPairCount - 1; boundaryIndex += 1) {
    const leftColumnIndex = (boundaryIndex + 1) * columnsPerModule - 1;
    const rightColumnIndex = leftColumnIndex + 1;
    const boundarySpineX = round((columnXs[leftColumnIndex]! + columnXs[rightColumnIndex]!) / 2, 3);
    for (const spine of spineLevels) {
      const id = moduleBoundarySpineNodeId(boundaryIndex, spine.level);
      addNode({ id, type: 'intersection', x: boundarySpineX, y: 0, z: spine.z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
      moduleBoundarySpineNodeIds[spine.level].push(id);
    }
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges: LayoutEdge[] = [];
  const addEdge = (id: string, from: string, to: string, conflictGroup: string, directionMode: 'oneWay' | 'twoWay' = 'twoWay') => {
    const fromNode = nodesById.get(from);
    const toNode = nodesById.get(to);
    if (!fromNode || !toNode) {
      throw new Error(`Top-lift column layout edge ${id} references an unknown node.`);
    }
    const lengthM = round(Math.abs(toNode.x - fromNode.x) + Math.abs(toNode.z - fromNode.z), 3);
    if (lengthM <= 0) {
      return;
    }
    edges.push({
      id,
      from,
      to,
      lengthM,
      directionMode,
      reservationType: 'edge',
      conflictGroup,
      noParking: true
    });
  };

  const connectHorizontal = (level: 'top-a' | 'top-b' | 'middle' | 'bottom-a' | 'bottom-b', extraNodeIds: string[], groupPrefix: string): void => {
    const nodeIds = [
      ...Array.from({ length: totalColumns }, (_, columnIndex) => columnAccessNodeId(level, columnIndex)),
      ...extraNodeIds
    ]
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .sort((left, right) => nodesById.get(left)!.x - nodesById.get(right)!.x || left.localeCompare(right));
    const groups: string[][] = [];
    for (const nodeId of nodeIds) {
      const previousGroup = groups.at(-1);
      const previousNodeId = previousGroup?.[0];
      if (previousNodeId && Math.abs(nodesById.get(previousNodeId)!.x - nodesById.get(nodeId)!.x) <= 1e-6) {
        previousGroup.push(nodeId);
      } else {
        groups.push([nodeId]);
      }
    }
    for (let groupIndex = 1; groupIndex < groups.length; groupIndex += 1) {
      const leftGroup = groups[groupIndex - 1]!;
      const rightGroup = groups[groupIndex]!;
      for (const leftNodeId of leftGroup) {
        for (const rightNodeId of rightGroup) {
          addEdge(`${leftNodeId}-${rightNodeId}`, leftNodeId, rightNodeId, `${groupPrefix}-${String(groupIndex).padStart(2, '0')}`);
        }
      }
    }
  };

  const throatIds = liftNodes.map((lift) => lift.throatId);
  const bufferAccessIds = liftNodes.map((lift) => lift.bufferAccessId);
  connectHorizontal('top-a', [...throatIds, ...bufferAccessIds, ...moduleSpineNodeIds['top-a'], ...moduleBoundarySpineNodeIds['top-a']], 'top-double-aisle-a');
  connectHorizontal('top-a', [...throatIds, ...bufferAccessIds, ...moduleSpineNodeIds['top-a'], ...moduleBoundarySpineNodeIds['top-a']], 'top-double-aisle-a-base');
  connectHorizontal('top-b', [...moduleSpineNodeIds['top-b'], ...moduleBoundarySpineNodeIds['top-b']], 'top-double-aisle-b');
  connectHorizontal('middle', [...moduleSpineNodeIds.middle, ...moduleBoundarySpineNodeIds.middle], 'middle-aisle');
  connectHorizontal('bottom-a', [...moduleSpineNodeIds['bottom-a'], ...moduleBoundarySpineNodeIds['bottom-a']], 'bottom-double-aisle-a');
  connectHorizontal('bottom-b', [...moduleSpineNodeIds['bottom-b'], ...moduleBoundarySpineNodeIds['bottom-b']], 'bottom-double-aisle-b');

  for (let moduleIndex = 0; moduleIndex < liftPairCount; moduleIndex += 1) {
    const topA = moduleSpineNodeId(moduleIndex, 'top-a');
    const topB = moduleSpineNodeId(moduleIndex, 'top-b');
    const middle = moduleSpineNodeId(moduleIndex, 'middle');
    const bottomA = moduleSpineNodeId(moduleIndex, 'bottom-a');
    const bottomB = moduleSpineNodeId(moduleIndex, 'bottom-b');
    const spineLabel = `module-spine-${String(moduleIndex + 1).padStart(2, '0')}`;
    addEdge(`${topA}-${topB}`, topA, topB, `${spineLabel}-top-transfer`);
    addEdge(`${topB}-${middle}`, topB, middle, `${spineLabel}-upper-vertical`);
    addEdge(`${middle}-${bottomA}`, middle, bottomA, `${spineLabel}-lower-vertical`);
    addEdge(`${bottomA}-${bottomB}`, bottomA, bottomB, `${spineLabel}-bottom-transfer`);
  }
  for (let boundaryIndex = 0; boundaryIndex < liftPairCount - 1; boundaryIndex += 1) {
    const topA = moduleBoundarySpineNodeId(boundaryIndex, 'top-a');
    const topB = moduleBoundarySpineNodeId(boundaryIndex, 'top-b');
    const middle = moduleBoundarySpineNodeId(boundaryIndex, 'middle');
    const bottomA = moduleBoundarySpineNodeId(boundaryIndex, 'bottom-a');
    const bottomB = moduleBoundarySpineNodeId(boundaryIndex, 'bottom-b');
    const spineLabel = `module-boundary-spine-${String(boundaryIndex + 1).padStart(2, '0')}`;
    addEdge(`${topA}-${topB}`, topA, topB, `${spineLabel}-top-transfer`);
    addEdge(`${topB}-${middle}`, topB, middle, `${spineLabel}-upper-vertical`);
    addEdge(`${middle}-${bottomA}`, middle, bottomA, `${spineLabel}-lower-vertical`);
    addEdge(`${bottomA}-${bottomB}`, bottomA, bottomB, `${spineLabel}-bottom-transfer`);
  }

  for (let columnIndex = 0; columnIndex < totalColumns; columnIndex += 1) {
    addEdge(`${columnAccessNodeId('top-a', columnIndex)}-${columnAccessNodeId('top-b', columnIndex)}`, columnAccessNodeId('top-a', columnIndex), columnAccessNodeId('top-b', columnIndex), `top-lane-transfer-c${String(columnIndex + 1).padStart(2, '0')}`);
    addEdge(`${columnAccessNodeId('bottom-a', columnIndex)}-${columnAccessNodeId('bottom-b', columnIndex)}`, columnAccessNodeId('bottom-a', columnIndex), columnAccessNodeId('bottom-b', columnIndex), `bottom-lane-transfer-c${String(columnIndex + 1).padStart(2, '0')}`);
    addEdge(`${columnAccessNodeId('top-b', columnIndex)}-${storageNodeId(0, columnIndex)}`, columnAccessNodeId('top-b', columnIndex), storageNodeId(0, columnIndex), `storage-column-upper-c${String(columnIndex + 1).padStart(2, '0')}`);
    addEdge(`${columnAccessNodeId('middle', columnIndex)}-${storageNodeId(rowsPerZone - 1, columnIndex)}`, columnAccessNodeId('middle', columnIndex), storageNodeId(rowsPerZone - 1, columnIndex), `storage-column-upper-c${String(columnIndex + 1).padStart(2, '0')}`);
    addEdge(`${columnAccessNodeId('middle', columnIndex)}-${storageNodeId(rowsPerZone, columnIndex)}`, columnAccessNodeId('middle', columnIndex), storageNodeId(rowsPerZone, columnIndex), `storage-column-lower-c${String(columnIndex + 1).padStart(2, '0')}`);
    addEdge(`${columnAccessNodeId('bottom-a', columnIndex)}-${storageNodeId(totalRows - 1, columnIndex)}`, columnAccessNodeId('bottom-a', columnIndex), storageNodeId(totalRows - 1, columnIndex), `storage-column-lower-c${String(columnIndex + 1).padStart(2, '0')}`);
    for (let rowIndex = 1; rowIndex < rowsPerZone; rowIndex += 1) {
      addEdge(`${storageNodeId(rowIndex - 1, columnIndex)}-${storageNodeId(rowIndex, columnIndex)}`, storageNodeId(rowIndex - 1, columnIndex), storageNodeId(rowIndex, columnIndex), `storage-column-upper-c${String(columnIndex + 1).padStart(2, '0')}`);
      addEdge(`${storageNodeId(rowsPerZone + rowIndex - 1, columnIndex)}-${storageNodeId(rowsPerZone + rowIndex, columnIndex)}`, storageNodeId(rowsPerZone + rowIndex - 1, columnIndex), storageNodeId(rowsPerZone + rowIndex, columnIndex), `storage-column-lower-c${String(columnIndex + 1).padStart(2, '0')}`);
    }
  }

  for (const lift of liftNodes) {
    addEdge(`${lift.id}-${lift.throatId}`, lift.id, lift.throatId, `${lift.id}-buffer-throat`);
    const pickupBufferNodeId = lift.bufferNodeIds.at(-1);
    if (pickupBufferNodeId) {
      addEdge(`${lift.bufferAccessId}-${pickupBufferNodeId}`, lift.bufferAccessId, pickupBufferNodeId, `${lift.id}-conveyor-pickup`);
    }
    if (lift.queueAccessId && lift.queueNodeId && pickupBufferNodeId) {
      addEdge(`${lift.bufferAccessId}-${lift.queueAccessId}`, lift.bufferAccessId, lift.queueAccessId, `${lift.id}-standby-queue-access`);
      let previousQueueAccessNodeId = lift.queueAccessId;
      let previousQueueNodeId: string | null = null;
      let previousServiceExitNodeId = lift.bufferAccessId;
      for (let queueIndex = 0; queueIndex < lift.queueNodeIds.length; queueIndex += 1) {
        const queueAccessNodeId = lift.queueAccessNodeIds[queueIndex];
        const queueServiceExitNodeId = lift.queueServiceExitNodeIds[queueIndex];
        const queueNodeId = lift.queueNodeIds[queueIndex];
        if (!queueAccessNodeId || !queueServiceExitNodeId || !queueNodeId) {
          continue;
        }
        addEdge(
          `${previousQueueAccessNodeId}-${queueAccessNodeId}`,
          previousQueueAccessNodeId,
          queueAccessNodeId,
          `${lift.id}-standby-queue-aisle-${String(queueIndex + 1).padStart(2, '0')}`
        );
        addEdge(
          `${queueAccessNodeId}-${queueNodeId}`,
          queueAccessNodeId,
          queueNodeId,
          `${lift.id}-standby-queue-slot-${String(queueIndex + 1).padStart(2, '0')}`
        );
        if (previousQueueNodeId) {
          addEdge(
            `${previousQueueNodeId}-${queueNodeId}`,
            previousQueueNodeId,
            queueNodeId,
            `${lift.id}-standby-queue-parking-spine-${String(queueIndex + 1).padStart(2, '0')}`,
            'oneWay'
          );
        }
        addEdge(
          `${queueNodeId}-${queueServiceExitNodeId}`,
          queueNodeId,
          queueServiceExitNodeId,
          `${lift.id}-standby-queue-service-lateral-${String(queueIndex + 1).padStart(2, '0')}`,
          'oneWay'
        );
        const queueEntryNodeId = lift.queueEntryNodeIds[queueIndex];
        if (queueEntryNodeId) {
          const entryNode = nodesById.get(queueEntryNodeId);
          if (entryNode) {
            const entryColumnIndex = columnXs.findIndex((x) => Math.abs(x - entryNode.x) < 1e-6);
            if (entryColumnIndex >= 0) {
              const entryTopNodeId = columnAccessNodeId('top-a', entryColumnIndex);
              addEdge(
                `${entryTopNodeId}-${queueEntryNodeId}`,
                entryTopNodeId,
                queueEntryNodeId,
                `${lift.id}-standby-queue-entry-drop-${String(queueIndex + 1).padStart(2, '0')}`,
                lift.kind === 'inbound' ? 'twoWay' : 'oneWay'
              );
            }
            if (lift.kind === 'inbound') {
              addEdge(
                `${queueServiceExitNodeId}-${queueEntryNodeId}`,
                queueServiceExitNodeId,
                queueEntryNodeId,
                `${lift.id}-standby-queue-service-entry-${String(queueIndex + 1).padStart(2, '0')}`,
                'oneWay'
              );
            } else {
              addEdge(
                `${queueEntryNodeId}-${queueServiceExitNodeId}`,
                queueEntryNodeId,
                queueServiceExitNodeId,
                `${lift.id}-standby-queue-service-entry-${String(queueIndex + 1).padStart(2, '0')}`,
                'oneWay'
              );
            }
          }
        }
        addEdge(
          `${queueServiceExitNodeId}-${previousServiceExitNodeId}`,
          queueServiceExitNodeId,
          previousServiceExitNodeId,
          `${lift.id}-standby-queue-service-spine-${String(queueIndex + 1).padStart(2, '0')}`,
          lift.kind === 'inbound' ? 'twoWay' : 'oneWay'
        );
        previousQueueAccessNodeId = queueAccessNodeId;
        previousQueueNodeId = queueNodeId;
        previousServiceExitNodeId = queueServiceExitNodeId;
      }
    }
    let previousBufferNodeId: string | null = null;
    for (const bufferNodeId of lift.bufferNodeIds) {
      if (!previousBufferNodeId) {
        addEdge(`${lift.id}-${bufferNodeId}`, lift.id, bufferNodeId, `${lift.id}-conveyor-buffer`);
      } else {
        addEdge(`${previousBufferNodeId}-${bufferNodeId}`, previousBufferNodeId, bufferNodeId, `${lift.id}-conveyor-buffer`);
      }
      previousBufferNodeId = bufferNodeId;
    }
  }

  const parkingZ = bottomLaneBZM;
  for (let index = 0; index < 8; index += 1) {
    const columnIndex = Math.min(totalColumns - 1, Math.floor(index * totalColumns / 8));
    const id = `parking-${String(index + 1).padStart(2, '0')}`;
    addNode({ id, type: 'parking', x: columnXs[columnIndex]!, y: 0, z: round(parkingZ + profile.parkingStandoffXM, 3), noStop: false, noParking: false, capacity: 1, allowedDirections: [] });
    nodesById.set(id, nodes[nodes.length - 1]!);
    addEdge(`${id}-${columnAccessNodeId('bottom-b', columnIndex)}`, id, columnAccessNodeId('bottom-b', columnIndex), `parking-bottom-c${String(columnIndex + 1).padStart(2, '0')}`);
  }

  const calibrationProfile = {
    ...profile.calibrationProfile,
    id: TOP_LIFT_COLUMN_LAYOUT_PROFILE_ID,
    label: 'Top-lift column-fill layout assumption',
    sourceDescription: `${profile.calibrationProfile.sourceDescription}; updated from user reference image with top-side lifts, one left inbound lift and one right outbound lift per region, and column-fill 7x7 modules.`,
    dimensions: profile.calibrationProfile.dimensions.map((dimension) => dimension.key === 'storageBayGapX'
      ? {
          ...dimension,
          note: 'Top-lift column layouts use one storage pitch as the pass-through gap between adjacent 7x7 storage zones.'
        }
      : dimension),
    notes: [
      ...profile.calibrationProfile.notes,
      'Top-lift column layout: every region has a left inbound lift and a right outbound lift.',
      'Each inbound and outbound lift port has three explicit compact conveyor buffer positions stacked along the lift side; inbound buffers sit to the right of the port and outbound buffers sit to the left.',
      'Each inbound lift has a side standby queue pocket next to the conveyor pickup so one empty shuttle can wait off the aisle while another lifts.',
      'Each pair of physical lifts owns four 7x7 storage zones; inbound target allocation fills each physical storage column bottom-to-top.',
      'Adjacent 7x7 storage zones leave a one-lane pass-through gap; empty shuttles may use storage cells as conditional aisle space while loaded routes avoid stored-load crossings.',
      'Inbound source backlog models three port buffer positions plus one lift position per inbound port.'
    ]
  };

  return { units: 'meter', calibrationProfile, nodes, edges, zones: [] };
}

function createDefaultLayout(
  profile: ShuttleLayoutGeometryProfile = DEFAULT_SHUTTLE_LAYOUT_PROFILE,
  liftMode: DefaultLiftMode = 'balanced'
): ShuttleScenario['layout'] {
  if (profile.layoutKind === 'top-lift-column') {
    return createTopLiftColumnLayout(profile, liftMode);
  }

  const leftSpineX = profile.leftSpineXM;
  const rowZs = defaultStorageRowZs(profile);
  const columnXs = defaultStorageColumnXs(profile);
  const storageColumns = columnXs.length;
  const rightSpineX = round(columnXs[columnXs.length - 1]! + profile.sideClearanceXM, 3);
  const topZ = round(rowZs[0]! - profile.storageCellPitchZM * 1.5, 3);
  const bottomZ = round(rowZs[rowZs.length - 1]! + profile.storageCellPitchZM * 1.5, 3);
  const topLiftZ = round(topZ - profile.liftStandoffZM, 3);
  const bottomLiftZ = round(bottomZ + profile.liftStandoffZM, 3);
  const liftPortalXs = defaultLiftPortalXs(columnXs, rightSpineX, profile);
  const mainXs = [leftSpineX, ...liftPortalXs, rightSpineX];

  const rightParkingX = round(rightSpineX + profile.parkingStandoffXM, 3);
  const rightStagingX = round(rightSpineX + profile.parkingStandoffXM * 2, 3);
  const leftParkingX = round(leftSpineX - profile.parkingStandoffXM, 3);
  const leftStagingX = round(leftSpineX - profile.parkingStandoffXM * 2, 3);

  const nodes: LayoutNode[] = [
    { id: 'left-top', type: 'aisle', x: leftSpineX, y: 0, z: topZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'left-bottom', type: 'aisle', x: leftSpineX, y: 0, z: bottomZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'right-top', type: 'aisle', x: rightSpineX, y: 0, z: topZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'right-bottom', type: 'aisle', x: rightSpineX, y: 0, z: bottomZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'parking-a', type: 'parking', x: rightParkingX, y: 0, z: profile.mainLaneNorthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-b', type: 'parking', x: rightParkingX, y: 0, z: profile.mainLaneSouthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-c', type: 'parking', x: leftParkingX, y: 0, z: profile.mainLaneNorthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-d', type: 'parking', x: leftParkingX, y: 0, z: profile.mainLaneSouthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-e', type: 'parking', x: rightStagingX, y: 0, z: profile.mainLaneNorthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-f', type: 'parking', x: rightStagingX, y: 0, z: profile.mainLaneSouthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-g', type: 'parking', x: leftStagingX, y: 0, z: profile.mainLaneNorthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-h', type: 'parking', x: leftStagingX, y: 0, z: profile.mainLaneSouthZM, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
  ];

  mainXs.forEach((x, index) => {
    nodes.push(
      { id: mainLaneNodeId('north', index), type: 'intersection', x, y: 0, z: profile.mainLaneNorthZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
      { id: mainLaneNodeId('south', index), type: 'intersection', x, y: 0, z: profile.mainLaneSouthZM, noStop: true, noParking: true, capacity: 1, allowedDirections: [] }
    );
  });

  const liftKind = (balancedKind: LiftKind): LiftKind => liftMode === 'all-inbound' ? 'inbound' : balancedKind;
  const liftDefinitions: Array<{ id: string; liftKind: LiftKind; portalIndex: number; x: number; z: number }> = [
    { id: 'inbound-lift-top-01', liftKind: liftKind('inbound'), portalIndex: 0, x: liftPortalXs[0]!, z: topLiftZ },
    { id: 'outbound-lift-top-01', liftKind: liftKind('outbound'), portalIndex: 1, x: liftPortalXs[1]!, z: topLiftZ },
    { id: 'inbound-lift-top-02', liftKind: liftKind('inbound'), portalIndex: 2, x: liftPortalXs[2]!, z: topLiftZ },
    { id: 'outbound-lift-top-02', liftKind: liftKind('outbound'), portalIndex: 3, x: liftPortalXs[3]!, z: topLiftZ },
    { id: 'outbound-lift-bottom-01', liftKind: liftKind('outbound'), portalIndex: 0, x: liftPortalXs[0]!, z: bottomLiftZ },
    { id: 'inbound-lift-bottom-01', liftKind: liftKind('inbound'), portalIndex: 1, x: liftPortalXs[1]!, z: bottomLiftZ },
    { id: 'outbound-lift-bottom-02', liftKind: liftKind('outbound'), portalIndex: 2, x: liftPortalXs[2]!, z: bottomLiftZ },
    { id: 'inbound-lift-bottom-02', liftKind: liftKind('inbound'), portalIndex: 3, x: liftPortalXs[3]!, z: bottomLiftZ }
  ];
  liftDefinitions.forEach((lift) => {
    nodes.push({ id: lift.id, type: 'lift-blackbox', liftKind: lift.liftKind, x: lift.x, y: 0, z: lift.z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
  });
  for (let rowIndex = 0; rowIndex < rowZs.length; rowIndex += 1) {
    const z = rowZs[rowIndex]!;
    const rowLabel = String(rowIndex + 1).padStart(2, '0');
    nodes.push(
      { id: `left-row-${rowLabel}`, type: 'intersection', x: leftSpineX, y: 0, z, noStop: false, noParking: true, capacity: 1, allowedDirections: [] },
      { id: `right-row-${rowLabel}`, type: 'intersection', x: rightSpineX, y: 0, z, noStop: false, noParking: true, capacity: 1, allowedDirections: [] }
    );
    for (let columnIndex = 0; columnIndex < columnXs.length; columnIndex += 1) {
      nodes.push({
        id: storageNodeId(rowIndex, columnIndex),
        type: 'storage',
        x: columnXs[columnIndex]!,
        y: 0,
        z,
        noStop: false,
        noParking: false,
        capacity: 1,
        allowedDirections: []
      });
    }
  }

  const liftStorageTransferNodes: Array<{
    id: string;
    liftId: string;
    rowLabel: string;
    rowIndex: number;
    storageIds: string[];
  }> = [];
  for (const lift of liftDefinitions) {
    for (let rowIndex = 0; rowIndex < rowZs.length; rowIndex += 1) {
      const z = rowZs[rowIndex]!;
      const rowLabel = String(rowIndex + 1).padStart(2, '0');
      const leftColumnIndex = columnXs.findIndex((x, index) =>
        index < columnXs.length - 1 &&
        x < lift.x &&
        lift.x < columnXs[index + 1]!
      );
      const storageIds = leftColumnIndex >= 0
        ? [
            storageNodeId(rowIndex, leftColumnIndex),
            storageNodeId(rowIndex, leftColumnIndex + 1)
          ]
        : lift.x <= columnXs[0]!
          ? [storageNodeId(rowIndex, 0)]
          : lift.x >= columnXs[columnXs.length - 1]!
            ? [storageNodeId(rowIndex, columnXs.length - 1)]
            : [];
      if (storageIds.length === 0) {
        continue;
      }
      const id = `${lift.id}-row-${rowLabel}-transfer`;
      nodes.push({
        id,
        type: 'intersection',
        x: lift.x,
        y: 0,
        z,
        noStop: true,
        noParking: true,
        capacity: 1,
        allowedDirections: []
      });
      liftStorageTransferNodes.push({ id, liftId: lift.id, rowLabel, rowIndex, storageIds });
    }
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges: LayoutEdge[] = [];
  const addEdge = (id: string, from: string, to: string, conflictGroup: string, directionMode: 'oneWay' | 'twoWay' = 'twoWay') => {
    const fromNode = nodesById.get(from);
    const toNode = nodesById.get(to);
    if (!fromNode || !toNode) {
      throw new Error(`Default layout edge ${id} references an unknown node.`);
    }
    edges.push({
      id,
      from,
      to,
      lengthM: round(Math.abs(toNode.x - fromNode.x) + Math.abs(toNode.z - fromNode.z), 3),
      directionMode,
      reservationType: 'edge',
      conflictGroup,
      noParking: true
    });
  };

  addEdge('left-top-right-top', 'left-top', 'right-top', 'north-cross-aisle');
  addEdge('left-bottom-right-bottom', 'left-bottom', 'right-bottom', 'south-cross-aisle');

  for (let index = 1; index < mainXs.length; index += 1) {
    addEdge(
      `${mainLaneNodeId('north', index - 1)}-${mainLaneNodeId('north', index)}`,
      mainLaneNodeId('north', index - 1),
      mainLaneNodeId('north', index),
      `main-lane-north-${String(index).padStart(2, '0')}`
    );
    addEdge(
      `${mainLaneNodeId('south', index - 1)}-${mainLaneNodeId('south', index)}`,
      mainLaneNodeId('south', index - 1),
      mainLaneNodeId('south', index),
      `main-lane-south-${String(index).padStart(2, '0')}`
    );
  }
  for (let index = 1; index < mainXs.length - 1; index += 1) {
    addEdge(
      `${mainLaneNodeId('north', index)}-${mainLaneNodeId('south', index)}`,
      mainLaneNodeId('north', index),
      mainLaneNodeId('south', index),
      `main-lane-transfer-${String(index).padStart(2, '0')}`
    );
  }

  const lastMainIndex = mainXs.length - 1;
  addEdge('parking-a-main-north-right', 'parking-a', mainLaneNodeId('north', lastMainIndex), 'parking-approach-right-north');
  addEdge('parking-b-main-south-right', 'parking-b', mainLaneNodeId('south', lastMainIndex), 'parking-approach-right-south');
  addEdge('parking-c-main-north-left', 'parking-c', mainLaneNodeId('north', 0), 'parking-approach-left-north');
  addEdge('parking-d-main-south-left', 'parking-d', mainLaneNodeId('south', 0), 'parking-approach-left-south');
  addEdge('parking-e-parking-a', 'parking-e', 'parking-a', 'parking-staging-right-north');
  addEdge('parking-f-parking-b', 'parking-f', 'parking-b', 'parking-staging-right-south');
  addEdge('parking-g-parking-c', 'parking-g', 'parking-c', 'parking-staging-left-north');
  addEdge('parking-h-parking-d', 'parking-h', 'parking-d', 'parking-staging-left-south');

  const liftConnectorDefinitions = [
    { id: 'inbound-lift-top-01', targets: [mainLaneNodeId('north', 1), mainLaneNodeId('south', 1)] },
    { id: 'outbound-lift-top-01', targets: [mainLaneNodeId('north', 2), mainLaneNodeId('south', 2)] },
    { id: 'inbound-lift-top-02', targets: [mainLaneNodeId('north', 3), mainLaneNodeId('south', 3)] },
    { id: 'outbound-lift-top-02', targets: [mainLaneNodeId('north', 4), mainLaneNodeId('south', 4)] },
    { id: 'outbound-lift-bottom-01', targets: [mainLaneNodeId('north', 1), mainLaneNodeId('south', 1)] },
    { id: 'inbound-lift-bottom-01', targets: [mainLaneNodeId('north', 2), mainLaneNodeId('south', 2)] },
    { id: 'outbound-lift-bottom-02', targets: [mainLaneNodeId('north', 3), mainLaneNodeId('south', 3)] },
    { id: 'inbound-lift-bottom-02', targets: [mainLaneNodeId('north', 4), mainLaneNodeId('south', 4)] }
  ];
  liftConnectorDefinitions.forEach((connector) => {
    for (const target of connector.targets) {
      addEdge(`${connector.id}-${target}`, connector.id, target, `${connector.id}-dock`);
    }
  });
  const topRowNodeIds = rowZs.map((z, rowIndex) => ({ z, left: `left-row-${String(rowIndex + 1).padStart(2, '0')}`, right: `right-row-${String(rowIndex + 1).padStart(2, '0')}` }))
    .filter((row) => row.z < profile.mainLaneNorthZM);
  const bottomRowNodeIds = rowZs.map((z, rowIndex) => ({ z, left: `left-row-${String(rowIndex + 1).padStart(2, '0')}`, right: `right-row-${String(rowIndex + 1).padStart(2, '0')}` }))
    .filter((row) => row.z > profile.mainLaneSouthZM);
  const leftSpineNodeIds = [
    'left-top',
    ...topRowNodeIds.map((row) => row.left),
    mainLaneNodeId('north', 0),
    mainLaneNodeId('south', 0),
    ...bottomRowNodeIds.map((row) => row.left),
    'left-bottom'
  ];
  const rightSpineNodeIds = [
    'right-top',
    ...topRowNodeIds.map((row) => row.right),
    mainLaneNodeId('north', lastMainIndex),
    mainLaneNodeId('south', lastMainIndex),
    ...bottomRowNodeIds.map((row) => row.right),
    'right-bottom'
  ];
  for (let index = 1; index < leftSpineNodeIds.length; index += 1) {
    const from = leftSpineNodeIds[index - 1]!;
    const to = leftSpineNodeIds[index]!;
    addEdge(`${from}-${to}`, from, to, `left-upright-${String(index).padStart(2, '0')}`);
  }
  for (let index = 1; index < rightSpineNodeIds.length; index += 1) {
    const from = rightSpineNodeIds[index - 1]!;
    const to = rightSpineNodeIds[index]!;
    addEdge(`${from}-${to}`, from, to, `right-upright-${String(index).padStart(2, '0')}`);
  }

  for (const lift of liftDefinitions) {
    const columnNodes = [
      lift.id,
      ...liftStorageTransferNodes
        .filter((transfer) => transfer.liftId === lift.id)
        .map((transfer) => transfer.id)
    ].sort((left, right) => nodesById.get(left)!.z - nodesById.get(right)!.z || left.localeCompare(right));
    for (let index = 1; index < columnNodes.length; index += 1) {
      const from = columnNodes[index - 1]!;
      const to = columnNodes[index]!;
      addEdge(
        `lift-column-segment-${from}-${to}`,
        from,
        to,
        `${lift.id}-storage-column-${String(index).padStart(2, '0')}`
      );
    }
  }

  for (let rowIndex = 0; rowIndex < rowZs.length; rowIndex += 1) {
    const rowLabel = String(rowIndex + 1).padStart(2, '0');
    const rightRowId = `right-row-${rowLabel}`;
    const leftRowId = `left-row-${rowLabel}`;
    const rightmostStorageId = storageNodeId(rowIndex, storageColumns - 1);
    edges.push({
      id: `${rightRowId}-${rightmostStorageId}`,
      from: rightRowId,
      to: rightmostStorageId,
      lengthM: round(rightSpineX - columnXs[storageColumns - 1]!, 3),
      directionMode: 'twoWay',
      reservationType: 'edge',
      conflictGroup: `fifo-lane-${rowLabel}`,
      noParking: true
    });
    for (let columnIndex = storageColumns - 1; columnIndex > 0; columnIndex -= 1) {
      const from = storageNodeId(rowIndex, columnIndex);
      const to = storageNodeId(rowIndex, columnIndex - 1);
      edges.push({
        id: `${from}-${to}`,
        from,
        to,
        lengthM: round(columnXs[columnIndex]! - columnXs[columnIndex - 1]!, 3),
        directionMode: 'twoWay',
        reservationType: 'edge',
        conflictGroup: `fifo-lane-${rowLabel}`,
        noParking: true
      });
    }
    const leftmostStorageId = storageNodeId(rowIndex, 0);
    edges.push({
      id: `${leftmostStorageId}-${leftRowId}`,
      from: leftmostStorageId,
      to: leftRowId,
      lengthM: round(columnXs[0]! - leftSpineX, 3),
      directionMode: 'twoWay',
      reservationType: 'edge',
      conflictGroup: `fifo-lane-${rowLabel}`,
      noParking: true
    });
  }
  for (const transfer of liftStorageTransferNodes) {
    for (const storageId of transfer.storageIds) {
      addEdge(
        `${storageId}-${transfer.id}`,
        storageId,
        transfer.id,
        `fifo-lane-${transfer.rowLabel}`
      );
    }
    addEdge(
      `${transfer.id}-${transfer.liftId}`,
      transfer.id,
      transfer.liftId,
      `${transfer.liftId}-storage-transfer-${transfer.rowLabel}`
    );
  }

  const liftStorageCrossingZones: LayoutZone[] = [];
  const liftMainCrossingZones: LayoutZone[] = [];
  const liftConnectorEdges = edges.filter((edge) => {
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    return (
      (fromNode?.type === 'lift-blackbox' && toNode?.id.startsWith('main-')) ||
      (toNode?.type === 'lift-blackbox' && fromNode?.id.startsWith('main-'))
    );
  });
  const fifoLaneEdges = edges.filter((edge) => edge.conflictGroup?.startsWith('fifo-lane'));
  for (const connectorEdge of liftConnectorEdges) {
    const connectorFrom = nodesById.get(connectorEdge.from)!;
    const connectorTo = nodesById.get(connectorEdge.to)!;
    if (connectorFrom.x !== connectorTo.x) {
      continue;
    }
    const connectorX = connectorFrom.x;
    const connectorMinZ = Math.min(connectorFrom.z, connectorTo.z);
    const connectorMaxZ = Math.max(connectorFrom.z, connectorTo.z);
    for (const fifoEdge of fifoLaneEdges) {
      const fifoFrom = nodesById.get(fifoEdge.from)!;
      const fifoTo = nodesById.get(fifoEdge.to)!;
      if (fifoFrom.z !== fifoTo.z) {
        continue;
      }
      const fifoMinX = Math.min(fifoFrom.x, fifoTo.x);
      const fifoMaxX = Math.max(fifoFrom.x, fifoTo.x);
      const crosses = connectorX >= fifoMinX && connectorX <= fifoMaxX && fifoFrom.z >= connectorMinZ && fifoFrom.z <= connectorMaxZ;
      if (!crosses) {
        continue;
      }
      const index = liftStorageCrossingZones.length + 1;
      liftStorageCrossingZones.push({
        id: `zone-lift-storage-cross-${String(index).padStart(3, '0')}`,
        type: 'intersection' as const,
        nodeIds: [],
        edgeIds: [connectorEdge.id, fifoEdge.id].sort((left, right) => left.localeCompare(right)),
        noStop: true,
        noParking: true,
        capacity: 1,
        conflictGroup: `intersection-lift-storage-cross-${String(index).padStart(3, '0')}`
      });
    }
  }
  const mainLaneEdges = edges.filter((edge) => edge.from.startsWith('main-') && edge.to.startsWith('main-'));
  for (const connectorEdge of liftConnectorEdges) {
    const connectorFrom = nodesById.get(connectorEdge.from)!;
    const connectorTo = nodesById.get(connectorEdge.to)!;
    if (connectorFrom.x !== connectorTo.x) {
      continue;
    }
    const connectorX = connectorFrom.x;
    const connectorMinZ = Math.min(connectorFrom.z, connectorTo.z);
    const connectorMaxZ = Math.max(connectorFrom.z, connectorTo.z);
    for (const mainEdge of mainLaneEdges) {
      const mainFrom = nodesById.get(mainEdge.from)!;
      const mainTo = nodesById.get(mainEdge.to)!;
      if (mainFrom.z !== mainTo.z) {
        continue;
      }
      const mainMinX = Math.min(mainFrom.x, mainTo.x);
      const mainMaxX = Math.max(mainFrom.x, mainTo.x);
      const crosses = connectorX >= mainMinX && connectorX <= mainMaxX && mainFrom.z >= connectorMinZ && mainFrom.z <= connectorMaxZ;
      if (!crosses) {
        continue;
      }
      const index = liftMainCrossingZones.length + 1;
      liftMainCrossingZones.push({
        id: `zone-lift-main-cross-${String(index).padStart(3, '0')}`,
        type: 'intersection' as const,
        nodeIds: [],
        edgeIds: [connectorEdge.id, mainEdge.id].sort((left, right) => left.localeCompare(right)),
        noStop: true,
        noParking: true,
        capacity: 1,
        conflictGroup: `intersection-lift-main-cross-${String(index).padStart(3, '0')}`
      });
    }
  }
  const liftSideOverlapZones: LayoutZone[] = [];
  const sideUprightEdges = edges.filter((edge) =>
    edge.conflictGroup?.startsWith('left-upright') || edge.conflictGroup?.startsWith('right-upright')
  );
  for (const connectorEdge of liftConnectorEdges) {
    const connectorFrom = nodesById.get(connectorEdge.from)!;
    const connectorTo = nodesById.get(connectorEdge.to)!;
    if (connectorFrom.x !== connectorTo.x) {
      continue;
    }
    const connectorMinZ = Math.min(connectorFrom.z, connectorTo.z);
    const connectorMaxZ = Math.max(connectorFrom.z, connectorTo.z);
    for (const sideEdge of sideUprightEdges) {
      const sideFrom = nodesById.get(sideEdge.from)!;
      const sideTo = nodesById.get(sideEdge.to)!;
      if (sideFrom.x !== sideTo.x || Math.abs(sideFrom.x - connectorFrom.x) > 1e-6) {
        continue;
      }
      const sideMinZ = Math.min(sideFrom.z, sideTo.z);
      const sideMaxZ = Math.max(sideFrom.z, sideTo.z);
      const overlapM = Math.min(connectorMaxZ, sideMaxZ) - Math.max(connectorMinZ, sideMinZ);
      if (overlapM <= 1e-6) {
        continue;
      }
      const index = liftSideOverlapZones.length + 1;
      const overlapNodeIds = [
        { id: sideEdge.from, z: sideFrom.z },
        { id: sideEdge.to, z: sideTo.z }
      ]
        .filter((node) => node.z >= connectorMinZ - 1e-6 && node.z <= connectorMaxZ + 1e-6)
        .map((node) => node.id)
        .sort((left, right) => left.localeCompare(right));
      liftSideOverlapZones.push({
        id: `zone-lift-side-overlap-${String(index).padStart(3, '0')}`,
        type: 'intersection' as const,
        nodeIds: overlapNodeIds,
        edgeIds: [connectorEdge.id, sideEdge.id].sort((left, right) => left.localeCompare(right)),
        noStop: true,
        noParking: true,
        capacity: 1,
        conflictGroup: `intersection-lift-side-overlap-${String(index).padStart(3, '0')}`
      });
    }
  }

  const zones: LayoutZone[] = [
    ...liftStorageCrossingZones,
    ...liftMainCrossingZones,
    ...liftSideOverlapZones,
    ...mainXs.map((_, index) => {
      const portalNodeIds = [mainLaneNodeId('north', index), mainLaneNodeId('south', index)];
      const portalNodeIdSet = new Set(portalNodeIds);
      const portalLiftEdgeIds = edges
        .filter((edge) => portalNodeIdSet.has(edge.from) || portalNodeIdSet.has(edge.to))
        .filter((edge) => {
          const otherNodeId = portalNodeIdSet.has(edge.from) ? edge.to : edge.from;
          const otherNode = nodesById.get(otherNodeId);
          return (
            otherNode?.type === 'lift-blackbox' ||
            edge.id === `${mainLaneNodeId('north', index)}-${mainLaneNodeId('south', index)}`
          );
        })
        .map((edge) => edge.id)
        .sort((left, right) => left.localeCompare(right));
      return {
        id: `zone-main-portal-node-${String(index).padStart(2, '0')}`,
        type: 'intersection' as const,
        nodeIds: portalNodeIds,
        edgeIds: portalLiftEdgeIds,
        noStop: true,
        noParking: true,
        capacity: 1,
        conflictGroup: `intersection-main-portal-node-${String(index).padStart(2, '0')}`
      };
    })
  ];

  return { units: 'meter', calibrationProfile: profile.calibrationProfile, nodes, edges, zones };
}

export function createDefaultShuttleScenario(overrides: ShuttleScenarioOverrides = {}): ShuttleScenario {
  const layoutProfile = createShuttleLayoutProfile(overrides.layoutProfile);
  const base: ShuttleScenario = {
    schemaVersion: 'shuttle.phase0.v0',
    id: 'shuttle-phase0-balanced',
    name: 'Phase 0 Balanced Shuttle Smoke',
    seed: 20260502,
    durationSec: 7200,
    timeStepSec: 0.2,
    vehicles: {
      count: 2,
      lengthM: 1.09,
      widthM: 1.03,
      heightM: 0.16,
      emptySpeedMps: 2,
      loadedSpeedMps: 1.5,
      accelerationMps2: 1,
      switchDirectionSec: 0,
      liftTimeSec: 0.05,
      lowerTimeSec: 0.05,
      maxLoadKg: 1800,
      safetyRadiusM: 0.1,
      batteryEnabled: false,
      initialSoc: 1
    },
    layout: createDefaultLayout(layoutProfile, overrides.liftMode ?? 'balanced'),
    taskGeneration: {
      inboundRatePerHour: 18,
      outboundRatePerHour: 18,
      inboundOutboundMix: 0.5,
      arrivalDistribution: 'deterministic',
      maxTasks: 40,
      initialOutboundFullColumns: 0
    },
    physicsParams: {
      emptySpeedMps: 2,
      loadedSpeedMps: 1.5,
      accelerationMps2: 1,
      switchDirectionSec: 0,
      liftTimeSec: 0.05,
      lowerTimeSec: 0.05,
      loadedClearanceM: 0.2,
      reservationClearanceSec: 0.4
    },
    routingPolicy: {
      algorithm: 'astar',
      allowReplan: true,
      routeTimeoutSec: 12,
      maxReplansPerTask: 3
    },
    trafficPolicy: {
      controllerMode: 'reservation-v2',
      edgeCapacity: 1,
      nodeCapacity: 1,
      zoneCapacity: 1,
      liftApproachCapacity: 4,
      sourceBufferCapacity: 4,
      collisionAvoidanceEnabled: true,
      minimumClearanceSec: 0.4,
      dynamicAvoidanceClearanceM: 0.5,
      priorityAgingSec: 20,
      deadlockDetectSec: 2,
      deadlockBreakPolicy: 'oldest-waits-wins'
    }
  };

  return ShuttleScenarioSchema.parse({
    ...base,
    ...overrides,
    vehicles: { ...base.vehicles, ...overrides.vehicles },
    layout: { ...base.layout, ...overrides.layout },
    taskGeneration: { ...base.taskGeneration, ...overrides.taskGeneration },
    physicsParams: { ...base.physicsParams, ...overrides.physicsParams },
    routingPolicy: { ...base.routingPolicy, ...overrides.routingPolicy },
    trafficPolicy: { ...base.trafficPolicy, ...overrides.trafficPolicy }
  });
}

export function createInboundMvpBaselineScenario(overrides: ShuttleScenarioOverrides = {}): ShuttleScenario {
  return createDefaultShuttleScenario({
    ...overrides,
    id: overrides.id ?? 'shuttle-all-inbound-8x-7200',
    name: overrides.name ?? 'All Inbound 8 Shuttle 7200 PPH Stress',
    layoutProfile: {
      layoutKind: 'top-lift-column',
      liftPairCount: 2,
      ...overrides.layoutProfile
    },
    durationSec: overrides.durationSec ?? 7200,
    vehicles: {
      count: 8,
      emptySpeedMps: 2,
      loadedSpeedMps: 1.5,
      accelerationMps2: 1.2,
      liftTimeSec: 0.01,
      lowerTimeSec: 0.01,
      ...overrides.vehicles
    },
    physicsParams: {
      emptySpeedMps: 2,
      loadedSpeedMps: 1.5,
      accelerationMps2: 1.2,
      liftTimeSec: 0.01,
      lowerTimeSec: 0.01,
      ...overrides.physicsParams
    },
    taskGeneration: {
      inboundRatePerHour: 7200,
      outboundRatePerHour: 0,
      inboundOutboundMix: 1,
      arrivalDistribution: 'deterministic',
      maxTasks: 32,
      ...overrides.taskGeneration
    },
    trafficPolicy: {
      controllerMode: 'agent-refresh',
      liftApproachCapacity: 4,
      sourceBufferCapacity: 4,
      minimumClearanceSec: 0.4,
      dynamicAvoidanceClearanceM: 0.5,
      deadlockDetectSec: 2,
      ...overrides.trafficPolicy
    }
  });
}

export function createInboundOutboundDemoScenario(overrides: ShuttleScenarioOverrides = {}): ShuttleScenario {
  return createInboundMvpBaselineScenario({
    ...overrides,
    id: overrides.id ?? 'shuttle-inbound-outbound-demo',
    name: overrides.name ?? 'Inbound + Outbound 8 Shuttle Column Demo',
    taskGeneration: {
      inboundRatePerHour: 3600,
      outboundRatePerHour: 3600,
      inboundOutboundMix: 0.5,
      arrivalDistribution: 'deterministic',
      maxTasks: 32,
      initialOutboundFullColumns: 4,
      ...overrides.taskGeneration
    }
  });
}

export function summarizeScenarioStaticSceneContract(scenario: ShuttleScenario = createDefaultShuttleScenario()): ShuttleStaticSceneContract {
  return summarizeStaticSceneContract(scenario);
}

export type VerticalStorageFootprintEdgeViolation = {
  edgeId: string;
  cellId: string;
};

export function verticalStorageFootprintEdgeViolations(scenario: ShuttleScenario): VerticalStorageFootprintEdgeViolation[] {
  if (isTopLiftColumnLayout(scenario)) {
    return [];
  }
  const staticScene = summarizeStaticSceneContract(scenario);
  const nodesById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  const violations: VerticalStorageFootprintEdgeViolation[] = [];

  for (const edge of scenario.layout.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to || Math.abs(from.x - to.x) > 1e-6 || Math.abs(from.z - to.z) < 1e-6) {
      continue;
    }

    const edgeMinZ = Math.min(from.z, to.z);
    const edgeMaxZ = Math.max(from.z, to.z);
    const crossedCell = staticScene.storageCells.find((cell) => {
      const halfXM = cell.lengthXM / 2 - 1e-6;
      const halfZM = cell.lengthZM / 2 - 1e-6;
      return (
        from.x >= cell.xM - halfXM &&
        from.x <= cell.xM + halfXM &&
        edgeMinZ <= cell.zM + halfZM &&
        edgeMaxZ >= cell.zM - halfZM
      );
    });
    if (crossedCell) {
      violations.push({ edgeId: edge.id, cellId: crossedCell.id });
    }
  }

  return violations.sort((left, right) => left.edgeId.localeCompare(right.edgeId) || left.cellId.localeCompare(right.cellId));
}

function assertNoVerticalStorageFootprintEdges(scenario: ShuttleScenario): void {
  const violations = verticalStorageFootprintEdgeViolations(scenario);
  if (violations.length === 0) {
    return;
  }
  const first = violations[0]!;
  throw new Error(
    `Invalid storage topology: vertical edge ${first.edgeId} crosses storage-cell footprint ${first.cellId}; storage-area travel must stay horizontal.`
  );
}

class TrafficControllerV2 {
  private sequence = 0;

  constructor(private readonly scenario: ShuttleScenario) {}

  reserveMove(options: {
    vehicleId: string;
    taskId: string | null;
    fromNodeId: string;
    toNodeId: string;
    startTimeSec: number;
    travelSec: number;
    priority: number;
    existing: Reservation[];
    ignoreConflicts?: boolean;
  }): ReservationAttempt {
    const edge = this.findEdge(options.fromNodeId, options.toNodeId);
    if (!edge) {
      return { ok: false, reasonCode: 'route-edge-missing', blockingReservationId: null };
    }

    const endTimeSec = options.startTimeSec + options.travelSec + this.scenario.trafficPolicy.minimumClearanceSec;
    const conflictTokenEndTimeSec = endTimeSec;
    const matchingZones = this.zonesForMovement(options.fromNodeId, options.toNodeId, edge.id);
    const targetNodeZones = matchingZones.filter((zone) => zone.nodeIds.includes(options.toNodeId));
    const candidates: Reservation[] = [
      this.createReservation({
        resourceType: 'edge',
        resourceId: edge.id,
        conflictGroup: edge.conflictGroup ?? null,
        reasonCode: 'edge-reservation',
        vehicleId: options.vehicleId,
        taskId: options.taskId,
        startTimeSec: options.startTimeSec,
        endTimeSec,
        priority: options.priority
      }),
      this.createReservation({
        resourceType: 'node',
        resourceId: options.toNodeId,
        conflictGroup: targetNodeZones[0]?.conflictGroup ?? null,
        reasonCode: 'node-reservation',
        vehicleId: options.vehicleId,
        taskId: options.taskId,
        startTimeSec: options.startTimeSec,
        endTimeSec,
        priority: options.priority
      })
    ];

    for (const zone of matchingZones) {
      candidates.push(
        this.createReservation({
          resourceType: 'zone',
          resourceId: zone.id,
          conflictGroup: zone.conflictGroup ?? null,
          reasonCode: 'zone-reservation',
          vehicleId: options.vehicleId,
          taskId: options.taskId,
          startTimeSec: options.startTimeSec,
          endTimeSec: conflictTokenEndTimeSec,
          priority: options.priority
        })
      );
    }

    if (options.ignoreConflicts !== true) {
      for (const candidate of candidates) {
        const conflict = options.existing.find((reservation) => this.conflicts(candidate, reservation));
        if (conflict) {
          return {
            ok: false,
            reasonCode: `${candidate.resourceType}-reserved`,
            blockingReservationId: conflict.id
          };
        }
      }
    }

    return { ok: true, reservations: candidates.map((reservation) => ReservationSchema.parse(reservation)) };
  }

  findEdge(fromNodeId: string, toNodeId: string): LayoutEdge | null {
    return this.scenario.layout.edges.find((edge) => {
      if (edge.from === fromNodeId && edge.to === toNodeId) {
        return true;
      }
      return edge.directionMode === 'twoWay' && edge.from === toNodeId && edge.to === fromNodeId;
    }) ?? null;
  }

  zonesForMovement(fromNodeId: string, toNodeId: string, edgeId?: string): LayoutZone[] {
    const edge = edgeId
      ? this.scenario.layout.edges.find((candidate) => candidate.id === edgeId) ?? null
      : this.findEdge(fromNodeId, toNodeId);
    if (!edge) {
      return [];
    }

    return this.scenario.layout.zones
      .filter((zone) => {
        const crossesEdge = zone.edgeIds.includes(edge.id);
        const touchesEndpoint = zone.nodeIds.includes(fromNodeId) || zone.nodeIds.includes(toNodeId);
        const endpointAppliesToMovement = touchesEndpoint && (zone.edgeIds.length === 0 || crossesEdge);
        return crossesEdge || endpointAppliesToMovement;
      })
      .filter((zone, index, zones) => zones.findIndex((candidate) => candidate.id === zone.id) === index);
  }

  private createReservation(options: Omit<Reservation, 'id'>): Reservation {
    this.sequence += 1;
    return {
      id: `res-${String(this.sequence).padStart(6, '0')}`,
      ...options,
      startTimeSec: round(options.startTimeSec),
      endTimeSec: round(options.endTimeSec)
    };
  }

  private conflicts(candidate: Reservation, existing: Reservation): boolean {
    if (existing.vehicleId === candidate.vehicleId) {
      return false;
    }
    const sameResource = existing.resourceType === candidate.resourceType && existing.resourceId === candidate.resourceId;
    const sameConflictGroup =
      existing.conflictGroup !== null &&
      candidate.conflictGroup !== null &&
      existing.conflictGroup === candidate.conflictGroup &&
      existing.resourceType === candidate.resourceType &&
      existing.resourceType === 'zone';
    if (!sameResource && !sameConflictGroup) {
      return false;
    }

    return candidate.startTimeSec <= existing.endTimeSec + 1e-6 && existing.startTimeSec <= candidate.endTimeSec + 1e-6;
  }
}

type TheoreticalCapacitySnapshot = NonNullable<KpiSnapshot['theoreticalCapacity']>;
type TheoreticalCapacityBaseline = Omit<TheoreticalCapacitySnapshot, 'achievedInboundPct' | 'averageVehicleUtilizationPct'>;

const theoreticalCapacityBaselineCache = new Map<string, TheoreticalCapacityBaseline>();

export class ShuttleSimCore {
  private scenario: ShuttleScenario;
  private sessionId: string = randomUUID();
  private traffic!: TrafficControllerV2;
  private rng!: Rng;
  private status: RuntimeStatus = 'idle';
  private simTimeSec = 0;
  private tickIndex = 0;
  private vehicles: MutableVehicle[] = [];
  private tasks: TaskStateRecord[] = [];
  private loads: LoadStateRecord[] = [];
  private tasksById = new Map<string, TaskStateRecord>();
  private loadsById = new Map<string, LoadStateRecord>();
  private activeTaskIds = new Set<string>();
  private queuedTaskIds = new Set<string>();
  private storedLoadIdByNodeId = new Map<string, string>();
  private storedNodeIdByLoadId = new Map<string, string>();
  private layoutNodesById = new Map<string, LayoutNode>();
  private layoutNodeIds = new Set<string>();
  private storageNodeIds: string[] = [];
  private storageNodeIdSet = new Set<string>();
  private storageGridPositionCache = new Map<string, { row: number; column: number } | null>();
  private inboundSourceSlotNodeIdsCache = new Map<string, string[]>();
  private blockedStorageTransitBaseCache = new Map<string, Set<string>>();
  private reservations: Reservation[] = [];
  private currentNodeOccupancy = new Map<string, string>();
  private eventLog: EventLogEntry[] = [];
  private recentEvents: EventLogEntry[] = [];
  private eventSequence = 0;
  private taskSequence = 0;
  private sourceLoadSequence = 0;
  private nextInboundSec = 0;
  private nextOutboundSec = 0;
  private completedTaskCycleTimes: number[] = [];
  private completedTaskWaitTimes: number[] = [];
  private completedInbound = 0;
  private completedOutbound = 0;
  private completedByLiftPort = new Map<string, { kind: LiftKind; completed: number }>();
  private reservationConflictCount = 0;
  private replanCount = 0;
  private deadlockCount = 0;
  private livelockCount = 0;
  private deadlockCandidateSignature: string | null = null;
  private deadlockCandidateSinceSec: number | null = null;
  private blockedTimeByReasonSec = new Map<string, number>();
  private deferredTaskReasons: Record<'inbound' | 'outbound', string | null> = { inbound: null, outbound: null };
  private liftPortBusyTimeSec = new Map<string, number>();
  private neighborByNodeId = new Map<string, Array<{ nodeId: string; lengthM: number }>>();
  private theoreticalCapacityBaseline: TheoreticalCapacityBaseline | null = null;
  private topLiftColumnRowsPerZoneCache: number | null = null;
  private topLiftStorageColumnNumbersCache: number[] | null = null;
  private topLiftStorageColumnNodeIdsCache = new Map<number, string[]>();
  private topLiftColumnFlowModes = new Map<number, TopLiftColumnFlowMode>();
  private conflictSessions: ConflictSessionV1[] = [];
  private error: string | null = null;

  constructor(scenario: ShuttleScenario = createDefaultShuttleScenario()) {
    this.scenario = ShuttleScenarioSchema.parse(scenario);
    assertNoVerticalStorageFootprintEdges(this.scenario);
    this.reset(this.scenario.seed);
  }

  getScenario(): ShuttleScenario {
    return structuredClone(this.scenario);
  }

  setDurationSec(durationSec: number): ShuttleSimState {
    const nextDurationSec = Math.max(round(this.simTimeSec), round(durationSec));
    this.scenario = ShuttleScenarioSchema.parse({
      ...this.scenario,
      durationSec: nextDurationSec
    });
    if (this.status === 'completed' && this.simTimeSec < nextDurationSec - 1e-9) {
      this.status = 'paused';
    }
    return this.getState();
  }

  loadScenario(scenario: ShuttleScenario): ShuttleSimState {
    this.scenario = ShuttleScenarioSchema.parse(scenario);
    assertNoVerticalStorageFootprintEdges(this.scenario);
    this.theoreticalCapacityBaseline = null;
    this.topLiftColumnRowsPerZoneCache = null;
    this.topLiftStorageColumnNumbersCache = null;
    this.topLiftStorageColumnNodeIdsCache = new Map();
    this.reset(this.scenario.seed);
    this.logEvent('scenario-loaded', null, null, null, null, null, 'loadScenario', null, { scenarioId: this.scenario.id });
    return this.getState();
  }

  reset(seed = this.scenario.seed): ShuttleSimState {
    this.status = 'idle';
    this.simTimeSec = 0;
    this.tickIndex = 0;
    this.tasks = [];
    this.loads = [];
    this.tasksById = new Map();
    this.loadsById = new Map();
    this.activeTaskIds = new Set();
    this.queuedTaskIds = new Set();
    this.storedLoadIdByNodeId = new Map();
    this.storedNodeIdByLoadId = new Map();
    this.reservations = [];
    this.currentNodeOccupancy = new Map();
    this.eventLog = [];
    this.recentEvents = [];
    this.eventSequence = 0;
    this.taskSequence = 0;
    this.sourceLoadSequence = 0;
    this.completedTaskCycleTimes = [];
    this.completedTaskWaitTimes = [];
    this.completedInbound = 0;
    this.completedOutbound = 0;
    this.completedByLiftPort = new Map();
    this.reservationConflictCount = 0;
    this.replanCount = 0;
    this.deadlockCount = 0;
    this.livelockCount = 0;
    this.deadlockCandidateSignature = null;
    this.deadlockCandidateSinceSec = null;
    this.blockedTimeByReasonSec = new Map();
    this.deferredTaskReasons = { inbound: null, outbound: null };
    this.liftPortBusyTimeSec = new Map();
    this.topLiftColumnFlowModes = new Map();
    this.conflictSessions = [];
    this.error = null;
    this.rng = makeRng(seed);
    this.scenario = { ...this.scenario, seed };
    this.rebuildLayoutIndexes();
    this.traffic = new TrafficControllerV2(this.scenario);
    this.rebuildGraphNeighbors();
    this.nextInboundSec = this.scenario.taskGeneration.inboundRatePerHour > 0 ? 0 : Infinity;
    this.nextOutboundSec = this.intervalForRate(this.scenario.taskGeneration.outboundRatePerHour) / 2;

    const parkingNodes = this.parkableNodeCandidates();
    this.vehicles = Array.from({ length: this.scenario.vehicles.count }, (_, index) => {
      const parking = parkingNodes[index] ?? this.scenario.layout.nodes[0]!;
      return {
        id: `SH-${String(index + 1).padStart(2, '0')}`,
        state: 'idle',
        x: parking.x,
        y: SHUTTLE_Y_M,
        z: parking.z,
        yaw: 0,
        speedMps: 0,
        loaded: false,
        taskId: null,
        targetNodeId: null,
        currentNodeId: parking.id,
        currentEdgeId: null,
        routeNodeIds: [],
        plannedGoalNodeId: null,
        plannedRouteNodeIds: [],
        localRouteNodeIds: [],
        localRouteReason: null,
        routeIndex: 0,
        legRemainingM: 0,
        legElapsedSec: 0,
        legTravelSec: 0,
        phaseRemainingSec: 0,
        waitReason: null,
        blockingReservationId: null,
        blockingVehicleId: null,
        blockedTimeSec: 0,
        idleTimeSec: 0,
        busyTimeSec: 0,
        targetSpeedMps: 0,
        waitingSinceSec: null,
        lastMovementAxis: null,
        directionSwitchReadyNodeId: null,
        legMotionMode: 'profile',
        movingTimeSec: 0,
        handlingTimeSec: 0,
        tasklessTravelTimeSec: 0,
        yieldHoldUntilSec: null,
        yieldHoldNodeId: null
      };
    });
    for (const vehicle of this.vehicles) {
      if (!this.currentNodeOccupancy.has(vehicle.currentNodeId)) {
        this.currentNodeOccupancy.set(vehicle.currentNodeId, vehicle.id);
      }
    }

    this.logEvent('sim-reset', null, null, null, null, null, 'reset', null, { seed });
    this.primeTopLiftOutboundFullColumns();
    this.refreshTopLiftColumnFlowModes();
    this.primeInboundSourceBacklog();
    return this.getState();
  }

  start(): ShuttleSimState {
    if (this.status !== 'completed') {
      this.status = 'running';
      this.logEvent('sim-started', null, null, null, null, null, 'startRun', null, {});
    }
    return this.getState();
  }

  pause(): ShuttleSimState {
    if (this.status === 'running') {
      this.status = 'paused';
      this.logEvent('sim-paused', null, null, null, null, null, 'pause', null, {});
    }
    return this.getState();
  }

  resume(): ShuttleSimState {
    if (this.status === 'paused' || this.status === 'idle') {
      this.status = 'running';
      this.logEvent('sim-resumed', null, null, null, null, null, 'resume', null, {});
    }
    return this.getState();
  }

  setParam(path: string, value: unknown): SetParamResult {
    const previousScenario = this.scenario;
    const previousValue = getByPointer(previousScenario as unknown as Record<string, unknown>, path);
    if (
      path === COLLISION_AVOIDANCE_PARAM &&
      this.simTimeSec > 0 &&
      previousValue !== value
    ) {
      return {
        accepted: false,
        path,
        previousValue,
        value,
        reason: 'reset-required'
      };
    }
    const nextScenario = structuredClone(this.scenario) as ShuttleScenario;
    const result = setByPointer(nextScenario as unknown as Record<string, unknown>, path, value);
    if (!result.accepted) {
      return { accepted: false, path, previousValue: result.previousValue, value, reason: result.reason };
    }

    const parsed = ShuttleScenarioSchema.safeParse(nextScenario);
    if (!parsed.success) {
      return {
        accepted: false,
        path,
        previousValue: result.previousValue,
        value,
        reason: parsed.error.issues[0]?.message ?? 'Invalid scenario update'
      };
    }

    this.scenario = parsed.data;
    this.theoreticalCapacityBaseline = null;
    this.topLiftColumnRowsPerZoneCache = null;
    this.topLiftStorageColumnNumbersCache = null;
    this.topLiftStorageColumnNodeIdsCache = new Map();
    if (path.startsWith('/layout')) {
      this.rebuildLayoutIndexes();
      this.rebuildGraphNeighbors();
    }
    this.logEvent('param-updated', null, null, null, null, null, 'setParam', null, { path, value: String(value) });

    if (path === '/vehicles/count') {
      this.reset(this.scenario.seed);
    }

    return {
      accepted: true,
      path,
      previousValue: result.previousValue ?? previousValue,
      value
    };
  }

  getStatus(): ShuttleSimState['status'] {
    return this.status;
  }

  getClock(): { simTimeSec: number; tickIndex: number; status: ShuttleSimState['status'] } {
    return {
      simTimeSec: round(this.simTimeSec),
      tickIndex: this.tickIndex,
      status: this.status
    };
  }

  private stepInPlace(dtSec = this.scenario.timeStepSec): void {
    if (this.status === 'idle') {
      this.status = 'running';
    }

    if (this.status !== 'running') {
      return;
    }

    if (this.simTimeSec >= this.scenario.durationSec) {
      this.status = 'completed';
      this.logEvent('sim-completed', null, null, null, null, null, 'duration-reached', null, {});
      return;
    }

    const stepSec = Math.min(dtSec, this.scenario.durationSec - this.simTimeSec);
    this.simTimeSec = round(this.simTimeSec + stepSec);
    this.tickIndex += 1;
    this.reservations = this.reservations.filter((reservation) => reservation.endTimeSec >= this.simTimeSec - 1);

    this.replenishInboundSourceBuffers();
    this.generateDueTasks(stepSec);
    this.assignQueuedTasks(stepSec);
    this.advanceVehicles(stepSec);
    this.updateConflictSessions();
    // Keep this post-advance refill: vehicles can consume inbound source slots during the tick,
    // and moving it changes deterministic event/state hashes.
    this.replenishInboundSourceBuffers();
    this.updateLiftPortUtilization(stepSec);
    this.updateDeadlockSmokeCounters();

    if (this.simTimeSec >= this.scenario.durationSec) {
      this.status = 'completed';
      this.logEvent('sim-completed', null, null, null, null, null, 'duration-reached', null, {});
    }
  }

  step(dtSec = this.scenario.timeStepSec): ShuttleSimState {
    this.stepInPlace(dtSec);
    return this.getState();
  }

  advanceByInPlace(dtSec: number): void {
    const maxStepSec = Math.max(0.001, this.scenario.timeStepSec);
    let remainingSec = dtSec;
    while (remainingSec > 1e-9 && this.status === 'running') {
      const stepSec = Math.min(maxStepSec, remainingSec);
      this.stepInPlace(stepSec);
      remainingSec -= stepSec;
    }
  }

  advanceBy(dtSec: number): ShuttleSimState {
    this.advanceByInPlace(dtSec);
    return this.getState();
  }

  runToEnd(durationSec = this.scenario.durationSec): ShuttleSimState {
    if (durationSec !== this.scenario.durationSec) {
      this.scenario = { ...this.scenario, durationSec };
    }
    this.start();
    while (this.status === 'running') {
      this.stepInPlace(this.scenario.timeStepSec);
    }
    return this.getState();
  }

  getState(): ShuttleSimState {
    return {
      schemaVersion: 'shuttle.phase0.state.v0',
      scenarioId: this.scenario.id,
      sessionId: this.sessionId,
      status: this.status,
      simTimeSec: round(this.simTimeSec),
      durationSec: this.scenario.durationSec,
      seed: this.scenario.seed,
      vehicles: this.vehicles.map((vehicle) => this.publicVehicle(vehicle)),
      tasks: structuredClone(this.tasks),
      loads: structuredClone(this.loads),
      reservations: structuredClone(this.reservations),
      traffic: this.calculateTrafficDiagnostics(),
      kpis: this.calculateKpis(),
      recentEvents: structuredClone(this.recentEvents),
      error: this.error
    };
  }

  getEventLog(): EventLogEntry[] {
    return structuredClone(this.eventLog);
  }

  retainRecentEventLog(maxEvents: number): void {
    const retainedEvents = Math.max(0, Math.floor(maxEvents));
    if (retainedEvents === 0) {
      this.eventLog = [];
      return;
    }
    if (this.eventLog.length > retainedEvents) {
      this.eventLog = this.eventLog.slice(-retainedEvents);
    }
  }

  getDebugState(): ShuttleSimDebugState {
    return {
      currentNodeOccupancy: [...this.currentNodeOccupancy.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, vehicleId]) => ({ nodeId, vehicleId })),
      storageNodeOccupancy: [...this.storageNodeLoadOccupancy(true).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, loadId]) => ({ nodeId, loadId }))
    };
  }

  createSnapshot(): ShuttleEngineSnapshotV1 {
    const debugState = this.getDebugState();
    const snapshotWithoutHash: Omit<ShuttleEngineSnapshotV1, 'stateHash'> = {
      schemaVersion: 'shuttle.engineSnapshot.v1',
      simTimeSec: round(this.simTimeSec),
      tickIndex: this.tickIndex,
      status: this.status,
      sessionId: this.sessionId,
      rngState: this.rng.getState(),
      eventSequence: this.eventSequence,
      taskSequence: this.taskSequence,
      sourceLoadSequence: this.sourceLoadSequence,
      nextInboundSec: Number.isFinite(this.nextInboundSec) ? this.nextInboundSec : null,
      nextOutboundSec: Number.isFinite(this.nextOutboundSec) ? this.nextOutboundSec : null,
      vehicles: structuredClone(this.vehicles),
      tasks: structuredClone(this.tasks),
      loads: structuredClone(this.loads),
      reservations: structuredClone(this.reservations),
      completedTaskCycleTimes: [...this.completedTaskCycleTimes],
      completedTaskWaitTimes: [...this.completedTaskWaitTimes],
      completedInbound: this.completedInbound,
      completedOutbound: this.completedOutbound,
      completedByLiftPort: [...this.completedByLiftPort.entries()].sort(([left], [right]) => left.localeCompare(right)),
      reservationConflictCount: this.reservationConflictCount,
      replanCount: this.replanCount,
      deadlockCount: this.deadlockCount,
      livelockCount: this.livelockCount,
      deadlockCandidateSignature: this.deadlockCandidateSignature,
      deadlockCandidateSinceSec: this.deadlockCandidateSinceSec,
      blockedTimeByReasonSec: [...this.blockedTimeByReasonSec.entries()].sort(([left], [right]) => left.localeCompare(right)),
      deferredTaskReasons: { ...this.deferredTaskReasons },
      liftPortBusyTimeSec: [...this.liftPortBusyTimeSec.entries()].sort(([left], [right]) => left.localeCompare(right)),
      currentNodeOccupancy: debugState.currentNodeOccupancy,
      storageNodeOccupancy: debugState.storageNodeOccupancy,
      conflictSessions: structuredClone(this.conflictSessions),
      recentEvents: structuredClone(this.recentEvents),
      eventLog: structuredClone(this.eventLog),
      error: this.error,
      eventLogHash: hashEventLog(this.eventLog)
    };
    return {
      ...snapshotWithoutHash,
      stateHash: hashEngineSnapshot(snapshotWithoutHash)
    };
  }

  restoreSnapshot(snapshot: ShuttleEngineSnapshotV1): ShuttleSimState {
    if (snapshot.schemaVersion !== 'shuttle.engineSnapshot.v1') {
      throw new Error(`Unsupported engine snapshot schema ${String((snapshot as { schemaVersion?: unknown }).schemaVersion)}`);
    }
    const expectedHash = hashEngineSnapshot(snapshot);
    if (snapshot.stateHash && expectedHash !== snapshot.stateHash) {
      throw new Error(`Snapshot state hash mismatch: expected ${snapshot.stateHash}, got ${expectedHash}`);
    }

    this.status = snapshot.status;
    this.simTimeSec = snapshot.simTimeSec;
    this.tickIndex = snapshot.tickIndex;
    this.sessionId = snapshot.sessionId;
    this.rng.setState(snapshot.rngState);
    this.eventSequence = snapshot.eventSequence;
    this.taskSequence = snapshot.taskSequence;
    this.sourceLoadSequence = snapshot.sourceLoadSequence;
    this.nextInboundSec = snapshot.nextInboundSec ?? Infinity;
    this.nextOutboundSec = snapshot.nextOutboundSec ?? Infinity;
    this.vehicles = structuredClone(snapshot.vehicles);
    this.tasks = structuredClone(snapshot.tasks);
    this.loads = structuredClone(snapshot.loads);
    this.rebuildLayoutIndexes();
    this.rebuildTaskLoadIndexes();
    this.reservations = structuredClone(snapshot.reservations);
    this.completedTaskCycleTimes = [...snapshot.completedTaskCycleTimes];
    this.completedTaskWaitTimes = [...snapshot.completedTaskWaitTimes];
    this.completedInbound = snapshot.completedInbound;
    this.completedOutbound = snapshot.completedOutbound;
    this.completedByLiftPort = new Map(snapshot.completedByLiftPort ?? []);
    this.reservationConflictCount = snapshot.reservationConflictCount;
    this.replanCount = snapshot.replanCount;
    this.deadlockCount = snapshot.deadlockCount;
    this.livelockCount = snapshot.livelockCount;
    this.deadlockCandidateSignature = snapshot.deadlockCandidateSignature;
    this.deadlockCandidateSinceSec = snapshot.deadlockCandidateSinceSec;
    this.blockedTimeByReasonSec = new Map(snapshot.blockedTimeByReasonSec);
    this.deferredTaskReasons = { ...snapshot.deferredTaskReasons };
    this.liftPortBusyTimeSec = new Map(snapshot.liftPortBusyTimeSec);
    this.currentNodeOccupancy = new Map(snapshot.currentNodeOccupancy.map((entry) => [entry.nodeId, entry.vehicleId]));
    this.rebuildTopLiftColumnFlowModesFromState();
    this.conflictSessions = structuredClone(snapshot.conflictSessions ?? []);
    this.recentEvents = structuredClone(snapshot.recentEvents);
    this.eventLog = structuredClone(snapshot.eventLog);
    this.error = snapshot.error;
    this.traffic = new TrafficControllerV2(this.scenario);
    this.rebuildGraphNeighbors();
    return this.getState();
  }

  private rebuildLayoutIndexes(): void {
    this.layoutNodesById = new Map(this.scenario.layout.nodes.map((node) => [node.id, node]));
    this.layoutNodeIds = new Set(this.layoutNodesById.keys());
    this.storageNodeIds = this.scenario.layout.nodes
      .filter((node) => node.type === 'storage')
      .map((node) => node.id);
    this.storageNodeIdSet = new Set(this.storageNodeIds);
    this.storageGridPositionCache = new Map();
    this.inboundSourceSlotNodeIdsCache = new Map();
    this.blockedStorageTransitBaseCache = new Map();
  }

  private rebuildTaskLoadIndexes(): void {
    this.tasksById = new Map(this.tasks.map((task) => [task.id, task]));
    this.loadsById = new Map(this.loads.map((load) => [load.id, load]));
    this.storedLoadIdByNodeId = new Map();
    this.storedNodeIdByLoadId = new Map();
    this.activeTaskIds = new Set();
    this.queuedTaskIds = new Set();
    for (const task of this.tasks) {
      this.trackTaskIndexes(task);
    }
    for (const load of this.loads) {
      this.trackLoadIndexes(load);
    }
  }

  private pushTask(task: TaskStateRecord): TaskStateRecord {
    this.tasks.push(task);
    this.tasksById.set(task.id, task);
    this.trackTaskIndexes(task);
    return task;
  }

  private taskIsActive(task: TaskStateRecord): boolean {
    return task.state !== 'completed' && task.state !== 'failed';
  }

  private trackTaskIndexes(task: TaskStateRecord): void {
    if (this.taskIsActive(task)) {
      this.activeTaskIds.add(task.id);
    } else {
      this.activeTaskIds.delete(task.id);
    }

    if (task.state === 'queued') {
      this.queuedTaskIds.add(task.id);
    } else {
      this.queuedTaskIds.delete(task.id);
    }
  }

  private setTaskState(task: TaskStateRecord, state: TaskStateRecord['state']): void {
    task.state = state;
    this.trackTaskIndexes(task);
  }

  private activeTasks(): TaskStateRecord[] {
    const tasks: TaskStateRecord[] = [];
    for (const taskId of this.activeTaskIds) {
      const task = this.tasksById.get(taskId);
      if (!task || !this.taskIsActive(task)) {
        this.activeTaskIds.delete(taskId);
        this.queuedTaskIds.delete(taskId);
        continue;
      }
      tasks.push(task);
    }
    return tasks;
  }

  private queuedTasks(): TaskStateRecord[] {
    const tasks: TaskStateRecord[] = [];
    for (const taskId of this.queuedTaskIds) {
      const task = this.tasksById.get(taskId);
      if (!task || task.state !== 'queued') {
        this.queuedTaskIds.delete(taskId);
        if (task && !this.taskIsActive(task)) {
          this.activeTaskIds.delete(taskId);
        }
        continue;
      }
      tasks.push(task);
    }
    return tasks;
  }

  private pushLoad(load: LoadStateRecord): LoadStateRecord {
    this.loads.push(load);
    this.loadsById.set(load.id, load);
    this.trackLoadIndexes(load);
    return load;
  }

  private trackLoadIndexes(load: LoadStateRecord): void {
    const previousStoredNodeId = this.storedNodeIdByLoadId.get(load.id);
    if (previousStoredNodeId && (previousStoredNodeId !== load.nodeId || load.state !== 'stored')) {
      if (this.storedLoadIdByNodeId.get(previousStoredNodeId) === load.id) {
        this.storedLoadIdByNodeId.delete(previousStoredNodeId);
      }
      this.storedNodeIdByLoadId.delete(load.id);
    }
    if (load.state === 'stored' && load.nodeId && this.isStorageNode(load.nodeId)) {
      this.storedLoadIdByNodeId.set(load.nodeId, load.id);
      this.storedNodeIdByLoadId.set(load.id, load.nodeId);
    }
  }

  private setLoadPlacement(
    load: LoadStateRecord,
    state: LoadStateRecord['state'],
    nodeId: string | null,
    vehicleId: string | null
  ): void {
    load.state = state;
    load.nodeId = nodeId;
    load.vehicleId = vehicleId;
    this.trackLoadIndexes(load);
  }

  private taskById(taskId: string | null | undefined): TaskStateRecord | null {
    return taskId ? this.tasksById.get(taskId) ?? null : null;
  }

  private loadById(loadId: string | null | undefined): LoadStateRecord | null {
    return loadId ? this.loadsById.get(loadId) ?? null : null;
  }

  setVehicleRouteForTest(vehicleId: string, routeNodeIds: string[]): ShuttleSimState {
    const vehicle = this.vehicles.find((candidate) => candidate.id === vehicleId);
    if (!vehicle) {
      throw new Error(`Unknown vehicle ${vehicleId}`);
    }
    if (routeNodeIds.length < 1) {
      throw new Error('Test route must include at least one node');
    }
    for (const nodeId of routeNodeIds) {
      nodePosition(this.scenario, nodeId);
    }
    for (const [nodeId, occupantId] of [...this.currentNodeOccupancy.entries()]) {
      if (occupantId === vehicle.id) {
        this.currentNodeOccupancy.delete(nodeId);
        this.releaseZoneHoldReservations(vehicle);
      }
    }
    const startPosition = nodePosition(this.scenario, routeNodeIds[0]!);
    vehicle.x = startPosition.x;
    vehicle.y = SHUTTLE_Y_M;
    vehicle.z = startPosition.z;
    vehicle.yaw = 0;
    vehicle.speedMps = 0;
    vehicle.loaded = false;
    vehicle.taskId = null;
    vehicle.currentNodeId = routeNodeIds[0]!;
    vehicle.currentEdgeId = null;
    vehicle.routeNodeIds = [...routeNodeIds];
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = routeNodeIds[1] ?? null;
    vehicle.legRemainingM = 0;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = 0;
    vehicle.phaseRemainingSec = 0;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.targetSpeedMps = 0;
    vehicle.lastMovementAxis = null;
    vehicle.directionSwitchReadyNodeId = null;
    vehicle.legMotionMode = 'profile';
    vehicle.movingTimeSec = 0;
    vehicle.handlingTimeSec = 0;
    vehicle.tasklessTravelTimeSec = 0;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    vehicle.state = routeNodeIds.length > 1 ? 'assigned' : 'idle';
    this.currentNodeOccupancy.set(vehicle.currentNodeId, vehicle.id);
    this.ensureZoneHoldReservation(vehicle, vehicle.currentNodeId);
    return this.getState();
  }

  addReservationForTest(reservation: Omit<Reservation, 'id'> & { id?: string }): ShuttleSimState {
    const id = reservation.id ?? `test-res-${String(this.reservations.length + 1).padStart(4, '0')}`;
    this.reservations.push(ReservationSchema.parse({ ...reservation, id }));
    return this.getState();
  }

  installMoveReservationsForTest(vehicleId: string, reservations: Reservation[]): MoveReservationInstall {
    const vehicle = this.vehicles.find((candidate) => candidate.id === vehicleId);
    if (!vehicle) {
      throw new Error(`Unknown vehicle ${vehicleId}`);
    }
    const install = this.installMoveReservationsReplacingSelfOverlap(vehicle, reservations);
    return structuredClone(install);
  }

  rollbackMoveReservationsForTest(install: MoveReservationInstall): ShuttleSimState {
    this.rollbackMoveReservationInstall(install.installed, install.removed);
    return this.getState();
  }

  setVehicleWaitingForTest(vehicleId: string, options: {
    targetNodeId: string | null;
    waitReason: string;
    blockingVehicleId?: string | null;
    blockingReservationId?: string | null;
    waitingSinceSec?: number;
  }): ShuttleSimState {
    const vehicle = this.vehicles.find((candidate) => candidate.id === vehicleId);
    if (!vehicle) {
      throw new Error(`Unknown vehicle ${vehicleId}`);
    }
    vehicle.state = 'waiting-blocked';
    vehicle.targetNodeId = options.targetNodeId;
    vehicle.waitReason = options.waitReason;
    vehicle.blockingVehicleId = options.blockingVehicleId ?? null;
    vehicle.blockingReservationId = options.blockingReservationId ?? null;
    vehicle.waitingSinceSec = options.waitingSinceSec ?? this.simTimeSec;
    return this.getState();
  }

  addLoadForTest(load: LoadStateRecord): ShuttleSimState {
    this.pushLoad(LoadStateRecordSchema.parse(load));
    return this.getState();
  }

  addTaskForTest(task: TaskStateRecord): ShuttleSimState {
    this.pushTask(TaskStateRecordSchema.parse(task));
    return this.getState();
  }

  setVehicleTaskForTest(vehicleId: string, taskId: string | null, loaded: boolean): ShuttleSimState {
    const vehicle = this.vehicles.find((candidate) => candidate.id === vehicleId);
    if (!vehicle) {
      throw new Error(`Unknown vehicle ${vehicleId}`);
    }
    vehicle.taskId = taskId;
    vehicle.loaded = loaded;
    vehicle.state = taskId ? 'assigned' : vehicle.routeNodeIds.length > 1 ? 'assigned' : 'idle';
    return this.getState();
  }

  private intervalForRate(ratePerHour: number): number {
    if (ratePerHour <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return 3600 / ratePerHour;
  }

  private generateDueTasks(dtSec: number): void {
    if (this.activeTaskCount() >= this.scenario.taskGeneration.maxTasks) {
      return;
    }

    while (this.simTimeSec >= this.nextInboundSec && this.activeTaskCount() < this.scenario.taskGeneration.maxTasks) {
      const result = this.createTask('inbound');
      if (!result.created) {
        this.deferTask('inbound', result.reason, dtSec);
        this.nextInboundSec = this.simTimeSec + this.scenario.timeStepSec;
        break;
      }
      this.deferredTaskReasons.inbound = null;
      this.nextInboundSec += this.nextArrivalInterval('inbound');
    }

    while (this.simTimeSec >= this.nextOutboundSec && this.activeTaskCount() < this.scenario.taskGeneration.maxTasks) {
      const result = this.createTask('outbound');
      if (!result.created) {
        this.deferTask('outbound', result.reason, dtSec);
        this.nextOutboundSec = this.simTimeSec + this.scenario.timeStepSec;
        break;
      }
      this.deferredTaskReasons.outbound = null;
      this.nextOutboundSec += this.nextArrivalInterval('outbound');
    }
  }

  private activeTaskCount(): number {
    return this.activeTasks().length;
  }

  private nextArrivalInterval(kind: 'inbound' | 'outbound'): number {
    const rate = kind === 'inbound' ? this.scenario.taskGeneration.inboundRatePerHour : this.scenario.taskGeneration.outboundRatePerHour;
    const deterministic = this.intervalForRate(rate);
    if (this.scenario.taskGeneration.arrivalDistribution === 'deterministic') {
      return deterministic;
    }
    const u = Math.max(1e-9, 1 - this.rng.next());
    return -Math.log(u) * deterministic;
  }

  private createTask(kind: 'inbound' | 'outbound'): { created: true } | { created: false; reason: string } {
    this.refreshTopLiftColumnFlowModes();
    const topLiftInboundSelection = kind === 'inbound' && this.topLiftColumnLayoutEnabled()
      ? this.selectTopLiftInboundTaskSelection()
      : null;
    const topLiftOutboundSelection = kind === 'outbound' && this.topLiftColumnLayoutEnabled()
      ? this.selectTopLiftOutboundTaskSelection()
      : null;
    if (topLiftInboundSelection && 'reason' in topLiftInboundSelection) {
      return { created: false, reason: topLiftInboundSelection.reason };
    }
    if (topLiftOutboundSelection && 'reason' in topLiftOutboundSelection) {
      return { created: false, reason: topLiftOutboundSelection.reason };
    }
    const storageSelection = topLiftInboundSelection ?? topLiftOutboundSelection ?? (kind === 'inbound' ? this.selectInboundStorageNode() : this.selectOutboundLoad());
    if (!storageSelection) {
      return { created: false, reason: kind === 'inbound' ? 'storage-full' : 'storage-empty' };
    }

    const inboundSourceSelection = kind === 'inbound'
      ? topLiftInboundSelection
        ? { liftNodeId: topLiftInboundSelection.liftNodeId, loadId: topLiftInboundSelection.loadId }
        : this.selectInboundSourceLoadForTask(storageSelection.nodeId)
      : null;
    const liftNodeId = kind === 'inbound'
      ? inboundSourceSelection?.liftNodeId ?? null
      : topLiftOutboundSelection && 'liftNodeId' in topLiftOutboundSelection
        ? topLiftOutboundSelection.liftNodeId
        : this.selectLiftPortNodeId(kind, storageSelection.nodeId);
    if (!liftNodeId) {
      return { created: false, reason: kind === 'inbound' ? this.inboundSourceUnavailableReason() : 'outbound-lift-unavailable' };
    }

    this.taskSequence += 1;
    const taskId = `task-${String(this.taskSequence).padStart(4, '0')}`;
    const loadId = kind === 'inbound' ? inboundSourceSelection!.loadId : storageSelection.loadId;
    const pickupNodeId = kind === 'inbound' ? this.inboundSourcePickupNodeId(liftNodeId) : storageSelection.nodeId;
    const dropoffNodeId = kind === 'inbound' ? storageSelection.nodeId : this.outboundSinkDropoffNodeId(liftNodeId);
    const task: TaskStateRecord = {
      id: taskId,
      kind,
      state: 'queued',
      createdAtSec: this.simTimeSec,
      assignedAtSec: null,
      startedAtSec: null,
      completedAtSec: null,
      pickupNodeId,
      dropoffNodeId,
      loadId,
      vehicleId: null,
      replanCount: 0,
      waitReason: null
    };
    this.pushTask(task);
    this.logEvent('task-created', null, task.id, loadId, null, pickupNodeId, 'task-generation', nodePosition(this.scenario, pickupNodeId), {
      kind,
      fifoNodeId: storageSelection.nodeId
    });
    return { created: true };
  }

  private selectTopLiftInboundTaskSelection(): { nodeId: string; liftNodeId: string; loadId: string } | { reason: string } {
    for (const liftNode of this.inboundLiftNodes()) {
      this.compactInboundSourceBuffer(liftNode.id);
    }

    const assignedLoadIds = this.activeInboundSourceLoadIds();
    const sourceCandidates = this.inboundLiftNodes()
      .flatMap((liftNode) => {
        return this.inboundLiftWaitingSourceLoads(liftNode.id)
          .filter((sourceLoad) => !assignedLoadIds.has(sourceLoad.id))
          .sort((left, right) => this.inboundSourceSlotRank(liftNode.id, right.nodeId) - this.inboundSourceSlotRank(liftNode.id, left.nodeId))
          .map((sourceLoad, sourceIndex) => ({
            liftNodeId: liftNode.id,
            loadId: sourceLoad.id,
            plannedLoad: this.liftPortPlannedLoad('inbound', liftNode.id),
            sourceIndex
          }));
      })
      .sort((left, right) =>
        left.plannedLoad - right.plannedLoad ||
        left.sourceIndex - right.sourceIndex ||
        left.liftNodeId.localeCompare(right.liftNodeId)
      );

    if (sourceCandidates.length === 0) {
      return { reason: this.inboundSourceUnavailableReason() };
    }

    for (const source of sourceCandidates) {
      const nodeId = this.selectTopLiftInboundStorageNodeForLift(source.liftNodeId);
      if (nodeId) {
        return { nodeId, liftNodeId: source.liftNodeId, loadId: source.loadId };
      }
    }

    return { reason: 'storage-full' };
  }

  private selectLiftPortNodeId(kind: 'inbound' | 'outbound', relatedNodeId: string): string | null {
    const fallbackNodeId = this.scenario.layout.nodes.find((node) => node.type === kind)?.id ?? relatedNodeId;
    const relatedNode = this.scenario.layout.nodes.find((node) => node.id === relatedNodeId);
    const liftNodes = this.scenario.layout.nodes
      .filter((node) => liftKindForNode(node) === kind)
      .filter((node) => kind !== 'inbound' || !this.inboundLiftHasWaitingSourceLoad(node.id))
      .filter((node) => !this.topLiftColumnLayoutEnabled() || this.liftPortPlannedLoad(kind, node.id) < this.topLiftPortStagedTaskCapacity(kind, node.id))
      .sort((left, right) => {
        const leftPlannedLoad = this.liftPortPlannedLoad(kind, left.id);
        const rightPlannedLoad = this.liftPortPlannedLoad(kind, right.id);
        if (leftPlannedLoad !== rightPlannedLoad) {
          return leftPlannedLoad - rightPlannedLoad;
        }
        const leftDistance = relatedNode ? Math.abs(left.z - relatedNode.z) + Math.abs(left.x - relatedNode.x) : 0;
        const rightDistance = relatedNode ? Math.abs(right.z - relatedNode.z) + Math.abs(right.x - relatedNode.x) : 0;
        return leftDistance - rightDistance || left.id.localeCompare(right.id);
      });
    if (liftNodes.length > 0) {
      return liftNodes[0]!.id;
    }
    return kind === 'inbound' ? null : fallbackNodeId;
  }

  private replenishInboundSourceBuffers(): void {
    if (this.scenario.taskGeneration.inboundRatePerHour <= 0) {
      return;
    }

    for (const liftNode of this.inboundLiftNodes()) {
      this.compactInboundSourceBuffer(liftNode.id);
      const capacity = this.inboundSourceBufferCapacity(liftNode.id);
      while (this.inboundLiftWaitingSourceLoads(liftNode.id).length < capacity) {
        const slotNodeId = this.nextInboundSourceSlotNodeId(liftNode.id);
        this.sourceLoadSequence += 1;
        const load: LoadStateRecord = {
          id: `source-load-${String(this.sourceLoadSequence).padStart(5, '0')}`,
          state: 'waiting',
          nodeId: slotNodeId,
          vehicleId: null,
          weightKg: 450 + Math.round(this.rng.next() * 350)
        };
        this.pushLoad(load);
        this.logEvent('source-load-replenished', null, null, load.id, null, liftNode.id, 'inbound-source-buffer-refill', nodePosition(this.scenario, slotNodeId), {
          sourceSlotNodeId: slotNodeId,
          sourceBufferOccupancy: this.inboundLiftWaitingSourceLoads(liftNode.id).length,
          sourceBufferCapacity: capacity
        });
        this.compactInboundSourceBuffer(liftNode.id);
      }
    }
  }

  private selectInboundSourceLoadForTask(relatedNodeId: string): { liftNodeId: string; loadId: string } | null {
    for (const liftNode of this.inboundLiftNodes()) {
      this.compactInboundSourceBuffer(liftNode.id);
    }
    const assignedLoadIds = this.activeInboundSourceLoadIds();
    const relatedNode = this.scenario.layout.nodes.find((node) => node.id === relatedNodeId);
    const candidates = this.inboundLiftNodes()
      .flatMap((liftNode) => {
        const pickupNodeId = this.inboundSourcePickupNodeId(liftNode.id);
        const sourceLoads = this.inboundLiftWaitingSourceLoads(liftNode.id)
          .filter((sourceLoad) => sourceLoad.nodeId === pickupNodeId && !assignedLoadIds.has(sourceLoad.id));
        return sourceLoads.map((sourceLoad, sourceIndex) => ({
              liftNodeId: liftNode.id,
              loadId: sourceLoad.id,
              plannedLoad: this.liftPortPlannedLoad('inbound', liftNode.id),
              sourceIndex,
              distanceM: relatedNode ? Math.abs(liftNode.z - relatedNode.z) + Math.abs(liftNode.x - relatedNode.x) : 0
            }));
      })
      .sort((left, right) =>
        left.plannedLoad - right.plannedLoad ||
        left.sourceIndex - right.sourceIndex ||
        left.distanceM - right.distanceM ||
        left.liftNodeId.localeCompare(right.liftNodeId)
      );
    return candidates[0] ? { liftNodeId: candidates[0].liftNodeId, loadId: candidates[0].loadId } : null;
  }

  private activeInboundSourceLoadIds(): Set<string> {
    return new Set(
      this.activeTasks()
        .filter((task) => task.kind === 'inbound')
        .map((task) => task.loadId)
    );
  }

  private compactInboundSourceBuffer(liftNodeId: string): void {
    if (!this.topLiftColumnLayoutEnabled()) {
      return;
    }
    const slotNodeIds = this.inboundSourceSlotNodeIds(liftNodeId);
    if (slotNodeIds.length < 2) {
      return;
    }
    const slotOrder = new Map(slotNodeIds.map((nodeId, index) => [nodeId, index]));
    const targetSlotsFrontFirst = [...slotNodeIds].reverse();
    const waitingLoadsFrontFirst = this.loads
      .filter((load) =>
        load.state === 'waiting' &&
        load.nodeId !== null &&
        slotOrder.has(load.nodeId) &&
        load.vehicleId === null
      )
      .sort((left, right) =>
        (slotOrder.get(right.nodeId!) ?? Number.MIN_SAFE_INTEGER) - (slotOrder.get(left.nodeId!) ?? Number.MIN_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      );
    for (let index = 0; index < waitingLoadsFrontFirst.length && index < targetSlotsFrontFirst.length; index += 1) {
      waitingLoadsFrontFirst[index]!.nodeId = targetSlotsFrontFirst[index]!;
    }
  }

  private inboundSourceSlotRank(liftNodeId: string, nodeId: string | null): number {
    if (!nodeId) {
      return -1;
    }
    return this.inboundSourceSlotNodeIds(liftNodeId).indexOf(nodeId);
  }

  private inboundLiftWaitingSourceLoads(liftNodeId: string): LoadStateRecord[] {
    const slotNodeIds = this.inboundSourceSlotNodeIds(liftNodeId);
    const slotOrder = new Map(slotNodeIds.map((nodeId, index) => [nodeId, index]));
    return this.loads
      .filter((load) => load.state === 'waiting' && load.nodeId !== null && slotOrder.has(load.nodeId) && load.vehicleId === null)
      .sort((left, right) =>
        (slotOrder.get(left.nodeId!) ?? Number.MAX_SAFE_INTEGER) - (slotOrder.get(right.nodeId!) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      );
  }

  private inboundLiftWaitingSourceLoad(liftNodeId: string): LoadStateRecord | null {
    return this.inboundLiftWaitingSourceLoads(liftNodeId)[0] ?? null;
  }

  private inboundSourceSlotNodeIds(liftNodeId: string): string[] {
    if (!this.topLiftColumnLayoutEnabled()) {
      return [liftNodeId];
    }
    const cached = this.inboundSourceSlotNodeIdsCache.get(liftNodeId);
    if (cached) {
      return cached;
    }
    const bufferNodeIds = Array.from({ length: Math.max(0, this.scenario.trafficPolicy.sourceBufferCapacity - 1) }, (_, index) =>
      liftBufferNodeId(liftNodeId, index + 1)
    ).filter((nodeId) => this.layoutNodeIds.has(nodeId));
    const slotNodeIds = [liftNodeId, ...bufferNodeIds];
    this.inboundSourceSlotNodeIdsCache.set(liftNodeId, slotNodeIds);
    return slotNodeIds;
  }

  private inboundSourcePickupNodeId(liftNodeId: string): string {
    if (!this.topLiftColumnLayoutEnabled()) {
      return liftNodeId;
    }
    return this.inboundSourceSlotNodeIds(liftNodeId).at(-1) ?? liftNodeId;
  }

  private liftBufferNodeIds(liftNodeId: string): string[] {
    return this.scenario.layout.nodes
      .map((node) => ({ nodeId: node.id, parent: liftBufferParentNodeId(node.id) }))
      .filter((entry): entry is { nodeId: string; parent: { liftNodeId: string; kind: LiftKind; slotIndex: number } } =>
        entry.parent?.liftNodeId === liftNodeId
      )
      .sort((left, right) => left.parent.slotIndex - right.parent.slotIndex)
      .map((entry) => entry.nodeId);
  }

  private outboundSinkDropoffNodeId(liftNodeId: string): string {
    if (!this.topLiftColumnLayoutEnabled()) {
      return liftNodeId;
    }
    return this.liftBufferNodeIds(liftNodeId).at(-1) ?? liftNodeId;
  }

  private inboundSourceLoadBelongsToLift(load: LoadStateRecord | null | undefined, liftNodeId: string): boolean {
    return Boolean(
      load &&
      load.state === 'waiting' &&
      load.nodeId !== null &&
      this.inboundSourceSlotNodeIds(liftNodeId).includes(load.nodeId)
    );
  }

  private inboundTaskLoadReadyAtPickup(task: TaskStateRecord): boolean {
    if (task.kind !== 'inbound' || !this.topLiftColumnLayoutEnabled()) {
      return true;
    }
    const bufferParent = liftBufferParentNodeId(task.pickupNodeId);
    if (!bufferParent || bufferParent.kind !== 'inbound') {
      return true;
    }
    this.compactInboundSourceBuffer(bufferParent.liftNodeId);
    const load = this.loadById(task.loadId);
    return Boolean(load && load.state === 'waiting' && load.nodeId === task.pickupNodeId && load.vehicleId === null);
  }

  private topLiftInboundQueueNodeIdForTask(task: TaskStateRecord): string | null {
    if (task.kind !== 'inbound' || !this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return null;
    }
    const earlierUnreleasedCount = this.activeTasks().filter((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'inbound' &&
      this.taskLiftPortNodeId(candidate) === liftNodeId &&
      this.inboundTaskPrecedes(candidate, task) &&
      !this.inboundTaskPickupReleased(candidate)
    ).length;
    const queueSlotIndex = Math.min(3, Math.max(
      earlierUnreleasedCount <= 0 ? 1 : earlierUnreleasedCount + 1,
      this.topLiftMaxOccupiedEarlierQueueSlot(liftNodeId, task, 'inbound') + 1
    ));
    const queueNodeId = liftQueueNodeId(liftNodeId, queueSlotIndex);
    return this.layoutNode(queueNodeId) ? queueNodeId : null;
  }

  private inboundTaskPickupReleased(task: TaskStateRecord): boolean {
    if (task.kind !== 'inbound' || task.state === 'completed' || task.state === 'failed') {
      return true;
    }
    if (task.startedAtSec !== null || task.state === 'in-progress') {
      return true;
    }
    const vehicle = task.vehicleId ? this.vehicles.find((candidate) => candidate.id === task.vehicleId) : null;
    if (vehicle?.loaded) {
      return true;
    }
    const load = this.loadById(task.loadId);
    return Boolean(load && load.state !== 'waiting');
  }

  private taskPrecedes(left: TaskStateRecord, right: TaskStateRecord): boolean {
    return left.createdAtSec < right.createdAtSec ||
      (left.createdAtSec === right.createdAtSec && left.id.localeCompare(right.id) < 0);
  }

  private inboundTaskPrecedes(left: TaskStateRecord, right: TaskStateRecord): boolean {
    return this.taskPrecedes(left, right);
  }

  private inboundTaskHasEarlierPickupTask(task: TaskStateRecord): boolean {
    if (task.kind !== 'inbound' || !this.topLiftColumnLayoutEnabled() || task.startedAtSec !== null) {
      return false;
    }
    if (this.topLiftInboundColumnPredecessorPending(task)) {
      return true;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return false;
    }
    return this.activeTasks().some((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'inbound' &&
      this.taskLiftPortNodeId(candidate) === liftNodeId &&
      this.inboundTaskPrecedes(candidate, task) &&
      !this.inboundTaskPickupReleased(candidate)
    );
  }

  private inboundStickyQueueGoalNodeId(task: TaskStateRecord, vehicle?: MutableVehicle | VehicleState | null): string | null {
    if (task.kind !== 'inbound' || vehicle?.loaded || !vehicle?.plannedGoalNodeId || vehicle.currentNodeId === vehicle.plannedGoalNodeId) {
      return null;
    }
    const plannedQueueSlot = topLiftQueueParkingSlot(vehicle.plannedGoalNodeId);
    if (!plannedQueueSlot) {
      return null;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (plannedQueueSlot.liftNodeId !== liftNodeId) {
      return null;
    }
    const alreadyInsideQueue = [vehicle.currentNodeId].some((nodeId) =>
      topLiftQueueParkingSlot(nodeId)?.liftNodeId === liftNodeId ||
      topLiftQueueAisleAccess(nodeId)?.liftNodeId === liftNodeId
    );
    if (alreadyInsideQueue) {
      return vehicle.plannedGoalNodeId;
    }
    return this.inboundTaskHasEarlierPickupTask(task) ? vehicle.plannedGoalNodeId : null;
  }

  private inboundPickupDispatchGoalNodeId(task: TaskStateRecord, vehicle?: MutableVehicle | VehicleState | null): string {
    const stickyQueueGoalNodeId = this.inboundStickyQueueGoalNodeId(task, vehicle);
    if (stickyQueueGoalNodeId) {
      return stickyQueueGoalNodeId;
    }
    if (!this.inboundTaskHasEarlierPickupTask(task)) {
      return task.pickupNodeId;
    }
    return this.topLiftInboundQueueNodeIdForTask(task) ?? task.pickupNodeId;
  }

  private topLiftOutboundQueueNodeIdForTask(task: TaskStateRecord): string | null {
    if (task.kind !== 'outbound' || !this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return null;
    }
    const earlierUnreleasedCount = this.activeTasks().filter((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'outbound' &&
      this.taskLiftPortNodeId(candidate) === liftNodeId &&
      this.taskPrecedes(candidate, task) &&
      !this.outboundTaskDropoffReleased(candidate)
    ).length;
    const queueSlotIndex = Math.min(3, Math.max(
      earlierUnreleasedCount <= 0 ? 1 : earlierUnreleasedCount + 1,
      this.topLiftMaxOccupiedEarlierQueueSlot(liftNodeId, task, 'outbound') + 1
    ));
    const queueNodeId = liftQueueTailEntryNodeId(liftNodeId, queueSlotIndex);
    return this.layoutNode(queueNodeId) ? queueNodeId : null;
  }

  private outboundTaskDropoffReleased(task: TaskStateRecord): boolean {
    return task.kind !== 'outbound' || task.state === 'completed' || task.state === 'failed';
  }

  private topLiftMaxOccupiedEarlierQueueSlot(liftNodeId: string, task: TaskStateRecord, kind: 'inbound' | 'outbound'): number {
    let maxSlotIndex = 0;
    for (const candidate of this.activeTasks()) {
      if (
        candidate.id === task.id ||
        candidate.kind !== kind ||
        this.taskLiftPortNodeId(candidate) !== liftNodeId ||
        !this.taskPrecedes(candidate, task)
      ) {
        continue;
      }
      const vehicle = candidate.vehicleId
        ? this.vehicles.find((entry) => entry.id === candidate.vehicleId) ?? null
        : null;
      for (const nodeId of [vehicle?.currentNodeId, vehicle?.targetNodeId, vehicle?.plannedGoalNodeId]) {
        const slot = nodeId ? topLiftQueueParkingSlot(nodeId) ?? topLiftQueueEntrySlot(nodeId) : null;
        if (slot?.liftNodeId === liftNodeId) {
          maxSlotIndex = Math.max(maxSlotIndex, slot.slotIndex);
        }
      }
    }
    return maxSlotIndex;
  }

  private outboundTaskHasEarlierDropoffTask(task: TaskStateRecord): boolean {
    if (task.kind !== 'outbound' || !this.topLiftColumnLayoutEnabled() || task.completedAtSec !== null) {
      return false;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return false;
    }
    return this.activeTasks().some((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'outbound' &&
      this.taskLiftPortNodeId(candidate) === liftNodeId &&
      this.taskPrecedes(candidate, task) &&
      !this.outboundTaskDropoffReleased(candidate)
    );
  }

  private outboundStickyQueueGoalNodeId(task: TaskStateRecord, vehicle?: MutableVehicle | VehicleState | null): string | null {
    if (
      task.kind !== 'outbound' ||
      !this.topLiftColumnLayoutEnabled() ||
      !vehicle?.loaded ||
      !vehicle.plannedGoalNodeId
    ) {
      return null;
    }
    const plannedQueueSlot = topLiftQueueEntrySlot(vehicle.plannedGoalNodeId) ?? topLiftQueueParkingSlot(vehicle.plannedGoalNodeId);
    if (!plannedQueueSlot) {
      return null;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (plannedQueueSlot.liftNodeId !== liftNodeId) {
      return null;
    }
    const alreadyInsideQueue = [vehicle.currentNodeId].some((nodeId) =>
      topLiftQueueEntrySlot(nodeId)?.liftNodeId === liftNodeId ||
      topLiftQueueParkingSlot(nodeId)?.liftNodeId === liftNodeId ||
      topLiftQueueAisleAccess(nodeId)?.liftNodeId === liftNodeId
    );
    if (!alreadyInsideQueue && !this.outboundQueueNodeAvailableForVehicle(vehicle.plannedGoalNodeId, vehicle)) {
      return null;
    }
    if (alreadyInsideQueue && vehicle.currentNodeId !== vehicle.plannedGoalNodeId) {
      return vehicle.plannedGoalNodeId;
    }
    return this.outboundTaskHasEarlierDropoffTask(task) ? vehicle.plannedGoalNodeId : null;
  }

  private outboundDropoffDispatchGoalNodeId(task: TaskStateRecord, vehicle?: MutableVehicle | VehicleState | null): string {
    if (vehicle?.loaded && this.topLiftColumnLayoutEnabled()) {
      return task.dropoffNodeId;
    }
    if (this.outboundLoadedVehicleAlreadyInServiceLane(task, vehicle)) {
      return task.dropoffNodeId;
    }
    const stickyQueueGoalNodeId = this.outboundStickyQueueGoalNodeId(task, vehicle);
    if (stickyQueueGoalNodeId) {
      return stickyQueueGoalNodeId;
    }
    if (!this.outboundTaskHasEarlierDropoffTask(task)) {
      return task.dropoffNodeId;
    }
    const queueNodeId = this.topLiftOutboundQueueNodeIdForTask(task);
    return queueNodeId && this.outboundQueueNodeAvailableForVehicle(queueNodeId, vehicle)
      ? queueNodeId
      : task.dropoffNodeId;
  }

  private outboundQueueNodeAvailableForVehicle(queueNodeId: string, vehicle?: MutableVehicle | VehicleState | null): boolean {
    const occupantId = this.currentNodeOccupancy.get(queueNodeId);
    if (occupantId && occupantId !== vehicle?.id) {
      return false;
    }
    return !this.nodeClaimedByOtherVehicle(queueNodeId, vehicle?.id ?? '');
  }

  private outboundLoadedVehicleAlreadyInServiceLane(task: TaskStateRecord, vehicle?: MutableVehicle | VehicleState | null): boolean {
    if (task.kind !== 'outbound' || !vehicle?.loaded || !this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return false;
    }
    const currentBuffer = liftBufferParentNodeId(vehicle.currentNodeId);
    if (currentBuffer?.liftNodeId === liftNodeId) {
      return true;
    }
    const currentBufferAccessLiftNodeId = /^(lift-\d{2}-outbound)-buffer-access$/.exec(vehicle.currentNodeId)?.[1] ?? null;
    if (currentBufferAccessLiftNodeId === liftNodeId) {
      return true;
    }
    const currentServiceLiftNodeId = /^(lift-\d{2}-outbound)-queue-\d{2}-service-exit$/.exec(vehicle.currentNodeId)?.[1] ?? null;
    return currentServiceLiftNodeId === liftNodeId;
  }

  private taskDispatchGoalNodeId(task: TaskStateRecord, vehicle?: MutableVehicle | VehicleState | null): string {
    if (task.kind === 'inbound' && !vehicle?.loaded) {
      return this.inboundPickupDispatchGoalNodeId(task, vehicle);
    }
    if (task.kind === 'outbound' && vehicle?.loaded) {
      return this.outboundDropoffDispatchGoalNodeId(task, vehicle);
    }
    return vehicle?.loaded ? task.dropoffNodeId : task.pickupNodeId;
  }

  private inboundPickupClearanceRouteActive(vehicle: MutableVehicle, task: TaskStateRecord): boolean {
    const queueNodeId = this.topLiftInboundQueueNodeIdForTask(task);
    return task.kind === 'inbound' &&
      queueNodeId !== null &&
      this.inboundTaskHasEarlierPickupTask(task) &&
      vehicle.routeNodeIds[vehicle.routeIndex] === vehicle.currentNodeId &&
      vehicle.routeNodeIds.at(-1) === queueNodeId &&
      vehicle.routeNodeIds[vehicle.routeIndex + 1] !== undefined;
  }

  private rerouteInboundPickupVehicleBehindEarlierTask(vehicle: MutableVehicle, task: TaskStateRecord): boolean {
    if (
      task.kind !== 'inbound' ||
      vehicle.currentNodeId !== task.pickupNodeId ||
      !this.inboundTaskHasEarlierPickupTask(task)
    ) {
      return false;
    }
    const queueNodeId = this.topLiftInboundQueueNodeIdForTask(task);
    if (!queueNodeId || queueNodeId === vehicle.currentNodeId) {
      return false;
    }
    const route = this.shortestPath(vehicle.currentNodeId, queueNodeId);
    const nextNodeId = route[1] ?? null;
    if (!nextNodeId) {
      return false;
    }
    const block = this.collisionAvoidanceEnabled()
      ? this.agentRefreshEnabled()
        ? this.agentRefreshMoveBlocker(vehicle, nextNodeId, route)
        : this.agentMinimalEnabled()
          ? this.agentMinimalMoveBlocker(vehicle, nextNodeId)
          : this.agentMoveBlocker(vehicle, nextNodeId)
      : null;
    if (block) {
      return false;
    }
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = nextNodeId;
    vehicle.state = vehicle.taskId ? 'assigned' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.plannedGoalNodeId = queueNodeId;
    vehicle.plannedRouteNodeIds = route;
    vehicle.localRouteNodeIds = [];
    vehicle.localRouteReason = null;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    this.logAgentReroute(vehicle, task, task.pickupNodeId, route, 'inbound-pickup-clears-earlier-load', { countTaskReplan: false });
    return true;
  }

  private waitForInboundPickupLoad(vehicle: MutableVehicle, task: TaskStateRecord, dtSec: number): void {
    vehicle.state = 'waiting-blocked';
    vehicle.speedMps = 0;
    vehicle.waitReason = 'inbound-source-not-at-pickup';
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec ??= this.simTimeSec;
    vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
    this.blockedTimeByReasonSec.set('inbound-source-not-at-pickup', round((this.blockedTimeByReasonSec.get('inbound-source-not-at-pickup') ?? 0) + dtSec));
    this.logEvent('vehicle-waiting', vehicle.id, task.id, task.loadId, vehicle.currentNodeId, task.pickupNodeId, 'inbound-source-not-at-pickup', this.vehiclePosition(vehicle), {});
  }

  private nextInboundSourceSlotNodeId(liftNodeId: string): string {
    const occupiedSlotNodeIds = new Set(
      this.inboundLiftWaitingSourceLoads(liftNodeId)
        .map((load) => load.nodeId)
        .filter((nodeId): nodeId is string => nodeId !== null)
    );
    return this.inboundSourceSlotNodeIds(liftNodeId).find((nodeId) => !occupiedSlotNodeIds.has(nodeId)) ?? liftNodeId;
  }

  private inboundSourceUnavailableReason(): string {
    const waitingSourceLoadCount = this.inboundLiftNodes()
      .filter((liftNode) => this.inboundLiftWaitingSourceLoad(liftNode.id))
      .length;
    return waitingSourceLoadCount > 0 ? 'inbound-lift-source-assigned' : 'inbound-lift-source-empty';
  }

  private primeInboundSourceBacklog(): void {
    if (!this.shouldPrimeInboundSourceBacklog()) {
      return;
    }

    this.replenishInboundSourceBuffers();
    const inboundLiftCount = this.scenario.layout.nodes.filter((node) => liftKindForNode(node) === 'inbound').length;
    const sourceCapacity = this.inboundSourceBacklogCapacity();
    const targetTaskCount = Math.min(
      this.topLiftColumnLayoutEnabled() ? sourceCapacity : inboundLiftCount,
      this.scenario.taskGeneration.maxTasks
    );
    while (this.activeTaskCount() < targetTaskCount) {
      const result = this.createTask('inbound');
      if (!result.created) {
        break;
      }
    }

    this.nextInboundSec = Math.max(this.nextInboundSec, this.nextArrivalInterval('inbound'));
  }

  private primeTopLiftOutboundFullColumns(): void {
    const targetColumnCount = this.scenario.taskGeneration.initialOutboundFullColumns;
    if (
      !this.topLiftColumnLayoutEnabled() ||
      targetColumnCount <= 0 ||
      this.scenario.taskGeneration.outboundRatePerHour <= 0
    ) {
      return;
    }

    const occupancy = this.storageNodeLoadOccupancy(false);
    const seededColumnNumbers = this.initialTopLiftOutboundFullColumnNumbers(targetColumnCount);
    let seedIndex = 0;
    for (const column of seededColumnNumbers) {
      this.topLiftColumnFlowModes.set(column, 'outbound');
      for (const nodeId of this.topLiftStorageColumnNodeIds(column)) {
        if (occupancy.has(nodeId)) {
          continue;
        }
        seedIndex += 1;
        const position = this.storageGridPosition(nodeId);
        const load: LoadStateRecord = {
          id: `${OUTBOUND_SEED_LOAD_PREFIX}c${String(column).padStart(2, '0')}-r${String(position?.row ?? 0).padStart(2, '0')}-${String(seedIndex).padStart(4, '0')}`,
          state: 'stored',
          nodeId,
          vehicleId: null,
          weightKg: 450 + Math.round(this.rng.next() * 350)
        };
        this.pushLoad(load);
        occupancy.set(nodeId, load.id);
      }
    }
    if (seedIndex > 0) {
      this.logEvent('outbound-columns-seeded', null, null, null, null, null, 'initial-outbound-full-columns', null, {
        columns: seededColumnNumbers.map((column) => `c${String(column).padStart(2, '0')}`).join(','),
        loadCount: seedIndex
      });
    }
  }

  private initialTopLiftOutboundFullColumnNumbers(targetColumnCount: number): number[] {
    const columns = this.topLiftStorageColumnNumbers();
    if (columns.length === 0 || targetColumnCount <= 0) {
      return [];
    }

    const inboundLiftCount = this.inboundLiftNodes().length;
    const moduleCount = Math.max(1, inboundLiftCount);
    const columnsPerModule = Math.max(1, Math.floor(columns.length / moduleCount));
    const selected = new Set<number>();
    const columnsPerModuleTarget = Math.max(1, Math.ceil(targetColumnCount / moduleCount));

    for (let moduleIndex = 0; moduleIndex < moduleCount && selected.size < targetColumnCount; moduleIndex += 1) {
      const moduleStart = moduleIndex * columnsPerModule;
      const moduleColumns = columns.slice(moduleStart, moduleStart + columnsPerModule);
      const half = Math.max(1, Math.floor(moduleColumns.length / 2));
      const localCandidates = [
        ...moduleColumns.slice(0, half),
        ...moduleColumns.slice(half)
      ];
      for (const column of localCandidates.slice(0, columnsPerModuleTarget)) {
        selected.add(column);
        if (selected.size >= targetColumnCount) {
          break;
        }
      }
    }

    for (const column of columns) {
      if (selected.size >= targetColumnCount) {
        break;
      }
      selected.add(column);
    }

    return [...selected].sort((left, right) => left - right);
  }

  private shouldPrimeInboundSourceBacklog(): boolean {
    const inboundLiftCount = this.scenario.layout.nodes.filter((node) => liftKindForNode(node) === 'inbound').length;
    const outboundLiftCount = this.scenario.layout.nodes.filter((node) => liftKindForNode(node) === 'outbound').length;
    return (
      this.isInboundOnlyFlow() &&
      (outboundLiftCount === 0 || this.topLiftColumnLayoutEnabled()) &&
      inboundLiftCount > 1 &&
      this.scenario.taskGeneration.inboundRatePerHour >= 7200
    );
  }

  private inboundLiftHasWaitingSourceLoad(liftNodeId: string): boolean {
    return this.inboundLiftWaitingSourceLoad(liftNodeId) !== null;
  }

  private inboundSourceBacklogCapacity(): number {
    return this.inboundLiftNodes().reduce((sum, liftNode) => sum + this.inboundSourceBufferCapacity(liftNode.id), 0);
  }

  private inboundSourceBufferCapacity(_liftNodeId: string): number {
    if (!this.topLiftColumnLayoutEnabled()) {
      return 1;
    }
    return Math.max(1, Math.min(this.scenario.trafficPolicy.sourceBufferCapacity, this.inboundSourceSlotNodeIds(_liftNodeId).length));
  }

  private liftPortPlannedLoad(kind: 'inbound' | 'outbound', liftNodeId: string): number {
    return this.activeTasks().filter((task) =>
      task.kind === kind &&
      this.taskLiftPortNodeId(task) === liftNodeId
    ).length;
  }

  private taskLiftPortNodeId(task: TaskStateRecord): string | null {
    const candidateNodeId = task.kind === 'inbound' ? task.pickupNodeId : task.dropoffNodeId;
    const bufferParent = liftBufferParentNodeId(candidateNodeId);
    if (bufferParent?.kind === task.kind) {
      return bufferParent.liftNodeId;
    }
    return this.liftPortKindForNodeId(candidateNodeId) === task.kind ? candidateNodeId : null;
  }

  private liftPortKindForNodeId(nodeId: string): LiftKind | null {
    const bufferParent = liftBufferParentNodeId(nodeId);
    if (bufferParent) {
      return bufferParent.kind;
    }
    const node = this.scenario.layout.nodes.find((candidate) => candidate.id === nodeId);
    return node ? liftKindForNode(node) : null;
  }

  private isLiftPortCycleActive(kind: 'inbound' | 'outbound', liftNodeId: string): boolean {
    return this.vehicles.some((vehicle) =>
      ((kind === 'inbound' && vehicle.state === 'lifting') || (kind === 'outbound' && vehicle.state === 'lowering')) &&
      this.vehicleTaskLiftPortNodeId(vehicle) === liftNodeId
    );
  }

  private vehicleTaskLiftPortNodeId(vehicle: MutableVehicle | VehicleState): string | null {
    const task = this.taskById(vehicle.taskId);
    return task ? this.taskLiftPortNodeId(task) : null;
  }

  private nodeBelongsToLiftPort(nodeId: string, liftNodeId: string): boolean {
    if (nodeId === liftNodeId) {
      return true;
    }
    return liftBufferParentNodeId(nodeId)?.liftNodeId === liftNodeId;
  }

  private liftPortApproachCapacity(): number {
    return this.scenario.trafficPolicy.liftApproachCapacity;
  }

  private topLiftPortQueueCapacity(liftNodeId: string): number {
    if (!this.topLiftColumnLayoutEnabled()) {
      return 0;
    }
    return this.scenario.layout.nodes.filter((node) => topLiftQueueParkingSlot(node.id)?.liftNodeId === liftNodeId).length;
  }

  private topLiftPortStagedTaskCapacity(kind: 'inbound' | 'outbound', liftNodeId: string): number {
    if (!this.topLiftColumnLayoutEnabled()) {
      return this.effectiveLiftPortApproachCapacity(kind);
    }
    return Math.max(1, this.topLiftPortQueueCapacity(liftNodeId) + 1);
  }

  private effectiveLiftPortApproachCapacity(kind: 'inbound' | 'outbound'): number {
    if (this.topLiftColumnLayoutEnabled() && kind === 'outbound') {
      return 1;
    }
    return this.liftPortApproachCapacity();
  }

  private liftPortApproachCount(kind: 'inbound' | 'outbound', liftNodeId: string): number {
    return this.activeTasks().filter((task) =>
      task.kind === kind &&
      task.state !== 'queued' &&
      this.taskLiftPortNodeId(task) === liftNodeId &&
      this.taskStillConsumesLiftApproachSlot(task, kind, liftNodeId)
    ).length;
  }

  private taskStillConsumesLiftApproachSlot(task: TaskStateRecord, kind: 'inbound' | 'outbound', liftNodeId: string): boolean {
    const vehicle = task.vehicleId ? this.vehicles.find((candidate) => candidate.id === task.vehicleId) : null;
    if (vehicle && (vehicle.currentNodeId === liftNodeId || vehicle.targetNodeId === liftNodeId)) {
      return true;
    }
    if (kind === 'inbound') {
      const load = this.loadById(task.loadId);
      return task.state === 'assigned' || this.inboundSourceLoadBelongsToLift(load, liftNodeId);
    }
    return true;
  }

  private vehicleLiftPortWindowContains(vehicle: MutableVehicle, liftNodeId: string): boolean {
    return (
      vehicle.routeNodeIds[vehicle.routeIndex + 1] === liftNodeId ||
      vehicle.routeNodeIds[vehicle.routeIndex + 2] === liftNodeId
    );
  }

  private routeLiftPortAfterTarget(vehicle: MutableVehicle, toNodeId: string): { liftNodeId: string; kind: LiftKind } | null {
    if (vehicle.routeNodeIds[vehicle.routeIndex + 1] !== toNodeId) {
      return null;
    }
    const liftNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 2];
    if (!liftNodeId) {
      return null;
    }
    const kind = this.liftPortKindForNodeId(liftNodeId);
    const parent = liftBufferParentNodeId(liftNodeId);
    return kind ? { liftNodeId: parent?.liftNodeId ?? liftNodeId, kind } : null;
  }

  private liftIngressClaimingVehicleId(liftNodeId: string, vehicleId: string): string | null {
    for (const other of [...this.vehicles].sort((left, right) => left.id.localeCompare(right.id))) {
      if (other.id === vehicleId) {
        continue;
      }
      if (this.nodeBelongsToLiftPort(other.currentNodeId, liftNodeId) || (other.targetNodeId && this.nodeBelongsToLiftPort(other.targetNodeId, liftNodeId))) {
        return other.id;
      }
      const task = this.taskById(other.taskId);
      if (!task || task.state === 'completed' || task.state === 'failed' || this.taskLiftPortNodeId(task) !== liftNodeId) {
        continue;
      }
      if (this.vehicleLiftPortWindowContains(other, liftNodeId)) {
        return other.id;
      }
    }
    return null;
  }

  private liftIngressStagingBlock(
    vehicle: MutableVehicle,
    toNodeId: string,
    task: TaskStateRecord | null
  ): { reason: string; blockingVehicleId: string | null } | null {
    const liftPort = this.routeLiftPortAfterTarget(vehicle, toNodeId);
    if (!liftPort) {
      return null;
    }

    const blockingVehicleId = this.liftIngressClaimingVehicleId(liftPort.liftNodeId, vehicle.id);
    if (blockingVehicleId) {
      return { reason: `${liftPort.kind}-lift-busy:${liftPort.liftNodeId}`, blockingVehicleId };
    }

    const approachCount = this.liftPortApproachCount(liftPort.kind, liftPort.liftNodeId);
    const consumesSelf = task ? this.taskStillConsumesLiftApproachSlot(task, liftPort.kind, liftPort.liftNodeId) : false;
    const otherApproachCount = consumesSelf ? Math.max(0, approachCount - 1) : approachCount;
    if (otherApproachCount >= this.effectiveLiftPortApproachCapacity(liftPort.kind)) {
      return { reason: `${liftPort.kind}-lift-approach-full:${liftPort.liftNodeId}`, blockingVehicleId: null };
    }

    return null;
  }

  private portalNodeHoldBlock(vehicle: MutableVehicle, toNodeId: string): Reservation | null {
    const portalZones = this.zonesForNode(toNodeId).filter((zone) => zone.noStop && zone.noParking);
    for (const zone of portalZones) {
      const entrySensitive = this.portalNodeEntryUsesZone(vehicle, toNodeId, zone);
      const reservation = this.reservations.find((candidate) =>
        candidate.reasonCode === 'zone-hold' &&
        candidate.resourceType === 'zone' &&
        candidate.resourceId === zone.id &&
        candidate.vehicleId !== vehicle.id &&
        this.reservationIsActive(candidate) &&
        (entrySensitive || this.portalHoldConflictsWithEntry(candidate, zone, toNodeId))
      );
      if (reservation) {
        return reservation;
      }
    }
    return null;
  }

  private portalNodeEntryUsesZone(vehicle: MutableVehicle, toNodeId: string, zone: LayoutZone): boolean {
    const nextNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 2];
    if (!nextNodeId) {
      return false;
    }
    const nextEdge = this.traffic.findEdge(toNodeId, nextNodeId);
    return nextEdge ? zone.edgeIds.includes(nextEdge.id) : false;
  }

  private portalHoldConflictsWithEntry(reservation: Reservation, zone: LayoutZone, toNodeId: string): boolean {
    const holder = this.vehicles.find((vehicle) => vehicle.id === reservation.vehicleId);
    if (!holder || !holder.targetNodeId) {
      return true;
    }
    if (holder.targetNodeId === toNodeId) {
      return true;
    }
    const holderEdge = this.traffic.findEdge(holder.currentNodeId, holder.targetNodeId);
    return holderEdge ? zone.edgeIds.includes(holderEdge.id) : true;
  }

  private movingVehicleTargetingNode(nodeId: string, vehicleId: string): string | null {
    const claimant = this.vehicles.find((vehicle) =>
      vehicle.id !== vehicleId &&
      vehicle.currentEdgeId !== null &&
      vehicle.targetNodeId === nodeId
    );
    return claimant?.id ?? null;
  }

  private minimalTargetClaimBlocker(vehicle: MutableVehicle, toNodeId: string): string | null {
    const target = nodePosition(this.scenario, toNodeId);
    const closeEnoughM = this.closeTargetClaimDistanceM();
    const requesterDistanceToTargetM = Math.hypot(vehicle.x - target.x, vehicle.z - target.z);
    const claimant = this.vehicles.find((candidate) => {
      if (candidate.id === vehicle.id || candidate.currentEdgeId === null || candidate.targetNodeId !== toNodeId) {
        return false;
      }
      if (this.vehicleCurrentlyWaitsFor(candidate, vehicle.id)) {
        return false;
      }
      const claimantDistanceToTargetM = Math.hypot(candidate.x - target.x, candidate.z - target.z);
      return claimantDistanceToTargetM <= closeEnoughM;
    });
    if (!claimant) {
      return null;
    }
    return requesterDistanceToTargetM <= closeEnoughM ? claimant.id : null;
  }

  private closeTargetClaimDistanceM(): number {
    return Math.max(
      this.scenario.vehicles.lengthM + this.scenario.vehicles.safetyRadiusM + this.scenario.trafficPolicy.dynamicAvoidanceClearanceM / 2,
      this.scenario.vehicles.lengthM * 1.5
    );
  }

  private nodeClaimedByOtherVehicle(nodeId: string, vehicleId: string): string | null {
    const occupantId = this.currentNodeOccupancy.get(nodeId);
    if (occupantId && occupantId !== vehicleId) {
      return occupantId;
    }
    const claimant = this.vehicles.find((vehicle) =>
      vehicle.id !== vehicleId &&
      vehicle.targetNodeId === nodeId &&
      vehicle.currentNodeId !== nodeId &&
      vehicle.state !== 'idle' &&
      vehicle.state !== 'parking' &&
      !(vehicle.state === 'waiting-blocked' && vehicle.blockingVehicleId !== null)
    );
    if (claimant) {
      return claimant.id;
    }
    return this.localRouteNodeClaimBlocker(nodeId, vehicleId);
  }

  private localRouteNodeClaimBlocker(nodeId: string, vehicleId: string): string | null {
    const claimant = this.vehicles.find((vehicle) => {
      if (
        vehicle.id === vehicleId ||
        vehicle.state === 'idle' ||
        vehicle.state === 'parking' ||
        vehicle.localRouteNodeIds.length < 2
      ) {
        return false;
      }
      const currentIndex = vehicle.localRouteNodeIds.indexOf(vehicle.currentNodeId);
      if (currentIndex < 0) {
        return false;
      }
      if (this.vehicleCurrentlyWaitsFor(vehicle, vehicleId)) {
        return false;
      }
      return vehicle.localRouteNodeIds.slice(currentIndex + 1).includes(nodeId);
    });
    return claimant?.id ?? null;
  }

  private vehicleCurrentlyWaitsFor(vehicle: MutableVehicle, blockingVehicleId: string): boolean {
    return vehicle.state === 'waiting-blocked' &&
      (vehicle.blockingVehicleId === blockingVehicleId ||
        this.blockingVehicleForReservation(vehicle.blockingReservationId) === blockingVehicleId);
  }

  private closeOccupiedNextNode(vehicle: MutableVehicle, toNodeId: string): string | null {
    if (!this.collisionAvoidanceEnabled()) {
      return null;
    }
    const nextNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 2];
    if (!nextNodeId) {
      return null;
    }
    const occupantId = this.currentNodeOccupancy.get(nextNodeId) ?? this.movingVehicleTargetingNode(nextNodeId, vehicle.id);
    if (!occupantId || occupantId === vehicle.id) {
      return null;
    }
    const to = nodePosition(this.scenario, toNodeId);
    const next = nodePosition(this.scenario, nextNodeId);
    const spacingM = Math.hypot(to.x - next.x, to.z - next.z);
    const requiredM = this.scenario.vehicles.lengthM + this.scenario.vehicles.safetyRadiusM + 0.1;
    return spacingM < requiredM ? occupantId : null;
  }

  private deferTask(kind: 'inbound' | 'outbound', reason: string, dtSec: number): void {
    this.blockedTimeByReasonSec.set(reason, round((this.blockedTimeByReasonSec.get(reason) ?? 0) + dtSec));
    if (this.deferredTaskReasons[kind] === reason) {
      return;
    }

    this.deferredTaskReasons[kind] = reason;
    this.logEvent('task-deferred', null, null, null, null, null, reason, null, { kind });
  }

  private isStorageNode(nodeId: string): boolean {
    return this.storageNodeIdSet.has(nodeId);
  }

  private storageLanes(): ShuttleScenario['layout']['nodes'][] {
    if (this.topLiftColumnLayoutEnabled()) {
      const laneByKey = new Map<string, ShuttleScenario['layout']['nodes']>();
      for (const node of this.scenario.layout.nodes.filter((candidate) => candidate.type === 'storage')) {
        const key = this.nodeStorageRowLabel(node.id);
        if (!key) {
          continue;
        }
        const lane = laneByKey.get(key) ?? [];
        lane.push(node);
        laneByKey.set(key, lane);
      }

      return [...laneByKey.entries()]
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([, lane]) => lane.sort((left, right) => {
          const leftPosition = this.storageGridPosition(left.id);
          const rightPosition = this.storageGridPosition(right.id);
          return (
            (rightPosition?.row ?? 0) - (leftPosition?.row ?? 0) ||
            left.id.localeCompare(right.id)
          );
        }));
    }

    const laneByZ = new Map<number, ShuttleScenario['layout']['nodes']>();
    for (const node of this.scenario.layout.nodes.filter((candidate) => candidate.type === 'storage')) {
      const lane = laneByZ.get(node.z) ?? [];
      lane.push(node);
      laneByZ.set(node.z, lane);
    }

    return [...laneByZ.entries()]
      .sort(([leftZ], [rightZ]) => leftZ - rightZ)
      .map(([, lane]) => lane.sort((left, right) => left.x - right.x || left.id.localeCompare(right.id)));
  }

  private storageNodeLoadOccupancy(includePendingInbound: boolean): Map<string, string> {
    const occupancy = new Map<string, string>();
    for (const nodeId of this.storedLoadIdByNodeId.keys()) {
      const loadId = this.storedLoadIdAtNode(nodeId);
      if (loadId) {
        occupancy.set(nodeId, loadId);
      }
    }

    if (!includePendingInbound) {
      return occupancy;
    }

    for (const task of this.activeTasks()) {
      if (
        task.kind === 'inbound' &&
        this.isStorageNode(task.dropoffNodeId)
      ) {
        occupancy.set(task.dropoffNodeId, task.loadId);
      }
    }

    return occupancy;
  }

  private storageNodeLoadOccupancyForTaskReachability(task: TaskStateRecord): Map<string, string> {
    const occupancy = this.storageNodeLoadOccupancy(false);
    if (task.kind !== 'inbound') {
      return occupancy;
    }
    for (const candidate of this.activeTasks()) {
      if (
        candidate.kind !== 'inbound' ||
        !this.isStorageNode(candidate.dropoffNodeId)
      ) {
        continue;
      }
      const candidatePrecedesTask =
        candidate.createdAtSec < task.createdAtSec ||
        (candidate.createdAtSec === task.createdAtSec && candidate.id.localeCompare(task.id) <= 0);
      if (candidatePrecedesTask) {
        occupancy.set(candidate.dropoffNodeId, candidate.loadId);
      }
    }
    return occupancy;
  }

  private storedLoadIdAtNode(nodeId: string): string | null {
    const loadId = this.storedLoadIdByNodeId.get(nodeId);
    if (!loadId) {
      return null;
    }
    const load = this.loadById(loadId);
    if (load?.state === 'stored' && load.nodeId === nodeId) {
      return loadId;
    }
    this.storedLoadIdByNodeId.delete(nodeId);
    if (load) {
      this.storedNodeIdByLoadId.delete(load.id);
    }
    return null;
  }

  private selectInboundStorageNode(): { nodeId: string; loadId: string } | null {
    if (this.topLiftColumnLayoutEnabled()) {
      return this.selectTopLiftInboundStorageNode();
    }

    if (this.agentRefreshEnabled()) {
      return this.selectRefreshInboundStorageNode();
    }

    const lanes = this.storageLanes();
    if (lanes.length === 0) {
      return null;
    }

    const occupancy = this.storageNodeLoadOccupancy(true);
    const candidates: Array<{ nodeId: string; activeRowTaskCount: number; roundRobinDistance: number }> = [];
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      const lane = lanes[laneIndex]!;
      const firstEmptyIndex = lane.findIndex((node) => !occupancy.has(node.id) && !this.currentNodeOccupancy.has(node.id));
      if (firstEmptyIndex < 0) {
        continue;
      }
      // Phase 0 storage policy is an explicit contiguous lane-fill contract:
      // each row fills from the outfeed side toward the infeed side, and the
      // allocator does not compact or skip gaps inside a partially used row.
      const occupiedTowardOutfeed = lane.slice(0, firstEmptyIndex).every((leftSideNode) => occupancy.has(leftSideNode.id));
      const emptyTowardInfeed = lane.slice(firstEmptyIndex + 1).every((rightSideNode) => !occupancy.has(rightSideNode.id));
      if (occupiedTowardOutfeed && emptyTowardInfeed) {
        const nodeId = lane[firstEmptyIndex]!.id;
        const rowLabel = this.nodeStorageRowLabel(nodeId);
        candidates.push({
          nodeId,
          activeRowTaskCount: rowLabel ? this.activeStorageRowTaskCount(rowLabel) : 0,
          roundRobinDistance: (laneIndex - (this.taskSequence % lanes.length) + lanes.length) % lanes.length
        });
      }
    }
    const bestCandidate = candidates.sort((left, right) =>
      left.activeRowTaskCount - right.activeRowTaskCount ||
      left.roundRobinDistance - right.roundRobinDistance ||
      left.nodeId.localeCompare(right.nodeId)
    )[0];
    return bestCandidate ? { nodeId: bestCandidate.nodeId, loadId: '' } : null;
  }

  private selectRefreshInboundStorageNode(): { nodeId: string; loadId: string } | null {
    const lanes = this.storageLanes();
    if (lanes.length === 0) {
      return null;
    }

    const inboundTaskOrdinal = this.tasks.filter((task) => task.kind === 'inbound').length + 1;
    const occupancy = this.storageNodeLoadOccupancy(true);
    for (let offset = 0; offset < lanes.length; offset += 1) {
      const lane = lanes[(inboundTaskOrdinal - 1 + offset) % lanes.length]!;
      const rowLabel = this.nodeStorageRowLabel(lane[0]?.id ?? '');
      if (rowLabel && this.activeInboundStorageRowTaskCount(rowLabel) > 0) {
        continue;
      }

      const firstEmptyIndex = lane.findIndex((node) => !occupancy.has(node.id) && !this.currentNodeOccupancy.has(node.id));
      if (firstEmptyIndex < 0) {
        continue;
      }

      const occupiedTowardOutfeed = lane.slice(0, firstEmptyIndex).every((leftSideNode) => occupancy.has(leftSideNode.id));
      const emptyTowardInfeed = lane.slice(firstEmptyIndex + 1).every((rightSideNode) => !occupancy.has(rightSideNode.id));
      if (!occupiedTowardOutfeed || !emptyTowardInfeed) {
        continue;
      }

      return { nodeId: lane[firstEmptyIndex]!.id, loadId: '' };
    }

    return null;
  }

  private selectTopLiftInboundStorageNode(): { nodeId: string; loadId: string } | null {
    const occupancy = this.storageNodeLoadOccupancy(true);
    const outboundLockedColumns = this.topLiftOutboundLockedColumns();
    const activeColumn = this.activeTopLiftTaskColumn('inbound');
    if (activeColumn !== null) {
      if (outboundLockedColumns.has(activeColumn)) {
        return null;
      }
      if (this.topLiftTasklessStorageVehicleInColumn(activeColumn)) {
        return null;
      }
      if (this.activeTopLiftTaskCountInColumn('inbound', activeColumn) >= this.topLiftSkuColumnActiveTaskLimit('inbound')) {
        return null;
      }
      const nodeId = this.firstAvailableTopLiftInboundNodeInColumn(activeColumn, occupancy);
      return nodeId ? { nodeId, loadId: '' } : null;
    }

    for (const column of this.topLiftStorageColumnNumbers()) {
      if (outboundLockedColumns.has(column)) {
        continue;
      }
      if (this.topLiftTasklessStorageVehicleInColumn(column)) {
        continue;
      }
      const nodeId = this.firstAvailableTopLiftInboundNodeInColumn(column, occupancy);
      if (nodeId) {
        return { nodeId, loadId: '' };
      }
    }
    return null;
  }

  private selectTopLiftInboundStorageNodeForLift(liftNodeId: string): string | null {
    const occupancy = this.storageNodeLoadOccupancy(true);
    const outboundLockedColumns = this.topLiftOutboundLockedColumns();
    const activeColumn = this.activeTopLiftTaskColumnForLift('inbound', liftNodeId);
    if (activeColumn !== null) {
      if (outboundLockedColumns.has(activeColumn)) {
        return null;
      }
      if (this.topLiftTasklessStorageVehicleInColumn(activeColumn)) {
        return null;
      }
      if (this.activeTopLiftTaskCountInColumnForLift('inbound', activeColumn, liftNodeId) >= this.topLiftSkuColumnActiveTaskLimit('inbound')) {
        return null;
      }
      return this.firstAvailableTopLiftInboundNodeInColumn(activeColumn, occupancy);
    }

    for (const column of this.topLiftStorageColumnNumbersForLift(liftNodeId)) {
      if (outboundLockedColumns.has(column)) {
        continue;
      }
      if (this.topLiftTasklessStorageVehicleInColumn(column)) {
        continue;
      }
      const nodeId = this.firstAvailableTopLiftInboundNodeInColumn(column, occupancy);
      if (nodeId) {
        return nodeId;
      }
    }
    return null;
  }

  private firstAvailableTopLiftInboundNodeInColumn(column: number, occupancy: Map<string, string>): string | null {
    for (const nodeId of this.topLiftStorageColumnNodeIds(column)) {
      if (
        !occupancy.has(nodeId) &&
        !this.currentNodeOccupancy.has(nodeId) &&
        this.topLiftInboundStorageNodeReachableInColumn(nodeId, occupancy)
      ) {
        return nodeId;
      }
    }
    return null;
  }

  private topLiftInboundStorageNodeReachableInColumn(nodeId: string, occupancy: Map<string, string>): boolean {
    const position = this.storageGridPosition(nodeId);
    if (!position || !this.topLiftColumnLayoutEnabled()) {
      return true;
    }

    const rowsPerZone = this.topLiftColumnRowsPerZone();
    const zoneFirstRow = position.row <= rowsPerZone ? 1 : rowsPerZone + 1;
    const zoneLastRow = position.row <= rowsPerZone ? rowsPerZone : rowsPerZone * 2;
    const columnIndex = position.column - 1;
    const rowClear = (row: number): boolean => {
      const transitNodeId = storageNodeId(row - 1, columnIndex);
      return !occupancy.has(transitNodeId) && !this.currentNodeOccupancy.has(transitNodeId);
    };
    const rangeClear = (firstRow: number, lastRow: number): boolean => {
      for (let row = firstRow; row <= lastRow; row += 1) {
        if (!rowClear(row)) {
          return false;
        }
      }
      return true;
    };

    return rangeClear(zoneFirstRow, position.row - 1) || rangeClear(position.row + 1, zoneLastRow);
  }

  private activeStorageRowTaskCount(rowLabel: string): number {
    return this.activeTasks().filter((task) =>
      this.taskStorageRowLabel(task) === rowLabel
    ).length;
  }

  private activeInboundStorageRowTaskCount(rowLabel: string): number {
    return this.activeTasks().filter((task) =>
      task.kind === 'inbound' &&
      this.taskStorageRowLabel(task) === rowLabel
    ).length;
  }

  private selectOutboundLoad(): { nodeId: string; loadId: string } | null {
    if (this.topLiftColumnLayoutEnabled()) {
      return this.selectTopLiftOutboundLoad();
    }

    const lanes = this.storageLanes();
    const assignedOutboundLoadIds = new Set(
      this.tasks
        .filter((task) => task.kind === 'outbound' && task.state !== 'completed' && task.state !== 'failed')
        .map((task) => task.loadId)
    );

    for (let offset = 0; offset < lanes.length; offset += 1) {
      const lane = lanes[(this.taskSequence + offset) % lanes.length]!;
      for (const node of lane) {
        const loadId = this.storedLoadIdAtNode(node.id);
        if (loadId && !assignedOutboundLoadIds.has(loadId)) {
          return { nodeId: node.id, loadId };
        }
      }
    }
    return null;
  }

  private selectTopLiftOutboundTaskSelection(): { nodeId: string; liftNodeId: string; loadId: string } | { reason: string } {
    const outboundLockedColumns = this.topLiftOutboundLockedColumns();
    if (this.mixedTopLiftFlowEnabled() && outboundLockedColumns.size === 0) {
      return { reason: 'storage-empty' };
    }

    const assignedOutboundLoadIds = this.assignedOutboundLoadIds();
    const outboundLifts = this.outboundLiftNodes()
      .filter((node) => this.liftPortPlannedLoad('outbound', node.id) < this.topLiftPortStagedTaskCapacity('outbound', node.id))
      .sort((left, right) =>
        this.liftPortPlannedLoad('outbound', left.id) - this.liftPortPlannedLoad('outbound', right.id) ||
        left.x - right.x ||
        left.id.localeCompare(right.id)
      );

    for (const liftNode of outboundLifts) {
      for (const column of this.topLiftStorageColumnNumbersForLift(liftNode.id)) {
        if (this.mixedTopLiftFlowEnabled() && !outboundLockedColumns.has(column)) {
          continue;
        }
        if (!this.topLiftOutboundColumnCanAcceptTask(column)) {
          continue;
        }
        const selection = this.firstAvailableTopLiftOutboundLoadInColumn(column, assignedOutboundLoadIds);
        if (selection) {
          return { ...selection, liftNodeId: liftNode.id };
        }
      }
    }

    return { reason: 'storage-empty' };
  }

  private selectTopLiftOutboundLoad(): { nodeId: string; loadId: string } | null {
    const assignedOutboundLoadIds = this.assignedOutboundLoadIds();
    const outboundLockedColumns = this.topLiftOutboundLockedColumns();
    const activeColumn = this.activeTopLiftTaskColumn('outbound');
    if (activeColumn !== null && !this.mixedTopLiftFlowEnabled()) {
      if (this.topLiftOutboundColumnCanAcceptTask(activeColumn)) {
        return this.firstAvailableTopLiftOutboundLoadInColumn(activeColumn, assignedOutboundLoadIds);
      }
      return null;
    }

    if (this.mixedTopLiftFlowEnabled() && outboundLockedColumns.size === 0) {
      return null;
    }

    for (const column of this.topLiftStorageColumnNumbers()) {
      if (this.mixedTopLiftFlowEnabled() && !outboundLockedColumns.has(column)) {
        continue;
      }
      if (!this.topLiftOutboundColumnCanAcceptTask(column)) {
        continue;
      }
      const selection = this.firstAvailableTopLiftOutboundLoadInColumn(column, assignedOutboundLoadIds);
      if (selection) {
        return selection;
      }
    }
    return null;
  }

  private topLiftOutboundColumnCanAcceptTask(column: number): boolean {
    return this.activeTopLiftTaskCountInColumn('outbound', column) < this.topLiftSkuColumnActiveTaskLimit('outbound');
  }

  private firstAvailableTopLiftOutboundLoadInColumn(column: number, assignedOutboundLoadIds: Set<string>): { nodeId: string; loadId: string } | null {
    for (const nodeId of this.topLiftStorageColumnNodeIds(column)) {
      const loadId = this.storedLoadIdAtNode(nodeId);
      const load = this.loadById(loadId);
      if (!load) {
        continue;
      }
      if (assignedOutboundLoadIds.has(load.id) || !this.outboundEligibleLoad(load)) {
        return null;
      }
      if (this.topLiftOutboundLoadHasStoredBlocker(load, assignedOutboundLoadIds)) {
        return null;
      }
      if (load) {
        return { nodeId, loadId: load.id };
      }
    }
    return null;
  }

  private topLiftOutboundLoadHasStoredBlocker(load: LoadStateRecord, assignedOutboundLoadIds: Set<string>): boolean {
    if (!load.nodeId || !this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const targetPosition = this.storageGridPosition(load.nodeId);
    if (!targetPosition) {
      return false;
    }
    const columnNodeIds = this.topLiftStorageColumnNodeIds(targetPosition.column);
    const targetIndex = columnNodeIds.indexOf(load.nodeId);
    if (targetIndex <= 0) {
      return false;
    }
    for (const blockerNodeId of columnNodeIds.slice(0, targetIndex)) {
      const blockerLoadId = this.storedLoadIdAtNode(blockerNodeId);
      if (blockerLoadId && assignedOutboundLoadIds.has(blockerLoadId)) {
        return true;
      }
    }
    return false;
  }

  private topLiftOutboundLockedColumns(): Set<number> {
    const columns = new Set<number>();
    if (!this.topLiftColumnLayoutEnabled()) {
      return columns;
    }
    if (this.scenario.taskGeneration.outboundRatePerHour <= 0) {
      return columns;
    }

    for (const task of this.activeTasks()) {
      if (task.kind !== 'outbound') {
        continue;
      }
      const column = this.taskStorageColumn(task);
      if (column !== null) {
        columns.add(column);
      }
    }

    for (const [nodeId, loadId] of this.storedLoadIdByNodeId) {
      const load = this.loadById(loadId);
      if (!load || load.state !== 'stored' || load.nodeId !== nodeId || !this.outboundEligibleLoad(load)) {
        continue;
      }
      const column = this.storageGridPosition(nodeId)?.column ?? null;
      if (column !== null) {
        columns.add(column);
      }
    }

    return columns;
  }

  private outboundEligibleLoad(load: LoadStateRecord): boolean {
    if (!this.mixedTopLiftFlowEnabled()) {
      return true;
    }
    if (load.id.startsWith(OUTBOUND_SEED_LOAD_PREFIX)) {
      return true;
    }
    if (!load.nodeId) {
      return false;
    }
    const column = this.storageGridPosition(load.nodeId)?.column ?? null;
    return column !== null && this.topLiftColumnFlowModes.get(column) === 'outbound';
  }

  private mixedTopLiftFlowEnabled(): boolean {
    return this.topLiftColumnLayoutEnabled() &&
      this.scenario.taskGeneration.inboundRatePerHour > 0 &&
      this.scenario.taskGeneration.outboundRatePerHour > 0;
  }

  private assignedOutboundLoadIds(): Set<string> {
    return new Set(
      this.activeTasks()
        .filter((task) => task.kind === 'outbound')
        .map((task) => task.loadId)
    );
  }

  private assignQueuedTasks(dtSec: number): void {
    this.dispatchTasklessTopLiftStorageExits();
    const availableVehicleIds = new Set(
      this.vehicles
        .filter((vehicle) => this.canAcceptQueuedTask(vehicle))
        .map((vehicle) => vehicle.id)
    );

    for (const task of this.queuedTasks()) {
      if (availableVehicleIds.size === 0) {
        this.recordQueuedTaskWait(task, 'vehicle-unavailable', dtSec);
        continue;
      }

      const reason = this.taskAssignmentBlockReason(task);
      if (reason) {
        this.recordQueuedTaskWait(task, reason, dtSec);
        continue;
      }

      const assignment = this.bestAvailableVehicleForTask(task, availableVehicleIds);
      if (!assignment) {
        this.recordQueuedTaskWait(task, 'route-unavailable', dtSec);
        continue;
      }

      this.assignTaskToVehicle(assignment.vehicle, task, assignment.route);
      availableVehicleIds.delete(assignment.vehicle.id);
    }
  }

  private recordQueuedTaskWait(task: TaskStateRecord, reason: string, dtSec: number): void {
    task.waitReason = reason;
    this.blockedTimeByReasonSec.set(reason, round((this.blockedTimeByReasonSec.get(reason) ?? 0) + dtSec));
  }

  private canAcceptQueuedTask(vehicle: MutableVehicle): boolean {
    if (vehicle.taskId || vehicle.loaded || vehicle.currentEdgeId || vehicle.legRemainingM > 0 || vehicle.phaseRemainingSec > 0) {
      return false;
    }
    if (this.topLiftColumnLayoutEnabled() && this.isStorageNode(vehicle.currentNodeId)) {
      return false;
    }
    if (this.tasklessPlannedRouteActive(vehicle)) {
      return false;
    }
    return vehicle.state === 'idle' || vehicle.state === 'assigned' || vehicle.state === 'waiting-blocked' || vehicle.state === 'parking';
  }

  private tasklessPlannedRouteActive(vehicle: MutableVehicle): boolean {
    return this.topLiftColumnLayoutEnabled() &&
      !vehicle.taskId &&
      vehicle.plannedGoalNodeId !== null &&
      vehicle.plannedGoalNodeId !== vehicle.currentNodeId;
  }

  private bestAvailableVehicleForTask(task: TaskStateRecord, availableVehicleIds: Set<string>): { vehicle: MutableVehicle; route: string[]; pickupDistanceM: number; totalDistanceM: number } | null {
    let bestAssignment: { vehicle: MutableVehicle; route: string[]; pickupDistanceM: number; totalDistanceM: number } | null = null;
    for (const vehicle of this.vehicles.filter((candidate) => availableVehicleIds.has(candidate.id))) {
      try {
        const route = this.taskAssignmentRoute(vehicle, task);
        const pickupDistanceM = this.routeDistanceM(route, this.taskDispatchGoalNodeId(task, vehicle));
        const totalDistanceM = this.routeDistanceM(route);
        if (
          !bestAssignment ||
          pickupDistanceM < bestAssignment.pickupDistanceM ||
          (pickupDistanceM === bestAssignment.pickupDistanceM && totalDistanceM < bestAssignment.totalDistanceM) ||
          (pickupDistanceM === bestAssignment.pickupDistanceM && totalDistanceM === bestAssignment.totalDistanceM && vehicle.id.localeCompare(bestAssignment.vehicle.id) < 0)
        ) {
          bestAssignment = { vehicle, route, pickupDistanceM, totalDistanceM };
        }
      } catch {
        continue;
      }
    }
    return bestAssignment;
  }

  private taskAssignmentRoute(vehicle: MutableVehicle, task: TaskStateRecord): string[] {
    const pickupGoalNodeId = this.taskDispatchGoalNodeId(task, vehicle);
    if (this.agentRefreshEnabled()) {
      return this.agentRefreshNominalRouteToGoal(vehicle, task, pickupGoalNodeId);
    }
    if (this.agentMinimalEnabled()) {
      return this.agentNominalRouteToGoal(vehicle, task, pickupGoalNodeId);
    }
    return this.planRoute(vehicle.currentNodeId, task, this.parkingNodeFor(vehicle.id));
  }

  private assignTaskToVehicle(vehicle: MutableVehicle, task: TaskStateRecord, route: string[]): void {
    if (!vehicle.taskId) {
      this.clearTasklessRouteReservations(vehicle);
    }
    const agentMinimal = this.agentMinimalEnabled();
    const agentRefresh = this.agentRefreshEnabled();
    const agentSimple = this.agentSimpleEnabled();
    vehicle.taskId = task.id;
    const dispatchGoalNodeId = this.taskDispatchGoalNodeId(task, vehicle);
    if (agentRefresh) {
      this.installAgentRefreshPlannedRoute(vehicle, task, dispatchGoalNodeId);
    } else if (agentMinimal) {
      this.installAgentTaskRoute(vehicle, task, dispatchGoalNodeId);
    } else if (agentSimple) {
      this.resetNavigationAtCurrentNode(vehicle);
    } else {
      vehicle.routeNodeIds = route;
      vehicle.routeIndex = 0;
      vehicle.targetNodeId = route[1] ?? null;
    }
    vehicle.state = 'assigned';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.directionSwitchReadyNodeId = null;
    this.setTaskState(task, 'assigned');
    task.vehicleId = vehicle.id;
    task.assignedAtSec = this.simTimeSec;
    task.waitReason = null;
    this.logEvent(
      'task-assigned',
      vehicle.id,
      task.id,
      task.loadId,
      vehicle.currentNodeId,
      task.pickupNodeId,
      agentRefresh ? 'nearest-available-agent-refresh' : agentSimple ? 'nearest-available-agent-goal' : 'nearest-available',
      this.vehiclePosition(vehicle),
      agentSimple
        ? agentRefresh
          ? { pickupNodeId: task.pickupNodeId, dropoffNodeId: task.dropoffNodeId, dispatcherRouteInstalled: false, route: vehicle.routeNodeIds.join('>') }
          : agentMinimal
          ? { pickupNodeId: task.pickupNodeId, dropoffNodeId: task.dropoffNodeId, dispatcherRouteInstalled: false, route: vehicle.routeNodeIds.join('>') }
          : { pickupNodeId: task.pickupNodeId, dropoffNodeId: task.dropoffNodeId, dispatcherRouteInstalled: false }
        : { route: route.join('>') }
    );
  }

  private installAgentTaskRoute(vehicle: MutableVehicle, task: TaskStateRecord, goalNodeId: string): string[] {
    const route = this.agentNominalRouteToGoal(vehicle, task, goalNodeId);
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = route[1] ?? null;
    return route;
  }

  private installAgentRefreshPlannedRoute(vehicle: MutableVehicle, task: TaskStateRecord | null, goalNodeId: string): string[] {
    const route = this.agentRefreshNominalRouteToGoal(vehicle, task, goalNodeId);
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = route[1] ?? null;
    vehicle.plannedGoalNodeId = goalNodeId;
    vehicle.plannedRouteNodeIds = route;
    vehicle.localRouteNodeIds = [];
    vehicle.localRouteReason = null;
    return route;
  }

  private resetNavigationAtCurrentNode(vehicle: MutableVehicle): void {
    vehicle.routeNodeIds = [vehicle.currentNodeId];
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = null;
    vehicle.currentEdgeId = null;
    vehicle.legRemainingM = 0;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = 0;
    vehicle.targetSpeedMps = 0;
    vehicle.plannedGoalNodeId = null;
    vehicle.plannedRouteNodeIds = [];
    vehicle.localRouteNodeIds = [];
    vehicle.localRouteReason = null;
  }

  private clearTasklessRouteReservations(vehicle: MutableVehicle): void {
    this.reservations = this.reservations.filter(
      (reservation) => reservation.vehicleId !== vehicle.id || reservation.reasonCode === 'zone-hold'
    );
    this.ensureZoneHoldReservation(vehicle, vehicle.currentNodeId);
  }

  private routeDistanceM(routeNodeIds: string[], stopAtNodeId?: string): number {
    if (stopAtNodeId && routeNodeIds[0] === stopAtNodeId) {
      return 0;
    }
    let distanceM = 0;
    for (let index = 1; index < routeNodeIds.length; index += 1) {
      const fromNodeId = routeNodeIds[index - 1]!;
      const toNodeId = routeNodeIds[index]!;
      const edge = this.traffic.findEdge(fromNodeId, toNodeId);
      if (!edge) {
        throw new Error(`No route edge between ${fromNodeId} and ${toNodeId}`);
      }
      distanceM += edge.lengthM;
      if (toNodeId === stopAtNodeId) {
        return distanceM;
      }
    }
    return distanceM;
  }

  private routeTravelEstimateSec(vehicle: MutableVehicle, routeNodeIds: string[]): number {
    let travelSec = 0;
    for (let index = 1; index < routeNodeIds.length; index += 1) {
      const fromNodeId = routeNodeIds[index - 1]!;
      const toNodeId = routeNodeIds[index]!;
      const edge = this.traffic.findEdge(fromNodeId, toNodeId);
      if (!edge) {
        continue;
      }
      const speedMps = this.speedForEdge(vehicle, edge);
      travelSec += calculateTravelTimeSec(edge.lengthM, speedMps, this.scenario.physicsParams.accelerationMps2);
    }
    return round(travelSec);
  }

  private nearestLiftPortNodeIdByDistance(kind: LiftKind, relatedNodeId: string): string | null {
    const related = this.scenario.layout.nodes.find((node) => node.id === relatedNodeId);
    const liftNodes = this.scenario.layout.nodes
      .filter((node) => liftKindForNode(node) === kind)
      .sort((left, right) => {
        const leftDistance = related ? Math.abs(left.x - related.x) + Math.abs(left.z - related.z) : 0;
        const rightDistance = related ? Math.abs(right.x - related.x) + Math.abs(right.z - related.z) : 0;
        return leftDistance - rightDistance || left.id.localeCompare(right.id);
      });
    return liftNodes[0]?.id ?? null;
  }

  private routeThroughTargets(startNodeId: string, targets: string[]): string[] {
    const route = [startNodeId];
    for (const target of targets) {
      if (target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      const blockedStorageNodeIds = this.blockedStorageTransitNodeIds(fromNodeId, target);
      const segment = this.shortestPath(fromNodeId, target, blockedStorageNodeIds);
      route.push(...segment.slice(1));
    }
    return route;
  }

  private idealInboundCycleForStorageCell(storageNodeId: string): {
    loadedDistanceM: number;
    emptyReturnDistanceM: number;
    loadedTravelSec: number;
    emptyReturnSec: number;
    cycleSec: number;
  } | null {
    const liftNodeId = this.nearestLiftPortNodeIdByDistance('inbound', storageNodeId);
    const storageEntryNodeId = this.storageSideNodeId(storageNodeId, 'right');
    const storageExitNodeId = this.storageSideNodeId(storageNodeId, 'left');
    if (!liftNodeId || !storageEntryNodeId || !storageExitNodeId) {
      return null;
    }

    try {
      const loadedRoute = this.routeThroughTargets(liftNodeId, [storageEntryNodeId, storageNodeId]);
      const emptyReturnRoute = this.routeThroughTargets(storageNodeId, [storageExitNodeId, liftNodeId]);
      const loadedDistanceM = this.routeDistanceM(loadedRoute);
      const emptyReturnDistanceM = this.routeDistanceM(emptyReturnRoute);
      const loadedTravelSec = calculateTravelTimeSec(
        loadedDistanceM,
        this.scenario.physicsParams.loadedSpeedMps,
        this.scenario.physicsParams.accelerationMps2
      );
      const emptyReturnSec = calculateTravelTimeSec(
        emptyReturnDistanceM,
        this.scenario.physicsParams.emptySpeedMps,
        this.scenario.physicsParams.accelerationMps2
      );
      const cycleSec = loadedTravelSec + emptyReturnSec + this.scenario.physicsParams.liftTimeSec + this.scenario.physicsParams.lowerTimeSec;
      return { loadedDistanceM, emptyReturnDistanceM, loadedTravelSec, emptyReturnSec, cycleSec };
    } catch {
      return null;
    }
  }

  private calculateTheoreticalCapacityBaseline(): TheoreticalCapacityBaseline {
    if (this.theoreticalCapacityBaseline) {
      return this.theoreticalCapacityBaseline;
    }
    const cacheKey = this.theoreticalCapacityBaselineCacheKey();
    const cached = theoreticalCapacityBaselineCache.get(cacheKey);
    if (cached) {
      this.theoreticalCapacityBaseline = cached;
      return cached;
    }

    const samples = this.scenario.layout.nodes
      .filter((node) => node.type === 'storage')
      .flatMap((node) => this.idealInboundCycleForStorageCell(node.id) ?? []);
    const sampleCount = Math.max(1, samples.length);
    const averageCycleSec = samples.reduce((sum, sample) => sum + sample.cycleSec, 0) / sampleCount;
    const averageLoadedDistanceM = samples.reduce((sum, sample) => sum + sample.loadedDistanceM, 0) / sampleCount;
    const averageEmptyReturnDistanceM = samples.reduce((sum, sample) => sum + sample.emptyReturnDistanceM, 0) / sampleCount;
    const averageLoadedTravelSec = samples.reduce((sum, sample) => sum + sample.loadedTravelSec, 0) / sampleCount;
    const averageEmptyReturnSec = samples.reduce((sum, sample) => sum + sample.emptyReturnSec, 0) / sampleCount;
    const singleShuttlePph = averageCycleSec > 0 ? 3600 / averageCycleSec : 0;
    const fleetPph = singleShuttlePph * this.scenario.vehicles.count;
    this.theoreticalCapacityBaseline = {
      kind: 'inbound',
      shuttleCount: this.scenario.vehicles.count,
      singleShuttlePph: round(singleShuttlePph, 3),
      fleetPph: round(fleetPph, 3),
      idealCycleSec: round(averageCycleSec, 3),
      loadedTravelSec: round(averageLoadedTravelSec, 3),
      emptyReturnSec: round(averageEmptyReturnSec, 3),
      liftAndLowerSec: round(this.scenario.physicsParams.liftTimeSec + this.scenario.physicsParams.lowerTimeSec, 3),
      averageLoadedDistanceM: round(averageLoadedDistanceM, 3),
      averageEmptyReturnDistanceM: round(averageEmptyReturnDistanceM, 3),
      assumptions: [
        'inbound-only ideal with unlimited lift-side demand',
        'no traffic conflicts, waiting, deadlock recovery, battery, or upstream starvation',
        'average over all storage cells using nearest inbound lift and current speed/lift/lower parameters',
        'empty return is modeled from storage cell back to the nearest inbound lift through allowed horizontal storage rows and aisles'
      ]
    };
    theoreticalCapacityBaselineCache.set(cacheKey, this.theoreticalCapacityBaseline);
    return this.theoreticalCapacityBaseline;
  }

  private theoreticalCapacityBaselineCacheKey(): string {
    const layoutHash = createHash('sha256')
      .update(stableJson({
        calibrationProfile: this.scenario.layout.calibrationProfile ?? null,
        nodes: this.scenario.layout.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          liftKind: node.liftKind ?? null,
          x: node.x,
          z: node.z,
          noStop: node.noStop,
          noParking: node.noParking
        })),
        edges: this.scenario.layout.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          lengthM: edge.lengthM,
          directionMode: edge.directionMode
        }))
      }))
      .digest('hex');
    return stableJson({
      layoutHash,
      shuttleCount: this.scenario.vehicles.count,
      emptySpeedMps: this.scenario.physicsParams.emptySpeedMps,
      loadedSpeedMps: this.scenario.physicsParams.loadedSpeedMps,
      accelerationMps2: this.scenario.physicsParams.accelerationMps2,
      liftTimeSec: this.scenario.physicsParams.liftTimeSec,
      lowerTimeSec: this.scenario.physicsParams.lowerTimeSec
    });
  }

  private calculateTheoreticalCapacity(
    inboundPph: number,
    vehicleUtilization: Record<string, number>
  ): TheoreticalCapacitySnapshot {
    const baseline = this.calculateTheoreticalCapacityBaseline();
    const utilizationValues = Object.values(vehicleUtilization);
    const averageVehicleUtilizationPct =
      utilizationValues.reduce((sum, value) => sum + value, 0) / Math.max(1, utilizationValues.length) * 100;

    return {
      ...baseline,
      achievedInboundPct: round(baseline.fleetPph > 0 ? (inboundPph / baseline.fleetPph) * 100 : 0, 3),
      averageVehicleUtilizationPct: round(averageVehicleUtilizationPct, 3)
    };
  }

  private taskAssignmentBlockReason(task: TaskStateRecord): string | null {
    if (task.kind === 'inbound') {
      const columnPredecessorBlockReason = this.topLiftInboundColumnPredecessorBlockReason(task);
      if (columnPredecessorBlockReason && !this.topLiftInboundQueueSlotAvailableForTask(task)) {
        return columnPredecessorBlockReason;
      }
      const dropoffLoadId = this.storedLoadIdAtNode(task.dropoffNodeId);
      if (dropoffLoadId && dropoffLoadId !== task.loadId) {
        return 'storage-full';
      }
      const dropoffColumn = this.storageGridPosition(task.dropoffNodeId)?.column ?? null;
      if (
        this.topLiftColumnLayoutEnabled() &&
        dropoffColumn !== null &&
        this.topLiftTasklessStorageVehicleInColumn(dropoffColumn)
      ) {
        return `inbound-column-clearing:c${String(dropoffColumn).padStart(2, '0')}`;
      }
      if (
        this.topLiftColumnLayoutEnabled() &&
        this.isStorageNode(task.dropoffNodeId) &&
        !this.topLiftInboundStorageNodeReachableInColumn(task.dropoffNodeId, this.storageNodeLoadOccupancyForTaskReachability(task))
      ) {
        return 'storage-full';
      }
    }
    if (task.kind === 'inbound' && this.isInboundOnlyFlow()) {
      return null;
    }
    if (
      task.kind === 'outbound' &&
      this.topLiftColumnLayoutEnabled() &&
      this.outboundTaskHasEarlierDropoffTask(task) &&
      !this.topLiftOutboundQueueSlotAvailableForTask(task)
    ) {
      return 'outbound-lift-queue-full';
    }
    return this.liftPortBlockReason(task) ?? this.fifoLaneBlockReason(task) ?? this.fifoNetworkBlockReason(task);
  }

  private yieldPocketRank(vehicle: MutableVehicle, nodeId: string): number {
    const node = this.layoutNode(nodeId);
    if (!node) {
      return 99;
    }
    if (this.agentMinimalEnabled()) {
      if (node.type === 'parking') {
        return 0;
      }
      if (node.type === 'storage') {
        return /^left-row-|^right-row-/.test(vehicle.currentNodeId) ? 1 : 4;
      }
      if (node.type === 'aisle') {
        return 2;
      }
      if (node.type === 'intersection') {
        return 3;
      }
      return 10;
    }
    if (node.type === 'storage') {
      return vehicle.loaded ? 50 : 0;
    }
    if (node.type === 'parking') {
      return 1;
    }
    if (node.type === 'aisle') {
      return 2;
    }
    if (node.type === 'intersection') {
      return 3;
    }
    return 10;
  }

  private tryInsertEmptySideAisleRefuge(vehicle: MutableVehicle, blockedTargetNodeId: string): boolean {
    if (vehicle.loaded) {
      return false;
    }
    const currentNode = this.layoutNode(vehicle.currentNodeId);
    if (!currentNode || currentNode.type !== 'intersection' || !/^left-row-|^right-row-/.test(currentNode.id)) {
      return false;
    }
    const previousNodeId = vehicle.routeNodeIds[vehicle.routeIndex - 1];
    if (
      previousNodeId &&
      this.layoutNode(previousNodeId)?.type === 'storage' &&
      vehicle.routeNodeIds[vehicle.routeIndex - 2] === currentNode.id
    ) {
      return false;
    }
    const currentTargetNode = this.layoutNode(blockedTargetNodeId);
    if (currentTargetNode?.type === 'storage') {
      return false;
    }
    const activeRefugeNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 1];
    if (
      activeRefugeNodeId &&
      this.layoutNode(activeRefugeNodeId)?.type === 'storage' &&
      vehicle.routeNodeIds[vehicle.routeIndex + 2] === currentNode.id
    ) {
      return false;
    }
    const refuge = this.neighbors(currentNode.id)
      .filter((neighbor) => !this.nodeClaimedByOtherVehicle(neighbor.nodeId, vehicle.id))
      .filter((neighbor) => this.layoutNode(neighbor.nodeId)?.type === 'storage')
      .sort((left, right) => left.lengthM - right.lengthM || left.nodeId.localeCompare(right.nodeId))[0];
    if (!refuge || !this.traffic.findEdge(refuge.nodeId, currentNode.id)) {
      return false;
    }
    const nextRoute = [
      ...vehicle.routeNodeIds.slice(0, vehicle.routeIndex + 1),
      refuge.nodeId,
      currentNode.id,
      ...vehicle.routeNodeIds.slice(vehicle.routeIndex + 1)
    ];
    vehicle.routeNodeIds = nextRoute;
    vehicle.targetNodeId = refuge.nodeId;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.state = 'assigned';
    this.replanCount += 1;
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, null, currentNode.id, refuge.nodeId, 'side-aisle-refuge-pocket', this.vehiclePosition(vehicle), {
      blockedTargetNodeId,
      route: nextRoute.join('>')
    });
    return true;
  }

  private storageRefugeExitBlock(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    fromNodeId: string,
    toNodeId: string,
    exitEdge: LayoutEdge
  ): { reason: string; blockingReservationId: string | null; blockingVehicleId: string | null } | null {
    if (vehicle.loaded) {
      return null;
    }
    const fromNode = this.layoutNode(fromNodeId);
    const toNode = this.layoutNode(toNodeId);
    if (fromNode?.type === 'storage' && toNode?.type === 'storage' && vehicle.routeIndex > 0) {
      let sideRowExitNodeId: string | null = null;
      let sideRowExitIndex = -1;
      for (let index = vehicle.routeIndex + 2; index < vehicle.routeNodeIds.length; index += 1) {
        const candidateNodeId = vehicle.routeNodeIds[index]!;
        const candidateNode = this.layoutNode(candidateNodeId);
        if (candidateNode?.type === 'storage') {
          continue;
        }
        if (candidateNode?.type === 'intersection' && /^left-row-|^right-row-/.test(candidateNode.id)) {
          sideRowExitNodeId = candidateNode.id;
          sideRowExitIndex = index;
        }
        break;
      }
      if (!sideRowExitNodeId) {
        return null;
      }
      const fromStoragePosition = this.storageGridPosition(fromNodeId);
      const toStoragePosition = this.storageGridPosition(toNodeId);
      if (fromStoragePosition && toStoragePosition) {
        const movingTowardSideExit = sideRowExitNodeId.startsWith('left-row-')
          ? toStoragePosition.column < fromStoragePosition.column
          : toStoragePosition.column > fromStoragePosition.column;
        if (!movingTowardSideExit) {
          return null;
        }
      }

      const sideRowClaimId = this.nodeClaimedByOtherVehicle(sideRowExitNodeId, vehicle.id);
      if (sideRowClaimId) {
        return { reason: 'refuge-exit-blocked', blockingReservationId: null, blockingVehicleId: sideRowClaimId };
      }
      const continuationNodeId = vehicle.routeNodeIds[sideRowExitIndex + 1];
      if (continuationNodeId && this.layoutNode(continuationNodeId)?.type !== 'storage') {
        const continuationClaimId = this.nodeClaimedByOtherVehicle(continuationNodeId, vehicle.id);
        if (continuationClaimId) {
          return { reason: 'refuge-exit-blocked', blockingReservationId: null, blockingVehicleId: continuationClaimId };
        }
      }
      return null;
    }

    if (
      fromNode?.type !== 'storage' ||
      toNode?.type !== 'intersection' ||
      !/^left-row-|^right-row-/.test(toNode.id) ||
      vehicle.routeNodeIds[vehicle.routeIndex - 1] !== toNodeId
    ) {
      return null;
    }

    const continuationNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 2];
    if (!continuationNodeId || this.layoutNode(continuationNodeId)?.type === 'storage') {
      return null;
    }

    const sideRowClaimId = this.nodeClaimedByOtherVehicle(toNodeId, vehicle.id);
    if (sideRowClaimId) {
      return { reason: 'node-occupied', blockingReservationId: null, blockingVehicleId: sideRowClaimId };
    }

    const continuationClaimId = this.nodeClaimedByOtherVehicle(continuationNodeId, vehicle.id);
    if (continuationClaimId) {
      return { reason: 'refuge-exit-blocked', blockingReservationId: null, blockingVehicleId: continuationClaimId };
    }

    const continuationEdge = this.traffic.findEdge(toNodeId, continuationNodeId);
    if (!continuationEdge) {
      return { reason: 'route-edge-missing', blockingReservationId: null, blockingVehicleId: null };
    }

    const exitMotionMode = this.routeLegMotionMode(vehicle, exitEdge, toNodeId, vehicle.routeIndex, task);
    const exitTravelSec = this.routeLegTravelSec(vehicle, exitEdge, toNodeId, vehicle.routeIndex, exitMotionMode);
    const continuationMotionMode = this.routeLegMotionMode(vehicle, continuationEdge, continuationNodeId, vehicle.routeIndex + 1, task);
    const continuationTravelSec = this.routeLegTravelSec(vehicle, continuationEdge, continuationNodeId, vehicle.routeIndex + 1, continuationMotionMode);
    const attempt = this.traffic.reserveMove({
      vehicleId: vehicle.id,
      taskId: vehicle.taskId,
      fromNodeId: toNodeId,
      toNodeId: continuationNodeId,
      startTimeSec: this.simTimeSec + exitTravelSec,
      travelSec: continuationTravelSec,
      priority: this.priorityFor(vehicle),
      existing: this.reservations,
      ignoreConflicts: !this.collisionAvoidanceEnabled()
    });
    if (!attempt.ok) {
      return {
        reason: attempt.reasonCode === 'route-edge-missing' ? attempt.reasonCode : 'refuge-exit-blocked',
        blockingReservationId: attempt.blockingReservationId,
        blockingVehicleId: this.blockingVehicleForReservation(attempt.blockingReservationId)
      };
    }

    return null;
  }

  private deeperStorageRefugeNodeId(vehicle: MutableVehicle, blockedTargetNodeId: string): string | null {
    if (vehicle.loaded || !this.isStorageNode(vehicle.currentNodeId)) {
      return null;
    }
    const currentPosition = this.storageGridPosition(vehicle.currentNodeId);
    if (!currentPosition) {
      return null;
    }

    const previousNodeId = vehicle.routeNodeIds[vehicle.routeIndex - 1];
    const enteredFromSideAisle = Boolean(previousNodeId && /^left-row-|^right-row-/.test(previousNodeId));
    const currentCellClaimedByOther = this.nodeClaimedByOtherVehicle(vehicle.currentNodeId, vehicle.id) !== null;
    const blockedPosition = this.storageGridPosition(blockedTargetNodeId);
    const blockedTargetClaimId = this.nodeClaimedByOtherVehicle(blockedTargetNodeId, vehicle.id);
    const blockedTargetClaimant = blockedTargetClaimId
      ? this.vehicles.find((candidate) => candidate.id === blockedTargetClaimId) ?? null
      : null;
    const loadedVehicleNeedsBlockedStorageCell = Boolean(
      blockedPosition &&
      blockedPosition.row === currentPosition.row &&
      blockedTargetClaimant?.loaded
    );
    const sideRowExitNodeId = this.storageRowSideExitNodeIdForRoute(vehicle);
    const sideRowExitClaimId = sideRowExitNodeId ? this.nodeClaimedByOtherVehicle(sideRowExitNodeId, vehicle.id) : null;
    const sideRowExitClaimant = sideRowExitClaimId
      ? this.vehicles.find((candidate) => candidate.id === sideRowExitClaimId) ?? null
      : null;
    const loadedVehicleBlocksSameRowExit = Boolean(
      sideRowExitNodeId &&
      this.storageSideRowMatchesStorageRow(sideRowExitNodeId, currentPosition.row) &&
      sideRowExitClaimant?.loaded
    );
    if (
      !enteredFromSideAisle &&
      !currentCellClaimedByOther &&
      !loadedVehicleNeedsBlockedStorageCell &&
      !loadedVehicleBlocksSameRowExit
    ) {
      return null;
    }

    let deeperColumn: number | null = null;
    if (blockedPosition && blockedPosition.row === currentPosition.row) {
      deeperColumn = blockedPosition.column < currentPosition.column
        ? currentPosition.column + 1
        : currentPosition.column - 1;
    } else if (blockedTargetNodeId.startsWith('left-row-')) {
      deeperColumn = currentPosition.column + 1;
    } else if (blockedTargetNodeId.startsWith('right-row-')) {
      deeperColumn = currentPosition.column - 1;
    } else {
      if (previousNodeId?.startsWith('left-row-')) {
        deeperColumn = currentPosition.column + 1;
      } else if (previousNodeId?.startsWith('right-row-')) {
        deeperColumn = currentPosition.column - 1;
      }
    }
    if (deeperColumn === null || deeperColumn < 1) {
      return null;
    }

    const candidateNodeId = storageNodeId(currentPosition.row - 1, deeperColumn - 1);
    if (!this.isStorageNode(candidateNodeId) || !this.traffic.findEdge(vehicle.currentNodeId, candidateNodeId)) {
      return null;
    }
    if (this.storedLoadIdAtNode(candidateNodeId)) {
      return null;
    }
    return this.nodeClaimedByOtherVehicle(candidateNodeId, vehicle.id) ? null : candidateNodeId;
  }

  private storageRowSideExitNodeIdForRoute(vehicle: MutableVehicle): string | null {
    for (let index = vehicle.routeIndex + 1; index < vehicle.routeNodeIds.length; index += 1) {
      const nodeId = vehicle.routeNodeIds[index]!;
      const node = this.layoutNode(nodeId);
      if (node?.type === 'storage') {
        continue;
      }
      return node?.type === 'intersection' && /^left-row-|^right-row-/.test(node.id) ? node.id : null;
    }
    return null;
  }

  private storageSideRowMatchesStorageRow(sideRowNodeId: string, storageRow: number): boolean {
    const match = /^(?:left|right)-row-(\d+)$/.exec(sideRowNodeId);
    return match ? Number(match[1]) === storageRow : false;
  }

  private tryMoveDeeperIntoStorageRefuge(vehicle: MutableVehicle, blockedTargetNodeId: string): boolean {
    const deeperNodeId = this.deeperStorageRefugeNodeId(vehicle, blockedTargetNodeId);
    if (!deeperNodeId) {
      return false;
    }

    const nextRoute = [
      ...vehicle.routeNodeIds.slice(0, vehicle.routeIndex + 1),
      deeperNodeId,
      vehicle.currentNodeId,
      ...vehicle.routeNodeIds.slice(vehicle.routeIndex + 1)
    ];
    vehicle.routeNodeIds = nextRoute;
    vehicle.targetNodeId = deeperNodeId;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.state = 'assigned';
    this.replanCount += 1;
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, null, vehicle.currentNodeId, deeperNodeId, 'storage-refuge-deeper-pocket', this.vehiclePosition(vehicle), {
      blockedTargetNodeId,
      route: nextRoute.join('>')
    });
    return true;
  }

  private liftPortBlockReason(task: TaskStateRecord): string | null {
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return null;
    }
    if (this.topLiftColumnLayoutEnabled() && this.topLiftPortQueueCapacity(liftNodeId) > 0) {
      return null;
    }
    const approachCount = this.liftPortApproachCount(task.kind, liftNodeId);
    return approachCount >= this.effectiveLiftPortApproachCapacity(task.kind) ? `${task.kind}-lift-approach-full:${liftNodeId}` : null;
  }

  private liftPortWaitReason(nodeId: string): string | null {
    const kind = this.liftPortKindForNodeId(nodeId);
    return kind ? `${kind}-lift-busy:${nodeId}` : null;
  }

  private reservationIsActive(reservation: Reservation): boolean {
    return reservation.startTimeSec <= this.simTimeSec + 1e-6 && this.simTimeSec <= reservation.endTimeSec + 1e-6;
  }

  private reservationWindowsOverlap(left: Reservation, right: Reservation): boolean {
    return left.startTimeSec <= right.endTimeSec + 1e-6 && right.startTimeSec <= left.endTimeSec + 1e-6;
  }

  private reservationsShareBlockingResource(left: Reservation, right: Reservation): boolean {
    const sameResource = left.resourceType === right.resourceType && left.resourceId === right.resourceId;
    const sameZoneConflictGroup =
      left.resourceType === 'zone' &&
      right.resourceType === 'zone' &&
      left.conflictGroup !== null &&
      right.conflictGroup !== null &&
      left.conflictGroup === right.conflictGroup;
    return sameResource || sameZoneConflictGroup;
  }

  private reservationsShareExactResource(left: Reservation, right: Reservation): boolean {
    return left.resourceType === right.resourceType && left.resourceId === right.resourceId;
  }

  private mergeSelfReservationWindows(existing: Reservation, candidate: Reservation): Reservation {
    const mergedStartTimeSec = Math.min(existing.startTimeSec, candidate.startTimeSec);
    const retainedPastSec = Math.max(
      this.scenario.timeStepSec,
      this.scenario.trafficPolicy.minimumClearanceSec
    ) + 1e-6;
    const startTimeSec = mergedStartTimeSec < this.simTimeSec - retainedPastSec
      ? Math.max(this.simTimeSec - retainedPastSec, Math.min(existing.endTimeSec, candidate.startTimeSec))
      : mergedStartTimeSec;
    return ReservationSchema.parse({
      ...existing,
      taskId: existing.taskId ?? candidate.taskId,
      startTimeSec,
      endTimeSec: Math.max(existing.endTimeSec, candidate.endTimeSec),
      priority: Math.max(existing.priority, candidate.priority)
    });
  }

  private installMoveReservationsReplacingSelfOverlap(
    vehicle: MutableVehicle,
    reservations: Reservation[]
  ): MoveReservationInstall {
    if (reservations.length === 0) {
      return { installed: [], removed: [] };
    }

    const removed: Array<{ index: number; reservation: Reservation }> = [];
    const acceptedReservations: Reservation[] = [];
    for (const reservation of reservations) {
      let mergedReservation = reservation;
      for (let index = acceptedReservations.length - 1; index >= 0; index -= 1) {
        const existing = acceptedReservations[index]!;
        if (
          this.reservationsShareExactResource(existing, mergedReservation) &&
          this.reservationWindowsOverlap(existing, mergedReservation)
        ) {
          acceptedReservations.splice(index, 1);
          mergedReservation = this.mergeSelfReservationWindows(existing, mergedReservation);
        }
      }
      this.reservations = this.reservations.filter((existing, index) => {
        const merge =
          existing.vehicleId === vehicle.id &&
          this.reservationsShareExactResource(existing, mergedReservation) &&
          this.reservationWindowsOverlap(existing, mergedReservation);
        if (merge) {
          removed.push({ index, reservation: existing });
          mergedReservation = this.mergeSelfReservationWindows(existing, mergedReservation);
        }
        return !merge;
      });
      acceptedReservations.push(mergedReservation);
    }
    this.reservations.push(...acceptedReservations);
    return { installed: acceptedReservations, removed };
  }

  private rollbackMoveReservationInstall(
    installed: Reservation[],
    removed: Array<{ index: number; reservation: Reservation }>
  ): void {
    if (installed.length === 0 && removed.length === 0) {
      return;
    }

    const addedIds = new Set(installed.map((reservation) => reservation.id));
    const restored = this.reservations.filter((reservation) => !addedIds.has(reservation.id));
    for (const { index, reservation } of removed.sort((left, right) => left.index - right.index)) {
      restored.splice(Math.min(index, restored.length), 0, reservation);
    }
    this.reservations = restored;
  }

  private hasActiveSelfMoveAuthorization(
    vehicle: MutableVehicle,
    edgeId: string,
    targetNodeId: string,
    requiredEndTimeSec: number
  ): boolean {
    return this.hasSelfMoveAuthorizationAt(vehicle, edgeId, targetNodeId, this.simTimeSec, requiredEndTimeSec);
  }

  private hasSelfMoveAuthorizationAt(
    vehicle: MutableVehicle,
    edgeId: string,
    targetNodeId: string,
    authorizationStartTimeSec: number,
    requiredEndTimeSec: number,
    endToleranceSec = 1e-6
  ): boolean {
    const hasEdgeReservation = this.reservations.some((reservation) =>
      reservation.vehicleId === vehicle.id &&
      reservation.resourceType === 'edge' &&
      reservation.resourceId === edgeId &&
      reservation.startTimeSec <= authorizationStartTimeSec + 1e-6 &&
      authorizationStartTimeSec <= reservation.endTimeSec + 1e-6 &&
      reservation.endTimeSec >= requiredEndTimeSec - endToleranceSec
    );
    const hasNodeReservation = this.reservations.some((reservation) =>
      reservation.vehicleId === vehicle.id &&
      reservation.resourceType === 'node' &&
      reservation.resourceId === targetNodeId &&
      reservation.startTimeSec <= authorizationStartTimeSec + 1e-6 &&
      authorizationStartTimeSec <= reservation.endTimeSec + 1e-6 &&
      reservation.endTimeSec >= requiredEndTimeSec - endToleranceSec
    );
    return hasEdgeReservation && hasNodeReservation;
  }

  private fifoLaneBlockReason(task: TaskStateRecord): string | null {
    const rowLabel = this.taskStorageRowLabel(task);
    if (!rowLabel) {
      return null;
    }
    const taskColumn = this.taskStorageColumn(task);
    if (taskColumn !== null) {
      const hasUnfinishedPredecessor = this.activeTasks().some((candidate) =>
        candidate.id !== task.id &&
        candidate.kind === task.kind &&
        this.taskStorageRowLabel(candidate) === rowLabel &&
        (this.taskStorageColumn(candidate) ?? Number.POSITIVE_INFINITY) < taskColumn
      );
      if (hasUnfinishedPredecessor) {
        return `fifo-predecessor-pending:${rowLabel}`;
      }
      if (this.topLiftColumnLayoutEnabled()) {
        const activeSameColumnSameKindCount = this.activeTasks().filter((candidate) =>
          candidate.id !== task.id &&
          candidate.kind === task.kind &&
          (candidate.state === 'assigned' || candidate.state === 'in-progress') &&
          this.taskStorageColumn(candidate) === taskColumn
        ).length;
        if (activeSameColumnSameKindCount < this.topLiftSkuColumnActiveTaskLimit(task.kind)) {
          return null;
        }
      }
    }
    const hasActiveSameLaneTask = this.activeTasks().some((candidate) =>
      candidate.id !== task.id &&
      (candidate.state === 'assigned' || candidate.state === 'in-progress') &&
      this.taskStorageRowLabel(candidate) === rowLabel
    );
    return hasActiveSameLaneTask ? `fifo-lane-busy:${rowLabel}` : null;
  }

  private fifoNetworkBlockReason(task: TaskStateRecord): string | null {
    if (task.kind !== 'outbound') {
      return null;
    }
    if (this.mixedTopLiftFlowEnabled()) {
      return null;
    }
    const hasActiveOutboundFifoTask = this.activeTasks().some((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'outbound' &&
      (candidate.state === 'assigned' || candidate.state === 'in-progress')
    );
    return hasActiveOutboundFifoTask ? 'fifo-left-network-busy' : null;
  }

  private topLiftInboundColumnPredecessorBlockReason(task: TaskStateRecord): string | null {
    const position = this.topLiftInboundColumnPredecessorPosition(task);
    return position && this.topLiftInboundColumnPredecessorPending(task)
      ? `inbound-column-predecessor-pending:c${String(position.column).padStart(2, '0')}`
      : null;
  }

  private topLiftInboundQueueSlotAvailableForTask(task: TaskStateRecord): boolean {
    const queueNodeId = this.topLiftInboundQueueNodeIdForTask(task);
    if (!queueNodeId) {
      return false;
    }
    const taskVehicleId = task.vehicleId ?? null;
    const occupantId = this.currentNodeOccupancy.get(queueNodeId);
    if (occupantId && occupantId !== taskVehicleId) {
      return false;
    }
    return !this.vehicles.some((vehicle) =>
      vehicle.id !== taskVehicleId &&
      (vehicle.currentNodeId === queueNodeId || vehicle.targetNodeId === queueNodeId || vehicle.plannedGoalNodeId === queueNodeId)
    );
  }

  private topLiftOutboundQueueSlotAvailableForTask(task: TaskStateRecord): boolean {
    const queueNodeId = this.topLiftOutboundQueueNodeIdForTask(task);
    if (!queueNodeId) {
      return false;
    }
    const taskVehicleId = task.vehicleId ?? null;
    const occupantId = this.currentNodeOccupancy.get(queueNodeId);
    if (occupantId && occupantId !== taskVehicleId) {
      return false;
    }
    return !this.vehicles.some((vehicle) =>
      vehicle.id !== taskVehicleId &&
      (vehicle.currentNodeId === queueNodeId || vehicle.targetNodeId === queueNodeId || vehicle.plannedGoalNodeId === queueNodeId)
    );
  }

  private topLiftInboundColumnPredecessorPending(task: TaskStateRecord): boolean {
    const position = this.topLiftInboundColumnPredecessorPosition(task);
    if (!position) {
      return false;
    }
    const columnNodeIds = this.topLiftStorageColumnNodeIds(position.column);
    const targetIndex = columnNodeIds.indexOf(task.dropoffNodeId);
    if (targetIndex <= 0) {
      return false;
    }
    const deeperNodeIds = new Set(columnNodeIds.slice(0, targetIndex));
    return this.activeTasks().some((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'inbound' &&
      deeperNodeIds.has(candidate.dropoffNodeId)
    );
  }

  private topLiftInboundColumnPredecessorPosition(task: TaskStateRecord): { row: number; column: number } | null {
    if (task.kind !== 'inbound' || !this.topLiftColumnLayoutEnabled() || !this.isStorageNode(task.dropoffNodeId)) {
      return null;
    }
    const position = this.storageGridPosition(task.dropoffNodeId);
    if (!position) {
      return null;
    }
    return position;
  }

  private taskStorageRowLabel(task: TaskStateRecord): string | null {
    const storageNodeId = task.kind === 'inbound' ? task.dropoffNodeId : task.pickupNodeId;
    return this.nodeStorageRowLabel(storageNodeId);
  }

  private taskStorageColumn(task: TaskStateRecord): number | null {
    const storageNodeId = task.kind === 'inbound' ? task.dropoffNodeId : task.pickupNodeId;
    return this.storageGridPosition(storageNodeId)?.column ?? null;
  }

  private activeTopLiftTaskColumn(kind: 'inbound' | 'outbound'): number | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const activeTasks = this.tasks
      .filter((task) => task.kind === kind && task.state !== 'completed' && task.state !== 'failed')
      .map((task) => ({
        task,
        column: this.taskStorageColumn(task)
      }))
      .filter((entry): entry is { task: TaskStateRecord; column: number } => entry.column !== null)
      .sort((left, right) =>
        left.task.createdAtSec - right.task.createdAtSec ||
        left.task.id.localeCompare(right.task.id)
      );
    return activeTasks[0]?.column ?? null;
  }

  private activeTopLiftTaskCountInColumn(kind: 'inbound' | 'outbound', column: number): number {
    return this.activeTasks().filter((task) =>
      task.kind === kind &&
      this.taskStorageColumn(task) === column
    ).length;
  }

  private activeTopLiftTaskColumnForLift(kind: 'inbound' | 'outbound', liftNodeId: string): number | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const activeTasks = this.activeTasks()
      .filter((task) =>
        task.kind === kind &&
        this.taskLiftPortNodeId(task) === liftNodeId
      )
      .map((task) => ({
        task,
        column: this.taskStorageColumn(task)
      }))
      .filter((entry): entry is { task: TaskStateRecord; column: number } => entry.column !== null)
      .sort((left, right) =>
        left.task.createdAtSec - right.task.createdAtSec ||
        left.task.id.localeCompare(right.task.id)
      );
    return activeTasks[0]?.column ?? null;
  }

  private activeTopLiftTaskCountInColumnForLift(kind: 'inbound' | 'outbound', column: number, liftNodeId: string): number {
    return this.activeTasks().filter((task) =>
      task.kind === kind &&
      this.taskStorageColumn(task) === column &&
      this.taskLiftPortNodeId(task) === liftNodeId
    ).length;
  }

  private topLiftSkuColumnActiveTaskLimit(kind: 'inbound' | 'outbound'): number {
    void kind;
    return 2;
  }

  private refreshTopLiftColumnFlowModes(): void {
    if (!this.mixedTopLiftFlowEnabled()) {
      this.topLiftColumnFlowModes.clear();
      return;
    }

    const storedOccupancy = this.storageNodeLoadOccupancy(false);
    for (const column of this.topLiftStorageColumnNumbers()) {
      const nodeIds = this.topLiftStorageColumnNodeIds(column);
      const mode = this.topLiftColumnFlowModes.get(column);
      const hasSeedLoad = this.topLiftColumnHasSeedOutboundLoad(nodeIds, storedOccupancy);
      const hasActiveOutbound = this.activeTopLiftTaskCountInColumn('outbound', column) > 0;
      const hasActiveInbound = this.activeTopLiftTaskCountInColumn('inbound', column) > 0;
      const full = this.topLiftColumnIsPhysicallyFull(nodeIds, storedOccupancy);
      const empty = this.topLiftColumnIsPhysicallyEmpty(nodeIds, storedOccupancy);

      if (hasSeedLoad || hasActiveOutbound) {
        this.topLiftColumnFlowModes.set(column, 'outbound');
        continue;
      }
      if ((mode === 'outbound' || hasActiveInbound) && empty && !hasActiveOutbound) {
        this.topLiftColumnFlowModes.set(column, 'inbound');
        continue;
      }
      if ((mode === undefined || mode === 'inbound') && full && !hasActiveInbound) {
        this.topLiftColumnFlowModes.set(column, 'outbound');
        continue;
      }
      if (mode === undefined) {
        this.topLiftColumnFlowModes.set(column, 'inbound');
      }
    }
  }

  private rebuildTopLiftColumnFlowModesFromState(): void {
    this.topLiftColumnFlowModes = new Map();
    if (!this.mixedTopLiftFlowEnabled()) {
      return;
    }
    this.refreshTopLiftColumnFlowModes();
  }

  private topLiftColumnHasSeedOutboundLoad(nodeIds: string[], storedOccupancy: Map<string, string>): boolean {
    return nodeIds.some((nodeId) =>
      (storedOccupancy.get(nodeId) ?? '').startsWith(OUTBOUND_SEED_LOAD_PREFIX)
    );
  }

  private topLiftColumnIsPhysicallyFull(nodeIds: string[], storedOccupancy: Map<string, string>): boolean {
    return nodeIds.length > 0 && nodeIds.every((nodeId) => storedOccupancy.has(nodeId));
  }

  private topLiftColumnIsPhysicallyEmpty(nodeIds: string[], storedOccupancy: Map<string, string>): boolean {
    return nodeIds.every((nodeId) => !storedOccupancy.has(nodeId));
  }

  private topLiftStorageColumnNumbers(): number[] {
    if (this.topLiftStorageColumnNumbersCache) {
      return this.topLiftStorageColumnNumbersCache;
    }
    const columns = new Set<number>();
    for (const node of this.scenario.layout.nodes) {
      if (node.type !== 'storage') {
        continue;
      }
      const position = this.storageGridPosition(node.id);
      if (position) {
        columns.add(position.column);
      }
    }
    this.topLiftStorageColumnNumbersCache = [...columns].sort((left, right) => left - right);
    return this.topLiftStorageColumnNumbersCache;
  }

  private topLiftStorageColumnNumbersForLift(liftNodeId: string): number[] {
    const columns = this.topLiftStorageColumnNumbers();
    const liftNode = this.layoutNode(liftNodeId);
    const liftKind = liftNode ? liftKindForNode(liftNode) : null;
    const liftNodes = this.scenario.layout.nodes
      .filter((node) => liftKindForNode(node) === (liftKind ?? 'inbound'))
      .sort((left, right) => left.x - right.x || left.id.localeCompare(right.id));
    const liftIndex = liftNodes.findIndex((liftNode) => liftNode.id === liftNodeId);
    if (liftIndex < 0 || liftNodes.length === 0) {
      return columns;
    }
    const startIndex = Math.floor((liftIndex * columns.length) / liftNodes.length);
    const endIndex = Math.floor(((liftIndex + 1) * columns.length) / liftNodes.length);
    return columns.slice(startIndex, endIndex);
  }

  private topLiftStorageColumnNodeIds(column: number): string[] {
    const cached = this.topLiftStorageColumnNodeIdsCache.get(column);
    if (cached) {
      return cached;
    }
    const nodeIds = this.scenario.layout.nodes
      .filter((node) => node.type === 'storage')
      .map((node) => ({ nodeId: node.id, position: this.storageGridPosition(node.id) }))
      .filter((entry): entry is { nodeId: string; position: { row: number; column: number } } =>
        entry.position !== null && entry.position.column === column
      )
      .sort((left, right) =>
        right.position.row - left.position.row ||
        left.nodeId.localeCompare(right.nodeId)
      )
      .map((entry) => entry.nodeId);
    this.topLiftStorageColumnNodeIdsCache.set(column, nodeIds);
    return nodeIds;
  }

  private topLiftInitialSkuParkingBlockedColumns(): Set<number> {
    if (!this.topLiftColumnLayoutEnabled()) {
      return new Set();
    }
    const columns = this.topLiftStorageColumnNumbers();
    const firstColumn = columns[0];
    if (firstColumn === undefined) {
      return new Set();
    }
    return new Set(columns.filter((column) => column === firstColumn || column === firstColumn + 1));
  }

  private storageGridPosition(nodeId: string): { row: number; column: number } | null {
    if (this.storageGridPositionCache.has(nodeId)) {
      return this.storageGridPositionCache.get(nodeId) ?? null;
    }
    const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
    const position = match ? { row: Number(match[1]), column: Number(match[2]) } : null;
    this.storageGridPositionCache.set(nodeId, position);
    return position;
  }

  private nodeStorageRowLabel(nodeId: string): string | null {
    const storagePosition = this.storageGridPosition(nodeId);
    if (storagePosition) {
      if (this.topLiftColumnLayoutEnabled()) {
        const bank = storagePosition.row <= this.topLiftColumnRowsPerZone() ? 1 : 2;
        return `b${String(bank).padStart(2, '0')}-c${String(storagePosition.column).padStart(2, '0')}`;
      }
      return `r${String(storagePosition.row).padStart(2, '0')}`;
    }
    if (this.topLiftColumnLayoutEnabled()) {
      const accessMatch = /^column-(?:top-a|top-b|middle|bottom-a|bottom-b)-c(\d+)$/.exec(nodeId);
      if (accessMatch) {
        return `c${accessMatch[1]}`;
      }
    }
    const sideMatch = /^(?:left|right)-row-(\d+)$/.exec(nodeId);
    if (sideMatch) {
      return `r${sideMatch[1]}`;
    }
    return null;
  }

  private topLiftColumnKey(nodeId: string): string | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const storagePosition = this.storageGridPosition(nodeId);
    if (storagePosition) {
      return `c${String(storagePosition.column).padStart(2, '0')}`;
    }
    const accessMatch = /^column-(?:top-a|top-b|middle|bottom-a|bottom-b)-c(\d+)$/.exec(nodeId);
    if (accessMatch) {
      return `c${String(Number(accessMatch[1])).padStart(2, '0')}`;
    }
    return null;
  }

  private topLiftTasklessStorageVehicleInColumn(column: number): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    return this.vehicles.some((vehicle) => {
      if (vehicle.loaded || vehicle.taskId) {
        return false;
      }
      const position = this.storageGridPosition(vehicle.currentNodeId);
      return position?.column === column;
    });
  }

  private topLiftTasklessVehicleBlocksInboundColumn(vehicle: MutableVehicle): boolean {
    if (!this.topLiftColumnLayoutEnabled() || vehicle.loaded || vehicle.taskId || !this.isStorageNode(vehicle.currentNodeId)) {
      return false;
    }
    const position = this.storageGridPosition(vehicle.currentNodeId);
    if (!position) {
      return false;
    }
    return this.activeTasks().some((task) =>
      task.kind === 'inbound' &&
      this.storageGridPosition(task.dropoffNodeId)?.column === position.column
    );
  }

  private topLiftTasklessNoParkingClearanceRoute(vehicle: MutableVehicle): string[] | null {
    if (!this.topLiftColumnLayoutEnabled() || vehicle.loaded || vehicle.taskId) {
      return null;
    }
    const fromNodeId = vehicle.currentNodeId;
    const fromNode = this.layoutNode(fromNodeId);
    if (!fromNode?.noParking) {
      return null;
    }
    const activeColumnKeys = this.activeTopLiftInboundColumnKeys();

    const candidate = this.neighbors(fromNodeId)
      .filter((neighbor) => {
        const node = this.layoutNode(neighbor.nodeId);
        return node?.type === 'storage' || (node?.type === 'parking' && !node.noParking);
      })
      .filter((neighbor) => {
        const columnKey = this.topLiftColumnKey(neighbor.nodeId);
        return !columnKey || !activeColumnKeys.has(columnKey);
      })
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => !this.nodeClaimedByOtherVehicle(neighbor.nodeId, vehicle.id))
      .filter((neighbor) => !this.storedLoadIdAtNode(neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshTemporaryStorageNodeAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, fromNodeId, neighbor.nodeId))
      .sort((left, right) =>
        this.topLiftTasklessClearanceRank(left.nodeId) - this.topLiftTasklessClearanceRank(right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0];
    return candidate ? [fromNodeId, candidate.nodeId] : null;
  }

  private topLiftTasklessClearanceRank(nodeId: string): number {
    const node = this.layoutNode(nodeId);
    if (!node) {
      return 99;
    }
    if (node.type === 'parking') {
      return 0;
    }
    if (isTopLiftColumnAccessNodeId(nodeId)) {
      return 1;
    }
    if (node.type === 'storage') {
      return 2;
    }
    return 10;
  }

  private topLiftRouteTerminatesOnColumnAccess(routeNodeIds: string[]): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const terminalNodeId = routeNodeIds.at(-1);
    return terminalNodeId ? isTopLiftColumnAccessNodeId(terminalNodeId) : false;
  }

  private topLiftColumnRowsPerZone(): number {
    if (this.topLiftColumnRowsPerZoneCache !== null) {
      return this.topLiftColumnRowsPerZoneCache;
    }
    const rows = this.scenario.layout.nodes
      .filter((node) => node.type === 'storage')
      .map((node) => this.storageGridPosition(node.id)?.row ?? 0);
    this.topLiftColumnRowsPerZoneCache = Math.max(1, Math.max(...rows) / 2);
    return this.topLiftColumnRowsPerZoneCache;
  }

  private planRoute(currentNodeId: string, task: TaskStateRecord, parkingNodeId: string): string[] {
    const route: string[] = [currentNodeId];
    const storageEntrySideNodeId = task.kind === 'inbound' ? this.storageSideNodeId(task.dropoffNodeId, 'right') : this.storageSideNodeId(task.pickupNodeId, 'left');
    const currentStorageExitNodeId = task.kind === 'inbound' && this.isStorageNode(currentNodeId)
      ? this.inboundStorageExitNodeId(currentNodeId)
      : null;
    const alreadyAtOutboundPickup = task.kind === 'outbound' && currentNodeId === task.pickupNodeId;
    const targets = task.kind === 'inbound'
      ? [currentStorageExitNodeId, task.pickupNodeId, storageEntrySideNodeId, task.dropoffNodeId]
      : alreadyAtOutboundPickup
        ? [task.dropoffNodeId, parkingNodeId]
        : [storageEntrySideNodeId, task.pickupNodeId, storageEntrySideNodeId, task.dropoffNodeId, parkingNodeId];
    for (const target of targets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      const blockStoredLoads = route.includes(task.pickupNodeId) && target !== task.pickupNodeId;
      const blockedStorageNodeIds = this.blockedStorageTransitNodeIds(fromNodeId, target, { blockStoredLoads });
      const segment = this.shortestPath(fromNodeId, target, blockedStorageNodeIds);
      route.push(...segment.slice(1));
    }
    return route;
  }

  private planLoadedRouteToDropoff(currentNodeId: string, task: TaskStateRecord): string[] {
    const route: string[] = [currentNodeId];
    const targets = task.kind === 'inbound'
      ? [this.storageSideNodeId(task.dropoffNodeId, 'right'), task.dropoffNodeId]
      : [task.dropoffNodeId];

    for (const target of targets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      const blockedStorageNodeIds = this.blockedStorageTransitNodeIds(fromNodeId, target, { blockStoredLoads: true });
      const segment = this.shortestPath(fromNodeId, target, blockedStorageNodeIds);
      route.push(...segment.slice(1));
    }

    return route;
  }

  private inboundStorageExitNodeId(storageNodeId: string): string | null {
    return this.inboundStorageExitNodeCandidates(storageNodeId)[0] ?? null;
  }

  private inboundStorageExitNodeCandidates(storageNodeId: string): string[] {
    if (this.topLiftColumnLayoutEnabled()) {
      return [
        this.topLiftNearestStorageColumnAccessNodeId(storageNodeId),
        this.storageSideNodeId(storageNodeId, 'right'),
        this.storageSideNodeId(storageNodeId, 'left')
      ].filter((nodeId, index, nodeIds): nodeId is string =>
        nodeId !== null && nodeIds.indexOf(nodeId) === index
      );
    }
    if (this.isInboundOnlyFlow()) {
      const nodeId = this.nearestStorageSideNodeId(storageNodeId);
      return nodeId ? [nodeId] : [];
    }
    return [
      this.storageSideNodeId(storageNodeId, 'left'),
      this.nearestStorageSideNodeId(storageNodeId)
    ].filter((nodeId, index, nodeIds): nodeId is string =>
      nodeId !== null && nodeIds.indexOf(nodeId) === index
    );
  }

  private dispatchVehicleAfterInboundDropoff(vehicle: MutableVehicle): boolean {
    if (vehicle.loaded || vehicle.taskId) {
      return false;
    }
    if (this.dispatchTasklessTopLiftStorageExit(vehicle)) {
      return true;
    }
    if (!this.isInboundOnlyFlow()) {
      return false;
    }

    const route = this.routeToInboundStandby(vehicle);
    if (!route || route.length <= 1 || this.topLiftRouteTerminatesOnColumnAccess(route)) {
      return false;
    }
    this.installTasklessPostDropoffRoute(vehicle, route);
    return true;
  }

  private dispatchVehicleAfterOutboundDropoff(vehicle: MutableVehicle, task: TaskStateRecord): boolean {
    if (
      task.kind !== 'outbound' ||
      !this.topLiftColumnLayoutEnabled() ||
      vehicle.loaded ||
      vehicle.taskId
    ) {
      return false;
    }

    const route = this.outboundLiftDropoffClearanceRoute(vehicle, task);
    if (!route || route.length <= 1) {
      return false;
    }
    this.installTasklessPostDropoffRoute(vehicle, route, 'outbound-lift-dropoff-clearance', 'outbound-lift-clearance');
    return true;
  }

  private outboundLiftDropoffClearanceRoute(vehicle: MutableVehicle, task: TaskStateRecord): string[] | null {
    if (vehicle.currentNodeId !== task.dropoffNodeId) {
      return null;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return null;
    }
    const dropoffBuffer = liftBufferParentNodeId(task.dropoffNodeId);
    if (dropoffBuffer?.kind !== 'outbound' || dropoffBuffer.liftNodeId !== liftNodeId) {
      return null;
    }

    const exitNodeId = liftBufferAccessNodeId(liftNodeId);
    if (!this.layoutNode(exitNodeId) || !this.traffic.findEdge(task.dropoffNodeId, exitNodeId)) {
      return null;
    }
    return [task.dropoffNodeId, exitNodeId];
  }

  private dispatchTasklessTopLiftStorageExit(vehicle: MutableVehicle): boolean {
    if (!this.topLiftColumnLayoutEnabled() || vehicle.loaded || vehicle.taskId || !this.isStorageNode(vehicle.currentNodeId)) {
      return false;
    }
    const postDropoffExitRoute = this.postDropoffColumnExitRoute(vehicle);
    const queuedWorkWaiting = this.topLiftQueuedWorkWaiting();
    const route = postDropoffExitRoute
      ? this.isInboundOnlyFlow() && !queuedWorkWaiting
        ? this.extendPostDropoffExitRouteToStandby(vehicle, postDropoffExitRoute)
        : postDropoffExitRoute
      : null;
    if (!route || route.length <= 1) {
      return false;
    }
    if (this.isInboundOnlyFlow() && !queuedWorkWaiting && this.topLiftRouteTerminatesOnColumnAccess(route)) {
      return false;
    }
    this.installTasklessPostDropoffRoute(vehicle, route);
    return true;
  }

  private topLiftQueuedWorkWaiting(): boolean {
    return this.tasks.some((task) => task.state === 'queued');
  }

  private dispatchTasklessTopLiftStorageExits(): void {
    if (!this.topLiftColumnLayoutEnabled()) {
      return;
    }
    for (const vehicle of this.vehicles) {
      if (
        !vehicle.taskId &&
        !vehicle.loaded &&
        this.isStorageNode(vehicle.currentNodeId) &&
        vehicle.currentEdgeId === null &&
        vehicle.legRemainingM <= 0 &&
        vehicle.phaseRemainingSec <= 0 &&
        !this.tasklessPlannedRouteActive(vehicle) &&
        (this.topLiftTasklessVehicleBlocksInboundColumn(vehicle) || this.topLiftQueuedWorkWaiting())
      ) {
        this.dispatchTasklessTopLiftStorageExit(vehicle);
      }
    }
  }

  private installTasklessPostDropoffRoute(
    vehicle: MutableVehicle,
    route: string[],
    reason = 'inbound-lift-near-storage-standby',
    localRouteReason = 'post-dropoff-column-exit'
  ): void {
    this.clearTasklessRouteReservations(vehicle);
    vehicle.state = 'assigned';
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = route[1] ?? null;
    vehicle.plannedGoalNodeId = route.at(-1) ?? null;
    vehicle.plannedRouteNodeIds = route;
    vehicle.localRouteNodeIds = this.localClaimPrefixForRoute(vehicle.id, route);
    vehicle.localRouteReason = localRouteReason;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.directionSwitchReadyNodeId = null;
    this.logEvent('vehicle-standby-dispatched', vehicle.id, null, null, vehicle.currentNodeId, route[route.length - 1] ?? null, reason, this.vehiclePosition(vehicle), {
      route: route.join('>')
    });
  }

  private extendPostDropoffExitRouteToStandby(vehicle: MutableVehicle, exitRoute: string[]): string[] | null {
    const exitNodeId = exitRoute.at(-1);
    if (!exitNodeId) {
      return this.topLiftRouteTerminatesOnColumnAccess(exitRoute) ? null : exitRoute;
    }
    for (const candidate of this.inboundStandbyNodeCandidates(vehicle.id)) {
      try {
        const standbyRoute = this.planStandbyRoute(exitNodeId, candidate.id);
        if (standbyRoute.length > 1 && this.postDropoffStandbyRouteAcceptable(standbyRoute)) {
          return [...exitRoute, ...standbyRoute.slice(1)];
        }
      } catch {
        continue;
      }
    }
    return this.topLiftRouteTerminatesOnColumnAccess(exitRoute) ? null : exitRoute;
  }

  private postDropoffStandbyRouteAcceptable(routeNodeIds: string[]): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return true;
    }
    const targetNodeId = routeNodeIds.at(-1);
    if (!targetNodeId || !this.isStorageNode(targetNodeId)) {
      return true;
    }

    let storageSuffixCount = 0;
    for (let index = routeNodeIds.length - 1; index >= 0; index -= 1) {
      if (!this.isStorageNode(routeNodeIds[index]!)) {
        break;
      }
      storageSuffixCount += 1;
    }
    return storageSuffixCount <= 4;
  }

  private localClaimPrefixForRoute(vehicleId: string, routeNodeIds: string[], maxNodeCount = 4): string[] {
    if (routeNodeIds.length < 2) {
      return [];
    }
    const prefix = [routeNodeIds[0]!];
    for (const nodeId of routeNodeIds.slice(1)) {
      if (prefix.length >= maxNodeCount) {
        break;
      }
      const occupantId = this.currentNodeOccupancy.get(nodeId);
      const claimedByOtherId = this.nodeClaimedByOtherVehicle(nodeId, vehicleId);
      if ((occupantId && occupantId !== vehicleId) || claimedByOtherId) {
        break;
      }
      prefix.push(nodeId);
    }
    return prefix.length >= 2 ? prefix : [];
  }

  private postDropoffColumnExitRoute(vehicle: MutableVehicle): string[] | null {
    const fromNodeId = vehicle.currentNodeId;
    if (!this.topLiftColumnLayoutEnabled() || !this.isStorageNode(fromNodeId)) {
      return null;
    }
    const exitNodeIds = [
      this.storageSideNodeId(fromNodeId, 'left'),
      ...this.inboundStorageExitNodeCandidates(fromNodeId)
    ].filter((nodeId, index, nodeIds): nodeId is string =>
      nodeId !== null && nodeIds.indexOf(nodeId) === index
    );
    for (const exitNodeId of exitNodeIds) {
      if (exitNodeId === fromNodeId) {
        continue;
      }
      const route = this.topLiftDirectStorageColumnExitRoute(fromNodeId, exitNodeId);
      if (route && this.postDropoffColumnExitRouteClear(vehicle, route)) {
        return route;
      }
    }
    return null;
  }

  private postDropoffColumnExitRouteClear(vehicle: MutableVehicle, routeNodeIds: string[]): boolean {
    for (const nodeId of routeNodeIds.slice(1)) {
      const occupantId = this.currentNodeOccupancy.get(nodeId);
      if (occupantId && occupantId !== vehicle.id) {
        return false;
      }
      const claimantId = this.nodeClaimedByOtherVehicle(nodeId, vehicle.id);
      if (claimantId) {
        return false;
      }
      if (this.storedLoadIdAtNode(nodeId)) {
        return false;
      }
    }
    return true;
  }

  private topLiftDirectStorageColumnExitRoute(fromNodeId: string, exitNodeId: string): string[] | null {
    const position = this.storageGridPosition(fromNodeId);
    const exitMatch = /^column-(top-b|middle|bottom-a)-c(\d+)$/.exec(exitNodeId);
    if (!position || !exitMatch || Number(exitMatch[2]) !== position.column) {
      return null;
    }

    const level = exitMatch[1] as 'top-b' | 'middle' | 'bottom-a';
    const rowsPerZone = this.topLiftColumnRowsPerZone();
    const totalRows = rowsPerZone * 2;
    const route = [fromNodeId];
    const addStorageRow = (row: number): void => {
      route.push(storageNodeId(row - 1, position.column - 1));
    };

    if (level === 'top-b' && position.row <= rowsPerZone) {
      for (let row = position.row - 1; row >= 1; row -= 1) {
        addStorageRow(row);
      }
    } else if (level === 'middle' && position.row <= rowsPerZone) {
      for (let row = position.row + 1; row <= rowsPerZone; row += 1) {
        addStorageRow(row);
      }
    } else if (level === 'middle' && position.row > rowsPerZone) {
      for (let row = position.row - 1; row >= rowsPerZone + 1; row -= 1) {
        addStorageRow(row);
      }
    } else if (level === 'bottom-a' && position.row > rowsPerZone) {
      for (let row = position.row + 1; row <= totalRows; row += 1) {
        addStorageRow(row);
      }
    } else {
      return null;
    }

    route.push(exitNodeId);
    if (route.some((nodeId) => !this.layoutNode(nodeId))) {
      return null;
    }
    for (let index = 1; index < route.length; index += 1) {
      if (!this.traffic.findEdge(route[index - 1]!, route[index]!)) {
        return null;
      }
    }
    return route;
  }

  private routeToInboundStandby(vehicle: MutableVehicle): string[] | null {
    for (const candidate of this.inboundStandbyNodeCandidates(vehicle.id)) {
      try {
        const route = this.planStandbyRoute(vehicle.currentNodeId, candidate.id);
        if (route.length > 1) {
          return route;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private planStandbyRoute(fromNodeId: string, targetNodeId: string): string[] {
    const route: string[] = [fromNodeId];
    const targets: Array<string | null> = this.isStorageNode(targetNodeId)
      ? this.isStorageNode(fromNodeId)
        ? [this.inboundStorageExitNodeId(fromNodeId), this.nearestStorageSideNodeId(targetNodeId), targetNodeId]
        : [this.nearestStorageSideNodeId(targetNodeId), targetNodeId]
      : this.isStorageNode(fromNodeId)
        ? [this.inboundStorageExitNodeId(fromNodeId), targetNodeId]
        : [targetNodeId];

    for (const target of targets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const current = route[route.length - 1]!;
      const blockedNodeIds = this.blockedStorageTransitNodeIds(current, target);
      const segment = this.shortestPath(current, target, blockedNodeIds);
      route.push(...segment.slice(1));
    }
    return route;
  }

  private inboundStandbyNodeCandidates(vehicleId: string): LayoutNode[] {
    const inboundLifts = this.inboundLiftNodes();
    if (inboundLifts.length === 0) {
      return [];
    }

    const vehicle = this.vehicles.find((candidate) => candidate.id === vehicleId) ?? null;
    const storageNodes = this.scenario.layout.nodes.filter((node): node is LayoutNode =>
      node.type === 'storage' && !node.noStop && !node.noParking
    );
    const dedicatedParkingNodes = this.topLiftColumnLayoutEnabled()
      ? this.scenario.layout.nodes.filter((node): node is LayoutNode =>
          node.type === 'parking' && !node.noStop && !node.noParking
        )
      : [];
    const standbyNodes = dedicatedParkingNodes.length > 0
      ? [...dedicatedParkingNodes, ...storageNodes]
      : storageNodes;
    const blockedDropoffNodeIds = this.activeInboundDropoffNodeIds();
    const blockedDropoffColumnKeys = this.activeTopLiftInboundColumnKeys();
    const storedLoadNodeIds = new Set(this.storageNodeLoadOccupancy(false).keys());
    const storedLoadColumnKeys = new Set(
      [...storedLoadNodeIds]
        .map((nodeId) => this.topLiftColumnKey(nodeId))
        .filter((columnKey): columnKey is string => columnKey !== null)
    );
    const claimedStandbyNodeIds = this.claimedTasklessParkableNodeIds(vehicleId);
    const vehicleOffset = (this.vehicleOrdinal(vehicleId) - 1) % inboundLifts.length;
    const liftOrder = inboundLifts.map((_, index) => inboundLifts[(index + vehicleOffset) % inboundLifts.length]!);
    const candidates: LayoutNode[] = [];
    const seenNodeIds = new Set<string>();

    for (const lift of liftOrder) {
      const rankedNodes = standbyNodes
        .filter((node) => node.id !== vehicle?.currentNodeId)
        .filter((node) => !storedLoadNodeIds.has(node.id))
        .filter((node) => !blockedDropoffNodeIds.has(node.id))
        .filter((node) => {
          const columnKey = this.topLiftColumnKey(node.id);
          return !columnKey || !blockedDropoffColumnKeys.has(columnKey);
        })
        .filter((node) => {
          const columnKey = this.topLiftColumnKey(node.id);
          return !columnKey || !storedLoadColumnKeys.has(columnKey);
        })
        .filter((node) => !claimedStandbyNodeIds.has(node.id))
        .filter((node) => {
          const occupantId = this.currentNodeOccupancy.get(node.id);
          return !occupantId || occupantId === vehicleId;
        })
        .map((node) => ({
          node,
          parkingRank: node.type === 'parking' ? 0 : 1,
          distanceM: Math.hypot(node.x - lift.x, node.z - lift.z)
        }))
        .sort((left, right) =>
          this.topLiftStandbyNodeRank(left.node) - this.topLiftStandbyNodeRank(right.node) ||
          left.parkingRank - right.parkingRank ||
          left.distanceM - right.distanceM ||
          left.node.id.localeCompare(right.node.id)
        );

      for (const ranked of rankedNodes) {
        if (seenNodeIds.has(ranked.node.id)) {
          continue;
        }
        seenNodeIds.add(ranked.node.id);
        candidates.push(ranked.node);
      }
    }

    return candidates;
  }

  private inboundLiftNodes(): LayoutNode[] {
    return this.scenario.layout.nodes
      .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private outboundLiftNodes(): LayoutNode[] {
    return this.scenario.layout.nodes
      .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound')
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private activeInboundDropoffNodeIds(): Set<string> {
    return new Set(
      this.activeTasks()
        .filter((task) =>
          task.kind === 'inbound' &&
          this.isStorageNode(task.dropoffNodeId)
        )
        .map((task) => task.dropoffNodeId)
    );
  }

  private activeMovingInboundDropoffNodeIds(): Set<string> {
    return new Set(
      this.activeTasks()
        .filter((task) =>
          task.kind === 'inbound' &&
          (task.state === 'assigned' || task.state === 'in-progress') &&
          this.isStorageNode(task.dropoffNodeId)
        )
        .map((task) => task.dropoffNodeId)
    );
  }

  private activeTopLiftInboundColumnKeys(): Set<string> {
    const activeColumnKeys = new Set<string>();
    if (!this.topLiftColumnLayoutEnabled()) {
      return activeColumnKeys;
    }

    for (const nodeId of this.activeInboundDropoffNodeIds()) {
      const columnKey = this.topLiftColumnKey(nodeId);
      if (columnKey) {
        activeColumnKeys.add(columnKey);
      }
    }

    for (const columnKey of this.clearingTopLiftColumnKeys()) {
      activeColumnKeys.add(columnKey);
    }

    for (const column of this.topLiftOutboundLockedColumns()) {
      activeColumnKeys.add(`c${String(column).padStart(2, '0')}`);
    }

    return activeColumnKeys;
  }

  private activeTopLiftInboundTransitBlockedNodeIds(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    goalNodeId: string
  ): Set<string> {
    const blockedNodeIds = new Set<string>();
    if (!this.topLiftColumnLayoutEnabled() || vehicle.loaded) {
      return blockedNodeIds;
    }

    const activeColumnKeys = new Set<string>();
    for (const nodeId of this.activeMovingInboundDropoffNodeIds()) {
      const columnKey = this.topLiftColumnKey(nodeId);
      if (columnKey) {
        activeColumnKeys.add(columnKey);
      }
    }
    for (const columnKey of this.clearingTopLiftColumnKeys()) {
      activeColumnKeys.add(columnKey);
    }

    if (activeColumnKeys.size === 0) {
      return blockedNodeIds;
    }

    for (const node of this.scenario.layout.nodes) {
      const columnKey = this.topLiftColumnKey(node.id);
      if (
        columnKey &&
        activeColumnKeys.has(columnKey) &&
        (node.type === 'storage' || /^column-middle-c\d+$/.test(node.id))
      ) {
        blockedNodeIds.add(node.id);
      }
    }

    const currentColumnKey = this.topLiftColumnKey(vehicle.currentNodeId);
    if (currentColumnKey && activeColumnKeys.has(currentColumnKey)) {
      for (const node of this.scenario.layout.nodes) {
        if (this.topLiftColumnKey(node.id) === currentColumnKey) {
          blockedNodeIds.delete(node.id);
        }
      }
    }

    blockedNodeIds.delete(vehicle.currentNodeId);
    blockedNodeIds.delete(goalNodeId);
    if (task) {
      blockedNodeIds.delete(task.pickupNodeId);
      blockedNodeIds.delete(task.dropoffNodeId);
    }
    return blockedNodeIds;
  }

  private clearingTopLiftColumnKeys(): Set<string> {
    const clearingColumnKeys = new Set<string>();
    if (!this.topLiftColumnLayoutEnabled()) {
      return clearingColumnKeys;
    }

    for (const vehicle of this.vehicles) {
      if (vehicle.loaded || vehicle.taskId || vehicle.localRouteReason !== 'post-dropoff-column-exit') {
        continue;
      }
      for (const nodeId of [vehicle.currentNodeId, vehicle.targetNodeId]) {
        if (!nodeId) {
          continue;
        }
        const columnKey = this.topLiftColumnKey(nodeId);
        if (columnKey) {
          clearingColumnKeys.add(columnKey);
        }
      }
    }

    return clearingColumnKeys;
  }

  private claimedTasklessParkableNodeIds(vehicleId: string): Set<string> {
    const claimed = new Set<string>();
    for (const vehicle of this.vehicles) {
      if (vehicle.id === vehicleId || vehicle.taskId || vehicle.loaded) {
        continue;
      }
      const routeTargetNodeId = vehicle.routeNodeIds.at(-1) ?? null;
      for (const nodeId of [vehicle.currentNodeId, vehicle.targetNodeId, routeTargetNodeId]) {
        const node = nodeId ? this.layoutNode(nodeId) : null;
        if (node && (node.type === 'storage' || node.type === 'parking')) {
          claimed.add(node.id);
        }
      }
    }
    return claimed;
  }

  private isInboundOnlyFlow(): boolean {
    return this.scenario.taskGeneration.inboundRatePerHour > 0 && this.scenario.taskGeneration.outboundRatePerHour <= 0;
  }

  private topLiftColumnLayoutEnabled(): boolean {
    return isTopLiftColumnLayout(this.scenario);
  }

  private vehicleOrdinal(vehicleId: string): number {
    return Math.max(1, Number(vehicleId.replace(/\D+/g, '')) || 1);
  }

  private storageSideNodeId(storageNodeId: string, side: 'left' | 'right'): string | null {
    const match = /^storage-r(\d+)-c\d+$/.exec(storageNodeId);
    if (!match) {
      return null;
    }
    if (this.topLiftColumnLayoutEnabled()) {
      const position = this.storageGridPosition(storageNodeId);
      if (!position) {
        return null;
      }
      const rowsPerZone = this.topLiftColumnRowsPerZone();
      const upperBank = position.row <= rowsPerZone;
      const columnIndex = position.column - 1;
      const nodeId = upperBank
        ? side === 'right'
          ? columnAccessNodeId('top-b', columnIndex)
          : columnAccessNodeId('middle', columnIndex)
        : side === 'right'
          ? columnAccessNodeId('middle', columnIndex)
          : columnAccessNodeId('bottom-a', columnIndex);
      return this.layoutNodeIds.has(nodeId) ? nodeId : null;
    }
    const sideNodeId = `${side}-row-${match[1]}`;
    return this.layoutNodeIds.has(sideNodeId) ? sideNodeId : null;
  }

  private nearestStorageSideNodeId(storageNodeId: string): string | null {
    if (this.topLiftColumnLayoutEnabled()) {
      return this.storageSideNodeId(storageNodeId, 'right') ?? this.storageSideNodeId(storageNodeId, 'left');
    }
    const position = this.storageGridPosition(storageNodeId);
    if (!position) {
      return null;
    }
    const maxColumn = Math.max(
      position.column,
      ...this.scenario.layout.nodes
        .map((node) => this.storageGridPosition(node.id)?.column ?? 0)
    );
    const preferredSide = position.column <= (maxColumn + 1) / 2 ? 'left' : 'right';
    return this.storageSideNodeId(storageNodeId, preferredSide) ?? this.storageSideNodeId(storageNodeId, preferredSide === 'left' ? 'right' : 'left');
  }

  private blockedStorageTransitNodeIds(
    fromNodeId: string,
    targetNodeId: string,
    options: { blockStoredLoads?: boolean } = {}
  ): Set<string> {
    const cacheKey = `${fromNodeId}>${targetNodeId}`;
    let baseBlockedNodeIds = this.blockedStorageTransitBaseCache.get(cacheKey);
    if (!baseBlockedNodeIds) {
      const allowedNodeIds = new Set([fromNodeId, targetNodeId]);
      baseBlockedNodeIds = new Set<string>();
      const fromRowLabel = this.nodeStorageRowLabel(fromNodeId);
      const targetRowLabel = this.nodeStorageRowLabel(targetNodeId);
      const fromIsStorage = this.isStorageNode(fromNodeId);
      const targetIsStorage = this.isStorageNode(targetNodeId);
      const allowStorageTransitRows = new Set<string>();
      if (fromIsStorage && fromRowLabel) {
        allowStorageTransitRows.add(fromRowLabel);
      }
      if (targetIsStorage && targetRowLabel) {
        allowStorageTransitRows.add(targetRowLabel);
      }

      for (const nodeId of this.storageNodeIds) {
        const rowLabel = this.nodeStorageRowLabel(nodeId);
        if (!allowedNodeIds.has(nodeId) && (!rowLabel || !allowStorageTransitRows.has(rowLabel))) {
          baseBlockedNodeIds.add(nodeId);
        }
      }
      this.blockedStorageTransitBaseCache.set(cacheKey, baseBlockedNodeIds);
    }

    const blockedNodeIds = new Set(baseBlockedNodeIds);
    if (options.blockStoredLoads) {
      const allowedNodeIds = new Set([fromNodeId, targetNodeId]);
      for (const [nodeId] of this.storageNodeLoadOccupancy(false)) {
        if (!allowedNodeIds.has(nodeId)) {
          blockedNodeIds.add(nodeId);
        }
      }
    }

    return blockedNodeIds;
  }

  private shortestPath(fromNodeId: string, toNodeId: string, blockedNodeIds = new Set<string>()): string[] {
    if (fromNodeId === toNodeId) {
      return [fromNodeId];
    }

    const open = new MinPriorityQueue();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[fromNodeId, 0]]);
    open.push({ nodeId: fromNodeId, priority: 0 });

    while (open.size > 0) {
      const next = open.pop();
      if (!next) {
        break;
      }
      const current = next.nodeId;
      if (next.priority > (gScore.get(current) ?? Infinity) + 1e-9) {
        continue;
      }
      if (current === toNodeId) {
        const path = [current];
        while (cameFrom.has(path[0]!)) {
          path.unshift(cameFrom.get(path[0]!)!);
        }
        return path;
      }

      for (const neighbor of this.neighbors(current)) {
        if (blockedNodeIds.has(neighbor.nodeId)) {
          continue;
        }
        if (this.topLiftColumnLayoutEnabled() && !this.agentEdgeDirectionAllowed(current, neighbor.nodeId, toNodeId)) {
          continue;
        }
        if (neighbor.nodeId !== toNodeId && this.layoutNode(neighbor.nodeId)?.type === 'lift-blackbox') {
          continue;
        }
        const tentative = (gScore.get(current) ?? Infinity) + this.agentEdgeCostM(current, neighbor.nodeId, neighbor.lengthM, toNodeId);
        if (tentative < (gScore.get(neighbor.nodeId) ?? Infinity)) {
          cameFrom.set(neighbor.nodeId, current);
          gScore.set(neighbor.nodeId, tentative);
          open.push({ nodeId: neighbor.nodeId, priority: tentative });
        }
      }
    }

    throw new Error(`No route between ${fromNodeId} and ${toNodeId}`);
  }

  private agentShortestPath(fromNodeId: string, toNodeId: string, blockedNodeIds = new Set<string>()): string[] {
    if (fromNodeId === toNodeId) {
      return [fromNodeId];
    }

    const open = new MinPriorityQueue();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[fromNodeId, 0]]);
    open.push({ nodeId: fromNodeId, priority: 0 });

    while (open.size > 0) {
      const next = open.pop();
      if (!next) {
        break;
      }
      const current = next.nodeId;
      if (next.priority > (gScore.get(current) ?? Infinity) + 1e-9) {
        continue;
      }
      if (current === toNodeId) {
        const path = [current];
        while (cameFrom.has(path[0]!)) {
          path.unshift(cameFrom.get(path[0]!)!);
        }
        return path;
      }

      for (const neighbor of this.agentNeighbors(current, toNodeId)) {
        if (blockedNodeIds.has(neighbor.nodeId)) {
          continue;
        }
        if (neighbor.nodeId !== toNodeId && this.layoutNode(neighbor.nodeId)?.type === 'lift-blackbox') {
          continue;
        }
        const tentative = (gScore.get(current) ?? Infinity) + this.agentEdgeCostM(current, neighbor.nodeId, neighbor.lengthM, toNodeId);
        if (tentative < (gScore.get(neighbor.nodeId) ?? Infinity)) {
          cameFrom.set(neighbor.nodeId, current);
          gScore.set(neighbor.nodeId, tentative);
          open.push({ nodeId: neighbor.nodeId, priority: tentative });
        }
      }
    }

    throw new Error(`No route between ${fromNodeId} and ${toNodeId}`);
  }

  private neighbors(nodeId: string): Array<{ nodeId: string; lengthM: number }> {
    return this.neighborByNodeId.get(nodeId) ?? [];
  }

  private agentNeighbors(nodeId: string, goalNodeId: string): Array<{ nodeId: string; lengthM: number }> {
    return this.neighbors(nodeId)
      .filter((neighbor) => this.agentLiftStorageTransferAllowed(nodeId, neighbor.nodeId, goalNodeId))
      .filter((neighbor) => this.agentEdgeDirectionAllowed(nodeId, neighbor.nodeId, goalNodeId))
      .map((neighbor) => ({
        ...neighbor,
        lengthM: this.agentEdgeCostM(nodeId, neighbor.nodeId, neighbor.lengthM, goalNodeId)
      }));
  }

  private agentLiftStorageTransferAllowed(fromNodeId: string, toNodeId: string, goalNodeId: string): boolean {
    const fromTransferLiftId = this.liftStorageTransferTargetLiftId(fromNodeId);
    const toTransferLiftId = this.liftStorageTransferTargetLiftId(toNodeId);
    if (toTransferLiftId && toTransferLiftId !== goalNodeId) {
      return false;
    }
    if (fromTransferLiftId && this.layoutNode(toNodeId)?.type === 'lift-blackbox' && fromTransferLiftId !== goalNodeId) {
      return false;
    }
    return true;
  }

  private liftStorageTransferTargetLiftId(nodeId: string): string | null {
    const match = /^(.*)-row-\d{2}-transfer$/.exec(nodeId);
    return match?.[1] ?? null;
  }

  private agentEdgeCostM(fromNodeId: string, toNodeId: string, lengthM: number, goalNodeId: string): number {
    if (this.topLiftColumnLayoutEnabled()) {
      const goalNode = this.layoutNode(goalNodeId);
      if (
        goalNode?.type !== 'storage' &&
        goalNodeId !== fromNodeId &&
        goalNodeId !== toNodeId &&
        (this.isStorageNode(fromNodeId) || this.isStorageNode(toNodeId))
      ) {
        return lengthM + 8;
      }
      const liftPortTransit = (nodeId: string): boolean => /^lift-\d+-(?:inbound|outbound)(?:$|-)/.test(nodeId);
      if (
        (liftPortTransit(fromNodeId) || liftPortTransit(toNodeId)) &&
        goalNodeId !== fromNodeId &&
        goalNodeId !== toNodeId
      ) {
        return lengthM + 5;
      }
      if (
        goalNode?.type !== 'storage' &&
        goalNodeId !== fromNodeId &&
        goalNodeId !== toNodeId &&
        (isTopLiftAisleLevelNodeId(fromNodeId, 'middle') || isTopLiftAisleLevelNodeId(toNodeId, 'middle'))
      ) {
        return lengthM + 20;
      }
    }
    const edgeKey = [fromNodeId, toNodeId].sort().join('>');
    if (
      (edgeKey === 'left-top>right-top' || edgeKey === 'left-bottom>right-bottom') &&
      goalNodeId !== fromNodeId &&
      goalNodeId !== toNodeId
    ) {
      return lengthM + 1000;
    }
    return lengthM;
  }

  private topLiftDoubleLaneDirectionAllowed(fromNodeId: string, toNodeId: string): boolean | null {
    const fromLevel = topLiftAisleLevel(fromNodeId);
    const toLevel = topLiftAisleLevel(toNodeId);
    if (!fromLevel || fromLevel !== toLevel || fromLevel === 'middle') {
      return null;
    }

    const preferredDirection =
      fromLevel === 'top-a' || fromLevel === 'bottom-a' ? 1 :
      fromLevel === 'top-b' || fromLevel === 'bottom-b' ? -1 :
      0;
    if (preferredDirection === 0) {
      return null;
    }

    const fromNode = this.layoutNode(fromNodeId);
    const toNode = this.layoutNode(toNodeId);
    if (!fromNode || !toNode) {
      return null;
    }

    const dx = Math.sign(toNode.x - fromNode.x);
    if (dx === 0) {
      return true;
    }
    return dx === preferredDirection;
  }

  private agentEdgeDirectionAllowed(fromNodeId: string, toNodeId: string, goalNodeId: string): boolean {
    if (this.topLiftColumnLayoutEnabled()) {
      if (toNodeId === goalNodeId) {
        return true;
      }
      return this.topLiftDoubleLaneDirectionAllowed(fromNodeId, toNodeId) ?? true;
    }
    const fromMain = /^main-(north|south)-(\d+)$/.exec(fromNodeId);
    const toMain = /^main-(north|south)-(\d+)$/.exec(toNodeId);
    if (!fromMain || !toMain || fromMain[1] !== toMain[1]) {
      return true;
    }
    const fromIndex = Number(fromMain[2]);
    const toIndex = Number(toMain[2]);
    const preferredDirection = fromMain[1] === 'north' ? toIndex >= fromIndex : toIndex <= fromIndex;
    if (preferredDirection) {
      return true;
    }
    const goalNode = this.layoutNode(goalNodeId);
    const goalIsLiftPort = goalNode?.type === 'inbound' || goalNode?.type === 'outbound' || goalNode?.type === 'lift-blackbox';
    return goalIsLiftPort && this.neighbors(toNodeId).some((neighbor) => neighbor.nodeId === goalNodeId);
  }

  private rebuildGraphNeighbors(): void {
    const nodes = new Set(this.scenario.layout.nodes.map((node) => node.id));
    const byNode = new Map<string, Array<{ nodeId: string; lengthM: number }>>();
    const addNeighbor = (from: string, to: string, lengthM: number): void => {
      if (!nodes.has(from) || !nodes.has(to)) {
        return;
      }
      const neighbors = byNode.get(from) ?? [];
      neighbors.push({ nodeId: to, lengthM });
      byNode.set(from, neighbors);
    };

    for (const edge of this.scenario.layout.edges) {
      if (!this.isAllowedStorageTraversalEdge(edge)) {
        continue;
      }
      addNeighbor(edge.from, edge.to, edge.lengthM);
      if (edge.directionMode === 'twoWay') {
        addNeighbor(edge.to, edge.from, edge.lengthM);
      }
    }

    this.neighborByNodeId = new Map(
      [...byNode.entries()].map(([id, neighbors]) => [
        id,
        neighbors.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      ])
    );
  }

  private isAllowedStorageTraversalEdge(edge: LayoutEdge): boolean {
    if (!this.isStorageNode(edge.from) || !this.isStorageNode(edge.to)) {
      return true;
    }
    return this.nodeStorageRowLabel(edge.from) === this.nodeStorageRowLabel(edge.to);
  }

  private parkingNodeFor(vehicleId: string): string {
    const parkingNodes = this.parkableNodeCandidates();
    if (parkingNodes.length === 0) {
      const fallbackNode = this.scenario.layout.nodes.find((node) => !node.noParking && !node.noStop) ?? this.scenario.layout.nodes[0];
      if (!fallbackNode) {
        throw new Error('Scenario has no nodes available for vehicle parking.');
      }
      return fallbackNode.id;
    }
    const vehicleNumber = Number(vehicleId.replace(/\D+/g, '')) || 1;
    return parkingNodes[(vehicleNumber - 1) % parkingNodes.length]!.id;
  }

  private parkableNodeCandidates(): ShuttleScenario['layout']['nodes'] {
    const isParkableStorage = (node: ShuttleScenario['layout']['nodes'][number]): boolean =>
      node.type === 'storage' && !node.noStop && !node.noParking;
    const dedicatedParking = this.scenario.layout.nodes
      .filter((node) => node.type === 'parking' && !node.noStop && !node.noParking)
      .sort((left, right) => {
        const parkingRank = (nodeId: string): number => isTopLiftQueueParkingNodeId(nodeId) ? 0 : nodeId.startsWith('parking-') ? 1 : 2;
        return parkingRank(left.id) - parkingRank(right.id) || left.id.localeCompare(right.id);
      });
    const temporaryStorageParking = this.scenario.layout.nodes
      .filter(isParkableStorage)
      .sort((left, right) => {
        const leftPosition = this.storageGridPosition(left.id);
        const rightPosition = this.storageGridPosition(right.id);
        return (
          (leftPosition?.column ?? 0) - (rightPosition?.column ?? 0) ||
          (rightPosition?.row ?? 0) - (leftPosition?.row ?? 0) ||
          left.id.localeCompare(right.id)
        );
      });
    if (this.isInboundOnlyFlow() && this.topLiftColumnLayoutEnabled() && dedicatedParking.length > 0) {
      return [...dedicatedParking, ...temporaryStorageParking];
    }
    if (this.isInboundOnlyFlow()) {
      const inboundStandbyStorage = this.inboundInitialParkingCandidates(temporaryStorageParking);
      const standbyIds = new Set(inboundStandbyStorage.map((node) => node.id));
      const initialSkuParkingBlockedColumns = this.topLiftInitialSkuParkingBlockedColumns();
      const blocksInitialSkuColumn = (node: ShuttleScenario['layout']['nodes'][number]): boolean =>
        initialSkuParkingBlockedColumns.has(this.storageGridPosition(node.id)?.column ?? 0);
      const overflowStorage = temporaryStorageParking.filter((node) => !standbyIds.has(node.id) && !blocksInitialSkuColumn(node));
      const lastResortInitialSkuStorage = temporaryStorageParking.filter((node) => !standbyIds.has(node.id) && blocksInitialSkuColumn(node));
      return [
        ...inboundStandbyStorage,
        ...overflowStorage,
        ...dedicatedParking,
        ...lastResortInitialSkuStorage
      ];
    }
    return [...dedicatedParking, ...temporaryStorageParking];
  }

  private topLiftStandbyNodeRank(node: LayoutNode): number {
    if (isTopLiftQueueParkingNodeId(node.id)) {
      return 0;
    }
    if (node.type === 'storage') {
      return 1;
    }
    if (node.type === 'parking') {
      return 2;
    }
    return 3;
  }

  private inboundInitialParkingCandidates(storageNodes: ShuttleScenario['layout']['nodes']): ShuttleScenario['layout']['nodes'] {
    const inboundLifts = this.inboundLiftNodes();
    if (inboundLifts.length === 0 || storageNodes.length === 0) {
      return [];
    }

    const initialSkuParkingBlockedColumns = this.topLiftInitialSkuParkingBlockedColumns();
    const candidateStorageNodes = initialSkuParkingBlockedColumns.size === 0
      ? storageNodes
      : storageNodes.filter((node) => !initialSkuParkingBlockedColumns.has(this.storageGridPosition(node.id)?.column ?? 0));
    const candidates: ShuttleScenario['layout']['nodes'] = [];
    const seenNodeIds = new Set<string>();
    for (const lift of inboundLifts) {
      const ranked = candidateStorageNodes
        .filter((node) => !seenNodeIds.has(node.id))
        .map((node) => ({
          node,
          distanceM: Math.abs(node.x - lift.x) + Math.abs(node.z - lift.z)
        }))
        .sort((left, right) => left.distanceM - right.distanceM || left.node.id.localeCompare(right.node.id));
      const selected = ranked[0]?.node;
      if (selected) {
        seenNodeIds.add(selected.id);
        candidates.push(selected);
      }
    }

    return candidates;
  }

  private zonesForNode(nodeId: string): ShuttleScenario['layout']['zones'] {
    return this.scenario.layout.zones.filter((zone) => zone.nodeIds.includes(nodeId));
  }

  private axisForEdge(edge: ShuttleScenario['layout']['edges'][number]): 'x' | 'z' | null {
    const from = nodePosition(this.scenario, edge.from);
    const to = nodePosition(this.scenario, edge.to);
    const dx = Math.abs(to.x - from.x);
    const dz = Math.abs(to.z - from.z);
    if (dx <= 1e-9 && dz <= 1e-9) {
      return null;
    }
    return dx >= dz ? 'x' : 'z';
  }

  private releaseNodeOccupancy(vehicle: MutableVehicle, nodeId: string): void {
    if (this.currentNodeOccupancy.get(nodeId) === vehicle.id) {
      this.currentNodeOccupancy.delete(nodeId);
    }
    this.releaseZoneHoldReservations(vehicle);
  }

  private occupyNode(vehicle: MutableVehicle, nodeId: string): void {
    this.currentNodeOccupancy.set(nodeId, vehicle.id);
    this.ensureZoneHoldReservation(vehicle, nodeId);
  }

  private ensureZoneHoldReservation(vehicle: MutableVehicle, nodeId: string): void {
    if (this.agentSimpleEnabled()) {
      return;
    }
    this.releaseZoneHoldReservations(vehicle);
    const holdZones = this.zonesForNode(nodeId).filter((zone) => zone.noStop || zone.noParking);
    if (holdZones.length === 0) {
      return;
    }
    const startTimeSec = this.simTimeSec;
    const endTimeSec = round(
      this.simTimeSec + Math.max(this.scenario.timeStepSec, this.scenario.trafficPolicy.minimumClearanceSec) + 1e-6
    );
    const priority = this.priorityFor(vehicle);
    for (const zone of holdZones) {
      this.installLocalZoneHoldReservation(ReservationSchema.parse({
        id: `local-hold-${vehicle.id}-${zone.id}-${String(Math.round(this.simTimeSec * 1000)).padStart(8, '0')}`,
        resourceType: 'zone',
        resourceId: zone.id,
        vehicleId: vehicle.id,
        taskId: vehicle.taskId,
        startTimeSec,
        endTimeSec,
        priority,
        conflictGroup: zone.conflictGroup ?? null,
        reasonCode: 'local-zone-occupancy'
      }));
    }
  }

  private installLocalZoneHoldReservation(hold: Reservation): void {
    let installedHold = hold;
    const retained: Reservation[] = [];
    for (const existing of this.reservations) {
      const conflicts =
        this.reservationWindowsOverlap(existing, installedHold) &&
        this.reservationsShareBlockingResource(existing, installedHold);
      if (!conflicts) {
        retained.push(existing);
        continue;
      }
      if (
        existing.vehicleId === installedHold.vehicleId &&
        this.reservationsShareExactResource(existing, installedHold)
      ) {
        installedHold = this.mergeSelfReservationWindows(existing, installedHold);
        continue;
      }
      if (existing.reasonCode !== 'local-zone-occupancy') {
        continue;
      }
      retained.push(existing);
    }
    this.reservations = [...retained, installedHold];
  }

  private releaseZoneHoldReservations(vehicle: MutableVehicle): void {
    this.reservations = this.reservations.filter(
      (reservation) =>
        !(
          (reservation.reasonCode === 'zone-hold' || reservation.reasonCode === 'local-zone-occupancy') &&
          reservation.vehicleId === vehicle.id &&
          reservation.resourceType === 'zone'
        )
    );
  }

  private shouldLogVehicleWait(
    vehicle: MutableVehicle,
    targetNodeId: string,
    waitReason: string,
    blockingReservationId: string | null,
    blockingVehicleId: string | null
  ): boolean {
    return (
      vehicle.state !== 'waiting-blocked' ||
      vehicle.targetNodeId !== targetNodeId ||
      vehicle.waitReason !== waitReason ||
      vehicle.blockingReservationId !== blockingReservationId ||
      vehicle.blockingVehicleId !== blockingVehicleId
    );
  }

  private predictedFootprintOverlapVehicleId(
    vehicle: MutableVehicle,
    x: number,
    z: number,
    ignoredVehicleIds = new Set<string>()
  ): string | null {
    const predictedPose = { x, z, yaw: vehicle.yaw };
    const blocker = this.vehicles.find((other) =>
      other.id !== vehicle.id &&
      !ignoredVehicleIds.has(other.id) &&
      vehicleFootprintsOverlap(predictedPose, other, this.scenario.vehicles)
    );
    return blocker?.id ?? null;
  }

  private predictedSweptFootprintOverlapVehicleId(
    vehicle: MutableVehicle,
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    ignoredVehicleIds = new Set<string>()
  ): string | null {
    const distanceM = Math.hypot(toX - fromX, toZ - fromZ);
    const sampleSpacingM = Math.max(0.05, Math.min(0.2, this.scenario.vehicles.lengthM / 4));
    const steps = Math.max(1, Math.ceil(distanceM / sampleSpacingM));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = round(fromX + (toX - fromX) * ratio);
      const z = round(fromZ + (toZ - fromZ) * ratio);
      const blockerId = this.predictedFootprintOverlapVehicleId(vehicle, x, z, ignoredVehicleIds);
      if (blockerId) {
        return blockerId;
      }
    }
    return null;
  }

  private advanceVehicles(dtSec: number): void {
    if (this.agentSimpleEnabled()) {
      this.advanceVehiclesAgentSimple(dtSec);
      return;
    }

    const sortedVehicles = [...this.vehicles].sort((left, right) => left.id.localeCompare(right.id));
    for (const vehicle of sortedVehicles) {
      if (vehicle.state === 'idle') {
        vehicle.idleTimeSec = round(vehicle.idleTimeSec + dtSec);
        continue;
      }
      vehicle.busyTimeSec = round(vehicle.busyTimeSec + dtSec);
      this.accrueVehicleWorkBreakdown(vehicle, dtSec);

      if (vehicle.state === 'lifting' || vehicle.state === 'lowering' || vehicle.state === 'parking') {
        this.advanceTimedPhase(vehicle, dtSec);
        continue;
      }

      if (!vehicle.currentEdgeId && vehicle.legRemainingM <= 0 && vehicle.phaseRemainingSec > 0) {
        this.advanceDirectionSwitchPhase(vehicle, dtSec);
        continue;
      }

      if (vehicle.legRemainingM > 0) {
        this.advanceMovement(vehicle, dtSec);
        continue;
      }

      this.startNextLeg(vehicle, dtSec);
    }
  }

  private advanceVehiclesAgentSimple(dtSec: number): void {
    const vehicles = [...this.vehicles].sort((left, right) =>
      this.agentTurnPriority(right) - this.agentTurnPriority(left) ||
      left.id.localeCompare(right.id)
    );

    for (const vehicle of vehicles) {
      if (vehicle.state === 'idle' && !vehicle.taskId) {
        if (
          this.topLiftTasklessVehicleBlocksInboundColumn(vehicle) &&
          this.dispatchTasklessTopLiftStorageExit(vehicle)
        ) {
          continue;
        }
        if (vehicle.routeNodeIds.length === 0) {
          if (this.dispatchTasklessTopLiftStorageExit(vehicle)) {
            continue;
          }
        }
        if (this.topLiftColumnLayoutEnabled() && this.layoutNode(vehicle.currentNodeId)?.noParking) {
          this.startNextLegAgentSimple(vehicle, dtSec);
          continue;
        }
        vehicle.idleTimeSec = round(vehicle.idleTimeSec + dtSec);
        continue;
      }

      vehicle.busyTimeSec = round(vehicle.busyTimeSec + dtSec);
      this.accrueVehicleWorkBreakdown(vehicle, dtSec);

      if (vehicle.state === 'lifting' || vehicle.state === 'lowering' || vehicle.state === 'parking') {
        this.advanceTimedPhase(vehicle, dtSec);
        continue;
      }

      if (!vehicle.currentEdgeId && vehicle.legRemainingM <= 0 && vehicle.phaseRemainingSec > 0) {
        this.advanceDirectionSwitchPhase(vehicle, dtSec);
        continue;
      }

      if (vehicle.legRemainingM > 0) {
        this.advanceMovement(vehicle, dtSec);
        continue;
      }

      this.startNextLegAgentSimple(vehicle, dtSec);
    }
  }

  private accrueVehicleWorkBreakdown(vehicle: MutableVehicle, dtSec: number): void {
    const moving =
      vehicle.currentEdgeId !== null ||
      vehicle.legRemainingM > 0 ||
      vehicle.state === 'moving-to-pickup' ||
      vehicle.state === 'loaded-moving' ||
      vehicle.state === 'returning';
    if (moving) {
      vehicle.movingTimeSec = round(vehicle.movingTimeSec + dtSec);
    }
    if (vehicle.state === 'lifting' || vehicle.state === 'lowering') {
      vehicle.handlingTimeSec = round(vehicle.handlingTimeSec + dtSec);
    }
    if (!vehicle.taskId && !vehicle.loaded && (moving || vehicle.state === 'assigned' || vehicle.state === 'returning')) {
      vehicle.tasklessTravelTimeSec = round(vehicle.tasklessTravelTimeSec + dtSec);
    }
  }

  private advanceTimedPhase(vehicle: MutableVehicle, dtSec: number): void {
    vehicle.phaseRemainingSec = round(Math.max(0, vehicle.phaseRemainingSec - dtSec));
    vehicle.speedMps = 0;
    if (vehicle.phaseRemainingSec > 0) {
      return;
    }

    const task = this.taskById(vehicle.taskId);
    if (vehicle.state === 'lifting' && task) {
      vehicle.loaded = true;
      const load = this.loadById(task.loadId);
      if (load) {
        this.setLoadPlacement(load, 'carried', null, vehicle.id);
      }
      vehicle.state = 'assigned';
      this.logEvent('lift-complete', vehicle.id, task.id, task.loadId, task.pickupNodeId, vehicle.currentNodeId, 'lift-time-elapsed', this.vehiclePosition(vehicle), {});
      const loadedDispatchGoalNodeId = this.taskDispatchGoalNodeId(task, vehicle);
      if (this.agentRefreshEnabled()) {
        const route = this.installAgentRefreshPlannedRoute(vehicle, task, loadedDispatchGoalNodeId);
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        vehicle.directionSwitchReadyNodeId = null;
        this.logEvent('route-replanned', vehicle.id, task.id, task.loadId, vehicle.currentNodeId, route.at(-1) ?? null, 'loaded-shortest-path', this.vehiclePosition(vehicle), {
          route: route.join('>')
        });
        return;
      }
      if (this.agentMinimalEnabled()) {
        const route = this.installAgentTaskRoute(vehicle, task, loadedDispatchGoalNodeId);
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        vehicle.directionSwitchReadyNodeId = null;
        this.logEvent('route-replanned', vehicle.id, task.id, task.loadId, vehicle.currentNodeId, route.at(-1) ?? null, 'loaded-shortest-path', this.vehiclePosition(vehicle), {
          route: route.join('>')
        });
        return;
      }
      if (this.agentSimpleEnabled()) {
        this.resetNavigationAtCurrentNode(vehicle);
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        vehicle.directionSwitchReadyNodeId = null;
        return;
      }
      const directLoadedRoute = this.planLoadedRouteToDropoff(vehicle.currentNodeId, task);
      vehicle.routeNodeIds = directLoadedRoute;
      vehicle.routeIndex = 0;
      vehicle.targetNodeId = directLoadedRoute[1] ?? null;
      vehicle.directionSwitchReadyNodeId = null;
      this.logEvent('route-replanned', vehicle.id, task.id, task.loadId, vehicle.currentNodeId, directLoadedRoute.at(-1) ?? null, 'loaded-shortest-path', this.vehiclePosition(vehicle), {
        route: directLoadedRoute.join('>')
      });
      return;
    }

    if (vehicle.state === 'lowering' && task) {
      vehicle.loaded = false;
      const load = this.loadById(task.loadId);
      if (load) {
        this.setLoadPlacement(load, task.kind === 'inbound' ? 'stored' : 'delivered', task.dropoffNodeId, null);
      }
      this.setTaskState(task, 'completed');
      task.completedAtSec = this.simTimeSec;
      this.completedTaskCycleTimes.push(task.completedAtSec - task.createdAtSec);
      this.completedTaskWaitTimes.push((task.assignedAtSec ?? task.createdAtSec) - task.createdAtSec);
      if (task.kind === 'inbound') this.completedInbound += 1;
      if (task.kind === 'outbound') this.completedOutbound += 1;
      this.recordLiftPortCompletion(task);
      this.refreshTopLiftColumnFlowModes();
      this.logEvent('task-completed', vehicle.id, task.id, task.loadId, task.pickupNodeId, task.dropoffNodeId, 'lower-complete', this.vehiclePosition(vehicle), {
        kind: task.kind
      });
      vehicle.taskId = null;
      if (this.dispatchVehicleAfterOutboundDropoff(vehicle, task)) {
        return;
      }
      if (this.agentSimpleModeEnabled()) {
        this.clearTasklessRouteReservations(vehicle);
        vehicle.state = 'idle';
        this.resetNavigationAtCurrentNode(vehicle);
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        vehicle.directionSwitchReadyNodeId = null;
        return;
      }
      if (task.kind === 'inbound' && this.isStorageNode(vehicle.currentNodeId)) {
        if (this.dispatchVehicleAfterInboundDropoff(vehicle)) {
          return;
        }
        vehicle.state = 'idle';
        vehicle.routeNodeIds = [vehicle.currentNodeId];
        vehicle.routeIndex = 0;
        vehicle.targetNodeId = null;
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        vehicle.directionSwitchReadyNodeId = null;
        return;
      }
      vehicle.state = 'assigned';
      return;
    }

    if (vehicle.state === 'parking') {
      vehicle.state = 'idle';
      vehicle.routeNodeIds = [];
      vehicle.routeIndex = 0;
      vehicle.targetNodeId = null;
      vehicle.currentEdgeId = null;
      vehicle.legRemainingM = 0;
      vehicle.legElapsedSec = 0;
      vehicle.legTravelSec = 0;
      vehicle.phaseRemainingSec = 0;
      vehicle.targetSpeedMps = 0;
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      vehicle.directionSwitchReadyNodeId = null;
      this.logEvent('vehicle-parked', vehicle.id, null, null, vehicle.currentNodeId, null, 'idle-parking', this.vehiclePosition(vehicle), {});
    }
  }

  private advanceDirectionSwitchPhase(vehicle: MutableVehicle, dtSec: number): void {
    vehicle.phaseRemainingSec = round(Math.max(0, vehicle.phaseRemainingSec - dtSec));
    vehicle.speedMps = 0;
    if (vehicle.phaseRemainingSec > 0) {
      return;
    }

    vehicle.directionSwitchReadyNodeId = vehicle.currentNodeId;
    this.logEvent('direction-switch-complete', vehicle.id, vehicle.taskId, null, vehicle.currentNodeId, vehicle.targetNodeId, 'switch-direction-elapsed', this.vehiclePosition(vehicle), {});
  }

  private startNextLegAgentSimple(vehicle: MutableVehicle, dtSec: number): void {
    const fromNodeId = vehicle.currentNodeId;
    const task = this.taskForVehicle(vehicle);

    if (task && fromNodeId === task.pickupNodeId && !vehicle.loaded) {
      if (!this.inboundTaskLoadReadyAtPickup(task)) {
        if (!this.inboundPickupClearanceRouteActive(vehicle, task)) {
          if (this.rerouteInboundPickupVehicleBehindEarlierTask(vehicle, task)) {
            return;
          }
          this.waitForInboundPickupLoad(vehicle, task, dtSec);
          return;
        }
      } else {
        this.setTaskState(task, 'in-progress');
        task.startedAtSec ??= this.simTimeSec;
        vehicle.state = 'lifting';
        vehicle.speedMps = 0;
        vehicle.phaseRemainingSec = this.scenario.physicsParams.liftTimeSec;
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        this.logEvent('lift-started', vehicle.id, task.id, task.loadId, fromNodeId, fromNodeId, 'pickup-aligned', this.vehiclePosition(vehicle), {});
        return;
      }
    }

    if (task && fromNodeId === task.dropoffNodeId && vehicle.loaded) {
      vehicle.state = 'lowering';
      vehicle.speedMps = 0;
      vehicle.phaseRemainingSec = this.scenario.physicsParams.lowerTimeSec;
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      this.logEvent('lower-started', vehicle.id, task.id, task.loadId, fromNodeId, fromNodeId, 'dropoff-aligned', this.vehiclePosition(vehicle), {});
      return;
    }

    if (
      (this.agentMinimalEnabled() || this.agentRefreshEnabled()) &&
      vehicle.yieldHoldUntilSec !== null &&
      (vehicle.yieldHoldNodeId === null || vehicle.yieldHoldNodeId === fromNodeId)
    ) {
      const refreshHoldBlock = this.agentRefreshYieldHoldBlocker(vehicle, task);
      if (this.agentRefreshEnabled()) {
        if (refreshHoldBlock) {
          this.agentSetWaiting(
            vehicle,
            vehicle.routeNodeIds[vehicle.routeIndex + 1] ?? fromNodeId,
            refreshHoldBlock,
            dtSec
          );
          return;
        }
        vehicle.yieldHoldUntilSec = null;
        vehicle.yieldHoldNodeId = null;
      } else if (this.simTimeSec < vehicle.yieldHoldUntilSec || refreshHoldBlock) {
        this.agentSetWaiting(
          vehicle,
          vehicle.routeNodeIds[vehicle.routeIndex + 1] ?? fromNodeId,
          refreshHoldBlock ?? { reason: 'local-yield-hold', blockingVehicleId: null },
          dtSec
        );
        return;
      }
      if (!this.agentRefreshEnabled()) {
        vehicle.yieldHoldUntilSec = null;
        vehicle.yieldHoldNodeId = null;
      }
    }

    const goalNodeId = this.agentGoalNodeId(vehicle, task);
    const committedLocalRouteAtGoal = this.agentRefreshEnabled() && goalNodeId === fromNodeId
      ? this.agentRefreshCommittedLocalRoute(vehicle, goalNodeId)
      : null;
    if (!goalNodeId || (goalNodeId === fromNodeId && !committedLocalRouteAtGoal)) {
      if (!task && this.topLiftTasklessVehicleBlocksInboundColumn(vehicle) && this.dispatchTasklessTopLiftStorageExit(vehicle)) {
        return;
      }
      if (!task && this.topLiftColumnLayoutEnabled() && this.layoutNode(fromNodeId)?.noParking) {
        if (!this.isInboundOnlyFlow()) {
          const clearanceRoute = this.topLiftTasklessNoParkingClearanceRoute(vehicle);
          if (clearanceRoute) {
            vehicle.state = 'assigned';
            vehicle.routeNodeIds = clearanceRoute;
            vehicle.routeIndex = 0;
            vehicle.targetNodeId = clearanceRoute[1] ?? null;
            vehicle.currentEdgeId = null;
            vehicle.legRemainingM = 0;
            vehicle.waitReason = null;
            vehicle.blockingReservationId = null;
            vehicle.blockingVehicleId = null;
            vehicle.plannedGoalNodeId = clearanceRoute.at(-1) ?? null;
            vehicle.plannedRouteNodeIds = clearanceRoute;
            vehicle.localRouteNodeIds = this.localClaimPrefixForRoute(vehicle.id, clearanceRoute);
            vehicle.localRouteReason = 'temporary-yield';
            return;
          }
        }
        const standbyRoute = this.routeToInboundStandby(vehicle);
        if (standbyRoute && standbyRoute.length > 1 && !this.topLiftRouteTerminatesOnColumnAccess(standbyRoute)) {
          const nextStandbyNodeId = standbyRoute[1] ?? null;
          const standbyBlock = nextStandbyNodeId && this.collisionAvoidanceEnabled()
            ? this.agentRefreshMoveBlocker(vehicle, nextStandbyNodeId, standbyRoute)
            : null;
          if (nextStandbyNodeId && standbyBlock) {
            this.agentSetWaiting(vehicle, nextStandbyNodeId, standbyBlock, dtSec);
            return;
          }
          vehicle.state = 'assigned';
          vehicle.routeNodeIds = standbyRoute;
          vehicle.routeIndex = 0;
          vehicle.targetNodeId = nextStandbyNodeId;
          vehicle.currentEdgeId = null;
          vehicle.legRemainingM = 0;
          vehicle.waitReason = null;
          vehicle.blockingReservationId = null;
          vehicle.blockingVehicleId = null;
          vehicle.plannedGoalNodeId = null;
          vehicle.plannedRouteNodeIds = [];
          vehicle.localRouteNodeIds = [];
          vehicle.localRouteReason = null;
          return;
        }
        this.clearTasklessRouteReservations(vehicle);
        vehicle.state = 'waiting-blocked';
        vehicle.speedMps = 0;
        vehicle.routeNodeIds = [];
        vehicle.routeIndex = 0;
        vehicle.targetNodeId = null;
        vehicle.currentEdgeId = null;
        vehicle.legRemainingM = 0;
        vehicle.waitReason = 'standby-unavailable';
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        vehicle.waitingSinceSec ??= this.simTimeSec;
        vehicle.plannedGoalNodeId = null;
        vehicle.plannedRouteNodeIds = [];
        vehicle.localRouteNodeIds = [];
        vehicle.localRouteReason = null;
        this.blockedTimeByReasonSec.set('standby-unavailable', round((this.blockedTimeByReasonSec.get('standby-unavailable') ?? 0) + dtSec));
        return;
      }
      vehicle.state = vehicle.taskId ? 'assigned' : 'idle';
      vehicle.routeNodeIds = [fromNodeId];
      vehicle.routeIndex = 0;
      vehicle.targetNodeId = null;
      vehicle.currentEdgeId = null;
      vehicle.legRemainingM = 0;
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      vehicle.plannedGoalNodeId = null;
      vehicle.plannedRouteNodeIds = [];
      vehicle.localRouteNodeIds = [];
      vehicle.localRouteReason = null;
      return;
    }

    let route: string[];
    try {
      route = committedLocalRouteAtGoal ?? this.agentRouteToGoal(vehicle, task, goalNodeId);
    } catch {
      if (!task && this.topLiftColumnLayoutEnabled() && !vehicle.loaded && this.isStorageNode(vehicle.currentNodeId)) {
        this.resetNavigationAtCurrentNode(vehicle);
        vehicle.state = 'idle';
        this.dispatchTasklessTopLiftStorageExit(vehicle);
        return;
      }
      this.agentSetWaiting(vehicle, goalNodeId, { reason: 'route-unavailable', blockingVehicleId: null }, dtSec);
      return;
    }

    const toNodeId = route[1];
    if (!toNodeId) {
      vehicle.state = vehicle.taskId ? 'assigned' : 'idle';
      vehicle.routeNodeIds = [fromNodeId];
      vehicle.routeIndex = 0;
      vehicle.targetNodeId = null;
      vehicle.plannedGoalNodeId = null;
      vehicle.plannedRouteNodeIds = [];
      vehicle.localRouteNodeIds = [];
      vehicle.localRouteReason = null;
      return;
    }

    const storageLoadBlock = this.loadedStorageLoadBlock(vehicle, toNodeId);
    if (storageLoadBlock) {
      this.agentSetWaiting(vehicle, toNodeId, storageLoadBlock, dtSec);
      return;
    }

    const storageExitBlock = this.agentMinimalStorageExitLookaheadBlocker(vehicle, route);
    if (storageExitBlock) {
      this.agentSetWaiting(vehicle, toNodeId, storageExitBlock, dtSec);
      return;
    }

    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = toNodeId;

    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    if (!edge) {
      vehicle.state = 'faulted';
      vehicle.waitReason = 'route-edge-missing';
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      this.error = `Missing route edge ${fromNodeId} -> ${toNodeId}`;
      this.logEvent('vehicle-faulted', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'route-edge-missing', this.vehiclePosition(vehicle), {});
      return;
    }

    const nextAxis = this.axisForEdge(edge);
    const requiresDirectionSwitch =
      nextAxis !== null &&
      vehicle.lastMovementAxis !== null &&
      nextAxis !== vehicle.lastMovementAxis &&
      vehicle.directionSwitchReadyNodeId !== fromNodeId &&
      this.scenario.physicsParams.switchDirectionSec > 0;
    if (requiresDirectionSwitch) {
      vehicle.state = 'assigned';
      vehicle.speedMps = 0;
      vehicle.phaseRemainingSec = this.scenario.physicsParams.switchDirectionSec;
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      this.logEvent('direction-switch-started', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'orthogonal-axis-change', this.vehiclePosition(vehicle), {
        fromAxis: vehicle.lastMovementAxis,
        toAxis: nextAxis,
        switchDirectionSec: String(this.scenario.physicsParams.switchDirectionSec)
      });
      return;
    }

    const block = this.collisionAvoidanceEnabled()
      ? this.agentRefreshEnabled()
        ? this.agentRefreshMoveBlocker(vehicle, toNodeId)
        : this.agentMinimalEnabled()
          ? this.agentMinimalMoveBlocker(vehicle, toNodeId)
          : this.agentMoveBlocker(vehicle, toNodeId)
      : null;
    if (block) {
      if (!task && this.rerouteTasklessStandbyAroundBlockedTarget(vehicle, toNodeId)) {
        return;
      }
      if (this.agentRefreshEnabled() && this.agentRefreshHandleMoveBlock(vehicle, toNodeId, block)) {
        return;
      }
      if (vehicle.loaded && block.blockingVehicleId) {
        this.agentTryDisplaceEmptyBlocker(block.blockingVehicleId, vehicle, toNodeId);
      }
      this.agentSetWaiting(vehicle, toNodeId, block, dtSec);
      return;
    }

    this.beginAgentSimpleLeg(vehicle, edge, toNodeId, task, dtSec);
  }

  private rerouteTasklessStandbyAroundBlockedTarget(vehicle: MutableVehicle, blockedTargetNodeId: string): boolean {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      vehicle.taskId ||
      vehicle.loaded ||
      vehicle.currentEdgeId !== null ||
      vehicle.legRemainingM > 0
    ) {
      return false;
    }
    const blockedNode = this.layoutNode(blockedTargetNodeId);
    if (!blockedNode || (blockedNode.type !== 'parking' && blockedNode.type !== 'storage')) {
      return false;
    }
    const route = this.routeToInboundStandby(vehicle);
    const nextNodeId = route?.[1] ?? null;
    if (!route || !nextNodeId || nextNodeId === blockedTargetNodeId || this.topLiftRouteTerminatesOnColumnAccess(route)) {
      return false;
    }
    const nextBlock = this.collisionAvoidanceEnabled()
      ? this.agentRefreshEnabled()
        ? this.agentRefreshMoveBlocker(vehicle, nextNodeId, route)
        : this.agentMinimalEnabled()
          ? this.agentMinimalMoveBlocker(vehicle, nextNodeId)
          : this.agentMoveBlocker(vehicle, nextNodeId)
      : null;
    if (nextBlock) {
      return false;
    }

    this.clearTasklessRouteReservations(vehicle);
    vehicle.state = 'assigned';
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = nextNodeId;
    vehicle.plannedGoalNodeId = route.at(-1) ?? null;
    vehicle.plannedRouteNodeIds = route;
    vehicle.localRouteNodeIds = [];
    vehicle.localRouteReason = null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    this.logAgentReroute(vehicle, null, blockedTargetNodeId, route, 'standby-target-occupied-reroute', { countTaskReplan: false });
    return true;
  }

  private agentRefreshMoveBlocker(
    vehicle: MutableVehicle,
    toNodeId: string,
    candidateRouteNodeIds: string[] | null = null
  ): { reason: string; blockingVehicleId: string | null } | null {
    const middleAisleBlockerId = this.topLiftMiddleAisleOpposingClaimBlocker(vehicle, toNodeId);
    if (middleAisleBlockerId) {
      return { reason: 'middle-aisle-opposing-claim', blockingVehicleId: middleAisleBlockerId };
    }
    const spineBlockerId = this.topLiftVerticalSpineOpposingClaimBlocker(vehicle, toNodeId);
    if (spineBlockerId) {
      return { reason: 'top-lift-spine-opposing-claim', blockingVehicleId: spineBlockerId };
    }

    const immediateBlock = this.agentMinimalMoveBlocker(vehicle, toNodeId);
    if (immediateBlock && this.agentRefreshImmediateNodeBlockTakesPrecedence(immediateBlock.reason)) {
      return immediateBlock;
    }

    const queueAisleBlocker = this.topLiftQueueAisleClearThroughBlocker(vehicle, toNodeId, candidateRouteNodeIds);
    if (queueAisleBlocker) {
      return { reason: 'lift-queue-aisle-clear-through', blockingVehicleId: queueAisleBlocker };
    }

    const noStopContinuationBlock = this.agentRefreshNoStopContinuationBlock(vehicle, toNodeId, candidateRouteNodeIds);
    if (noStopContinuationBlock) {
      const noStopBlockingVehicle = noStopContinuationBlock.blockingVehicleId
        ? this.vehicles.find((candidate) => candidate.id === noStopContinuationBlock.blockingVehicleId) ?? null
        : null;
      if (
        noStopBlockingVehicle &&
        (
          this.agentRefreshBlockerIsTrailingCurrentNode(vehicle, noStopBlockingVehicle) ||
          this.agentRefreshBlockerIsBehindCurrentMove(vehicle, toNodeId, noStopBlockingVehicle)
        )
      ) {
        return null;
      }
      return noStopContinuationBlock;
    }

    const queueFifoBlocker = this.topLiftQueueFifoBlocker(vehicle, toNodeId);
    if (queueFifoBlocker) {
      return { reason: 'lift-queue-fifo', blockingVehicleId: queueFifoBlocker };
    }

    if (immediateBlock) {
      const immediateBlockingVehicle = immediateBlock.blockingVehicleId
        ? this.vehicles.find((candidate) => candidate.id === immediateBlock.blockingVehicleId) ?? null
        : null;
      if (
        immediateBlockingVehicle &&
        (immediateBlock.reason === 'min-separation' || immediateBlock.reason === 'avoidance-clearance') &&
        this.topLiftQueueDeeperClearanceOverlapAllowed(vehicle, toNodeId, immediateBlockingVehicle.id)
      ) {
        return null;
      }
      if (
        immediateBlockingVehicle &&
        (immediateBlock.reason === 'min-separation' || immediateBlock.reason === 'avoidance-clearance') &&
        this.agentRefreshStoragePocketBlockerIsOffAisleYield(vehicle, toNodeId, immediateBlockingVehicle)
      ) {
        return null;
      }
      if (
        immediateBlockingVehicle &&
        (immediateBlock.reason === 'min-separation' || immediateBlock.reason === 'avoidance-clearance') &&
        this.agentRefreshBlockerIsTrailingCurrentNode(vehicle, immediateBlockingVehicle)
      ) {
        return null;
      }
      return immediateBlock;
    }
    if (this.isStorageNode(vehicle.currentNodeId)) {
      return null;
    }
    return this.agentRefreshColumnEdgeBlocker(vehicle, toNodeId);
  }

  private agentRefreshStoragePocketBlockerIsOffAisleYield(
    vehicle: MutableVehicle,
    toNodeId: string,
    blocker: MutableVehicle
  ): boolean {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      blocker.loaded ||
      !this.isStorageNode(blocker.currentNodeId) ||
      !isTopLiftColumnAccessNodeId(toNodeId) ||
      this.topLiftColumnKey(blocker.currentNodeId) !== this.topLiftColumnKey(toNodeId)
    ) {
      return false;
    }
    if (
      blocker.waitReason !== 'local-yield-hold' &&
      blocker.waitReason !== 'middle-aisle-opposing-claim'
    ) {
      return false;
    }
    return blocker.blockingVehicleId === vehicle.id ||
      this.activeConflictSessionForPair(vehicle.id, blocker.id)?.yielderVehicleId === blocker.id;
  }

  private agentRefreshImmediateNodeBlockTakesPrecedence(reason: string): boolean {
    return reason === 'node-occupancy-mismatch' ||
      reason === 'node-occupied' ||
      reason === 'node-local-yield' ||
      reason === 'node-target-near' ||
      reason === 'edge-head-on' ||
      reason.includes('-lift-busy:');
  }

  private topLiftQueueAisleClearThroughBlocker(
    vehicle: MutableVehicle,
    toNodeId: string,
    candidateRouteNodeIds: string[] | null
  ): string | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const entryAccess = topLiftQueueAisleAccess(toNodeId);
    if (!entryAccess) {
      return null;
    }
    const routeNodeIds = candidateRouteNodeIds ?? this.vehicleRouteTailForMove(vehicle, toNodeId);
    const toIndex = routeNodeIds.indexOf(toNodeId);
    if (toIndex < 0) {
      return null;
    }
    const moveIntent = this.topLiftQueueAisleMoveIntent(vehicle, toNodeId);

    for (let index = toIndex; index < routeNodeIds.length && index <= toIndex + 8; index += 1) {
      const nodeId = routeNodeIds[index]!;
      const occupantId = this.currentNodeOccupancy.get(nodeId);
      if (occupantId && occupantId !== vehicle.id) {
        return occupantId;
      }
      const claimantId = this.nodeClaimedByOtherVehicle(nodeId, vehicle.id);
      if (claimantId) {
        if (
          moveIntent === 'service' &&
          this.topLiftQueueAisleClaimIsQueueEntry(claimantId, entryAccess.liftNodeId)
        ) {
          continue;
        }
        return claimantId;
      }

      if (index === toIndex) {
        continue;
      }
      const access = topLiftQueueAisleAccess(nodeId);
      if (!access || access.liftNodeId !== entryAccess.liftNodeId || topLiftQueueParkingSlot(nodeId)) {
        return null;
      }
    }

    return null;
  }

  private topLiftQueueAisleClaimIsQueueEntry(claimantId: string, liftNodeId: string): boolean {
    const claimant = this.vehicles.find((vehicle) => vehicle.id === claimantId) ?? null;
    if (!claimant || !claimant.targetNodeId) {
      return false;
    }
    if (!this.topLiftNodeBelongsToLiftQueueOrService(claimant.targetNodeId, liftNodeId)) {
      return false;
    }
    return this.topLiftQueueAisleMoveIntent(claimant, claimant.targetNodeId) === 'queue';
  }

  private topLiftQueueAisleMoveIntent(vehicle: MutableVehicle, toNodeId: string): 'queue' | 'service' | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const currentAccess = topLiftQueueAisleAccess(vehicle.currentNodeId);
    const toAccess = topLiftQueueAisleAccess(toNodeId);
    const currentSlot = topLiftQueueParkingSlot(vehicle.currentNodeId);
    const toSlot = topLiftQueueParkingSlot(toNodeId);
    const currentServiceLiftNodeId = this.topLiftQueueServiceLiftNodeId(vehicle.currentNodeId);
    const toServiceLiftNodeId = this.topLiftQueueServiceLiftNodeId(toNodeId);
    const task = this.taskForVehicle(vehicle);
    const taskLiftNodeId = task ? this.taskLiftPortNodeId(task) : null;
    const plannedSlot = vehicle.plannedGoalNodeId ? topLiftQueueParkingSlot(vehicle.plannedGoalNodeId) : null;
    const liftNodeId =
      toAccess?.liftNodeId ??
      currentAccess?.liftNodeId ??
      toSlot?.liftNodeId ??
      currentSlot?.liftNodeId ??
      toServiceLiftNodeId ??
      currentServiceLiftNodeId ??
      taskLiftNodeId ??
      plannedSlot?.liftNodeId ??
      null;
    if (!liftNodeId) {
      return null;
    }

    if (toSlot?.liftNodeId === liftNodeId) {
      return 'queue';
    }
    if (currentAccess?.liftNodeId === liftNodeId && toAccess?.liftNodeId === liftNodeId) {
      if (toAccess.slotIndex > currentAccess.slotIndex) {
        return 'queue';
      }
      if (toAccess.slotIndex < currentAccess.slotIndex) {
        return 'service';
      }
    }
    if (currentSlot?.liftNodeId === liftNodeId && toAccess?.liftNodeId === liftNodeId) {
      return plannedSlot?.liftNodeId === liftNodeId && plannedSlot.slotIndex !== currentSlot.slotIndex
        ? 'queue'
        : 'service';
    }
    if (currentServiceLiftNodeId === liftNodeId && toAccess?.liftNodeId === liftNodeId) {
      return 'queue';
    }
    if (currentAccess?.liftNodeId === liftNodeId && toServiceLiftNodeId === liftNodeId) {
      return 'service';
    }
    if (toServiceLiftNodeId === liftNodeId) {
      return 'service';
    }
    return plannedSlot?.liftNodeId === liftNodeId ? 'queue' : null;
  }

  private topLiftQueueServiceLiftNodeId(nodeId: string): string | null {
    const queueSlot = topLiftQueueParkingSlot(nodeId);
    if (queueSlot) {
      return queueSlot.liftNodeId;
    }
    const queueAccess = topLiftQueueAisleAccess(nodeId);
    if (queueAccess) {
      return queueAccess.liftNodeId;
    }
    const buffer = liftBufferParentNodeId(nodeId);
    if (buffer) {
      return buffer.liftNodeId;
    }
    const suffix = '-buffer-access';
    if (nodeId.endsWith(suffix)) {
      return nodeId.slice(0, -suffix.length);
    }
    return /^(lift-\d{2}-(?:inbound|outbound))-(?:queue-access|queue-\d{2}-(?:entry-access|service-exit))$/.exec(nodeId)?.[1] ?? null;
  }

  private topLiftQueueDeeperClearanceOverlapAllowed(
    vehicle: MutableVehicle,
    toNodeId: string,
    blockerVehicleId: string
  ): boolean {
    if (!this.topLiftColumnLayoutEnabled() || vehicle.loaded) {
      return false;
    }
    const blocker = this.vehicles.find((candidate) => candidate.id === blockerVehicleId) ?? null;
    if (!blocker?.loaded) {
      return false;
    }
    const currentSlot = topLiftQueueParkingSlot(vehicle.currentNodeId);
    const currentAccess = topLiftQueueAisleAccess(vehicle.currentNodeId);
    const toSlot = topLiftQueueParkingSlot(toNodeId);
    const toAccess = topLiftQueueAisleAccess(toNodeId);
    const liftNodeId = currentSlot?.liftNodeId ?? currentAccess?.liftNodeId ?? null;
    if (!liftNodeId || (toSlot?.liftNodeId ?? toAccess?.liftNodeId) !== liftNodeId) {
      return false;
    }
    const goalSlot = topLiftQueueParkingSlot(vehicle.routeNodeIds.at(-1) ?? '');
    if (!goalSlot || goalSlot.liftNodeId !== liftNodeId) {
      return false;
    }
    const currentIndex = currentSlot?.slotIndex ?? currentAccess?.slotIndex ?? 0;
    const toIndex = toSlot?.slotIndex ?? toAccess?.slotIndex ?? 0;
    const enteringGoalSlotFromAccess =
      !currentSlot &&
      currentAccess !== null &&
      toSlot?.slotIndex === goalSlot.slotIndex &&
      currentAccess.slotIndex === goalSlot.slotIndex;
    if ((goalSlot.slotIndex <= currentIndex && !enteringGoalSlotFromAccess) || toIndex < currentIndex) {
      return false;
    }
    const blockerLiftNodeId =
      this.topLiftQueueServiceLiftNodeId(blocker.currentNodeId) ??
      (blocker.targetNodeId ? this.topLiftQueueServiceLiftNodeId(blocker.targetNodeId) : null);
    return blockerLiftNodeId === liftNodeId;
  }

  private topLiftQueueEntryBlockedByOccupiedFrontSlot(
    vehicle: MutableVehicle,
    toNodeId: string,
    candidateRouteNodeIds: string[] | null
  ): string | null {
    if (!this.topLiftColumnLayoutEnabled() || topLiftQueueParkingSlot(vehicle.currentNodeId)) {
      return null;
    }
    const liftNodeId = this.topLiftQueueEntryLiftNodeId(vehicle, toNodeId, candidateRouteNodeIds);
    if (!liftNodeId) {
      return null;
    }
    const frontSlotNodeId = liftQueueNodeId(liftNodeId, 1);
    const frontSlotOccupantId = this.currentNodeOccupancy.get(frontSlotNodeId);
    if (frontSlotOccupantId && frontSlotOccupantId !== vehicle.id) {
      return frontSlotOccupantId;
    }
    return this.nodeClaimedByOtherVehicle(frontSlotNodeId, vehicle.id);
  }

  private topLiftQueueEntryLiftNodeId(
    vehicle: MutableVehicle,
    toNodeId: string,
    candidateRouteNodeIds: string[] | null
  ): string | null {
    const routeNodeIds = candidateRouteNodeIds ?? this.vehicleRouteTailForMove(vehicle, toNodeId);
    const currentIndex = routeNodeIds.indexOf(vehicle.currentNodeId);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    for (let index = Math.max(0, startIndex + 1); index < routeNodeIds.length; index += 1) {
      const nodeId = routeNodeIds[index]!;
      const accessLiftNodeId = this.topLiftQueueAccessLiftNodeId(nodeId);
      if (accessLiftNodeId) {
        return accessLiftNodeId;
      }
      const slot = topLiftQueueParkingSlot(nodeId);
      if (slot) {
        return slot.liftNodeId;
      }
      if (index > startIndex + 4) {
        break;
      }
    }
    return this.topLiftQueueAccessLiftNodeId(toNodeId);
  }

  private topLiftQueueAccessLiftNodeId(nodeId: string): string | null {
    const suffix = '-queue-access';
    return nodeId.endsWith(suffix) ? nodeId.slice(0, -suffix.length) : null;
  }

  private agentRefreshNoStopContinuationBlock(
    vehicle: MutableVehicle,
    toNodeId: string,
    candidateRouteNodeIds: string[] | null = null
  ): { reason: string; blockingVehicleId: string | null } | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    if (!isTopLiftSpineLevelNodeId(toNodeId, 'middle')) {
      return null;
    }
    const task = this.taskForVehicle(vehicle);
    if (!this.mustClearNoStopNode(vehicle, task, toNodeId)) {
      return null;
    }
    const candidateRouteIndex = candidateRouteNodeIds?.indexOf(toNodeId) ?? -1;
    const nextNodeId = candidateRouteNodeIds
      ? candidateRouteIndex >= 0
        ? candidateRouteNodeIds[candidateRouteIndex + 1] ?? null
        : null
      : this.agentRouteNodeAfter(vehicle, toNodeId);
    if (!nextNodeId) {
      return { reason: 'no-stop-continuation-blocked', blockingVehicleId: null };
    }
    const occupantId = this.currentNodeOccupancy.get(nextNodeId);
    if (occupantId && occupantId !== vehicle.id) {
      return { reason: 'no-stop-continuation-blocked', blockingVehicleId: occupantId };
    }
    const targetClaimId = this.movingVehicleTargetingNode(nextNodeId, vehicle.id);
    if (targetClaimId) {
      return { reason: 'no-stop-continuation-blocked', blockingVehicleId: targetClaimId };
    }
    return null;
  }

  private agentRefreshBlockerIsTrailingCurrentNode(vehicle: MutableVehicle, blocker: MutableVehicle): boolean {
    if (blocker.currentEdgeId !== null || blocker.legRemainingM > 0) {
      return false;
    }
    if (blocker.targetNodeId === vehicle.currentNodeId) {
      return true;
    }
    return blocker.routeNodeIds[blocker.routeIndex + 1] === vehicle.currentNodeId;
  }

  private agentRefreshBlockerIsBehindCurrentMove(
    vehicle: MutableVehicle,
    toNodeId: string,
    blocker: MutableVehicle
  ): boolean {
    const from = nodePosition(this.scenario, vehicle.currentNodeId);
    const to = nodePosition(this.scenario, toNodeId);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length <= 1e-9) {
      return false;
    }

    const ux = dx / length;
    const uz = dz / length;
    const relX = blocker.x - from.x;
    const relZ = blocker.z - from.z;
    const projection = relX * ux + relZ * uz;
    const lateral = Math.abs(relX * -uz + relZ * ux);
    const sameLaneToleranceM = Math.max(0.2, this.scenario.vehicles.widthM * 0.8);
    if (projection >= -0.05 || lateral > sameLaneToleranceM) {
      return false;
    }

    if (
      this.topLiftColumnLayoutEnabled() &&
      isTopLiftAisleLevelNodeId(vehicle.currentNodeId, 'middle') &&
      isTopLiftAisleLevelNodeId(toNodeId, 'middle') &&
      (
        isTopLiftAisleLevelNodeId(blocker.currentNodeId, 'middle') ||
        (blocker.targetNodeId !== null && isTopLiftAisleLevelNodeId(blocker.targetNodeId, 'middle'))
      )
    ) {
      return true;
    }

    const blockerDirection = this.vehicleMovementDirection(blocker);
    return !blockerDirection || blockerDirection.ux * ux + blockerDirection.uz * uz > 0.35;
  }

  private agentRefreshColumnEdgeBlocker(
    vehicle: MutableVehicle,
    toNodeId: string
  ): { reason: string; blockingVehicleId: string | null } | null {
    const blockingVehicleId = this.agentRefreshNearColumnSweptFootprintBlocker(vehicle, vehicle.currentNodeId, toNodeId);
    if (
      blockingVehicleId &&
      this.topLiftQueueDeeperClearanceOverlapAllowed(vehicle, toNodeId, blockingVehicleId)
    ) {
      return null;
    }
    if (
      blockingVehicleId &&
      this.topLiftOutboundBufferContinuationAllowed(vehicle, toNodeId, blockingVehicleId)
    ) {
      return null;
    }
    return blockingVehicleId ? { reason: 'lift-column-near', blockingVehicleId } : null;
  }

  private topLiftOutboundBufferContinuationAllowed(
    vehicle: MutableVehicle,
    toNodeId: string,
    blockerVehicleId: string
  ): boolean {
    if (!this.topLiftColumnLayoutEnabled() || !vehicle.loaded) {
      return false;
    }
    const targetBuffer = liftBufferParentNodeId(toNodeId);
    if (targetBuffer?.kind !== 'outbound') {
      return false;
    }
    const blocker = this.vehicles.find((candidate) => candidate.id === blockerVehicleId) ?? null;
    if (!blocker?.loaded) {
      return false;
    }
    const task = this.taskForVehicle(vehicle);
    const blockerTask = this.taskForVehicle(blocker);
    if (
      task?.kind !== 'outbound' ||
      blockerTask?.kind !== 'outbound' ||
      this.taskLiftPortNodeId(task) !== targetBuffer.liftNodeId ||
      this.taskLiftPortNodeId(blockerTask) !== targetBuffer.liftNodeId ||
      !this.taskPrecedes(task, blockerTask)
    ) {
      return false;
    }
    const blockerLiftNodeId =
      this.topLiftQueueServiceLiftNodeId(blocker.currentNodeId) ??
      (blocker.targetNodeId ? this.topLiftQueueServiceLiftNodeId(blocker.targetNodeId) : null);
    return blockerLiftNodeId === targetBuffer.liftNodeId;
  }

  private topLiftMiddleAisleOpposingClaimBlocker(vehicle: MutableVehicle, toNodeId: string): string | null {
    const requestedClaim = this.topLiftMiddleAisleRequestedClaim(vehicle, toNodeId);
    if (!requestedClaim) {
      return null;
    }

    const blocker = this.vehicles.find((other) => {
      if (other.id === vehicle.id) {
        return false;
      }
      if (
        other.waitReason === 'no-stop-continuation-blocked' &&
        other.blockingVehicleId === vehicle.id
      ) {
        return false;
      }
      const activeClaim = this.topLiftMiddleAisleActiveClaim(other);
      if (
        activeClaim === null ||
        activeClaim.direction === requestedClaim.direction ||
        !this.topLiftMiddleAisleClaimsOverlap(requestedClaim, activeClaim)
      ) {
        return false;
      }
      if (
        isTopLiftAisleLevelNodeId(other.currentNodeId, 'middle') ||
        (
          other.currentEdgeId !== null &&
          other.targetNodeId !== null &&
          isTopLiftAisleLevelNodeId(other.targetNodeId, 'middle')
        )
      ) {
        return true;
      }
      return this.agentRefreshHasHigherPriority(other, vehicle);
    });
    return blocker?.id ?? null;
  }

  private topLiftMiddleAisleRequestedClaim(
    vehicle: MutableVehicle,
    toNodeId: string
  ): { direction: -1 | 1; minX: number; maxX: number } | null {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      isTopLiftAisleLevelNodeId(vehicle.currentNodeId, 'middle') ||
      !isTopLiftAisleLevelNodeId(toNodeId, 'middle')
    ) {
      return null;
    }

    return this.topLiftMiddleAisleClaimFromRoute(this.vehicleRouteTailForMove(vehicle, toNodeId));
  }

  private topLiftMiddleAisleActiveClaim(vehicle: MutableVehicle): { direction: -1 | 1; minX: number; maxX: number } | null {
    if (
      vehicle.waitReason === 'middle-aisle-opposing-claim' &&
      !isTopLiftAisleLevelNodeId(vehicle.currentNodeId, 'middle') &&
      !(
        vehicle.currentEdgeId !== null &&
        vehicle.targetNodeId !== null &&
        isTopLiftAisleLevelNodeId(vehicle.targetNodeId, 'middle')
      )
    ) {
      return null;
    }
    if (
      vehicle.waitReason === 'local-yield-hold' &&
      vehicle.currentEdgeId === null &&
      vehicle.targetNodeId === vehicle.currentNodeId
    ) {
      return null;
    }

    const routeCandidates: string[][] = [];
    if (vehicle.targetNodeId) {
      routeCandidates.push([vehicle.currentNodeId, vehicle.targetNodeId]);
    }
    routeCandidates.push(
      this.vehicleRouteTail(vehicle, vehicle.routeNodeIds),
      this.vehicleRouteTail(vehicle, vehicle.localRouteNodeIds),
      this.vehicleRouteTail(vehicle, vehicle.plannedRouteNodeIds)
    );

    for (const routeNodeIds of routeCandidates) {
      const claim = this.topLiftMiddleAisleClaimFromRoute(routeNodeIds);
      if (claim) {
        return claim;
      }
    }
    return null;
  }

  private topLiftMiddleAisleClaimsOverlap(
    left: { minX: number; maxX: number },
    right: { minX: number; maxX: number }
  ): boolean {
    const clearanceM = Math.max(this.scenario.vehicles.lengthM, this.scenario.vehicles.widthM) * 1.5;
    return left.minX <= right.maxX + clearanceM && right.minX <= left.maxX + clearanceM;
  }

  private topLiftMiddleAisleClaimFromRoute(routeNodeIds: string[]): { direction: -1 | 1; minX: number; maxX: number } | null {
    let direction: -1 | 1 | null = null;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;

    for (let index = 1; index < routeNodeIds.length; index += 1) {
      const fromNodeId = routeNodeIds[index - 1]!;
      const toNodeId = routeNodeIds[index]!;
      const moveDirection = this.topLiftMiddleAisleMoveDirection(fromNodeId, toNodeId);
      if (!moveDirection) {
        continue;
      }
      const fromNode = this.layoutNode(fromNodeId);
      const toNode = this.layoutNode(toNodeId);
      if (!fromNode || !toNode) {
        continue;
      }
      direction ??= moveDirection;
      if (moveDirection !== direction) {
        break;
      }
      minX = Math.min(minX, fromNode.x, toNode.x);
      maxX = Math.max(maxX, fromNode.x, toNode.x);
    }

    return direction === null ? null : { direction, minX, maxX };
  }

  private vehicleRouteTailForMove(vehicle: MutableVehicle, toNodeId: string): string[] {
    const routeNodeIds = this.vehicleRouteTail(vehicle, vehicle.routeNodeIds);
    if (routeNodeIds.length === 0) {
      return [vehicle.currentNodeId, toNodeId];
    }
    if (routeNodeIds[0] !== vehicle.currentNodeId) {
      routeNodeIds.unshift(vehicle.currentNodeId);
    }
    if (routeNodeIds[1] !== toNodeId) {
      routeNodeIds.splice(1, 0, toNodeId);
    }
    return routeNodeIds;
  }

  private vehicleRouteTail(vehicle: MutableVehicle, routeNodeIds: string[]): string[] {
    if (routeNodeIds.length === 0) {
      return [];
    }
    const currentIndex = routeNodeIds.indexOf(vehicle.currentNodeId);
    if (currentIndex >= 0) {
      return routeNodeIds.slice(currentIndex);
    }
    if (vehicle.targetNodeId) {
      const targetIndex = routeNodeIds.indexOf(vehicle.targetNodeId);
      if (targetIndex >= 0) {
        return [vehicle.currentNodeId, ...routeNodeIds.slice(targetIndex)];
      }
    }
    return [vehicle.currentNodeId, ...routeNodeIds];
  }

  private topLiftMiddleAisleDirectionFromRoute(routeNodeIds: string[]): -1 | 1 | null {
    for (let index = 1; index < routeNodeIds.length; index += 1) {
      const direction = this.topLiftMiddleAisleMoveDirection(routeNodeIds[index - 1]!, routeNodeIds[index]!);
      if (direction) {
        return direction;
      }
    }
    return null;
  }

  private topLiftMiddleAisleMoveDirection(fromNodeId: string, toNodeId: string): -1 | 1 | null {
    if (!isTopLiftAisleLevelNodeId(fromNodeId, 'middle') || !isTopLiftAisleLevelNodeId(toNodeId, 'middle')) {
      return null;
    }
    const fromNode = this.layoutNode(fromNodeId);
    const toNode = this.layoutNode(toNodeId);
    if (!fromNode || !toNode) {
      return null;
    }
    const dx = Math.sign(toNode.x - fromNode.x);
    return dx === -1 || dx === 1 ? dx : null;
  }

  private topLiftVerticalSpineOpposingClaimBlocker(vehicle: MutableVehicle, toNodeId: string): string | null {
    const requestedClaim = this.topLiftVerticalSpineRequestedClaim(vehicle, toNodeId);
    if (!requestedClaim) {
      return null;
    }

    const blocker = this.vehicles.find((other) => {
      if (other.id === vehicle.id) {
        return false;
      }
      if (
        other.waitReason === 'no-stop-continuation-blocked' &&
        other.blockingVehicleId === vehicle.id
      ) {
        return false;
      }
      const activeClaim = this.topLiftVerticalSpineActiveClaim(other);
      if (
        activeClaim === null ||
        activeClaim.spineKey !== requestedClaim.spineKey ||
        activeClaim.direction === requestedClaim.direction ||
        !this.topLiftVerticalSpineClaimsOverlap(requestedClaim, activeClaim)
      ) {
        return false;
      }
      if (
        topLiftSpineKey(other.currentNodeId) === requestedClaim.spineKey ||
        (
          other.currentEdgeId !== null &&
          other.targetNodeId !== null &&
          topLiftSpineKey(other.targetNodeId) === requestedClaim.spineKey
        )
      ) {
        return true;
      }
      return false;
    });
    return blocker?.id ?? null;
  }

  private topLiftVerticalSpineRequestedClaim(
    vehicle: MutableVehicle,
    toNodeId: string
  ): { spineKey: string; direction: -1 | 1; minZ: number; maxZ: number } | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const routeNodeIds = this.vehicleRouteTailForMove(vehicle, toNodeId);
    const firstVerticalMoveIndex = routeNodeIds.findIndex((nodeId, index) =>
      index > 0 && this.topLiftVerticalSpineMove(routeNodeIds[index - 1]!, nodeId) !== null
    );
    if (firstVerticalMoveIndex < 1) {
      return null;
    }
    const firstVerticalMoveFromIndex = firstVerticalMoveIndex - 1;
    const enteringSpineNow = firstVerticalMoveFromIndex <= 1;
    if (!enteringSpineNow) {
      return null;
    }
    return this.topLiftVerticalSpineClaimFromRoute(routeNodeIds.slice(firstVerticalMoveFromIndex));
  }

  private topLiftVerticalSpineActiveClaim(vehicle: MutableVehicle): { spineKey: string; direction: -1 | 1; minZ: number; maxZ: number } | null {
    if (
      vehicle.waitReason === 'local-yield-hold' &&
      vehicle.currentEdgeId === null &&
      vehicle.targetNodeId === vehicle.currentNodeId
    ) {
      return null;
    }

    const routeCandidates: string[][] = [];
    if (vehicle.targetNodeId) {
      routeCandidates.push([vehicle.currentNodeId, vehicle.targetNodeId]);
    }
    routeCandidates.push(
      this.vehicleRouteTail(vehicle, vehicle.routeNodeIds),
      this.vehicleRouteTail(vehicle, vehicle.localRouteNodeIds),
      this.vehicleRouteTail(vehicle, vehicle.plannedRouteNodeIds)
    );

    for (const routeNodeIds of routeCandidates) {
      const claim = this.topLiftVerticalSpineClaimFromRoute(routeNodeIds);
      if (claim) {
        return claim;
      }
    }
    return null;
  }

  private topLiftVerticalSpineClaimsOverlap(
    left: { minZ: number; maxZ: number },
    right: { minZ: number; maxZ: number }
  ): boolean {
    const clearanceM = Math.max(this.scenario.vehicles.lengthM, this.scenario.vehicles.widthM) * 1.5;
    return left.minZ <= right.maxZ + clearanceM && right.minZ <= left.maxZ + clearanceM;
  }

  private topLiftVerticalSpineClaimFromRoute(routeNodeIds: string[]): { spineKey: string; direction: -1 | 1; minZ: number; maxZ: number } | null {
    let spineKey: string | null = null;
    let direction: -1 | 1 | null = null;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (let index = 1; index < routeNodeIds.length; index += 1) {
      const fromNodeId = routeNodeIds[index - 1]!;
      const toNodeId = routeNodeIds[index]!;
      const move = this.topLiftVerticalSpineMove(fromNodeId, toNodeId);
      if (!move) {
        if (direction !== null) {
          break;
        }
        continue;
      }
      if (spineKey !== null && move.spineKey !== spineKey) {
        break;
      }
      if (direction !== null && move.direction !== direction) {
        break;
      }
      spineKey = move.spineKey;
      direction = move.direction;
      minZ = Math.min(minZ, move.fromZ, move.toZ);
      maxZ = Math.max(maxZ, move.fromZ, move.toZ);
    }

    return spineKey === null || direction === null ? null : { spineKey, direction, minZ, maxZ };
  }

  private topLiftVerticalSpineMove(fromNodeId: string, toNodeId: string): { spineKey: string; direction: -1 | 1; fromZ: number; toZ: number } | null {
    const spineKey = topLiftSpineKey(fromNodeId);
    if (!spineKey || topLiftSpineKey(toNodeId) !== spineKey) {
      return null;
    }
    const fromNode = this.layoutNode(fromNodeId);
    const toNode = this.layoutNode(toNodeId);
    if (!fromNode || !toNode) {
      return null;
    }
    const dz = Math.sign(toNode.z - fromNode.z);
    return dz === -1 || dz === 1
      ? { spineKey, direction: dz, fromZ: fromNode.z, toZ: toNode.z }
      : null;
  }

  private agentRefreshHandleMoveBlock(
    vehicle: MutableVehicle,
    blockedTargetNodeId: string,
    block: { reason: string; blockingVehicleId: string | null }
  ): boolean {
    const blocker = block.blockingVehicleId
      ? this.vehicles.find((candidate) => candidate.id === block.blockingVehicleId) ?? null
      : null;

    if (block.reason === 'middle-aisle-opposing-claim') {
      return blocker
        ? this.tryInstallTopLiftMiddleAisleStorageYield(vehicle, blockedTargetNodeId, blocker)
        : false;
    }

    if (
      block.reason === 'no-stop-continuation-blocked' ||
      this.topLiftLaneTransferShouldWait(vehicle.currentNodeId, blockedTargetNodeId, block.reason)
    ) {
      return false;
    }

    if (!blocker) {
      return false;
    }
    if (this.topLiftInboundRequesterShouldWaitForEarlierPickup(vehicle, blocker)) {
      return false;
    }
    if (
      (block.reason === 'min-separation' || block.reason === 'avoidance-clearance') &&
      (
        this.agentRefreshSameDirectionFollowerBlock(vehicle, blockedTargetNodeId, blocker) ||
        this.agentRefreshBlockerIsClearingTarget(vehicle, blockedTargetNodeId, blocker)
      )
    ) {
      return false;
    }

    const existingSession = this.activeConflictSessionForPair(vehicle.id, blocker.id);
    if (existingSession) {
      existingSession.updatedAtSec = this.simTimeSec;
      if (vehicle.id === existingSession.winnerVehicleId) {
        if (this.agentRefreshMoveQueueYielderDeeper(blocker, existingSession, vehicle, blockedTargetNodeId)) {
          return true;
        }
        return false;
      }
      if (
        vehicle.id === existingSession.yielderVehicleId &&
        !vehicle.currentEdgeId &&
        vehicle.legRemainingM <= 0
      ) {
        existingSession.yielderOriginalNodeId = vehicle.currentNodeId;
        return this.agentRefreshInstallSideYield(vehicle, blockedTargetNodeId, blocker, existingSession);
      }
      return false;
    }

    if (this.isStorageNode(vehicle.currentNodeId) && this.liftStorageTransferTargetLiftId(blockedTargetNodeId) !== null) {
      return false;
    }

    const session = this.createAgentRefreshConflictSession(vehicle, blocker, blockedTargetNodeId, block.reason);
    if (session.yielderVehicleId === blocker.id) {
      if (this.agentRefreshInstallSideYield(blocker, blockedTargetNodeId, vehicle, session)) {
        return false;
      }
      if (vehicle.loaded) {
        return false;
      }
      return this.installSideYieldWithReassignedConflictSession(session, blocker, vehicle, blockedTargetNodeId);
    }

    if (vehicle.loaded) {
      return false;
    }

    return this.agentRefreshInstallSideYield(vehicle, blockedTargetNodeId, blocker, session);
  }

  private tryInstallTopLiftMiddleAisleStorageYield(
    vehicle: MutableVehicle,
    blockedTargetNodeId: string,
    blocker: MutableVehicle
  ): boolean {
    const task = this.taskForVehicle(vehicle);
    if (
      !this.topLiftColumnLayoutEnabled() ||
      !this.isStorageNode(vehicle.currentNodeId) ||
      !isTopLiftAisleLevelNodeId(blockedTargetNodeId, 'middle') ||
      vehicle.currentEdgeId !== null ||
      vehicle.legRemainingM > 0 ||
      vehicle.phaseRemainingSec > 0 ||
      vehicle.state === 'lifting' ||
      vehicle.state === 'lowering' ||
      (vehicle.loaded && task?.kind !== 'outbound')
    ) {
      return false;
    }

    const currentPosition = this.storageGridPosition(vehicle.currentNodeId);
    const blockedColumn = this.topLiftColumnAccessColumn(blockedTargetNodeId);
    if (!currentPosition || blockedColumn !== currentPosition.column) {
      return false;
    }

    const blockedTarget = nodePosition(this.scenario, blockedTargetNodeId);
    const currentNodeId = vehicle.currentNodeId;
    const candidate = this.neighbors(currentNodeId)
      .filter((neighbor) => {
        const position = this.storageGridPosition(neighbor.nodeId);
        return position !== null && position.column === currentPosition.column;
      })
      .filter((neighbor) => neighbor.nodeId !== blockedTargetNodeId && neighbor.nodeId !== blocker.currentNodeId)
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketKeepsGoalReachable(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketCanReturn(vehicle, neighbor.nodeId, currentNodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, currentNodeId, neighbor.nodeId))
      .sort((left, right) => {
        const leftPosition = nodePosition(this.scenario, left.nodeId);
        const rightPosition = nodePosition(this.scenario, right.nodeId);
        const leftAwayM = Math.abs(leftPosition.x - blockedTarget.x) + Math.abs(leftPosition.z - blockedTarget.z);
        const rightAwayM = Math.abs(rightPosition.x - blockedTarget.x) + Math.abs(rightPosition.z - blockedTarget.z);
        return rightAwayM - leftAwayM ||
          left.lengthM - right.lengthM ||
          left.nodeId.localeCompare(right.nodeId);
      })[0];
    if (!candidate) {
      return false;
    }

    const route = [currentNodeId, candidate.nodeId];
    const session = this.createAgentRefreshConflictSession(vehicle, blocker, blockedTargetNodeId, 'middle-aisle-opposing-claim');
    this.reassignAgentRefreshConflictSession(session, blocker, vehicle, blockedTargetNodeId);
    session.state = 'yielding';
    session.updatedAtSec = this.simTimeSec;
    session.yielderOriginalNodeId = currentNodeId;
    session.yielderPocketNodeId = candidate.nodeId;
    session.yielderLocalRouteNodeIds = route;
    session.resumeNodeId = blockedTargetNodeId;
    session.clearancePolicy = 'short-horizon';
    session.timeoutAtSec = Math.max(session.timeoutAtSec, round(this.simTimeSec + 20));
    session.expiresAtSec = Math.max(session.expiresAtSec, round(this.simTimeSec + 30));
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = candidate.nodeId;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = round(this.simTimeSec + this.routeTravelEstimateSec(vehicle, route) + 1);
    vehicle.yieldHoldNodeId = candidate.nodeId;
    vehicle.localRouteNodeIds = route;
    vehicle.localRouteReason = 'temporary-yield';
    if (!vehicle.taskId && !vehicle.loaded) {
      vehicle.plannedGoalNodeId = candidate.nodeId;
      vehicle.plannedRouteNodeIds = route;
    }
    this.logAgentReroute(vehicle, task, blockedTargetNodeId, route, 'agent-refresh-middle-aisle-storage-yield', { countTaskReplan: false });
    return true;
  }

  private topLiftInboundRequesterShouldWaitForEarlierPickup(requester: MutableVehicle, blocker: MutableVehicle): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const requesterTask = this.taskForVehicle(requester);
    const blockerTask = this.taskForVehicle(blocker);
    if (
      requesterTask?.kind !== 'inbound' ||
      blockerTask?.kind !== 'inbound' ||
      requesterTask.pickupNodeId !== blockerTask.pickupNodeId
    ) {
      return false;
    }
    if (blockerTask.createdAtSec !== requesterTask.createdAtSec) {
      return blockerTask.createdAtSec < requesterTask.createdAtSec;
    }
    return blockerTask.id.localeCompare(requesterTask.id) < 0;
  }

  private topLiftLaneTransferShouldWait(fromNodeId: string, toNodeId: string, blockReason: string): boolean {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      blockReason !== 'node-local-yield'
    ) {
      return false;
    }

    const fromLevel = topLiftAisleLevel(fromNodeId);
    const toLevel = topLiftAisleLevel(toNodeId);
    const laneTransfer =
      (fromLevel === 'top-a' && toLevel === 'top-b') ||
      (fromLevel === 'top-b' && toLevel === 'top-a') ||
      (fromLevel === 'bottom-a' && toLevel === 'bottom-b') ||
      (fromLevel === 'bottom-b' && toLevel === 'bottom-a');
    if (!laneTransfer) {
      return false;
    }

    const fromNode = this.layoutNode(fromNodeId);
    const toNode = this.layoutNode(toNodeId);
    return Boolean(fromNode && toNode && Math.abs(fromNode.x - toNode.x) <= 1e-6);
  }

  private agentRefreshSameDirectionFollowerBlock(
    vehicle: MutableVehicle,
    blockedTargetNodeId: string,
    blocker: MutableVehicle
  ): boolean {
    const from = nodePosition(this.scenario, vehicle.currentNodeId);
    const target = nodePosition(this.scenario, blockedTargetNodeId);
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length <= 1e-9) {
      return false;
    }

    const ux = dx / length;
    const uz = dz / length;
    const relX = blocker.x - from.x;
    const relZ = blocker.z - from.z;
    const projection = relX * ux + relZ * uz;
    const lateral = Math.abs(relX * -uz + relZ * ux);
    const sameLaneToleranceM = Math.max(0.2, this.scenario.vehicles.widthM * 0.65);
    if (projection < -0.05 || lateral > sameLaneToleranceM) {
      return false;
    }

    const blockerDirection = this.vehicleMovementDirection(blocker);
    if (blockerDirection) {
      return blockerDirection.ux * ux + blockerDirection.uz * uz > 0.5;
    }

    return blocker.currentNodeId === blockedTargetNodeId && blocker.targetNodeId === null;
  }

  private agentRefreshBlockerIsClearingTarget(
    vehicle: MutableVehicle,
    blockedTargetNodeId: string,
    blocker: MutableVehicle
  ): boolean {
    if (blocker.currentNodeId !== blockedTargetNodeId || blocker.currentEdgeId === null || !blocker.targetNodeId) {
      return false;
    }
    return blocker.targetNodeId !== vehicle.currentNodeId;
  }

  private vehicleMovementDirection(vehicle: MutableVehicle): { ux: number; uz: number } | null {
    const nextNodeId = vehicle.targetNodeId ?? vehicle.routeNodeIds[vehicle.routeIndex + 1] ?? null;
    if (!nextNodeId || nextNodeId === vehicle.currentNodeId) {
      return null;
    }
    const from = nodePosition(this.scenario, vehicle.currentNodeId);
    const to = nodePosition(this.scenario, nextNodeId);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    return length > 1e-9 ? { ux: dx / length, uz: dz / length } : null;
  }

  private installSideYieldWithReassignedConflictSession(
    session: ConflictSessionV1,
    winner: MutableVehicle,
    yielder: MutableVehicle,
    resumeNodeId: string | null
  ): boolean {
    const previousSessionState = {
      winnerVehicleId: session.winnerVehicleId,
      yielderVehicleId: session.yielderVehicleId,
      blockerVehicleId: session.blockerVehicleId,
      yielderOriginalNodeId: session.yielderOriginalNodeId,
      yielderPocketNodeId: session.yielderPocketNodeId,
      yielderLocalRouteNodeIds: [...session.yielderLocalRouteNodeIds],
      resumeNodeId: session.resumeNodeId,
      updatedAtSec: session.updatedAtSec,
      clearancePolicy: session.clearancePolicy
    };
    this.reassignAgentRefreshConflictSession(session, winner, yielder, resumeNodeId);
    if (this.agentRefreshInstallSideYield(yielder, resumeNodeId ?? yielder.targetNodeId ?? yielder.currentNodeId, winner, session)) {
      this.logEvent('conflict-session-reassigned', yielder.id, yielder.taskId, null, yielder.currentNodeId, resumeNodeId, 'actual-yielder-side-yield', this.vehiclePosition(yielder), {
        sessionId: session.id,
        winnerVehicleId: session.winnerVehicleId,
        yielderVehicleId: session.yielderVehicleId,
        blockerVehicleId: session.blockerVehicleId,
        resourceKey: session.resourceKey
      });
      return true;
    }

    session.winnerVehicleId = previousSessionState.winnerVehicleId;
    session.yielderVehicleId = previousSessionState.yielderVehicleId;
    session.blockerVehicleId = previousSessionState.blockerVehicleId;
    session.yielderOriginalNodeId = previousSessionState.yielderOriginalNodeId;
    session.yielderPocketNodeId = previousSessionState.yielderPocketNodeId;
    session.yielderLocalRouteNodeIds = previousSessionState.yielderLocalRouteNodeIds;
    session.resumeNodeId = previousSessionState.resumeNodeId;
    session.updatedAtSec = previousSessionState.updatedAtSec;
    session.clearancePolicy = previousSessionState.clearancePolicy;
    return false;
  }

  private reassignAgentRefreshConflictSession(
    session: ConflictSessionV1,
    winner: MutableVehicle,
    yielder: MutableVehicle,
    resumeNodeId: string | null
  ): void {
    session.winnerVehicleId = winner.id;
    session.yielderVehicleId = yielder.id;
    session.blockerVehicleId = winner.id;
    session.yielderOriginalNodeId = yielder.currentNodeId;
    session.yielderPocketNodeId = null;
    session.yielderLocalRouteNodeIds = [];
    session.resumeNodeId = resumeNodeId;
    session.updatedAtSec = this.simTimeSec;
    session.clearancePolicy = 'immediate-next-move';
  }

  private agentRefreshHasHigherPriority(left: MutableVehicle, right: MutableVehicle): boolean {
    const leftPriority = this.agentTurnPriority(left);
    const rightPriority = this.agentTurnPriority(right);
    return leftPriority > rightPriority || (leftPriority === rightPriority && left.id.localeCompare(right.id) < 0);
  }

  private activeConflictSessions(): ConflictSessionV1[] {
    return this.conflictSessions
      .filter((session) => session.state !== 'cleared' && session.state !== 'timed-out')
      .map((session) => structuredClone(session));
  }

  private activeConflictSessionForVehicle(vehicleId: string): ConflictSessionV1 | null {
    return this.conflictSessions.find((session) =>
      session.state !== 'cleared' &&
      session.state !== 'timed-out' &&
      session.participantVehicleIds.includes(vehicleId)
    ) ?? null;
  }

  private activeConflictSessionForPair(leftVehicleId: string, rightVehicleId: string): ConflictSessionV1 | null {
    return this.conflictSessions.find((session) =>
      session.state !== 'cleared' &&
      session.state !== 'timed-out' &&
      session.participantVehicleIds.includes(leftVehicleId) &&
      session.participantVehicleIds.includes(rightVehicleId)
    ) ?? null;
  }

  private updateConflictSessions(): void {
    for (const session of this.conflictSessions) {
      if (session.state === 'cleared' || session.state === 'timed-out') {
        continue;
      }
      const yielder = this.vehicles.find((vehicle) => vehicle.id === session.yielderVehicleId) ?? null;
      const winner = this.vehicles.find((vehicle) => vehicle.id === session.winnerVehicleId) ?? null;
      if (!yielder || !winner) {
        this.closeConflictSession(session, 'participant-missing');
        continue;
      }
      if (this.simTimeSec >= session.timeoutAtSec) {
        session.state = 'timed-out';
        session.updatedAtSec = this.simTimeSec;
        session.closeReason = 'timeout';
        this.logEvent('conflict-session-timed-out', yielder.id, yielder.taskId, null, yielder.currentNodeId, yielder.targetNodeId, 'timeout', this.vehiclePosition(yielder), {
          sessionId: session.id,
          winnerVehicleId: session.winnerVehicleId,
          yielderVehicleId: session.yielderVehicleId
        });
        continue;
      }
      if (
        session.yielderPocketNodeId &&
        yielder.currentNodeId === session.yielderPocketNodeId &&
        yielder.currentEdgeId === null &&
        yielder.legRemainingM <= 0 &&
        session.state === 'yielding'
      ) {
        session.state = 'holding-pocket';
        session.updatedAtSec = this.simTimeSec;
      }
      if (
        session.state === 'holding-pocket' &&
        yielder.currentNodeId !== session.yielderPocketNodeId
      ) {
        session.state = 'returning';
        session.updatedAtSec = this.simTimeSec;
      }
      if (
        session.state === 'returning' &&
        (yielder.currentEdgeId !== null || yielder.waitReason === null) &&
        this.simTimeSec > session.updatedAtSec + this.scenario.timeStepSec
      ) {
        this.closeConflictSession(session, 'yielder-returning');
      }
      if (this.simTimeSec >= session.expiresAtSec) {
        this.closeConflictSession(session, 'expired');
      }
    }

    if (this.conflictSessions.length > 400) {
      this.conflictSessions = this.conflictSessions.slice(-300);
    }
  }

  private closeConflictSession(session: ConflictSessionV1, reason: string): void {
    if (session.state === 'cleared' || session.state === 'timed-out') {
      return;
    }
    session.state = 'cleared';
    session.updatedAtSec = this.simTimeSec;
    session.closeReason = reason;
    this.logEvent('conflict-session-closed', session.yielderVehicleId, null, null, session.yielderPocketNodeId, session.resumeNodeId, reason, null, {
      sessionId: session.id,
      winnerVehicleId: session.winnerVehicleId,
      yielderVehicleId: session.yielderVehicleId
    });
  }

  private createAgentRefreshConflictSession(
    requester: MutableVehicle,
    blocker: MutableVehicle,
    blockedTargetNodeId: string,
    reason: string
  ): ConflictSessionV1 {
    const winner = this.agentRefreshHasHigherPriority(requester, blocker) ? requester : blocker;
    const yielder = winner.id === requester.id ? blocker : requester;
    const participantVehicleIds = [requester.id, blocker.id].sort((left, right) => left.localeCompare(right));
    const resourceKey = this.agentRefreshConflictResourceKey(requester, blocker, blockedTargetNodeId, reason);
    const existing = this.conflictSessions.find((session) =>
      session.state !== 'cleared' &&
      session.state !== 'timed-out' &&
      session.resourceKey === resourceKey
    );
    if (existing) {
      existing.updatedAtSec = this.simTimeSec;
      return existing;
    }

    const session: ConflictSessionV1 = {
      id: `conflict-${String(this.conflictSessions.length + 1).padStart(5, '0')}`,
      kind: 'pair',
      resourceKey,
      state: 'open',
      participantVehicleIds,
      winnerVehicleId: winner.id,
      yielderVehicleId: yielder.id,
      createdAtSec: this.simTimeSec,
      createdAtTick: this.tickIndex,
      updatedAtSec: this.simTimeSec,
      expiresAtSec: round(this.simTimeSec + 20),
      timeoutAtSec: round(this.simTimeSec + 12),
      trigger: this.agentRefreshConflictTrigger(reason),
      initialBlockerVehicleId: blocker.id,
      blockerVehicleId: winner.id,
      yielderOriginalNodeId: yielder.currentNodeId,
      yielderPocketNodeId: null,
      yielderLocalRouteNodeIds: [],
      resumeNodeId: blockedTargetNodeId,
      clearancePolicy: 'immediate-next-move',
      closeReason: null
    };
    this.conflictSessions.push(session);
    this.logEvent('conflict-session-opened', yielder.id, yielder.taskId, null, yielder.currentNodeId, blockedTargetNodeId, reason, this.vehiclePosition(yielder), {
      sessionId: session.id,
      winnerVehicleId: session.winnerVehicleId,
      yielderVehicleId: session.yielderVehicleId,
      blockerVehicleId: session.blockerVehicleId,
      resourceKey: session.resourceKey
    });
    return session;
  }

  private agentRefreshConflictResourceKey(
    requester: MutableVehicle,
    blocker: MutableVehicle,
    blockedTargetNodeId: string,
    reason: string
  ): string {
    const pairKey = [requester.id, blocker.id].sort((left, right) => left.localeCompare(right)).join('+');
    if (reason === 'node-occupied' || reason === 'node-target-near') {
      return `node:${blockedTargetNodeId}:${pairKey}`;
    }
    const edge = this.traffic.findEdge(requester.currentNodeId, blockedTargetNodeId);
    if (edge) {
      return `edge:${edge.id}:${pairKey}`;
    }
    return `${reason}:${blockedTargetNodeId}:${pairKey}`;
  }

  private agentRefreshConflictTrigger(reason: string): ConflictSessionV1['trigger'] {
    if (reason === 'edge-head-on') return 'head-on';
    if (reason === 'node-occupied' || reason === 'node-target-near') return 'same-node';
    if (reason === 'lift-column-near') return 'column-exit';
    if (reason === 'avoidance-clearance' || reason === 'min-separation') return 'swept-footprint';
    return 'deadlock-break';
  }

  private agentRefreshInstallSideYield(
    vehicle: MutableVehicle,
    blockedTargetNodeId: string,
    requester: MutableVehicle,
    session: ConflictSessionV1 | null = null
  ): boolean {
    if (
      vehicle.currentEdgeId !== null ||
      vehicle.legRemainingM > 0 ||
      vehicle.phaseRemainingSec > 0 ||
      vehicle.state === 'lifting' ||
      vehicle.state === 'lowering'
    ) {
      return false;
    }
    if (this.topLiftLoadedOutboundQueueShouldHoldLine(vehicle)) {
      return false;
    }

    const currentNodeId = vehicle.currentNodeId;
    const forbiddenNodeIds = new Set<string>([currentNodeId, blockedTargetNodeId, requester.currentNodeId]);
    const previousNodeId = vehicle.routeNodeIds[vehicle.routeIndex - 1];
    const stagedInboundQueueVehicle =
      !vehicle.loaded &&
      vehicle.plannedGoalNodeId !== null &&
      topLiftQueueParkingSlot(vehicle.plannedGoalNodeId) !== null;
    const allowShortSpineRetreat =
      previousNodeId &&
      this.topLiftColumnLayoutEnabled() &&
      !vehicle.loaded &&
      !stagedInboundQueueVehicle &&
      this.topLiftColumnSpineOrAccessNode(currentNodeId) &&
      this.topLiftColumnSpineOrAccessNode(blockedTargetNodeId);
    if (previousNodeId && !allowShortSpineRetreat) {
      forbiddenNodeIds.add(previousNodeId);
    }
    if (requester.targetNodeId) {
      forbiddenNodeIds.add(requester.targetNodeId);
    }
    const requesterContinuationNodeId = this.agentRouteNodeAfter(requester, blockedTargetNodeId);
    if (requesterContinuationNodeId) {
      forbiddenNodeIds.add(requesterContinuationNodeId);
    }
    for (const nodeId of this.agentRefreshLoadedRequesterProtectedRouteNodeIds(requester)) {
      forbiddenNodeIds.add(nodeId);
    }
    for (const nodeId of this.agentRefreshLoadedTrafficProtectedRouteNodeIds(vehicle)) {
      forbiddenNodeIds.add(nodeId);
    }

    const candidate = this.neighbors(currentNodeId)
      .filter((neighbor) => !forbiddenNodeIds.has(neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketKeepsGoalReachable(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketCanReturn(vehicle, neighbor.nodeId, blockedTargetNodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketMovesAwayFromBlockedTransfer(vehicle, neighbor.nodeId, blockedTargetNodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, currentNodeId, neighbor.nodeId))
      .sort((left, right) =>
        this.agentRefreshYieldPocketRank(vehicle, left.nodeId) - this.agentRefreshYieldPocketRank(vehicle, right.nodeId) ||
        this.agentRefreshYieldPocketDirectionScore(vehicle, left.nodeId, blockedTargetNodeId) - this.agentRefreshYieldPocketDirectionScore(vehicle, right.nodeId, blockedTargetNodeId) ||
        this.agentRefreshYieldPocketTieBreak(vehicle, left.nodeId) - this.agentRefreshYieldPocketTieBreak(vehicle, right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0];

    const selectedCandidate = candidate ?? this.agentRefreshTransferBypassCandidate(
      vehicle,
      currentNodeId,
      forbiddenNodeIds
    ) ?? this.agentRefreshAdjacentTransferBypassCandidate(
      vehicle,
      currentNodeId,
      forbiddenNodeIds
    );
    if (!selectedCandidate) {
      return false;
    }

    const queueContinuationNodeId = this.topLiftQueueSideYieldContinuationNodeId(
      vehicle,
      currentNodeId,
      selectedCandidate.nodeId
    );
    const continuationNodeId = queueContinuationNodeId ?? this.topLiftEmptyStorageSideYieldContinuationNodeId(
      vehicle,
      currentNodeId,
      selectedCandidate.nodeId,
      blockedTargetNodeId
    ) ?? this.topLiftEmptySideYieldContinuationNodeId(
      vehicle,
      currentNodeId,
      selectedCandidate.nodeId,
      blockedTargetNodeId
    );
    const route = continuationNodeId
      ? [currentNodeId, selectedCandidate.nodeId, continuationNodeId]
      : [currentNodeId, selectedCandidate.nodeId];
    const yieldHoldNodeId = route[route.length - 1]!;
    if (this.topLiftColumnLayoutEnabled() && isTopLiftSpineLevelNodeId(yieldHoldNodeId, 'middle')) {
      return false;
    }
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = selectedCandidate.nodeId;
    vehicle.state = vehicle.taskId ? 'assigned' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = round(this.simTimeSec + this.routeTravelEstimateSec(vehicle, route) + 2);
    vehicle.yieldHoldNodeId = yieldHoldNodeId;
    vehicle.localRouteNodeIds = route;
    vehicle.localRouteReason = 'temporary-yield';
    if (session) {
      session.state = 'yielding';
      session.updatedAtSec = this.simTimeSec;
      session.yielderPocketNodeId = yieldHoldNodeId;
      session.yielderLocalRouteNodeIds = route;
      session.resumeNodeId = blockedTargetNodeId;
      session.clearancePolicy = 'immediate-next-move';
    }
    this.logAgentReroute(vehicle, this.taskForVehicle(vehicle), blockedTargetNodeId, route, 'agent-refresh-side-yield', { countTaskReplan: false });
    return true;
  }

  private topLiftLoadedOutboundQueueShouldHoldLine(vehicle: MutableVehicle): boolean {
    if (!this.topLiftColumnLayoutEnabled() || !vehicle.loaded) {
      return false;
    }
    const task = this.taskForVehicle(vehicle);
    if (task?.kind !== 'outbound') {
      return false;
    }
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return false;
    }
    return [vehicle.currentNodeId, vehicle.targetNodeId, vehicle.plannedGoalNodeId]
      .some((nodeId) => nodeId !== null && this.topLiftNodeBelongsToLiftQueueOrService(nodeId, liftNodeId));
  }

  private topLiftNodeBelongsToLiftQueueOrService(nodeId: string, liftNodeId: string): boolean {
    const queueSlot = topLiftQueueParkingSlot(nodeId);
    if (queueSlot?.liftNodeId === liftNodeId) {
      return true;
    }
    const buffer = liftBufferParentNodeId(nodeId);
    if (buffer?.liftNodeId === liftNodeId) {
      return true;
    }
    if (nodeId === liftBufferAccessNodeId(liftNodeId)) {
      return true;
    }
    return nodeId.startsWith(`${liftNodeId}-queue-`);
  }

  private agentRefreshLoadedRequesterProtectedRouteNodeIds(requester: MutableVehicle): string[] {
    if (!this.topLiftColumnLayoutEnabled() || !requester.loaded) {
      return [];
    }
    const task = this.taskForVehicle(requester);
    if (task?.kind !== 'inbound') {
      return [];
    }

    const route = requester.routeNodeIds.length > 1 ? requester.routeNodeIds : requester.plannedRouteNodeIds;
    const currentIndex = route.indexOf(requester.currentNodeId, Math.max(0, requester.routeIndex));
    const startIndex = currentIndex >= 0 ? currentIndex : Math.max(0, requester.routeIndex);
    const dropoffIndex = route.indexOf(task.dropoffNodeId, startIndex);
    const endIndex = dropoffIndex >= 0 ? dropoffIndex : Math.min(route.length - 1, startIndex + 6);
    return route.slice(startIndex + 1, endIndex + 1);
  }

  private agentRefreshLoadedTrafficProtectedRouteNodeIds(yielder: MutableVehicle): string[] {
    if (!this.topLiftColumnLayoutEnabled() || yielder.loaded) {
      return [];
    }

    const protectedNodeIds: string[] = [];
    const seen = new Set<string>();
    for (const vehicle of this.vehicles) {
      if (vehicle.id === yielder.id || !vehicle.loaded) {
        continue;
      }
      for (const nodeId of this.agentRefreshLoadedRequesterProtectedRouteNodeIds(vehicle)) {
        if (!seen.has(nodeId)) {
          seen.add(nodeId);
          protectedNodeIds.push(nodeId);
        }
      }
    }
    return protectedNodeIds;
  }

  private agentRefreshMoveQueueYielderDeeper(
    yielder: MutableVehicle,
    session: ConflictSessionV1,
    winner: MutableVehicle,
    resumeNodeId: string
  ): boolean {
    const currentSlot = topLiftQueueParkingSlot(yielder.currentNodeId);
    const resumeBuffer = liftBufferParentNodeId(resumeNodeId);
    if (
      !this.topLiftColumnLayoutEnabled() ||
      session.winnerVehicleId !== winner.id ||
      session.yielderVehicleId !== yielder.id ||
      (
        !isTopLiftColumnAccessNodeId(resumeNodeId) &&
        (!currentSlot || resumeBuffer?.liftNodeId !== currentSlot.liftNodeId)
      ) ||
      yielder.loaded ||
      yielder.currentEdgeId !== null ||
      yielder.legRemainingM > 0 ||
      yielder.phaseRemainingSec > 0
    ) {
      return false;
    }

    if (!currentSlot) {
      return false;
    }
    const deeperNodeId = liftQueueNodeId(currentSlot.liftNodeId, currentSlot.slotIndex + 1);
    if (!this.layoutNode(deeperNodeId) || !isTopLiftQueueParkingNodeId(deeperNodeId)) {
      return false;
    }
    if (
      this.currentNodeOccupancy.get(deeperNodeId) ||
      this.nodeClaimedByOtherVehicle(deeperNodeId, yielder.id)
    ) {
      return false;
    }

    const blockedNodeIds = new Set<string>();
    for (const [nodeId, occupantId] of this.currentNodeOccupancy) {
      if (occupantId !== yielder.id && nodeId !== deeperNodeId) {
        blockedNodeIds.add(nodeId);
      }
    }
    let route: string[];
    try {
      route = this.agentRefreshShortestPath(yielder.currentNodeId, deeperNodeId, blockedNodeIds);
    } catch {
      return false;
    }
    const nextNodeId = route[1];
    if (
      !nextNodeId ||
      route.at(-1) !== deeperNodeId ||
      !this.agentMinimalYieldFirstLegSafe(yielder, yielder.currentNodeId, nextNodeId) ||
      route.slice(1).some((nodeId) => nodeId !== deeperNodeId && this.nodeClaimedByOtherVehicle(nodeId, yielder.id))
    ) {
      return false;
    }

    yielder.routeNodeIds = route;
    yielder.routeIndex = 0;
    yielder.targetNodeId = nextNodeId;
    yielder.state = yielder.taskId ? 'assigned' : 'returning';
    yielder.waitReason = null;
    yielder.blockingReservationId = null;
    yielder.blockingVehicleId = null;
    yielder.waitingSinceSec = null;
    yielder.yieldHoldUntilSec = round(this.simTimeSec + this.routeTravelEstimateSec(yielder, route) + 8);
    yielder.yieldHoldNodeId = deeperNodeId;
    yielder.localRouteNodeIds = route;
    yielder.localRouteReason = 'temporary-yield';
    session.state = 'yielding';
    session.updatedAtSec = this.simTimeSec;
    session.yielderPocketNodeId = deeperNodeId;
    session.yielderLocalRouteNodeIds = route;
    session.resumeNodeId = resumeNodeId;
    session.timeoutAtSec = Math.max(session.timeoutAtSec, round(this.simTimeSec + 18));
    session.expiresAtSec = Math.max(session.expiresAtSec, round(this.simTimeSec + 24));
    this.logAgentReroute(yielder, this.taskForVehicle(yielder), resumeNodeId, route, 'agent-refresh-queue-tail-yield', { countTaskReplan: false });
    return true;
  }

  private topLiftQueueSideYieldContinuationNodeId(
    vehicle: MutableVehicle,
    currentNodeId: string,
    pocketNodeId: string
  ): string | null {
    if (!this.topLiftColumnLayoutEnabled() || vehicle.loaded) {
      return null;
    }
    const currentSlot = topLiftQueueParkingSlot(currentNodeId);
    const pocketSlot = topLiftQueueParkingSlot(pocketNodeId);
    if (
      !currentSlot ||
      !pocketSlot ||
      currentSlot.liftNodeId !== pocketSlot.liftNodeId ||
      pocketSlot.slotIndex !== currentSlot.slotIndex + 1
    ) {
      return null;
    }

    const tailNodeId = liftQueueNodeId(currentSlot.liftNodeId, pocketSlot.slotIndex + 1);
    if (
      !this.layoutNode(tailNodeId) ||
      !this.traffic.findEdge(pocketNodeId, tailNodeId) ||
      this.currentNodeOccupancy.get(tailNodeId) ||
      this.nodeClaimedByOtherVehicle(tailNodeId, vehicle.id)
    ) {
      return null;
    }
    return tailNodeId;
  }

  private topLiftEmptySideYieldContinuationNodeId(
    vehicle: MutableVehicle,
    currentNodeId: string,
    pocketNodeId: string,
    blockedTargetNodeId: string
  ): string | null {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      vehicle.loaded ||
      this.isStorageNode(currentNodeId) ||
      !isTopLiftColumnAccessNodeId(currentNodeId) ||
      !isTopLiftColumnAccessNodeId(pocketNodeId)
    ) {
      return null;
    }
    const blockedTarget = nodePosition(this.scenario, blockedTargetNodeId);
    return this.neighbors(pocketNodeId)
      .filter((neighbor) => this.layoutNode(neighbor.nodeId)?.type === 'storage')
      .filter((neighbor) =>
        this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId) ||
        this.topLiftMiddleAisleTemporaryStorageYieldContinuationAllowed(vehicle, currentNodeId, pocketNodeId, neighbor.nodeId)
      )
      .filter((neighbor) => this.traffic.findEdge(pocketNodeId, neighbor.nodeId) !== null)
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, pocketNodeId, neighbor.nodeId))
      .sort((left, right) => {
        const leftPosition = nodePosition(this.scenario, left.nodeId);
        const rightPosition = nodePosition(this.scenario, right.nodeId);
        const leftAwayM = Math.abs(leftPosition.x - blockedTarget.x) + Math.abs(leftPosition.z - blockedTarget.z);
        const rightAwayM = Math.abs(rightPosition.x - blockedTarget.x) + Math.abs(rightPosition.z - blockedTarget.z);
        return rightAwayM - leftAwayM ||
          left.lengthM - right.lengthM ||
          left.nodeId.localeCompare(right.nodeId);
      })[0]?.nodeId ?? null;
  }

  private topLiftEmptyStorageSideYieldContinuationNodeId(
    vehicle: MutableVehicle,
    currentNodeId: string,
    pocketNodeId: string,
    blockedTargetNodeId: string
  ): string | null {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      vehicle.loaded ||
      !isTopLiftColumnAccessNodeId(currentNodeId) ||
      !this.isStorageNode(pocketNodeId)
    ) {
      return null;
    }

    const current = nodePosition(this.scenario, currentNodeId);
    const blockedTarget = nodePosition(this.scenario, blockedTargetNodeId);
    const pocketPosition = this.storageGridPosition(pocketNodeId);
    if (!pocketPosition) {
      return null;
    }

    return this.neighbors(pocketNodeId)
      .filter((neighbor) => {
        const position = this.storageGridPosition(neighbor.nodeId);
        return position !== null && position.column === pocketPosition.column;
      })
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.traffic.findEdge(pocketNodeId, neighbor.nodeId) !== null)
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, pocketNodeId, neighbor.nodeId))
      .sort((left, right) => {
        const leftPosition = nodePosition(this.scenario, left.nodeId);
        const rightPosition = nodePosition(this.scenario, right.nodeId);
        const leftAwayFromCurrentM = Math.abs(leftPosition.x - current.x) + Math.abs(leftPosition.z - current.z);
        const rightAwayFromCurrentM = Math.abs(rightPosition.x - current.x) + Math.abs(rightPosition.z - current.z);
        const leftAwayFromBlockedM = Math.abs(leftPosition.x - blockedTarget.x) + Math.abs(leftPosition.z - blockedTarget.z);
        const rightAwayFromBlockedM = Math.abs(rightPosition.x - blockedTarget.x) + Math.abs(rightPosition.z - blockedTarget.z);
        return rightAwayFromCurrentM - leftAwayFromCurrentM ||
          rightAwayFromBlockedM - leftAwayFromBlockedM ||
          left.lengthM - right.lengthM ||
          left.nodeId.localeCompare(right.nodeId);
      })[0]?.nodeId ?? null;
  }

  private agentRefreshTransferBypassCandidate(
    vehicle: MutableVehicle,
    currentNodeId: string,
    forbiddenNodeIds: Set<string>
  ): { nodeId: string; lengthM: number } | null {
    const currentLiftId = this.liftStorageTransferTargetLiftId(currentNodeId);
    if (!currentLiftId || vehicle.loaded) {
      return null;
    }

    const current = nodePosition(this.scenario, currentNodeId);
    return this.neighbors(currentNodeId)
      .filter((neighbor) => !forbiddenNodeIds.has(neighbor.nodeId))
      .filter((neighbor) => this.liftStorageTransferTargetLiftId(neighbor.nodeId) === currentLiftId)
      .filter((neighbor) => this.agentRefreshYieldPocketCanReturn(vehicle, neighbor.nodeId, currentNodeId))
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => !this.nodeClaimedByOtherVehicle(neighbor.nodeId, vehicle.id))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, currentNodeId, neighbor.nodeId))
      .sort((left, right) => {
        const leftNode = nodePosition(this.scenario, left.nodeId);
        const rightNode = nodePosition(this.scenario, right.nodeId);
        return Math.abs(leftNode.z - current.z) - Math.abs(rightNode.z - current.z) ||
          left.lengthM - right.lengthM ||
          left.nodeId.localeCompare(right.nodeId);
      })[0] ?? null;
  }

  private agentRefreshAdjacentTransferBypassCandidate(
    vehicle: MutableVehicle,
    currentNodeId: string,
    forbiddenNodeIds: Set<string>
  ): { nodeId: string; lengthM: number } | null {
    if (!this.isStorageNode(currentNodeId) || vehicle.loaded) {
      return null;
    }

    return this.neighbors(currentNodeId)
      .filter((neighbor) => !forbiddenNodeIds.has(neighbor.nodeId))
      .filter((neighbor) => this.liftStorageTransferTargetLiftId(neighbor.nodeId) !== null)
      .filter((neighbor) => this.agentRefreshYieldPocketCanReturn(vehicle, neighbor.nodeId, currentNodeId))
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => !this.nodeClaimedByOtherVehicle(neighbor.nodeId, vehicle.id))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, currentNodeId, neighbor.nodeId))
      .sort((left, right) =>
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0] ?? null;
  }

  private agentRouteNodeAfter(vehicle: MutableVehicle, nodeId: string): string | null {
    const routeIndex = vehicle.routeNodeIds.indexOf(nodeId, Math.max(0, vehicle.routeIndex));
    if (routeIndex >= 0) {
      return vehicle.routeNodeIds[routeIndex + 1] ?? null;
    }
    const plannedIndex = vehicle.plannedRouteNodeIds.indexOf(nodeId);
    return plannedIndex >= 0 ? vehicle.plannedRouteNodeIds[plannedIndex + 1] ?? null : null;
  }

  private agentRefreshYieldPocketCanReturn(
    vehicle: MutableVehicle,
    pocketNodeId: string,
    resumeNodeId: string
  ): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return true;
    }
    if (pocketNodeId === resumeNodeId) {
      return true;
    }
    const blockedNodeIds = new Set<string>();
    if (!this.isStorageNode(pocketNodeId) && !this.isStorageNode(resumeNodeId)) {
      for (const node of this.scenario.layout.nodes) {
        if (node.type === 'storage') {
          blockedNodeIds.add(node.id);
        }
      }
      blockedNodeIds.delete(pocketNodeId);
      blockedNodeIds.delete(resumeNodeId);
    }
    try {
      this.agentRefreshShortestPath(pocketNodeId, resumeNodeId, blockedNodeIds);
      return true;
    } catch {
      const task = this.taskForVehicle(vehicle);
      const goalNodeId = this.agentGoalNodeId(vehicle, task);
      if (!goalNodeId || goalNodeId === resumeNodeId) {
        return false;
      }
      try {
        this.agentRefreshShortestPath(pocketNodeId, goalNodeId, blockedNodeIds);
        return true;
      } catch {
        return false;
      }
    }
  }

  private agentRefreshYieldPocketAllowed(
    vehicle: MutableVehicle,
    nodeId: string
  ): boolean {
    const node = this.layoutNode(nodeId);
    if (!node || node.type === 'lift-blackbox' || this.liftStorageTransferTargetLiftId(nodeId)) {
      return false;
    }
    const occupantId = this.currentNodeOccupancy.get(nodeId);
    if (occupantId && occupantId !== vehicle.id) {
      return false;
    }
    const claimantId = this.nodeClaimedByOtherVehicle(nodeId, vehicle.id);
    if (claimantId) {
      return false;
    }
    if (node.type === 'storage') {
      const task = this.taskForVehicle(vehicle);
      if (
        this.topLiftColumnLayoutEnabled() &&
        !this.isStorageNode(vehicle.currentNodeId) &&
        !isTopLiftColumnAccessNodeId(vehicle.currentNodeId)
      ) {
        return false;
      }
      if (
        this.topLiftColumnLayoutEnabled() &&
        !vehicle.loaded &&
        task?.kind === 'inbound' &&
        (this.inboundTaskHasEarlierPickupTask(task) ||
          (vehicle.plannedGoalNodeId !== null && topLiftQueueParkingSlot(vehicle.plannedGoalNodeId) !== null)) &&
        !this.topLiftMiddleAisleTemporaryStorageYieldAllowed(vehicle, nodeId)
      ) {
        return false;
      }
      if (
        this.topLiftColumnLayoutEnabled() &&
        !vehicle.loaded &&
        task?.kind === 'outbound' &&
        nodeId !== task.pickupNodeId &&
        !this.topLiftMiddleAisleTemporaryStorageYieldAllowed(vehicle, nodeId)
      ) {
        return false;
      }
      if (
        this.topLiftColumnLayoutEnabled() &&
        vehicle.loaded &&
        task?.kind === 'inbound' &&
        nodeId !== task.dropoffNodeId &&
        !this.topLiftMiddleAisleTemporaryStorageYieldAllowed(vehicle, nodeId)
      ) {
        return false;
      }
      return this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId);
    }
    if (
      this.topLiftColumnLayoutEnabled() &&
      isTopLiftColumnAccessNodeId(node.id)
    ) {
      return true;
    }
    return node.type === 'parking' || node.type === 'aisle' || /^left-row-|^right-row-/.test(node.id);
  }

  private topLiftMiddleAisleTemporaryStorageYieldAllowed(vehicle: MutableVehicle, nodeId: string): boolean {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      !isTopLiftAisleLevelNodeId(vehicle.currentNodeId, 'middle') ||
      !this.isStorageNode(nodeId) ||
      !this.traffic.findEdge(vehicle.currentNodeId, nodeId)
    ) {
      return false;
    }
    return this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId);
  }

  private topLiftMiddleAisleTemporaryStorageYieldContinuationAllowed(
    vehicle: MutableVehicle,
    currentNodeId: string,
    pocketNodeId: string,
    storageNodeId: string
  ): boolean {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      vehicle.loaded ||
      !isTopLiftAisleLevelNodeId(currentNodeId, 'middle') ||
      !isTopLiftAisleLevelNodeId(pocketNodeId, 'middle') ||
      !this.isStorageNode(storageNodeId) ||
      !this.traffic.findEdge(pocketNodeId, storageNodeId)
    ) {
      return false;
    }
    return this.agentRefreshTemporaryStorageNodeAllowed(vehicle, storageNodeId);
  }

  private agentRefreshYieldPocketMovesAwayFromBlockedTransfer(
    vehicle: MutableVehicle,
    nodeId: string,
    blockedTargetNodeId: string
  ): boolean {
    if (
      !this.isStorageNode(vehicle.currentNodeId) ||
      !this.isStorageNode(nodeId) ||
      this.liftStorageTransferTargetLiftId(blockedTargetNodeId) === null
    ) {
      return true;
    }
    const current = nodePosition(this.scenario, vehicle.currentNodeId);
    const candidate = nodePosition(this.scenario, nodeId);
    const blockedTarget = nodePosition(this.scenario, blockedTargetNodeId);
    const currentDistanceM = Math.abs(current.x - blockedTarget.x) + Math.abs(current.z - blockedTarget.z);
    const candidateDistanceM = Math.abs(candidate.x - blockedTarget.x) + Math.abs(candidate.z - blockedTarget.z);
    return candidateDistanceM > currentDistanceM + 0.1;
  }

  private agentRefreshYieldPocketRank(vehicle: MutableVehicle, nodeId: string): number {
    const node = this.layoutNode(nodeId);
    if (!node) {
      return 99;
    }
    if (
      this.topLiftColumnLayoutEnabled() &&
      !vehicle.loaded &&
      isTopLiftColumnAccessNodeId(vehicle.currentNodeId) &&
      node.type === 'storage'
    ) {
      return 0;
    }
    if (
      this.topLiftColumnLayoutEnabled() &&
      !this.isStorageNode(vehicle.currentNodeId) &&
      !vehicle.loaded &&
      isTopLiftSpineLevelNodeId(vehicle.currentNodeId, 'middle') &&
      isTopLiftAisleLevelNodeId(node.id, 'middle')
    ) {
      return 0;
    }
    if (
      this.topLiftColumnLayoutEnabled() &&
      !this.isStorageNode(vehicle.currentNodeId) &&
      isTopLiftColumnAccessNodeId(node.id)
    ) {
      return vehicle.loaded ? 0 : 1;
    }
    if (node.type === 'storage') {
      if (this.topLiftColumnLayoutEnabled() && !this.isStorageNode(vehicle.currentNodeId)) {
        return vehicle.loaded ? 1 : 0;
      }
      return vehicle.loaded ? 1 : 0;
    }
    if (
      this.topLiftColumnLayoutEnabled() &&
      isTopLiftColumnAccessNodeId(node.id)
    ) {
      return vehicle.loaded ? 0 : 1;
    }
    if (/^left-row-|^right-row-/.test(node.id)) {
      return 2;
    }
    if (node.type === 'parking') {
      return 3;
    }
    if (node.type === 'aisle') {
      return 4;
    }
    return 10;
  }

  private agentRefreshYieldPocketDirectionScore(
    vehicle: MutableVehicle,
    nodeId: string,
    blockedTargetNodeId: string
  ): number {
    if (
      !this.isStorageNode(vehicle.currentNodeId) ||
      !this.isStorageNode(nodeId) ||
      this.liftStorageTransferTargetLiftId(blockedTargetNodeId) === null
    ) {
      return 0;
    }
    const current = nodePosition(this.scenario, vehicle.currentNodeId);
    const candidate = nodePosition(this.scenario, nodeId);
    const blockedTarget = nodePosition(this.scenario, blockedTargetNodeId);
    const currentDistanceM = Math.abs(current.x - blockedTarget.x) + Math.abs(current.z - blockedTarget.z);
    const candidateDistanceM = Math.abs(candidate.x - blockedTarget.x) + Math.abs(candidate.z - blockedTarget.z);
    if (candidateDistanceM > currentDistanceM + 0.1) {
      return -candidateDistanceM;
    }
    if (candidateDistanceM < currentDistanceM - 0.1) {
      return 100 + candidateDistanceM;
    }
    return 0;
  }

  private agentRefreshYieldPocketTieBreak(vehicle: MutableVehicle, nodeId: string): number {
    if (!this.liftStorageTransferTargetLiftId(vehicle.currentNodeId)) {
      return 0;
    }
    const position = this.storageGridPosition(nodeId);
    return position ? -position.column : 0;
  }

  private taskForVehicle(vehicle: MutableVehicle): TaskStateRecord | null {
    return this.taskById(vehicle.taskId);
  }

  private agentGoalNodeId(vehicle: MutableVehicle, task: TaskStateRecord | null): string | null {
    if (task) {
      return this.taskDispatchGoalNodeId(task, vehicle);
    }
    if (this.topLiftColumnLayoutEnabled() && vehicle.plannedGoalNodeId && vehicle.plannedGoalNodeId !== vehicle.currentNodeId) {
      return vehicle.plannedGoalNodeId;
    }
    const routeGoal = vehicle.routeNodeIds.at(-1) ?? null;
    return routeGoal && routeGoal !== vehicle.currentNodeId ? routeGoal : null;
  }

  private agentRouteToGoal(vehicle: MutableVehicle, task: TaskStateRecord | null, goalNodeId: string): string[] {
    if (this.agentRefreshEnabled()) {
      const committedLocalRoute = this.agentRefreshCommittedLocalRoute(vehicle, goalNodeId);
      if (committedLocalRoute) {
        return committedLocalRoute;
      }

      const committedRoute = this.agentCommittedRoute(vehicle, goalNodeId);
      if (committedRoute) {
        return committedRoute;
      }

      return this.installAgentRefreshPlannedRoute(vehicle, task, goalNodeId);
    }

    if (this.agentMinimalEnabled()) {
      const committedYieldRoute = this.agentCommittedYieldRoute(vehicle, goalNodeId);
      if (committedYieldRoute) {
        const committedNextNodeId = committedYieldRoute[1] ?? null;
        if (committedNextNodeId && (!this.collisionAvoidanceEnabled() || !this.agentMinimalMoveBlocker(vehicle, committedNextNodeId))) {
          return committedYieldRoute;
        }
      }

      const committedRoute = this.agentCommittedRoute(vehicle, goalNodeId);
      if (committedRoute) {
        const committedNextNodeId = committedRoute[1] ?? null;
        if (
          committedNextNodeId &&
          (!this.collisionAvoidanceEnabled() || !this.agentMinimalMoveBlocker(vehicle, committedNextNodeId))
        ) {
          return committedRoute;
        }
      }

      return this.agentNominalRouteToGoal(vehicle, task, goalNodeId);
    }

    const committedRoute = this.agentCommittedRoute(vehicle, goalNodeId);
    if (committedRoute) {
      const committedNextNodeId = committedRoute[1] ?? null;
      if (committedNextNodeId && (!this.collisionAvoidanceEnabled() || !this.agentMoveBlocker(vehicle, committedNextNodeId))) {
        return committedRoute;
      }
    }

    const committedYieldRoute = this.agentCommittedYieldRoute(vehicle, goalNodeId);
    if (committedYieldRoute) {
      const committedNextNodeId = committedYieldRoute[1] ?? null;
      if (committedNextNodeId && (!this.collisionAvoidanceEnabled() || !this.agentMoveBlocker(vehicle, committedNextNodeId))) {
        return committedYieldRoute;
      }
    }

    const directRoute = this.agentNominalRouteToGoal(vehicle, task, goalNodeId);
    const directNextNodeId = directRoute[1] ?? null;
    if (!this.collisionAvoidanceEnabled() || !directNextNodeId) {
      return directRoute;
    }

    const directBlock = this.agentMoveBlocker(vehicle, directNextNodeId);
    const lookaheadBlock = directBlock ? null : this.agentEmptyStorageExitLookaheadBlocker(vehicle, directRoute);
    if (!directBlock && !lookaheadBlock) {
      return directRoute;
    }
    const blockedNodeId = directBlock ? directNextNodeId : lookaheadBlock!.nodeId;

    if (vehicle.loaded) {
      return directRoute;
    }
    if (this.isStorageNode(vehicle.currentNodeId)) {
      const headOnYieldRoute = directBlock?.blockingVehicleId
        ? this.agentStorageHeadOnYieldRoute(vehicle, task, goalNodeId, directNextNodeId, directBlock.blockingVehicleId)
        : null;
      return headOnYieldRoute ?? directRoute;
    }

    try {
      if (!vehicle.loaded) {
        const storageBypassRoute = this.agentStorageBypassRoute(vehicle, task, goalNodeId, blockedNodeId, directRoute);
        if (storageBypassRoute) {
          return storageBypassRoute;
        }
      }

      const blockedNodeIds = this.agentStaticBlockedNodeIds(vehicle, goalNodeId, { openStorageRows: !vehicle.loaded });
      for (const nodeId of this.agentDynamicBlockedNodeIds(vehicle)) {
        blockedNodeIds.add(nodeId);
      }
      const alternateRoute = this.agentShortestPath(vehicle.currentNodeId, goalNodeId, blockedNodeIds);
      const alternateNextNodeId = alternateRoute[1] ?? null;
      if (
        alternateNextNodeId &&
        !this.agentMoveBlocker(vehicle, alternateNextNodeId) &&
        this.agentLocalRerouteAcceptable(directRoute, alternateRoute)
      ) {
        this.logAgentReroute(vehicle, task, blockedNodeId, alternateRoute, vehicle.loaded ? 'loaded-local-obstacle-reroute' : 'empty-local-obstacle-reroute');
        return alternateRoute;
      }
    } catch {
      // Waiting is better than forcing a strange detour when there is no real local bypass.
    }

    return directRoute;
  }

  private agentRefreshCommittedLocalRoute(vehicle: MutableVehicle, goalNodeId: string): string[] | null {
    if (!vehicle.localRouteReason) {
      return null;
    }
    const currentIndex = vehicle.routeNodeIds.indexOf(vehicle.currentNodeId, Math.max(0, vehicle.routeIndex));
    if (currentIndex < 0) {
      return null;
    }
    const route = vehicle.routeNodeIds.slice(currentIndex);
    if (route.length < 2 || route[0] !== vehicle.currentNodeId || route.at(-1) === goalNodeId) {
      return null;
    }
    const nextNodeId = route[1]!;
    return this.traffic.findEdge(vehicle.currentNodeId, nextNodeId) && this.agentRefreshLocalRouteNodesClear(vehicle, route)
      ? route
      : null;
  }

  private agentRefreshLocalRouteNodesClear(vehicle: MutableVehicle, routeNodeIds: string[]): boolean {
    for (const nodeId of routeNodeIds.slice(1)) {
      const occupantId = this.currentNodeOccupancy.get(nodeId);
      if (occupantId && occupantId !== vehicle.id) {
        return false;
      }
      if (this.nodeClaimedByOtherVehicle(nodeId, vehicle.id)) {
        return false;
      }
    }
    return true;
  }

  private agentRefreshNominalRouteToGoal(vehicle: MutableVehicle, task: TaskStateRecord | null, goalNodeId: string): string[] {
    if (task?.kind === 'inbound' && vehicle.loaded && goalNodeId === task.dropoffNodeId) {
      return this.agentRefreshLoadedInboundRouteToDropoff(vehicle.currentNodeId, task);
    }
    if (task?.kind === 'inbound' && !vehicle.loaded) {
      const pickupRoute = this.agentRefreshEmptyInboundRouteToPickup(vehicle, task, goalNodeId);
      if (pickupRoute) {
        return pickupRoute;
      }
    }
    if (task?.kind === 'outbound' && vehicle.loaded) {
      const dropoffRoute = this.agentRefreshLoadedOutboundRouteToDropoff(vehicle.currentNodeId, task, goalNodeId);
      if (dropoffRoute) {
        return dropoffRoute;
      }
    }

    const blockedNodeIds = this.agentRefreshBlockedNodeIds(vehicle, task, goalNodeId);
    return this.agentRefreshExpandLiftColumnSegments(
      this.agentRefreshShortestPath(vehicle.currentNodeId, goalNodeId, blockedNodeIds)
    );
  }

  private topLiftQueueServiceTargets(currentNodeId: string, liftNodeId: string, serviceNodeId: string): string[] | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const serviceAccessNodeId = liftBufferAccessNodeId(liftNodeId);
    if (!this.layoutNode(serviceAccessNodeId) || !this.layoutNode(serviceNodeId)) {
      return null;
    }
    if (currentNodeId === serviceNodeId) {
      return [];
    }

    if (/-outbound$/.test(liftNodeId)) {
      const serviceLaneNodeId = liftQueueServiceExitNodeId(liftNodeId, 1);
      if (this.layoutNode(serviceLaneNodeId)) {
        return currentNodeId === serviceAccessNodeId
          ? [serviceNodeId]
          : [serviceLaneNodeId, serviceAccessNodeId, serviceNodeId];
      }
    }

    return currentNodeId === serviceAccessNodeId
      ? [serviceNodeId]
      : [serviceAccessNodeId, serviceNodeId];
  }

  private agentRefreshEmptyInboundRouteToPickup(
    vehicle: MutableVehicle,
    task: TaskStateRecord,
    goalNodeId = task.pickupNodeId
  ): string[] | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }

    const route: string[] = [vehicle.currentNodeId];
    const currentExitNodeId = this.isStorageNode(vehicle.currentNodeId)
      ? this.topLiftNearestStorageColumnAccessNodeId(vehicle.currentNodeId)
      : null;
    const liftNodeId = this.taskLiftPortNodeId(task);
    const queueServiceTargets = goalNodeId === task.pickupNodeId && liftNodeId
      ? this.topLiftQueueServiceTargets(vehicle.currentNodeId, liftNodeId, task.pickupNodeId)
      : null;
    const targets = [currentExitNodeId, ...(queueServiceTargets ?? [goalNodeId])];

    for (const target of targets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      const blockedNodeIds = this.isStorageNode(fromNodeId) || this.isStorageNode(target)
        ? this.blockedStorageTransitNodeIds(fromNodeId, target)
        : this.agentRefreshBlockedNodeIds(vehicle, task, target);
      blockedNodeIds.delete(fromNodeId);
      blockedNodeIds.delete(target);
      const segment = this.agentRefreshShortestPath(fromNodeId, target, blockedNodeIds);
      route.push(...segment.slice(1));
    }

    return route.length > 1 ? this.agentRefreshExpandLiftColumnSegments(route) : null;
  }

  private topLiftNearestStorageColumnAccessNodeId(storageNodeId: string): string | null {
    const position = this.storageGridPosition(storageNodeId);
    if (!position || !this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const rowsPerZone = this.topLiftColumnRowsPerZone();
    const zoneRow = position.row <= rowsPerZone ? position.row : position.row - rowsPerZone;
    const nearRightEntry = zoneRow <= (rowsPerZone + 1) / 2;
    return this.storageSideNodeId(storageNodeId, nearRightEntry ? 'right' : 'left') ??
      this.storageSideNodeId(storageNodeId, nearRightEntry ? 'left' : 'right');
  }

  private agentRefreshLoadedOutboundRouteToDropoff(currentNodeId: string, task: TaskStateRecord, goalNodeId = task.dropoffNodeId): string[] | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }

    const route: string[] = [currentNodeId];
    const currentExitNodeId = this.isStorageNode(currentNodeId)
      ? this.storageSideNodeId(currentNodeId, 'left') ?? this.nearestStorageSideNodeId(currentNodeId)
      : null;
    const liftNodeId = goalNodeId === task.dropoffNodeId ? this.taskLiftPortNodeId(task) : null;
    const queueServiceTargets = liftNodeId
      ? this.topLiftQueueServiceTargets(currentNodeId, liftNodeId, task.dropoffNodeId)
      : null;
    const targets = [currentExitNodeId, ...(queueServiceTargets ?? [goalNodeId])];

    for (const target of targets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      const directColumnExitRoute = this.isStorageNode(fromNodeId)
        ? this.topLiftDirectStorageColumnExitRoute(fromNodeId, target)
        : null;
      if (directColumnExitRoute) {
        route.push(...directColumnExitRoute.slice(1));
        continue;
      }
      const blockedNodeIds = this.blockedStorageTransitNodeIds(fromNodeId, target, { blockStoredLoads: false });
      blockedNodeIds.delete(fromNodeId);
      blockedNodeIds.delete(target);
      const segment = this.agentRefreshShortestPath(fromNodeId, target, blockedNodeIds);
      route.push(...segment.slice(1));
    }

    return route.length > 1 ? this.agentRefreshExpandLiftColumnSegments(route) : null;
  }

  private agentRefreshLoadedInboundRouteToDropoff(currentNodeId: string, task: TaskStateRecord): string[] {
    const route: string[] = [currentNodeId];
    const serviceExitRoute = this.topLiftInboundLoadedServiceExitRoute(currentNodeId, task);
    if (serviceExitRoute) {
      route.push(...serviceExitRoute.slice(1));
    }
    const dropoffRowLabel = this.nodeStorageRowLabel(task.dropoffNodeId);
    const routeStartNodeId = route[route.length - 1]!;
    const currentRowLabel = this.nodeStorageRowLabel(routeStartNodeId);
    const alreadyInsideDropoffRow = this.isStorageNode(routeStartNodeId) && currentRowLabel !== null && currentRowLabel === dropoffRowLabel;
    const currentStorageExitNodeId = this.isStorageNode(routeStartNodeId) && currentRowLabel !== dropoffRowLabel
      ? this.storageSideNodeId(routeStartNodeId, 'right') ?? this.nearestStorageSideNodeId(routeStartNodeId)
      : null;
    const candidateLiftRowTransferNodeId = alreadyInsideDropoffRow ? null : this.agentRefreshLiftRowTransferNodeId(routeStartNodeId, task.dropoffNodeId);
    const liftRowTransferNodeId = candidateLiftRowTransferNodeId && this.agentRefreshLoadedInboundSegmentAvailable(candidateLiftRowTransferNodeId, task.dropoffNodeId, task)
      ? candidateLiftRowTransferNodeId
      : null;
    const preEntryTargets = alreadyInsideDropoffRow
      ? []
      : [
          currentStorageExitNodeId,
          liftRowTransferNodeId
        ];

    for (const target of preEntryTargets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      try {
        this.appendAgentRefreshLoadedInboundSegment(route, target, task);
      } catch (error) {
        const fallbackRoute = target === task.dropoffNodeId
          ? this.agentRefreshLoadedInboundEntryFallbackRoute(fromNodeId, task)
          : null;
        if (!fallbackRoute) {
          throw error;
        }
        route.push(...fallbackRoute.slice(1));
        return route;
      }
    }

    if (!alreadyInsideDropoffRow && !liftRowTransferNodeId) {
      const entryRoute = this.agentRefreshLoadedInboundBestEntryRoute(route, task);
      if (entryRoute) {
        return entryRoute;
      }
    }

    if (task.dropoffNodeId !== route[route.length - 1]) {
      const fromNodeId = route[route.length - 1]!;
      try {
        this.appendAgentRefreshLoadedInboundSegment(route, task.dropoffNodeId, task);
      } catch (error) {
        const fallbackRoute = this.agentRefreshLoadedInboundEntryFallbackRoute(fromNodeId, task);
        if (!fallbackRoute) {
          throw error;
        }
        route.push(...fallbackRoute.slice(1));
      }
    }

    return route;
  }

  private topLiftInboundLoadedServiceExitRoute(currentNodeId: string, task: TaskStateRecord): string[] | null {
    if (!this.topLiftColumnLayoutEnabled() || task.kind !== 'inbound' || !task.pickupNodeId) {
      return null;
    }
    const pickupBuffer = liftBufferParentNodeId(task.pickupNodeId);
    if (!pickupBuffer || pickupBuffer.kind !== 'inbound') {
      return null;
    }
    const liftNodeId = pickupBuffer.liftNodeId;
    const bufferAccessNodeId = liftBufferAccessNodeId(liftNodeId);
    const serviceExitNodeId = liftQueueServiceExitNodeId(liftNodeId, 1);
    const entryNodeId = liftQueueTailEntryNodeId(liftNodeId, 1);
    if (!this.layoutNode(bufferAccessNodeId) || !this.layoutNode(serviceExitNodeId) || !this.layoutNode(entryNodeId)) {
      return null;
    }

    const route =
      currentNodeId === task.pickupNodeId ? [currentNodeId, bufferAccessNodeId, serviceExitNodeId, entryNodeId] :
      currentNodeId === bufferAccessNodeId ? [currentNodeId, serviceExitNodeId, entryNodeId] :
      currentNodeId === serviceExitNodeId ? [currentNodeId, entryNodeId] :
      currentNodeId === entryNodeId ? [currentNodeId] :
      null;
    if (!route) {
      return null;
    }
    const entryExitRoute = this.topLiftInboundQueueExitRoute(entryNodeId, task);
    if (entryExitRoute) {
      route.push(...entryExitRoute.slice(1));
    }
    if (route.length < 2) {
      return null;
    }
    for (let index = 1; index < route.length; index += 1) {
      if (!this.traffic.findEdge(route[index - 1]!, route[index]!)) {
        return null;
      }
    }
    return route;
  }

  private topLiftInboundQueueExitRoute(entryNodeId: string, task: TaskStateRecord): string[] | null {
    const dropoffPosition = this.storageGridPosition(task.dropoffNodeId);
    if (!dropoffPosition || dropoffPosition.row > this.topLiftColumnRowsPerZone()) {
      return this.topLiftInboundQueueEntryDownRoute(entryNodeId);
    }

    const entryNode = this.layoutNode(entryNodeId);
    if (!entryNode) {
      return null;
    }
    const topAColumnNode = this.scenario.layout.nodes.find((node) =>
      /^column-top-a-c\d+$/.test(node.id) &&
      Math.abs(node.x - entryNode.x) < 1e-6
    );
    const columnMatch = topAColumnNode ? /^column-top-a-c(\d+)$/.exec(topAColumnNode.id) : null;
    if (!topAColumnNode || !columnMatch) {
      return null;
    }
    const columnIndex = Number(columnMatch[1]!) - 1;
    if (!Number.isInteger(columnIndex) || columnIndex < 0) {
      return null;
    }

    const route = [
      entryNodeId,
      topAColumnNode.id,
      columnAccessNodeId('top-b', columnIndex)
    ];
    return route.every((nodeId) => this.layoutNode(nodeId)) &&
      route.slice(1).every((nodeId, index) => this.traffic.findEdge(route[index]!, nodeId))
      ? route
      : null;
  }

  private topLiftInboundQueueEntryDownRoute(entryNodeId: string): string[] | null {
    const entryNode = this.layoutNode(entryNodeId);
    if (!entryNode) {
      return null;
    }
    const topAColumnNode = this.scenario.layout.nodes.find((node) =>
      /^column-top-a-c\d+$/.test(node.id) &&
      Math.abs(node.x - entryNode.x) < 1e-6
    );
    const columnMatch = topAColumnNode ? /^column-top-a-c(\d+)$/.exec(topAColumnNode.id) : null;
    if (!topAColumnNode || !columnMatch) {
      return null;
    }
    const columnIndex = Number(columnMatch[1]!) - 1;
    if (!Number.isInteger(columnIndex) || columnIndex < 0) {
      return null;
    }
    const storageNodeIds = Array.from({ length: this.topLiftColumnRowsPerZone() }, (_, rowIndex) =>
      storageNodeId(rowIndex, columnIndex)
    );
    const storedLoadNodeIds = this.storageNodeLoadOccupancy(false);
    if (storageNodeIds.some((nodeId) => storedLoadNodeIds.has(nodeId))) {
      return null;
    }
    const route = [
      entryNodeId,
      topAColumnNode.id,
      columnAccessNodeId('top-b', columnIndex),
      ...storageNodeIds,
      columnAccessNodeId('middle', columnIndex)
    ];
    return route.every((nodeId) => this.layoutNode(nodeId)) ? route : null;
  }

  private appendAgentRefreshLoadedInboundSegment(
    route: string[],
    target: string,
    task: TaskStateRecord
  ): void {
    const fromNodeId = route[route.length - 1]!;
    const blockedStorageNodeIds = this.agentRefreshLoadedInboundBlockedNodeIds(fromNodeId, target, task);
    blockedStorageNodeIds.delete(fromNodeId);
    blockedStorageNodeIds.delete(target);
    blockedStorageNodeIds.delete(task.pickupNodeId);
    blockedStorageNodeIds.delete(task.dropoffNodeId);
    const segment = this.agentRefreshShortestPath(fromNodeId, target, blockedStorageNodeIds);
    route.push(...segment.slice(1));
  }

  private agentRefreshLoadedInboundBlockedNodeIds(
    fromNodeId: string,
    target: string,
    task: TaskStateRecord
  ): Set<string> {
    const blockedNodeIds = this.blockedStorageTransitNodeIds(fromNodeId, target, { blockStoredLoads: true });
    if (!this.topLiftColumnLayoutEnabled()) {
      return blockedNodeIds;
    }

    const inboundSourceBuffer = liftBufferParentNodeId(fromNodeId);
    if (inboundSourceBuffer?.kind === 'inbound') {
      for (const node of this.scenario.layout.nodes) {
        const sameLiftEntryAccess = new RegExp(`^${inboundSourceBuffer.liftNodeId}-queue-\\d{2}-entry-access$`).test(node.id);
        if (sameLiftEntryAccess) {
          continue;
        }
        if (
          isTopLiftQueueParkingNodeId(node.id) ||
          /^(lift-\d{2}-(?:inbound|outbound))-queue(?:-\d{2})?-(?:entry-)?access$/.test(node.id) ||
          /^lift-\d{2}-(?:inbound|outbound)-queue-pickup-access$/.test(node.id)
        ) {
          blockedNodeIds.add(node.id);
        }
      }
    }

    const allowedColumnKeys = new Set<string>();
    for (const nodeId of [fromNodeId, target, task.dropoffNodeId]) {
      const columnKey = this.topLiftColumnKey(nodeId);
      if (columnKey) {
        allowedColumnKeys.add(columnKey);
      }
    }
    const occupiedStorageNodeIds = this.storageNodeLoadOccupancy(false);

    for (const node of this.scenario.layout.nodes) {
      if (node.type !== 'storage') {
        continue;
      }
      const columnKey = this.topLiftColumnKey(node.id);
      if (!columnKey || !allowedColumnKeys.has(columnKey)) {
        blockedNodeIds.add(node.id);
        continue;
      }
      if (
        !occupiedStorageNodeIds.has(node.id) &&
        (!this.currentNodeOccupancy.has(node.id) || node.id === fromNodeId || node.id === target || node.id === task.dropoffNodeId)
      ) {
        blockedNodeIds.delete(node.id);
      }
    }
    return blockedNodeIds;
  }

  private agentRefreshLoadedInboundSegmentAvailable(
    fromNodeId: string,
    target: string,
    task: TaskStateRecord
  ): boolean {
    const route = [fromNodeId];
    try {
      this.appendAgentRefreshLoadedInboundSegment(route, target, task);
      return true;
    } catch {
      return false;
    }
  }

  private agentRefreshLoadedInboundEntryFallbackRoute(
    fromNodeId: string,
    task: TaskStateRecord
  ): string[] | null {
    const entryNodeIds = this.agentRefreshLoadedInboundEntryCandidateNodeIds(task);
    const fromLiftId = this.liftStorageTransferTargetLiftId(fromNodeId);
    const candidateRoutes: string[][] = [];
    for (const entryNodeId of entryNodeIds) {
      const route = [fromNodeId];
      const targets = [
        fromLiftId,
        entryNodeId,
        task.dropoffNodeId
      ];
      try {
        for (const target of targets) {
          if (!target || target === route[route.length - 1]) {
            continue;
          }
          this.appendAgentRefreshLoadedInboundSegment(route, target, task);
        }
        candidateRoutes.push(route);
      } catch {
        continue;
      }
    }
    return this.shortestRouteByDistance(candidateRoutes);
  }

  private agentRefreshLoadedInboundBestEntryRoute(routePrefix: string[], task: TaskStateRecord): string[] | null {
    const candidateRoutes: string[][] = [];
    for (const entryNodeId of this.agentRefreshLoadedInboundEntryCandidateNodeIds(task)) {
      const route = [...routePrefix];
      try {
        if (entryNodeId !== route[route.length - 1]) {
          this.appendAgentRefreshLoadedInboundSegment(route, entryNodeId, task);
        }
        if (task.dropoffNodeId !== route[route.length - 1]) {
          this.appendAgentRefreshLoadedInboundSegment(route, task.dropoffNodeId, task);
        }
        candidateRoutes.push(route);
      } catch {
        continue;
      }
    }
    return this.shortestRouteByDistance(candidateRoutes);
  }

  private shortestRouteByDistance(routes: string[][]): string[] | null {
    return routes
      .filter((route) => route.length > 1)
      .sort((left, right) =>
        this.routeDistanceM(left) - this.routeDistanceM(right) ||
        left.length - right.length ||
        left.join('>').localeCompare(right.join('>'))
      )[0] ?? null;
  }

  private agentRefreshLoadedInboundEntryCandidateNodeIds(task: TaskStateRecord): string[] {
    return [
      this.topLiftNearestStorageColumnAccessNodeId(task.dropoffNodeId),
      this.storageSideNodeId(task.dropoffNodeId, 'right'),
      this.storageSideNodeId(task.dropoffNodeId, 'left')
    ].filter((nodeId, index, nodeIds): nodeId is string => Boolean(nodeId) && nodeIds.indexOf(nodeId) === index);
  }

  private agentRefreshLiftRowTransferNodeId(currentNodeId: string, storageNodeId: string): string | null {
    const liftId = this.layoutNode(currentNodeId)?.type === 'lift-blackbox'
      ? currentNodeId
      : this.liftStorageTransferTargetLiftId(currentNodeId);
    const storagePosition = this.storageGridPosition(storageNodeId);
    if (!liftId || !storagePosition) {
      return null;
    }
    const transferNodeId = `${liftId}-row-${String(storagePosition.row).padStart(2, '0')}-transfer`;
    return this.layoutNode(transferNodeId) ? transferNodeId : null;
  }

  private agentRefreshExpandLiftColumnSegments(route: string[]): string[] {
    if (route.length < 2) {
      return route;
    }

    const expanded = [route[0]!];
    for (let index = 1; index < route.length; index += 1) {
      const fromNodeId = expanded[expanded.length - 1]!;
      const toNodeId = route[index]!;
      const segment = this.agentRefreshLiftColumnSegment(fromNodeId, toNodeId);
      expanded.push(...(segment ? segment.slice(1) : [toNodeId]));
    }
    return expanded;
  }

  private agentRefreshLiftColumnSegment(fromNodeId: string, toNodeId: string): string[] | null {
    if (
      topLiftQueueParkingSlot(fromNodeId) ||
      topLiftQueueParkingSlot(toNodeId) ||
      /^lift-\d{2}-(?:inbound|outbound)-queue-access$/.test(fromNodeId) ||
      /^lift-\d{2}-(?:inbound|outbound)-queue-access$/.test(toNodeId)
    ) {
      return null;
    }
    const fromInfo = this.liftColumnNodeInfo(fromNodeId);
    const toInfo = this.liftColumnNodeInfo(toNodeId);
    const liftId = fromInfo?.liftId ?? toInfo?.liftId ?? null;
    if (!liftId || fromInfo?.liftId !== liftId || toInfo?.liftId !== liftId) {
      return null;
    }
    if (!this.traffic.findEdge(fromNodeId, toNodeId)) {
      return null;
    }

    const from = nodePosition(this.scenario, fromNodeId);
    const to = nodePosition(this.scenario, toNodeId);
    if (Math.abs(from.x - to.x) > 1e-6 || Math.abs(from.z - to.z) <= 1e-6) {
      return null;
    }

    const minZ = Math.min(from.z, to.z);
    const maxZ = Math.max(from.z, to.z);
    const nodes = this.scenario.layout.nodes
      .filter((node) =>
        this.liftColumnNodeInfo(node.id)?.liftId === liftId &&
        Math.abs(node.x - from.x) <= 1e-6 &&
        node.z >= minZ - 1e-6 &&
        node.z <= maxZ + 1e-6
      )
      .sort((left, right) => from.z <= to.z
        ? left.z - right.z || left.id.localeCompare(right.id)
        : right.z - left.z || left.id.localeCompare(right.id)
      )
      .map((node) => node.id);

    if (nodes[0] !== fromNodeId || nodes.at(-1) !== toNodeId || nodes.length < 2) {
      return null;
    }
    return nodes;
  }

  private liftColumnNodeInfo(nodeId: string): { liftId: string } | null {
    const node = this.layoutNode(nodeId);
    if (node?.type === 'lift-blackbox') {
      return { liftId: nodeId };
    }
    const liftId = this.liftStorageTransferTargetLiftId(nodeId);
    return liftId ? { liftId } : null;
  }

  private agentRefreshBlockedNodeIds(vehicle: MutableVehicle, task: TaskStateRecord | null, goalNodeId: string): Set<string> {
    if (!vehicle.loaded) {
      return this.activeTopLiftInboundTransitBlockedNodeIds(vehicle, task, goalNodeId);
    }

    if (task?.kind === 'outbound' && goalNodeId === task.dropoffNodeId) {
      return this.blockedStorageTransitNodeIds(vehicle.currentNodeId, goalNodeId, { blockStoredLoads: false });
    }

    const blocked = this.blockedStorageTransitNodeIds(vehicle.currentNodeId, goalNodeId, { blockStoredLoads: true });
    blocked.delete(vehicle.currentNodeId);
    blocked.delete(goalNodeId);
    if (task) {
      blocked.delete(task.pickupNodeId);
      blocked.delete(task.dropoffNodeId);
    }
    return blocked;
  }

  private agentRefreshShortestPath(fromNodeId: string, toNodeId: string, blockedNodeIds = new Set<string>()): string[] {
    if (fromNodeId === toNodeId) {
      return [fromNodeId];
    }

    const open = new MinPriorityQueue();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[fromNodeId, 0]]);
    open.push({ nodeId: fromNodeId, priority: 0 });

    while (open.size > 0) {
      const next = open.pop();
      if (!next) {
        break;
      }
      const current = next.nodeId;
      if (next.priority > (gScore.get(current) ?? Infinity) + 1e-9) {
        continue;
      }
      if (current === toNodeId) {
        const path = [current];
        while (cameFrom.has(path[0]!)) {
          path.unshift(cameFrom.get(path[0]!)!);
        }
        return path;
      }

      for (const neighbor of this.neighbors(current)) {
        if (blockedNodeIds.has(neighbor.nodeId)) {
          continue;
        }
        if (!this.agentEdgeDirectionAllowed(current, neighbor.nodeId, toNodeId)) {
          continue;
        }
        if (neighbor.nodeId !== toNodeId && this.layoutNode(neighbor.nodeId)?.type === 'lift-blackbox') {
          continue;
        }
        const tentative = (gScore.get(current) ?? Infinity) + this.agentEdgeCostM(current, neighbor.nodeId, neighbor.lengthM, toNodeId);
        if (tentative < (gScore.get(neighbor.nodeId) ?? Infinity)) {
          cameFrom.set(neighbor.nodeId, current);
          gScore.set(neighbor.nodeId, tentative);
          open.push({ nodeId: neighbor.nodeId, priority: tentative });
        }
      }
    }

    throw new Error(`No route between ${fromNodeId} and ${toNodeId}`);
  }

  private agentNominalRouteToGoal(vehicle: MutableVehicle, task: TaskStateRecord | null, goalNodeId: string): string[] {
    if (task?.kind === 'inbound' && vehicle.loaded && goalNodeId === task.dropoffNodeId) {
      return this.agentLoadedInboundRouteToDropoff(vehicle.currentNodeId, task);
    }
    return this.agentShortestPath(
      vehicle.currentNodeId,
      goalNodeId,
      this.agentStaticBlockedNodeIds(vehicle, goalNodeId)
    );
  }

  private agentLoadedInboundRouteToDropoff(currentNodeId: string, task: TaskStateRecord): string[] {
    const route: string[] = [currentNodeId];
    const rightSideNodeId = this.storageSideNodeId(task.dropoffNodeId, 'right');
    const dropoffRow = this.nodeStorageRowLabel(task.dropoffNodeId);
    const currentRow = this.nodeStorageRowLabel(currentNodeId);
    const alreadyInRightEntryLane =
      currentNodeId === rightSideNodeId ||
      (this.isStorageNode(currentNodeId) && currentRow !== null && currentRow === dropoffRow);
    const targets: Array<string | null> = alreadyInRightEntryLane
      ? [task.dropoffNodeId]
      : [rightSideNodeId, task.dropoffNodeId];

    for (const target of targets) {
      if (!target || target === route[route.length - 1]) {
        continue;
      }
      const fromNodeId = route[route.length - 1]!;
      const blockedStorageNodeIds = this.blockedStorageTransitNodeIds(fromNodeId, target, { blockStoredLoads: true });
      const segment = this.agentShortestPath(fromNodeId, target, blockedStorageNodeIds);
      route.push(...segment.slice(1));
    }
    return route;
  }

  private agentCommittedRoute(vehicle: MutableVehicle, goalNodeId: string): string[] | null {
    const currentIndex = vehicle.routeNodeIds.indexOf(vehicle.currentNodeId, Math.max(0, vehicle.routeIndex));
    if (currentIndex < 0) {
      return null;
    }
    const route = vehicle.routeNodeIds.slice(currentIndex);
    if (route.length < 2 || route[0] !== vehicle.currentNodeId || route.at(-1) !== goalNodeId) {
      return null;
    }
    const nextNodeId = route[1]!;
    if (!this.traffic.findEdge(vehicle.currentNodeId, nextNodeId)) {
      return null;
    }
    if (vehicle.loaded) {
      const blockedNodeIds = this.agentStaticBlockedNodeIds(vehicle, goalNodeId);
      if (route.slice(1).some((nodeId) => blockedNodeIds.has(nodeId))) {
        return null;
      }
    }
    return route;
  }

  private agentCommittedYieldRoute(vehicle: MutableVehicle, goalNodeId: string): string[] | null {
    if (vehicle.loaded) {
      return null;
    }
    const currentIndex = vehicle.routeNodeIds.indexOf(vehicle.currentNodeId, Math.max(0, vehicle.routeIndex));
    if (currentIndex < 0) {
      return null;
    }
    const route = vehicle.routeNodeIds.slice(currentIndex);
    if (route.length < 2 || route[0] !== vehicle.currentNodeId || route.at(-1) === goalNodeId) {
      return null;
    }
    if (this.agentMinimalEnabled() && route.length === 2) {
      const nextNodeId = route[1]!;
      return this.traffic.findEdge(vehicle.currentNodeId, nextNodeId) ? route : null;
    }
    const routeGoal = route.at(-1)!;
    if (!this.isStorageNode(routeGoal) && !routeGoal.startsWith('left-row-') && !routeGoal.startsWith('right-row-')) {
      return null;
    }
    const nextNodeId = route[1]!;
    if (!this.traffic.findEdge(vehicle.currentNodeId, nextNodeId)) {
      return null;
    }
    return route;
  }

  private agentStaticBlockedNodeIds(
    vehicle: MutableVehicle,
    goalNodeId: string,
    options: { openStorageRows?: boolean } = {}
  ): Set<string> {
    if (options.openStorageRows === true && !vehicle.loaded) {
      return new Set();
    }
    return this.blockedStorageTransitNodeIds(vehicle.currentNodeId, goalNodeId, { blockStoredLoads: vehicle.loaded });
  }

  private agentStorageBypassRoute(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    goalNodeId: string,
    blockedNodeId: string,
    directRoute: string[]
  ): string[] | null {
    const entryNodeId = this.agentStorageEntryNodeId(vehicle.currentNodeId);
    if (!entryNodeId) {
      return null;
    }

    try {
      const blockedNodeIds = this.agentStaticBlockedNodeIds(vehicle, goalNodeId, { openStorageRows: true });
      for (const nodeId of this.agentDynamicBlockedNodeIds(vehicle)) {
        blockedNodeIds.add(nodeId);
      }
      blockedNodeIds.delete(vehicle.currentNodeId);
      blockedNodeIds.delete(entryNodeId);

      const entrySegment = this.agentShortestPath(vehicle.currentNodeId, entryNodeId, blockedNodeIds);
      if (entrySegment[1] !== entryNodeId || this.agentMoveBlocker(vehicle, entryNodeId)) {
        return null;
      }
      const exitSegment = this.agentShortestPath(entryNodeId, goalNodeId, blockedNodeIds);
      const route = [...entrySegment, ...exitSegment.slice(1)];
      if (!this.agentLocalRerouteAcceptable(directRoute, route)) {
        return null;
      }
      this.logAgentReroute(vehicle, task, blockedNodeId, route, 'empty-storage-row-bypass');
      return route;
    } catch {
      return null;
    }
  }

  private agentLocalRerouteAcceptable(directRoute: string[], candidateRoute: string[]): boolean {
    const allowedRows = new Set(
      [directRoute[0], directRoute.at(-1)]
        .map((nodeId) => nodeId ? this.nodeStorageRowLabel(nodeId) : null)
        .filter((row): row is string => row !== null)
    );
    const storageRows = new Set(
      candidateRoute
        .filter((nodeId) => this.isStorageNode(nodeId))
        .map((nodeId) => this.nodeStorageRowLabel(nodeId))
        .filter((row): row is string => row !== null)
    );
    for (const row of storageRows) {
      if (!allowedRows.has(row)) {
        return false;
      }
    }
    if (this.routeUsesOuterTransfer(candidateRoute)) {
      return false;
    }
    if (this.topLiftColumnLayoutEnabled() || storageRows.size === 0) {
      const directDistanceM = this.routeDistanceM(directRoute);
      const candidateDistanceM = this.routeDistanceM(candidateRoute);
      const extraDistanceM = candidateDistanceM - directDistanceM;
      if (extraDistanceM > 12 && candidateDistanceM > directDistanceM * 1.5) {
        return false;
      }
    }
    return true;
  }

  private routeUsesOuterTransfer(route: string[]): boolean {
    for (let index = 1; index < route.length; index += 1) {
      const edgeKey = [route[index - 1]!, route[index]!].sort().join('>');
      if (edgeKey === 'left-top>right-top' || edgeKey === 'left-bottom>right-bottom') {
        return true;
      }
    }
    return false;
  }

  private agentStorageHeadOnYieldRoute(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    goalNodeId: string,
    blockedNodeId: string | null,
    blockingVehicleId: string
  ): string[] | null {
    if (vehicle.loaded || !blockedNodeId) {
      return null;
    }
    const blocker = this.vehicles.find((candidate) => candidate.id === blockingVehicleId) ?? null;
    if (!blocker || blocker.currentEdgeId || blocker.legRemainingM > 0) {
      return null;
    }
    const currentPosition = this.storageGridPosition(vehicle.currentNodeId);
    const blockedPosition = this.storageGridPosition(blockedNodeId);
    if (
      !currentPosition ||
      !blockedPosition ||
      currentPosition.row !== blockedPosition.row ||
      Math.abs(currentPosition.column - blockedPosition.column) !== 1 ||
      blocker.currentNodeId !== blockedNodeId ||
      blocker.targetNodeId !== vehicle.currentNodeId
    ) {
      return null;
    }

    const vehiclePriority = this.agentTurnPriority(vehicle);
    const blockerPriority = this.agentTurnPriority(blocker);
    if (vehiclePriority > blockerPriority || (vehiclePriority === blockerPriority && vehicle.id.localeCompare(blocker.id) < 0)) {
      return null;
    }

    const yieldSide: 'left' | 'right' = blockedPosition.column > currentPosition.column ? 'left' : 'right';
    const sideNodeId = this.storageSideNodeId(vehicle.currentNodeId, yieldSide);
    if (!sideNodeId) {
      return null;
    }

    try {
      const blockedNodeIds = this.agentStaticBlockedNodeIds(vehicle, goalNodeId);
      for (const nodeId of this.agentDynamicBlockedNodeIds(vehicle)) {
        blockedNodeIds.add(nodeId);
      }
      blockedNodeIds.delete(vehicle.currentNodeId);
      const exitSegment = this.agentShortestPath(vehicle.currentNodeId, sideNodeId, blockedNodeIds);
      const nextNodeId = exitSegment[1] ?? null;
      if (!nextNodeId || nextNodeId === blockedNodeId || this.agentMoveBlocker(vehicle, nextNodeId)) {
        return null;
      }
      const continuationSegment = this.agentShortestPath(sideNodeId, goalNodeId, blockedNodeIds);
      const route = [...exitSegment, ...continuationSegment.slice(1)];
      this.logAgentReroute(vehicle, task, blockedNodeId, route, 'empty-storage-head-on-yield');
      return route;
    } catch {
      return null;
    }
  }

  private agentStorageEntryNodeId(nodeId: string): string | null {
    const sideMatch = /^(left|right)-row-(\d+)$/.exec(nodeId);
    if (!sideMatch) {
      return null;
    }
    const rowNumber = sideMatch[2]!;
    if (sideMatch[1] === 'left') {
      const entryNodeId = `storage-r${rowNumber}-c01`;
      return this.layoutNode(entryNodeId) ? entryNodeId : null;
    }
    const rowColumns = this.scenario.layout.nodes
      .map((node) => this.storageGridPosition(node.id))
      .filter((position): position is { row: number; column: number } => position !== null && String(position.row).padStart(2, '0') === rowNumber)
      .map((position) => position.column);
    const maxColumn = Math.max(0, ...rowColumns);
    if (maxColumn <= 0) {
      return null;
    }
    const entryNodeId = `storage-r${rowNumber}-c${String(maxColumn).padStart(2, '0')}`;
    return this.layoutNode(entryNodeId) ? entryNodeId : null;
  }

  private agentDynamicBlockedNodeIds(vehicle: MutableVehicle): Set<string> {
    const blocked = new Set<string>();
    for (const other of this.vehicles) {
      if (other.id === vehicle.id) {
        continue;
      }
      blocked.add(other.currentNodeId);
      if (other.targetNodeId && other.currentNodeId !== other.targetNodeId) {
        blocked.add(other.targetNodeId);
      }
    }
    blocked.delete(vehicle.currentNodeId);
    return blocked;
  }

  private agentEmptyStorageExitLookaheadBlocker(
    vehicle: MutableVehicle,
    route: string[]
  ): { nodeId: string; blockingVehicleId: string } | null {
    if (vehicle.loaded || route.length < 3) {
      return null;
    }
    const nextNodeId = route[1]!;
    const afterNextNodeId = route[2]!;
    if (!this.isStorageNode(vehicle.currentNodeId) && !this.isStorageNode(nextNodeId)) {
      return null;
    }
    const afterNextIsSideExit = /^left-row-|^right-row-/.test(afterNextNodeId);
    if (!afterNextIsSideExit) {
      return null;
    }
    const blockerId = this.agentNodeBlocker(vehicle, afterNextNodeId);
    return blockerId ? { nodeId: afterNextNodeId, blockingVehicleId: blockerId } : null;
  }

  private agentMoveBlocker(
    vehicle: MutableVehicle,
    toNodeId: string
  ): { reason: string; blockingVehicleId: string | null } | null {
    const fromNodeId = vehicle.currentNodeId;
    const currentOccupant = this.currentNodeOccupancy.get(fromNodeId);
    if (currentOccupant && currentOccupant !== vehicle.id) {
      return { reason: 'node-occupancy-mismatch', blockingVehicleId: currentOccupant };
    }

    const nodeClaim = this.agentNodeBlocker(vehicle, toNodeId);
    if (nodeClaim) {
      return { reason: this.liftPortWaitReason(toNodeId) ?? 'node-occupied', blockingVehicleId: nodeClaim };
    }

    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    if (edge) {
      const headOn = this.vehicles.find((other) =>
        other.id !== vehicle.id &&
        other.currentEdgeId === edge.id &&
        other.currentNodeId === toNodeId &&
        other.targetNodeId === fromNodeId
      );
      if (headOn) {
        return { reason: 'edge-head-on', blockingVehicleId: headOn.id };
      }
    }

    const leadingVehicleId = this.leadingVehicleTooClose(vehicle, fromNodeId, toNodeId);
    if (leadingVehicleId) {
      return { reason: 'min-separation', blockingVehicleId: leadingVehicleId };
    }

    const target = nodePosition(this.scenario, toNodeId);
    const footprintBlockerId = this.predictedFootprintOverlapVehicleId(vehicle, target.x, target.z);
    if (footprintBlockerId && !this.topLiftQueueClearanceOverlapAllowed(vehicle, toNodeId, footprintBlockerId)) {
      return { reason: 'min-separation', blockingVehicleId: footprintBlockerId };
    }

    return null;
  }

  private agentMinimalMoveBlocker(
    vehicle: MutableVehicle,
    toNodeId: string
  ): { reason: string; blockingVehicleId: string | null } | null {
    const fromNodeId = vehicle.currentNodeId;
    const currentOccupant = this.currentNodeOccupancy.get(fromNodeId);
    if (currentOccupant && currentOccupant !== vehicle.id) {
      return { reason: 'node-occupancy-mismatch', blockingVehicleId: currentOccupant };
    }

    const occupiedTargetId = this.currentNodeOccupancy.get(toNodeId);
    if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
      return { reason: this.liftPortWaitReason(toNodeId) ?? 'node-occupied', blockingVehicleId: occupiedTargetId };
    }

    const localRouteClaimBlockerId = this.localRouteNodeClaimBlocker(toNodeId, vehicle.id);
    if (localRouteClaimBlockerId) {
      return { reason: 'node-local-yield', blockingVehicleId: localRouteClaimBlockerId };
    }

    const targetClaimBlockerId = this.minimalTargetClaimBlocker(vehicle, toNodeId);
    if (targetClaimBlockerId) {
      return { reason: 'node-target-near', blockingVehicleId: targetClaimBlockerId };
    }

    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    if (edge) {
      const headOn = this.vehicles.find((other) =>
        other.id !== vehicle.id &&
        other.currentEdgeId === edge.id &&
        other.currentNodeId === toNodeId &&
        other.targetNodeId === fromNodeId
      );
      if (headOn) {
        return { reason: 'edge-head-on', blockingVehicleId: headOn.id };
      }
    }

    const leadingVehicleId = this.leadingVehicleTooClose(vehicle, fromNodeId, toNodeId);
    if (leadingVehicleId) {
      return { reason: 'min-separation', blockingVehicleId: leadingVehicleId };
    }

    const target = nodePosition(this.scenario, toNodeId);
    const footprintBlockerId = this.predictedFootprintOverlapVehicleId(vehicle, target.x, target.z);
    if (footprintBlockerId && !this.topLiftQueueClearanceOverlapAllowed(vehicle, toNodeId, footprintBlockerId)) {
      return { reason: 'avoidance-clearance', blockingVehicleId: footprintBlockerId };
    }

    return null;
  }

  private topLiftQueueClearanceOverlapAllowed(
    vehicle: MutableVehicle,
    toNodeId: string,
    blockerVehicleId: string
  ): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const targetBuffer = liftBufferParentNodeId(toNodeId);
    const targetBufferAccessLiftNodeId = /^(lift-\d{2}-(?:inbound|outbound))-buffer-access$/.exec(toNodeId)?.[1] ?? null;
    const targetLiftNodeId = targetBuffer?.liftNodeId ?? targetBufferAccessLiftNodeId;
    if (!targetLiftNodeId) {
      return false;
    }
    const blocker = this.vehicles.find((vehicle) => vehicle.id === blockerVehicleId);
    const blockerQueueSlot = blocker ? topLiftQueueParkingSlot(blocker.currentNodeId) : null;
    if (blockerQueueSlot?.liftNodeId === targetLiftNodeId) {
      return true;
    }

    const task = this.taskForVehicle(vehicle);
    const blockerTask = blocker ? this.taskForVehicle(blocker) : null;
    return Boolean(
      blocker &&
      vehicle.loaded &&
      blocker.loaded &&
      task?.kind === 'outbound' &&
      blockerTask?.kind === 'outbound' &&
      this.taskLiftPortNodeId(task) === targetLiftNodeId &&
      this.taskLiftPortNodeId(blockerTask) === targetLiftNodeId &&
      this.taskPrecedes(task, blockerTask)
    );
  }

  private topLiftQueueFifoBlocker(vehicle: MutableVehicle, toNodeId: string): string | null {
    if (!this.topLiftColumnLayoutEnabled()) {
      return null;
    }
    const targetSlot = topLiftQueueParkingSlot(toNodeId);
    if (!targetSlot) {
      return null;
    }
    const plannedSlot = topLiftQueueParkingSlot(vehicle.plannedGoalNodeId ?? vehicle.routeNodeIds.at(-1) ?? '');
    if (
      plannedSlot?.liftNodeId === targetSlot.liftNodeId &&
      plannedSlot.slotIndex > targetSlot.slotIndex
    ) {
      return null;
    }
    const task = this.taskForVehicle(vehicle);
    if (!task || this.taskLiftPortNodeId(task) !== targetSlot.liftNodeId) {
      return null;
    }
    if (task.kind === 'outbound' && !vehicle.loaded) {
      return null;
    }
    if (task.kind === 'inbound' && vehicle.loaded) {
      return null;
    }

    for (const candidate of this.activeTasks()) {
      if (
        candidate.id === task.id ||
        candidate.kind !== task.kind ||
        this.taskLiftPortNodeId(candidate) !== targetSlot.liftNodeId ||
        !this.taskPrecedes(candidate, task)
      ) {
        continue;
      }
      if (task.kind === 'inbound' && this.inboundTaskPickupReleased(candidate)) {
        continue;
      }
      if (task.kind === 'outbound' && this.outboundTaskDropoffReleased(candidate)) {
        continue;
      }
      const candidateVehicle = candidate.vehicleId
        ? this.vehicles.find((entry) => entry.id === candidate.vehicleId) ?? null
        : null;
      if (!candidateVehicle) {
        return candidate.vehicleId;
      }
      for (const nodeId of [candidateVehicle.currentNodeId, candidateVehicle.targetNodeId, candidateVehicle.plannedGoalNodeId]) {
        const candidateSlot = nodeId ? topLiftQueueParkingSlot(nodeId) : null;
        if (
          candidateSlot?.liftNodeId === targetSlot.liftNodeId &&
          candidateSlot.slotIndex > targetSlot.slotIndex
        ) {
          return candidateVehicle.id;
        }
      }
    }
    return null;
  }

  private loadedStorageLoadBlock(
    vehicle: MutableVehicle,
    toNodeId: string
  ): { reason: string; blockingVehicleId: string | null } | null {
    if (!vehicle.loaded || !this.isStorageNode(toNodeId)) {
      return null;
    }
    return this.storedLoadIdAtNode(toNodeId) ? { reason: 'stored-load-occupied', blockingVehicleId: null } : null;
  }

  private agentMinimalStorageExitLookaheadBlocker(
    vehicle: MutableVehicle,
    route: string[]
  ): { reason: string; blockingVehicleId: string | null } | null {
    if (!this.agentMinimalEnabled() || !this.collisionAvoidanceEnabled() || vehicle.loaded || route.length < 3) {
      return null;
    }
    const fromNodeId = route[0]!;
    const sideExitNodeId = route[1]!;
    const afterExitNodeId = route[2]!;
    if (!this.isStorageNode(fromNodeId) || !/^(left|right)-row-\d+$/.test(sideExitNodeId)) {
      return null;
    }
    const block = this.agentMinimalMoveBlocker(vehicle, afterExitNodeId);
    return block
      ? { reason: `storage-exit-${block.reason}`, blockingVehicleId: block.blockingVehicleId }
      : null;
  }

  private agentRefreshNearColumnSweptFootprintBlocker(
    vehicle: MutableVehicle,
    fromNodeId: string,
    toNodeId: string
  ): string | null {
    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    if (!edge || this.axisForEdge(edge) !== 'z') {
      return null;
    }
    const from = nodePosition(this.scenario, fromNodeId);
    const to = nodePosition(this.scenario, toNodeId);
    const distanceM = Math.hypot(to.x - from.x, to.z - from.z);
    if (distanceM <= 1e-9) {
      return null;
    }
    const horizonM = Math.min(distanceM, this.agentRefreshNearAvoidanceHorizonM());
    const ratio = horizonM / distanceM;
    const horizonX = from.x + (to.x - from.x) * ratio;
    const horizonZ = from.z + (to.z - from.z) * ratio;
    return this.predictedSweptFootprintOverlapVehicleId(vehicle, from.x, from.z, horizonX, horizonZ);
  }

  private agentRefreshNearAvoidanceHorizonM(): number {
    return Math.max(
      this.scenario.trafficPolicy.dynamicAvoidanceClearanceM,
      this.scenario.vehicles.lengthM + this.scenario.vehicles.safetyRadiusM
    );
  }

  private agentRefreshYieldHoldBlocker(
    vehicle: MutableVehicle,
    _task: TaskStateRecord | null
  ): { reason: string; blockingVehicleId: string | null } | null {
    if (!this.agentRefreshEnabled()) {
      return null;
    }
    const conflictSession = this.activeConflictSessionForVehicle(vehicle.id);
    if (
      conflictSession &&
      conflictSession.clearancePolicy === 'short-horizon' &&
      (conflictSession.state === 'yielding' || conflictSession.state === 'holding-pocket') &&
      conflictSession.yielderVehicleId === vehicle.id
    ) {
      const blockerId = this.topLiftMiddleAisleStorageYieldHoldBlocker(vehicle, conflictSession);
      if (blockerId) {
        return { reason: 'local-yield-hold', blockingVehicleId: blockerId };
      }
    }
    if (
      conflictSession &&
      conflictSession.state === 'yielding' &&
      conflictSession.yielderVehicleId === vehicle.id &&
      conflictSession.resumeNodeId
    ) {
      const winner = this.vehicles.find((candidate) => candidate.id === conflictSession.winnerVehicleId) ?? null;
      if (winner) {
        const winnerCurrentIndex = winner.routeNodeIds.indexOf(
          winner.currentNodeId,
          Math.max(0, winner.routeIndex)
        );
        const searchFromIndex = winnerCurrentIndex >= 0 ? winnerCurrentIndex : Math.max(0, winner.routeIndex);
        const resumeIndex = winner.routeNodeIds.indexOf(conflictSession.resumeNodeId, searchFromIndex);
        if (winner.targetNodeId === conflictSession.resumeNodeId || resumeIndex > searchFromIndex) {
          return { reason: 'local-yield-hold', blockingVehicleId: winner.id };
        }
      }
    }
    if (vehicle.yieldHoldUntilSec !== null && this.simTimeSec < vehicle.yieldHoldUntilSec) {
      return {
        reason: 'local-yield-hold',
        blockingVehicleId: conflictSession?.winnerVehicleId === vehicle.id ? null : conflictSession?.winnerVehicleId ?? null
      };
    }
    return null;
  }

  private topLiftMiddleAisleStorageYieldHoldBlocker(
    vehicle: MutableVehicle,
    session: ConflictSessionV1
  ): string | null {
    if (
      !this.topLiftColumnLayoutEnabled() ||
      !this.isStorageNode(vehicle.currentNodeId) ||
      !this.isStorageNode(session.yielderOriginalNodeId) ||
      !session.resumeNodeId ||
      !isTopLiftAisleLevelNodeId(session.resumeNodeId, 'middle')
    ) {
      return null;
    }
    const resumeNode = this.layoutNode(session.resumeNodeId);
    if (!resumeNode) {
      return null;
    }
    const entryClaim = { minX: resumeNode.x, maxX: resumeNode.x };
    return this.vehicles
      .filter((candidate) => candidate.id !== vehicle.id)
      .sort((left, right) =>
        Number(right.id === session.winnerVehicleId) - Number(left.id === session.winnerVehicleId) ||
        left.id.localeCompare(right.id)
      )
      .find((candidate) => {
        const activeClaim = this.topLiftMiddleAisleActiveClaim(candidate);
        return Boolean(activeClaim && this.topLiftMiddleAisleClaimsOverlap(entryClaim, activeClaim));
      })?.id ?? null;
  }

  private agentRefreshWinnerShouldStayCourse(
    session: ConflictSessionV1 | null,
    vehicle: MutableVehicle,
    blocker: MutableVehicle | null
  ): boolean {
    if (
      !session ||
      !blocker ||
      session.winnerVehicleId !== vehicle.id ||
      session.yielderVehicleId !== blocker.id ||
      !session.resumeNodeId ||
      !isTopLiftColumnAccessNodeId(session.resumeNodeId)
    ) {
      return false;
    }

    return [
      blocker.currentNodeId,
      blocker.targetNodeId,
      session.yielderPocketNodeId,
      ...session.yielderLocalRouteNodeIds
    ].some((nodeId) => nodeId !== null && isTopLiftQueueParkingNodeId(nodeId));
  }

  private agentNodeBlocker(vehicle: MutableVehicle, nodeId: string): string | null {
    const occupantId = this.currentNodeOccupancy.get(nodeId);
    if (occupantId && occupantId !== vehicle.id) {
      return occupantId;
    }

    const claimant = this.vehicles.find((other) =>
      other.id !== vehicle.id &&
      other.targetNodeId === nodeId &&
      other.currentNodeId !== nodeId &&
      other.state !== 'idle' &&
      other.state !== 'parking' &&
      !this.vehicleCurrentlyWaitsFor(other, vehicle.id)
    );
    if (!claimant) {
      return null;
    }

    if (claimant.currentEdgeId !== null || claimant.legRemainingM > 0) {
      return claimant.id;
    }

    const claimantPriority = this.agentTurnPriority(claimant);
    const vehiclePriority = this.agentTurnPriority(vehicle);
    if (claimantPriority > vehiclePriority) {
      return claimant.id;
    }
    if (claimantPriority === vehiclePriority && claimant.id.localeCompare(vehicle.id) < 0) {
      return claimant.id;
    }
    return null;
  }

  private agentSetWaiting(
    vehicle: MutableVehicle,
    targetNodeId: string,
    block: { reason: string; blockingVehicleId: string | null },
    dtSec: number
  ): void {
    const conflictSession = this.agentRefreshEnabled() ? this.activeConflictSessionForVehicle(vehicle.id) : null;
    const shouldUseSessionBlocker = block.reason !== 'no-stop-continuation-blocked';
    const stableBlockingVehicleId =
      shouldUseSessionBlocker && conflictSession && conflictSession.yielderVehicleId === vehicle.id
        ? conflictSession.blockerVehicleId
        : block.blockingVehicleId;
    if (conflictSession && conflictSession.yielderVehicleId === vehicle.id) {
      conflictSession.updatedAtSec = this.simTimeSec;
    }
    const shouldLogWait = this.shouldLogVehicleWait(vehicle, targetNodeId, block.reason, null, stableBlockingVehicleId);
    this.reservationConflictCount += 1;
    vehicle.state = 'waiting-blocked';
    vehicle.speedMps = 0;
    vehicle.targetNodeId = targetNodeId;
    vehicle.waitReason = block.reason;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = stableBlockingVehicleId;
    vehicle.waitingSinceSec ??= this.simTimeSec;
    vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
    this.blockedTimeByReasonSec.set(block.reason, round((this.blockedTimeByReasonSec.get(block.reason) ?? 0) + dtSec));
    if (shouldLogWait) {
      this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, vehicle.currentNodeId, targetNodeId, block.reason, this.vehiclePosition(vehicle), {
        blockingVehicleId: stableBlockingVehicleId,
        conflictSessionId: conflictSession?.id ?? null
      });
    }
  }

  private beginAgentSimpleLeg(
    vehicle: MutableVehicle,
    edge: ShuttleScenario['layout']['edges'][number],
    toNodeId: string,
    task: TaskStateRecord | null,
    dtSec: number
  ): void {
    const speedMps = this.speedForEdge(vehicle, edge);
    const motionMode = this.routeLegMotionMode(vehicle, edge, toNodeId, vehicle.routeIndex, task);
    const travelSec = motionMode === 'cruise'
      ? edge.lengthM / Math.max(0.001, speedMps)
      : calculateTravelTimeSec(edge.lengthM, speedMps, this.scenario.physicsParams.accelerationMps2);

    this.releaseNodeOccupancy(vehicle, vehicle.currentNodeId);
    vehicle.directionSwitchReadyNodeId = null;
    vehicle.waitingSinceSec = null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    if (vehicle.yieldHoldNodeId === vehicle.currentNodeId) {
      vehicle.yieldHoldUntilSec = null;
      vehicle.yieldHoldNodeId = null;
    }
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.targetNodeId = toNodeId;
    vehicle.legRemainingM = edge.lengthM;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = travelSec;
    vehicle.currentEdgeId = edge.id;
    vehicle.targetSpeedMps = speedMps;
    vehicle.legMotionMode = motionMode;
    this.advanceMovement(vehicle, dtSec);
  }

  private agentTryDisplaceEmptyBlocker(blockingVehicleId: string, requester: MutableVehicle, blockedTargetNodeId: string): boolean {
    const blocker = this.vehicles.find((candidate) => candidate.id === blockingVehicleId) ?? null;
    if (
      !blocker ||
      blocker.loaded ||
      blocker.currentEdgeId ||
      blocker.legRemainingM > 0 ||
      blocker.phaseRemainingSec > 0
    ) {
      return false;
    }

    if (this.tryMoveTopLiftQueueBlockerDeeper(blocker, requester, blockedTargetNodeId)) {
      return true;
    }

    if (this.tryDisplaceAgentRefreshTopLiftSpineBlocker(blocker, requester, blockedTargetNodeId)) {
      return true;
    }

    const task = this.taskForVehicle(blocker);
    const goals = this.agentEmptyEscapeGoalCandidates(blocker, requester, blockedTargetNodeId)
      .filter((goal) => this.agentEmptyEscapeGoalAllowed(blocker, goal));
    const taskGoal = this.agentGoalNodeId(blocker, task);
    if (taskGoal && this.agentEmptyEscapeGoalAllowed(blocker, taskGoal)) {
      goals.push(taskGoal);
    }

    const seen = new Set<string>();
    for (const goal of goals) {
      if (!goal || goal === blocker.currentNodeId || seen.has(goal)) {
        continue;
      }
      seen.add(goal);
      try {
        const blockedNodeIds = this.agentStaticBlockedNodeIds(blocker, goal);
        for (const nodeId of this.agentDynamicBlockedNodeIds(blocker)) {
          blockedNodeIds.add(nodeId);
        }
        blockedNodeIds.add(requester.currentNodeId);
        if (requester.targetNodeId) {
          blockedNodeIds.add(requester.targetNodeId);
        }
        blockedNodeIds.delete(blocker.currentNodeId);
        const route = this.agentShortestPath(blocker.currentNodeId, goal, blockedNodeIds);
        const isTaskGoal = taskGoal !== null && goal === taskGoal;
        if (!isTaskGoal && this.agentEmptyEscapeRouteRepeatsLastStorageStep(blocker, route)) {
          continue;
        }
        if (!isTaskGoal && !this.agentYieldEscapeRouteAcceptable(route)) {
          continue;
        }
        if (isTaskGoal) {
          const directRoute = this.agentNominalRouteToGoal(blocker, task, goal);
          if (!this.agentLocalRerouteAcceptable(directRoute, route)) {
            continue;
          }
        }
        if (this.agentMinimalEnabled() && isTaskGoal && route.length > 8) {
          continue;
        }
        const nextNodeId = route[1] ?? null;
        const nextBlock = nextNodeId
          ? this.agentMinimalEnabled()
            ? this.agentMinimalMoveBlocker(blocker, nextNodeId)
            : this.agentMoveBlocker(blocker, nextNodeId)
          : { reason: 'route-unavailable', blockingVehicleId: null };
        const effectiveNextBlock = nextBlock && this.emptyStorageEscapeMovesAwayFromLoadedRequester(
          blocker,
          requester,
          blockedTargetNodeId,
          nextNodeId,
          nextBlock
        )
          ? null
          : nextBlock;
        if (!nextNodeId || effectiveNextBlock) {
          continue;
        }
        const alreadyFollowingRoute =
          blocker.routeNodeIds.length === route.length &&
          blocker.routeNodeIds.every((nodeId, index) => nodeId === route[index]) &&
          blocker.targetNodeId === nextNodeId;
        blocker.routeNodeIds = route;
        blocker.routeIndex = 0;
        blocker.targetNodeId = nextNodeId;
        blocker.state = blocker.taskId ? 'assigned' : 'returning';
        blocker.waitReason = null;
        blocker.blockingReservationId = null;
        blocker.blockingVehicleId = null;
        if (isTaskGoal) {
          blocker.yieldHoldUntilSec = null;
          blocker.yieldHoldNodeId = null;
          blocker.localRouteNodeIds = [];
          blocker.localRouteReason = null;
        } else {
          blocker.yieldHoldUntilSec = round(this.simTimeSec + this.routeTravelEstimateSec(blocker, route) + 8);
          blocker.yieldHoldNodeId = route.at(-1) ?? null;
          blocker.localRouteNodeIds = route;
          blocker.localRouteReason = 'temporary-yield';
        }
        if (!alreadyFollowingRoute) {
          this.logAgentReroute(
            blocker,
            task,
            blockedTargetNodeId,
            route,
            isTaskGoal ? 'empty-task-route-clears-loaded' : 'empty-yields-to-loaded',
            { countTaskReplan: false }
          );
        }
        const session = this.agentRefreshEnabled() ? this.activeConflictSessionForPair(requester.id, blocker.id) : null;
        if (session && session.yielderVehicleId === blocker.id) {
          session.state = 'yielding';
          session.updatedAtSec = this.simTimeSec;
          session.yielderOriginalNodeId = blocker.currentNodeId;
          session.yielderPocketNodeId = route.at(-1) ?? null;
          session.yielderLocalRouteNodeIds = route;
          session.resumeNodeId = blockedTargetNodeId;
          session.clearancePolicy = 'immediate-next-move';
        }
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private tryMoveTopLiftQueueBlockerDeeper(
    blocker: MutableVehicle,
    requester: MutableVehicle,
    blockedTargetNodeId: string
  ): boolean {
    if (
      !this.agentRefreshEnabled() ||
      !this.topLiftColumnLayoutEnabled() ||
      !requester.loaded ||
      blocker.loaded ||
      blocker.currentEdgeId !== null ||
      blocker.legRemainingM > 0 ||
      blocker.phaseRemainingSec > 0
    ) {
      return false;
    }
    const currentSlot = topLiftQueueParkingSlot(blocker.currentNodeId);
    const currentAccess = topLiftQueueAisleAccess(blocker.currentNodeId);
    const currentLiftNodeId = currentSlot?.liftNodeId ?? currentAccess?.liftNodeId ?? null;
    const currentSlotIndex = currentSlot?.slotIndex ?? currentAccess?.slotIndex ?? 0;
    if (!currentLiftNodeId || currentSlotIndex <= 0) {
      return false;
    }
    const requesterLiftNodeId =
      this.topLiftQueueServiceLiftNodeId(blockedTargetNodeId) ??
      this.topLiftQueueServiceLiftNodeId(requester.currentNodeId) ??
      (requester.targetNodeId ? this.topLiftQueueServiceLiftNodeId(requester.targetNodeId) : null);
    if (requesterLiftNodeId && requesterLiftNodeId !== currentLiftNodeId) {
      return false;
    }

    for (let slotIndex = currentSlotIndex + 1; slotIndex <= 3; slotIndex += 1) {
      const deeperNodeId = liftQueueNodeId(currentLiftNodeId, slotIndex);
      if (
        !this.layoutNode(deeperNodeId) ||
        this.currentNodeOccupancy.has(deeperNodeId) ||
        this.nodeClaimedByOtherVehicle(deeperNodeId, blocker.id)
      ) {
        continue;
      }
      let routeNodeIds: string[];
      try {
        routeNodeIds = this.agentRefreshShortestPath(blocker.currentNodeId, deeperNodeId, new Set([requester.currentNodeId]));
      } catch {
        continue;
      }
      const nextNodeId = routeNodeIds[1] ?? null;
      if (
        !nextNodeId ||
        routeNodeIds.at(-1) !== deeperNodeId ||
        !this.agentRefreshLocalRouteNodesClear(blocker, routeNodeIds)
      ) {
        continue;
      }

      blocker.routeNodeIds = routeNodeIds;
      blocker.routeIndex = 0;
      blocker.targetNodeId = nextNodeId;
      blocker.state = blocker.taskId ? 'assigned' : 'returning';
      blocker.waitReason = null;
      blocker.blockingReservationId = null;
      blocker.blockingVehicleId = null;
      blocker.waitingSinceSec = null;
      blocker.yieldHoldUntilSec = round(this.simTimeSec + this.routeTravelEstimateSec(blocker, routeNodeIds) + 8);
      blocker.yieldHoldNodeId = deeperNodeId;
      blocker.localRouteNodeIds = routeNodeIds;
      blocker.localRouteReason = 'temporary-yield';
      this.logAgentReroute(blocker, this.taskForVehicle(blocker), blockedTargetNodeId, routeNodeIds, 'agent-refresh-queue-blocker-deeper', { countTaskReplan: false });
      return true;
    }
    return false;
  }

  private tryDisplaceAgentRefreshTopLiftSpineBlocker(
    blocker: MutableVehicle,
    requester: MutableVehicle,
    blockedTargetNodeId: string
  ): boolean {
    if (
      !this.agentRefreshEnabled() ||
      !this.topLiftColumnLayoutEnabled() ||
      !requester.loaded ||
      blocker.loaded ||
      blocker.currentNodeId !== blockedTargetNodeId ||
      !this.topLiftColumnSpineOrAccessNode(blocker.currentNodeId) ||
      !this.topLiftColumnSpineOrAccessNode(requester.currentNodeId) ||
      !this.topLiftColumnSpineOrAccessNode(blockedTargetNodeId)
    ) {
      return false;
    }

    const forbiddenNodeIds = new Set<string>([
      requester.currentNodeId,
      blockedTargetNodeId
    ]);
    if (requester.targetNodeId) {
      forbiddenNodeIds.add(requester.targetNodeId);
    }
    const requesterContinuationNodeId = this.agentRouteNodeAfter(requester, blockedTargetNodeId);
    if (requesterContinuationNodeId) {
      forbiddenNodeIds.add(requesterContinuationNodeId);
    }

    const escapeNodeId = this.neighbors(blocker.currentNodeId)
      .filter((neighbor) => !forbiddenNodeIds.has(neighbor.nodeId))
      .filter((neighbor) => this.topLiftColumnSpineOrAccessNode(neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(blocker, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketKeepsGoalReachable(blocker, neighbor.nodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(blocker, blocker.currentNodeId, neighbor.nodeId))
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => !this.nodeClaimedByOtherVehicle(neighbor.nodeId, blocker.id))
      .sort((left, right) =>
        this.topLiftAdjacentSwapEscapeRank(left.nodeId) - this.topLiftAdjacentSwapEscapeRank(right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0]?.nodeId ?? null;
    if (!escapeNodeId) {
      return false;
    }

    const routeNodeIds = [blocker.currentNodeId, escapeNodeId];
    if (!this.agentRefreshLocalRouteNodesClear(blocker, routeNodeIds)) {
      return false;
    }

    this.installAgentRefreshTopLiftSpineCycleYield(blocker, routeNodeIds);
    const session = this.activeConflictSessionForPair(requester.id, blocker.id);
    if (session && session.yielderVehicleId === blocker.id) {
      session.state = 'yielding';
      session.updatedAtSec = this.simTimeSec;
      session.yielderOriginalNodeId = blocker.currentNodeId;
      session.yielderPocketNodeId = escapeNodeId;
      session.yielderLocalRouteNodeIds = routeNodeIds;
      session.resumeNodeId = blockedTargetNodeId;
      session.clearancePolicy = 'immediate-next-move';
    }
    return true;
  }

  private emptyStorageEscapeMovesAwayFromLoadedRequester(
    blocker: MutableVehicle,
    requester: MutableVehicle,
    blockedTargetNodeId: string,
    nextNodeId: string | null,
    block: { reason: string; blockingVehicleId: string | null }
  ): boolean {
    if (
      !nextNodeId ||
      !requester.loaded ||
      block.blockingVehicleId !== requester.id ||
      (block.reason !== 'min-separation' && block.reason !== 'avoidance-clearance') ||
      !this.isStorageNode(blocker.currentNodeId) ||
      !this.isStorageNode(nextNodeId) ||
      this.topLiftColumnKey(blocker.currentNodeId) !== this.topLiftColumnKey(nextNodeId)
    ) {
      return false;
    }
    const current = nodePosition(this.scenario, blocker.currentNodeId);
    const next = nodePosition(this.scenario, nextNodeId);
    const blockedTarget = nodePosition(this.scenario, blockedTargetNodeId);
    const currentDistance = Math.hypot(current.x - blockedTarget.x, current.z - blockedTarget.z);
    const nextDistance = Math.hypot(next.x - blockedTarget.x, next.z - blockedTarget.z);
    return nextDistance > currentDistance + 1e-6;
  }

  private agentEmptyEscapeRouteRepeatsLastStorageStep(vehicle: MutableVehicle, route: string[]): boolean {
    if (route.length !== 2 || !this.isStorageNode(route[0]!) || !this.isStorageNode(route[1]!)) {
      return false;
    }

    const previousNodeId = vehicle.routeIndex > 0 ? vehicle.routeNodeIds[vehicle.routeIndex - 1] : null;
    return previousNodeId === route[1];
  }

  private agentYieldEscapeRouteAcceptable(route: string[]): boolean {
    const goalNodeId = route.at(-1);
    if (!goalNodeId) {
      return false;
    }
    if (
      this.topLiftColumnLayoutEnabled() &&
      this.isStorageNode(route[0]!) &&
      isTopLiftColumnAccessNodeId(goalNodeId)
    ) {
      const directColumnExit = this.topLiftDirectStorageColumnExitRoute(route[0]!, goalNodeId);
      if (directColumnExit && directColumnExit.join('>') === route.join('>')) {
        return true;
      }
    }
    const maxNodes = this.isStorageNode(goalNodeId) ? 5 : 4;
    const maxDistanceM = this.isStorageNode(goalNodeId) ? 18 : 12;
    return route.length <= maxNodes && this.routeDistanceM(route) <= maxDistanceM;
  }

  private agentEmptyEscapeGoalAllowed(vehicle: MutableVehicle, goalNodeId: string): boolean {
    if (!this.topLiftColumnLayoutEnabled() || !this.isStorageNode(goalNodeId)) {
      return true;
    }
    const task = this.taskForVehicle(vehicle);
    if (
      task?.kind === 'inbound' &&
      vehicle.plannedGoalNodeId !== null &&
      topLiftQueueParkingSlot(vehicle.plannedGoalNodeId) !== null
    ) {
      return false;
    }
    if (task?.kind === 'outbound' && goalNodeId !== task.pickupNodeId) {
      return false;
    }
    return true;
  }

  private agentEmptyEscapeGoalCandidates(
    vehicle: MutableVehicle,
    requester: MutableVehicle,
    blockedTargetNodeId: string
  ): string[] {
    const rowLabel = this.nodeStorageRowLabel(vehicle.currentNodeId) ?? this.nodeStorageRowLabel(blockedTargetNodeId);
    if (!rowLabel) {
      return this.agentMainLaneEscapeGoalCandidates(vehicle, requester, blockedTargetNodeId);
    }
    if (this.topLiftColumnLayoutEnabled()) {
      const storageNodeId = this.isStorageNode(vehicle.currentNodeId)
        ? vehicle.currentNodeId
        : this.isStorageNode(blockedTargetNodeId)
          ? blockedTargetNodeId
          : null;
      if (storageNodeId) {
        const storagePosition = nodePosition(this.scenario, storageNodeId);
        const storageGoals = this.scenario.layout.nodes
          .filter((node) => node.type === 'storage' && this.nodeStorageRowLabel(node.id) === rowLabel)
          .sort((left, right) => {
            const leftDistance = Math.abs(left.x - storagePosition.x) + Math.abs(left.z - storagePosition.z);
            const rightDistance = Math.abs(right.x - storagePosition.x) + Math.abs(right.z - storagePosition.z);
            return leftDistance - rightDistance || left.id.localeCompare(right.id);
          })
          .map((node) => node.id);
        return [...this.inboundStorageExitNodeCandidates(storageNodeId), ...storageGoals];
      }
    }
    const rowNumber = rowLabel.replace(/^r/, '');
    const leftSide = `left-row-${rowNumber}`;
    const rightSide = `right-row-${rowNumber}`;
    const requesterNodeId = requester.targetNodeId ?? requester.currentNodeId;
    const requesterComesFromLeft = requester.currentNodeId.startsWith('left-row-') || requesterNodeId.startsWith('left-row-');
    const sideGoals = requesterComesFromLeft ? [rightSide, leftSide] : [leftSide, rightSide];
    const immediatePocket = this.agentStorageEntryNodeId(vehicle.currentNodeId);
    const storageGoals = this.scenario.layout.nodes
      .filter((node) => node.type === 'storage' && this.nodeStorageRowLabel(node.id) === rowLabel)
      .sort((left, right) =>
        Math.abs(right.x - nodePosition(this.scenario, requester.currentNodeId).x) -
        Math.abs(left.x - nodePosition(this.scenario, requester.currentNodeId).x) ||
        left.id.localeCompare(right.id)
      )
      .map((node) => node.id);
    return [immediatePocket, ...sideGoals, ...storageGoals].filter((nodeId): nodeId is string => nodeId !== null);
  }

  private agentMainLaneEscapeGoalCandidates(
    vehicle: MutableVehicle,
    requester: MutableVehicle,
    blockedTargetNodeId: string
  ): string[] {
    const vehiclePosition = nodePosition(this.scenario, vehicle.currentNodeId);
    const requesterPosition = nodePosition(this.scenario, requester.currentNodeId);
    const forbidden = new Set<string>([
      vehicle.currentNodeId,
      requester.currentNodeId,
      blockedTargetNodeId
    ]);
    if (requester.targetNodeId) {
      forbidden.add(requester.targetNodeId);
    }

    const candidates = this.scenario.layout.nodes
      .filter((node) =>
        !forbidden.has(node.id) &&
        (
          node.type === 'storage' ||
          (node.type === 'intersection' && /^left-row-|^right-row-/.test(node.id))
        )
      )
      .map((node) => {
        const distanceM = Math.abs(node.x - vehiclePosition.x) + Math.abs(node.z - vehiclePosition.z);
        const requesterDistanceM = Math.abs(node.x - requesterPosition.x) + Math.abs(node.z - requesterPosition.z);
        return { node, distanceM, requesterDistanceM };
      })
      .sort((left, right) =>
        (left.node.type === 'storage' ? -1 : 1) - (right.node.type === 'storage' ? -1 : 1) ||
        left.distanceM - right.distanceM ||
        right.requesterDistanceM - left.requesterDistanceM ||
        left.node.id.localeCompare(right.node.id)
      )
      .slice(0, 16)
      .map((candidate) => candidate.node.id);

    return [...new Set(candidates)];
  }

  private logAgentReroute(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    blockedNodeId: string,
    route: string[],
    reason: string,
    options: { countTaskReplan?: boolean } = {}
  ): void {
    this.replanCount += 1;
    if (task && options.countTaskReplan !== false) {
      task.replanCount += 1;
    }
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, task?.loadId ?? null, vehicle.currentNodeId, route.at(-1) ?? null, reason, this.vehiclePosition(vehicle), {
      blockedNodeId,
      route: route.join('>')
    });
  }

  private agentTurnPriority(vehicle: MutableVehicle): number {
    const task = this.taskForVehicle(vehicle);
    const ageSec = task ? Math.max(0, this.simTimeSec - task.createdAtSec) : 0;
    const loadPriority = vehicle.loaded ? 1_000_000 : 0;
    const taskPriority = vehicle.taskId ? 100_000 : 0;
    const waitPriority = vehicle.state === 'waiting-blocked' ? 10_000 : 0;
    const stagedSameLiftPickupPenalty =
      task && !vehicle.loaded && this.inboundTaskHasEarlierPickupTask(task) ? 90_000 : 0;
    return loadPriority + taskPriority + waitPriority + ageSec - stagedSameLiftPickupPenalty - this.vehicleOrdinal(vehicle.id) / 1000;
  }

  private startNextLeg(vehicle: MutableVehicle, dtSec: number): void {
    const fromNodeId = vehicle.currentNodeId;
    const task = this.taskById(vehicle.taskId);

    if (task && fromNodeId === task.pickupNodeId && !vehicle.loaded) {
      if (!this.inboundTaskLoadReadyAtPickup(task)) {
        if (!this.inboundPickupClearanceRouteActive(vehicle, task)) {
          if (this.rerouteInboundPickupVehicleBehindEarlierTask(vehicle, task)) {
            return;
          }
          this.waitForInboundPickupLoad(vehicle, task, dtSec);
          return;
        }
      } else {
        this.setTaskState(task, 'in-progress');
        task.startedAtSec ??= this.simTimeSec;
        vehicle.state = 'lifting';
        vehicle.speedMps = 0;
        vehicle.phaseRemainingSec = this.scenario.physicsParams.liftTimeSec;
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
        this.ensureZoneHoldReservation(vehicle, fromNodeId);
        this.logEvent('lift-started', vehicle.id, task.id, task.loadId, fromNodeId, fromNodeId, 'pickup-aligned', this.vehiclePosition(vehicle), {});
        return;
      }
    }

    if (task && fromNodeId === task.dropoffNodeId && vehicle.loaded) {
      vehicle.state = 'lowering';
      vehicle.speedMps = 0;
      vehicle.phaseRemainingSec = this.scenario.physicsParams.lowerTimeSec;
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.logEvent('lower-started', vehicle.id, task.id, task.loadId, fromNodeId, fromNodeId, 'dropoff-aligned', this.vehiclePosition(vehicle), {});
      return;
    }

    const toNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 1];

    if (!toNodeId) {
      if (!vehicle.taskId) {
        vehicle.state = 'parking';
        vehicle.phaseRemainingSec = 0;
      } else {
        vehicle.state = 'idle';
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
      }
      return;
    }

    const currentOccupant = this.currentNodeOccupancy.get(fromNodeId);
    if (this.collisionAvoidanceEnabled() && currentOccupant && currentOccupant !== vehicle.id) {
      const waitReason = 'node-occupancy-mismatch';
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, null, currentOccupant);
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = currentOccupant;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingVehicleId: currentOccupant
        });
      }
      return;
    }

    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    if (!edge) {
      vehicle.state = 'faulted';
      vehicle.waitReason = 'route-edge-missing';
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      this.error = `Missing route edge ${fromNodeId} -> ${toNodeId}`;
      this.logEvent('vehicle-faulted', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'route-edge-missing', this.vehiclePosition(vehicle), {});
      return;
    }

    const refugeExitBlock = this.storageRefugeExitBlock(vehicle, task, fromNodeId, toNodeId, edge);
    if (refugeExitBlock) {
      if (this.tryMoveDeeperIntoStorageRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      const shouldLogWait = this.shouldLogVehicleWait(
        vehicle,
        toNodeId,
        refugeExitBlock.reason,
        refugeExitBlock.blockingReservationId,
        refugeExitBlock.blockingVehicleId
      );
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = refugeExitBlock.reason;
      vehicle.blockingReservationId = refugeExitBlock.blockingReservationId;
      vehicle.blockingVehicleId = refugeExitBlock.blockingVehicleId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(refugeExitBlock.reason, round((this.blockedTimeByReasonSec.get(refugeExitBlock.reason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, refugeExitBlock.reason, this.vehiclePosition(vehicle), {
          blockingReservationId: refugeExitBlock.blockingReservationId,
          blockingVehicleId: refugeExitBlock.blockingVehicleId
        });
      }
      return;
    }

    const nextAxis = this.axisForEdge(edge);
    const requiresDirectionSwitch =
      nextAxis !== null &&
      vehicle.lastMovementAxis !== null &&
      nextAxis !== vehicle.lastMovementAxis &&
      vehicle.directionSwitchReadyNodeId !== fromNodeId &&
      this.scenario.physicsParams.switchDirectionSec > 0;
    if (requiresDirectionSwitch) {
      vehicle.state = 'assigned';
      vehicle.speedMps = 0;
      vehicle.phaseRemainingSec = this.scenario.physicsParams.switchDirectionSec;
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.logEvent('direction-switch-started', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'orthogonal-axis-change', this.vehiclePosition(vehicle), {
        fromAxis: vehicle.lastMovementAxis,
        toAxis: nextAxis,
        switchDirectionSec: String(this.scenario.physicsParams.switchDirectionSec)
      });
      return;
    }

    const liftIngressBlock = this.liftIngressStagingBlock(vehicle, toNodeId, task);
    if (liftIngressBlock) {
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, liftIngressBlock.reason, null, liftIngressBlock.blockingVehicleId);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = liftIngressBlock.reason;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = liftIngressBlock.blockingVehicleId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(liftIngressBlock.reason, round((this.blockedTimeByReasonSec.get(liftIngressBlock.reason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, liftIngressBlock.reason, this.vehiclePosition(vehicle), {
          blockingVehicleId: liftIngressBlock.blockingVehicleId
        });
      }
      return;
    }

    let closeNextOccupantId = this.closeOccupiedNextNode(vehicle, toNodeId);
    if (
      closeNextOccupantId &&
      this.topLiftQueueDeeperClearanceOverlapAllowed(vehicle, toNodeId, closeNextOccupantId)
    ) {
      closeNextOccupantId = null;
    }
    if (closeNextOccupantId) {
      if (this.tryMoveDeeperIntoStorageRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      if (this.tryInsertEmptySideAisleRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      if (vehicle.loaded && this.agentRefreshEnabled()) {
        this.agentTryDisplaceEmptyBlocker(closeNextOccupantId, vehicle, toNodeId);
      }
      const waitReason = 'min-separation';
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, null, closeNextOccupantId);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = closeNextOccupantId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingVehicleId: closeNextOccupantId
        });
      }
      return;
    }

    const movingTargetClaimId = this.collisionAvoidanceEnabled() ? this.movingVehicleTargetingNode(toNodeId, vehicle.id) : null;
    if (movingTargetClaimId) {
      if (this.tryInsertEmptySideAisleRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      const waitReason = 'node-reserved';
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, null, movingTargetClaimId);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = movingTargetClaimId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingVehicleId: movingTargetClaimId
        });
      }
      return;
    }

    const occupiedTargetId = this.collisionAvoidanceEnabled() ? this.currentNodeOccupancy.get(toNodeId) : null;
    if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
      if (this.tryMoveDeeperIntoStorageRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      if (this.tryInsertEmptySideAisleRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      const waitReason = this.liftPortWaitReason(toNodeId) ?? 'node-occupied';
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, null, occupiedTargetId);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = occupiedTargetId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingVehicleId: occupiedTargetId
        });
      }
      return;
    }

    const portalHoldBlock = this.collisionAvoidanceEnabled() ? this.portalNodeHoldBlock(vehicle, toNodeId) : null;
    if (portalHoldBlock) {
      if (this.tryInsertEmptySideAisleRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      const waitReason = 'zone-reserved';
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, portalHoldBlock.id, null);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = portalHoldBlock.id;
      vehicle.blockingVehicleId = null;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingReservationId: portalHoldBlock.id
        });
      }
      return;
    }

    const leadingVehicleId = this.leadingVehicleTooClose(vehicle, fromNodeId, toNodeId);
    if (leadingVehicleId) {
      if (this.tryInsertEmptySideAisleRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      const waitReason = 'min-separation';
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, null, leadingVehicleId);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = leadingVehicleId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingVehicleId: leadingVehicleId
        });
      }
      return;
    }

    const authorization = this.authorizeRouteHorizon(vehicle, task);

    if (!authorization.ok) {
      if (this.tryInsertEmptySideAisleRefuge(vehicle, toNodeId)) {
        this.startNextLeg(vehicle, dtSec);
        return;
      }
      const waitReason = this.liftPortWaitReason(toNodeId) ?? authorization.reasonCode;
      const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, authorization.blockingReservationId, null);
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.targetNodeId = toNodeId;
      vehicle.waitReason = waitReason;
      vehicle.blockingReservationId = authorization.blockingReservationId;
      vehicle.blockingVehicleId = null;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.ensureZoneHoldReservation(vehicle, fromNodeId);
      this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
      if (shouldLogWait) {
        this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
          blockingReservationId: authorization.blockingReservationId
        });
      }
      return;
    }

    this.installMoveReservationsReplacingSelfOverlap(vehicle, authorization.reservations);
    this.releaseNodeOccupancy(vehicle, fromNodeId);
    vehicle.directionSwitchReadyNodeId = null;
    vehicle.waitingSinceSec = null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.targetNodeId = toNodeId;
    vehicle.legRemainingM = authorization.edge.lengthM;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = authorization.travelSec;
    vehicle.currentEdgeId = authorization.edge.id;
    vehicle.targetSpeedMps = authorization.speedMps;
    vehicle.legMotionMode = authorization.motionMode;
    if (!authorization.reusedExisting) {
      this.logEvent('reservation-created', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'route-horizon', this.vehiclePosition(vehicle), {
        edgeId: authorization.edge.id,
        reservationIds: authorization.reservations.map((reservation) => reservation.id).join(','),
        motionMode: vehicle.legMotionMode,
        horizonLegCount: authorization.horizonLegCount
      });
    }
    this.advanceMovement(vehicle, dtSec);
  }

  private mustStopAtNode(vehicle: MutableVehicle, task: TaskStateRecord | null, nodeId: string): boolean {
    if (task && nodeId === task.pickupNodeId && !vehicle.loaded) {
      return true;
    }
    if (task && nodeId === task.dropoffNodeId && vehicle.loaded) {
      return true;
    }
    if (nodeId === vehicle.plannedGoalNodeId && topLiftQueueParkingSlot(nodeId)) {
      return true;
    }
    return !task && nodeId === this.parkingNodeFor(vehicle.id);
  }

  private layoutNode(nodeId: string): LayoutNode | null {
    return this.layoutNodesById.get(nodeId) ?? null;
  }

  private targetNodeCanServeAsExitBuffer(vehicle: MutableVehicle, task: TaskStateRecord | null, nodeId: string): boolean {
    if (!this.layoutNode(nodeId)) {
      return false;
    }
    return !this.mustClearNoStopNode(vehicle, task, nodeId);
  }

  private mustClearNoStopNode(vehicle: MutableVehicle, task: TaskStateRecord | null, nodeId: string): boolean {
    if (!this.collisionAvoidanceEnabled()) {
      return false;
    }
    const nodeRequiresClearThrough = this.layoutNode(nodeId)?.noStop === true;
    const zoneRequiresClearThrough = this.zonesForNode(nodeId).some(
      (zone) => zone.noStop && (zone.edgeIds.length === 0 || zone.id.startsWith('zone-main-portal-node'))
    );
    return (nodeRequiresClearThrough || zoneRequiresClearThrough) && !this.mustStopAtNode(vehicle, task, nodeId);
  }

  private movementRequiresClearThrough(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    fromNodeId: string,
    toNodeId: string
  ): boolean {
    if (!this.collisionAvoidanceEnabled()) {
      return false;
    }
    if (this.targetNodeCanServeAsExitBuffer(vehicle, task, toNodeId)) {
      return false;
    }
    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    if (!edge) {
      return false;
    }
    const targetNodeRequiresClearThrough = this.layoutNode(toNodeId)?.noStop === true;
    const movementZoneRequiresClearThrough = this.traffic
      .zonesForMovement(fromNodeId, toNodeId, edge.id)
      .some((zone) => zone.noStop);
    return targetNodeRequiresClearThrough || movementZoneRequiresClearThrough;
  }

  private noStopArrivalBlock(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    fromNodeId: string,
    nodeId: string
  ): { reason: string; blockingReservationId: string | null; blockingVehicleId: string | null } | null {
    if (!this.movementRequiresClearThrough(vehicle, task, fromNodeId, nodeId)) {
      return null;
    }
    const nextNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 2];
    if (!nextNodeId) {
      return { reason: 'no-stop-continuation-blocked', blockingReservationId: null, blockingVehicleId: null };
    }

    const occupiedTargetId = this.currentNodeOccupancy.get(nextNodeId);
    if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
      const blocker = this.vehicles.find((candidate) => candidate.id === occupiedTargetId) ?? null;
      if (blocker && this.agentRefreshEnabled() && this.agentRefreshBlockerIsBehindCurrentMove(vehicle, nodeId, blocker)) {
        return null;
      }
      return { reason: 'node-occupied', blockingReservationId: null, blockingVehicleId: occupiedTargetId };
    }

    const movingTargetClaimId = this.movingVehicleTargetingNode(nextNodeId, vehicle.id);
    if (movingTargetClaimId) {
      const blocker = this.vehicles.find((candidate) => candidate.id === movingTargetClaimId) ?? null;
      if (blocker && this.agentRefreshEnabled() && this.agentRefreshBlockerIsBehindCurrentMove(vehicle, nodeId, blocker)) {
        return null;
      }
      return { reason: 'node-reserved', blockingReservationId: null, blockingVehicleId: movingTargetClaimId };
    }

    const nextEdge = this.traffic.findEdge(nodeId, nextNodeId);
    if (!nextEdge) {
      return { reason: 'route-edge-missing', blockingReservationId: null, blockingVehicleId: null };
    }

    const speed = this.speedForEdge(vehicle, nextEdge);
    const motionMode = this.routeLegMotionMode(vehicle, nextEdge, nextNodeId, vehicle.routeIndex + 1, task);
    const travelSec = motionMode === 'cruise'
      ? nextEdge.lengthM / Math.max(0.001, speed)
      : calculateTravelTimeSec(nextEdge.lengthM, speed, this.scenario.physicsParams.accelerationMps2);
    const continuationStartTimeSec = this.simTimeSec + Math.max(0, vehicle.legTravelSec - vehicle.legElapsedSec);
    const requiredEndTimeSec = continuationStartTimeSec + travelSec + this.scenario.trafficPolicy.minimumClearanceSec;
    const tickEndToleranceSec = Math.max(this.scenario.timeStepSec, 1e-6);
    if (!this.hasSelfMoveAuthorizationAt(vehicle, nextEdge.id, nextNodeId, continuationStartTimeSec, requiredEndTimeSec, tickEndToleranceSec)) {
      return { reason: 'no-stop-continuation-blocked', blockingReservationId: null, blockingVehicleId: null };
    }

    return null;
  }

  private speedForEdge(vehicle: MutableVehicle, edge: ShuttleScenario['layout']['edges'][number]): number {
    const speedLimit = vehicle.loaded ? edge.speedLimitLoadedMps ?? this.scenario.physicsParams.loadedSpeedMps : edge.speedLimitEmptyMps ?? this.scenario.physicsParams.emptySpeedMps;
    return Math.min(speedLimit, vehicle.loaded ? this.scenario.physicsParams.loadedSpeedMps : this.scenario.physicsParams.emptySpeedMps);
  }

  private routeLegMotionMode(
    vehicle: MutableVehicle,
    edge: ShuttleScenario['layout']['edges'][number],
    toNodeId: string,
    routeIndex: number,
    task: TaskStateRecord | null
  ): MutableVehicle['legMotionMode'] {
    const axis = this.axisForEdge(edge);
    if (!axis || this.mustStopAtNode(vehicle, task, toNodeId)) {
      return 'profile';
    }
    if (routeIndex === vehicle.routeIndex && vehicle.state === 'waiting-blocked' && vehicle.currentEdgeId !== null) {
      return 'profile';
    }
    const nextNodeId = vehicle.routeNodeIds[routeIndex + 2];
    if (!nextNodeId) {
      return 'profile';
    }
    const nextEdge = this.traffic.findEdge(toNodeId, nextNodeId);
    return nextEdge && this.axisForEdge(nextEdge) === axis ? 'cruise' : 'profile';
  }

  private routeLegTravelSec(
    vehicle: MutableVehicle,
    edge: ShuttleScenario['layout']['edges'][number],
    toNodeId: string,
    routeIndex: number,
    motionMode: MutableVehicle['legMotionMode']
  ): number {
    const speed = this.speedForEdge(vehicle, edge);
    const fullTravelSec = motionMode === 'cruise'
      ? edge.lengthM / Math.max(0.001, speed)
      : calculateTravelTimeSec(edge.lengthM, speed, this.scenario.physicsParams.accelerationMps2);
    const isActiveCurrentLeg =
      vehicle.currentEdgeId === edge.id &&
      vehicle.targetNodeId === toNodeId &&
      vehicle.routeIndex === routeIndex;
    return isActiveCurrentLeg ? Math.max(0, vehicle.legTravelSec - vehicle.legElapsedSec) : fullTravelSec;
  }

  private routeHorizonEligible(
    vehicle: MutableVehicle,
    task: TaskStateRecord | null,
    fromNodeId: string,
    toNodeId: string
  ): boolean {
    return this.mustClearNoStopNode(vehicle, task, fromNodeId) || this.movementRequiresClearThrough(vehicle, task, fromNodeId, toNodeId);
  }

  private collisionAvoidanceEnabled(): boolean {
    return this.scenario.trafficPolicy.collisionAvoidanceEnabled !== false;
  }

  private agentMinimalEmptyStorageEscapeMove(
    vehicle: MutableVehicle,
    blockingVehicleId: string,
    nextX: number,
    nextZ: number
  ): boolean {
    if (
      (!this.agentMinimalEnabled() && !this.agentRefreshEnabled()) ||
      vehicle.loaded ||
      !vehicle.targetNodeId ||
      !this.isStorageNode(vehicle.targetNodeId)
    ) {
      return false;
    }
    const blocker = this.vehicles.find((candidate) => candidate.id === blockingVehicleId);
    if (!blocker) {
      return false;
    }
    const ignoredBlockerIds = new Set([blockingVehicleId]);
    if (this.predictedSweptFootprintOverlapVehicleId(vehicle, vehicle.x, vehicle.z, nextX, nextZ, ignoredBlockerIds)) {
      return false;
    }
    const currentClearanceM = vehicleFootprintClearanceM(vehicle, blocker, this.scenario.vehicles);
    const nextClearanceM = vehicleFootprintClearanceM({ x: nextX, z: nextZ, yaw: vehicle.yaw }, blocker, this.scenario.vehicles);
    const target = nodePosition(this.scenario, vehicle.targetNodeId);
    const targetClearanceM = vehicleFootprintClearanceM({ x: target.x, z: target.z, yaw: vehicle.yaw }, blocker, this.scenario.vehicles);
    const nextOverlapsBlocker = vehicleFootprintsOverlap({ x: nextX, z: nextZ, yaw: vehicle.yaw }, blocker, this.scenario.vehicles);
    const targetOverlapsBlocker = vehicleFootprintsOverlap({ x: target.x, z: target.z, yaw: vehicle.yaw }, blocker, this.scenario.vehicles);
    return !nextOverlapsBlocker && !targetOverlapsBlocker && (nextClearanceM > currentClearanceM + 0.001 || targetClearanceM > currentClearanceM + 0.01);
  }

  private agentSimpleEnabled(): boolean {
    return this.scenario.trafficPolicy.controllerMode === 'agent-simple' || this.agentMinimalEnabled() || this.agentRefreshEnabled();
  }

  private agentSimpleModeEnabled(): boolean {
    return this.scenario.trafficPolicy.controllerMode === 'agent-simple';
  }

  private agentMinimalEnabled(): boolean {
    return this.scenario.trafficPolicy.controllerMode === 'agent-minimal';
  }

  private agentRefreshEnabled(): boolean {
    return this.scenario.trafficPolicy.controllerMode === 'agent-refresh';
  }

  private leadingVehicleTooClose(vehicle: MutableVehicle, fromNodeId: string, toNodeId: string): string | null {
    if (!this.collisionAvoidanceEnabled()) {
      return null;
    }
    const from = nodePosition(this.scenario, fromNodeId);
    const to = nodePosition(this.scenario, toNodeId);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length <= 1e-9) {
      return null;
    }

    const ux = dx / length;
    const uz = dz / length;
    const lateralToleranceM = Math.max(0.15, this.scenario.vehicles.widthM * 0.55);
    const headwayM = Math.max(
      this.scenario.vehicles.lengthM + this.scenario.vehicles.safetyRadiusM + 0.15,
      this.scenario.vehicles.lengthM * 2 + this.scenario.vehicles.safetyRadiusM
    );

    for (const other of this.vehicles) {
      if (other.id === vehicle.id) {
        continue;
      }
      const relX = other.x - from.x;
      const relZ = other.z - from.z;
      const projection = relX * ux + relZ * uz;
      if (projection <= 0 || projection > headwayM) {
        continue;
      }

      const lateral = Math.abs(relX * -uz + relZ * ux);
      if (lateral > lateralToleranceM) {
        continue;
      }

      const otherAheadOnSameLane =
        other.currentNodeId === toNodeId ||
        other.targetNodeId === toNodeId ||
        (other.currentEdgeId !== null && this.edgeIsCollinearWithVector(other.currentEdgeId, ux, uz, from));
      if (otherAheadOnSameLane) {
        return other.id;
      }
    }
    return null;
  }

  private edgeIsCollinearWithVector(edgeId: string, ux: number, uz: number, origin: { x: number; z: number }): boolean {
    const edge = this.scenario.layout.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) {
      return false;
    }
    const from = nodePosition(this.scenario, edge.from);
    const to = nodePosition(this.scenario, edge.to);
    const edgeDx = to.x - from.x;
    const edgeDz = to.z - from.z;
    const edgeLength = Math.hypot(edgeDx, edgeDz);
    if (edgeLength <= 1e-9) {
      return false;
    }

    const edgeUx = edgeDx / edgeLength;
    const edgeUz = edgeDz / edgeLength;
    const parallel = Math.abs(edgeUx * ux + edgeUz * uz) >= 0.99;
    const lateral = Math.abs((from.x - origin.x) * -uz + (from.z - origin.z) * ux);
    return parallel && lateral <= Math.max(0.15, this.scenario.vehicles.widthM * 0.55);
  }

  private authorizeRouteHorizon(vehicle: MutableVehicle, task: TaskStateRecord | null): RouteLegAuthorization {
    const firstFromNodeId = vehicle.currentNodeId;
    const firstToNodeId = vehicle.routeNodeIds[vehicle.routeIndex + 1];
    if (!firstToNodeId) {
      return { ok: false, reasonCode: 'route-complete', blockingReservationId: null };
    }

    const firstEdge = this.traffic.findEdge(firstFromNodeId, firstToNodeId);
    if (!firstEdge) {
      return { ok: false, reasonCode: 'route-edge-missing', blockingReservationId: null };
    }

    const firstSpeed = this.speedForEdge(vehicle, firstEdge);
    const firstMotionMode = this.routeLegMotionMode(vehicle, firstEdge, firstToNodeId, vehicle.routeIndex, task);
    const firstTravelSec = this.routeLegTravelSec(vehicle, firstEdge, firstToNodeId, vehicle.routeIndex, firstMotionMode);
    const firstMovementMustClear = this.movementRequiresClearThrough(vehicle, task, firstFromNodeId, firstToNodeId);

    const requiredSelfAuthorizationEndSec = this.simTimeSec + firstTravelSec + this.scenario.trafficPolicy.minimumClearanceSec;
    if (
      !firstMovementMustClear &&
      this.hasActiveSelfMoveAuthorization(vehicle, firstEdge.id, firstToNodeId, requiredSelfAuthorizationEndSec)
    ) {
      return {
        ok: true,
        edge: firstEdge,
        speedMps: firstSpeed,
        travelSec: firstTravelSec,
        motionMode: firstMotionMode,
        reservations: [],
        horizonLegCount: 1,
        reusedExisting: true
      };
    }

    const priority = this.priorityFor(vehicle);
    const stagedReservations: Reservation[] = [];
    let horizonLegCount = 0;
    let cumulativeTravelSec = 0;
    let horizonAxis: 'x' | 'z' | null = null;
    let lastHorizonTargetNodeId = firstFromNodeId;

    for (
      let routeIndex = vehicle.routeIndex;
      routeIndex < vehicle.routeNodeIds.length - 1 && horizonLegCount < MAX_CLEAR_THROUGH_HORIZON_LEGS;
      routeIndex += 1
    ) {
      const fromNodeId = vehicle.routeNodeIds[routeIndex]!;
      const toNodeId = vehicle.routeNodeIds[routeIndex + 1]!;
      const edge = this.traffic.findEdge(fromNodeId, toNodeId);
      if (!edge) {
        return horizonLegCount === 0
          ? { ok: false, reasonCode: 'route-edge-missing', blockingReservationId: null }
          : {
              ok: true,
              edge: firstEdge,
              speedMps: firstSpeed,
              travelSec: firstTravelSec,
              motionMode: firstMotionMode,
              reservations: stagedReservations,
              horizonLegCount,
              reusedExisting: false
            };
      }

      const movementMustClear = this.movementRequiresClearThrough(vehicle, task, fromNodeId, toNodeId);
      const horizonEligible = this.routeHorizonEligible(vehicle, task, fromNodeId, toNodeId);
      if (horizonLegCount > 0 && !horizonEligible) {
        break;
      }

      const axis = this.axisForEdge(edge);
      const clearingNoStopTurn =
        movementMustClear ||
        this.mustClearNoStopNode(vehicle, task, fromNodeId) ||
        this.mustClearNoStopNode(vehicle, task, toNodeId);
      if (horizonLegCount > 0 && horizonAxis !== null && axis !== horizonAxis && !clearingNoStopTurn) {
        break;
      }

      const occupiedTargetId = this.collisionAvoidanceEnabled() ? this.currentNodeOccupancy.get(toNodeId) : null;
      if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
        break;
      }

      const motionMode = this.routeLegMotionMode(vehicle, edge, toNodeId, routeIndex, task);
      const travelSec = this.routeLegTravelSec(vehicle, edge, toNodeId, routeIndex, motionMode);
      const nextCumulativeTravelSec = cumulativeTravelSec + travelSec;
      if (
        horizonLegCount > 0 &&
        nextCumulativeTravelSec > MAX_CLEAR_THROUGH_HORIZON_SEC &&
        this.targetNodeCanServeAsExitBuffer(vehicle, task, lastHorizonTargetNodeId)
      ) {
        break;
      }
      const legStartTimeSec = this.simTimeSec + cumulativeTravelSec;
      cumulativeTravelSec = nextCumulativeTravelSec;
      const attempt = this.traffic.reserveMove({
        vehicleId: vehicle.id,
        taskId: vehicle.taskId,
        fromNodeId,
        toNodeId,
        startTimeSec: legStartTimeSec,
        travelSec,
        priority,
        existing: [...this.reservations, ...stagedReservations],
        ignoreConflicts: !this.collisionAvoidanceEnabled()
      });

      if (!attempt.ok) {
        if (
          firstMovementMustClear &&
          (horizonLegCount < 2 || !this.targetNodeCanServeAsExitBuffer(vehicle, task, lastHorizonTargetNodeId))
        ) {
          return attempt;
        }
        return horizonLegCount === 0
          ? attempt
          : {
              ok: true,
              edge: firstEdge,
              speedMps: firstSpeed,
              travelSec: firstTravelSec,
              motionMode: firstMotionMode,
              reservations: stagedReservations,
              horizonLegCount,
              reusedExisting: false
            };
      }

      stagedReservations.push(...attempt.reservations);
      horizonLegCount += 1;
      horizonAxis = axis ?? horizonAxis;
      lastHorizonTargetNodeId = toNodeId;

      if (this.mustStopAtNode(vehicle, task, toNodeId)) {
        break;
      }
      if (!horizonEligible && !this.mustClearNoStopNode(vehicle, task, toNodeId)) {
        break;
      }
    }

    if (firstMovementMustClear && horizonLegCount < 2) {
      return { ok: false, reasonCode: 'no-stop-continuation-blocked', blockingReservationId: null };
    }
    if (firstMovementMustClear && !this.targetNodeCanServeAsExitBuffer(vehicle, task, lastHorizonTargetNodeId)) {
      return { ok: false, reasonCode: 'no-stop-clearance-incomplete', blockingReservationId: null };
    }

    return {
      ok: true,
      edge: firstEdge,
      speedMps: firstSpeed,
      travelSec: firstTravelSec,
      motionMode: firstMotionMode,
      reservations: stagedReservations,
      horizonLegCount,
      reusedExisting: false
    };
  }

  private advanceMovement(vehicle: MutableVehicle, dtSec: number): void {
    const fromNodeId = vehicle.currentNodeId;
    const toNodeId = vehicle.targetNodeId;
    if (!toNodeId) {
      return;
    }
    const from = nodePosition(this.scenario, fromNodeId);
    const to = nodePosition(this.scenario, toNodeId);
    const edge = this.traffic.findEdge(fromNodeId, toNodeId);
    const task = this.taskById(vehicle.taskId);
    const lengthM = edge?.lengthM ?? Math.hypot(to.x - from.x, to.z - from.z);
    const remainingLegSec = Math.max(0, vehicle.legTravelSec - vehicle.legElapsedSec);
    const previousLegElapsedSec = vehicle.legElapsedSec;
    const previousLegRemainingM = vehicle.legRemainingM;
    const usedSec = Math.min(dtSec, remainingLegSec);
    vehicle.legElapsedSec = round(Math.min(vehicle.legTravelSec, vehicle.legElapsedSec + usedSec));
    const profile = vehicle.legMotionMode === 'cruise'
      ? {
          distanceM: vehicle.legElapsedSec * vehicle.targetSpeedMps,
          speedMps: vehicle.targetSpeedMps
        }
      : motionProfileAt(
          vehicle.legElapsedSec,
          lengthM,
          vehicle.targetSpeedMps,
          this.scenario.physicsParams.accelerationMps2
    );
    const legCompleteByTime = vehicle.legElapsedSec >= vehicle.legTravelSec - 1e-6;
    const traveledM = legCompleteByTime ? lengthM : Math.min(lengthM, profile.distanceM);
    const progress = lengthM <= 0 ? 1 : traveledM / lengthM;
    const nextX = round(from.x + (to.x - from.x) * progress);
    const nextZ = round(from.z + (to.z - from.z) * progress);

    if (legCompleteByTime && !this.agentSimpleEnabled()) {
      let noStopBlock = this.noStopArrivalBlock(vehicle, task, fromNodeId, toNodeId);
      if (
        noStopBlock &&
        (noStopBlock.reason === 'no-stop-continuation-blocked' || noStopBlock.reason === 'no-stop-clearance-incomplete')
      ) {
        const authorization = this.authorizeRouteHorizon(vehicle, task);
        if (authorization.ok) {
          const installedReservations = this.installMoveReservationsReplacingSelfOverlap(vehicle, authorization.reservations);
          noStopBlock = this.noStopArrivalBlock(vehicle, task, fromNodeId, toNodeId);
          if (noStopBlock) {
            this.rollbackMoveReservationInstall(installedReservations.installed, installedReservations.removed);
          }
        }
      }

      if (noStopBlock) {
        const holdDistanceM = Math.min(0.15, Math.max(0.01, lengthM * 0.05));
        const holdProgress = lengthM <= 1e-9 ? 0 : Math.max(0, (lengthM - holdDistanceM) / lengthM);
        const shouldLogWait = this.shouldLogVehicleWait(
          vehicle,
          toNodeId,
          noStopBlock.reason,
          noStopBlock.blockingReservationId,
          noStopBlock.blockingVehicleId
        );
        vehicle.legElapsedSec = round(Math.max(0, vehicle.legTravelSec - 0.001));
        vehicle.legRemainingM = round(holdDistanceM);
        vehicle.speedMps = 0;
        vehicle.x = round(from.x + (to.x - from.x) * holdProgress);
        vehicle.y = SHUTTLE_Y_M;
        vehicle.z = round(from.z + (to.z - from.z) * holdProgress);
        vehicle.state = 'waiting-blocked';
        vehicle.waitReason = noStopBlock.reason;
        vehicle.blockingReservationId = noStopBlock.blockingReservationId;
        vehicle.blockingVehicleId = noStopBlock.blockingVehicleId;
        vehicle.waitingSinceSec ??= this.simTimeSec;
        vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
        this.blockedTimeByReasonSec.set(noStopBlock.reason, round((this.blockedTimeByReasonSec.get(noStopBlock.reason) ?? 0) + dtSec));
        if (shouldLogWait) {
          this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, noStopBlock.reason, this.vehiclePosition(vehicle), {
            blockingReservationId: noStopBlock.blockingReservationId,
            blockingVehicleId: noStopBlock.blockingVehicleId
          });
        }
        return;
      }
    }

    let footprintBlockerId = this.collisionAvoidanceEnabled()
      ? this.predictedSweptFootprintOverlapVehicleId(vehicle, vehicle.x, vehicle.z, nextX, nextZ)
      : null;
    if (footprintBlockerId && this.agentRefreshEnabled()) {
      const footprintBlocker = this.vehicles.find((candidate) => candidate.id === footprintBlockerId) ?? null;
      if (footprintBlocker && this.agentRefreshStoragePocketBlockerIsOffAisleYield(vehicle, toNodeId, footprintBlocker)) {
        footprintBlockerId = null;
      }
      if (footprintBlockerId && this.topLiftQueueDeeperClearanceOverlapAllowed(vehicle, toNodeId, footprintBlockerId)) {
        footprintBlockerId = null;
      }
    }
    if (footprintBlockerId) {
      if (this.agentMinimalEmptyStorageEscapeMove(vehicle, footprintBlockerId, nextX, nextZ)) {
        vehicle.waitReason = null;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = null;
      } else {
        if (vehicle.loaded && this.agentRefreshEnabled()) {
          this.agentTryDisplaceEmptyBlocker(footprintBlockerId, vehicle, toNodeId);
        }
        const waitReason = this.agentMinimalEnabled() ? 'avoidance-clearance' : 'min-separation';
        const shouldLogWait = this.shouldLogVehicleWait(vehicle, toNodeId, waitReason, null, footprintBlockerId);
        vehicle.legElapsedSec = previousLegElapsedSec;
        vehicle.legRemainingM = previousLegRemainingM;
        vehicle.speedMps = 0;
        vehicle.state = 'waiting-blocked';
        vehicle.waitReason = waitReason;
        vehicle.blockingReservationId = null;
        vehicle.blockingVehicleId = footprintBlockerId;
        vehicle.waitingSinceSec ??= this.simTimeSec;
        vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
        this.blockedTimeByReasonSec.set(waitReason, round((this.blockedTimeByReasonSec.get(waitReason) ?? 0) + dtSec));
        if (shouldLogWait) {
          this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, waitReason, this.vehiclePosition(vehicle), {
            blockingVehicleId: footprintBlockerId
          });
        }
        if (this.agentRefreshEnabled()) {
          this.tryRetreatAgentRefreshNearFaceoff([vehicle.id, footprintBlockerId]);
        }
        return;
      }
    }

    vehicle.legRemainingM = round(Math.max(0, lengthM - traveledM));
    vehicle.speedMps = round(vehicle.legRemainingM <= 0 ? 0 : profile.speedMps);
    vehicle.x = nextX;
    vehicle.y = SHUTTLE_Y_M;
    vehicle.z = nextZ;
    vehicle.yaw = 0;

    if (vehicle.legRemainingM > 0) {
      return;
    }

    const previousNode = vehicle.currentNodeId;
    vehicle.currentNodeId = toNodeId;
    this.occupyNode(vehicle, toNodeId);
    vehicle.routeIndex += 1;
    vehicle.lastMovementAxis = edge ? this.axisForEdge(edge) : vehicle.lastMovementAxis;
    vehicle.targetNodeId = null;
    vehicle.currentEdgeId = null;
    vehicle.targetSpeedMps = 0;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = 0;
    vehicle.legMotionMode = 'profile';
    vehicle.speedMps = 0;
    this.logEvent('vehicle-arrived', vehicle.id, task?.id ?? null, task?.loadId ?? null, previousNode, toNodeId, 'route-arrival', this.vehiclePosition(vehicle), {});

    if (task && toNodeId === task.pickupNodeId && !vehicle.loaded) {
      if (!this.inboundTaskLoadReadyAtPickup(task)) {
        this.waitForInboundPickupLoad(vehicle, task, dtSec);
        return;
      }
      this.setTaskState(task, 'in-progress');
      task.startedAtSec ??= this.simTimeSec;
      vehicle.state = 'lifting';
      vehicle.phaseRemainingSec = this.scenario.physicsParams.liftTimeSec;
      this.logEvent('lift-started', vehicle.id, task.id, task.loadId, previousNode, toNodeId, 'pickup-aligned', this.vehiclePosition(vehicle), {});
      return;
    }

    if (task && toNodeId === task.dropoffNodeId && vehicle.loaded) {
      vehicle.state = 'lowering';
      vehicle.phaseRemainingSec = this.scenario.physicsParams.lowerTimeSec;
      this.logEvent('lower-started', vehicle.id, task.id, task.loadId, previousNode, toNodeId, 'dropoff-aligned', this.vehiclePosition(vehicle), {});
      return;
    }

    if (!task && toNodeId === this.parkingNodeFor(vehicle.id)) {
      vehicle.state = 'parking';
      vehicle.phaseRemainingSec = 0;
      return;
    }

    vehicle.state = 'assigned';
    const remainingStepSec = round(Math.max(0, dtSec - usedSec));
    if (remainingStepSec > 1e-6) {
      if (this.agentSimpleEnabled()) {
        this.startNextLegAgentSimple(vehicle, remainingStepSec);
      } else {
        this.startNextLeg(vehicle, remainingStepSec);
      }
    }
  }

  private priorityFor(vehicle: MutableVehicle): number {
    const task = this.taskById(vehicle.taskId);
    const base = task?.createdAtSec ?? this.simTimeSec;
    const age = Math.floor((this.simTimeSec - base) / Math.max(1, this.scenario.trafficPolicy.priorityAgingSec));
    return age * 1000 - Number(vehicle.id.replace(/\D+/g, '') || 0);
  }

  private updateDeadlockSmokeCounters(): void {
    const deadlockCandidateVehicleIds = this.deadlockCandidateVehicleIds();
    if (deadlockCandidateVehicleIds.length < 2) {
      this.deadlockCandidateSignature = null;
      this.deadlockCandidateSinceSec = null;
      return;
    }
    const signature = deadlockCandidateVehicleIds.join(',');
    if (signature !== this.deadlockCandidateSignature) {
      this.deadlockCandidateSignature = signature;
      this.deadlockCandidateSinceSec = this.simTimeSec;
      return;
    }
    if (this.deadlockCandidateSinceSec !== null && this.simTimeSec - this.deadlockCandidateSinceSec >= this.scenario.trafficPolicy.deadlockDetectSec) {
      if (this.agentRefreshEnabled() && this.tryBreakAgentRefreshStorageColumnQueue(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentRefreshEnabled() && this.tryBreakAgentRefreshLoadedStorageSwap(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentRefreshEnabled() && this.tryBreakAgentRefreshTopLiftAdjacentNodeSwap(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentRefreshEnabled() && this.tryBreakAgentRefreshTopLiftSpineCycle(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentRefreshEnabled() && this.tryRetreatAgentRefreshNearFaceoff(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentRefreshEnabled() && this.tryBreakAgentRefreshWaitCycle(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentMinimalEnabled() && this.tryRetreatAgentMinimalLoadedFaceoff(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentMinimalEnabled() && this.tryRetreatAgentMinimalEdgeBlocker(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.agentMinimalEnabled() && this.tryBreakAgentMinimalWaitCycle(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      if (this.tryBreakPortalHoldCycle(deadlockCandidateVehicleIds)) {
        this.deadlockCandidateSignature = null;
        this.deadlockCandidateSinceSec = null;
        return;
      }
      this.deadlockCount += 1;
      this.deadlockCandidateSinceSec = this.simTimeSec;
      this.logEvent('deadlock-detected', null, null, null, null, null, 'phase0-smoke-detector', null, {
        waitingVehicles: signature
      });
    }
  }

  private deadlockCandidateVehicleIds(): string[] {
    const waitingVehicles = this.vehicles.filter((vehicle) => vehicle.state === 'waiting-blocked');
    const waitFor = new Map<string, string>();
    for (const vehicle of waitingVehicles) {
      const blockingVehicleId = vehicle.blockingVehicleId ?? this.blockingVehicleForReservation(vehicle.blockingReservationId);
      if (blockingVehicleId && blockingVehicleId !== vehicle.id) {
        if (this.agentRefreshEnabled() && !this.agentRefreshDeadlockBlockerStillApplies(vehicle, blockingVehicleId)) {
          continue;
        }
        waitFor.set(vehicle.id, blockingVehicleId);
      }
    }

    const cycleVehicleIds = new Set<string>();
    for (const vehicleId of waitFor.keys()) {
      const seen = new Set<string>();
      let cursor: string | undefined = vehicleId;
      while (cursor) {
        if (seen.has(cursor)) {
          for (const id of seen) {
            cycleVehicleIds.add(id);
          }
          break;
        }
        seen.add(cursor);
        cursor = waitFor.get(cursor);
      }
    }
    return [...cycleVehicleIds].sort((left, right) => left.localeCompare(right));
  }

  private agentRefreshDeadlockBlockerStillApplies(vehicle: MutableVehicle, blockingVehicleId: string): boolean {
    if (vehicle.waitReason === 'local-yield-hold') {
      const task = this.taskForVehicle(vehicle);
      const block = this.agentRefreshYieldHoldBlocker(vehicle, task);
      return block?.blockingVehicleId === blockingVehicleId;
    }

    if (vehicle.waitReason === 'min-separation' || vehicle.waitReason === 'avoidance-clearance') {
      return this.agentRefreshFootprintBlockerStillApplies(vehicle, blockingVehicleId);
    }

    if (vehicle.waitReason === 'node-occupied' || vehicle.waitReason === 'node-target-near') {
      return this.agentRefreshNodeBlockerStillApplies(vehicle, blockingVehicleId);
    }

    return true;
  }

  private agentRefreshNodeBlockerStillApplies(vehicle: MutableVehicle, blockingVehicleId: string): boolean {
    if (!vehicle.targetNodeId) {
      return false;
    }
    const blocker = this.vehicles.find((candidate) => candidate.id === blockingVehicleId) ?? null;
    if (!blocker) {
      return false;
    }
    return blocker.currentNodeId === vehicle.targetNodeId || blocker.targetNodeId === vehicle.targetNodeId;
  }

  private agentRefreshFootprintBlockerStillApplies(vehicle: MutableVehicle, blockingVehicleId: string): boolean {
    const ignoredVehicleIds = new Set<string>();
    const currentBlockerId = this.predictedFootprintOverlapVehicleId(vehicle, vehicle.x, vehicle.z, ignoredVehicleIds);
    if (currentBlockerId === blockingVehicleId) {
      return true;
    }

    if (!vehicle.targetNodeId) {
      return false;
    }

    if (vehicle.currentEdgeId && vehicle.legRemainingM > 0) {
      const target = nodePosition(this.scenario, vehicle.targetNodeId);
      const dx = target.x - vehicle.x;
      const dz = target.z - vehicle.z;
      const distanceM = Math.hypot(dx, dz);
      if (distanceM <= 1e-6) {
        return false;
      }
      const lookaheadM = Math.min(vehicle.legRemainingM, Math.max(0.25, this.scenario.trafficPolicy.dynamicAvoidanceClearanceM));
      const ratio = Math.min(1, lookaheadM / distanceM);
      const nextX = round(vehicle.x + dx * ratio);
      const nextZ = round(vehicle.z + dz * ratio);
      return this.predictedSweptFootprintOverlapVehicleId(vehicle, vehicle.x, vehicle.z, nextX, nextZ, ignoredVehicleIds) === blockingVehicleId;
    }

    const target = nodePosition(this.scenario, vehicle.targetNodeId);
    return this.predictedFootprintOverlapVehicleId(vehicle, target.x, target.z, ignoredVehicleIds) === blockingVehicleId;
  }

  private tryBreakAgentRefreshTopLiftAdjacentNodeSwap(candidateVehicleIds: string[]): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const candidateIds = new Set(candidateVehicleIds);
    const swaps = this.vehicles
      .filter((vehicle) =>
        candidateIds.has(vehicle.id) &&
        vehicle.state === 'waiting-blocked' &&
        vehicle.waitReason === 'node-occupied' &&
        vehicle.currentEdgeId === null &&
        vehicle.legRemainingM <= 0 &&
        vehicle.targetNodeId !== null &&
        vehicle.blockingVehicleId !== null &&
        this.topLiftColumnSpineOrAccessNode(vehicle.currentNodeId) &&
        this.topLiftColumnSpineOrAccessNode(vehicle.targetNodeId)
      )
      .map((vehicle) => {
        const blocker = vehicle.blockingVehicleId
          ? this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId) ?? null
          : null;
        return { vehicle, blocker };
      })
      .filter((entry): entry is { vehicle: MutableVehicle; blocker: MutableVehicle } =>
        Boolean(
          entry.blocker &&
          candidateIds.has(entry.blocker.id) &&
          entry.blocker.state === 'waiting-blocked' &&
          entry.blocker.targetNodeId === entry.vehicle.currentNodeId &&
          entry.vehicle.targetNodeId === entry.blocker.currentNodeId &&
          entry.blocker.currentEdgeId === null &&
          entry.blocker.legRemainingM <= 0 &&
          this.topLiftColumnSpineOrAccessNode(entry.blocker.currentNodeId)
        )
      )
      .sort((left, right) => left.vehicle.id.localeCompare(right.vehicle.id));

    const seenPairs = new Set<string>();
    for (const { vehicle, blocker } of swaps) {
      const pairKey = [vehicle.id, blocker.id].sort().join(':');
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);
      const vehicleAtSpineMiddle = isTopLiftSpineLevelNodeId(vehicle.currentNodeId, 'middle');
      const blockerAtSpineMiddle = isTopLiftSpineLevelNodeId(blocker.currentNodeId, 'middle');
      const yielder = vehicleAtSpineMiddle && !blockerAtSpineMiddle
        ? vehicle
        : blockerAtSpineMiddle && !vehicleAtSpineMiddle
          ? blocker
          : [vehicle, blocker].sort((left, right) =>
              Number(left.loaded) - Number(right.loaded) ||
              this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
              right.id.localeCompare(left.id)
            )[0]!;
      const fallbackYielder = yielder.id === vehicle.id ? blocker : vehicle;
      const yielderCandidates = [yielder, fallbackYielder];
      for (const candidateYielder of yielderCandidates) {
        const blockerNodeId = candidateYielder.id === vehicle.id ? blocker.currentNodeId : vehicle.currentNodeId;
        const routeNodeIds = this.topLiftAdjacentSwapEscapeRoute(candidateYielder, blockerNodeId);
        if (!routeNodeIds) {
          continue;
        }
        if (!this.agentRefreshLocalRouteNodesClear(candidateYielder, routeNodeIds)) {
          continue;
        }
        this.installAgentRefreshAdjacentNodeSwapYield(candidateYielder, routeNodeIds);
        return true;
      }
    }
    return false;
  }

  private topLiftAdjacentSwapEscapeRoute(vehicle: MutableVehicle, blockedNodeId: string): string[] | null {
    const routes = this.neighbors(vehicle.currentNodeId)
      .filter((neighbor) => neighbor.nodeId !== blockedNodeId)
      .filter((neighbor) => this.topLiftAdjacentSwapEscapeAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, vehicle.currentNodeId, neighbor.nodeId))
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => !this.nodeClaimedByOtherVehicle(neighbor.nodeId, vehicle.id))
      .map((neighbor) => this.topLiftAdjacentSwapEscapeRouteFromFirstStep(vehicle, blockedNodeId, neighbor.nodeId))
      .filter((route): route is string[] => route !== null)
      .filter((route) => this.agentRefreshLocalRouteNodesClear(vehicle, route))
      .sort((left, right) =>
        this.topLiftAdjacentSwapEscapeRouteRank(vehicle, left) - this.topLiftAdjacentSwapEscapeRouteRank(vehicle, right) ||
        this.routeDistanceM(left) - this.routeDistanceM(right) ||
        left.join('>').localeCompare(right.join('>'))
      );
    return routes[0] ?? null;
  }

  private topLiftAdjacentSwapEscapeRouteFromFirstStep(
    vehicle: MutableVehicle,
    blockedNodeId: string,
    firstNodeId: string
  ): string[] | null {
    const directRoute = [vehicle.currentNodeId, firstNodeId];
    if (this.topLiftAdjacentSwapHoldNodeAllowed(vehicle, firstNodeId)) {
      return directRoute;
    }
    if (!this.topLiftColumnSpineOrAccessNode(firstNodeId)) {
      return null;
    }

    const task = this.taskForVehicle(vehicle);
    const queue: Array<{ nodeId: string; routeNodeIds: string[]; distanceM: number }> = [{
      nodeId: firstNodeId,
      routeNodeIds: directRoute,
      distanceM: this.routeDistanceM(directRoute)
    }];
    const bestDistanceByNode = new Map<string, number>([[vehicle.currentNodeId, 0], [firstNodeId, queue[0]!.distanceM]]);
    const maxRouteNodes = 8;

    while (queue.length > 0) {
      queue.sort((left, right) =>
        left.distanceM - right.distanceM ||
        left.routeNodeIds.join('>').localeCompare(right.routeNodeIds.join('>'))
      );
      const current = queue.shift()!;
      if (
        current.nodeId !== firstNodeId &&
        !this.mustClearNoStopNode(vehicle, task, current.nodeId) &&
        this.topLiftAdjacentSwapHoldNodeAllowed(vehicle, current.nodeId)
      ) {
        return current.routeNodeIds;
      }
      if (current.routeNodeIds.length >= maxRouteNodes) {
        continue;
      }

      for (const neighbor of this.neighbors(current.nodeId)) {
        if (
          neighbor.nodeId === vehicle.currentNodeId ||
          neighbor.nodeId === blockedNodeId ||
          current.routeNodeIds.includes(neighbor.nodeId) ||
          !this.topLiftAdjacentSwapClearThroughStepAllowed(vehicle, neighbor.nodeId) ||
          this.topLiftDoubleLaneDirectionAllowed(current.nodeId, neighbor.nodeId) === false ||
          this.currentNodeOccupancy.has(neighbor.nodeId) ||
          this.nodeClaimedByOtherVehicle(neighbor.nodeId, vehicle.id)
        ) {
          continue;
        }
        const routeNodeIds = [...current.routeNodeIds, neighbor.nodeId];
        const distanceM = current.distanceM + neighbor.lengthM;
        if (distanceM >= (bestDistanceByNode.get(neighbor.nodeId) ?? Infinity) - 1e-9) {
          continue;
        }
        bestDistanceByNode.set(neighbor.nodeId, distanceM);
        queue.push({ nodeId: neighbor.nodeId, routeNodeIds, distanceM });
      }
    }
    return null;
  }

  private topLiftAdjacentSwapHoldNodeAllowed(vehicle: MutableVehicle, nodeId: string): boolean {
    const task = this.taskForVehicle(vehicle);
    if (this.mustClearNoStopNode(vehicle, task, nodeId)) {
      return false;
    }
    return this.agentRefreshYieldPocketAllowed(vehicle, nodeId) &&
      this.agentRefreshYieldPocketKeepsGoalReachable(vehicle, nodeId);
  }

  private topLiftAdjacentSwapClearThroughStepAllowed(vehicle: MutableVehicle, nodeId: string): boolean {
    if (this.topLiftColumnSpineOrAccessNode(nodeId)) {
      return true;
    }
    return this.topLiftAdjacentSwapHoldNodeAllowed(vehicle, nodeId);
  }

  private topLiftAdjacentSwapEscapeRouteRank(vehicle: MutableVehicle, routeNodeIds: string[]): number {
    const firstStepNodeId = routeNodeIds[1] ?? routeNodeIds[0] ?? '';
    const holdNodeId = routeNodeIds.at(-1) ?? firstStepNodeId;
    const task = this.taskForVehicle(vehicle);
    const clearThroughPenalty = this.mustClearNoStopNode(vehicle, task, firstStepNodeId) ? 10 : 0;
    const parkingPenalty = this.layoutNode(holdNodeId)?.type === 'parking' ? 4 : 0;
    return clearThroughPenalty + parkingPenalty + this.topLiftAdjacentSwapEscapeRank(firstStepNodeId);
  }

  private topLiftAdjacentSwapEscapeAllowed(vehicle: MutableVehicle, nodeId: string): boolean {
    if (this.topLiftColumnSpineOrAccessNode(nodeId)) {
      return true;
    }
    return this.topLiftColumnLayoutEnabled() &&
      isTopLiftAisleLevelNodeId(vehicle.currentNodeId, 'middle') &&
      this.isStorageNode(nodeId) &&
      this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId);
  }

  private topLiftAdjacentSwapEscapeRank(nodeId: string): number {
    if (this.isStorageNode(nodeId)) {
      return 0;
    }
    if (isTopLiftAisleLevelNodeId(nodeId, 'top-b') || isTopLiftAisleLevelNodeId(nodeId, 'bottom-a')) {
      return 1;
    }
    if (isTopLiftAisleLevelNodeId(nodeId, 'top-a') || isTopLiftAisleLevelNodeId(nodeId, 'bottom-b')) {
      return 2;
    }
    if (isTopLiftAisleLevelNodeId(nodeId, 'middle')) {
      return 3;
    }
    return 4;
  }

  private installAgentRefreshAdjacentNodeSwapYield(vehicle: MutableVehicle, routeNodeIds: string[]): void {
    const holdNodeId = routeNodeIds.at(-1) ?? vehicle.currentNodeId;
    if (this.mustClearNoStopNode(vehicle, this.taskForVehicle(vehicle), holdNodeId)) {
      return;
    }
    vehicle.routeNodeIds = routeNodeIds;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = routeNodeIds[1] ?? null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    vehicle.localRouteNodeIds = routeNodeIds;
    vehicle.localRouteReason = 'temporary-yield';
    this.logAgentReroute(vehicle, this.taskForVehicle(vehicle), routeNodeIds.at(-1) ?? vehicle.currentNodeId, routeNodeIds, 'agent-refresh-top-lift-adjacent-swap-yield', { countTaskReplan: false });
  }

  private tryBreakAgentRefreshTopLiftSpineCycle(candidateVehicleIds: string[]): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return false;
    }
    const candidateIds = new Set(candidateVehicleIds);
    const loadedDown = this.vehicles.find((vehicle) =>
      candidateIds.has(vehicle.id) &&
      vehicle.loaded &&
      vehicle.state === 'waiting-blocked' &&
      (
        vehicle.waitReason === 'edge-head-on' ||
        vehicle.waitReason === 'middle-aisle-opposing-claim' ||
        vehicle.waitReason === 'top-lift-spine-opposing-claim' ||
        vehicle.waitReason === 'no-stop-continuation-blocked'
      ) &&
      vehicle.currentEdgeId === null &&
      isTopLiftSpineLevelNodeId(vehicle.currentNodeId, 'top-b') &&
      isTopLiftSpineLevelNodeId(vehicle.targetNodeId ?? '', 'middle')
    );
    if (!loadedDown || !loadedDown.targetNodeId) {
      return false;
    }
    const topBNodeId = loadedDown.currentNodeId;
    const middleNodeId = loadedDown.targetNodeId;
    if (this.tryMoveAgentRefreshTopLiftLoadedDownAside(loadedDown, topBNodeId, middleNodeId)) {
      return true;
    }
    const emptyCandidates = this.vehicles
      .filter((vehicle) =>
        candidateIds.has(vehicle.id) &&
        !vehicle.loaded &&
        vehicle.state === 'waiting-blocked' &&
        (vehicle.waitReason === 'min-separation' || vehicle.waitReason === 'avoidance-clearance') &&
        vehicle.currentNodeId === middleNodeId &&
        vehicle.targetNodeId === topBNodeId
      )
      .sort((left, right) =>
        Number(Boolean(left.taskId)) - Number(Boolean(right.taskId)) ||
        (left.waitingSinceSec ?? this.simTimeSec) - (right.waitingSinceSec ?? this.simTimeSec) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of emptyCandidates) {
      const continuationNodeId = this.agentRefreshTopLiftSpineEscapeNodeId(vehicle, middleNodeId, topBNodeId);
      if (!continuationNodeId) {
        continue;
      }
      if (vehicle.currentEdgeId !== null) {
        const edge = this.traffic.findEdge(middleNodeId, topBNodeId);
        if (!edge) {
          continue;
        }
        this.startAgentMinimalReverseLeg(
          vehicle,
          edge,
          topBNodeId,
          middleNodeId,
          [topBNodeId, middleNodeId, continuationNodeId],
          'agent-refresh-top-lift-spine-cycle-yield'
        );
        return true;
      }
      const routeNodeIds = [middleNodeId, continuationNodeId];
      if (!this.agentRefreshLocalRouteNodesClear(vehicle, routeNodeIds)) {
        continue;
      }
      this.installAgentRefreshTopLiftSpineCycleYield(vehicle, routeNodeIds);
      return true;
    }
    return false;
  }

  private tryMoveAgentRefreshTopLiftLoadedDownAside(
    vehicle: MutableVehicle,
    topBNodeId: string,
    middleNodeId: string
  ): boolean {
    const escapeNodeId = this.neighbors(topBNodeId)
      .filter((neighbor) => neighbor.nodeId !== middleNodeId)
      .filter((neighbor) => this.topLiftColumnSpineOrAccessNode(neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketKeepsGoalReachable(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, topBNodeId, neighbor.nodeId))
      .sort((left, right) =>
        this.agentRefreshTopLiftLoadedDownEscapeRank(left.nodeId) - this.agentRefreshTopLiftLoadedDownEscapeRank(right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0]?.nodeId ?? null;
    if (!escapeNodeId) {
      return false;
    }
    const routeNodeIds = [topBNodeId, escapeNodeId];
    if (!this.agentRefreshLocalRouteNodesClear(vehicle, routeNodeIds)) {
      return false;
    }
    this.installAgentRefreshTopLiftSpineCycleYield(vehicle, routeNodeIds);
    return true;
  }

  private agentRefreshTopLiftLoadedDownEscapeRank(nodeId: string): number {
    if (isTopLiftAisleLevelNodeId(nodeId, 'top-b')) {
      return 0;
    }
    if (isTopLiftSpineLevelNodeId(nodeId, 'top-a')) {
      return 1;
    }
    if (isTopLiftAisleLevelNodeId(nodeId, 'top-a')) {
      return 2;
    }
    return 3;
  }

  private agentRefreshTopLiftSpineEscapeNodeId(
    vehicle: MutableVehicle,
    middleNodeId: string,
    blockedTopBNodeId: string
  ): string | null {
    return this.neighbors(middleNodeId)
      .filter((neighbor) => neighbor.nodeId !== blockedTopBNodeId)
      .filter((neighbor) => this.topLiftColumnSpineOrAccessNode(neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketKeepsGoalReachable(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, middleNodeId, neighbor.nodeId))
      .sort((left, right) =>
        this.agentRefreshTopLiftSpineEscapeRank(left.nodeId) - this.agentRefreshTopLiftSpineEscapeRank(right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0]?.nodeId ?? null;
  }

  private agentRefreshTopLiftSpineEscapeRank(nodeId: string): number {
    if (isTopLiftSpineLevelNodeId(nodeId, 'bottom-a')) {
      return 0;
    }
    if (/^column-middle-c\d+$/.test(nodeId)) {
      return 1;
    }
    if (isTopLiftSpineLevelNodeId(nodeId, 'top-a')) {
      return 2;
    }
    return 3;
  }

  private installAgentRefreshTopLiftSpineCycleYield(vehicle: MutableVehicle, routeNodeIds: string[]): void {
    vehicle.routeNodeIds = routeNodeIds;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = routeNodeIds[1] ?? null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    vehicle.localRouteNodeIds = routeNodeIds;
    vehicle.localRouteReason = 'temporary-yield';
    this.logAgentReroute(vehicle, this.taskForVehicle(vehicle), routeNodeIds.at(-1) ?? vehicle.currentNodeId, routeNodeIds, 'agent-refresh-top-lift-spine-cycle-yield', { countTaskReplan: false });
  }

  private tryRetreatAgentRefreshNearFaceoff(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const candidates = this.vehicles
      .filter((vehicle) => {
        if (
          !candidateIds.has(vehicle.id) ||
          vehicle.state !== 'waiting-blocked' ||
          (vehicle.waitReason !== 'min-separation' && vehicle.waitReason !== 'avoidance-clearance' && vehicle.waitReason !== 'edge-head-on' && vehicle.waitReason !== 'lift-column-near' && vehicle.waitReason !== 'top-lift-spine-opposing-claim') ||
          vehicle.targetNodeId === null ||
          !vehicle.blockingVehicleId
        ) {
          return false;
        }
        const blocker = this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId);
        return Boolean(
          blocker &&
          candidateIds.has(blocker.id) &&
          blocker.state === 'waiting-blocked' &&
          blocker.blockingVehicleId === vehicle.id
        );
      })
      .sort((left, right) =>
        Number(left.loaded) - Number(right.loaded) ||
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of candidates) {
      const retreatNodeId = vehicle.currentNodeId;
      const fromBlockedNodeId = vehicle.targetNodeId;
      if (!fromBlockedNodeId) {
        continue;
      }
      const edge = this.traffic.findEdge(retreatNodeId, fromBlockedNodeId);
      if (!edge) {
        continue;
      }
      const blocker = vehicle.blockingVehicleId
        ? this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId) ?? null
        : null;
      if (vehicle.currentEdgeId === null) {
        const currentLiftId = this.liftStorageTransferTargetLiftId(retreatNodeId);
        const targetLiftId = this.liftStorageTransferTargetLiftId(fromBlockedNodeId);
        const oldLiftTransferFaceoff = Boolean(currentLiftId && currentLiftId === targetLiftId);
        const topLiftSpineFaceoff = this.topLiftColumnLayoutEnabled() &&
          this.topLiftColumnSpineOrAccessNode(retreatNodeId) &&
          this.topLiftColumnSpineOrAccessNode(fromBlockedNodeId);
        if (!oldLiftTransferFaceoff && !topLiftSpineFaceoff) {
          continue;
        }
        const session = blocker ? this.activeConflictSessionForPair(vehicle.id, blocker.id) : null;
        if (this.agentRefreshWinnerShouldStayCourse(session, vehicle, blocker)) {
          continue;
        }
        if (blocker && this.agentRefreshInstallSideYield(vehicle, fromBlockedNodeId, blocker, session)) {
          return true;
        }
        continue;
      }
      const forwardPocketNodeId = this.agentRefreshForwardYieldPocketNodeId(vehicle, retreatNodeId, fromBlockedNodeId, blocker);
      if (forwardPocketNodeId) {
        const routeNodeIds = [retreatNodeId, fromBlockedNodeId, forwardPocketNodeId];
        if (!this.agentRefreshLocalRouteNodesClear(vehicle, routeNodeIds)) {
          continue;
        }
        if (this.agentRefreshTemporaryRouteAlreadyActive(vehicle, routeNodeIds)) {
          return true;
        }
        this.startAgentRefreshForwardPocketYield(
          vehicle,
          edge,
          retreatNodeId,
          fromBlockedNodeId,
          forwardPocketNodeId
        );
        return true;
      }
      const continuationNodeId = this.agentRefreshYieldPocketNodeId(vehicle, retreatNodeId, fromBlockedNodeId);
      const retreatNode = this.layoutNode(retreatNodeId);
      const canShortRetreatOnly = !continuationNodeId && Boolean(retreatNode && (retreatNode.type === 'lift-blackbox' || retreatNode.type === 'parking'));
      if (!continuationNodeId && !canShortRetreatOnly) {
        continue;
      }
      const routeNodeIds = continuationNodeId ? [fromBlockedNodeId, retreatNodeId, continuationNodeId] : [fromBlockedNodeId, retreatNodeId];
      if (this.agentRefreshTemporaryRouteAlreadyActive(vehicle, routeNodeIds)) {
        return true;
      }
      this.startAgentMinimalReverseLeg(
        vehicle,
        edge,
        fromBlockedNodeId,
        retreatNodeId,
        routeNodeIds,
        'agent-refresh-near-faceoff-yield',
        continuationNodeId ? 0 : 4
      );
      return true;
    }
    return false;
  }

  private topLiftColumnSpineOrAccessNode(nodeId: string): boolean {
    return isTopLiftColumnAccessNodeId(nodeId);
  }

  private agentRefreshTemporaryRouteAlreadyActive(vehicle: MutableVehicle, routeNodeIds: string[]): boolean {
    return vehicle.localRouteReason === 'temporary-yield' &&
      vehicle.routeNodeIds.join('>') === routeNodeIds.join('>') &&
      vehicle.localRouteNodeIds.join('>') === routeNodeIds.join('>') &&
      this.agentRefreshLocalRouteNodesClear(vehicle, routeNodeIds);
  }

  private tryBreakAgentRefreshStorageColumnQueue(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const candidateOrDependent = this.vehicles
      .filter((vehicle) =>
        !vehicle.loaded &&
        vehicle.state === 'waiting-blocked' &&
        vehicle.waitReason === 'node-occupied' &&
        vehicle.currentEdgeId === null &&
        vehicle.legRemainingM <= 0 &&
        vehicle.targetNodeId !== null &&
        vehicle.blockingVehicleId !== null &&
        (candidateIds.has(vehicle.id) || candidateIds.has(vehicle.blockingVehicleId))
      )
      .sort((left, right) =>
        Number(left.loaded) - Number(right.loaded) ||
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of candidateOrDependent) {
      const routeNodeIds = this.agentRefreshStorageColumnQueueYieldRoute(vehicle);
      if (!routeNodeIds) {
        continue;
      }
      if (this.agentRefreshTemporaryRouteAlreadyActive(vehicle, routeNodeIds)) {
        return true;
      }
      this.installAgentRefreshStorageColumnQueueYield(vehicle, routeNodeIds);
      return true;
    }
    return false;
  }

  private agentRefreshStorageColumnQueueYieldRoute(vehicle: MutableVehicle): string[] | null {
    if (!vehicle.targetNodeId) {
      return null;
    }
    const currentPosition = this.storageGridPosition(vehicle.currentNodeId);
    const targetPosition = this.storageGridPosition(vehicle.targetNodeId);
    if (!currentPosition || !targetPosition || currentPosition.column !== targetPosition.column) {
      return null;
    }

    const awayDirection = Math.sign(currentPosition.row - targetPosition.row);
    const candidates: string[] = [];
    if (awayDirection !== 0) {
      candidates.push(`storage-r${String(currentPosition.row + awayDirection).padStart(2, '0')}-c${String(currentPosition.column).padStart(2, '0')}`);
    }
    candidates.push(
      ...this.neighbors(vehicle.currentNodeId)
        .map((neighbor) => neighbor.nodeId)
        .filter((nodeId) => isTopLiftColumnAccessNodeId(nodeId))
    );

    for (const nodeId of candidates.filter((candidate, index, all) => all.indexOf(candidate) === index)) {
      const node = this.layoutNode(nodeId);
      if (!node || nodeId === vehicle.targetNodeId || !this.traffic.findEdge(vehicle.currentNodeId, nodeId)) {
        continue;
      }
      if (node.type === 'storage' && !this.agentRefreshStorageColumnQueueEscapeNodeAllowed(vehicle, nodeId)) {
        continue;
      }
      if (
        node.type !== 'storage' &&
        (
          this.currentNodeOccupancy.has(nodeId) ||
          this.nodeClaimedByOtherVehicle(nodeId, vehicle.id)
        )
      ) {
        continue;
      }
      if (this.agentRefreshMoveBlocker(vehicle, nodeId)) {
        continue;
      }
      return [vehicle.currentNodeId, nodeId];
    }
    return null;
  }

  private installAgentRefreshStorageColumnQueueYield(vehicle: MutableVehicle, routeNodeIds: string[]): void {
    vehicle.routeNodeIds = routeNodeIds;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = routeNodeIds[1] ?? null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    vehicle.localRouteNodeIds = routeNodeIds;
    vehicle.localRouteReason = 'temporary-yield';
    this.logAgentReroute(vehicle, this.taskForVehicle(vehicle), routeNodeIds.at(-1) ?? vehicle.currentNodeId, routeNodeIds, 'agent-refresh-storage-column-queue-yield', { countTaskReplan: false });
  }

  private agentRefreshStorageColumnQueueEscapeNodeAllowed(vehicle: MutableVehicle, nodeId: string): boolean {
    if (vehicle.loaded || !this.isStorageNode(nodeId)) {
      return this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId);
    }
    const occupantId = this.currentNodeOccupancy.get(nodeId);
    if (occupantId && occupantId !== vehicle.id) {
      return false;
    }
    if (this.nodeClaimedByOtherVehicle(nodeId, vehicle.id)) {
      return false;
    }
    return !this.activeInboundDropoffNodeIds().has(nodeId);
  }

  private tryBreakAgentRefreshLoadedStorageSwap(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const consideredPairs = new Set<string>();
    const candidates = this.vehicles
      .filter((vehicle) =>
        candidateIds.has(vehicle.id) &&
        vehicle.loaded &&
        vehicle.state === 'waiting-blocked' &&
        vehicle.waitReason === 'node-occupied' &&
        vehicle.currentEdgeId === null &&
        vehicle.legRemainingM <= 0 &&
        vehicle.targetNodeId !== null &&
        vehicle.blockingVehicleId !== null
      )
      .sort((left, right) =>
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of candidates) {
      const blocker = this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId) ?? null;
      if (
        !blocker ||
        !candidateIds.has(blocker.id) ||
        !this.agentRefreshLoadedStorageSwapPair(vehicle, blocker)
      ) {
        continue;
      }
      const pairKey = [vehicle.id, blocker.id].sort((left, right) => left.localeCompare(right)).join('+');
      if (consideredPairs.has(pairKey)) {
        continue;
      }
      consideredPairs.add(pairKey);

      const plans = [
        this.agentRefreshLoadedStorageSwapClearancePlan(vehicle, blocker),
        this.agentRefreshLoadedStorageSwapClearancePlan(blocker, vehicle)
      ]
        .filter((plan): plan is { vehicle: MutableVehicle; blocker: MutableVehicle; routeNodeIds: string[]; score: number } => plan !== null)
        .filter((plan) => this.agentRefreshLocalRouteNodesClear(plan.vehicle, plan.routeNodeIds))
        .sort((left, right) =>
          left.score - right.score ||
          this.agentTurnPriority(left.vehicle) - this.agentTurnPriority(right.vehicle) ||
          right.vehicle.id.localeCompare(left.vehicle.id)
        );
      const plan = plans[0];
      if (!plan) {
        continue;
      }

      const session = this.activeConflictSessionForPair(plan.vehicle.id, plan.blocker.id);
      if (session) {
        this.closeConflictSession(session, 'loaded-storage-swap-clearance');
      }
      this.installAgentRefreshLoadedStorageSwapClearance(plan.vehicle, plan.blocker, plan.routeNodeIds);
      return true;
    }
    return false;
  }

  private agentRefreshLoadedStorageSwapPair(vehicle: MutableVehicle, blocker: MutableVehicle): boolean {
    if (
      !vehicle.loaded ||
      !blocker.loaded ||
      blocker.state !== 'waiting-blocked' ||
      blocker.waitReason !== 'node-occupied' ||
      blocker.currentEdgeId !== null ||
      blocker.legRemainingM > 0 ||
      blocker.targetNodeId !== vehicle.currentNodeId ||
      vehicle.targetNodeId !== blocker.currentNodeId
    ) {
      return false;
    }
    const vehiclePosition = this.storageGridPosition(vehicle.currentNodeId);
    const blockerPosition = this.storageGridPosition(blocker.currentNodeId);
    return Boolean(
      vehiclePosition &&
      blockerPosition &&
      (
        (vehiclePosition.row === blockerPosition.row && Math.abs(vehiclePosition.column - blockerPosition.column) === 1) ||
        (
          this.topLiftColumnLayoutEnabled() &&
          vehiclePosition.column === blockerPosition.column &&
          Math.abs(vehiclePosition.row - blockerPosition.row) === 1
        )
      )
    );
  }

  private agentRefreshLoadedStorageSwapClearancePlan(
    vehicle: MutableVehicle,
    blocker: MutableVehicle
  ): { vehicle: MutableVehicle; blocker: MutableVehicle; routeNodeIds: string[]; score: number } | null {
    const currentPosition = this.storageGridPosition(vehicle.currentNodeId);
    const blockerPosition = this.storageGridPosition(blocker.currentNodeId);
    if (!currentPosition || !blockerPosition) {
      return null;
    }

    if (
      this.topLiftColumnLayoutEnabled() &&
      currentPosition.column === blockerPosition.column &&
      Math.abs(currentPosition.row - blockerPosition.row) === 1
    ) {
      return this.agentRefreshLoadedStorageColumnSwapSidePocketPlan(vehicle, blocker, currentPosition) ??
        this.agentRefreshLoadedStorageColumnSwapClearancePlan(vehicle, blocker, currentPosition, blockerPosition);
    }

    if (currentPosition.row !== blockerPosition.row) {
      return null;
    }

    const escapeSide: 'left' | 'right' = currentPosition.column > blockerPosition.column ? 'right' : 'left';
    const sideNodeId = this.storageSideNodeId(vehicle.currentNodeId, escapeSide);
    if (!sideNodeId) {
      return null;
    }

    try {
      const blockedNodeIds = this.blockedStorageTransitNodeIds(vehicle.currentNodeId, sideNodeId, { blockStoredLoads: true });
      blockedNodeIds.delete(vehicle.currentNodeId);
      blockedNodeIds.delete(sideNodeId);
      blockedNodeIds.add(blocker.currentNodeId);
      const sideRoute = this.agentRefreshShortestPath(vehicle.currentNodeId, sideNodeId, blockedNodeIds);
      if (
        sideRoute.length < 2 ||
        sideRoute.includes(blocker.currentNodeId) ||
        sideRoute.slice(1, -1).some((nodeId) => this.storedLoadIdAtNode(nodeId))
      ) {
        return null;
      }

      const routeNodeIds = [...sideRoute];
      const aisleEscapeNodeId = this.agentRefreshLoadedStorageSwapAisleEscapeNodeId(sideNodeId, vehicle, blocker);
      if (aisleEscapeNodeId) {
        routeNodeIds.push(aisleEscapeNodeId);
      }

      const nextNodeId = routeNodeIds[1] ?? null;
      if (!nextNodeId || this.agentRefreshMoveBlocker(vehicle, nextNodeId, routeNodeIds)) {
        return null;
      }

      return {
        vehicle,
        blocker,
        routeNodeIds,
        score: this.routeDistanceM(routeNodeIds)
      };
    } catch {
      return null;
    }
  }

  private agentRefreshLoadedStorageColumnSwapSidePocketPlan(
    vehicle: MutableVehicle,
    blocker: MutableVehicle,
    currentPosition: { row: number; column: number }
  ): { vehicle: MutableVehicle; blocker: MutableVehicle; routeNodeIds: string[]; score: number } | null {
    const candidates = [currentPosition.column - 1, currentPosition.column + 1]
      .map((column) => `storage-r${String(currentPosition.row).padStart(2, '0')}-c${String(column).padStart(2, '0')}`)
      .filter((nodeId) =>
        nodeId !== blocker.currentNodeId &&
        this.layoutNode(nodeId) &&
        this.traffic.findEdge(vehicle.currentNodeId, nodeId) &&
        this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId) &&
        !this.agentRefreshMoveBlocker(vehicle, nodeId)
      )
      .map((nodeId) => ({
        vehicle,
        blocker,
        routeNodeIds: [vehicle.currentNodeId, nodeId],
        score: this.routeDistanceM([vehicle.currentNodeId, nodeId])
      }))
      .sort((left, right) =>
        left.score - right.score ||
        left.routeNodeIds[1]!.localeCompare(right.routeNodeIds[1]!)
      );
    return candidates[0] ?? null;
  }

  private agentRefreshLoadedStorageColumnSwapClearancePlan(
    vehicle: MutableVehicle,
    blocker: MutableVehicle,
    currentPosition: { row: number; column: number },
    _blockerPosition: { row: number; column: number }
  ): { vehicle: MutableVehicle; blocker: MutableVehicle; routeNodeIds: string[]; score: number } | null {
    const blockedNodeIds = this.agentRefreshTemporaryStorageBlockedNodeIds(vehicle);
    blockedNodeIds.delete(vehicle.currentNodeId);
    blockedNodeIds.add(blocker.currentNodeId);

    const current = nodePosition(this.scenario, vehicle.currentNodeId);
    const accessNodeIds = this.scenario.layout.nodes
      .filter((node) =>
        isTopLiftColumnAccessNodeId(node.id) &&
        this.topLiftColumnAccessColumn(node.id) === currentPosition.column &&
        !this.currentNodeOccupancy.has(node.id) &&
        !this.nodeClaimedByOtherVehicle(node.id, vehicle.id)
      )
      .sort((left, right) =>
        Math.abs(left.z - current.z) - Math.abs(right.z - current.z) ||
        left.id.localeCompare(right.id)
      )
      .map((node) => node.id);

    for (const accessNodeId of accessNodeIds) {
      try {
        const routeNodeIds = this.agentRefreshShortestPath(vehicle.currentNodeId, accessNodeId, blockedNodeIds);
        if (
          routeNodeIds.length < 2 ||
          routeNodeIds.length > 6 ||
          routeNodeIds.includes(blocker.currentNodeId) ||
          !this.routeHasOnlyAdjacentEdges(routeNodeIds) ||
          routeNodeIds.slice(1, -1).some((nodeId) =>
            this.isStorageNode(nodeId) && !this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId)
          )
        ) {
          continue;
        }
        const nextNodeId = routeNodeIds[1] ?? null;
        if (!nextNodeId || this.agentRefreshMoveBlocker(vehicle, nextNodeId, routeNodeIds)) {
          continue;
        }
        return {
          vehicle,
          blocker,
          routeNodeIds,
          score: this.routeDistanceM(routeNodeIds)
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  private agentRefreshTemporaryStorageBlockedNodeIds(vehicle: MutableVehicle): Set<string> {
    return new Set(
      this.scenario.layout.nodes
        .filter((node) => node.type === 'storage')
        .map((node) => node.id)
        .filter((nodeId) => !this.agentRefreshTemporaryStorageNodeAllowed(vehicle, nodeId))
    );
  }

  private topLiftColumnAccessColumn(nodeId: string): number | null {
    const match = /^column-(?:top-a|top-b|middle|bottom-a|bottom-b)-c(\d+)$/.exec(nodeId);
    return match ? Number(match[1]) : null;
  }

  private routeHasOnlyAdjacentEdges(routeNodeIds: string[]): boolean {
    for (let index = 1; index < routeNodeIds.length; index += 1) {
      if (!this.traffic.findEdge(routeNodeIds[index - 1]!, routeNodeIds[index]!)) {
        return false;
      }
    }
    return true;
  }

  private agentRefreshTemporaryStorageNodeAllowed(vehicle: MutableVehicle, nodeId: string): boolean {
    const occupantId = this.currentNodeOccupancy.get(nodeId);
    if (occupantId && occupantId !== vehicle.id) {
      return false;
    }
    if (this.nodeClaimedByOtherVehicle(nodeId, vehicle.id)) {
      return false;
    }
    if (this.storedLoadIdAtNode(nodeId)) {
      return false;
    }
    const task = this.taskForVehicle(vehicle);
    const activeInboundDropoffs = this.activeInboundDropoffNodeIds();
    return !activeInboundDropoffs.has(nodeId) || (vehicle.loaded && task?.dropoffNodeId === nodeId);
  }

  private agentRefreshLoadedStorageSwapAisleEscapeNodeId(sideNodeId: string, vehicle: MutableVehicle, blocker: MutableVehicle): string | null {
    const sideMatch = /^(left|right)-row-(\d+)$/.exec(sideNodeId);
    if (!sideMatch) {
      return null;
    }
    const side = sideMatch[1] as 'left' | 'right';
    const row = Number(sideMatch[2]);
    const blockerTask = this.taskForVehicle(blocker);
    const blockerGoalNodeId = this.agentGoalNodeId(blocker, blockerTask);
    const blockerGoalRow = blockerGoalNodeId ? this.storageGridPosition(blockerGoalNodeId)?.row ?? null : null;
    const preferredDirection = blockerGoalRow !== null && blockerGoalRow !== row
      ? -Math.sign(blockerGoalRow - row)
      : -1;
    const directions = [preferredDirection, -preferredDirection].filter((direction, index, self) =>
      direction !== 0 && self.indexOf(direction) === index
    );

    for (const direction of directions) {
      const candidateNodeId = `${side}-row-${String(row + direction).padStart(2, '0')}`;
      if (
        this.layoutNode(candidateNodeId) &&
        this.traffic.findEdge(sideNodeId, candidateNodeId) &&
        !this.currentNodeOccupancy.has(candidateNodeId) &&
        !this.nodeClaimedByOtherVehicle(candidateNodeId, vehicle.id)
      ) {
        return candidateNodeId;
      }
    }
    return null;
  }

  private installAgentRefreshLoadedStorageSwapClearance(
    vehicle: MutableVehicle,
    blocker: MutableVehicle,
    routeNodeIds: string[]
  ): void {
    vehicle.routeNodeIds = routeNodeIds;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = routeNodeIds[1] ?? null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    vehicle.localRouteNodeIds = routeNodeIds;
    vehicle.localRouteReason = 'loaded-storage-swap-clearance';
    this.logAgentReroute(vehicle, this.taskForVehicle(vehicle), blocker.currentNodeId, routeNodeIds, 'agent-refresh-loaded-storage-swap-clearance', { countTaskReplan: false });
  }

  private agentRefreshForwardYieldPocketNodeId(
    vehicle: MutableVehicle,
    currentNodeId: string,
    forwardNodeId: string,
    blocker: MutableVehicle | null = null
  ): string | null {
    const occupantId = this.currentNodeOccupancy.get(forwardNodeId);
    if (occupantId && occupantId !== vehicle.id) {
      return null;
    }

    const pocketNodeId = this.agentRefreshYieldPocketNodeId(vehicle, forwardNodeId, currentNodeId);
    if (!pocketNodeId) {
      return null;
    }
    if (!this.agentRefreshForwardYieldPocketAllowed(vehicle, currentNodeId, pocketNodeId)) {
      return null;
    }
    if (blocker && this.agentRefreshForwardPocketWouldPassBlocker(currentNodeId, forwardNodeId, blocker)) {
      if (vehicle.loaded) {
        return null;
      }
      const currentPocketNodeId = this.agentRefreshYieldPocketNodeId(vehicle, currentNodeId, forwardNodeId);
      if (currentPocketNodeId) {
        return null;
      }
    }

    const current = nodePosition(this.scenario, currentNodeId);
    const forward = nodePosition(this.scenario, forwardNodeId);
    const distanceToCurrentM = Math.hypot(vehicle.x - current.x, vehicle.z - current.z);
    const distanceToForwardM = Math.hypot(vehicle.x - forward.x, vehicle.z - forward.z);
    const nearForwardThresholdM = Math.max(
      this.scenario.trafficPolicy.dynamicAvoidanceClearanceM + this.scenario.vehicles.lengthM,
      1.8
    );
    const forwardIsTransfer = this.liftStorageTransferTargetLiftId(forwardNodeId) !== null;
    const alreadyCommittedForward = distanceToForwardM <= distanceToCurrentM + 0.25;
    const nearEnoughToTurnIn = distanceToForwardM <= nearForwardThresholdM;
    if (!forwardIsTransfer && !alreadyCommittedForward && !nearEnoughToTurnIn) {
      return null;
    }

    return pocketNodeId;
  }

  private agentRefreshForwardPocketWouldPassBlocker(
    currentNodeId: string,
    forwardNodeId: string,
    blocker: MutableVehicle
  ): boolean {
    const current = nodePosition(this.scenario, currentNodeId);
    const forward = nodePosition(this.scenario, forwardNodeId);
    const sameVerticalLine = Math.abs(current.x - forward.x) <= 1e-6 &&
      Math.abs(blocker.x - current.x) <= this.scenario.vehicles.widthM;
    if (sameVerticalLine) {
      const minZ = Math.min(current.z, forward.z);
      const maxZ = Math.max(current.z, forward.z);
      return blocker.z > minZ + 0.05 && blocker.z < maxZ - 0.05;
    }
    const sameHorizontalLine = Math.abs(current.z - forward.z) <= 1e-6 &&
      Math.abs(blocker.z - current.z) <= this.scenario.vehicles.widthM;
    if (sameHorizontalLine) {
      const minX = Math.min(current.x, forward.x);
      const maxX = Math.max(current.x, forward.x);
      return blocker.x > minX + 0.05 && blocker.x < maxX - 0.05;
    }
    return false;
  }

  private agentRefreshForwardYieldPocketAllowed(
    vehicle: MutableVehicle,
    currentNodeId: string,
    pocketNodeId: string
  ): boolean {
    const task = this.taskForVehicle(vehicle);
    if (
      !vehicle.loaded ||
      !task ||
      task.kind !== 'inbound' ||
      this.layoutNode(currentNodeId)?.type !== 'lift-blackbox' ||
      !this.isStorageNode(pocketNodeId)
    ) {
      return true;
    }
    if (this.topLiftColumnLayoutEnabled()) {
      const pocketColumnKey = this.topLiftColumnKey(pocketNodeId);
      const dropoffColumnKey = this.topLiftColumnKey(task.dropoffNodeId);
      return pocketColumnKey !== null && pocketColumnKey === dropoffColumnKey;
    }
    return this.nodeStorageRowLabel(pocketNodeId) === this.nodeStorageRowLabel(task.dropoffNodeId);
  }

  private tryBreakAgentRefreshWaitCycle(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const candidates = this.vehicles
      .filter((vehicle) =>
        candidateIds.has(vehicle.id) &&
        vehicle.state === 'waiting-blocked' &&
        !vehicle.loaded &&
        vehicle.currentEdgeId === null &&
        vehicle.legRemainingM <= 0 &&
        vehicle.targetNodeId !== null &&
        vehicle.blockingVehicleId !== null
      )
      .sort((left, right) =>
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of candidates) {
      const blocker = this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId) ?? null;
      if (!blocker) {
        continue;
      }
      const session = this.activeConflictSessionForPair(vehicle.id, blocker.id);
      if (this.agentRefreshWinnerShouldStayCourse(session, vehicle, blocker)) {
        continue;
      }
      if (this.agentRefreshInstallSideYield(vehicle, vehicle.targetNodeId!, blocker, session)) {
        return true;
      }
    }
    return false;
  }

  private startAgentRefreshForwardPocketYield(
    vehicle: MutableVehicle,
    edge: ShuttleScenario['layout']['edges'][number],
    currentNodeId: string,
    forwardNodeId: string,
    pocketNodeId: string
  ): void {
    const from = nodePosition(this.scenario, currentNodeId);
    const edgeLengthM = Math.max(0.001, edge.lengthM);
    const distanceFromCurrentM = Math.min(
      edgeLengthM,
      Math.max(0, Math.hypot(vehicle.x - from.x, vehicle.z - from.z))
    );
    const speedMps = Math.max(0.001, this.speedForEdge(vehicle, edge));
    const routeNodeIds = [currentNodeId, forwardNodeId, pocketNodeId];
    vehicle.currentNodeId = currentNodeId;
    vehicle.routeNodeIds = routeNodeIds;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = forwardNodeId;
    vehicle.currentEdgeId = edge.id;
    vehicle.legMotionMode = 'cruise';
    vehicle.legTravelSec = round(edgeLengthM / speedMps);
    vehicle.legElapsedSec = round(distanceFromCurrentM / speedMps);
    vehicle.legRemainingM = round(edgeLengthM - distanceFromCurrentM);
    vehicle.targetSpeedMps = speedMps;
    vehicle.speedMps = 0;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.yieldHoldUntilSec = null;
    vehicle.yieldHoldNodeId = null;
    vehicle.localRouteNodeIds = routeNodeIds;
    vehicle.localRouteReason = 'temporary-yield';
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    const task = this.taskForVehicle(vehicle);
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, task?.loadId ?? null, currentNodeId, pocketNodeId, 'agent-refresh-forward-pocket-yield', this.vehiclePosition(vehicle), {
      route: routeNodeIds.join('>')
    });
  }

  private agentRefreshYieldPocketNodeId(
    vehicle: MutableVehicle,
    currentNodeId: string,
    blockedNodeId: string | null = vehicle.targetNodeId
  ): string | null {
    const candidate = this.neighbors(currentNodeId)
      .filter((neighbor) => neighbor.nodeId !== blockedNodeId)
      .filter((neighbor) => this.agentRefreshYieldPocketAllowed(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentRefreshYieldPocketKeepsGoalReachable(vehicle, neighbor.nodeId))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, currentNodeId, neighbor.nodeId))
      .sort((left, right) =>
        this.agentRefreshYieldPocketRank(vehicle, left.nodeId) - this.agentRefreshYieldPocketRank(vehicle, right.nodeId) ||
        this.agentRefreshYieldPocketTieBreak(vehicle, left.nodeId) - this.agentRefreshYieldPocketTieBreak(vehicle, right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0];
    return candidate?.nodeId ?? null;
  }

  private agentRefreshYieldPocketKeepsGoalReachable(vehicle: MutableVehicle, pocketNodeId: string): boolean {
    if (!this.topLiftColumnLayoutEnabled()) {
      return true;
    }
    const task = this.taskForVehicle(vehicle);
    if (!vehicle.loaded || task?.kind !== 'inbound') {
      return true;
    }
    try {
      return this.agentRefreshLoadedInboundRouteToDropoff(pocketNodeId, task).length > 1;
    } catch {
      return false;
    }
  }

  private tryRetreatAgentMinimalLoadedFaceoff(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const candidates = this.vehicles
      .filter((vehicle) => {
        if (
          !candidateIds.has(vehicle.id) ||
          vehicle.state !== 'waiting-blocked' ||
          vehicle.waitReason !== 'avoidance-clearance' ||
          vehicle.currentEdgeId === null ||
          vehicle.targetNodeId === null ||
          !vehicle.loaded ||
          !vehicle.blockingVehicleId
        ) {
          return false;
        }
        const blocker = this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId);
        return Boolean(
          blocker &&
          blocker.loaded &&
          blocker.state === 'waiting-blocked' &&
          blocker.waitReason === 'avoidance-clearance' &&
          blocker.blockingVehicleId === vehicle.id &&
          blocker.currentEdgeId !== null &&
          blocker.targetNodeId === vehicle.targetNodeId
        );
      })
      .sort((left, right) =>
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of candidates) {
      const retreatNodeId = vehicle.currentNodeId;
      const fromBlockedNodeId = vehicle.targetNodeId;
      if (!fromBlockedNodeId) {
        continue;
      }
      const retreatNode = this.layoutNode(retreatNodeId);
      if (!retreatNode || (retreatNode.type !== 'lift-blackbox' && retreatNode.type !== 'parking')) {
        continue;
      }
      const edge = this.traffic.findEdge(retreatNodeId, fromBlockedNodeId);
      if (!edge) {
        continue;
      }
      this.startAgentMinimalReverseLeg(
        vehicle,
        edge,
        fromBlockedNodeId,
        retreatNodeId,
        [fromBlockedNodeId, retreatNodeId],
        'loaded-retreats-from-faceoff',
        5
      );
      return true;
    }
    return false;
  }

  private tryRetreatAgentMinimalEdgeBlocker(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const candidates = this.vehicles
      .filter((vehicle) =>
        candidateIds.has(vehicle.id) &&
        vehicle.state === 'waiting-blocked' &&
        vehicle.waitReason === 'avoidance-clearance' &&
        vehicle.currentEdgeId !== null &&
        vehicle.targetNodeId !== null &&
        !vehicle.loaded
      )
      .sort((left, right) =>
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );

    for (const vehicle of candidates) {
      const retreatNodeId = vehicle.currentNodeId;
      const fromBlockedNodeId = vehicle.targetNodeId;
      if (!fromBlockedNodeId) {
        continue;
      }
      const edge = this.traffic.findEdge(retreatNodeId, fromBlockedNodeId);
      if (!edge) {
        continue;
      }
      const blocker = vehicle.blockingVehicleId ? this.vehicles.find((candidate) => candidate.id === vehicle.blockingVehicleId) : null;
      if (blocker && !blocker.loaded) {
        continue;
      }
      const occupantId = this.currentNodeOccupancy.get(retreatNodeId);
      if (occupantId && occupantId !== vehicle.id) {
        continue;
      }
      const continuationNodeId = this.agentMinimalYieldPocketNodeId(vehicle, retreatNodeId, fromBlockedNodeId);
      if (!continuationNodeId) {
        continue;
      }

      this.startAgentMinimalReverseLeg(
        vehicle,
        edge,
        fromBlockedNodeId,
        retreatNodeId,
        [fromBlockedNodeId, retreatNodeId, continuationNodeId],
        'empty-retreats-to-local-yield'
      );
      return true;
    }
    return false;
  }

  private startAgentMinimalReverseLeg(
    vehicle: MutableVehicle,
    edge: ShuttleScenario['layout']['edges'][number],
    fromBlockedNodeId: string,
    retreatNodeId: string,
    routeNodeIds: string[],
    reason: string,
    holdAfterArrivalSec = 0
  ): void {
    const reverseFrom = nodePosition(this.scenario, fromBlockedNodeId);
    const edgeLengthM = Math.max(0.001, edge.lengthM);
    const distanceFromReverseStartM = Math.min(
      edgeLengthM,
      Math.max(0, Math.hypot(vehicle.x - reverseFrom.x, vehicle.z - reverseFrom.z))
    );
    const speedMps = Math.max(0.001, this.speedForEdge(vehicle, edge));
    const remainingReverseTravelSec = (edgeLengthM - distanceFromReverseStartM) / speedMps;
    vehicle.currentNodeId = fromBlockedNodeId;
    vehicle.routeNodeIds = routeNodeIds;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = retreatNodeId;
    vehicle.currentEdgeId = edge.id;
    vehicle.legMotionMode = 'cruise';
    vehicle.legTravelSec = round(edgeLengthM / speedMps);
    vehicle.legElapsedSec = round(distanceFromReverseStartM / speedMps);
    vehicle.legRemainingM = round(edgeLengthM - distanceFromReverseStartM);
    vehicle.targetSpeedMps = speedMps;
    vehicle.speedMps = 0;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.localRouteNodeIds = [];
    vehicle.localRouteReason = null;
    vehicle.yieldHoldUntilSec = holdAfterArrivalSec > 0
      ? round(this.simTimeSec + remainingReverseTravelSec + holdAfterArrivalSec)
      : null;
    vehicle.yieldHoldNodeId = holdAfterArrivalSec > 0 ? retreatNodeId : null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    const task = this.taskForVehicle(vehicle);
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, task?.loadId ?? null, fromBlockedNodeId, routeNodeIds.at(-1) ?? retreatNodeId, reason, this.vehiclePosition(vehicle), {
      route: vehicle.routeNodeIds.join('>')
    });
  }

  private tryBreakAgentMinimalWaitCycle(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    const candidates = this.vehicles
      .filter((vehicle) => candidateIds.has(vehicle.id) && vehicle.state === 'waiting-blocked')
      .sort((left, right) =>
        Number(left.loaded) - Number(right.loaded) ||
        this.agentTurnPriority(left) - this.agentTurnPriority(right) ||
        right.id.localeCompare(left.id)
      );
    for (const vehicle of candidates) {
      if (this.insertPortalYieldPocket(vehicle)) {
        return true;
      }
    }
    return false;
  }

  private tryBreakPortalHoldCycle(candidateVehicleIds: string[]): boolean {
    const candidateIds = new Set(candidateVehicleIds);
    for (const vehicle of this.vehicles.filter((candidate) => candidateIds.has(candidate.id) && candidate.state === 'waiting-blocked')) {
      const reservation = this.blockingZoneHoldReservation(vehicle);
      if (!reservation) {
        continue;
      }
      const holder = this.vehicles.find((candidate) => candidate.id === reservation.vehicleId);
      if (!holder || !candidateIds.has(holder.id) || holder.state !== 'waiting-blocked') {
        continue;
      }
      const holderReservation = this.blockingZoneHoldReservation(holder);
      if (!holderReservation || holderReservation.vehicleId !== vehicle.id) {
        continue;
      }
      const yieldVehicle = vehicle.id.localeCompare(holder.id) > 0 ? vehicle : holder;
      if (this.insertPortalYieldPocket(yieldVehicle)) {
        return true;
      }
    }
    return false;
  }

  private blockingZoneHoldReservation(vehicle: MutableVehicle): Reservation | null {
    if (!vehicle.blockingReservationId) {
      return null;
    }
    const reservation = this.reservations.find((candidate) => candidate.id === vehicle.blockingReservationId) ?? null;
    return reservation?.reasonCode === 'zone-hold' ? reservation : null;
  }

  private agentMinimalYieldPocketNodeId(
    vehicle: MutableVehicle,
    currentNodeId: string,
    blockedNodeId: string | null = vehicle.targetNodeId
  ): string | null {
    const currentZones = new Set(this.zonesForNode(currentNodeId).map((zone) => zone.id));
    const candidate = this.neighbors(currentNodeId)
      .filter((neighbor) => neighbor.nodeId !== blockedNodeId)
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => {
        const node = this.scenario.layout.nodes.find((candidate) => candidate.id === neighbor.nodeId);
        return node?.type !== 'lift-blackbox';
      })
      .filter((neighbor) => !this.liftStorageTransferTargetLiftId(neighbor.nodeId))
      .filter((neighbor) => this.zonesForNode(neighbor.nodeId).every((zone) => !currentZones.has(zone.id)))
      .filter((neighbor) => !(vehicle.loaded && this.layoutNode(neighbor.nodeId)?.type === 'storage'))
      .filter((neighbor) => this.agentMinimalYieldFirstLegSafe(vehicle, currentNodeId, neighbor.nodeId))
      .sort((left, right) =>
        this.yieldPocketRank(vehicle, left.nodeId) - this.yieldPocketRank(vehicle, right.nodeId) ||
        left.lengthM - right.lengthM ||
        left.nodeId.localeCompare(right.nodeId)
      )[0];
    return candidate?.nodeId ?? null;
  }

  private agentMinimalYieldFirstLegSafe(vehicle: MutableVehicle, fromNodeId: string, toNodeId: string): boolean {
    const from = nodePosition(this.scenario, fromNodeId);
    const to = nodePosition(this.scenario, toNodeId);
    return this.predictedSweptFootprintOverlapVehicleId(vehicle, from.x, from.z, to.x, to.z) === null;
  }

  private insertPortalYieldPocket(vehicle: MutableVehicle): boolean {
    if (this.agentMinimalEnabled() && (vehicle.currentEdgeId !== null || vehicle.legRemainingM > 0)) {
      return false;
    }
    const currentNodeId = vehicle.currentNodeId;
    const candidateNodeId = this.agentMinimalEnabled()
      ? this.agentMinimalYieldPocketNodeId(vehicle, currentNodeId)
      : null;
    const candidate = candidateNodeId
      ? this.neighbors(currentNodeId).find((neighbor) => neighbor.nodeId === candidateNodeId) ?? null
      : this.neighbors(currentNodeId)
          .filter((neighbor) => neighbor.nodeId !== vehicle.targetNodeId)
          .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
          .filter((neighbor) => {
            const node = this.scenario.layout.nodes.find((candidateNode) => candidateNode.id === neighbor.nodeId);
            return node?.type !== 'lift-blackbox';
          })
          .filter((neighbor) => !this.liftStorageTransferTargetLiftId(neighbor.nodeId))
          .filter((neighbor) => this.zonesForNode(neighbor.nodeId).every((zone) => !this.zonesForNode(currentNodeId).some((currentZone) => currentZone.id === zone.id)))
          .filter((neighbor) => !(vehicle.loaded && this.layoutNode(neighbor.nodeId)?.type === 'storage'))
          .sort((left, right) =>
            this.yieldPocketRank(vehicle, left.nodeId) - this.yieldPocketRank(vehicle, right.nodeId) ||
            left.lengthM - right.lengthM ||
            left.nodeId.localeCompare(right.nodeId)
          )[0] ?? null;
    if (!candidate || !this.traffic.findEdge(candidate.nodeId, currentNodeId)) {
      return false;
    }

    const route = this.agentMinimalEnabled()
      ? [currentNodeId, candidate.nodeId]
      : [
          ...vehicle.routeNodeIds.slice(0, vehicle.routeIndex + 1),
          candidate.nodeId,
          currentNodeId,
          ...vehicle.routeNodeIds.slice(vehicle.routeIndex + 1)
        ];
    vehicle.routeNodeIds = route;
    if (this.agentMinimalEnabled()) {
      vehicle.routeIndex = 0;
      vehicle.yieldHoldUntilSec = round(this.simTimeSec + 5);
      vehicle.yieldHoldNodeId = null;
    }
    vehicle.targetNodeId = route[vehicle.routeIndex + 1] ?? null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.state = 'assigned';
    const task = this.taskById(vehicle.taskId);
    if (task && !this.agentMinimalEnabled()) {
      task.replanCount += 1;
    }
    this.replanCount += 1;
    const reason = this.agentMinimalEnabled() ? 'local-yield-pocket' : 'portal-hold-yield-pocket';
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, null, currentNodeId, vehicle.targetNodeId, reason, this.vehiclePosition(vehicle), {
      route: route.join('>')
    });
    return true;
  }

  private blockingVehicleForReservation(reservationId: string | null): string | null {
    if (!reservationId) {
      return null;
    }
    return this.reservations.find((reservation) => reservation.id === reservationId)?.vehicleId ?? null;
  }

  private liftPortNodes(): Array<{ nodeId: string; kind: 'inbound' | 'outbound' }> {
    return this.scenario.layout.nodes
      .map((node) => ({ nodeId: node.id, kind: liftKindForNode(node) }))
      .filter((port): port is { nodeId: string; kind: LiftKind } => port.kind !== null)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  private updateLiftPortUtilization(dtSec: number): void {
    for (const port of this.liftPortNodes()) {
      if (this.isLiftPortCycleActive(port.kind, port.nodeId)) {
        this.liftPortBusyTimeSec.set(port.nodeId, round((this.liftPortBusyTimeSec.get(port.nodeId) ?? 0) + dtSec));
      }
    }
  }

  private recordLiftPortCompletion(task: TaskStateRecord): void {
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return;
    }
    const previous = this.completedByLiftPort.get(liftNodeId);
    this.completedByLiftPort.set(liftNodeId, {
      kind: task.kind,
      completed: (previous?.completed ?? 0) + 1
    });
  }

  private liftPortPphByNodeId(): Record<string, { kind: LiftKind; completed: number; pph: number }> {
    const elapsedHours = Math.max(this.simTimeSec / 3600, 1e-9);
    return Object.fromEntries(this.liftPortNodes().map((port) => {
      const completion = this.completedByLiftPort.get(port.nodeId);
      const completed = completion?.completed ?? 0;
      return [port.nodeId, {
        kind: port.kind,
        completed,
        pph: round(completed / elapsedHours, 3)
      }];
    }));
  }

  private liftPortDiagnostics(): ShuttleSimState['traffic']['liftPorts'] {
    const liftPphByNodeId = this.liftPortPphByNodeId();
    return this.liftPortNodes().map((port) => {
      const liftPph = liftPphByNodeId[port.nodeId] ?? { kind: port.kind, completed: 0, pph: 0 };
      const waitingTaskIds = this.queuedTasks()
        .filter((task) => task.kind === port.kind && this.taskLiftPortNodeId(task) === port.nodeId)
        .map((task) => task.id)
        .sort();
      const activeVehicle = this.vehicles
        .filter((vehicle) =>
          ((port.kind === 'inbound' && vehicle.state === 'lifting') || (port.kind === 'outbound' && vehicle.state === 'lowering')) &&
          this.vehicleTaskLiftPortNodeId(vehicle) === port.nodeId
        )
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      return {
        nodeId: port.nodeId,
        kind: port.kind,
        queueLength: waitingTaskIds.length,
        waitingTaskIds,
        activeTaskId: activeVehicle?.taskId ?? null,
        approachOccupancy: this.liftPortApproachCount(port.kind, port.nodeId),
        approachCapacity: this.liftPortApproachCapacity(),
        sourceBufferOccupancy: port.kind === 'inbound' ? this.inboundLiftWaitingSourceLoads(port.nodeId).length : 0,
        sourceBufferCapacity: port.kind === 'inbound' ? this.inboundSourceBufferCapacity(port.nodeId) : 1,
        completedTasks: liftPph.completed,
        pph: liftPph.pph,
        utilization: round((this.liftPortBusyTimeSec.get(port.nodeId) ?? 0) / Math.max(this.simTimeSec, 1), 4)
      };
    });
  }

  private vehiclePosition(vehicle: MutableVehicle): { x: number; y: number; z: number } {
    return { x: vehicle.x, y: vehicle.y, z: vehicle.z };
  }

  private vehicleRouteDiagnostics(vehicle: MutableVehicle): Pick<VehicleState, 'plannedGoalNodeId' | 'plannedRouteNodeIds' | 'localRouteNodeIds' | 'localRouteReason'> {
    const activeRoute = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
    if (!this.agentSimpleEnabled()) {
      return {
        plannedGoalNodeId: activeRoute.at(-1) ?? null,
        plannedRouteNodeIds: activeRoute,
        localRouteNodeIds: [],
        localRouteReason: null
      };
    }

    const task = this.taskForVehicle(vehicle);
    const goalNodeId = this.agentGoalNodeId(vehicle, task);
    if (!goalNodeId || (goalNodeId === vehicle.currentNodeId && vehicle.currentEdgeId === null && activeRoute.length < 2)) {
      return {
        plannedGoalNodeId: goalNodeId,
        plannedRouteNodeIds: goalNodeId ? [vehicle.currentNodeId] : [],
        localRouteNodeIds: [],
        localRouteReason: null
      };
    }

    if (this.agentRefreshEnabled()) {
      const plannedFromState = vehicle.plannedGoalNodeId === goalNodeId && vehicle.plannedRouteNodeIds.length >= 1
        ? vehicle.plannedRouteNodeIds
        : [];
      let plannedRouteNodeIds = this.remainingRefreshPlannedRoute(vehicle, plannedFromState);
      if (plannedRouteNodeIds.length < 2 && vehicle.currentNodeId !== goalNodeId) {
        try {
          plannedRouteNodeIds = this.agentRefreshNominalRouteToGoal(vehicle, task, goalNodeId);
        } catch {
          plannedRouteNodeIds = activeRoute.length >= 2 ? activeRoute : [vehicle.currentNodeId];
        }
      }
      const activeRouteDiffers = activeRoute.length >= 2 && activeRoute.join('>') !== plannedRouteNodeIds.join('>');
      const localRouteIndex = vehicle.localRouteNodeIds.indexOf(vehicle.currentNodeId);
      const explicitLocalRouteNodeIds = localRouteIndex >= 0
        ? vehicle.localRouteNodeIds.slice(localRouteIndex)
        : [];
      const localRouteNodeIds = explicitLocalRouteNodeIds.length >= 2 ? explicitLocalRouteNodeIds : [];
      const visiblePlannedRouteNodeIds = activeRouteDiffers && activeRoute.at(-1) === goalNodeId
        ? activeRoute
        : plannedRouteNodeIds;
      return {
        plannedGoalNodeId: goalNodeId,
        plannedRouteNodeIds: visiblePlannedRouteNodeIds,
        localRouteNodeIds,
        localRouteReason: localRouteNodeIds.length === 0 ? null : vehicle.localRouteReason ?? 'temporary-yield'
      };
    }

    if (this.agentMinimalEnabled() && activeRoute.length >= 2 && activeRoute.at(-1) === goalNodeId) {
      return {
        plannedGoalNodeId: goalNodeId,
        plannedRouteNodeIds: activeRoute,
        localRouteNodeIds: [],
        localRouteReason: null
      };
    }

    let plannedRouteNodeIds: string[] = [];
    try {
      plannedRouteNodeIds = this.agentNominalRouteToGoal(vehicle, task, goalNodeId);
    } catch {
      plannedRouteNodeIds = [vehicle.currentNodeId, goalNodeId];
    }

    const activeRouteKey = activeRoute.join('>');
    const plannedRouteKey = plannedRouteNodeIds.join('>');
    const localRouteNodeIds = activeRoute.length >= 2 && activeRouteKey !== plannedRouteKey
      ? activeRoute
      : [];
    const localRouteReason = localRouteNodeIds.length === 0
      ? null
      : localRouteNodeIds.at(-1) === goalNodeId
        ? 'temporary-reroute'
        : 'temporary-yield';

    return {
      plannedGoalNodeId: goalNodeId,
      plannedRouteNodeIds,
      localRouteNodeIds,
      localRouteReason
    };
  }

  private remainingRefreshPlannedRoute(vehicle: MutableVehicle, routeNodeIds: string[]): string[] {
    if (routeNodeIds.length === 0) {
      return [];
    }
    const currentIndex = routeNodeIds.indexOf(vehicle.currentNodeId);
    if (currentIndex >= 0) {
      return routeNodeIds.slice(currentIndex);
    }
    return [];
  }

  private publicVehicle(vehicle: MutableVehicle): VehicleState {
    const routeDiagnostics = this.vehicleRouteDiagnostics(vehicle);
    return {
      id: vehicle.id,
      state: vehicle.state,
      x: round(vehicle.x),
      y: round(vehicle.y),
      z: round(vehicle.z),
      yaw: round(vehicle.yaw),
      speedMps: round(vehicle.speedMps),
      loaded: vehicle.loaded,
      taskId: vehicle.taskId,
      targetNodeId: vehicle.targetNodeId,
      currentNodeId: vehicle.currentNodeId,
      currentEdgeId: vehicle.currentEdgeId,
      routeNodeIds: [...vehicle.routeNodeIds],
      ...routeDiagnostics,
      routeIndex: vehicle.routeIndex,
      legRemainingM: round(vehicle.legRemainingM),
      legElapsedSec: round(vehicle.legElapsedSec),
      legTravelSec: round(vehicle.legTravelSec),
      phaseRemainingSec: round(vehicle.phaseRemainingSec),
      waitReason: vehicle.waitReason,
      blockingReservationId: vehicle.blockingReservationId,
      blockingVehicleId: vehicle.blockingVehicleId,
      blockedTimeSec: round(vehicle.blockedTimeSec),
      idleTimeSec: round(vehicle.idleTimeSec),
      busyTimeSec: round(vehicle.busyTimeSec)
    };
  }

  private calculateTrafficDiagnostics(): ShuttleSimState['traffic'] {
    const waitingVehicles = this.vehicles
      .filter((vehicle) => vehicle.state === 'waiting-blocked')
      .map((vehicle) => ({
        vehicleId: vehicle.id,
        currentNodeId: vehicle.currentNodeId,
        targetNodeId: vehicle.targetNodeId,
        waitReason: vehicle.waitReason,
        blockedTimeSec: round(vehicle.blockedTimeSec),
        waitingSinceSec: vehicle.waitingSinceSec,
        blockingReservationId: vehicle.blockingReservationId,
        blockingVehicleId: vehicle.blockingVehicleId
      }));
    const deadlockCandidateVehicleIds = this.deadlockCandidateVehicleIds();
    let minVehicleSeparationM: number | null = null;
    let physicalViolationCount = 0;
    for (const vehicle of this.vehicles) {
      if (![vehicle.x, vehicle.y, vehicle.z, vehicle.yaw, vehicle.speedMps].every(Number.isFinite)) {
        physicalViolationCount += 1;
      }
      const edge = vehicle.currentEdgeId ? this.scenario.layout.edges.find((candidate) => candidate.id === vehicle.currentEdgeId) : null;
      const speedLimitMps = edge
        ? this.speedForEdge(vehicle, edge)
        : vehicle.loaded
          ? this.scenario.physicsParams.loadedSpeedMps
          : this.scenario.physicsParams.emptySpeedMps;
      if (vehicle.speedMps > speedLimitMps + 1e-6) {
        physicalViolationCount += 1;
      }
    }

    for (let leftIndex = 0; leftIndex < this.vehicles.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < this.vehicles.length; rightIndex += 1) {
        const left = this.vehicles[leftIndex]!;
        const right = this.vehicles[rightIndex]!;
        const separationM = Math.hypot(left.x - right.x, left.z - right.z);
        minVehicleSeparationM = minVehicleSeparationM === null ? separationM : Math.min(minVehicleSeparationM, separationM);
        if (vehicleFootprintsOverlap(left, right, this.scenario.vehicles)) {
          physicalViolationCount += 1;
        }
      }
    }

    return {
      trafficMode: this.agentRefreshEnabled() ? 'agent-refresh' : this.agentMinimalEnabled() ? 'agent-minimal' : this.agentSimpleEnabled() ? 'agent-simple' : 'flow-debug',
      safetyValidated: false,
      collisionAvoidanceEnabled: this.collisionAvoidanceEnabled(),
      longHorizonReservationEnabled: false,
      clearThroughLookaheadEnabled: !this.agentSimpleEnabled(),
      clearThroughMaxLookaheadLegs: this.agentSimpleEnabled() ? 0 : MAX_CLEAR_THROUGH_HORIZON_LEGS,
      activeFutureGrantCount: this.reservations.filter((reservation) => reservation.startTimeSec > this.simTimeSec + 1e-6).length,
      legacyZoneHoldEnabled: false,
      activeReservationCount: this.reservations.length,
      waitingVehicles,
      conflictSessions: this.activeConflictSessions(),
      liftPorts: this.liftPortDiagnostics(),
      deadlockCandidateVehicleIds,
      minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
      maxObservedSpeedMps: round(Math.max(0, ...this.vehicles.map((vehicle) => vehicle.speedMps))),
      physicalViolationCount
    };
  }

  private calculateKpis(): KpiSnapshot {
    const elapsedHours = Math.max(this.simTimeSec / 3600, 1e-9);
    const inboundPph = round(this.completedInbound / elapsedHours, 3);
    const outboundPph = round(this.completedOutbound / elapsedHours, 3);
    const activeTasks = this.activeTasks().filter((task) => task.state === 'assigned' || task.state === 'in-progress').length;
    const queuedTasks = this.queuedTasks().length;
    const vehicleUtilization = Object.fromEntries(
      this.vehicles.map((vehicle) => [vehicle.id, round(vehicle.busyTimeSec / Math.max(this.simTimeSec, 1), 4)])
    );
    const vehicleUtilizationBreakdown = Object.fromEntries(
      this.vehicles.map((vehicle) => {
        const elapsedSec = Math.max(this.simTimeSec, 1);
        const tasklessTravelSec = Math.min(vehicle.tasklessTravelTimeSec, vehicle.movingTimeSec);
        const productiveSec = Math.max(0, vehicle.movingTimeSec - tasklessTravelSec) + vehicle.handlingTimeSec;
        return [vehicle.id, {
          busy: round(vehicle.busyTimeSec / elapsedSec, 4),
          productive: round(productiveSec / elapsedSec, 4),
          moving: round(vehicle.movingTimeSec / elapsedSec, 4),
          handling: round(vehicle.handlingTimeSec / elapsedSec, 4),
          waiting: round(vehicle.blockedTimeSec / elapsedSec, 4),
          idle: round(vehicle.idleTimeSec / elapsedSec, 4),
          tasklessTravel: round(tasklessTravelSec / elapsedSec, 4)
        }];
      })
    );
    const blockedTimeByReasonSec = Object.fromEntries([...this.blockedTimeByReasonSec.entries()].sort(([left], [right]) => left.localeCompare(right)));

    return {
      inboundPph,
      outboundPph,
      totalPph: round((this.completedInbound + this.completedOutbound) / elapsedHours, 3),
      completedInbound: this.completedInbound,
      completedOutbound: this.completedOutbound,
      activeTasks,
      queuedTasks,
      averageTaskCycleSec: round(this.completedTaskCycleTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.completedTaskCycleTimes.length)),
      p95TaskCycleSec: round(percentile(this.completedTaskCycleTimes, 95)),
      averageTaskWaitSec: round(this.completedTaskWaitTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.completedTaskWaitTimes.length)),
      vehicleUtilization,
      vehicleUtilizationBreakdown,
      liftPph: this.liftPortPphByNodeId(),
      blockedTimeByReasonSec,
      reservationConflictCount: this.reservationConflictCount,
      replanCount: this.replanCount,
      deadlockCount: this.deadlockCount,
      livelockCount: this.livelockCount,
      eventLogHash: hashEventLog(this.eventLog),
      theoreticalCapacity: this.calculateTheoreticalCapacity(inboundPph, vehicleUtilization)
    };
  }

  private logEvent(
    eventType: string,
    vehicleId: string | null,
    taskId: string | null,
    loadId: string | null,
    fromNodeId: string | null,
    toNodeId: string | null,
    reason: string | null,
    position: { x: number; y: number; z: number } | null,
    details: Record<string, string | number | boolean | null>
  ): void {
    const entry = EventLogEntrySchema.parse({
      sequence: this.eventSequence,
      timeSec: round(this.simTimeSec),
      eventType,
      vehicleId,
      taskId,
      loadId,
      fromNodeId,
      toNodeId,
      reason,
      position,
      details
    });
    this.eventSequence += 1;
    this.eventLog.push(entry);
    this.recentEvents.push(entry);
    if (this.recentEvents.length > DEFAULT_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(-DEFAULT_RECENT_EVENTS);
    }
  }
}

export type FixedStepRunManifestV1 = {
  schemaVersion: 'shuttle.fixedStepRunManifest.v1';
  scenarioId: string;
  scenarioHash: string;
  seed: number;
  commitSha: string;
  stepSec: number;
  durationSec: number;
  finalSimTimeSec: number;
  finalTickIndex: number;
  status: RuntimeStatus;
  eventLogHash: string;
  stateHash: string;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  inboundPph: number;
  deadlocks: number;
  livelocks: number;
  physicalViolations: number;
};

export type FixedStepRunResult = {
  manifest: FixedStepRunManifestV1;
  state: ShuttleSimState;
  snapshot: ShuttleEngineSnapshotV1;
  eventLog: EventLogEntry[];
};

export function runFixedStep(options: {
  scenario?: ShuttleScenario;
  durationSec?: number;
  stepSec?: number;
  commitSha?: string;
} = {}): FixedStepRunResult {
  const inputScenario = options.scenario ?? createDefaultShuttleScenario();
  const stepSec = Math.max(0.001, options.stepSec ?? inputScenario.timeStepSec);
  const durationSec = Math.max(0, options.durationSec ?? inputScenario.durationSec);
  const scenario = ShuttleScenarioSchema.parse({
    ...inputScenario,
    durationSec,
    timeStepSec: stepSec
  });
  const sim = new ShuttleSimCore(scenario);
  sim.start();
  while (sim.getClock().simTimeSec < durationSec - 1e-9 && sim.getClock().status === 'running') {
    sim.step(Math.min(stepSec, durationSec - sim.getClock().simTimeSec));
  }
  const state = sim.getState();
  const snapshot = sim.createSnapshot();
  const eventLog = sim.getEventLog();
  return {
    manifest: {
      schemaVersion: 'shuttle.fixedStepRunManifest.v1',
      scenarioId: scenario.id,
      scenarioHash: hashScenario(scenario),
      seed: scenario.seed,
      commitSha: options.commitSha ?? 'unknown',
      stepSec,
      durationSec,
      finalSimTimeSec: state.simTimeSec,
      finalTickIndex: snapshot.tickIndex,
      status: state.status,
      eventLogHash: snapshot.eventLogHash,
      stateHash: hashDeterministicReplayState(snapshot),
      completedInbound: state.kpis.completedInbound,
      completedOutbound: state.kpis.completedOutbound,
      totalPph: state.kpis.totalPph,
      inboundPph: state.kpis.inboundPph,
      deadlocks: state.kpis.deadlockCount,
      livelocks: state.kpis.livelockCount,
      physicalViolations: state.traffic.physicalViolationCount
    },
    state,
    snapshot,
    eventLog
  };
}

function getByPointer(root: Record<string, unknown>, pointer: string): unknown {
  const parts = pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function setByPointer(root: Record<string, unknown>, pointer: string, value: unknown): { accepted: boolean; previousValue?: unknown; reason?: string } {
  const parts = pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.length === 0) {
    return { accepted: false, reason: 'Root replacement is not supported' };
  }

  let cursor: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object') {
      return { accepted: false, reason: `Path segment ${part} is not an object` };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (!cursor || typeof cursor !== 'object') {
    return { accepted: false, reason: 'Target parent is not an object' };
  }

  const key = parts[parts.length - 1]!;
  const parent = cursor as Record<string, unknown>;
  const previousValue = parent[key];
  parent[key] = value;
  return { accepted: true, previousValue };
}
