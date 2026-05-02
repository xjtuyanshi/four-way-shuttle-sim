import { createHash, randomUUID } from 'node:crypto';

import {
  EventLogEntrySchema,
  ReservationSchema,
  ShuttleScenarioSchema,
  type EventLogEntry,
  type KpiSnapshot,
  type LoadStateRecord,
  type Reservation,
  type ShuttleScenario,
  type ShuttleSimState,
  type TaskStateRecord,
  type VehicleState
} from '@four-way-shuttle/schemas';

type RuntimeStatus = ShuttleSimState['status'];

type MutableVehicle = VehicleState & {
  targetSpeedMps: number;
  waitingSinceSec: number | null;
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

export type ShuttleSimDebugState = {
  currentNodeOccupancy: Array<{ nodeId: string; vehicleId: string }>;
  storageNodeOccupancy: Array<{ nodeId: string; loadId: string }>;
};

type Rng = {
  next: () => number;
};

const SHUTTLE_Y_M = 0.08;
const DEFAULT_RECENT_EVENTS = 80;

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
type LayoutEdge = ShuttleScenario['layout']['edges'][number];
type LayoutZone = ShuttleScenario['layout']['zones'][number];

const DEFAULT_STORAGE_ROWS = 6;
const DEFAULT_STORAGE_COLUMNS = 8;
const DEFAULT_STORAGE_CELL_PITCH_X_M = 1.25;
const DEFAULT_STORAGE_CELL_PITCH_Z_M = 1.2;

function storageNodeId(rowIndex: number, columnIndex: number): string {
  return `storage-r${String(rowIndex + 1).padStart(2, '0')}-c${String(columnIndex + 1).padStart(2, '0')}`;
}

function createDefaultLayout(): ShuttleScenario['layout'] {
  const leftSpineX = 0;
  const rightSpineX = 14;
  const inboundX = 18;
  const outboundX = -4;
  const firstStorageX = 2.5;
  const topZ = -4.8;
  const bottomZ = 4.8;
  const parkingTopZ = -7.2;
  const parkingBottomZ = 7.2;
  const rowZs = Array.from({ length: DEFAULT_STORAGE_ROWS }, (_, rowIndex) =>
    round((rowIndex - (DEFAULT_STORAGE_ROWS - 1) / 2) * DEFAULT_STORAGE_CELL_PITCH_Z_M, 3)
  );
  const columnXs = Array.from({ length: DEFAULT_STORAGE_COLUMNS }, (_, columnIndex) =>
    round(firstStorageX + columnIndex * DEFAULT_STORAGE_CELL_PITCH_X_M, 3)
  );

  const nodes: LayoutNode[] = [
    { id: 'outbound-lift-a', type: 'lift-blackbox', x: outboundX, y: 0, z: rowZs[0]!, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'outbound-lift-b', type: 'lift-blackbox', x: outboundX, y: 0, z: rowZs[rowZs.length - 1]!, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'x-outbound', type: 'intersection', x: leftSpineX, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'left-top', type: 'aisle', x: leftSpineX, y: 0, z: topZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'left-bottom', type: 'aisle', x: leftSpineX, y: 0, z: bottomZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'right-top', type: 'aisle', x: rightSpineX, y: 0, z: topZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'right-bottom', type: 'aisle', x: rightSpineX, y: 0, z: bottomZ, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'x-main', type: 'intersection', x: rightSpineX, y: 0, z: 0, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'inbound-lift-a', type: 'lift-blackbox', x: inboundX, y: 0, z: rowZs[0]!, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'inbound-lift-b', type: 'lift-blackbox', x: inboundX, y: 0, z: rowZs[rowZs.length - 1]!, noStop: true, noParking: true, capacity: 1, allowedDirections: [] },
    { id: 'parking-a', type: 'parking', x: rightSpineX, y: 0, z: parkingTopZ, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
    { id: 'parking-b', type: 'parking', x: rightSpineX, y: 0, z: parkingBottomZ, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
  ];

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
        noParking: true,
        capacity: 1,
        allowedDirections: []
      });
    }
  }

  const edges: LayoutEdge[] = [
    { id: 'inbound-lift-a-right-row-01', from: 'inbound-lift-a', to: 'right-row-01', lengthM: Math.abs(inboundX - rightSpineX), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'inbound-lift-a-dock', noParking: true },
    { id: `inbound-lift-b-right-row-${String(DEFAULT_STORAGE_ROWS).padStart(2, '0')}`, from: 'inbound-lift-b', to: `right-row-${String(DEFAULT_STORAGE_ROWS).padStart(2, '0')}`, lengthM: Math.abs(inboundX - rightSpineX), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'inbound-lift-b-dock', noParking: true },
    { id: 'outbound-lift-a-left-row-01', from: 'outbound-lift-a', to: 'left-row-01', lengthM: Math.abs(leftSpineX - outboundX), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'outbound-lift-a-dock', noParking: true },
    { id: `outbound-lift-b-left-row-${String(DEFAULT_STORAGE_ROWS).padStart(2, '0')}`, from: 'outbound-lift-b', to: `left-row-${String(DEFAULT_STORAGE_ROWS).padStart(2, '0')}`, lengthM: Math.abs(leftSpineX - outboundX), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'outbound-lift-b-dock', noParking: true },
    { id: 'parking-a-right-top', from: 'parking-a', to: 'right-top', lengthM: Math.abs(parkingTopZ - topZ), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'parking-approach', noParking: true },
    { id: 'parking-b-right-bottom', from: 'parking-b', to: 'right-bottom', lengthM: Math.abs(parkingBottomZ - bottomZ), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'parking-approach', noParking: true },
    { id: 'left-top-right-top', from: 'left-top', to: 'right-top', lengthM: rightSpineX - leftSpineX, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'north-cross-aisle', noParking: true },
    { id: 'left-bottom-right-bottom', from: 'left-bottom', to: 'right-bottom', lengthM: rightSpineX - leftSpineX, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'south-cross-aisle', noParking: true }
  ];

  const leftSpineNodeIds = ['left-top', ...rowZs.map((_, rowIndex) => `left-row-${String(rowIndex + 1).padStart(2, '0')}`), 'left-bottom'];
  const rightSpineNodeIds = ['right-top', ...rowZs.map((_, rowIndex) => `right-row-${String(rowIndex + 1).padStart(2, '0')}`), 'right-bottom'];
  for (let index = 1; index < leftSpineNodeIds.length; index += 1) {
    const from = leftSpineNodeIds[index - 1]!;
    const to = leftSpineNodeIds[index]!;
    const fromNode = nodes.find((node) => node.id === from)!;
    const toNode = nodes.find((node) => node.id === to)!;
    edges.push({ id: `${from}-${to}`, from, to, lengthM: round(Math.abs(toNode.z - fromNode.z), 3), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'left-upright', noParking: true });
  }
  for (let index = 1; index < rightSpineNodeIds.length; index += 1) {
    const from = rightSpineNodeIds[index - 1]!;
    const to = rightSpineNodeIds[index]!;
    const fromNode = nodes.find((node) => node.id === from)!;
    const toNode = nodes.find((node) => node.id === to)!;
    edges.push({ id: `${from}-${to}`, from, to, lengthM: round(Math.abs(toNode.z - fromNode.z), 3), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'right-upright', noParking: true });
  }

  const upperMiddleRow = Math.floor((DEFAULT_STORAGE_ROWS - 1) / 2);
  const lowerMiddleRow = upperMiddleRow + 1;
  for (const rowIndex of [upperMiddleRow, lowerMiddleRow]) {
    const rowLabel = String(rowIndex + 1).padStart(2, '0');
    edges.push(
      { id: `x-main-right-row-${rowLabel}`, from: 'x-main', to: `right-row-${rowLabel}`, lengthM: Math.abs(rowZs[rowIndex]!), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'right-upright', noParking: true },
      { id: `x-outbound-left-row-${rowLabel}`, from: 'x-outbound', to: `left-row-${rowLabel}`, lengthM: Math.abs(rowZs[rowIndex]!), directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'left-upright', noParking: true }
    );
  }

  for (let rowIndex = 0; rowIndex < rowZs.length; rowIndex += 1) {
    const rowLabel = String(rowIndex + 1).padStart(2, '0');
    const rightRowId = `right-row-${rowLabel}`;
    const leftRowId = `left-row-${rowLabel}`;
    const rightmostStorageId = storageNodeId(rowIndex, DEFAULT_STORAGE_COLUMNS - 1);
    edges.push({
      id: `${rightRowId}-${rightmostStorageId}`,
      from: rightRowId,
      to: rightmostStorageId,
      lengthM: round(rightSpineX - columnXs[DEFAULT_STORAGE_COLUMNS - 1]!, 3),
      directionMode: 'oneWay',
      reservationType: 'edge',
      conflictGroup: `fifo-lane-${rowLabel}`,
      noParking: true
    });
    for (let columnIndex = DEFAULT_STORAGE_COLUMNS - 1; columnIndex > 0; columnIndex -= 1) {
      const from = storageNodeId(rowIndex, columnIndex);
      const to = storageNodeId(rowIndex, columnIndex - 1);
      edges.push({
        id: `${from}-${to}`,
        from,
        to,
        lengthM: DEFAULT_STORAGE_CELL_PITCH_X_M,
        directionMode: 'oneWay',
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
      directionMode: 'oneWay',
      reservationType: 'edge',
      conflictGroup: `fifo-lane-${rowLabel}`,
      noParking: true
    });
  }

  const zones: LayoutZone[] = [
    {
      id: 'zone-x-main',
      type: 'intersection',
      nodeIds: ['x-main'],
      edgeIds: [`x-main-right-row-${String(upperMiddleRow + 1).padStart(2, '0')}`, `x-main-right-row-${String(lowerMiddleRow + 1).padStart(2, '0')}`],
      noStop: true,
      noParking: true,
      capacity: 1,
      conflictGroup: 'intersection-x-main'
    },
    {
      id: 'zone-x-outbound',
      type: 'intersection',
      nodeIds: ['x-outbound'],
      edgeIds: [`x-outbound-left-row-${String(upperMiddleRow + 1).padStart(2, '0')}`, `x-outbound-left-row-${String(lowerMiddleRow + 1).padStart(2, '0')}`],
      noStop: true,
      noParking: true,
      capacity: 1,
      conflictGroup: 'intersection-x-outbound'
    }
  ];

  return { units: 'meter', nodes, edges, zones };
}

