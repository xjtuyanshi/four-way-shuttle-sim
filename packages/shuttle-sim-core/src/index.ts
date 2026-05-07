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

type MutableVehicle = VehicleState & {
  targetSpeedMps: number;
  waitingSinceSec: number | null;
  lastMovementAxis: 'x' | 'z' | null;
  directionSwitchReadyNodeId: string | null;
  legMotionMode: 'profile' | 'cruise';
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

export type ShuttleSimDebugState = {
  currentNodeOccupancy: Array<{ nodeId: string; vehicleId: string }>;
  storageNodeOccupancy: Array<{ nodeId: string; loadId: string }>;
};

type Rng = {
  next: () => number;
};

const SHUTTLE_Y_M = 0.08;
const DEFAULT_RECENT_EVENTS = 80;
const MAX_RESERVATION_HORIZON_LEGS = 8;

function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0x100000000;
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function nodePosition(scenario: ShuttleScenario, nodeId: string): { x: number; y: number; z: number } {
  const node = scenario.layout.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Unknown node ${nodeId}`);
  }
  return { x: node.x, y: node.y, z: node.z };
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

function createDefaultLayout(profile: ShuttleLayoutGeometryProfile = DEFAULT_SHUTTLE_LAYOUT_PROFILE): ShuttleScenario['layout'] {
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

  [
    { id: 'inbound-lift-top-01', liftKind: 'inbound' as const, x: liftPortalXs[0]!, z: topLiftZ },
    { id: 'outbound-lift-top-01', liftKind: 'outbound' as const, x: liftPortalXs[1]!, z: topLiftZ },
    { id: 'inbound-lift-top-02', liftKind: 'inbound' as const, x: liftPortalXs[2]!, z: topLiftZ },
    { id: 'outbound-lift-top-02', liftKind: 'outbound' as const, x: liftPortalXs[3]!, z: topLiftZ },
    { id: 'outbound-lift-bottom-01', liftKind: 'outbound' as const, x: liftPortalXs[0]!, z: bottomLiftZ },
    { id: 'inbound-lift-bottom-01', liftKind: 'inbound' as const, x: liftPortalXs[1]!, z: bottomLiftZ },
    { id: 'outbound-lift-bottom-02', liftKind: 'outbound' as const, x: liftPortalXs[2]!, z: bottomLiftZ },
    { id: 'inbound-lift-bottom-02', liftKind: 'inbound' as const, x: liftPortalXs[3]!, z: bottomLiftZ }
  ].forEach((lift) => {
    nodes.push({ id: lift.id, type: 'lift-blackbox', liftKind: lift.liftKind, x: lift.x, y: 0, z: lift.z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] });
  });

  for (let rowIndex = 0; rowIndex < rowZs.length; rowIndex += 1) {
    const z = rowZs[rowIndex]!;
    const rowLabel = String(rowIndex + 1).padStart(2, '0');
    nodes.push(
      { id: `left-row-${rowLabel}`, type: 'intersection', x: leftSpineX, y: 0, z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
      { id: `right-row-${rowLabel}`, type: 'intersection', x: rightSpineX, y: 0, z, noStop: true, noParking: true, capacity: 1, allowedDirections: [] }
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

  [
    { id: 'inbound-lift-top-01', targets: [mainLaneNodeId('north', 1), mainLaneNodeId('south', 1)] },
    { id: 'outbound-lift-top-01', targets: [mainLaneNodeId('north', 2), mainLaneNodeId('south', 2)] },
    { id: 'inbound-lift-top-02', targets: [mainLaneNodeId('north', 3), mainLaneNodeId('south', 3)] },
    { id: 'outbound-lift-top-02', targets: [mainLaneNodeId('north', 4), mainLaneNodeId('south', 4)] },
    { id: 'outbound-lift-bottom-01', targets: [mainLaneNodeId('north', 1), mainLaneNodeId('south', 1)] },
    { id: 'inbound-lift-bottom-01', targets: [mainLaneNodeId('north', 2), mainLaneNodeId('south', 2)] },
    { id: 'outbound-lift-bottom-02', targets: [mainLaneNodeId('north', 3), mainLaneNodeId('south', 3)] },
    { id: 'inbound-lift-bottom-02', targets: [mainLaneNodeId('north', 4), mainLaneNodeId('south', 4)] }
  ].forEach((connector) => {
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

  const zones: LayoutZone[] = [
    ...liftStorageCrossingZones,
    ...liftMainCrossingZones,
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
    layout: createDefaultLayout(layoutProfile),
    taskGeneration: {
      inboundRatePerHour: 18,
      outboundRatePerHour: 18,
      inboundOutboundMix: 0.5,
      arrivalDistribution: 'deterministic',
      maxTasks: 40
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
      edgeCapacity: 1,
      nodeCapacity: 1,
      zoneCapacity: 1,
      minimumClearanceSec: 0.4,
      priorityAgingSec: 20,
      deadlockDetectSec: 15,
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

export function summarizeScenarioStaticSceneContract(scenario: ShuttleScenario = createDefaultShuttleScenario()): ShuttleStaticSceneContract {
  return summarizeStaticSceneContract(scenario);
}

export type VerticalStorageFootprintEdgeViolation = {
  edgeId: string;
  cellId: string;
};

export function verticalStorageFootprintEdgeViolations(scenario: ShuttleScenario): VerticalStorageFootprintEdgeViolation[] {
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

class TrafficReservationController {
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
  }): ReservationAttempt {
    const edge = this.findEdge(options.fromNodeId, options.toNodeId);
    if (!edge) {
      return { ok: false, reasonCode: 'route-edge-missing', blockingReservationId: null };
    }

    const endTimeSec = options.startTimeSec + options.travelSec + this.scenario.trafficPolicy.minimumClearanceSec;
    const nodeZonesForEdge = (nodeId: string) =>
      this.scenario.layout.zones.filter(
        (candidate) =>
          candidate.nodeIds.includes(nodeId) &&
          (candidate.edgeIds.length === 0 || candidate.edgeIds.includes(edge.id))
      );
    const currentNodeZones = nodeZonesForEdge(options.fromNodeId);
    const targetNodeZones = nodeZonesForEdge(options.toNodeId);
    const matchingZones = [
      ...this.scenario.layout.zones.filter((candidate) => candidate.edgeIds.includes(edge.id)),
      ...currentNodeZones,
      ...targetNodeZones
    ].filter((zone, index, zones) => zones.findIndex((candidate) => candidate.id === zone.id) === index);
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
          endTimeSec,
          priority: options.priority
        })
      );
    }

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

    return { ok: true, reservations: candidates.map((reservation) => ReservationSchema.parse(reservation)) };
  }

  findEdge(fromNodeId: string, toNodeId: string): ShuttleScenario['layout']['edges'][number] | null {
    return this.scenario.layout.edges.find((edge) => {
      if (edge.from === fromNodeId && edge.to === toNodeId) {
        return true;
      }
      return edge.directionMode === 'twoWay' && edge.from === toNodeId && edge.to === fromNodeId;
    }) ?? null;
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
      existing.resourceType === candidate.resourceType;
    if (!sameResource && !sameConflictGroup) {
      return false;
    }

    return candidate.startTimeSec <= existing.endTimeSec + 1e-6 && existing.startTimeSec <= candidate.endTimeSec + 1e-6;
  }
}

export class ShuttleSimCore {
  private scenario: ShuttleScenario;
  private readonly sessionId = randomUUID();
  private traffic: TrafficReservationController;
  private rng: Rng;
  private status: RuntimeStatus = 'idle';
  private simTimeSec = 0;
  private vehicles: MutableVehicle[] = [];
  private tasks: TaskStateRecord[] = [];
  private loads: LoadStateRecord[] = [];
  private reservations: Reservation[] = [];
  private currentNodeOccupancy = new Map<string, string>();
  private eventLog: EventLogEntry[] = [];
  private recentEvents: EventLogEntry[] = [];
  private eventSequence = 0;
  private taskSequence = 0;
  private nextInboundSec = 0;
  private nextOutboundSec = 0;
  private completedTaskCycleTimes: number[] = [];
  private completedTaskWaitTimes: number[] = [];
  private completedInbound = 0;
  private completedOutbound = 0;
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
  private error: string | null = null;

  constructor(scenario: ShuttleScenario = createDefaultShuttleScenario()) {
    this.scenario = ShuttleScenarioSchema.parse(scenario);
    assertNoVerticalStorageFootprintEdges(this.scenario);
    this.traffic = new TrafficReservationController(this.scenario);
    this.rng = makeRng(this.scenario.seed);
    this.rebuildGraphNeighbors();
    this.reset(this.scenario.seed);
  }

  getScenario(): ShuttleScenario {
    return structuredClone(this.scenario);
  }

  loadScenario(scenario: ShuttleScenario): ShuttleSimState {
    this.scenario = ShuttleScenarioSchema.parse(scenario);
    assertNoVerticalStorageFootprintEdges(this.scenario);
    this.traffic = new TrafficReservationController(this.scenario);
    this.rng = makeRng(this.scenario.seed);
    this.rebuildGraphNeighbors();
    this.reset(this.scenario.seed);
    this.logEvent('scenario-loaded', null, null, null, null, null, 'loadScenario', null, { scenarioId: this.scenario.id });
    return this.getState();
  }

  reset(seed = this.scenario.seed): ShuttleSimState {
    this.status = 'idle';
    this.simTimeSec = 0;
    this.tasks = [];
    this.loads = [];
    this.reservations = [];
    this.currentNodeOccupancy = new Map();
    this.eventLog = [];
    this.recentEvents = [];
    this.eventSequence = 0;
    this.taskSequence = 0;
    this.completedTaskCycleTimes = [];
    this.completedTaskWaitTimes = [];
    this.completedInbound = 0;
    this.completedOutbound = 0;
    this.reservationConflictCount = 0;
    this.replanCount = 0;
    this.deadlockCount = 0;
    this.livelockCount = 0;
    this.deadlockCandidateSignature = null;
    this.deadlockCandidateSinceSec = null;
    this.blockedTimeByReasonSec = new Map();
    this.deferredTaskReasons = { inbound: null, outbound: null };
    this.liftPortBusyTimeSec = new Map();
    this.error = null;
    this.rng = makeRng(seed);
    this.scenario = { ...this.scenario, seed };
    this.traffic = new TrafficReservationController(this.scenario);
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
        legMotionMode: 'profile'
      };
    });
    for (const vehicle of this.vehicles) {
      if (!this.currentNodeOccupancy.has(vehicle.currentNodeId)) {
        this.currentNodeOccupancy.set(vehicle.currentNodeId, vehicle.id);
      }
    }

    this.logEvent('sim-reset', null, null, null, null, null, 'reset', null, { seed });
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
    if (path.startsWith('/layout')) {
      this.rebuildGraphNeighbors();
    }
    this.logEvent('param-updated', null, null, null, null, null, 'setParam', null, { path, value: String(value) });

    if (path === '/vehicles/count') {
      this.reset(this.scenario.seed);
    }

    return {
      accepted: true,
      path,
      previousValue: result.previousValue ?? getByPointer(previousScenario as unknown as Record<string, unknown>, path),
      value
    };
  }

  step(dtSec = this.scenario.timeStepSec): ShuttleSimState {
    if (this.status === 'idle') {
      this.status = 'running';
    }

    if (this.status !== 'running') {
      return this.getState();
    }

    if (this.simTimeSec >= this.scenario.durationSec) {
      this.status = 'completed';
      this.logEvent('sim-completed', null, null, null, null, null, 'duration-reached', null, {});
      return this.getState();
    }

    const stepSec = Math.min(dtSec, this.scenario.durationSec - this.simTimeSec);
    this.simTimeSec = round(this.simTimeSec + stepSec);
    this.reservations = this.reservations.filter((reservation) => reservation.endTimeSec >= this.simTimeSec - 1);

    this.generateDueTasks(stepSec);
    this.assignQueuedTasks(stepSec);
    this.advanceVehicles(stepSec);
    this.updateLiftPortUtilization(stepSec);
    this.updateDeadlockSmokeCounters();

    if (this.simTimeSec >= this.scenario.durationSec) {
      this.status = 'completed';
      this.logEvent('sim-completed', null, null, null, null, null, 'duration-reached', null, {});
    }

    return this.getState();
  }

  runToEnd(durationSec = this.scenario.durationSec): ShuttleSimState {
    if (durationSec !== this.scenario.durationSec) {
      this.scenario = { ...this.scenario, durationSec };
    }
    this.start();
    while (this.status === 'running') {
      this.step(this.scenario.timeStepSec);
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
    this.loads.push(LoadStateRecordSchema.parse(load));
    return this.getState();
  }

  addTaskForTest(task: TaskStateRecord): ShuttleSimState {
    this.tasks.push(TaskStateRecordSchema.parse(task));
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
    return this.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed').length;
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
    const storageSelection = kind === 'inbound' ? this.selectInboundStorageNode() : this.selectOutboundLoad();
    if (!storageSelection) {
      return { created: false, reason: kind === 'inbound' ? 'storage-full' : 'storage-empty' };
    }

    this.taskSequence += 1;
    const taskId = `task-${String(this.taskSequence).padStart(4, '0')}`;
    const generatedLoadId = `load-${String(this.taskSequence).padStart(4, '0')}`;
    const loadId = kind === 'inbound' ? generatedLoadId : storageSelection.loadId;
    const liftNodeId = this.selectLiftPortNodeId(kind, storageSelection.nodeId);
    const pickupNodeId = kind === 'inbound' ? liftNodeId : storageSelection.nodeId;
    const dropoffNodeId = kind === 'inbound' ? storageSelection.nodeId : liftNodeId;
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
    if (kind === 'inbound') {
      const load: LoadStateRecord = {
        id: loadId,
        state: 'waiting',
        nodeId: pickupNodeId,
        vehicleId: null,
        weightKg: 450 + Math.round(this.rng.next() * 350)
      };
      this.loads.push(load);
    }
    this.tasks.push(task);
    this.logEvent('task-created', null, task.id, loadId, null, pickupNodeId, 'task-generation', nodePosition(this.scenario, pickupNodeId), {
      kind,
      fifoNodeId: storageSelection.nodeId
    });
    return { created: true };
  }

  private selectLiftPortNodeId(kind: 'inbound' | 'outbound', relatedNodeId: string): string {
    const fallbackNodeId = this.scenario.layout.nodes.find((node) => node.type === kind)?.id ?? relatedNodeId;
    const relatedNode = this.scenario.layout.nodes.find((node) => node.id === relatedNodeId);
    const liftNodes = this.scenario.layout.nodes
      .filter((node) => liftKindForNode(node) === kind)
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
    const candidates = liftNodes.length > 0 ? liftNodes.map((node) => node.id) : [fallbackNodeId];
    return candidates[0]!;
  }

  private liftPortPlannedLoad(kind: 'inbound' | 'outbound', liftNodeId: string): number {
    return this.tasks.filter((task) =>
      task.kind === kind &&
      task.state !== 'completed' &&
      task.state !== 'failed' &&
      this.taskLiftPortNodeId(task) === liftNodeId
    ).length;
  }

  private taskLiftPortNodeId(task: TaskStateRecord): string | null {
    const candidateNodeId = task.kind === 'inbound' ? task.pickupNodeId : task.dropoffNodeId;
    return this.liftPortKindForNodeId(candidateNodeId) === task.kind ? candidateNodeId : null;
  }

  private liftPortKindForNodeId(nodeId: string): LiftKind | null {
    const node = this.scenario.layout.nodes.find((candidate) => candidate.id === nodeId);
    return node ? liftKindForNode(node) : null;
  }

  private isLiftPortCycleActive(kind: 'inbound' | 'outbound', liftNodeId: string): boolean {
    return this.vehicles.some((vehicle) =>
      vehicle.currentNodeId === liftNodeId &&
      ((kind === 'inbound' && vehicle.state === 'lifting') || (kind === 'outbound' && vehicle.state === 'lowering'))
    );
  }

  private liftPortApproachCapacity(): number {
    return 1;
  }

  private liftPortApproachCount(kind: 'inbound' | 'outbound', liftNodeId: string): number {
    return this.tasks.filter((task) =>
      task.kind === kind &&
      task.state !== 'queued' &&
      task.state !== 'completed' &&
      task.state !== 'failed' &&
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
      const load = this.loads.find((candidate) => candidate.id === task.loadId);
      return task.state === 'assigned' || (load?.state === 'waiting' && load.nodeId === liftNodeId);
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
    return kind ? { liftNodeId, kind } : null;
  }

  private liftIngressClaimingVehicleId(liftNodeId: string, vehicleId: string): string | null {
    for (const other of [...this.vehicles].sort((left, right) => left.id.localeCompare(right.id))) {
      if (other.id === vehicleId) {
        continue;
      }
      if (other.currentNodeId === liftNodeId || other.targetNodeId === liftNodeId) {
        return other.id;
      }
      const task = other.taskId ? this.tasks.find((candidate) => candidate.id === other.taskId) ?? null : null;
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
    if (otherApproachCount >= this.liftPortApproachCapacity()) {
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

  private closeOccupiedNextNode(vehicle: MutableVehicle, toNodeId: string): string | null {
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
    return this.scenario.layout.nodes.some((node) => node.id === nodeId && node.type === 'storage');
  }

  private storageLanes(): ShuttleScenario['layout']['nodes'][] {
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
    for (const load of this.loads) {
      if (load.nodeId && load.state === 'stored' && this.isStorageNode(load.nodeId)) {
        occupancy.set(load.nodeId, load.id);
      }
    }

    if (!includePendingInbound) {
      return occupancy;
    }

    for (const task of this.tasks) {
      if (
        task.kind === 'inbound' &&
        task.state !== 'completed' &&
        task.state !== 'failed' &&
        this.isStorageNode(task.dropoffNodeId)
      ) {
        occupancy.set(task.dropoffNodeId, task.loadId);
      }
    }

    return occupancy;
  }

  private selectInboundStorageNode(): { nodeId: string; loadId: string } | null {
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

  private activeStorageRowTaskCount(rowLabel: string): number {
    return this.tasks.filter((task) =>
      task.state !== 'completed' &&
      task.state !== 'failed' &&
      this.taskStorageRowLabel(task) === rowLabel
    ).length;
  }

  private selectOutboundLoad(): { nodeId: string; loadId: string } | null {
    const lanes = this.storageLanes();
    const assignedOutboundLoadIds = new Set(
      this.tasks
        .filter((task) => task.kind === 'outbound' && task.state !== 'completed' && task.state !== 'failed')
        .map((task) => task.loadId)
    );

    for (let offset = 0; offset < lanes.length; offset += 1) {
      const lane = lanes[(this.taskSequence + offset) % lanes.length]!;
      for (const node of lane) {
        const load = this.loads.find(
          (candidate) => candidate.state === 'stored' && candidate.nodeId === node.id && !assignedOutboundLoadIds.has(candidate.id)
        );
        if (load) {
          return { nodeId: node.id, loadId: load.id };
        }
      }
    }
    return null;
  }

  private assignQueuedTasks(dtSec: number): void {
    const idleVehicleIds = new Set(
      this.vehicles
        .filter((vehicle) => vehicle.state === 'idle')
        .map((vehicle) => vehicle.id)
    );

    for (const task of this.tasks.filter((candidate) => candidate.state === 'queued')) {
      const reason = this.taskAssignmentBlockReason(task);
      task.waitReason = reason;
      if (reason) {
        this.blockedTimeByReasonSec.set(reason, round((this.blockedTimeByReasonSec.get(reason) ?? 0) + dtSec));
        continue;
      }

      if (idleVehicleIds.size === 0) {
        return;
      }

      const assignment = this.bestIdleVehicleForTask(task, idleVehicleIds);
      if (!assignment) {
        task.waitReason = 'route-unavailable';
        this.blockedTimeByReasonSec.set('route-unavailable', round((this.blockedTimeByReasonSec.get('route-unavailable') ?? 0) + dtSec));
        continue;
      }

      this.assignTaskToVehicle(assignment.vehicle, task, assignment.route);
      idleVehicleIds.delete(assignment.vehicle.id);
    }
  }

  private bestIdleVehicleForTask(task: TaskStateRecord, idleVehicleIds: Set<string>): { vehicle: MutableVehicle; route: string[]; pickupDistanceM: number; totalDistanceM: number } | null {
    let bestAssignment: { vehicle: MutableVehicle; route: string[]; pickupDistanceM: number; totalDistanceM: number } | null = null;
    for (const vehicle of this.vehicles.filter((candidate) => idleVehicleIds.has(candidate.id))) {
      if (
        task.kind === 'inbound' &&
        this.scenario.taskGeneration.outboundRatePerHour > 0 &&
        this.isStorageNode(vehicle.currentNodeId)
      ) {
        continue;
      }
      try {
        const route = this.planRoute(vehicle.currentNodeId, task, this.parkingNodeFor(vehicle.id));
        const pickupDistanceM = this.routeDistanceM(route, task.pickupNodeId);
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

  private assignTaskToVehicle(vehicle: MutableVehicle, task: TaskStateRecord, route: string[]): void {
    vehicle.taskId = task.id;
    vehicle.routeNodeIds = route;
    vehicle.routeIndex = 0;
    vehicle.targetNodeId = route[1] ?? null;
    vehicle.state = 'assigned';
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.directionSwitchReadyNodeId = null;
    task.state = 'assigned';
    task.vehicleId = vehicle.id;
    task.assignedAtSec = this.simTimeSec;
    task.waitReason = null;
    this.logEvent('task-assigned', vehicle.id, task.id, task.loadId, vehicle.currentNodeId, task.pickupNodeId, 'nearest-available', this.vehiclePosition(vehicle), {
      route: route.join('>')
    });
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

  private taskAssignmentBlockReason(task: TaskStateRecord): string | null {
    return this.liftPortBlockReason(task) ?? this.fifoLaneBlockReason(task) ?? this.fifoNetworkBlockReason(task);
  }

  private tryInsertHeadOnYieldRoute(vehicle: MutableVehicle, targetNodeId: string, blockingVehicleId: string): boolean {
    const blocker = this.vehicles.find((candidate) => candidate.id === blockingVehicleId);
    if (!blocker || blocker.currentNodeId !== targetNodeId || blocker.targetNodeId !== vehicle.currentNodeId) {
      return false;
    }
    if (vehicle.id.localeCompare(blockingVehicleId) < 0) {
      return false;
    }
    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null : null;
    if (task && task.replanCount >= this.scenario.routingPolicy.maxReplansPerTask) {
      return false;
    }

    const fromNodeId = vehicle.currentNodeId;
    const currentRoutePrefix = vehicle.routeNodeIds.slice(0, vehicle.routeIndex + 1);
    const currentRouteSuffix = vehicle.routeNodeIds.slice(vehicle.routeIndex + 2);
    const candidates = this.neighbors(fromNodeId)
      .filter((neighbor) => neighbor.nodeId !== targetNodeId)
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => {
        const node = this.scenario.layout.nodes.find((candidate) => candidate.id === neighbor.nodeId);
        return node?.type !== 'lift-blackbox';
      })
      .sort((left, right) => left.lengthM - right.lengthM || left.nodeId.localeCompare(right.nodeId));

    let bestRoute: string[] | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const pocketRoute = this.traffic.findEdge(candidate.nodeId, fromNodeId) && this.traffic.findEdge(fromNodeId, targetNodeId)
        ? [...currentRoutePrefix, candidate.nodeId, fromNodeId, targetNodeId, ...currentRouteSuffix]
        : null;
      const blockedNodeIds = this.blockedStorageTransitNodeIds(candidate.nodeId, targetNodeId);
      blockedNodeIds.add(fromNodeId);
      try {
        const segment = this.shortestPath(candidate.nodeId, targetNodeId, blockedNodeIds);
        if (segment.includes(fromNodeId)) {
          if (!pocketRoute) {
            continue;
          }
          const distance = this.routeDistanceM(pocketRoute.slice(vehicle.routeIndex));
          if (distance < bestDistance) {
            bestRoute = pocketRoute;
            bestDistance = distance;
          }
          continue;
        }
        const detour = [...currentRoutePrefix, candidate.nodeId, ...segment.slice(1), ...currentRouteSuffix];
        const distance = this.routeDistanceM(detour.slice(vehicle.routeIndex));
        if (distance < bestDistance) {
          bestRoute = detour;
          bestDistance = distance;
        }
      } catch {
        if (!pocketRoute) {
          continue;
        }
        const distance = this.routeDistanceM(pocketRoute.slice(vehicle.routeIndex));
        if (distance < bestDistance) {
          bestRoute = pocketRoute;
          bestDistance = distance;
        }
      }
    }

    if (!bestRoute) {
      return false;
    }

    vehicle.routeNodeIds = bestRoute;
    vehicle.targetNodeId = bestRoute[vehicle.routeIndex + 1] ?? null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    this.replanCount += 1;
    if (task) {
      task.replanCount += 1;
    }
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, null, fromNodeId, vehicle.targetNodeId, 'head-on-yield-detour', this.vehiclePosition(vehicle), {
      blockingVehicleId,
      originalTargetNodeId: targetNodeId,
      route: bestRoute.join('>')
    });
    return true;
  }

  private liftPortBlockReason(task: TaskStateRecord): string | null {
    const liftNodeId = this.taskLiftPortNodeId(task);
    if (!liftNodeId) {
      return null;
    }
    const approachCount = this.liftPortApproachCount(task.kind, liftNodeId);
    return approachCount >= this.liftPortApproachCapacity() ? `${task.kind}-lift-approach-full:${liftNodeId}` : null;
  }

  private liftPortWaitReason(nodeId: string): string | null {
    const kind = this.liftPortKindForNodeId(nodeId);
    return kind ? `${kind}-lift-busy:${nodeId}` : null;
  }

  private reservationIsActive(reservation: Reservation): boolean {
    return reservation.startTimeSec <= this.simTimeSec + 1e-6 && this.simTimeSec <= reservation.endTimeSec + 1e-6;
  }

  private hasActiveSelfMoveAuthorization(vehicle: MutableVehicle, edgeId: string, targetNodeId: string): boolean {
    const hasEdgeReservation = this.reservations.some((reservation) =>
      reservation.vehicleId === vehicle.id &&
      reservation.resourceType === 'edge' &&
      reservation.resourceId === edgeId &&
      this.reservationIsActive(reservation)
    );
    const hasNodeReservation = this.reservations.some((reservation) =>
      reservation.vehicleId === vehicle.id &&
      reservation.resourceType === 'node' &&
      reservation.resourceId === targetNodeId &&
      this.reservationIsActive(reservation)
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
      const hasUnfinishedPredecessor = this.tasks.some((candidate) =>
        candidate.id !== task.id &&
        candidate.kind === task.kind &&
        candidate.state !== 'completed' &&
        candidate.state !== 'failed' &&
        this.taskStorageRowLabel(candidate) === rowLabel &&
        (this.taskStorageColumn(candidate) ?? Number.POSITIVE_INFINITY) < taskColumn
      );
      if (hasUnfinishedPredecessor) {
        return `fifo-predecessor-pending:${rowLabel}`;
      }
    }
    const hasActiveSameLaneTask = this.tasks.some((candidate) =>
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
    const hasActiveOutboundFifoTask = this.tasks.some((candidate) =>
      candidate.id !== task.id &&
      candidate.kind === 'outbound' &&
      (candidate.state === 'assigned' || candidate.state === 'in-progress')
    );
    return hasActiveOutboundFifoTask ? 'fifo-left-network-busy' : null;
  }

  private taskStorageRowLabel(task: TaskStateRecord): string | null {
    const storageNodeId = task.kind === 'inbound' ? task.dropoffNodeId : task.pickupNodeId;
    return this.nodeStorageRowLabel(storageNodeId);
  }

  private taskStorageColumn(task: TaskStateRecord): number | null {
    const storageNodeId = task.kind === 'inbound' ? task.dropoffNodeId : task.pickupNodeId;
    return this.storageGridPosition(storageNodeId)?.column ?? null;
  }

  private storageGridPosition(nodeId: string): { row: number; column: number } | null {
    const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
    return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
  }

  private nodeStorageRowLabel(nodeId: string): string | null {
    const storagePosition = this.storageGridPosition(nodeId);
    if (storagePosition) {
      return `r${String(storagePosition.row).padStart(2, '0')}`;
    }
    const sideMatch = /^(?:left|right)-row-(\d+)$/.exec(nodeId);
    if (sideMatch) {
      return `r${sideMatch[1]}`;
    }
    return null;
  }

  private planRoute(currentNodeId: string, task: TaskStateRecord, parkingNodeId: string): string[] {
    const route: string[] = [currentNodeId];
    const storageEntrySideNodeId = task.kind === 'inbound' ? this.storageSideNodeId(task.dropoffNodeId, 'right') : this.storageSideNodeId(task.pickupNodeId, 'left');
    const currentStorageExitNodeId = task.kind === 'inbound' && this.isStorageNode(currentNodeId)
      ? this.storageSideNodeId(currentNodeId, 'left') ?? this.nearestStorageSideNodeId(currentNodeId)
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

  private storageSideNodeId(storageNodeId: string, side: 'left' | 'right'): string | null {
    const match = /^storage-r(\d+)-c\d+$/.exec(storageNodeId);
    if (!match) {
      return null;
    }
    const sideNodeId = `${side}-row-${match[1]}`;
    return this.scenario.layout.nodes.some((node) => node.id === sideNodeId) ? sideNodeId : null;
  }

  private nearestStorageSideNodeId(storageNodeId: string): string | null {
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
    const storageNodeIds = new Set(this.scenario.layout.nodes.filter((node) => node.type === 'storage').map((node) => node.id));
    const allowedNodeIds = new Set([fromNodeId, targetNodeId]);
    const blockedNodeIds = new Set<string>();
    const fromRowLabel = this.nodeStorageRowLabel(fromNodeId);
    const targetRowLabel = this.nodeStorageRowLabel(targetNodeId);
    const fromIsStorage = this.isStorageNode(fromNodeId);
    const targetIsStorage = this.isStorageNode(targetNodeId);
    const allowStorageTransitRow = fromIsStorage && targetIsStorage
      ? (fromRowLabel === targetRowLabel ? fromRowLabel : null)
      : fromIsStorage
        ? fromRowLabel
        : targetIsStorage
          ? targetRowLabel
          : null;

    for (const nodeId of storageNodeIds) {
      if (!allowedNodeIds.has(nodeId) && this.nodeStorageRowLabel(nodeId) !== allowStorageTransitRow) {
        blockedNodeIds.add(nodeId);
      }
    }

    if (options.blockStoredLoads) {
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
      for (const neighbor of this.neighbors(current)) {
        if (blockedNodeIds.has(neighbor.nodeId)) {
          continue;
        }
        const tentative = (gScore.get(current) ?? Infinity) + neighbor.lengthM;
        if (tentative < (gScore.get(neighbor.nodeId) ?? Infinity)) {
          cameFrom.set(neighbor.nodeId, current);
          gScore.set(neighbor.nodeId, tentative);
          open.add(neighbor.nodeId);
        }
      }
    }

    throw new Error(`No route between ${fromNodeId} and ${toNodeId}`);
  }

  private neighbors(nodeId: string): Array<{ nodeId: string; lengthM: number }> {
    return this.neighborByNodeId.get(nodeId) ?? [];
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
      .sort((left, right) => left.id.localeCompare(right.id));
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
    return [...dedicatedParking, ...temporaryStorageParking];
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
    const zones = this.zonesForNode(nodeId);
    for (const zone of zones) {
      const existing = this.reservations.find(
        (reservation) =>
          reservation.reasonCode === 'zone-hold' &&
          reservation.resourceType === 'zone' &&
          reservation.resourceId === zone.id &&
          reservation.vehicleId === vehicle.id
      );
      if (existing) {
        existing.endTimeSec = Math.max(existing.endTimeSec, this.scenario.durationSec + 3600);
        continue;
      }
      this.reservations.push(ReservationSchema.parse({
        id: `hold-${vehicle.id}-${zone.id}-${Math.round(this.simTimeSec * 1000)}`,
        resourceType: 'zone',
        resourceId: zone.id,
        vehicleId: vehicle.id,
        taskId: vehicle.taskId,
        startTimeSec: round(this.simTimeSec),
        endTimeSec: this.scenario.durationSec + 3600,
        priority: this.priorityFor(vehicle),
        conflictGroup: zone.conflictGroup ?? null,
        reasonCode: 'zone-hold'
      }));
    }
  }

  private releaseZoneHoldReservations(vehicle: MutableVehicle): void {
    this.reservations = this.reservations.filter(
      (reservation) =>
        !(
          reservation.reasonCode === 'zone-hold' &&
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

  private advanceVehicles(dtSec: number): void {
    for (const vehicle of this.vehicles.sort((left, right) => left.id.localeCompare(right.id))) {
      if (vehicle.state === 'idle') {
        vehicle.idleTimeSec = round(vehicle.idleTimeSec + dtSec);
        continue;
      }
      vehicle.busyTimeSec = round(vehicle.busyTimeSec + dtSec);

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

  private advanceTimedPhase(vehicle: MutableVehicle, dtSec: number): void {
    vehicle.phaseRemainingSec = round(Math.max(0, vehicle.phaseRemainingSec - dtSec));
    vehicle.speedMps = 0;
    if (vehicle.phaseRemainingSec > 0) {
      return;
    }

    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null : null;
    if (vehicle.state === 'lifting' && task) {
      vehicle.loaded = true;
      const load = this.loads.find((candidate) => candidate.id === task.loadId);
      if (load) {
        load.state = 'carried';
        load.nodeId = null;
        load.vehicleId = vehicle.id;
      }
      vehicle.state = 'assigned';
      this.logEvent('lift-complete', vehicle.id, task.id, task.loadId, task.pickupNodeId, vehicle.currentNodeId, 'lift-time-elapsed', this.vehiclePosition(vehicle), {});
      return;
    }

    if (vehicle.state === 'lowering' && task) {
      vehicle.loaded = false;
      const load = this.loads.find((candidate) => candidate.id === task.loadId);
      if (load) {
        load.state = task.kind === 'inbound' ? 'stored' : 'delivered';
        load.nodeId = task.dropoffNodeId;
        load.vehicleId = null;
      }
      task.state = 'completed';
      task.completedAtSec = this.simTimeSec;
      this.completedTaskCycleTimes.push(task.completedAtSec - task.createdAtSec);
      this.completedTaskWaitTimes.push((task.assignedAtSec ?? task.createdAtSec) - task.createdAtSec);
      if (task.kind === 'inbound') this.completedInbound += 1;
      if (task.kind === 'outbound') this.completedOutbound += 1;
      this.logEvent('task-completed', vehicle.id, task.id, task.loadId, task.pickupNodeId, task.dropoffNodeId, 'lower-complete', this.vehiclePosition(vehicle), {
        kind: task.kind
      });
      vehicle.taskId = null;
      if (task.kind === 'inbound' && this.isStorageNode(vehicle.currentNodeId)) {
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

  private startNextLeg(vehicle: MutableVehicle, dtSec: number): void {
    const fromNodeId = vehicle.currentNodeId;
    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null : null;

    if (task && fromNodeId === task.pickupNodeId && !vehicle.loaded) {
      task.state = 'in-progress';
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
    if (currentOccupant && currentOccupant !== vehicle.id) {
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

    const closeNextOccupantId = this.closeOccupiedNextNode(vehicle, toNodeId);
    if (closeNextOccupantId) {
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

    const movingTargetClaimId = this.movingVehicleTargetingNode(toNodeId, vehicle.id);
    if (movingTargetClaimId) {
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

    const occupiedTargetId = this.currentNodeOccupancy.get(toNodeId);
    if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
      if (this.tryInsertHeadOnYieldRoute(vehicle, toNodeId, occupiedTargetId)) {
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

    const portalHoldBlock = this.portalNodeHoldBlock(vehicle, toNodeId);
    if (portalHoldBlock) {
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

    this.reservations.push(...authorization.reservations);
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
    return !task && nodeId === this.parkingNodeFor(vehicle.id);
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
    const nextNodeId = vehicle.routeNodeIds[routeIndex + 2];
    if (!nextNodeId) {
      return 'profile';
    }
    const nextEdge = this.traffic.findEdge(toNodeId, nextNodeId);
    return nextEdge && this.axisForEdge(nextEdge) === axis ? 'cruise' : 'profile';
  }

  private routeHorizonEligible(fromNodeId: string, toNodeId: string): boolean {
    const fromRowLabel = this.nodeStorageRowLabel(fromNodeId);
    const toRowLabel = this.nodeStorageRowLabel(toNodeId);
    return (
      fromRowLabel !== null &&
      fromRowLabel === toRowLabel &&
      (this.isStorageNode(fromNodeId) || this.isStorageNode(toNodeId))
    );
  }

  private leadingVehicleTooClose(vehicle: MutableVehicle, fromNodeId: string, toNodeId: string): string | null {
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
    const firstTravelSec = firstMotionMode === 'cruise'
      ? firstEdge.lengthM / Math.max(0.001, firstSpeed)
      : calculateTravelTimeSec(firstEdge.lengthM, firstSpeed, this.scenario.physicsParams.accelerationMps2);

    if (this.hasActiveSelfMoveAuthorization(vehicle, firstEdge.id, firstToNodeId)) {
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

    for (
      let routeIndex = vehicle.routeIndex;
      routeIndex < vehicle.routeNodeIds.length - 1 && horizonLegCount < MAX_RESERVATION_HORIZON_LEGS;
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

      const horizonEligible = this.routeHorizonEligible(fromNodeId, toNodeId);
      if (horizonLegCount > 0 && !horizonEligible) {
        break;
      }

      const axis = this.axisForEdge(edge);
      if (horizonLegCount > 0 && horizonAxis !== null && axis !== horizonAxis) {
        break;
      }

      const occupiedTargetId = this.currentNodeOccupancy.get(toNodeId);
      if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
        break;
      }

      const speed = this.speedForEdge(vehicle, edge);
      const motionMode = this.routeLegMotionMode(vehicle, edge, toNodeId, routeIndex, task);
      const travelSec = motionMode === 'cruise'
        ? edge.lengthM / Math.max(0.001, speed)
        : calculateTravelTimeSec(edge.lengthM, speed, this.scenario.physicsParams.accelerationMps2);
      cumulativeTravelSec += travelSec;
      const attempt = this.traffic.reserveMove({
        vehicleId: vehicle.id,
        taskId: vehicle.taskId,
        fromNodeId,
        toNodeId,
        startTimeSec: this.simTimeSec,
        travelSec: cumulativeTravelSec,
        priority,
        existing: [...this.reservations, ...stagedReservations]
      });

      if (!attempt.ok) {
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

      if (this.mustStopAtNode(vehicle, task, toNodeId)) {
        break;
      }
      if (!horizonEligible) {
        break;
      }
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
    const lengthM = edge?.lengthM ?? Math.hypot(to.x - from.x, to.z - from.z);
    const remainingLegSec = Math.max(0, vehicle.legTravelSec - vehicle.legElapsedSec);
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
    vehicle.legRemainingM = round(Math.max(0, lengthM - traveledM));
    vehicle.speedMps = round(vehicle.legRemainingM <= 0 ? 0 : profile.speedMps);
    const progress = lengthM <= 0 ? 1 : traveledM / lengthM;
    vehicle.x = round(from.x + (to.x - from.x) * progress);
    vehicle.y = SHUTTLE_Y_M;
    vehicle.z = round(from.z + (to.z - from.z) * progress);
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
    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null : null;
    this.logEvent('vehicle-arrived', vehicle.id, task?.id ?? null, task?.loadId ?? null, previousNode, toNodeId, 'route-arrival', this.vehiclePosition(vehicle), {});

    if (task && toNodeId === task.pickupNodeId && !vehicle.loaded) {
      task.state = 'in-progress';
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
      this.startNextLeg(vehicle, remainingStepSec);
    }
  }

  private priorityFor(vehicle: MutableVehicle): number {
    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) ?? null : null;
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

  private insertPortalYieldPocket(vehicle: MutableVehicle): boolean {
    const currentNodeId = vehicle.currentNodeId;
    const currentZones = new Set(this.zonesForNode(currentNodeId).map((zone) => zone.id));
    const candidates = this.neighbors(currentNodeId)
      .filter((neighbor) => neighbor.nodeId !== vehicle.targetNodeId)
      .filter((neighbor) => !this.currentNodeOccupancy.has(neighbor.nodeId))
      .filter((neighbor) => {
        const node = this.scenario.layout.nodes.find((candidate) => candidate.id === neighbor.nodeId);
        return node?.type !== 'lift-blackbox';
      })
      .filter((neighbor) => this.zonesForNode(neighbor.nodeId).every((zone) => !currentZones.has(zone.id)))
      .sort((left, right) => left.lengthM - right.lengthM || left.nodeId.localeCompare(right.nodeId));
    const candidate = candidates[0];
    if (!candidate || !this.traffic.findEdge(candidate.nodeId, currentNodeId)) {
      return false;
    }

    const route = [
      ...vehicle.routeNodeIds.slice(0, vehicle.routeIndex + 1),
      candidate.nodeId,
      currentNodeId,
      ...vehicle.routeNodeIds.slice(vehicle.routeIndex + 1)
    ];
    vehicle.routeNodeIds = route;
    vehicle.targetNodeId = route[vehicle.routeIndex + 1] ?? null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.waitingSinceSec = null;
    vehicle.state = 'assigned';
    const task = vehicle.taskId ? this.tasks.find((candidateTask) => candidateTask.id === vehicle.taskId) ?? null : null;
    if (task) {
      task.replanCount += 1;
    }
    this.replanCount += 1;
    this.logEvent('route-replanned', vehicle.id, vehicle.taskId, null, currentNodeId, vehicle.targetNodeId, 'portal-hold-yield-pocket', this.vehiclePosition(vehicle), {
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

  private liftPortDiagnostics(): ShuttleSimState['traffic']['liftPorts'] {
    return this.liftPortNodes().map((port) => {
      const waitingTaskIds = this.tasks
        .filter((task) => task.state === 'queued' && task.kind === port.kind && this.taskLiftPortNodeId(task) === port.nodeId)
        .map((task) => task.id)
        .sort();
      const activeVehicle = this.vehicles
        .filter((vehicle) =>
          vehicle.currentNodeId === port.nodeId &&
          ((port.kind === 'inbound' && vehicle.state === 'lifting') || (port.kind === 'outbound' && vehicle.state === 'lowering'))
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
        utilization: round((this.liftPortBusyTimeSec.get(port.nodeId) ?? 0) / Math.max(this.simTimeSec, 1), 4)
      };
    });
  }

  private vehiclePosition(vehicle: MutableVehicle): { x: number; y: number; z: number } {
    return { x: vehicle.x, y: vehicle.y, z: vehicle.z };
  }

  private publicVehicle(vehicle: MutableVehicle): VehicleState {
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
    const maxConfiguredSpeedMps = Math.max(this.scenario.physicsParams.emptySpeedMps, this.scenario.physicsParams.loadedSpeedMps);

    for (const vehicle of this.vehicles) {
      if (![vehicle.x, vehicle.y, vehicle.z, vehicle.yaw, vehicle.speedMps].every(Number.isFinite)) {
        physicalViolationCount += 1;
      }
      if (vehicle.speedMps > maxConfiguredSpeedMps + 1e-6) {
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
      activeReservationCount: this.reservations.length,
      waitingVehicles,
      liftPorts: this.liftPortDiagnostics(),
      deadlockCandidateVehicleIds,
      minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
      maxObservedSpeedMps: round(Math.max(0, ...this.vehicles.map((vehicle) => vehicle.speedMps))),
      physicalViolationCount
    };
  }

  private calculateKpis(): KpiSnapshot {
    const elapsedHours = Math.max(this.simTimeSec / 3600, 1e-9);
    const activeTasks = this.tasks.filter((task) => task.state === 'assigned' || task.state === 'in-progress').length;
    const queuedTasks = this.tasks.filter((task) => task.state === 'queued').length;
    const vehicleUtilization = Object.fromEntries(
      this.vehicles.map((vehicle) => [vehicle.id, round(vehicle.busyTimeSec / Math.max(this.simTimeSec, 1), 4)])
    );
    const blockedTimeByReasonSec = Object.fromEntries([...this.blockedTimeByReasonSec.entries()].sort(([left], [right]) => left.localeCompare(right)));

    return {
      inboundPph: round(this.completedInbound / elapsedHours, 3),
      outboundPph: round(this.completedOutbound / elapsedHours, 3),
      totalPph: round((this.completedInbound + this.completedOutbound) / elapsedHours, 3),
      completedInbound: this.completedInbound,
      completedOutbound: this.completedOutbound,
      activeTasks,
      queuedTasks,
      averageTaskCycleSec: round(this.completedTaskCycleTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.completedTaskCycleTimes.length)),
      p95TaskCycleSec: round(percentile(this.completedTaskCycleTimes, 95)),
      averageTaskWaitSec: round(this.completedTaskWaitTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.completedTaskWaitTimes.length)),
      vehicleUtilization,
      blockedTimeByReasonSec,
      reservationConflictCount: this.reservationConflictCount,
      replanCount: this.replanCount,
      deadlockCount: this.deadlockCount,
      livelockCount: this.livelockCount,
      eventLogHash: hashEventLog(this.eventLog)
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
