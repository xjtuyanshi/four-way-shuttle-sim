import type { Reservation, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import {
  ShuttleSimCore,
  createDefaultShuttleScenario,
  hashEventLog,
  summarizeScenarioStaticSceneContract,
  type ShuttleSimDebugState,
  type ShuttleStaticSceneCalibrationReadiness
} from '@four-way-shuttle/sim-core';

export type PhysicalViolationCode =
  | 'unreservedEdgeOccupancy'
  | 'unreservedNodeOccupancy'
  | 'unreservedZoneOccupancy'
  | 'nodeOccupancyMismatch'
  | 'edgeOccupancyMismatch'
  | 'speedLimit'
  | 'accelerationLimit'
  | 'minSeparation'
  | 'invalidCoordinate';

export type PhysicalViolationExample = {
  code: PhysicalViolationCode;
  timeSec: number;
  vehicleIds?: string[];
  edgeId?: string;
  nodeId?: string;
  zoneId?: string;
  observed?: number | string;
  limit?: number | string;
  message: string;
};

export type BottleneckCategory =
  | 'storageInventory'
  | 'fifoLane'
  | 'sideAisleNetwork'
  | 'liftPort'
  | 'vehicleFleet'
  | 'reservationControl'
  | 'other';

export type BottleneckBreakdown = Record<BottleneckCategory, number>;

export type Phase0ValidationRun = {
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
  queuedTasks: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
  blockedTimeByReasonSec: Record<string, number>;
  blockedTimeByCategorySec: BottleneckBreakdown;
  reservationConflictCount: number;
  deadlockCount: number;
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationCount: number;
  physicalViolationsByCode: Record<PhysicalViolationCode, number>;
  physicalViolationExamples: PhysicalViolationExample[];
};

export type Phase0StressRun = Phase0ValidationRun & {
  stressScenarioId: string;
  label: string;
  requestedInboundPph: number;
  requestedOutboundPph: number;
  requestedTotalPph: number;
  achievedTotalRatio: number | null;
  expectedBottleneckReasonPrefixes: string[];
  observedBottleneckReasons: string[];
  expectedBottleneckObserved: boolean;
  missingExpectedBottleneckReasonPrefixes: string[];
};

export type Phase0StressScenarioResult = {
  id: string;
  label: string;
  description: string;
  durationSec: number;
  seeds: number[];
  requestedInboundPph: number;
  requestedOutboundPph: number;
  requestedTotalPph: number;
  expectedBottleneckReasonPrefixes: string[];
  requiresPositiveThroughput: boolean;
  runs: Phase0StressRun[];
  totalPphMean: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
  observedBottleneckReasons: string[];
  blockedTimeByCategorySec: BottleneckBreakdown;
  pass: boolean;
};

export type LongRunAcceptanceThresholds = {
  minTotalPph: number;
  minInboundPph: number;
  minOutboundPph: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
};

export type Phase0ValidationResult = {
  checkedAt: string;
  scenarioId: string;
  layoutCalibrationReadiness: ShuttleStaticSceneCalibrationReadiness;
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
  longRun: {
    seeds: number[];
    durationSec: number;
    runs: Phase0ValidationRun[];
    thresholds: LongRunAcceptanceThresholds;
    totalPphMean: number;
    maxQueuedTasks: number;
    maxWaitingVehicles: number;
    maxLiftPortQueueLength: number;
    blockedTimeByCategorySec: BottleneckBreakdown;
  };
  stress: {
    durationSec: number;
    seeds: number[];
    scenarios: Phase0StressScenarioResult[];
    pass: boolean;
    noStressDeadlocks: boolean;
    noStressPhysicalSafetyViolations: boolean;
    noStressReservationCoverageViolations: boolean;
    expectedBottlenecksObserved: boolean;
    positiveThroughputWhereRequired: boolean;
    blockedTimeByCategorySec: BottleneckBreakdown;
  };
  acceptance: {
    sameSeedEventHashStable: boolean;
    noDeadlocksInSweep: boolean;
    eventLogsPresent: boolean;
    noPhysicalSafetyViolations: boolean;
    noReservationCoverageViolations: boolean;
    longRunEventLogsPresent: boolean;
    longRunThroughputPositive: boolean;
    longRunThroughputFloorMet: boolean;
    longRunThroughputBySideMet: boolean;
    longRunQueuesBounded: boolean;
    noLongRunDeadlocks: boolean;
    noLongRunPhysicalSafetyViolations: boolean;
    noLongRunReservationCoverageViolations: boolean;
    stressPass: boolean;
    noStressDeadlocks: boolean;
    noStressPhysicalSafetyViolations: boolean;
    noStressReservationCoverageViolations: boolean;
    expectedStressBottlenecksObserved: boolean;
    positiveStressThroughputWhereRequired: boolean;
    pass: boolean;
  };
};

type Phase0ValidationOptions = {
  durationSec?: number;
  longRunDurationSec?: number;
  repeatCount?: number;
  sweepSeeds?: number[];
  stressDurationSec?: number;
  stressSeeds?: number[];
  includeStress?: boolean;
  longRunThresholds?: Partial<LongRunAcceptanceThresholds>;
};

export type Phase0StateInspection = {
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationsByCode: Record<PhysicalViolationCode, number>;
  physicalViolationExamples: PhysicalViolationExample[];
};

const VIOLATION_CODES: PhysicalViolationCode[] = [
  'unreservedEdgeOccupancy',
  'unreservedNodeOccupancy',
  'unreservedZoneOccupancy',
  'nodeOccupancyMismatch',
  'edgeOccupancyMismatch',
  'speedLimit',
  'accelerationLimit',
  'minSeparation',
  'invalidCoordinate'
];

const POSITION_TOLERANCE_M = 0.35;
const EXAMPLE_LIMIT = 20;
const RESERVATION_COVERAGE_CODES: PhysicalViolationCode[] = [
  'unreservedEdgeOccupancy',
  'unreservedNodeOccupancy',
  'unreservedZoneOccupancy',
  'nodeOccupancyMismatch',
  'edgeOccupancyMismatch'
];
const LONG_RUN_TOTAL_THROUGHPUT_FLOOR_RATIO = 0.5;
const LONG_RUN_SIDE_THROUGHPUT_FLOOR_RATIO = 1 / 3;
const BOTTLENECK_CATEGORIES: BottleneckCategory[] = [
  'storageInventory',
  'fifoLane',
  'sideAisleNetwork',
  'liftPort',
  'vehicleFleet',
  'reservationControl',
  'other'
];

function sideThroughputFloor(requestedPph: number): number {
  return requestedPph > 0 ? round(Math.max(1, requestedPph * LONG_RUN_SIDE_THROUGHPUT_FLOOR_RATIO), 1) : 0;
}

function emptyBottleneckBreakdown(): BottleneckBreakdown {
  return Object.fromEntries(BOTTLENECK_CATEGORIES.map((category) => [category, 0])) as BottleneckBreakdown;
}

function bottleneckCategoryForReason(reason: string): BottleneckCategory {
  if (reason === 'storage-empty' || reason === 'storage-full') return 'storageInventory';
  if (reason.startsWith('fifo-lane-busy:') || reason.startsWith('fifo-predecessor-pending:')) return 'fifoLane';
  if (reason === 'fifo-left-network-busy' || reason === 'fifo-right-network-busy') return 'sideAisleNetwork';
  if (
    reason.startsWith('inbound-lift-busy:') ||
    reason.startsWith('outbound-lift-busy:') ||
    reason.startsWith('inbound-lift-approach-full:') ||
    reason.startsWith('outbound-lift-approach-full:')
  ) return 'liftPort';
  if (reason === 'vehicle-unavailable') return 'vehicleFleet';
  if (
    reason === 'edge-reserved' ||
    reason === 'node-reserved' ||
    reason === 'zone-reserved' ||
    reason === 'opposite-direction'
  ) {
    return 'reservationControl';
  }
  return 'other';
}

function categorizeBlockedTimeByReason(blockedTimeByReasonSec: Record<string, number>): BottleneckBreakdown {
  const breakdown = emptyBottleneckBreakdown();
  for (const [reason, blockedSec] of Object.entries(blockedTimeByReasonSec)) {
    breakdown[bottleneckCategoryForReason(reason)] += blockedSec;
  }
  for (const category of BOTTLENECK_CATEGORIES) {
    breakdown[category] = round(breakdown[category], 1);
  }
  return breakdown;
}

function aggregateBottleneckBreakdowns(runs: Array<{ blockedTimeByCategorySec: BottleneckBreakdown }>): BottleneckBreakdown {
  const breakdown = emptyBottleneckBreakdown();
  for (const run of runs) {
    for (const category of BOTTLENECK_CATEGORIES) {
      breakdown[category] += run.blockedTimeByCategorySec[category];
    }
  }
  for (const category of BOTTLENECK_CATEGORIES) {
    breakdown[category] = round(breakdown[category], 1);
  }
  return breakdown;
}

function defaultLongRunThresholds(scenario: ShuttleScenario): LongRunAcceptanceThresholds {
  const requestedPph = scenario.taskGeneration.inboundRatePerHour + scenario.taskGeneration.outboundRatePerHour;
  return {
    minTotalPph: round(Math.max(1, requestedPph * LONG_RUN_TOTAL_THROUGHPUT_FLOOR_RATIO), 1),
    minInboundPph: sideThroughputFloor(scenario.taskGeneration.inboundRatePerHour),
    minOutboundPph: sideThroughputFloor(scenario.taskGeneration.outboundRatePerHour),
    maxQueuedTasks: Math.max(scenario.vehicles.count * 6, Math.ceil(scenario.taskGeneration.maxTasks * 0.5)),
    maxWaitingVehicles: scenario.vehicles.count,
    maxLiftPortQueueLength: Math.max(1, scenario.vehicles.count * 3)
  };
}

function resolveLongRunThresholds(
  scenario: ShuttleScenario,
  overrides: Partial<LongRunAcceptanceThresholds> | undefined
): LongRunAcceptanceThresholds {
  return {
    ...defaultLongRunThresholds(scenario),
    ...overrides
  };
}

function scenarioWithOperationalStressParams(
  base: ShuttleScenario,
  overrides: Partial<Omit<ShuttleScenario, 'vehicles' | 'taskGeneration' | 'physicsParams' | 'trafficPolicy'>> & {
    vehicles?: Partial<ShuttleScenario['vehicles']>;
    taskGeneration?: Partial<ShuttleScenario['taskGeneration']>;
    physicsParams?: Partial<ShuttleScenario['physicsParams']>;
    trafficPolicy?: Partial<ShuttleScenario['trafficPolicy']>;
  }
): ShuttleScenario {
  return createDefaultShuttleScenario({
    ...base,
    ...overrides,
    vehicles: { ...base.vehicles, ...overrides.vehicles },
    taskGeneration: { ...base.taskGeneration, ...overrides.taskGeneration },
    physicsParams: { ...base.physicsParams, ...overrides.physicsParams },
    trafficPolicy: { ...base.trafficPolicy, ...overrides.trafficPolicy }
  });
}

function defaultStressPhysics(scenario: ShuttleScenario): Partial<ShuttleScenario['physicsParams']> {
  return {
    emptySpeedMps: Math.max(scenario.physicsParams.emptySpeedMps, 2.6),
    loadedSpeedMps: Math.max(scenario.physicsParams.loadedSpeedMps, 2.2),
    accelerationMps2: Math.max(scenario.physicsParams.accelerationMps2, 2),
    liftTimeSec: Math.min(scenario.physicsParams.liftTimeSec, 0.5),
    lowerTimeSec: Math.min(scenario.physicsParams.lowerTimeSec, 0.5),
    reservationClearanceSec: Math.min(scenario.physicsParams.reservationClearanceSec, 0.1)
  };
}

function storageNodeIds(scenario: ShuttleScenario): string[] {
  return scenario.layout.nodes
    .filter((node) => node.type === 'storage')
    .sort((left, right) => left.z - right.z || left.x - right.x || left.id.localeCompare(right.id))
    .map((node) => node.id);
}

type Phase0StressScenarioSpec = {
  id: string;
  label: string;
  description: string;
  scenario: ShuttleScenario;
  initialStoredNodeIds: string[];
  expectedBottleneckReasonPrefixes: string[];
  requiresPositiveThroughput: boolean;
};

function buildStressScenarioSpecs(baseScenario: ShuttleScenario): Phase0StressScenarioSpec[] {
  const stressPhysics = defaultStressPhysics(baseScenario);
  const allStorageNodeIds = storageNodeIds(baseScenario);
  const preloadOutletNodes = allStorageNodeIds.slice(0, 48);
  const nearFullStoredNodes = allStorageNodeIds.slice(0, Math.max(0, allStorageNodeIds.length - 4));
  const common = {
    vehicles: { count: Math.max(12, baseScenario.vehicles.count) },
    physicsParams: stressPhysics,
    trafficPolicy: { deadlockDetectSec: 5 }
  };

  return [
    {
      id: 'balanced-high-load',
      label: 'Balanced high-load surge',
      description: 'Empty-start surge with inbound and outbound requests far above physical capacity; expected to expose storage-empty, lift, and FIFO bottlenecks without deadlock or unsafe reservations.',
      scenario: scenarioWithOperationalStressParams(baseScenario, {
        ...common,
        taskGeneration: {
          inboundRatePerHour: 7200,
          outboundRatePerHour: 7200,
          inboundOutboundMix: 0.5,
          arrivalDistribution: 'seeded-exponential',
          maxTasks: 80
        }
      }),
      initialStoredNodeIds: [],
      expectedBottleneckReasonPrefixes: ['storage-empty', 'fifo-'],
      requiresPositiveThroughput: true
    },
    {
      id: 'inbound-only-saturation',
      label: 'Inbound-only saturation',
      description: 'All demand enters from dedicated inbound lifts so the shuttle fleet, lift-port queues, and reservation control must absorb the pressure without overbooking the dense FIFO grid.',
      scenario: scenarioWithOperationalStressParams(baseScenario, {
        ...common,
        taskGeneration: {
          inboundRatePerHour: 7200,
          outboundRatePerHour: 0,
          inboundOutboundMix: 1,
          arrivalDistribution: 'deterministic',
          maxTasks: 80
        }
      }),
      initialStoredNodeIds: [],
      expectedBottleneckReasonPrefixes: ['vehicle-unavailable'],
      requiresPositiveThroughput: true
    },
    {
      id: 'outbound-empty-store',
      label: 'Outbound on empty store',
      description: 'Outbound requests against an empty dense store must defer as storage-empty instead of creating phantom pallets or unsafe vehicle work.',
      scenario: scenarioWithOperationalStressParams(baseScenario, {
        ...common,
        taskGeneration: {
          inboundRatePerHour: 0,
          outboundRatePerHour: 7200,
          inboundOutboundMix: 0,
          arrivalDistribution: 'deterministic',
          maxTasks: 80
        }
      }),
      initialStoredNodeIds: [],
      expectedBottleneckReasonPrefixes: ['storage-empty'],
      requiresPositiveThroughput: false
    },
    {
      id: 'outbound-preloaded-pressure',
      label: 'Outbound preloaded pressure',
      description: 'Preloaded outlet-side pallets exercise retrieval, left-side FIFO access, and outbound lift queues under high outbound demand.',
      scenario: scenarioWithOperationalStressParams(baseScenario, {
        ...common,
        taskGeneration: {
          inboundRatePerHour: 0,
          outboundRatePerHour: 7200,
          inboundOutboundMix: 0,
          arrivalDistribution: 'seeded-exponential',
          maxTasks: 80
        }
      }),
      initialStoredNodeIds: preloadOutletNodes,
      expectedBottleneckReasonPrefixes: ['fifo-'],
      requiresPositiveThroughput: true
    },
    {
      id: 'near-full-inbound-pressure',
      label: 'Near-full inbound pressure',
      description: 'Nearly full storage leaves only the infeed-side tail cells open, so inbound work must reserve the last FIFO slots then report storage-full without double-booking cells.',
      scenario: scenarioWithOperationalStressParams(baseScenario, {
        ...common,
        taskGeneration: {
          inboundRatePerHour: 7200,
          outboundRatePerHour: 0,
          inboundOutboundMix: 1,
          arrivalDistribution: 'deterministic',
          maxTasks: 80
        }
      }),
      initialStoredNodeIds: nearFullStoredNodes,
      expectedBottleneckReasonPrefixes: ['storage-full'],
      requiresPositiveThroughput: false
    }
  ];
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

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
  vehicle: Pick<VehicleState, 'x' | 'z' | 'yaw'>,
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
  left: Pick<VehicleState, 'x' | 'z' | 'yaw'>,
  right: Pick<VehicleState, 'x' | 'z' | 'yaw'>,
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

function emptyViolationCounts(): Record<PhysicalViolationCode, number> {
  return Object.fromEntries(VIOLATION_CODES.map((code) => [code, 0])) as Record<PhysicalViolationCode, number>;
}

function addViolation(
  counts: Record<PhysicalViolationCode, number>,
  examples: PhysicalViolationExample[],
  example: PhysicalViolationExample
): void {
  counts[example.code] += 1;
  if (examples.length < EXAMPLE_LIMIT) {
    examples.push(example);
  }
}

function isActive(reservation: Reservation, timeSec: number): boolean {
  return reservation.startTimeSec <= timeSec + 1e-6 && timeSec <= reservation.endTimeSec + 1e-6;
}

function activeReservation(
  state: ShuttleSimState,
  options: {
    timeSec: number;
    vehicleId: string;
    resourceType: Reservation['resourceType'];
    resourceId: string;
  }
): Reservation | undefined {
  return state.reservations.find(
    (reservation) =>
      reservation.vehicleId === options.vehicleId &&
      reservation.resourceType === options.resourceType &&
      reservation.resourceId === options.resourceId &&
      isActive(reservation, options.timeSec)
  );
}

function nodeById(scenario: ShuttleScenario, nodeId: string): ShuttleScenario['layout']['nodes'][number] | undefined {
  return scenario.layout.nodes.find((node) => node.id === nodeId);
}

function edgeById(scenario: ShuttleScenario, edgeId: string): ShuttleScenario['layout']['edges'][number] | undefined {
  return scenario.layout.edges.find((edge) => edge.id === edgeId);
}

function zonesForVehicle(scenario: ShuttleScenario, vehicle: VehicleState): ShuttleScenario['layout']['zones'] {
  return scenario.layout.zones.filter((zone) => {
    if (vehicle.currentEdgeId && zone.edgeIds.includes(vehicle.currentEdgeId)) {
      return true;
    }
    const zoneAppliesToCurrentEdge =
      vehicle.currentEdgeId && (zone.edgeIds.length === 0 || zone.edgeIds.includes(vehicle.currentEdgeId));
    if (zoneAppliesToCurrentEdge && zone.nodeIds.includes(vehicle.currentNodeId)) {
      return true;
    }
    if (zoneAppliesToCurrentEdge && vehicle.targetNodeId && zone.nodeIds.includes(vehicle.targetNodeId)) {
      return true;
    }
    return !vehicle.currentEdgeId && zone.nodeIds.includes(vehicle.currentNodeId);
  });
}

function distanceToSegmentM(
  point: { x: number; z: number },
  from: { x: number; z: number },
  to: { x: number; z: number }
): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-9) {
    return Math.hypot(point.x - from.x, point.z - from.z);
  }
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (from.x + dx * t), point.z - (from.z + dz * t));
}

