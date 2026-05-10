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

describe('shuttle phase 0 lift approach capacity', () => {
  it('uses configured lift approach staging capacity without changing lift node capacity', () => {
    const scenario = createDefaultShuttleScenario({
      vehicles: { count: 12 },
      taskGeneration: {
        inboundRatePerHour: 7200,
        outboundRatePerHour: 0,
        inboundOutboundMix: 1,
        maxTasks: 80
      },
      trafficPolicy: { liftApproachCapacity: 2 }
    });
    const sim = new ShuttleSimCore(scenario);
    const state = runFor(sim, 90);
    const inboundPorts = state.traffic.liftPorts.filter((port) => port.kind === 'inbound');

    expect(inboundPorts).toHaveLength(4);
    expect(inboundPorts.every((port) => port.approachCapacity === 2)).toBe(true);
    expect(scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox').every((node) => node.capacity === 1)).toBe(true);
    expect(Math.max(...inboundPorts.map((port) => port.approachOccupancy))).toBeGreaterThan(1);
    expectNoTrafficSafetyFailures(state);
  }, 15000);
});
