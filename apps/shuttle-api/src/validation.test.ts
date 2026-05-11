import type { Reservation, ShuttleScenario, ShuttleSimState } from '@four-way-shuttle/schemas';
import { createDefaultShuttleScenario, ShuttleSimCore, type ShuttleSimDebugState } from '@four-way-shuttle/sim-core';

import { inspectPhase0StateSnapshot, validatePhase0Scenario, type PhysicalViolationCode } from './validation.js';

type InspectionFixture = {
  scenario: ShuttleScenario;
  state: ShuttleSimState;
  debug: ShuttleSimDebugState;
};

function fixture(): InspectionFixture {
  const scenario = createDefaultShuttleScenario({ durationSec: 20 });
  const sim = new ShuttleSimCore(scenario);
  return {
    scenario,
    state: structuredClone(sim.getState()),
    debug: structuredClone(sim.getDebugState())
  };
}

function node(scenario: ShuttleScenario, nodeId: string): ShuttleScenario['layout']['nodes'][number] {
  const match = scenario.layout.nodes.find((candidate) => candidate.id === nodeId);
  if (!match) throw new Error(`Unknown node ${nodeId}`);
  return match;
}

function reservation(resourceType: Reservation['resourceType'], resourceId: string, vehicleId = 'SH-01'): Reservation {
  return {
    id: `test-${resourceType}-${resourceId}`,
    resourceType,
    resourceId,
    vehicleId,
    taskId: null,
    startTimeSec: 0,
    endTimeSec: 100,
    priority: 0,
    conflictGroup: null,
    reasonCode: 'test'
  };
}

function putVehicleOnMainEntryEdge(
  candidate: InspectionFixture,
  reservations: Array<Reservation['resourceType']>
): void {
  const vehicle = candidate.state.vehicles[0]!;
  const from = node(candidate.scenario, 'main-north-01');
  const to = node(candidate.scenario, 'main-south-01');
  vehicle.state = 'moving-to-pickup';
  vehicle.currentNodeId = 'main-north-01';
  vehicle.currentEdgeId = 'main-north-01-main-south-01';
  vehicle.targetNodeId = 'main-south-01';
  vehicle.x = (from.x + to.x) / 2;
  vehicle.z = (from.z + to.z) / 2;
  vehicle.speedMps = 0.2;
  candidate.state.reservations = reservations.map((resourceType) => {
    if (resourceType === 'edge') return reservation('edge', 'main-north-01-main-south-01');
    if (resourceType === 'node') return reservation('node', 'main-south-01');
    return reservation('zone', 'zone-main-portal-01');
  });
}

function putStoppedVehicleOnPortalNode(candidate: InspectionFixture): void {
  const vehicle = candidate.state.vehicles[0]!;
  const portalNode = node(candidate.scenario, 'main-south-01');
  vehicle.state = 'waiting-blocked';
  vehicle.currentNodeId = portalNode.id;
  vehicle.currentEdgeId = null;
  vehicle.targetNodeId = null;
  vehicle.x = portalNode.x;
  vehicle.z = portalNode.z;
  vehicle.speedMps = 0;
  vehicle.waitReason = 'edge-reserved';
  candidate.debug.currentNodeOccupancy = [{ nodeId: portalNode.id, vehicleId: vehicle.id }];
  candidate.state.reservations = [];
}

function collisionAvoidanceOffMergeScenario(): ShuttleScenario {
  return createDefaultShuttleScenario({
    vehicles: { count: 2, safetyRadiusM: 0.4, lengthM: 1, widthM: 1 },
    trafficPolicy: { collisionAvoidanceEnabled: false },
    layout: {
      units: 'meter',
      calibrationProfile: null,
      nodes: [
        { id: 'A', type: 'parking', x: 0, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
        { id: 'B', type: 'parking', x: 1, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] },
        { id: 'C', type: 'parking', x: 2, y: 0, z: 0, noStop: false, noParking: false, capacity: 1, allowedDirections: [] }
      ],
      edges: [
        { id: 'A-B', from: 'A', to: 'B', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'A-B', noParking: true },
        { id: 'C-B', from: 'C', to: 'B', lengthM: 1, directionMode: 'twoWay', reservationType: 'edge', conflictGroup: 'C-B', noParking: true }
      ],
      zones: []
    },
    physicsParams: {
      emptySpeedMps: 1,
      loadedSpeedMps: 1,
      accelerationMps2: 4,
      switchDirectionSec: 0,
      liftTimeSec: 0,
      lowerTimeSec: 0,
      loadedClearanceM: 0.2,
      reservationClearanceSec: 0.05
    }
  });
}