function inspectState(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  debug: ShuttleSimDebugState,
  previousSpeeds: Map<string, number>,
  previousMovingVehicleIds: Set<string>,
  counts: Record<PhysicalViolationCode, number>,
  examples: PhysicalViolationExample[]
): {
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
} {
  let maxObservedSpeedMps = 0;
  let maxObservedAccelerationMps2 = 0;
  let minVehicleSeparationM: number | null = null;
  const occupancyByNode = new Map(debug.currentNodeOccupancy.map((entry) => [entry.nodeId, entry.vehicleId]));
  const maxConfiguredSpeedMps = Math.max(scenario.physicsParams.emptySpeedMps, scenario.physicsParams.loadedSpeedMps);

  for (const vehicle of state.vehicles) {
    const timeSec = state.simTimeSec;
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, vehicle.speedMps);
    if (![vehicle.x, vehicle.y, vehicle.z, vehicle.yaw, vehicle.speedMps].every(Number.isFinite)) {
      addViolation(counts, examples, {
        code: 'invalidCoordinate',
        timeSec,
        vehicleIds: [vehicle.id],
        observed: `x=${vehicle.x}, y=${vehicle.y}, z=${vehicle.z}, yaw=${vehicle.yaw}, speed=${vehicle.speedMps}`,
        message: 'Vehicle reported a non-finite pose or speed value.'
      });
    }

    if (vehicle.speedMps > maxConfiguredSpeedMps + 1e-6) {
      addViolation(counts, examples, {
        code: 'speedLimit',
        timeSec,
        vehicleIds: [vehicle.id],
        observed: round(vehicle.speedMps),
        limit: maxConfiguredSpeedMps,
        message: 'Vehicle speed exceeded configured Phase 0 speed limits.'
      });
    }

    const previousSpeed = previousSpeeds.get(vehicle.id) ?? vehicle.speedMps;
    const accelerationMps2 = Math.abs(vehicle.speedMps - previousSpeed) / scenario.timeStepSec;
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, accelerationMps2);
    if (!vehicle.currentEdgeId && !previousMovingVehicleIds.has(vehicle.id) && accelerationMps2 > scenario.physicsParams.accelerationMps2 + 1e-6) {
      addViolation(counts, examples, {
        code: 'accelerationLimit',
        timeSec,
        vehicleIds: [vehicle.id],
        observed: round(accelerationMps2),
        limit: scenario.physicsParams.accelerationMps2,
        message: 'Vehicle acceleration exceeded configured acceleration limit.'
      });
    }

    if (vehicle.currentEdgeId) {
      const edge = edgeById(scenario, vehicle.currentEdgeId);
      const from = edge ? nodeById(scenario, edge.from) : undefined;
      const to = edge ? nodeById(scenario, edge.to) : undefined;
      if (!edge || !from || !to || distanceToSegmentM(vehicle, from, to) > POSITION_TOLERANCE_M) {
        addViolation(counts, examples, {
          code: 'edgeOccupancyMismatch',
          timeSec,
          vehicleIds: [vehicle.id],
          edgeId: vehicle.currentEdgeId,
          observed: `x=${round(vehicle.x)}, z=${round(vehicle.z)}`,
          limit: `${POSITION_TOLERANCE_M}m from edge segment`,
          message: 'Moving vehicle pose does not match its reported currentEdgeId.'
        });
      }
      if (!activeReservation(state, { timeSec, vehicleId: vehicle.id, resourceType: 'edge', resourceId: vehicle.currentEdgeId })) {
        addViolation(counts, examples, {
          code: 'unreservedEdgeOccupancy',
          timeSec,
          vehicleIds: [vehicle.id],
          edgeId: vehicle.currentEdgeId,
          message: 'Moving vehicle does not have an active edge reservation.'
        });
      }
      if (vehicle.targetNodeId && !activeReservation(state, { timeSec, vehicleId: vehicle.id, resourceType: 'node', resourceId: vehicle.targetNodeId })) {
        addViolation(counts, examples, {
          code: 'unreservedNodeOccupancy',
          timeSec,
          vehicleIds: [vehicle.id],
          nodeId: vehicle.targetNodeId,
          message: 'Moving vehicle does not have an active target-node reservation.'
        });
      }
    } else {
      const node = nodeById(scenario, vehicle.currentNodeId);
      if (!node || Math.hypot(vehicle.x - node.x, vehicle.z - node.z) > POSITION_TOLERANCE_M) {
        addViolation(counts, examples, {
          code: 'nodeOccupancyMismatch',
          timeSec,
          vehicleIds: [vehicle.id],
          nodeId: vehicle.currentNodeId,
          observed: `x=${round(vehicle.x)}, z=${round(vehicle.z)}`,
          limit: `${POSITION_TOLERANCE_M}m from current node`,
          message: 'Stopped vehicle pose does not match its reported currentNodeId.'
        });
      }
      if (occupancyByNode.get(vehicle.currentNodeId) !== vehicle.id) {
        addViolation(counts, examples, {
          code: 'unreservedNodeOccupancy',
          timeSec,
          vehicleIds: [vehicle.id],
          nodeId: vehicle.currentNodeId,
          observed: occupancyByNode.get(vehicle.currentNodeId) ?? 'none',
          limit: vehicle.id,
          message: 'Stopped vehicle is not registered as the current node occupant.'
        });
      }
    }

    for (const zone of zonesForVehicle(scenario, vehicle)) {
      if (!activeReservation(state, { timeSec, vehicleId: vehicle.id, resourceType: 'zone', resourceId: zone.id })) {
        addViolation(counts, examples, {
          code: 'unreservedZoneOccupancy',
          timeSec,
          vehicleIds: [vehicle.id],
          zoneId: zone.id,
          message: 'Vehicle is inside a zone without an active zone reservation or hold.'
        });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < state.vehicles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < state.vehicles.length; rightIndex += 1) {
      const left = state.vehicles[leftIndex]!;
      const right = state.vehicles[rightIndex]!;
      const separationM = Math.hypot(left.x - right.x, left.z - right.z);
      minVehicleSeparationM = minVehicleSeparationM === null ? separationM : Math.min(minVehicleSeparationM, separationM);
      if (vehicleFootprintsOverlap(left, right, scenario.vehicles)) {
        addViolation(counts, examples, {
          code: 'minSeparation',
          timeSec: state.simTimeSec,
          vehicleIds: [left.id, right.id],
          observed: round(separationM),
          limit: `rectangular footprint plus ${scenario.vehicles.safetyRadiusM}m clearance`,
          message: 'Vehicle rectangular safety envelopes overlap.'
        });
      }
    }
  }

  return { maxObservedSpeedMps, maxObservedAccelerationMps2, minVehicleSeparationM };
}

