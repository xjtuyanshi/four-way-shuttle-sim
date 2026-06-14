import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario,
  hashScenario
} from './index.js';

const enabled = process.env.SHUTTLE_PHYSICAL_LONG_VITEST === '1';
const describeLong = enabled ? describe : describe.skip;

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function integerEnv(name: string, fallback: number): number {
  return Math.max(0, Math.floor(numberEnv(name, fallback)));
}

function stringEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

describeLong('physical long run via vitest', () => {
  it('runs the top-lift physical tick model without server or tsx', async () => {
    const durationSec = numberEnv('SHUTTLE_PHYSICAL_DURATION_SEC', 7200);
    const sampleSec = numberEnv('SHUTTLE_PHYSICAL_SAMPLE_SEC', 3600);
    const maxChunkSec = numberEnv('SHUTTLE_PHYSICAL_CHUNK_SEC', 120);
    const regionCount = integerEnv('SHUTTLE_PHYSICAL_REGIONS', 2);
    const shuttleCount = integerEnv('SHUTTLE_PHYSICAL_SHUTTLES', 8);
    const inboundRatePerHour = numberEnv('SHUTTLE_PHYSICAL_INBOUND_PPH', 3600);
    const outboundRatePerHour = numberEnv('SHUTTLE_PHYSICAL_OUTBOUND_PPH', 3600);
    const initialOutboundFullColumns = integerEnv('SHUTTLE_PHYSICAL_OUTBOUND_FULL_COLUMNS', 4);
    const outputPath = resolve(stringEnv(
      'SHUTTLE_PHYSICAL_OUT',
      `/private/tmp/shuttle-physical-vitest-${Date.now()}.json`
    ));

    const scenario = createInboundOutboundDemoScenario({
      durationSec,
      vehicles: { count: shuttleCount },
      taskGeneration: {
        inboundRatePerHour,
        outboundRatePerHour,
        inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
          ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
          : 0.5,
        initialOutboundFullColumns
      },
      layoutProfile: {
        layoutKind: 'top-lift-column',
        liftPairCount: regionCount
      },
      trafficPolicy: {
        collisionAvoidanceEnabled: true
      }
    });
    const sim = new ShuttleSimCore(scenario);
    const startedAtMs = Date.now();
    const samples: Array<{
      timeSec: number;
      wallClockMs: number;
      inboundPph: number;
      outboundPph: number;
      totalPph: number;
      windowInboundPph: number;
      windowOutboundPph: number;
      windowTotalPph: number;
      completedInbound: number;
      completedOutbound: number;
      queuedTasks: number;
      activeTasks: number;
      waitingVehicles: number;
      blockedVehicles: number;
      physicalViolations: number;
      topBlockedReasons: Array<{ reason: string; sec: number }>;
    }> = [];

    const sample = () => {
      const state = sim.getState();
      samples.push({
        timeSec: round(state.simTimeSec),
        wallClockMs: Date.now() - startedAtMs,
        inboundPph: round(state.kpis.inboundPph),
        outboundPph: round(state.kpis.outboundPph),
        totalPph: round(state.kpis.totalPph),
        windowInboundPph: round(state.kpis.windowInboundPph),
        windowOutboundPph: round(state.kpis.windowOutboundPph),
        windowTotalPph: round(state.kpis.windowTotalPph),
        completedInbound: state.kpis.completedInbound,
        completedOutbound: state.kpis.completedOutbound,
        queuedTasks: state.kpis.queuedTasks,
        activeTasks: state.kpis.activeTasks,
        waitingVehicles: state.traffic.waitingVehicles.length,
        blockedVehicles: state.vehicles.filter((vehicle) => vehicle.state === 'waiting-blocked').length,
        physicalViolations: state.traffic.physicalViolationCount,
        topBlockedReasons: Object.entries(state.kpis.blockedTimeByReasonSec)
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 8)
          .map(([reason, sec]) => ({ reason, sec: round(sec) }))
      });
    };

    sim.start();
    sample();
    for (let nextSampleSec = sampleSec; sim.getClock().simTimeSec < durationSec - 1e-9;) {
      const stepSec = Math.min(
        Math.max(scenario.timeStepSec, nextSampleSec - sim.getClock().simTimeSec),
        maxChunkSec,
        durationSec - sim.getClock().simTimeSec
      );
      sim.advanceByInPlace(stepSec);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (sim.getClock().simTimeSec + 1e-9 >= nextSampleSec || sim.getClock().simTimeSec >= durationSec - 1e-9) {
        sample();
        while (nextSampleSec <= sim.getClock().simTimeSec + 1e-9) {
          nextSampleSec += sampleSec;
        }
      }
      if (sim.getClock().status !== 'running') {
        break;
      }
    }

    const finalState = sim.getState();
    const finalWaiting = finalState.traffic.waitingVehicles.map((waiting) => {
      const vehicle = finalState.vehicles.find((candidate) => candidate.id === waiting.vehicleId);
      return {
        id: waiting.vehicleId,
        state: vehicle?.state ?? null,
        loaded: vehicle?.loaded ?? null,
        currentNodeId: waiting.currentNodeId,
        targetNodeId: waiting.targetNodeId,
        plannedGoalNodeId: vehicle?.plannedGoalNodeId ?? null,
        waitReason: waiting.waitReason,
        blockingVehicleId: waiting.blockingVehicleId,
        waitingSinceSec: waiting.waitingSinceSec
      };
    });
    const result = {
      schemaVersion: 'shuttle.physicalLongVitest.v1',
      scenarioId: scenario.id,
      scenarioHash: hashScenario(scenario),
      durationSec,
      finalSimTimeSec: finalState.simTimeSec,
      finalTickIndex: sim.getClock().tickIndex,
      status: finalState.status,
      wallClockMs: Date.now() - startedAtMs,
      pph: {
        inbound: round(finalState.kpis.inboundPph),
        outbound: round(finalState.kpis.outboundPph),
        total: round(finalState.kpis.totalPph),
        windowInbound: round(finalState.kpis.windowInboundPph),
        windowOutbound: round(finalState.kpis.windowOutboundPph),
        windowTotal: round(finalState.kpis.windowTotalPph)
      },
      completed: {
        inbound: finalState.kpis.completedInbound,
        outbound: finalState.kpis.completedOutbound
      },
      traffic: {
        deadlocks: finalState.kpis.deadlockCount,
        livelocks: finalState.kpis.livelockCount,
        physicalViolations: finalState.traffic.physicalViolationCount,
        waitingVehicles: finalState.traffic.waitingVehicles.length,
        blockedVehicles: finalState.vehicles.filter((vehicle) => vehicle.state === 'waiting-blocked').length,
        minVehicleSeparationM: finalState.traffic.minVehicleSeparationM
      },
      finalWaiting,
      samples
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ type: 'physical-long-vitest-complete', outputPath, ...result.pph, traffic: result.traffic }));

    expect(finalState.simTimeSec).toBe(durationSec);
    expect(finalState.kpis.deadlockCount).toBe(0);
    expect(finalState.kpis.livelockCount).toBe(0);
    expect(finalState.traffic.physicalViolationCount).toBe(0);
  }, numberEnv('SHUTTLE_PHYSICAL_TIMEOUT_MS', 300000));
});
