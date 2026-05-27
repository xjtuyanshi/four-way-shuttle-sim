import { describe, expect, it } from 'vitest';

import { createInboundOutboundDemoScenario } from './index.js';
import { runHeadlessDes } from './headless-des.js';

describe('headless DES runner', () => {
  it('runs the column demo without fixed time-step ticks', () => {
    const scenario = createInboundOutboundDemoScenario({
      durationSec: 6 * 3600,
      taskGeneration: {
        inboundRatePerHour: 3600,
        outboundRatePerHour: 3600,
        initialOutboundFullColumns: 4
      }
    });

    const result = runHeadlessDes({ scenario, durationSec: 6 * 3600, sampleIntervalSec: 3600 });

    expect(result.schemaVersion).toBe('shuttle.headlessDes.v1');
    expect(result.finalSimTimeSec).toBe(6 * 3600);
    expect(result.completedInbound).toBeGreaterThan(0);
    expect(result.completedOutbound).toBeGreaterThan(0);
    expect(result.pendingInboundDemand).toBe(0);
    expect(result.pendingOutboundDemand).toBe(0);
    expect(result.skippedInbound + result.skippedOutbound).toBeGreaterThan(0);
    expect(result.processedEvents).toBeLessThan(6 * 3600 / scenario.timeStepSec);
    expect(result.samples.at(-1)?.timeSec).toBe(6 * 3600);
  });

  it('can advance a one-week headless run with bounded queues', () => {
    const scenario = createInboundOutboundDemoScenario({
      durationSec: 7 * 24 * 3600,
      vehicles: { count: 16 },
      taskGeneration: {
        inboundRatePerHour: 120,
        outboundRatePerHour: 120,
        initialOutboundFullColumns: 8
      },
      layoutProfile: {
        layoutKind: 'top-lift-column',
        liftPairCount: 4
      }
    });

    const result = runHeadlessDes({
      scenario,
      durationSec: 7 * 24 * 3600,
      sampleIntervalSec: 24 * 3600,
      maxQueuedTasks: 256
    });

    expect(result.finalSimTimeSec).toBe(7 * 24 * 3600);
    expect(result.samples).toHaveLength(8);
    expect(result.queuedTasks).toBeLessThanOrEqual(256);
    expect(result.pendingInboundDemand).toBe(0);
    expect(result.pendingOutboundDemand).toBe(0);
    expect(result.storageCapacity).toBeGreaterThan(392);
    expect(result.averageShuttleUtilization).toBeGreaterThanOrEqual(0);
    expect(result.averageShuttleUtilization).toBeLessThanOrEqual(1);
  });
});
