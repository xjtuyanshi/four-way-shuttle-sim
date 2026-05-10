import { createDefaultShuttleScenario, ShuttleSimCore } from './index.js';

function runFor(sim: ShuttleSimCore, durationSec: number, dtSec = 0.2) {
  sim.start();
  for (let elapsedSec = 0; elapsedSec < durationSec; elapsedSec = Number((elapsedSec + dtSec).toFixed(6))) {
    sim.step(dtSec);
  }
  return sim.getState();
}

function expectNoTrafficSafetyFailures(state: ReturnType<ShuttleSimCore['getState']>) {
  expect(state.kpis.deadlockCount).toBe(0);
  expect(state.kpis.livelockCount).toBe(0);
  expect(state.traffic.physicalViolationCount).toBe(0);
}

function addStoredLoads(sim: ShuttleSimCore, nodeIds: string[]) {
  nodeIds.forEach((nodeId, index) => {
    sim.addLoadForTest({
      id: `stored-${String(index + 1).padStart(4, '0')}`,
      state: 'stored',
      nodeId,
      vehicleId: null,
      weightKg: 100
    });
  });
}

describe('shuttle phase 0 pressure SimCore', () => {
  it('keeps four-vehicle mixed lift and FIFO pressure bounded without deadlock', () => {
    const scenario = createDefaultShuttleScenario({
      durationSec: 120,
      vehicles: { count: 4 },
      taskGeneration: {
        inboundRatePerHour: 240,
        outboundRatePerHour: 240,
        inboundOutboundMix: 0.5,
        arrivalDistribution: 'deterministic',
        maxTasks: 32
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0.2,
        liftTimeSec: 0.2,
        lowerTimeSec: 0.2,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      },
      trafficPolicy: {
        deadlockDetectSec: 5
      }
    });
    const sim = new ShuttleSimCore(scenario);
    addStoredLoads(sim, [
      'storage-r01-c01',
      'storage-r01-c02',
      'storage-r02-c01',
      'storage-r02-c02',
      'storage-r03-c01',
      'storage-r03-c02',
      'storage-r04-c01',
      'storage-r04-c02'
    ]);

    const state = runFor(sim, scenario.durationSec);
    const blockedReasons = Object.keys(state.kpis.blockedTimeByReasonSec);

    expectNoTrafficSafetyFailures(state);
    expect(state.kpis.completedInbound).toBeGreaterThan(0);
    expect(state.kpis.completedOutbound).toBeGreaterThan(0);
    expect(blockedReasons.some((reason) => reason.startsWith('fifo-') || reason.includes('lift-'))).toBe(true);
    expect(state.vehicles).toHaveLength(4);
    expect(state.vehicles.every((vehicle) => Number.isFinite(vehicle.x) && Number.isFinite(vehicle.z))).toBe(true);
  }, 60000);

  it('keeps one-direction pressure cases bounded for inbound-only and outbound-only runs', () => {
    const inboundScenario = createDefaultShuttleScenario({
      durationSec: 90,
      vehicles: { count: 4 },
      taskGeneration: {
        inboundRatePerHour: 240,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        arrivalDistribution: 'deterministic',
        maxTasks: 20
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0.2,
        liftTimeSec: 0.2,
        lowerTimeSec: 0.2,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const inboundState = runFor(new ShuttleSimCore(inboundScenario), inboundScenario.durationSec);

    expectNoTrafficSafetyFailures(inboundState);
    expect(inboundState.kpis.completedInbound).toBeGreaterThan(0);
    expect(inboundState.kpis.completedOutbound).toBe(0);

    const outboundScenario = createDefaultShuttleScenario({
      durationSec: 90,
      vehicles: { count: 4 },
      taskGeneration: {
        inboundRatePerHour: 0,
        outboundRatePerHour: 240,
        inboundOutboundMix: 0,
        arrivalDistribution: 'deterministic',
        maxTasks: 20
      },
      physicsParams: {
        emptySpeedMps: 4,
        loadedSpeedMps: 3,
        accelerationMps2: 4,
        switchDirectionSec: 0.2,
        liftTimeSec: 0.2,
        lowerTimeSec: 0.2,
        loadedClearanceM: 0.2,
        reservationClearanceSec: 0.05
      }
    });
    const outboundSim = new ShuttleSimCore(outboundScenario);
    addStoredLoads(outboundSim, [
      'storage-r01-c01',
      'storage-r01-c02',
      'storage-r01-c03',
      'storage-r01-c04',
      'storage-r02-c01',
      'storage-r02-c02',
      'storage-r02-c03',
      'storage-r02-c04'
    ]);
    const outboundState = runFor(outboundSim, outboundScenario.durationSec);

    expectNoTrafficSafetyFailures(outboundState);
    expect(outboundState.kpis.completedInbound).toBe(0);
    expect(outboundState.kpis.completedOutbound).toBeGreaterThan(0);
  }, 60000);
});
