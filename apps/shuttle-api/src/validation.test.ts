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

describe('phase 0 validation', () => {
  it('checks same-seed hash stability and seed sweep health', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 120 }), {
      durationSec: 120,
      longRunDurationSec: 600,
      stressDurationSec: 180,
      repeatCount: 3,
      sweepSeeds: [20260502, 20260503],
      stressSeeds: [20260502]
    });

    expect(result.deterministic.pass).toBe(true);
    expect(new Set(result.deterministic.hashes).size).toBe(1);
    expect(result.seedSweep.runs).toHaveLength(2);
    expect(result.acceptance.noPhysicalSafetyViolations).toBe(true);
    expect(result.acceptance.noReservationCoverageViolations).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationsByCode.unreservedEdgeOccupancy === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationExamples.length === 0)).toBe(true);
    expect(result.longRun.durationSec).toBe(600);
    expect(result.longRun.runs).toHaveLength(2);
    expect(result.longRun.thresholds.minTotalPph).toBe(18);
    expect(result.longRun.thresholds.minInboundPph).toBe(1);
    expect(result.longRun.thresholds.minOutboundPph).toBe(1);
    expect(result.longRun.maxQueuedTasks).toBeLessThanOrEqual(result.longRun.thresholds.maxQueuedTasks);
    expect(result.longRun.maxLiftPortQueueLength).toBeLessThanOrEqual(result.longRun.thresholds.maxLiftPortQueueLength);
    expect(result.longRun.maxQueuedTasks).toBeLessThanOrEqual(40);
    expect(result.acceptance.longRunEventLogsPresent).toBe(true);
    expect(result.acceptance.longRunThroughputPositive).toBe(true);
    expect(result.acceptance.longRunThroughputFloorMet).toBe(true);
    expect(result.acceptance.longRunThroughputBySideMet).toBe(true);
    expect(result.acceptance.longRunQueuesBounded).toBe(true);
    expect(result.acceptance.noLongRunPhysicalSafetyViolations).toBe(true);
    expect(result.stress.scenarios.map((scenario) => scenario.id)).toEqual([
      'balanced-high-load',
      'inbound-only-saturation',
      'outbound-empty-store',
      'outbound-preloaded-pressure',
      'near-full-inbound-pressure'
    ]);
    expect(result.stress.scenarios.every((scenario) => scenario.runs.length === 1)).toBe(true);
    expect(result.stress.scenarios.every((scenario) => scenario.observedBottleneckReasons.length > 0)).toBe(true);
    expect(result.stress.scenarios.every((scenario) =>
      scenario.runs.every((run) => run.missingExpectedBottleneckReasonPrefixes.length === 0)
    )).toBe(true);
    expect(result.stress.noStressDeadlocks).toBe(true);
    expect(result.stress.noStressPhysicalSafetyViolations).toBe(true);
    expect(result.stress.noStressReservationCoverageViolations).toBe(true);
    expect(result.stress.expectedBottlenecksObserved).toBe(true);
    expect(result.acceptance.stressPass).toBe(true);
    expect(result.acceptance.pass).toBe(true);
  }, 40000);

  it('fails long-run acceptance when explicit throughput and queue thresholds are missed', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 120 }), {
      durationSec: 120,
      longRunDurationSec: 240,
      repeatCount: 1,
      sweepSeeds: [20260502],
      includeStress: false,
      longRunThresholds: {
        minTotalPph: 999,
        maxQueuedTasks: 0,
        maxWaitingVehicles: 0,
        maxLiftPortQueueLength: 0
      }
    });

    expect(result.acceptance.longRunThroughputPositive).toBe(true);
    expect(result.acceptance.longRunThroughputFloorMet).toBe(false);
    expect(result.acceptance.longRunThroughputBySideMet).toBe(false);
    expect(result.acceptance.longRunQueuesBounded).toBe(false);
    expect(result.acceptance.pass).toBe(false);
  });

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
      code: 'accelerationLimit',
      mutate: (candidate: InspectionFixture) => {
        candidate.state.vehicles[0]!.speedMps = 0.5;
      },
      previousSpeeds: new Map([['SH-01', 0]])
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
});