export function inspectPhase0StateSnapshot(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  debug: ShuttleSimDebugState,
  previousSpeeds = new Map<string, number>()
): Phase0StateInspection {
  const physicalViolationsByCode = emptyViolationCounts();
  const physicalViolationExamples: PhysicalViolationExample[] = [];
  const physical = inspectState(
    scenario,
    state,
    debug,
    previousSpeeds,
    new Set(),
    physicalViolationsByCode,
    physicalViolationExamples
  );

  return {
    maxObservedSpeedMps: round(physical.maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(physical.maxObservedAccelerationMps2),
    minVehicleSeparationM: physical.minVehicleSeparationM === null ? null : round(physical.minVehicleSeparationM),
    physicalViolationsByCode,
    physicalViolationExamples
  };
}

function runOnce(scenario: ShuttleScenario, seed: number, durationSec: number): Phase0ValidationRun {
  const sim = new ShuttleSimCore({ ...scenario, seed, durationSec });
  sim.start();
  let maxObservedSpeedMps = 0;
  let maxObservedAccelerationMps2 = 0;
  let minVehicleSeparationM: number | null = null;
  let previousSpeeds = new Map<string, number>();
  let previousMovingVehicleIds = new Set<string>();
  let maxQueuedTasks = 0;
  let maxWaitingVehicles = 0;
  let maxLiftPortQueueLength = 0;
  const physicalViolationsByCode = emptyViolationCounts();
  const physicalViolationExamples: PhysicalViolationExample[] = [];

  while (sim.getState().status === 'running') {
    const state = sim.step(scenario.timeStepSec);
    const physical = inspectState(
      scenario,
      state,
      sim.getDebugState(),
      previousSpeeds,
      previousMovingVehicleIds,
      physicalViolationsByCode,
      physicalViolationExamples
    );
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, physical.maxObservedSpeedMps);
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, physical.maxObservedAccelerationMps2);
    maxQueuedTasks = Math.max(maxQueuedTasks, state.kpis.queuedTasks);
    maxWaitingVehicles = Math.max(maxWaitingVehicles, state.traffic.waitingVehicles.length);
    maxLiftPortQueueLength = Math.max(maxLiftPortQueueLength, 0, ...state.traffic.liftPorts.map((port) => port.queueLength));
    previousSpeeds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.speedMps]));
    previousMovingVehicleIds = new Set(state.vehicles.filter((vehicle) => vehicle.currentEdgeId).map((vehicle) => vehicle.id));
    minVehicleSeparationM =
      physical.minVehicleSeparationM === null
        ? minVehicleSeparationM
        : minVehicleSeparationM === null
          ? physical.minVehicleSeparationM
          : Math.min(minVehicleSeparationM, physical.minVehicleSeparationM);
  }
  const state = sim.getState();
  const eventLog = sim.getEventLog();
  const physicalViolationCount = Object.values(physicalViolationsByCode).reduce((sum, value) => sum + value, 0);

  return {
    seed,
    durationSec,
    status: state.status,
    eventLogHash: hashEventLog(eventLog),
    eventCount: eventLog.length,
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    totalPph: state.kpis.totalPph,
    inboundPph: state.kpis.inboundPph,
    outboundPph: state.kpis.outboundPph,
    queuedTasks: state.kpis.queuedTasks,
    maxQueuedTasks,
    maxWaitingVehicles,
    maxLiftPortQueueLength,
    blockedTimeByReasonSec: state.kpis.blockedTimeByReasonSec,
    blockedTimeByCategorySec: categorizeBlockedTimeByReason(state.kpis.blockedTimeByReasonSec),
    reservationConflictCount: state.kpis.reservationConflictCount,
    deadlockCount: state.kpis.deadlockCount,
    maxObservedSpeedMps: round(maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(maxObservedAccelerationMps2),
    minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
    physicalViolationCount,
    physicalViolationsByCode,
    physicalViolationExamples
  };
}