export function createDefaultShuttleScenario(overrides: ShuttleScenarioOverrides = {}): ShuttleScenario {
  const base: ShuttleScenario = {
    schemaVersion: 'shuttle.phase0.v0',
    id: 'shuttle-phase0-balanced',
    name: 'Phase 0 Balanced Shuttle Smoke',
    seed: 20260502,
    durationSec: 600,
    timeStepSec: 0.2,
    vehicles: {
      count: 2,
      lengthM: 1.09,
      widthM: 1.03,
      heightM: 0.16,
      emptySpeedMps: 2,
      loadedSpeedMps: 1.5,
      accelerationMps2: 1,
      switchDirectionSec: 3,
      liftTimeSec: 2,
      lowerTimeSec: 2,
      maxLoadKg: 1800,
      safetyRadiusM: 0.5,
      batteryEnabled: false,
      initialSoc: 1
    },
    layout: createDefaultLayout(),
    taskGeneration: {
      inboundRatePerHour: 90,
      outboundRatePerHour: 90,
      inboundOutboundMix: 0.5,
      arrivalDistribution: 'deterministic',
      maxTasks: 40
    },
    physicsParams: {
      emptySpeedMps: 2,
      loadedSpeedMps: 1.5,
      accelerationMps2: 1,
      switchDirectionSec: 3,
      liftTimeSec: 2,
      lowerTimeSec: 2,
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
    const targetNodeZones = this.scenario.layout.zones.filter((candidate) => candidate.nodeIds.includes(options.toNodeId));
    const matchingZones = [
      ...this.scenario.layout.zones.filter((candidate) => candidate.edgeIds.includes(edge.id)),
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

    return candidate.startTimeSec < existing.endTimeSec && existing.startTimeSec < candidate.endTimeSec;
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
  private blockedTimeByReasonSec = new Map<string, number>();
  private deferredTaskReasons: Record<'inbound' | 'outbound', string | null> = { inbound: null, outbound: null };
  private liftPortBusyTimeSec = new Map<string, number>();
  private error: string | null = null;

  constructor(scenario: ShuttleScenario = createDefaultShuttleScenario()) {
    this.scenario = ShuttleScenarioSchema.parse(scenario);
    this.traffic = new TrafficReservationController(this.scenario);
    this.rng = makeRng(this.scenario.seed);
    this.reset(this.scenario.seed);
  }

  getScenario(): ShuttleScenario {
    return structuredClone(this.scenario);
  }

  loadScenario(scenario: ShuttleScenario): ShuttleSimState {
    this.scenario = ShuttleScenarioSchema.parse(scenario);
    this.traffic = new TrafficReservationController(this.scenario);
    this.rng = makeRng(this.scenario.seed);
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
    this.blockedTimeByReasonSec = new Map();
    this.deferredTaskReasons = { inbound: null, outbound: null };
    this.liftPortBusyTimeSec = new Map();
    this.error = null;
    this.rng = makeRng(seed);
    this.scenario = { ...this.scenario, seed };
    this.traffic = new TrafficReservationController(this.scenario);
    this.nextInboundSec = this.intervalForRate(this.scenario.taskGeneration.inboundRatePerHour);
    this.nextOutboundSec = this.intervalForRate(this.scenario.taskGeneration.outboundRatePerHour) / 2;

    const parkingNodes = this.scenario.layout.nodes.filter((node) => node.type === 'parking');
    this.vehicles = Array.from({ length: this.scenario.vehicles.count }, (_, index) => {
      const parking = parkingNodes[index % Math.max(1, parkingNodes.length)] ?? this.scenario.layout.nodes[0]!;
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
        waitingSinceSec: null
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
        this.releaseZoneHoldReservations(vehicle, nodeId);
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

  private intervalForRate(ratePerHour: number): number {
    if (ratePerHour <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return 3600 / ratePerHour;
  }

  private generateDueTasks(dtSec: number): void {
    if (this.tasks.length >= this.scenario.taskGeneration.maxTasks) {
      return;
    }

    while (this.simTimeSec >= this.nextInboundSec && this.tasks.length < this.scenario.taskGeneration.maxTasks) {
      const result = this.createTask('inbound');
      if (!result.created) {
        this.deferTask('inbound', result.reason, dtSec);
        this.nextInboundSec = this.simTimeSec + this.scenario.timeStepSec;
        break;
      }
      this.deferredTaskReasons.inbound = null;
      this.nextInboundSec += this.nextArrivalInterval('inbound');
    }

    while (this.simTimeSec >= this.nextOutboundSec && this.tasks.length < this.scenario.taskGeneration.maxTasks) {
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
      .filter((node) => node.type === 'lift-blackbox' && node.id.startsWith(`${kind}-lift`))
      .sort((left, right) => {
        const leftDistance = relatedNode ? Math.abs(left.z - relatedNode.z) + Math.abs(left.x - relatedNode.x) : 0;
        const rightDistance = relatedNode ? Math.abs(right.z - relatedNode.z) + Math.abs(right.x - relatedNode.x) : 0;
        return leftDistance - rightDistance || left.id.localeCompare(right.id);
      });
    const candidates = liftNodes.length > 0 ? liftNodes.map((node) => node.id) : [fallbackNodeId];
    return candidates[0]!;
  }

  private taskLiftPortNodeId(task: TaskStateRecord): string | null {
    if (task.kind === 'inbound' && task.pickupNodeId.startsWith('inbound-lift')) {
      return task.pickupNodeId;
    }
    if (task.kind === 'outbound' && task.dropoffNodeId.startsWith('outbound-lift')) {
      return task.dropoffNodeId;
    }
    return null;
  }

  private isLiftPortBusyForAssignment(kind: 'inbound' | 'outbound', liftNodeId: string): boolean {
    return this.tasks.some((task) => this.isTaskUsingLiftPortResource(task, kind, liftNodeId));
  }

  private isTaskUsingLiftPortResource(task: TaskStateRecord, kind: 'inbound' | 'outbound', liftNodeId: string): boolean {
    if (task.kind !== kind || task.state === 'queued' || task.state === 'completed' || task.state === 'failed') {
      return false;
    }
    const taskLiftPortId = this.taskLiftPortNodeId(task);
    if (taskLiftPortId !== liftNodeId) {
      return false;
    }
    if (kind === 'outbound') {
      return true;
    }
    const load = this.loads.find((candidate) => candidate.id === task.loadId);
    return load?.state === 'waiting' && load.nodeId === liftNodeId;
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
    for (let offset = 0; offset < lanes.length; offset += 1) {
      const lane = lanes[(this.taskSequence + offset) % lanes.length]!;
      const candidate = lane.find((node, index) => {
        if (occupancy.has(node.id)) {
          return false;
        }
        const nodesBetweenCandidateAndInfeed = lane.slice(index + 1);
        return nodesBetweenCandidateAndInfeed.every((rightSideNode) => !occupancy.has(rightSideNode.id));
      });
      if (candidate) {
        return { nodeId: candidate.id, loadId: '' };
      }
    }
    return null;
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
    for (const task of this.tasks.filter((candidate) => candidate.state === 'queued')) {
      const reason = this.liftPortBlockReason(task);
      task.waitReason = reason;
      if (reason) {
        this.blockedTimeByReasonSec.set(reason, round((this.blockedTimeByReasonSec.get(reason) ?? 0) + dtSec));
      }
    }

    const idleVehicles = this.vehicles.filter((vehicle) => vehicle.state === 'idle');
    for (const vehicle of idleVehicles) {
      const task = this.tasks.find((candidate) => candidate.state === 'queued' && !this.liftPortBlockReason(candidate));
      if (!task) {
        return;
      }

      const route = this.planRoute(vehicle.currentNodeId, task.pickupNodeId, task.dropoffNodeId, this.parkingNodeFor(vehicle.id));
      vehicle.taskId = task.id;
      vehicle.routeNodeIds = route;
      vehicle.routeIndex = 0;
      vehicle.targetNodeId = route[1] ?? null;
      vehicle.state = 'assigned';
      vehicle.waitReason = null;
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = null;
      task.state = 'assigned';
      task.vehicleId = vehicle.id;
      task.assignedAtSec = this.simTimeSec;
      task.waitReason = null;
      this.logEvent('task-assigned', vehicle.id, task.id, task.loadId, vehicle.currentNodeId, task.pickupNodeId, 'nearest-idle', this.vehiclePosition(vehicle), {
        route: route.join('>')
      });
    }
  }

  private liftPortBlockReason(task: TaskStateRecord): string | null {
    if (task.kind === 'inbound' && task.pickupNodeId.startsWith('inbound-lift')) {
      return this.isLiftPortBusyForAssignment('inbound', task.pickupNodeId) ? `inbound-lift-busy:${task.pickupNodeId}` : null;
    }
    if (task.kind === 'outbound' && task.dropoffNodeId.startsWith('outbound-lift')) {
      return this.isLiftPortBusyForAssignment('outbound', task.dropoffNodeId) ? `outbound-lift-busy:${task.dropoffNodeId}` : null;
    }
    return null;
  }

  private planRoute(currentNodeId: string, pickupNodeId: string, dropoffNodeId: string, parkingNodeId: string): string[] {
    const route: string[] = [currentNodeId];
    for (const target of [pickupNodeId, dropoffNodeId, parkingNodeId]) {
      const segment = this.shortestPath(route[route.length - 1]!, target);
      route.push(...segment.slice(1));
    }
    return route;
  }

  private shortestPath(fromNodeId: string, toNodeId: string): string[] {
    if (fromNodeId === toNodeId) {
      return [fromNodeId];
    }

    const nodes = new Set(this.scenario.layout.nodes.map((node) => node.id));
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
        if (!nodes.has(neighbor.nodeId)) {
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
    const neighbors: Array<{ nodeId: string; lengthM: number }> = [];
    for (const edge of this.scenario.layout.edges) {
      if (edge.from === nodeId) {
        neighbors.push({ nodeId: edge.to, lengthM: edge.lengthM });
      }
      if (edge.directionMode === 'twoWay' && edge.to === nodeId) {
        neighbors.push({ nodeId: edge.from, lengthM: edge.lengthM });
      }
    }
    return neighbors.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  private parkingNodeFor(vehicleId: string): string {
    const parkingNodes = this.scenario.layout.nodes.filter((node) => node.type === 'parking');
    if (parkingNodes.length === 0) {
      const fallbackNode = this.scenario.layout.nodes.find((node) => !node.noParking) ?? this.scenario.layout.nodes[0];
      if (!fallbackNode) {
        throw new Error('Scenario has no nodes available for vehicle parking.');
      }
      return fallbackNode.id;
    }
    const vehicleNumber = Number(vehicleId.replace(/\D+/g, '')) || 1;
    return parkingNodes[(vehicleNumber - 1) % parkingNodes.length]!.id;
  }

  private zonesForNode(nodeId: string): ShuttleScenario['layout']['zones'] {
    return this.scenario.layout.zones.filter((zone) => zone.nodeIds.includes(nodeId));
  }

  private releaseNodeOccupancy(vehicle: MutableVehicle, nodeId: string): void {
    if (this.currentNodeOccupancy.get(nodeId) === vehicle.id) {
      this.currentNodeOccupancy.delete(nodeId);
    }
    this.releaseZoneHoldReservations(vehicle, nodeId);
  }

  private occupyNode(vehicle: MutableVehicle, nodeId: string): void {
    this.currentNodeOccupancy.set(nodeId, vehicle.id);
    this.ensureZoneHoldReservation(vehicle, nodeId);
  }

  private ensureZoneHoldReservation(vehicle: MutableVehicle, nodeId: string): void {
    for (const zone of this.zonesForNode(nodeId)) {
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

  private releaseZoneHoldReservations(vehicle: MutableVehicle, nodeId: string): void {
    const zoneIds = new Set(this.zonesForNode(nodeId).map((zone) => zone.id));
    if (zoneIds.size === 0) {
      return;
    }
    this.reservations = this.reservations.filter(
      (reservation) =>
        !(
          reservation.reasonCode === 'zone-hold' &&
          reservation.vehicleId === vehicle.id &&
          reservation.resourceType === 'zone' &&
          zoneIds.has(reservation.resourceId)
        )
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

    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) : null;
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
      this.logEvent('vehicle-parked', vehicle.id, null, null, vehicle.currentNodeId, null, 'idle-parking', this.vehiclePosition(vehicle), {});
    }
  }

  private startNextLeg(vehicle: MutableVehicle, dtSec: number): void {
    const fromNodeId = vehicle.currentNodeId;
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
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.waitReason = 'node-occupancy-mismatch';
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = currentOccupant;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.blockedTimeByReasonSec.set('node-occupancy-mismatch', round((this.blockedTimeByReasonSec.get('node-occupancy-mismatch') ?? 0) + dtSec));
      this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'node-occupancy-mismatch', this.vehiclePosition(vehicle), {
        blockingVehicleId: currentOccupant
      });
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

    const occupiedTargetId = this.currentNodeOccupancy.get(toNodeId);
    if (occupiedTargetId && occupiedTargetId !== vehicle.id) {
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.waitReason = 'node-occupied';
      vehicle.blockingReservationId = null;
      vehicle.blockingVehicleId = occupiedTargetId;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.blockedTimeByReasonSec.set('node-occupied', round((this.blockedTimeByReasonSec.get('node-occupied') ?? 0) + dtSec));
      this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'node-occupied', this.vehiclePosition(vehicle), {
        blockingVehicleId: occupiedTargetId
      });
      return;
    }

    const speedLimit = vehicle.loaded ? edge.speedLimitLoadedMps ?? this.scenario.physicsParams.loadedSpeedMps : edge.speedLimitEmptyMps ?? this.scenario.physicsParams.emptySpeedMps;
    const speed = Math.min(speedLimit, vehicle.loaded ? this.scenario.physicsParams.loadedSpeedMps : this.scenario.physicsParams.emptySpeedMps);
    const travelSec = calculateTravelTimeSec(edge.lengthM, speed, this.scenario.physicsParams.accelerationMps2);
    const priority = this.priorityFor(vehicle);
    const attempt = this.traffic.reserveMove({
      vehicleId: vehicle.id,
      taskId: vehicle.taskId,
      fromNodeId,
      toNodeId,
      startTimeSec: this.simTimeSec,
      travelSec,
      priority,
      existing: this.reservations
    });

    if (!attempt.ok) {
      this.reservationConflictCount += 1;
      vehicle.state = 'waiting-blocked';
      vehicle.speedMps = 0;
      vehicle.waitReason = attempt.reasonCode;
      vehicle.blockingReservationId = attempt.blockingReservationId;
      vehicle.blockingVehicleId = null;
      vehicle.waitingSinceSec ??= this.simTimeSec;
      vehicle.blockedTimeSec = round(vehicle.blockedTimeSec + dtSec);
      this.blockedTimeByReasonSec.set(attempt.reasonCode, round((this.blockedTimeByReasonSec.get(attempt.reasonCode) ?? 0) + dtSec));
      this.logEvent('vehicle-waiting', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, attempt.reasonCode, this.vehiclePosition(vehicle), {
        blockingReservationId: attempt.blockingReservationId
      });
      return;
    }

    this.reservations.push(...attempt.reservations);
    this.releaseNodeOccupancy(vehicle, fromNodeId);
    vehicle.waitingSinceSec = null;
    vehicle.waitReason = null;
    vehicle.blockingReservationId = null;
    vehicle.blockingVehicleId = null;
    vehicle.state = vehicle.loaded ? 'loaded-moving' : vehicle.taskId ? 'moving-to-pickup' : 'returning';
    vehicle.targetNodeId = toNodeId;
    vehicle.legRemainingM = edge.lengthM;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = travelSec;
    vehicle.currentEdgeId = edge.id;
    vehicle.targetSpeedMps = speed;
    this.logEvent('reservation-created', vehicle.id, vehicle.taskId, null, fromNodeId, toNodeId, 'route-leg', this.vehiclePosition(vehicle), {
      edgeId: edge.id,
      reservationIds: attempt.reservations.map((reservation) => reservation.id).join(',')
    });
    this.advanceMovement(vehicle, dtSec);
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
    vehicle.legElapsedSec = round(Math.min(vehicle.legTravelSec, vehicle.legElapsedSec + dtSec));
    const profile = motionProfileAt(
      vehicle.legElapsedSec,
      lengthM,
      vehicle.targetSpeedMps,
      this.scenario.physicsParams.accelerationMps2
    );
    const traveledM = Math.min(lengthM, profile.distanceM);
    vehicle.legRemainingM = round(Math.max(0, lengthM - traveledM));
    vehicle.speedMps = round(vehicle.legRemainingM <= 0 ? 0 : profile.speedMps);
    const progress = lengthM <= 0 ? 1 : traveledM / lengthM;
    vehicle.x = round(from.x + (to.x - from.x) * progress);
    vehicle.y = SHUTTLE_Y_M;
    vehicle.z = round(from.z + (to.z - from.z) * progress);
    vehicle.yaw = round(Math.atan2(to.z - from.z, to.x - from.x));

    if (vehicle.legRemainingM > 0) {
      return;
    }

    const previousNode = vehicle.currentNodeId;
    vehicle.currentNodeId = toNodeId;
    this.occupyNode(vehicle, toNodeId);
    vehicle.routeIndex += 1;
    vehicle.targetNodeId = null;
    vehicle.currentEdgeId = null;
    vehicle.targetSpeedMps = 0;
    vehicle.legElapsedSec = 0;
    vehicle.legTravelSec = 0;
    vehicle.speedMps = 0;
    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) : null;
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
  }

  private priorityFor(vehicle: MutableVehicle): number {
    const task = vehicle.taskId ? this.tasks.find((candidate) => candidate.id === vehicle.taskId) : null;
    const base = task?.createdAtSec ?? this.simTimeSec;
    const age = Math.floor((this.simTimeSec - base) / Math.max(1, this.scenario.trafficPolicy.priorityAgingSec));
    return age * 1000 - Number(vehicle.id.replace(/\D+/g, '') || 0);
  }

  private updateDeadlockSmokeCounters(): void {
    const deadlockCandidateVehicleIds = this.deadlockCandidateVehicleIds();
    if (deadlockCandidateVehicleIds.length < 2) {
      return;
    }
    const waitingVehicles = this.vehicles.filter((vehicle) => deadlockCandidateVehicleIds.includes(vehicle.id) && vehicle.waitingSinceSec !== null);
    const oldestWait = Math.min(...waitingVehicles.map((vehicle) => vehicle.waitingSinceSec ?? this.simTimeSec));
    if (this.simTimeSec - oldestWait >= this.scenario.trafficPolicy.deadlockDetectSec) {
      this.deadlockCount += 1;
      for (const vehicle of waitingVehicles) {
        vehicle.waitingSinceSec = this.simTimeSec;
      }
      this.logEvent('deadlock-detected', null, null, null, null, null, 'phase0-smoke-detector', null, {
        waitingVehicles: deadlockCandidateVehicleIds.join(',')
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

  private blockingVehicleForReservation(reservationId: string | null): string | null {
    if (!reservationId) {
      return null;
    }
    return this.reservations.find((reservation) => reservation.id === reservationId)?.vehicleId ?? null;
  }

  private liftPortNodes(): Array<{ nodeId: string; kind: 'inbound' | 'outbound' }> {
    return this.scenario.layout.nodes
      .filter((node) => node.type === 'lift-blackbox' && (node.id.startsWith('inbound-lift') || node.id.startsWith('outbound-lift')))
      .map((node) => ({ nodeId: node.id, kind: node.id.startsWith('inbound-lift') ? 'inbound' as const : 'outbound' as const }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  private updateLiftPortUtilization(dtSec: number): void {
    for (const port of this.liftPortNodes()) {
      if (this.isLiftPortBusyForAssignment(port.kind, port.nodeId)) {
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
      const activeTask = this.tasks
        .filter((task) => this.isTaskUsingLiftPortResource(task, port.kind, port.nodeId))
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      return {
        nodeId: port.nodeId,
        kind: port.kind,
        queueLength: waitingTaskIds.length,
        waitingTaskIds,
        activeTaskId: activeTask?.id ?? null,
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
    const minCenterSeparationM = this.scenario.vehicles.safetyRadiusM * 2;
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
        if (separationM + 1e-6 < minCenterSeparationM) {
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
