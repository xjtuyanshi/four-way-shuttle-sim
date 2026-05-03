import type { Reservation, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { ShuttleSimCore, hashEventLog, type ShuttleSimDebugState } from '@four-way-shuttle/sim-core';

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
  reservationConflictCount: number;
  deadlockCount: number;
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationCount: number;
  physicalViolationsByCode: Record<PhysicalViolationCode, number>;
  physicalViolationExamples: PhysicalViolationExample[];
};

export type LongRunAcceptanceThresholds = {
  minTotalPph: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
};

export type Phase0ValidationResult = {
  checkedAt: string;
  scenarioId: string;
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
    longRunQueuesBounded: boolean;
    noLongRunDeadlocks: boolean;
    noLongRunPhysicalSafetyViolations: boolean;
    noLongRunReservationCoverageViolations: boolean;
    pass: boolean;
  };
};

type Phase0ValidationOptions = {
  durationSec?: number;
  longRunDurationSec?: number;
  repeatCount?: number;
  sweepSeeds?: number[];
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

function defaultLongRunThresholds(scenario: ShuttleScenario): LongRunAcceptanceThresholds {
  const requestedPph = scenario.taskGeneration.inboundRatePerHour + scenario.taskGeneration.outboundRatePerHour;
  return {
    minTotalPph: round(Math.max(1, requestedPph * 0.5), 1),
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
    if (accelerationMps2 > scenario.physicsParams.accelerationMps2 + 1e-6) {
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
      physicalViolationsByCode,
      physicalViolationExamples
    );
    maxObservedSpeedMps = Math.max(maxObservedSpeedMps, physical.maxObservedSpeedMps);
    maxObservedAccelerationMps2 = Math.max(maxObservedAccelerationMps2, physical.maxObservedAccelerationMps2);
    maxQueuedTasks = Math.max(maxQueuedTasks, state.kpis.queuedTasks);
    maxWaitingVehicles = Math.max(maxWaitingVehicles, state.traffic.waitingVehicles.length);
    maxLiftPortQueueLength = Math.max(maxLiftPortQueueLength, 0, ...state.traffic.liftPorts.map((port) => port.queueLength));
    previousSpeeds = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle.speedMps]));
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

export function validatePhase0Scenario(
  scenario: ShuttleScenario,
  options: Phase0ValidationOptions = {}
): Phase0ValidationResult {
  const durationSec = options.durationSec ?? Math.min(240, scenario.durationSec);
  const longRunDurationSec = options.longRunDurationSec ?? 600;
  const repeatCount = options.repeatCount ?? 3;
  const sweepSeeds = options.sweepSeeds ?? [scenario.seed, scenario.seed + 1, scenario.seed + 2];
  const longRunThresholds = resolveLongRunThresholds(scenario, options.longRunThresholds);

  const repeatRuns = Array.from({ length: repeatCount }, () => runOnce(scenario, scenario.seed, durationSec));
  const hashes = repeatRuns.map((run) => run.eventLogHash);
  const seedSweepRuns = sweepSeeds.map((seed) => runOnce(scenario, seed, durationSec));
  const longRunRuns = sweepSeeds.map((seed) => runOnce(scenario, seed, longRunDurationSec));
  const allRuns = [...repeatRuns, ...seedSweepRuns, ...longRunRuns];
  const totalPphValues = seedSweepRuns.map((run) => run.totalPph);
  const longRunTotalPphValues = longRunRuns.map((run) => run.totalPph);
  const totalPphMin = Math.min(...totalPphValues);
  const totalPphMax = Math.max(...totalPphValues);
  const sameSeedEventHashStable = new Set(hashes).size === 1;
  const noDeadlocksInSweep = seedSweepRuns.every((run) => run.deadlockCount === 0);
  const eventLogsPresent = [...repeatRuns, ...seedSweepRuns].every((run) => run.eventCount > 0);
  const noPhysicalSafetyViolations = allRuns.every((run) => run.physicalViolationCount === 0);
  const noReservationCoverageViolations = allRuns.every((run) =>
    (
      [
        'unreservedEdgeOccupancy',
        'unreservedNodeOccupancy',
        'unreservedZoneOccupancy',
        'nodeOccupancyMismatch',
        'edgeOccupancyMismatch'
      ] as PhysicalViolationCode[]
    ).every((code) => run.physicalViolationsByCode[code] === 0)
  );
  const longRunEventLogsPresent = longRunRuns.every((run) => run.eventCount > 0);
  const longRunThroughputPositive = longRunRuns.every((run) => run.completedInbound + run.completedOutbound > 0 && run.totalPph > 0);
  const longRunThroughputFloorMet = longRunRuns.every(
    (run) => run.completedInbound + run.completedOutbound > 0 && run.totalPph >= longRunThresholds.minTotalPph
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
    (
      [
        'unreservedEdgeOccupancy',
        'unreservedNodeOccupancy',
        'unreservedZoneOccupancy',
        'nodeOccupancyMismatch',
        'edgeOccupancyMismatch'
      ] as PhysicalViolationCode[]
    ).every((code) => run.physicalViolationsByCode[code] === 0)
  );

  return {
    checkedAt: new Date().toISOString(),
    scenarioId: scenario.id,
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
      maxLiftPortQueueLength: Math.max(0, ...longRunRuns.map((run) => run.maxLiftPortQueueLength))
    },
    acceptance: {
      sameSeedEventHashStable,
      noDeadlocksInSweep,
      eventLogsPresent,
      noPhysicalSafetyViolations,
      noReservationCoverageViolations,
      longRunEventLogsPresent,
      longRunThroughputPositive,
      longRunThroughputFloorMet,
      longRunQueuesBounded,
      noLongRunDeadlocks,
      noLongRunPhysicalSafetyViolations,
      noLongRunReservationCoverageViolations,
      pass:
        sameSeedEventHashStable &&
        noDeadlocksInSweep &&
        eventLogsPresent &&
        noPhysicalSafetyViolations &&
        noReservationCoverageViolations &&
        longRunEventLogsPresent &&
        longRunThroughputPositive &&
        longRunThroughputFloorMet &&
        longRunQueuesBounded &&
        noLongRunDeadlocks &&
        noLongRunPhysicalSafetyViolations &&
        noLongRunReservationCoverageViolations
    }
  };
}