function addStressStoredLoads(sim: ShuttleSimCore, nodeIds: string[]): void {
  nodeIds.forEach((nodeId, index) => {
    sim.addLoadForTest({
      id: `stress-load-${String(index + 1).padStart(4, '0')}`,
      state: 'stored',
      nodeId,
      vehicleId: null,
      weightKg: 100
    });
  });
}

function observedBottleneckReasons(run: Phase0ValidationRun): string[] {
  return Object.entries(run.blockedTimeByReasonSec)
    .filter(([, blockedSec]) => blockedSec > 0)
    .map(([reason]) => reason)
    .sort((left, right) => left.localeCompare(right));
}

function missingExpectedBottleneckPrefixes(run: Phase0ValidationRun, expectedPrefixes: string[]): string[] {
  const observed = observedBottleneckReasons(run);
  return expectedPrefixes.filter((prefix) => !observed.some((reason) => reason.startsWith(prefix)));
}

function hasReservationCoverageViolation(run: Phase0ValidationRun): boolean {
  return RESERVATION_COVERAGE_CODES.some((code) => run.physicalViolationsByCode[code] > 0);
}

function runStressOnce(
  spec: Phase0StressScenarioSpec,
  seed: number,
  durationSec: number
): Phase0StressRun {
  const scenario = { ...spec.scenario, seed, durationSec };
  const sim = new ShuttleSimCore(scenario);
  addStressStoredLoads(sim, spec.initialStoredNodeIds);
  sim.start();
  let maxObservedSpeedMps = 0;
  let maxObservedAccelerationMps2 = 0;
  let minVehicleSeparationM: number | null = null;
  let previousSpeeds = new Map<string, number>();
  let previousMovingVehicleIds = new Set<string>();
  let maxQueuedTasks = 0;
  let maxWaitingVehicles = 0;
  let maxLiftPortQueueLength = 0;
  const physicalViolationsByCode = emptyViolationCounts();
  const physicalViolationExamples: PhysicalViolationExample[] = [];

  while (sim.getState().status === 'running') {
    const state = sim.step(scenario.timeStepSec);
    const physical = inspectState(
      scenario,
      state,
      sim.getDebugState(),
      previousSpeeds,
      previousMovingVehicleIds,
      physicalViolationsByCode,
      physicalViolationExamples
    );
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, physical.maxObservedSpeedMps);
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, physical.maxObservedAccelerationMps2);
    maxQueuedTasks = Math.max(maxQueuedTasks, state.kpis.queuedTasks);
    maxWaitingVehicles = Math.max(maxWaitingVehicles, state.traffic.waitingVehicles.length);
    maxLiftPortQueueLength = Math.max(maxLiftPortQueueLength, 0, ...state.traffic.liftPorts.map((port) => port.queueLength));
    previousSpeeds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.speedMps]));
    previousMovingVehicleIds = new Set(state.vehicles.filter((vehicle) => vehicle.currentEdgeId).map((vehicle) => vehicle.id));
    minVehicleSeparationM =
      physical.minVehicleSeparationM === null
        ? minVehicleSeparationM
        : minVehicleSeparationM === null
          ? physical.minVehicleSeparationM
          : Math.min(minVehicleSeparationM, physical.minVehicleSeparationM);
  }

  const state = sim.getState();
  const eventLog = sim.getEventLog();
  const physicalViolationCount = Object.values(physicalViolationsByCode).reduce((sum, value) => sum + value, 0);
  const requestedTotalPph = scenario.taskGeneration.inboundRatePerHour + scenario.taskGeneration.outboundRatePerHour;
  const baseRun: Phase0ValidationRun = {
    seed,
    durationSec,
    status: state.status,
    eventLogHash: hashEventLog(eventLog),
    eventCount: eventLog.length,
    completedInbound: state.kpis.completedInbound,
    completedOutbound: state.kpis.completedOutbound,
    totalPph: state.kpis.totalPph,
    inboundPph: state.kpis.inboundPph,
    outboundPph: state.kpis.outboundPph,
    queuedTasks: state.kpis.queuedTasks,
    maxQueuedTasks,
    maxWaitingVehicles,
    maxLiftPortQueueLength,
    blockedTimeByReasonSec: state.kpis.blockedTimeByReasonSec,
    blockedTimeByCategorySec: categorizeBlockedTimeByReason(state.kpis.blockedTimeByReasonSec),
    reservationConflictCount: state.kpis.reservationConflictCount,
    deadlockCount: state.kpis.deadlockCount,
    maxObservedSpeedMps: round(maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(maxObservedAccelerationMps2),
    minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
    physicalViolationCount,
    physicalViolationsByCode,
    physicalViolationExamples
  };

  const observed = observedBottleneckReasons(baseRun);
  const missingExpected = missingExpectedBottleneckPrefixes(baseRun, spec.expectedBottleneckReasonPrefixes);
  return {
    ...baseRun,
    stressScenarioId: spec.id,
    label: spec.label,
    requestedInboundPph: scenario.taskGeneration.inboundRatePerHour,
    requestedOutboundPph: scenario.taskGeneration.outboundRatePerHour,
    requestedTotalPph,
    achievedTotalRatio: requestedTotalPph > 0 ? round(state.kpis.totalPph / requestedTotalPph, 6) : null,
    expectedBottleneckReasonPrefixes: spec.expectedBottleneckReasonPrefixes,
    observedBottleneckReasons: observed,
    expectedBottleneckObserved: missingExpected.length === 0,
    missingExpectedBottleneckReasonPrefixes: missingExpected
  };
}

