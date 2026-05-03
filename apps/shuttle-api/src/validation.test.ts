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
  const from = node(candidate.scenario, 'x-main');
  const to = node(candidate.scenario, 'right-row-03');
  vehicle.state = 'moving-to-pickup';
  vehicle.currentNodeId = 'x-main';
  vehicle.currentEdgeId = 'x-main-right-row-03';
  vehicle.targetNodeId = 'right-row-03';
  vehicle.x = (from.x + to.x) / 2;
  vehicle.z = (from.z + to.z) / 2;
  vehicle.speedMps = 0.2;
  candidate.state.reservations = reservations.map((resourceType) => {
    if (resourceType === 'edge') return reservation('edge', 'x-main-right-row-03');
    if (resourceType === 'node') return reservation('node', 'right-row-03');
    return reservation('zone', 'zone-x-main');
  });
}

describe('phase 0 validation', () => {
  it('checks same-seed hash stability and seed sweep health', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 120 }), {
      durationSec: 120,
      longRunDurationSec: 240,
      repeatCount: 3,
      sweepSeeds: [20260502, 20260503],
      longRunThresholds: {
        minTotalPph: 75
      }
    });

    expect(result.deterministic.pass).toBe(true);
    expect(new Set(result.deterministic.hashes).size).toBe(1);
    expect(result.seedSweep.runs).toHaveLength(2);
    expect(result.acceptance.noPhysicalSafetyViolations).toBe(true);
    expect(result.acceptance.noReservationCoverageViolations).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationCount === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationsByCode.unreservedEdgeOccupancy === 0)).toBe(true);
    expect(result.seedSweep.runs.every((run) => run.physicalViolationExamples.length === 0)).toBe(true);
    expect(result.longRun.durationSec).toBe(240);
    expect(result.longRun.runs).toHaveLength(2);
    expect(result.longRun.thresholds.minTotalPph).toBe(75);
    expect(result.longRun.maxQueuedTasks).toBeLessThanOrEqual(result.longRun.thresholds.maxQueuedTasks);
    expect(result.longRun.maxLiftPortQueueLength).toBeLessThanOrEqual(result.longRun.thresholds.maxLiftPortQueueLength);
    expect(result.longRun.maxQueuedTasks).toBeLessThanOrEqual(40);
    expect(result.acceptance.longRunEventLogsPresent).toBe(true);
    expect(result.acceptance.longRunThroughputPositive).toBe(true);
    expect(result.acceptance.longRunThroughputFloorMet).toBe(true);
    expect(result.acceptance.longRunQueuesBounded).toBe(true);
    expect(result.acceptance.noLongRunPhysicalSafetyViolations).toBe(true);
    expect(result.acceptance.pass).toBe(true);
  });

  it('fails long-run acceptance when explicit throughput and queue thresholds are missed', () => {
    const result = validatePhase0Scenario(createDefaultShuttleScenario({ durationSec: 120 }), {
      durationSec: 120,
      longRunDurationSec: 240,
      repeatCount: 1,
      sweepSeeds: [20260502],
      longRunThresholds: {
        minTotalPph: 999,
        maxQueuedTasks: 0,
        maxWaitingVehicles: 0,
        maxLiftPortQueueLength: 0
      }
    });

    expect(result.acceptance.longRunThroughputPositive).toBe(true);
    expect(result.acceptance.longRunThroughputFloorMet).toBe(false);
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