describe('phase 0 validation', () => {
  it('checks same-seed hash stability and seed sweep health', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 60 }), {
      durationSec: 60,
      longRunDurationSec: 180,
      stressDurationSec: 180,
      repeatCount: 2,
      sweepSeeds: [20260502],
      stressSeeds: [20260502],
      includeStress: false
    });

    expect(result.deterministic.pass).toBe(true);
    expect(result.layoutCalibrationReadiness).toMatchObject({
      status: 'assumption',
      readyForIndustrialThroughputClaims: false
    });
    expect(result.layoutCalibrationReadiness.requiredDimensionKeys).toHaveLength(20);
    expect(result.layoutCalibrationReadiness.missingDimensionKeys).toContain('palletLength');
    expect(result.layoutCalibrationReadiness.assumedDimensionKeys).toContain('storageCellPitchX');
    expect(new Set(result.deterministic.hashes).size).toBe(1);
    expect(result.seedSweep.runs).toHaveLength(1);
    expect(result.acceptance.noPhysicalSafetyViolations).toBe(true);
    expect(result.acceptance.noReservationCoverageViolations).toBe(true);
    expect(result.acceptance.noLivelocksInSweep).toBe(true);
    expect(result.acceptance.noIeBehaviorAuditViolations).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationsByCode.unreservedEdgeOccupancy === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationExamples.length === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.ieBehaviorAudit.pass)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.ieBehaviorAudit.reservation.violationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.ieBehaviorAudit.inventory.violationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.ieBehaviorAudit.routing.violationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.theoreticalFleetPph !== null && run.inboundPphGapToTheory !== null)).toBe(true);
    expect(result.longRun.durationSec).toBe(180);
    expect(result.longRun.runs).toHaveLength(1);
    expect(result.longRun.thresholds.minTotalPph).toBe(18);
    expect(result.longRun.thresholds.minInboundPph).toBe(6);
    expect(result.longRun.thresholds.minOutboundPph).toBe(6);
    expect(result.longRun.runs.every((run) => run.inboundPph >= result.longRun.thresholds.minInboundPph)).toBe(true);
    expect(result.longRun.runs.every((run) => run.outboundPph >= result.longRun.thresholds.minOutboundPph)).toBe(true);
    expect(result.longRun.maxQueuedTasks).toBeLessThanOrEqual(result.longRun.thresholds.maxQueuedTasks);
    expect(result.longRun.maxLiftPortQueueLength).toBeLessThanOrEqual(result.longRun.thresholds.maxLiftPortQueueLength);
    expect(result.longRun.maxQueuedTasks).toBeLessThanOrEqual(40);
    expect(result.acceptance.longRunEventLogsPresent).toBe(true);
    expect(result.acceptance.longRunThroughputPositive).toBe(true);
    expect(result.acceptance.longRunThroughputFloorMet).toBe(true);
    expect(result.acceptance.longRunThroughputBySideMet).toBe(true);
    expect(result.acceptance.longRunQueuesBounded).toBe(true);
    expect(result.acceptance.noLongRunDeadlocks).toBe(true);
    expect(result.acceptance.noLongRunLivelocks).toBe(true);
    expect(result.acceptance.noLongRunPhysicalSafetyViolations).toBe(true);
    expect(result.acceptance.noLongRunIeBehaviorAuditViolations).toBe(true);
    expect(result.acceptance.flowDebugObservationPass).toBe(true);
    expect(result.acceptance.segmentSafeValidationPass).toBe(false);
    expect(result.acceptance.ieValidationPass).toBe(false);
    expect(result.acceptance.pass).toBe(false);
  }, 120000);

  it('keeps reservation-overlap audit active when collision avoidance is disabled', () => {
    const scenario = collisionAvoidanceOffMergeScenario();
    const sim = new ShuttleSimCore(scenario);
    sim.setVehicleRouteForTest('SH-01', ['A', 'B']);
    sim.setVehicleRouteForTest('SH-02', ['C', 'B']);

    const state = sim.step(0.1);
    const nodeBReservations = state.reservations.filter(
      (reservationItem) => reservationItem.resourceType === 'node' && reservationItem.resourceId === 'B'
    );
    const result = inspectPhase0StateSnapshot(scenario, state, sim.getDebugState());

    expect(nodeBReservations).toHaveLength(2);
    expect(result.ieBehaviorAudit.reservation.violationCount).toBeGreaterThan(0);
    expect(result.ieBehaviorAudit.reservation.violationsByCode.activeResourceOverlap).toBeGreaterThan(0);
    expect(result.ieBehaviorAudit.reservation.violationsByCode.resourceWindowOverlap).toBeGreaterThan(0);
  });

  it('fails long-run acceptance when explicit throughput and queue thresholds are missed', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({
      durationSec: 40,
      vehicles: { count: 1 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 80
      }
    }), {
      durationSec: 40,
      longRunDurationSec: 120,
      repeatCount: 1,
      sweepSeeds: [20260502],
      includeStress: false,
      longRunThresholds: {
        minTotalPph: 999,
        minInboundPph: 999,
        minOutboundPph: 999,
        maxQueuedTasks: 0,
        maxWaitingVehicles: 0,
        maxLiftPortQueueLength: 0
      }
    });

    expect(result.acceptance.longRunThroughputPositive).toBe(true);
    expect(result.acceptance.longRunThroughputFloorMet).toBe(false);
    expect(result.acceptance.longRunThroughputBySideMet).toBe(false);
    expect(result.acceptance.longRunQueuesBounded).toBe(false);
    expect(result.acceptance.segmentSafeValidationPass).toBe(false);
    expect(result.acceptance.ieValidationPass).toBe(false);
    expect(result.acceptance.pass).toBe(false);
  }, 60000);

  it.each([
    {
      code: 'unreservedEdgeOccupancy',
      mutate: (candidate: InspectionFixture) => putVehicleOnMainEntryEdge(candidate, ['node', 'zone'])
    },
    {
      code: 'unreservedNodeOccupancy',
      mutate: (candidate: InspectionFixture) => putVehicleOnMainEntryEdge(candidate, ['edge', 'zone'])
    },
    {
      code: 'unreservedZoneOccupancy',
      mutate: (candidate: InspectionFixture) => putVehicleOnMainEntryEdge(candidate, ['edge', 'node'])
    },
    {
      code: 'unreservedZoneOccupancy',
      mutate: putStoppedVehicleOnPortalNode
    },
    {
      code: 'nodeOccupancyMismatch',
      mutate: (candidate: InspectionFixture) => {
        candidate.state.vehicles[0]!.x += 5;
      }
    },
    {
      code: 'edgeOccupancyMismatch',
      mutate: (candidate: InspectionFixture) => {
        putVehicleOnMainEntryEdge(candidate, ['edge', 'node', 'zone']);
        candidate.state.vehicles[0]!.x += 25;
      }
    },
    {
      code: 'speedLimit',
      mutate: (candidate: InspectionFixture) => {
        candidate.state.vehicles[0]!.speedMps = Math.max(
          candidate.scenario.physicsParams.emptySpeedMps,
          candidate.scenario.physicsParams.loadedSpeedMps
        ) + 1;
      }
    },
    {
      code: 'speedLimit',
      mutate: (candidate: InspectionFixture) => {
        const vehicle = candidate.state.vehicles[0]!;
        vehicle.loaded = true;
        vehicle.speedMps = (candidate.scenario.physicsParams.loadedSpeedMps + candidate.scenario.physicsParams.emptySpeedMps) / 2;
      }
    },
    {
      code: 'accelerationLimit',
      mutate: (candidate: InspectionFixture) => {
        candidate.state.vehicles[0]!.speedMps = 0.5;
      },
      previousSpeeds: new Map([['SH-01', 0]])
    },
    {
      code: 'travelTimeLowerBound',
      mutate: (candidate: InspectionFixture) => {
        putVehicleOnMainEntryEdge(candidate, ['edge', 'node', 'zone']);
        candidate.state.vehicles[0]!.legTravelSec = 0.001;
      }
    },
    {
      code: 'minSeparation',
      mutate: (candidate: InspectionFixture) => {
        candidate.state.vehicles[1]!.x = candidate.state.vehicles[0]!.x;
        candidate.state.vehicles[1]!.z = candidate.state.vehicles[0]!.z;
      }
    },
    {
      code: 'invalidCoordinate',
      mutate: (candidate: InspectionFixture) => {
        candidate.state.vehicles[0]!.x = Number.NaN;
      }
    }
  ] satisfies Array<{
    code: PhysicalViolationCode;
    mutate: (candidate: InspectionFixture) => void;
    previousSpeeds?: Map<string, number>;
  }>)('flags positive-control violation $code', ({ code, mutate, previousSpeeds }) => {
    const candidate = fixture();
    mutate(candidate);

    const result = inspectPhase0StateSnapshot(candidate.scenario, candidate.state, candidate.debug, previousSpeeds);

    expect(result.physicalViolationsByCode[code]).toBeGreaterThan(0);
    expect(result.physicalViolationExamples.some((example) => example.code === code)).toBe(true);
  });

  it('flags self reservation windows that grow beyond resource traversal bounds', () => {
    const candidate = fixture();
    candidate.state.reservations = [
      {
        ...reservation('edge', 'main-north-01-main-south-01'),
        startTimeSec: 0,
        endTimeSec: 100
      }
    ];

    const result = inspectPhase0StateSnapshot(candidate.scenario, candidate.state, candidate.debug);

    expect(result.ieBehaviorAudit.reservation.warningsByCode.selfGrantSpanTooLong).toBeGreaterThan(0);
    expect(result.ieBehaviorAudit.reservation.warningExamples.some((example) => example.code === 'selfGrantSpanTooLong')).toBe(true);
    expect(result.ieBehaviorAudit.reservation.pass).toBe(true);
  });
});