function summarizeStressScenario(
  spec: Phase0StressScenarioSpec,
  seeds: number[],
  durationSec: number
): Phase0StressScenarioResult {
  const runs = seeds.map((seed) => runStressOnce(spec, seed, durationSec));
  const totalPphValues = runs.map((run) => run.totalPph);
  const observed = [...new Set(runs.flatMap((run) => run.observedBottleneckReasons))].sort((left, right) => left.localeCompare(right));
  const pass = runs.every((run) =>
    run.eventCount > 0 &&
    run.deadlockCount === 0 &&
    run.physicalViolationCount === 0 &&
    !hasReservationCoverageViolation(run) &&
    run.expectedBottleneckObserved &&
    (!spec.requiresPositiveThroughput || run.completedInbound + run.completedOutbound > 0)
  );

  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    durationSec,
    seeds,
    requestedInboundPph: spec.scenario.taskGeneration.inboundRatePerHour,
    requestedOutboundPph: spec.scenario.taskGeneration.outboundRatePerHour,
    requestedTotalPph: spec.scenario.taskGeneration.inboundRatePerHour + spec.scenario.taskGeneration.outboundRatePerHour,
    expectedBottleneckReasonPrefixes: spec.expectedBottleneckReasonPrefixes,
    requiresPositiveThroughput: spec.requiresPositiveThroughput,
    runs,
    totalPphMean: round(totalPphValues.reduce((sum, value) => sum + value, 0) / Math.max(1, totalPphValues.length)),
    maxQueuedTasks: Math.max(0, ...runs.map((run) => run.maxQueuedTasks)),
    maxWaitingVehicles: Math.max(0, ...runs.map((run) => run.maxWaitingVehicles)),
    maxLiftPortQueueLength: Math.max(0, ...runs.map((run) => run.maxLiftPortQueueLength)),
    observedBottleneckReasons: observed,
    blockedTimeByCategorySec: aggregateBottleneckBreakdowns(runs),
    pass
  };
}

