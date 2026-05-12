import type { LoadStateRecord, Reservation, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import {
  ShuttleSimCore,
  calculateTravelTimeSec,
  createDefaultShuttleScenario,
  hashEventLog,
  summarizeScenarioStaticSceneContract,
  verticalStorageFootprintEdgeViolations,
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
  | 'travelTimeLowerBound'
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
  | 'liftSource'
  | 'vehicleFleet'
  | 'legacyReservation'
  | 'intersectionToken'
  | 'clearThrough'
  | 'segmentCapacity'
  | 'headway'
  | 'routing'
  | 'reservationControl'
  | 'other';

export type BottleneckBreakdown = Record<BottleneckCategory, number>;

export type ReservationAuditCode =
  | 'invalidReservationWindow'
  | 'resourceWindowOverlap'
  | 'selfWindowOverlap'
  | 'selfGrantSpanTooLong'
  | 'activeResourceOverlap'
  | 'staleReservation';

export type InventoryAuditCode =
  | 'duplicateLoadId'
  | 'invalidLoadLocation'
  | 'hiddenCompaction'
  | 'inboundFifoFillGap';

export type RoutingAuditCode =
  | 'crossRowStorageHop'
  | 'verticalStorageFootprintEdge';

export type AuditExample<Code extends string> = {
  code: Code;
  timeSec: number;
  observed?: number | string;
  limit?: number | string;
  vehicleIds?: string[];
  loadId?: string;
  nodeId?: string;
  resourceType?: Reservation['resourceType'];
  resourceId?: string;
  message: string;
};

export type AuditSummary<Code extends string> = {
  pass: boolean;
  violationCount: number;
  violationsByCode: Record<Code, number>;
  examples: Array<AuditExample<Code>>;
  warningCount: number;
  warningsByCode: Record<Code, number>;
  warningExamples: Array<AuditExample<Code>>;
};

export type IeBehaviorAudit = {
  pass: boolean;
  reservation: AuditSummary<ReservationAuditCode>;
  inventory: AuditSummary<InventoryAuditCode>;
  routing: AuditSummary<RoutingAuditCode>;
};

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
  blockedTimeByCategorySec: BottleneckBreakdown;
  dominantBottleneckCategory: BottleneckCategory | null;
  queueGrowthTasksPerMin: number;
  averageTaskWaitSec: number;
  p95TaskWaitSec: number;
  reservationConflictCount: number;
  deadlockCount: number;
  livelockCount: number;
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationCount: number;
  physicalViolationsByCode: Record<PhysicalViolationCode, number>;
  physicalViolationExamples: PhysicalViolationExample[];
  ieBehaviorAudit: IeBehaviorAudit;
};

export type Phase0StressRun = Phase0ValidationRun & {
  stressScenarioId: string;
  label: string;
  requestedInboundPph: number;
  requestedOutboundPph: number;
  requestedTotalPph: number;
  achievedTotalRatio: number | null;
  expectedBottleneckReasonPrefixes: string[];
  expectedDominantBottleneckCategories: BottleneckCategory[];
  observedBottleneckReasons: string[];
  expectedBottleneckObserved: boolean;
  expectedDominantBottleneckObserved: boolean;
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
  expectedDominantBottleneckCategories: BottleneckCategory[];
  requiresPositiveThroughput: boolean;
  runs: Phase0StressRun[];
  totalPphMean: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
  observedBottleneckReasons: string[];
  observedDominantBottleneckCategories: Array<BottleneckCategory | null>;
  blockedTimeByCategorySec: BottleneckBreakdown;
  theoreticalFleetPphMean: number | null;
  achievedInboundVsTheoryPctMean: number | null;
  inboundPphGapToTheoryMean: number | null;
  averageVehicleUtilizationPctMean: number;
  averageVehicleProductivePctMean: number;
  averageVehicleWaitingPctMean: number;
  averageVehicleIdlePctMean: number;
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
    noStressIeBehaviorAuditViolations: boolean;
    expectedBottlenecksObserved: boolean;
    expectedDominantBottlenecksObserved: boolean;
    positiveThroughputWhereRequired: boolean;
    blockedTimeByCategorySec: BottleneckBreakdown;
  };
  acceptance: {
    sameSeedEventHashStable: boolean;
    noDeadlocksInSweep: boolean;
    noLivelocksInSweep: boolean;
    eventLogsPresent: boolean;
    noPhysicalSafetyViolations: boolean;
    noReservationCoverageViolations: boolean;
    noIeBehaviorAuditViolations: boolean;
    longRunEventLogsPresent: boolean;
    longRunThroughputPositive: boolean;
    longRunThroughputFloorMet: boolean;
    longRunThroughputBySideMet: boolean;
    longRunQueuesBounded: boolean;
    noLongRunDeadlocks: boolean;
    noLongRunLivelocks: boolean;
    noLongRunPhysicalSafetyViolations: boolean;
    noLongRunReservationCoverageViolations: boolean;
    noLongRunIeBehaviorAuditViolations: boolean;
    stressPass: boolean;
    noStressDeadlocks: boolean;
    noStressPhysicalSafetyViolations: boolean;
    noStressReservationCoverageViolations: boolean;
    noStressIeBehaviorAuditViolations: boolean;
    expectedStressBottlenecksObserved: boolean;
    expectedStressDominantBottlenecksObserved: boolean;
    positiveStressThroughputWhereRequired: boolean;
    flowDebugObservationPass: boolean;
    segmentSafeValidationPass: boolean;
    ieValidationPass: boolean;
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
  ieBehaviorAudit: IeBehaviorAudit;
};

const VIOLATION_CODES: PhysicalViolationCode[] = [
  'unreservedEdgeOccupancy',
  'unreservedNodeOccupancy',
  'unreservedZoneOccupancy',
  'nodeOccupancyMismatch',
  'edgeOccupancyMismatch',
  'speedLimit',
  'accelerationLimit',
  'travelTimeLowerBound',
  'minSeparation',
  'invalidCoordinate'
];
const RESERVATION_AUDIT_CODES: ReservationAuditCode[] = [
  'invalidReservationWindow',
  'resourceWindowOverlap',
  'selfWindowOverlap',
  'selfGrantSpanTooLong',
  'activeResourceOverlap',
  'staleReservation'
];
const INVENTORY_AUDIT_CODES: InventoryAuditCode[] = [
  'duplicateLoadId',
  'invalidLoadLocation',
  'hiddenCompaction',
  'inboundFifoFillGap'
];
const ROUTING_AUDIT_CODES: RoutingAuditCode[] = [
  'crossRowStorageHop',
  'verticalStorageFootprintEdge'
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
  'liftSource',
  'vehicleFleet',
  'legacyReservation',
  'intersectionToken',
  'clearThrough',
  'segmentCapacity',
  'headway',
  'routing',
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
  if (reason === 'inbound-lift-source-full' || reason === 'outbound-lift-unavailable') return 'liftSource';
  if (reason === 'vehicle-unavailable') return 'vehicleFleet';
  if (reason === 'zone-hold' || reason === 'legacy-zone-reserved') return 'legacyReservation';
  if (reason === 'zone-reserved') return 'intersectionToken';
  if (reason === 'min-separation') return 'headway';
  if (reason === 'no-stop-continuation-blocked' || reason === 'no-stop-clearance-incomplete') return 'clearThrough';
  if (reason === 'route-unavailable' || reason === 'route-edge-missing') return 'routing';
  if (
    reason === 'edge-reserved' ||
    reason === 'node-reserved' ||
    reason === 'opposite-direction' ||
    reason === 'node-occupied' ||
    reason === 'node-occupancy-mismatch'
  ) return 'segmentCapacity';
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

function dominantBottleneckCategory(breakdown: BottleneckBreakdown): BottleneckCategory | null {
  const [dominant] = BOTTLENECK_CATEGORIES
    .map((category) => ({ category, blockedSec: breakdown[category] }))
    .filter((entry) => entry.blockedSec > 0)
    .sort((left, right) => right.blockedSec - left.blockedSec || left.category.localeCompare(right.category));
  return dominant?.category ?? null;
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
    liftTimeSec: Math.min(scenario.physicsParams.liftTimeSec, 0.01),
    lowerTimeSec: Math.min(scenario.physicsParams.lowerTimeSec, 0.01),
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
  expectedDominantBottleneckCategories: BottleneckCategory[];
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
      expectedDominantBottleneckCategories: ['fifoLane', 'storageInventory', 'sideAisleNetwork', 'intersectionToken', 'clearThrough', 'segmentCapacity', 'headway', 'routing'],
      requiresPositiveThroughput: true
    },
    {
      id: 'inbound-only-saturation',
      label: 'Inbound-only saturation',
      description: 'All demand enters from dedicated inbound lifts so the shuttle fleet, lift-port queues, and local traffic admission must absorb the pressure without overbooking the dense FIFO grid.',
      scenario: scenarioWithOperationalStressParams(baseScenario, {
        ...common,
        layout: createDefaultShuttleScenario({ liftMode: 'all-inbound' }).layout,
        vehicles: { count: 8 },
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
      expectedDominantBottleneckCategories: ['vehicleFleet', 'intersectionToken', 'clearThrough', 'segmentCapacity', 'headway'],
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
      expectedDominantBottleneckCategories: ['storageInventory'],
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
      expectedDominantBottleneckCategories: ['fifoLane'],
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
      expectedDominantBottleneckCategories: ['storageInventory', 'fifoLane', 'intersectionToken', 'clearThrough', 'segmentCapacity', 'headway'],
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

function emptyAuditSummary<Code extends string>(codes: Code[]): AuditSummary<Code> {
  return {
    pass: true,
    violationCount: 0,
    violationsByCode: Object.fromEntries(codes.map((code) => [code, 0])) as Record<Code, number>,
    examples: [],
    warningCount: 0,
    warningsByCode: Object.fromEntries(codes.map((code) => [code, 0])) as Record<Code, number>,
    warningExamples: []
  };
}

function addAuditViolation<Code extends string>(summary: AuditSummary<Code>, example: AuditExample<Code>): void {
  summary.pass = false;
  summary.violationCount += 1;
  summary.violationsByCode[example.code] += 1;
  if (summary.examples.length < EXAMPLE_LIMIT) {
    summary.examples.push(example);
  }
}

function addAuditWarning<Code extends string>(summary: AuditSummary<Code>, example: AuditExample<Code>): void {
  summary.warningCount += 1;
  summary.warningsByCode[example.code] += 1;
  if (summary.warningExamples.length < EXAMPLE_LIMIT) {
    summary.warningExamples.push(example);
  }
}

function isActive(reservation: Reservation, timeSec: number): boolean {
  return reservation.startTimeSec <= timeSec + 1e-6 && timeSec <= reservation.endTimeSec + 1e-6;
}

function reservationWindowsOverlap(left: Reservation, right: Reservation): boolean {
  return left.startTimeSec <= right.endTimeSec + 1e-6 && right.startTimeSec <= left.endTimeSec + 1e-6;
}

function isPortalNodeZone(zone: ShuttleScenario['layout']['zones'][number]): boolean {
  return zone.id.startsWith('zone-main-portal-node-') && zone.nodeIds.length === 2 && zone.edgeIds.length > 0;
}

function zoneFootprintNodeIds(
  scenario: ShuttleScenario,
  zone: ShuttleScenario['layout']['zones'][number],
  vehicle: VehicleState
): Set<string> {
  const footprint = new Set<string>();
  if (vehicle.currentEdgeId) {
    const edge = edgeById(scenario, vehicle.currentEdgeId);
    if (edge && zone.edgeIds.includes(edge.id)) {
      if (zone.nodeIds.includes(edge.from)) footprint.add(edge.from);
      if (zone.nodeIds.includes(edge.to)) footprint.add(edge.to);
      return footprint;
    }
    if (zone.nodeIds.includes(vehicle.currentNodeId)) footprint.add(vehicle.currentNodeId);
    if (vehicle.targetNodeId && zone.nodeIds.includes(vehicle.targetNodeId)) footprint.add(vehicle.targetNodeId);
    return footprint;
  }
  if (zone.nodeIds.includes(vehicle.currentNodeId)) {
    footprint.add(vehicle.currentNodeId);
  }
  return footprint;
}

function zoneReservationsArePhysicallyDisjoint(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  zone: ShuttleScenario['layout']['zones'][number],
  left: Reservation,
  right: Reservation
): boolean {
  if (!isPortalNodeZone(zone)) return false;
  const leftVehicle = state.vehicles.find((vehicle) => vehicle.id === left.vehicleId);
  const rightVehicle = state.vehicles.find((vehicle) => vehicle.id === right.vehicleId);
  if (!leftVehicle || !rightVehicle) return false;
  const leftFootprint = zoneFootprintNodeIds(scenario, zone, leftVehicle);
  const rightFootprint = zoneFootprintNodeIds(scenario, zone, rightVehicle);
  if (
    (leftFootprint.size === 0 && left.reasonCode === 'zone-reservation') ||
    (rightFootprint.size === 0 && right.reasonCode === 'zone-reservation')
  ) {
    return true;
  }
  if (leftFootprint.size === 0 || rightFootprint.size === 0) return false;
  return [...leftFootprint].every((nodeId) => !rightFootprint.has(nodeId));
}

function reservationsConflictForAudit(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  left: Reservation,
  right: Reservation
): boolean {
  if (left.vehicleId === right.vehicleId) return false;
  if (left.resourceType !== right.resourceType) return false;
  const sameResource = left.resourceId === right.resourceId;
  const sameZoneConflictGroup =
    left.resourceType === 'zone' &&
    left.conflictGroup !== null &&
    right.conflictGroup !== null &&
    left.conflictGroup === right.conflictGroup;
  if (!sameResource && !sameZoneConflictGroup) return false;
  if (sameResource && left.resourceType === 'zone') {
    const zone = scenario.layout.zones.find((candidate) => candidate.id === left.resourceId);
    if (zone && zoneReservationsArePhysicallyDisjoint(scenario, state, zone, left, right)) {
      return false;
    }
  }
  return true;
}

function reservationWindowsConflictForAudit(left: Reservation, right: Reservation): boolean {
  if (left.id === right.id) return false;
  if (left.vehicleId === right.vehicleId) return false;
  const sameResource = left.resourceType === right.resourceType && left.resourceId === right.resourceId;
  const sameZoneConflictGroup =
    left.resourceType === 'zone' &&
    right.resourceType === 'zone' &&
    left.conflictGroup !== null &&
    right.conflictGroup !== null &&
    left.conflictGroup === right.conflictGroup;
  return (sameResource || sameZoneConflictGroup) && reservationWindowsOverlap(left, right);
}

function reservationWindowCoversForAudit(covering: Reservation, covered: Reservation): boolean {
  return covering.startTimeSec <= covered.startTimeSec + 1e-6 && covering.endTimeSec >= covered.endTimeSec - 1e-6;
}

function selfReservationWindowsPartiallyOverlapForAudit(left: Reservation, right: Reservation): boolean {
  if (left.id === right.id) return false;
  if (left.vehicleId !== right.vehicleId) return false;
  const sameResource = left.resourceType === right.resourceType && left.resourceId === right.resourceId;
  return (
    sameResource &&
    reservationWindowsOverlap(left, right) &&
    !reservationWindowCoversForAudit(left, right) &&
    !reservationWindowCoversForAudit(right, left)
  );
}

function speedForTraversalLimit(scenario: ShuttleScenario): number {
  return Math.max(
    0.001,
    Math.min(scenario.physicsParams.emptySpeedMps, scenario.physicsParams.loadedSpeedMps)
  );
}

function edgeTraversalLimitSec(
  scenario: ShuttleScenario,
  edge: ShuttleScenario['layout']['edges'][number]
): number {
  const emptySpeed = Math.min(edge.speedLimitEmptyMps ?? scenario.physicsParams.emptySpeedMps, scenario.physicsParams.emptySpeedMps);
  const loadedSpeed = Math.min(edge.speedLimitLoadedMps ?? scenario.physicsParams.loadedSpeedMps, scenario.physicsParams.loadedSpeedMps);
  return calculateTravelTimeSec(
    edge.lengthM,
    Math.max(0.001, Math.min(emptySpeed, loadedSpeed, speedForTraversalLimit(scenario))),
    scenario.physicsParams.accelerationMps2
  );
}

function reservationSpanLimitSec(scenario: ShuttleScenario, reservation: Reservation): number | null {
  let traversalLimitSec = 0;
  if (reservation.resourceType === 'edge') {
    const edge = scenario.layout.edges.find((candidate) => candidate.id === reservation.resourceId);
    if (!edge) return null;
    traversalLimitSec = edgeTraversalLimitSec(scenario, edge);
  } else if (reservation.resourceType === 'node') {
    const incidentEdges = scenario.layout.edges.filter(
      (edge) => edge.from === reservation.resourceId || edge.to === reservation.resourceId
    );
    traversalLimitSec = Math.max(0, ...incidentEdges.map((edge) => edgeTraversalLimitSec(scenario, edge)));
  } else {
    const zone = scenario.layout.zones.find((candidate) => candidate.id === reservation.resourceId);
    if (!zone) return null;
    const edgeIds = new Set(zone.edgeIds);
    if (edgeIds.size === 0) {
      for (const nodeId of zone.nodeIds) {
        for (const edge of scenario.layout.edges) {
          if (edge.from === nodeId || edge.to === nodeId) {
            edgeIds.add(edge.id);
          }
        }
      }
    }
    const zoneEdges = scenario.layout.edges.filter((edge) => edgeIds.has(edge.id));
    traversalLimitSec = zoneEdges.reduce((sum, edge) => sum + edgeTraversalLimitSec(scenario, edge), 0);
  }

  const marginSec = Math.max(1, scenario.timeStepSec * 3);
  return Math.max(5, traversalLimitSec + scenario.trafficPolicy.minimumClearanceSec + marginSec);
}

function inspectReservationAudit(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  summary: AuditSummary<ReservationAuditCode>
): void {
  const byResource = new Map<string, Reservation[]>();
  for (const reservation of state.reservations) {
    if (reservation.endTimeSec + 1e-6 < reservation.startTimeSec) {
      addAuditViolation(summary, {
        code: 'invalidReservationWindow',
        timeSec: state.simTimeSec,
        resourceType: reservation.resourceType,
        resourceId: reservation.resourceId,
        observed: `${reservation.startTimeSec}-${reservation.endTimeSec}`,
        message: 'Reservation end time is before start time.'
      });
    }
    if (reservation.endTimeSec < state.simTimeSec - 1.01) {
      addAuditViolation(summary, {
        code: 'staleReservation',
        timeSec: state.simTimeSec,
        resourceType: reservation.resourceType,
        resourceId: reservation.resourceId,
        vehicleIds: [reservation.vehicleId],
        observed: reservation.endTimeSec,
        limit: state.simTimeSec,
        message: 'Expired reservation remained in the active reservation set beyond the cleanup grace window.'
      });
    }
    const spanLimitSec = reservationSpanLimitSec(scenario, reservation);
    const observedSpanSec = reservation.endTimeSec - reservation.startTimeSec;
    if (spanLimitSec !== null && observedSpanSec > spanLimitSec + 1e-6) {
      addAuditWarning(summary, {
        code: 'selfGrantSpanTooLong',
        timeSec: state.simTimeSec,
        resourceType: reservation.resourceType,
        resourceId: reservation.resourceId,
        vehicleIds: [reservation.vehicleId],
        observed: round(observedSpanSec),
        limit: round(spanLimitSec),
        message: 'Reservation window is wider than the expected traversal, clearance, and tick margin for this resource.'
      });
    }
    const key = reservation.resourceType === 'zone' && reservation.conflictGroup
      ? `zone-conflict:${reservation.conflictGroup}`
      : `${reservation.resourceType}:${reservation.resourceId}`;
    const bucket = byResource.get(key) ?? [];
    bucket.push(reservation);
    byResource.set(key, bucket);
  }

  for (const reservations of byResource.values()) {
    const activeReservations = reservations.filter((reservation) => isActive(reservation, state.simTimeSec));
    for (let leftIndex = 0; leftIndex < activeReservations.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < activeReservations.length; rightIndex += 1) {
        const left = activeReservations[leftIndex]!;
        const right = activeReservations[rightIndex]!;
        if (!reservationsConflictForAudit(scenario, state, left, right)) continue;
        addAuditViolation(summary, {
          code: 'activeResourceOverlap',
          timeSec: state.simTimeSec,
          resourceType: left.resourceType,
          resourceId: left.resourceId,
          vehicleIds: [left.vehicleId, right.vehicleId].sort(),
          observed: 2,
          limit: 1,
          message: 'Multiple vehicles hold an active reservation on a single-capacity resource.'
        });
      }
    }

    for (let leftIndex = 0; leftIndex < reservations.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < reservations.length; rightIndex += 1) {
        const left = reservations[leftIndex]!;
        const right = reservations[rightIndex]!;
        if (!reservationWindowsConflictForAudit(left, right)) continue;
        addAuditViolation(summary, {
          code: 'resourceWindowOverlap',
          timeSec: state.simTimeSec,
          resourceType: left.resourceType,
          resourceId: left.resourceId,
          vehicleIds: [left.vehicleId, right.vehicleId].sort(),
          observed: `${round(left.startTimeSec)}-${round(left.endTimeSec)} vs ${round(right.startTimeSec)}-${round(right.endTimeSec)}`,
          limit: 'non-overlapping single-capacity windows',
          message: 'Reservation time windows overlap for different vehicles on a single-capacity resource or conflict group.'
        });
      }
    }

    for (let leftIndex = 0; leftIndex < reservations.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < reservations.length; rightIndex += 1) {
        const left = reservations[leftIndex]!;
        const right = reservations[rightIndex]!;
        if (!selfReservationWindowsPartiallyOverlapForAudit(left, right)) continue;
        addAuditViolation(summary, {
          code: 'selfWindowOverlap',
          timeSec: state.simTimeSec,
          resourceType: left.resourceType,
          resourceId: left.resourceId,
          vehicleIds: [left.vehicleId],
          observed: `${round(left.startTimeSec)}-${round(left.endTimeSec)} vs ${round(right.startTimeSec)}-${round(right.endTimeSec)}`,
          limit: 'self windows must be disjoint or one must fully cover the other',
          message: 'A vehicle has partially overlapping self reservations on one resource, which can hide grant bookkeeping errors.'
        });
      }
    }
  }
}

function storageGridPosition(nodeId: string): { row: number; column: number } | null {
  const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
  return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
}

function storageLanes(scenario: ShuttleScenario): ShuttleScenario['layout']['nodes'][] {
  const laneByRow = new Map<number, ShuttleScenario['layout']['nodes']>();
  for (const node of scenario.layout.nodes) {
    const position = storageGridPosition(node.id);
    if (!position) continue;
    const lane = laneByRow.get(position.row) ?? [];
    lane.push(node);
    laneByRow.set(position.row, lane);
  }
  return [...laneByRow.entries()]
    .sort(([leftRow], [rightRow]) => leftRow - rightRow)
    .map(([, lane]) => lane.sort((left, right) => {
      const leftPosition = storageGridPosition(left.id);
      const rightPosition = storageGridPosition(right.id);
      return (leftPosition?.column ?? 0) - (rightPosition?.column ?? 0) || left.id.localeCompare(right.id);
    }));
}

function inspectInventoryAudit(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  previousLoads: Map<string, LoadStateRecord>,
  summary: AuditSummary<InventoryAuditCode>
): void {
  const loadIds = new Set<string>();
  const vehicleIds = new Set(state.vehicles.map((vehicle) => vehicle.id));
  for (const load of state.loads) {
    if (loadIds.has(load.id)) {
      addAuditViolation(summary, {
        code: 'duplicateLoadId',
        timeSec: state.simTimeSec,
        loadId: load.id,
        message: 'A load id appeared more than once in the simulation state.'
      });
    }
    loadIds.add(load.id);

    const validLocation =
      (load.state === 'waiting' && load.nodeId !== null && load.vehicleId === null) ||
      (load.state === 'stored' && load.nodeId !== null && load.vehicleId === null) ||
      (load.state === 'carried' && load.nodeId === null && load.vehicleId !== null && vehicleIds.has(load.vehicleId)) ||
      (load.state === 'delivered' && load.nodeId !== null && load.vehicleId === null);
    if (!validLocation) {
      addAuditViolation(summary, {
        code: 'invalidLoadLocation',
        timeSec: state.simTimeSec,
        loadId: load.id,
        nodeId: load.nodeId ?? undefined,
        vehicleIds: load.vehicleId ? [load.vehicleId] : undefined,
        observed: `${load.state}:${load.nodeId ?? 'no-node'}:${load.vehicleId ?? 'no-vehicle'}`,
        message: 'Load state and physical location are inconsistent.'
      });
    }

    const previous = previousLoads.get(load.id);
    if (previous?.state === 'stored' && load.state === 'stored' && previous.nodeId !== load.nodeId) {
      addAuditViolation(summary, {
        code: 'hiddenCompaction',
        timeSec: state.simTimeSec,
        loadId: load.id,
        nodeId: load.nodeId ?? undefined,
        observed: `${previous.nodeId ?? 'none'} -> ${load.nodeId ?? 'none'}`,
        message: 'Stored load moved between storage nodes without an explicit carried phase.'
      });
    }
  }

  if (scenario.taskGeneration.outboundRatePerHour <= 0) {
    const occupiedStorageNodes = new Set(
      state.loads
        .filter((load) => load.state === 'stored' && load.nodeId !== null && storageGridPosition(load.nodeId) !== null)
        .map((load) => load.nodeId!)
    );
    for (const lane of storageLanes(scenario)) {
      let sawEmpty = false;
      for (const node of lane) {
        const occupied = occupiedStorageNodes.has(node.id);
        if (!occupied) {
          sawEmpty = true;
          continue;
        }
        if (sawEmpty) {
          addAuditViolation(summary, {
            code: 'inboundFifoFillGap',
            timeSec: state.simTimeSec,
            nodeId: node.id,
            message: 'Inbound-only storage row contains an occupied cell after an empty outfeed-side gap.'
          });
          break;
        }
      }
    }
  }
}

function storageHopViolation(
  scenario: ShuttleScenario,
  fromNodeId: string,
  toNodeId: string
): { edgeId: string | null; fromRow: number; toRow: number } | null {
  const from = storageGridPosition(fromNodeId);
  const to = storageGridPosition(toNodeId);
  if (!from || !to || from.row === to.row) return null;
  return {
    edgeId: edgeByIdForRouteHop(scenario, fromNodeId, toNodeId)?.id ?? null,
    fromRow: from.row,
    toRow: to.row
  };
}

function edgeByIdForRouteHop(
  scenario: ShuttleScenario,
  fromNodeId: string,
  toNodeId: string
): ShuttleScenario['layout']['edges'][number] | undefined {
  return scenario.layout.edges.find((edge) =>
    (edge.from === fromNodeId && edge.to === toNodeId) ||
    (edge.directionMode === 'twoWay' && edge.from === toNodeId && edge.to === fromNodeId)
  );
}

function inspectRoutingAudit(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  forbiddenFootprintEdges: Set<string>,
  summary: AuditSummary<RoutingAuditCode>
): void {
  for (const vehicle of state.vehicles) {
    if (vehicle.currentEdgeId && forbiddenFootprintEdges.has(vehicle.currentEdgeId)) {
      addAuditViolation(summary, {
        code: 'verticalStorageFootprintEdge',
        timeSec: state.simTimeSec,
        vehicleIds: [vehicle.id],
        resourceType: 'edge',
        resourceId: vehicle.currentEdgeId,
        message: 'Vehicle is traversing a vertical edge that cuts through storage-cell footprint.'
      });
    }

    const route = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
    for (let index = 1; index < route.length; index += 1) {
      const fromNodeId = route[index - 1]!;
      const toNodeId = route[index]!;
      const hopViolation = storageHopViolation(scenario, fromNodeId, toNodeId);
      if (hopViolation) {
        addAuditViolation(summary, {
          code: 'crossRowStorageHop',
          timeSec: state.simTimeSec,
          vehicleIds: [vehicle.id],
          resourceType: hopViolation.edgeId ? 'edge' : undefined,
          resourceId: hopViolation.edgeId ?? undefined,
          observed: `${fromNodeId}->${toNodeId}`,
          limit: 'same FIFO row while inside storage cells',
          message: `Route jumps from storage row ${hopViolation.fromRow} to ${hopViolation.toRow}; storage-area travel must stay horizontal.`
        });
      }
    }
  }
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

function requiresStrictReservationCoverage(state: ShuttleSimState): boolean {
  const traffic = state.traffic as ShuttleSimState['traffic'] & {
    trafficMode?: 'flow-debug' | 'segment-safe' | 'agent-simple' | 'agent-minimal';
    safetyValidated?: boolean;
  };
  return traffic.safetyValidated === true || traffic.trafficMode === 'segment-safe';
}

function nodeById(scenario: ShuttleScenario, nodeId: string): ShuttleScenario['layout']['nodes'][number] | undefined {
  return scenario.layout.nodes.find((node) => node.id === nodeId);
}

function edgeById(scenario: ShuttleScenario, edgeId: string): ShuttleScenario['layout']['edges'][number] | undefined {
  return scenario.layout.edges.find((edge) => edge.id === edgeId);
}

function vehicleSpeedLimitMps(
  scenario: ShuttleScenario,
  vehicle: Pick<VehicleState, 'loaded' | 'currentEdgeId'>
): number {
  const scenarioLimit = vehicle.loaded ? scenario.physicsParams.loadedSpeedMps : scenario.physicsParams.emptySpeedMps;
  if (!vehicle.currentEdgeId) return scenarioLimit;
  const edge = edgeById(scenario, vehicle.currentEdgeId);
  const edgeLimit = vehicle.loaded ? edge?.speedLimitLoadedMps : edge?.speedLimitEmptyMps;
  return Math.min(scenarioLimit, edgeLimit ?? scenarioLimit);
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
  previousEdgeIds: Map<string, string | null>,
  counts: Record<PhysicalViolationCode, number>,
  examples: PhysicalViolationExample[],
  options: { requireReservationCoverage: boolean; requireMotionSafety: boolean }
): {
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
} {
  let maxObservedSpeedMps = 0;
  let maxObservedAccelerationMps2 = 0;
  let minVehicleSeparationM: number | null = null;
  const occupancyByNode = new Map(debug.currentNodeOccupancy.map((entry) => [entry.nodeId, entry.vehicleId]));

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

    const speedLimitMps = vehicleSpeedLimitMps(scenario, vehicle);
    if (options.requireMotionSafety && vehicle.speedMps > speedLimitMps + 1e-6) {
      addViolation(counts, examples, {
        code: 'speedLimit',
        timeSec,
        vehicleIds: [vehicle.id],
        observed: round(vehicle.speedMps),
        limit: speedLimitMps,
        message: `Vehicle speed exceeded configured ${vehicle.loaded ? 'loaded' : 'empty'} Phase 0 speed limit.`
      });
    }

    const previousSpeed = previousSpeeds.get(vehicle.id) ?? vehicle.speedMps;
    const accelerationMps2 = Math.abs(vehicle.speedMps - previousSpeed) / scenario.timeStepSec;
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, accelerationMps2);
    const previousEdgeId = previousEdgeIds.get(vehicle.id) ?? null;
    const currentEdgeId = vehicle.currentEdgeId ?? null;
    const isStartArrivalOrEdgeTransition = previousEdgeId !== currentEdgeId;
    const isLegStart = currentEdgeId !== null && vehicle.legElapsedSec <= scenario.timeStepSec + 1e-6;
    if (
      options.requireMotionSafety &&
      !isStartArrivalOrEdgeTransition &&
      !isLegStart &&
      accelerationMps2 > scenario.physicsParams.accelerationMps2 + 1e-6
    ) {
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
      if (edge) {
        const straightLineLowerBoundSec = edge.lengthM / Math.max(0.001, speedLimitMps);
        if (options.requireMotionSafety && vehicle.legTravelSec + 1e-6 < straightLineLowerBoundSec) {
          addViolation(counts, examples, {
            code: 'travelTimeLowerBound',
            timeSec,
            vehicleIds: [vehicle.id],
            edgeId: vehicle.currentEdgeId,
            observed: round(vehicle.legTravelSec),
            limit: round(straightLineLowerBoundSec),
            message: 'Vehicle leg travel time is shorter than distance divided by its configured speed limit.'
          });
        }
      }
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
      if (
        options.requireReservationCoverage &&
        !activeReservation(state, { timeSec, vehicleId: vehicle.id, resourceType: 'edge', resourceId: vehicle.currentEdgeId })
      ) {
        addViolation(counts, examples, {
          code: 'unreservedEdgeOccupancy',
          timeSec,
          vehicleIds: [vehicle.id],
          edgeId: vehicle.currentEdgeId,
          message: 'Moving vehicle does not have an active edge reservation.'
        });
      }
      if (
        options.requireReservationCoverage &&
        vehicle.targetNodeId &&
        !activeReservation(state, { timeSec, vehicleId: vehicle.id, resourceType: 'node', resourceId: vehicle.targetNodeId })
      ) {
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

    if (options.requireReservationCoverage) {
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
  }

  for (let leftIndex = 0; leftIndex < state.vehicles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < state.vehicles.length; rightIndex += 1) {
      const left = state.vehicles[leftIndex]!;
      const right = state.vehicles[rightIndex]!;
      const separationM = Math.hypot(left.x - right.x, left.z - right.z);
      minVehicleSeparationM = minVehicleSeparationM === null ? separationM : Math.min(minVehicleSeparationM, separationM);
      if (options.requireMotionSafety && vehicleFootprintsOverlap(left, right, scenario.vehicles)) {
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
  const ieBehaviorAudit = emptyIeBehaviorAudit();
  const forbiddenFootprintEdges = new Set(verticalStorageFootprintEdgeViolations(scenario).map((violation) => violation.edgeId));
  inspectIeBehaviorAudit(scenario, state, loadSnapshot(state.loads), forbiddenFootprintEdges, ieBehaviorAudit);
  const physical = inspectState(
    scenario,
    state,
    debug,
    previousSpeeds,
    new Map(),
    physicalViolationsByCode,
    physicalViolationExamples,
    { requireReservationCoverage: true, requireMotionSafety: true }
  );

  return {
    maxObservedSpeedMps: round(physical.maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(physical.maxObservedAccelerationMps2),
    minVehicleSeparationM: physical.minVehicleSeparationM === null ? null : round(physical.minVehicleSeparationM),
    physicalViolationsByCode,
    physicalViolationExamples,
    ieBehaviorAudit
  };
}

function emptyIeBehaviorAudit(): IeBehaviorAudit {
  const reservation = emptyAuditSummary(RESERVATION_AUDIT_CODES);
  const inventory = emptyAuditSummary(INVENTORY_AUDIT_CODES);
  const routing = emptyAuditSummary(ROUTING_AUDIT_CODES);
  return {
    pass: true,
    reservation,
    inventory,
    routing
  };
}

function loadSnapshot(loads: LoadStateRecord[]): Map<string, LoadStateRecord> {
  return new Map(loads.map((load) => [load.id, structuredClone(load)]));
}

function inspectIeBehaviorAudit(
  scenario: ShuttleScenario,
  state: ShuttleSimState,
  previousLoads: Map<string, LoadStateRecord>,
  forbiddenFootprintEdges: Set<string>,
  audit: IeBehaviorAudit
): void {
  inspectReservationAudit(scenario, state, audit.reservation);
  inspectInventoryAudit(scenario, state, previousLoads, audit.inventory);
  inspectRoutingAudit(scenario, state, forbiddenFootprintEdges, audit.routing);
  audit.pass = audit.reservation.pass && audit.inventory.pass && audit.routing.pass;
}

function runPhysicalViolationCount(counts: Record<PhysicalViolationCode, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function runQueueGrowthTasksPerMin(state: ShuttleSimState, durationSec: number): number {
  return durationSec > 0 ? round((state.kpis.queuedTasks / durationSec) * 60, 4) : 0;
}

function p95TaskWaitSec(state: ShuttleSimState): number {
  const waits = state.tasks
    .map((task) => {
      const waitUntilSec = task.assignedAtSec ?? task.startedAtSec ?? task.completedAtSec ?? state.simTimeSec;
      return Math.max(0, waitUntilSec - task.createdAtSec);
    })
    .sort((left, right) => left - right);
  if (waits.length === 0) return 0;
  return round(waits[Math.min(waits.length - 1, Math.ceil(waits.length * 0.95) - 1)] ?? 0);
}

function utilizationAverages(state: ShuttleSimState): Pick<
  Phase0ValidationRun,
  'averageVehicleUtilizationPct' | 'averageVehicleProductivePct' | 'averageVehicleWaitingPct' | 'averageVehicleIdlePct'
> {
  const breakdowns = Object.values(state.kpis.vehicleUtilizationBreakdown ?? {});
  const fallbackUtilization = Object.values(state.kpis.vehicleUtilization ?? {});
  const averageField = (field: 'productive' | 'waiting' | 'idle'): number =>
    round((breakdowns.reduce((sum, breakdown) => sum + breakdown[field], 0) / Math.max(1, breakdowns.length)) * 100, 3);

  return {
    averageVehicleUtilizationPct: round((fallbackUtilization.reduce((sum, value) => sum + value, 0) / Math.max(1, fallbackUtilization.length)) * 100, 3),
    averageVehicleProductivePct: averageField('productive'),
    averageVehicleWaitingPct: averageField('waiting'),
    averageVehicleIdlePct: averageField('idle')
  };
}

function theoreticalCapacityFields(state: ShuttleSimState): Pick<
  Phase0ValidationRun,
  | 'theoreticalFleetPph'
  | 'theoreticalSingleShuttlePph'
  | 'theoreticalIdealCycleSec'
  | 'theoreticalLiftAndLowerSec'
  | 'achievedInboundVsTheoryPct'
  | 'inboundPphGapToTheory'
> {
  const theory = state.kpis.theoreticalCapacity;
  return {
    theoreticalFleetPph: theory?.fleetPph ?? null,
    theoreticalSingleShuttlePph: theory?.singleShuttlePph ?? null,
    theoreticalIdealCycleSec: theory?.idealCycleSec ?? null,
    theoreticalLiftAndLowerSec: theory?.liftAndLowerSec ?? null,
    achievedInboundVsTheoryPct: theory?.achievedInboundPct ?? null,
    inboundPphGapToTheory: theory ? round(Math.max(0, theory.fleetPph - state.kpis.inboundPph), 3) : null
  };
}

function runOnce(scenario: ShuttleScenario, seed: number, durationSec: number): Phase0ValidationRun {
  const sim = new ShuttleSimCore({ ...scenario, seed, durationSec });
  sim.start();
  let maxObservedSpeedMps = 0;
  let maxObservedAccelerationMps2 = 0;
  let minVehicleSeparationM: number | null = null;
  let previousSpeeds = new Map<string, number>();
  let previousEdgeIds = new Map<string, string | null>();
  let maxQueuedTasks = 0;
  let maxWaitingVehicles = 0;
  let maxLiftPortQueueLength = 0;
  const physicalViolationsByCode = emptyViolationCounts();
  const physicalViolationExamples: PhysicalViolationExample[] = [];
  const ieBehaviorAudit = emptyIeBehaviorAudit();
  let previousLoads = loadSnapshot(sim.getState().loads);
  const forbiddenFootprintEdges = new Set(verticalStorageFootprintEdgeViolations(scenario).map((violation) => violation.edgeId));

  while (sim.getState().status === 'running') {
    const state = sim.step(scenario.timeStepSec);
    inspectIeBehaviorAudit(scenario, state, previousLoads, forbiddenFootprintEdges, ieBehaviorAudit);
    const physical = inspectState(
      scenario,
      state,
      sim.getDebugState(),
      previousSpeeds,
      previousEdgeIds,
      physicalViolationsByCode,
      physicalViolationExamples,
      {
        requireReservationCoverage: requiresStrictReservationCoverage(state),
        requireMotionSafety: true
      }
    );
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, physical.maxObservedSpeedMps);
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, physical.maxObservedAccelerationMps2);
    maxQueuedTasks = Math.max(maxQueuedTasks, state.kpis.queuedTasks);
    maxWaitingVehicles = Math.max(maxWaitingVehicles, state.traffic.waitingVehicles.length);
    maxLiftPortQueueLength = Math.max(maxLiftPortQueueLength, 0, ...state.traffic.liftPorts.map((port) => port.queueLength));
    previousSpeeds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.speedMps]));
    previousEdgeIds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.currentEdgeId]));
    previousLoads = loadSnapshot(state.loads);
    minVehicleSeparationM =
      physical.minVehicleSeparationM === null
        ? minVehicleSeparationM
        : minVehicleSeparationM === null
          ? physical.minVehicleSeparationM
          : Math.min(minVehicleSeparationM, physical.minVehicleSeparationM);
  }
  const state = sim.getState();
  const eventLog = sim.getEventLog();
  const blockedTimeByCategorySec = categorizeBlockedTimeByReason(state.kpis.blockedTimeByReasonSec);
  const physicalViolationCount = runPhysicalViolationCount(physicalViolationsByCode);
  const theoryFields = theoreticalCapacityFields(state);
  const utilizationFields = utilizationAverages(state);

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
    ...theoryFields,
    ...utilizationFields,
    queuedTasks: state.kpis.queuedTasks,
    maxQueuedTasks,
    maxWaitingVehicles,
    maxLiftPortQueueLength,
    blockedTimeByReasonSec: state.kpis.blockedTimeByReasonSec,
    blockedTimeByCategorySec,
    dominantBottleneckCategory: dominantBottleneckCategory(blockedTimeByCategorySec),
    queueGrowthTasksPerMin: runQueueGrowthTasksPerMin(state, durationSec),
    averageTaskWaitSec: state.kpis.averageTaskWaitSec,
    p95TaskWaitSec: p95TaskWaitSec(state),
    reservationConflictCount: state.kpis.reservationConflictCount,
    deadlockCount: state.kpis.deadlockCount,
    livelockCount: state.kpis.livelockCount,
    maxObservedSpeedMps: round(maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(maxObservedAccelerationMps2),
    minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
    physicalViolationCount,
    physicalViolationsByCode,
    physicalViolationExamples,
    ieBehaviorAudit
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
  let previousEdgeIds = new Map<string, string | null>();
  let maxQueuedTasks = 0;
  let maxWaitingVehicles = 0;
  let maxLiftPortQueueLength = 0;
  const physicalViolationsByCode = emptyViolationCounts();
  const physicalViolationExamples: PhysicalViolationExample[] = [];
  const ieBehaviorAudit = emptyIeBehaviorAudit();
  let previousLoads = loadSnapshot(sim.getState().loads);
  const forbiddenFootprintEdges = new Set(verticalStorageFootprintEdgeViolations(scenario).map((violation) => violation.edgeId));

  while (sim.getState().status === 'running') {
    const state = sim.step(scenario.timeStepSec);
    inspectIeBehaviorAudit(scenario, state, previousLoads, forbiddenFootprintEdges, ieBehaviorAudit);
    const physical = inspectState(
      scenario,
      state,
      sim.getDebugState(),
      previousSpeeds,
      previousEdgeIds,
      physicalViolationsByCode,
      physicalViolationExamples,
      {
        requireReservationCoverage: requiresStrictReservationCoverage(state),
        requireMotionSafety: true
      }
    );
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, physical.maxObservedSpeedMps);
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, physical.maxObservedAccelerationMps2);
    maxQueuedTasks = Math.max(maxQueuedTasks, state.kpis.queuedTasks);
    maxWaitingVehicles = Math.max(maxWaitingVehicles, state.traffic.waitingVehicles.length);
    maxLiftPortQueueLength = Math.max(maxLiftPortQueueLength, 0, ...state.traffic.liftPorts.map((port) => port.queueLength));
    previousSpeeds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.speedMps]));
    previousEdgeIds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.currentEdgeId]));
    previousLoads = loadSnapshot(state.loads);
    minVehicleSeparationM =
      physical.minVehicleSeparationM === null
        ? minVehicleSeparationM
        : minVehicleSeparationM === null
          ? physical.minVehicleSeparationM
          : Math.min(minVehicleSeparationM, physical.minVehicleSeparationM);
  }

  const state = sim.getState();
  const eventLog = sim.getEventLog();
  const blockedTimeByCategorySec = categorizeBlockedTimeByReason(state.kpis.blockedTimeByReasonSec);
  const physicalViolationCount = runPhysicalViolationCount(physicalViolationsByCode);
  const requestedTotalPph = scenario.taskGeneration.inboundRatePerHour + scenario.taskGeneration.outboundRatePerHour;
  const theoryFields = theoreticalCapacityFields(state);
  const utilizationFields = utilizationAverages(state);
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
    ...theoryFields,
    ...utilizationFields,
    queuedTasks: state.kpis.queuedTasks,
    maxQueuedTasks,
    maxWaitingVehicles,
    maxLiftPortQueueLength,
    blockedTimeByReasonSec: state.kpis.blockedTimeByReasonSec,
    blockedTimeByCategorySec,
    dominantBottleneckCategory: dominantBottleneckCategory(blockedTimeByCategorySec),
    queueGrowthTasksPerMin: runQueueGrowthTasksPerMin(state, durationSec),
    averageTaskWaitSec: state.kpis.averageTaskWaitSec,
    p95TaskWaitSec: p95TaskWaitSec(state),
    reservationConflictCount: state.kpis.reservationConflictCount,
    deadlockCount: state.kpis.deadlockCount,
    livelockCount: state.kpis.livelockCount,
    maxObservedSpeedMps: round(maxObservedSpeedMps),
    maxObservedAccelerationMps2: round(maxObservedAccelerationMps2),
    minVehicleSeparationM: minVehicleSeparationM === null ? null : round(minVehicleSeparationM),
    physicalViolationCount,
    physicalViolationsByCode,
    physicalViolationExamples,
    ieBehaviorAudit
  };

  const observed = observedBottleneckReasons(baseRun);
  const missingExpected = missingExpectedBottleneckPrefixes(baseRun, spec.expectedBottleneckReasonPrefixes);
  const dominantCategory = baseRun.dominantBottleneckCategory;
  return {
    ...baseRun,
    stressScenarioId: spec.id,
    label: spec.label,
    requestedInboundPph: scenario.taskGeneration.inboundRatePerHour,
    requestedOutboundPph: scenario.taskGeneration.outboundRatePerHour,
    requestedTotalPph,
    achievedTotalRatio: requestedTotalPph > 0 ? round(state.kpis.totalPph / requestedTotalPph, 6) : null,
    expectedBottleneckReasonPrefixes: spec.expectedBottleneckReasonPrefixes,
    expectedDominantBottleneckCategories: spec.expectedDominantBottleneckCategories,
    observedBottleneckReasons: observed,
    expectedBottleneckObserved: missingExpected.length === 0,
    expectedDominantBottleneckObserved: dominantCategory !== null && spec.expectedDominantBottleneckCategories.includes(dominantCategory),
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
  const nullableMean = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? round(present.reduce((sum, value) => sum + value, 0) / present.length, 3) : null;
  };
  const mean = (values: number[]): number =>
    round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), 3);
  const observed = [...new Set(runs.flatMap((run) => run.observedBottleneckReasons))].sort((left, right) => left.localeCompare(right));
  const observedDominantBottleneckCategories = [...new Set(runs.map((run) => run.dominantBottleneckCategory))];
  const pass = runs.every((run) =>
    run.eventCount > 0 &&
    run.deadlockCount === 0 &&
    run.livelockCount === 0 &&
    run.physicalViolationCount === 0 &&
    !hasReservationCoverageViolation(run) &&
    run.ieBehaviorAudit.pass &&
    run.expectedBottleneckObserved &&
    run.expectedDominantBottleneckObserved &&
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
    expectedDominantBottleneckCategories: spec.expectedDominantBottleneckCategories,
    requiresPositiveThroughput: spec.requiresPositiveThroughput,
    runs,
    totalPphMean: round(totalPphValues.reduce((sum, value) => sum + value, 0) / Math.max(1, totalPphValues.length)),
    maxQueuedTasks: Math.max(0, ...runs.map((run) => run.maxQueuedTasks)),
    maxWaitingVehicles: Math.max(0, ...runs.map((run) => run.maxWaitingVehicles)),
    maxLiftPortQueueLength: Math.max(0, ...runs.map((run) => run.maxLiftPortQueueLength)),
    observedBottleneckReasons: observed,
    observedDominantBottleneckCategories,
    blockedTimeByCategorySec: aggregateBottleneckBreakdowns(runs),
    theoreticalFleetPphMean: nullableMean(runs.map((run) => run.theoreticalFleetPph)),
    achievedInboundVsTheoryPctMean: nullableMean(runs.map((run) => run.achievedInboundVsTheoryPct)),
    inboundPphGapToTheoryMean: nullableMean(runs.map((run) => run.inboundPphGapToTheory)),
    averageVehicleUtilizationPctMean: mean(runs.map((run) => run.averageVehicleUtilizationPct)),
    averageVehicleProductivePctMean: mean(runs.map((run) => run.averageVehicleProductivePct)),
    averageVehicleWaitingPctMean: mean(runs.map((run) => run.averageVehicleWaitingPct)),
    averageVehicleIdlePctMean: mean(runs.map((run) => run.averageVehicleIdlePct)),
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
    noStressIeBehaviorAuditViolations: true,
    expectedBottlenecksObserved: true,
    expectedDominantBottlenecksObserved: true,
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
      const noStressIeBehaviorAuditViolations = stressRuns.every((run) => run.ieBehaviorAudit.pass);
      const expectedBottlenecksObserved = scenarios.every((stressScenario) =>
        stressScenario.runs.every((run) => run.expectedBottleneckObserved)
      );
      const expectedDominantBottlenecksObserved = scenarios.every((stressScenario) =>
        stressScenario.runs.every((run) => run.expectedDominantBottleneckObserved)
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
          noStressIeBehaviorAuditViolations &&
          expectedBottlenecksObserved &&
          expectedDominantBottlenecksObserved &&
          positiveThroughputWhereRequired,
        noStressDeadlocks,
        noStressPhysicalSafetyViolations,
          noStressReservationCoverageViolations,
          noStressIeBehaviorAuditViolations,
          expectedBottlenecksObserved,
          expectedDominantBottlenecksObserved,
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
  const noLivelocksInSweep = seedSweepRuns.every((run) => run.livelockCount === 0);
  const eventLogsPresent = [...repeatRuns, ...seedSweepRuns].every((run) => run.eventCount > 0);
  const noPhysicalSafetyViolations = allRuns.every((run) => run.physicalViolationCount === 0);
  const noReservationCoverageViolations = allRuns.every((run) =>
    RESERVATION_COVERAGE_CODES.every((code) => run.physicalViolationsByCode[code] === 0)
  );
  const noIeBehaviorAuditViolations = allRuns.every((run) => run.ieBehaviorAudit.pass);
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
  const noLongRunLivelocks = longRunRuns.every((run) => run.livelockCount === 0);
  const noLongRunPhysicalSafetyViolations = longRunRuns.every((run) => run.physicalViolationCount === 0);
  const noLongRunReservationCoverageViolations = longRunRuns.every((run) =>
    RESERVATION_COVERAGE_CODES.every((code) => run.physicalViolationsByCode[code] === 0)
  );
  const noLongRunIeBehaviorAuditViolations = longRunRuns.every((run) => run.ieBehaviorAudit.pass);
  const flowDebugThroughputObserved = longRunThroughputPositive || stress.positiveThroughputWhereRequired;
  const flowDebugObservationPass =
    sameSeedEventHashStable &&
    noDeadlocksInSweep &&
    noLivelocksInSweep &&
    eventLogsPresent &&
    noIeBehaviorAuditViolations &&
    longRunEventLogsPresent &&
    flowDebugThroughputObserved &&
    noLongRunDeadlocks &&
    noLongRunLivelocks &&
    noLongRunIeBehaviorAuditViolations &&
    stress.noStressDeadlocks &&
    stress.noStressIeBehaviorAuditViolations &&
    stress.expectedBottlenecksObserved &&
    stress.expectedDominantBottlenecksObserved &&
    stress.positiveThroughputWhereRequired;
  const segmentSafeValidationPass = false;
  const ieValidationPass =
    segmentSafeValidationPass &&
    layoutCalibrationReadiness.readyForIndustrialThroughputClaims === true;

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
      noLivelocksInSweep,
      eventLogsPresent,
      noPhysicalSafetyViolations,
      noReservationCoverageViolations,
      noIeBehaviorAuditViolations,
      longRunEventLogsPresent,
      longRunThroughputPositive,
      longRunThroughputFloorMet,
      longRunThroughputBySideMet,
      longRunQueuesBounded,
      noLongRunDeadlocks,
      noLongRunLivelocks,
      noLongRunPhysicalSafetyViolations,
      noLongRunReservationCoverageViolations,
      noLongRunIeBehaviorAuditViolations,
      stressPass: stress.pass,
      noStressDeadlocks: stress.noStressDeadlocks,
      noStressPhysicalSafetyViolations: stress.noStressPhysicalSafetyViolations,
      noStressReservationCoverageViolations: stress.noStressReservationCoverageViolations,
      noStressIeBehaviorAuditViolations: stress.noStressIeBehaviorAuditViolations,
      expectedStressBottlenecksObserved: stress.expectedBottlenecksObserved,
      expectedStressDominantBottlenecksObserved: stress.expectedDominantBottlenecksObserved,
      positiveStressThroughputWhereRequired: stress.positiveThroughputWhereRequired,
      flowDebugObservationPass,
      segmentSafeValidationPass,
      ieValidationPass,
      pass: ieValidationPass
    }
  };
}