function emptyStressResult(durationSec: number, seeds: number[]): Phase0ValidationResult['stress'] {
  return {
    durationSec,
    seeds,
    scenarios: [],
    pass: true,
    noStressDeadlocks: true,
    noStressPhysicalSafetyViolations: true,
    noStressReservationCoverageViolations: true,
    expectedBottlenecksObserved: true,
    positiveThroughputWhereRequired: true,
    blockedTimeByCategorySec: emptyBottleneckBreakdown()
  };
}

export function validatePhase0Scenario(
  scenario: ShuttleScenario,
  options: Phase0ValidationOptions = {}
): Phase0ValidationResult {
  const durationSec = options.durationSec ?? Math.min(240, scenario.durationSec);
  const longRunDurationSec = options.longRunDurationSec ?? 600;
  const repeatCount = options.repeatCount ?? 3;
  const sweepSeeds = options.sweepSeeds ?? [scenario.seed, scenario.seed + 1, scenario.seed + 2];
  const stressDurationSec = options.stressDurationSec ?? Math.min(180, scenario.durationSec);
  const stressSeeds = options.stressSeeds ?? [scenario.seed, scenario.seed + 11];
  const longRunThresholds = resolveLongRunThresholds(scenario, options.longRunThresholds);
  const layoutCalibrationReadiness = summarizeScenarioStaticSceneContract(scenario).calibrationReadiness;

  const repeatRuns = Array.from({ length: repeatCount }, () => runOnce(scenario, scenario.seed, durationSec));
  const hashes = repeatRuns.map((run) => run.eventLogHash);
  const seedSweepRuns = sweepSeeds.map((seed) => runOnce(scenario, seed, durationSec));
  const longRunRuns = sweepSeeds.map((seed) => runOnce(scenario, seed, longRunDurationSec));
  const stress = options.includeStress === false
    ? emptyStressResult(stressDurationSec, stressSeeds)
    : (() => {
      const scenarios = buildStressScenarioSpecs(scenario).map((spec) =>
        summarizeStressScenario(spec, stressSeeds, stressDurationSec)
      );
      const stressRuns = scenarios.flatMap((stressScenario) => stressScenario.runs);
      const noStressDeadlocks = stressRuns.every((run) => run.deadlockCount === 0);
      const noStressPhysicalSafetyViolations = stressRuns.every((run) => run.physicalViolationCount === 0);
      const noStressReservationCoverageViolations = stressRuns.every((run) => !hasReservationCoverageViolation(run));
      const expectedBottlenecksObserved = scenarios.every((stressScenario) =>
        stressScenario.runs.every((run) => run.expectedBottleneckObserved)
      );
      const positiveThroughputWhereRequired = scenarios.every((stressScenario) =>
        !stressScenario.requiresPositiveThroughput ||
        stressScenario.runs.every((run) => run.completedInbound + run.completedOutbound > 0)
      );
      return {
        durationSec: stressDurationSec,
        seeds: stressSeeds,
        scenarios,
        pass:
          scenarios.every((stressScenario) => stressScenario.pass) &&
          noStressDeadlocks &&
          noStressPhysicalSafetyViolations &&
          noStressReservationCoverageViolations &&
          expectedBottlenecksObserved &&
          positiveThroughputWhereRequired,
        noStressDeadlocks,
        noStressPhysicalSafetyViolations,
          noStressReservationCoverageViolations,
          expectedBottlenecksObserved,
          positiveThroughputWhereRequired,
          blockedTimeByCategorySec: aggregateBottleneckBreakdowns(stressRuns)
      };
    })();
  const allRuns = [
    ...repeatRuns,
    ...seedSweepRuns,
    ...longRunRuns,
    ...stress.scenarios.flatMap((stressScenario) => stressScenario.runs)
  ];
  const totalPphValues = seedSweepRuns.map((run) => run.totalPph);
  const longRunTotalPphValues = longRunRuns.map((run) => run.totalPph);
  const totalPphMin = Math.min(...totalPphValues);
  const totalPphMax = Math.max(...totalPphValues);
  const sameSeedEventHashStable = new Set(hashes).size === 1;
  const noDeadlocksInSweep = seedSweepRuns.every((run) => run.deadlockCount === 0);
  const eventLogsPresent = [...repeatRuns, ...seedSweepRuns].every((run) => run.eventCount > 0);
  const noPhysicalSafetyViolations = allRuns.every((run) => run.physicalViolationCount === 0);
  const noReservationCoverageViolations = allRuns.every((run) =>
    RESERVATION_COVERAGE_CODES.every((code) => run.physicalViolationsByCode[code] === 0)
  );
  const longRunEventLogsPresent = longRunRuns.every((run) => run.eventCount > 0);
  const longRunThroughputPositive = longRunRuns.every((run) => run.completedInbound + run.completedOutbound > 0 && run.totalPph > 0);
  const longRunThroughputFloorMet = longRunRuns.every(
    (run) => run.completedInbound + run.completedOutbound > 0 && run.totalPph >= longRunThresholds.minTotalPph
  );
  const longRunThroughputBySideMet = longRunRuns.every(
    (run) =>
      (scenario.taskGeneration.inboundRatePerHour <= 0 || (run.completedInbound > 0 && run.inboundPph >= longRunThresholds.minInboundPph)) &&
      (scenario.taskGeneration.outboundRatePerHour <= 0 || (run.completedOutbound > 0 && run.outboundPph >= longRunThresholds.minOutboundPph))
  );
  const longRunQueuesBounded = longRunRuns.every(
    (run) =>
      run.maxQueuedTasks <= longRunThresholds.maxQueuedTasks &&
      run.maxLiftPortQueueLength <= longRunThresholds.maxLiftPortQueueLength &&
      run.maxWaitingVehicles <= longRunThresholds.maxWaitingVehicles
  );
  const noLongRunDeadlocks = longRunRuns.every((run) => run.deadlockCount === 0);
  const noLongRunPhysicalSafetyViolations = longRunRuns.every((run) => run.physicalViolationCount === 0);
  const noLongRunReservationCoverageViolations = longRunRuns.every((run) =>
    RESERVATION_COVERAGE_CODES.every((code) => run.physicalViolationsByCode[code] === 0)
  );

  return {
    checkedAt: new Date().toISOString(),
    scenarioId: scenario.id,
    layoutCalibrationReadiness,
    deterministic: {
      seed: scenario.seed,
      repeatCount,
      pass: sameSeedEventHashStable,
      hashes
    },
    seedSweep: {
      seeds: sweepSeeds,
      durationSec,
      runs: seedSweepRuns,
      totalPphMean: round(totalPphValues.reduce((sum, value) => sum + value, 0) / Math.max(1, totalPphValues.length)),
      totalPphMin: round(totalPphMin),
      totalPphMax: round(totalPphMax),
      totalPphRange: round(totalPphMax - totalPphMin)
    },
    longRun: {
      seeds: sweepSeeds,
      durationSec: longRunDurationSec,
      runs: longRunRuns,
      thresholds: longRunThresholds,
      totalPphMean: round(longRunTotalPphValues.reduce((sum, value) => sum + value, 0) / Math.max(1, longRunTotalPphValues.length)),
      maxQueuedTasks: Math.max(0, ...longRunRuns.map((run) => run.maxQueuedTasks)),
      maxWaitingVehicles: Math.max(0, ...longRunRuns.map((run) => run.maxWaitingVehicles)),
      maxLiftPortQueueLength: Math.max(0, ...longRunRuns.map((run) => run.maxLiftPortQueueLength)),
      blockedTimeByCategorySec: aggregateBottleneckBreakdowns(longRunRuns)
    },
    stress,
    acceptance: {
      sameSeedEventHashStable,
      noDeadlocksInSweep,
      eventLogsPresent,
      noPhysicalSafetyViolations,
      noReservationCoverageViolations,
      longRunEventLogsPresent,
      longRunThroughputPositive,
      longRunThroughputFloorMet,
      longRunThroughputBySideMet,
      longRunQueuesBounded,
      noLongRunDeadlocks,
      noLongRunPhysicalSafetyViolations,
      noLongRunReservationCoverageViolations,
      stressPass: stress.pass,
      noStressDeadlocks: stress.noStressDeadlocks,
      noStressPhysicalSafetyViolations: stress.noStressPhysicalSafetyViolations,
      noStressReservationCoverageViolations: stress.noStressReservationCoverageViolations,
      expectedStressBottlenecksObserved: stress.expectedBottlenecksObserved,
      positiveStressThroughputWhereRequired: stress.positiveThroughputWhereRequired,
      pass:
        sameSeedEventHashStable &&
        noDeadlocksInSweep &&
        eventLogsPresent &&
        noPhysicalSafetyViolations &&
        noReservationCoverageViolations &&
        longRunEventLogsPresent &&
        longRunThroughputPositive &&
        longRunThroughputFloorMet &&
        longRunThroughputBySideMet &&
        longRunQueuesBounded &&
        noLongRunDeadlocks &&
        noLongRunPhysicalSafetyViolations &&
        noLongRunReservationCoverageViolations &&
        stress.pass
    }
  };
}
