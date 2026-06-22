import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createInboundOutboundDemoScenario,
  ShuttleSimCore
} from '../packages/shuttle-sim-core/src/index.ts';

const timesSec = stringArg('--times', '3000,3300,3600')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)
  .sort((left, right) => left - right);
const vehicleIds = stringArg('--vehicles', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outPath = resolve(stringArg('--out', 'output/review/vehicle-snapshots.json'));

const durationSec = Math.max(...timesSec, 0);
const scenario = createInboundOutboundDemoScenario({
  durationSec,
  vehicles: { count: integerArg('--shuttles', 8) },
  taskGeneration: {
    inboundRatePerHour: numberArg('--inbound-pph', 3600),
    outboundRatePerHour: numberArg('--outbound-pph', 3600),
    inboundOutboundMix: 0.5,
    initialStorageFillPolicy: 'full-columns',
    initialOutboundFullColumns: integerArg('--outbound-full-columns', 4)
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: integerArg('--regions', 2)
  }
});

const sim = new ShuttleSimCore(scenario);
const snapshots: unknown[] = [];
sim.start();

for (const timeSec of timesSec) {
  const deltaSec = timeSec - sim.getClock().simTimeSec;
  if (deltaSec > 1e-9 && sim.getClock().status === 'running') {
    sim.advanceByInPlace(deltaSec);
  }
  const state = sim.getState();
  const selectedVehicles = vehicleIds.length > 0
    ? state.vehicles.filter((vehicle) => vehicleIds.includes(vehicle.id))
    : state.vehicles;
  snapshots.push({
    timeSec: state.simTimeSec,
    status: state.status,
    kpis: state.kpis,
    traffic: state.traffic,
    waitReasons: state.vehicles.reduce<Record<string, string[]>>((groups, vehicle) => {
      const reason = vehicle.waitReason ?? 'none';
      groups[reason] ??= [];
      groups[reason]!.push(vehicle.id);
      return groups;
    }, {}),
    vehicles: selectedVehicles.map((vehicle) => ({
      id: vehicle.id,
      state: vehicle.state,
      loaded: vehicle.loaded,
      taskId: vehicle.taskId,
      currentNodeId: vehicle.currentNodeId,
      targetNodeId: vehicle.targetNodeId,
      plannedGoalNodeId: vehicle.plannedGoalNodeId,
      waitReason: vehicle.waitReason,
      blockingVehicleId: vehicle.blockingVehicleId,
      routeNodeIds: vehicle.routeNodeIds.slice(0, 12),
      plannedRouteNodeIds: vehicle.plannedRouteNodeIds.slice(0, 12),
      localRouteNodeIds: vehicle.localRouteNodeIds.slice(0, 12),
      localRouteReason: vehicle.localRouteReason
    })),
    activeTasks: state.tasks
      .filter((task) => task.state !== 'completed' && task.state !== 'failed')
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        state: task.state,
        vehicleId: task.vehicleId,
        pickupNodeId: task.pickupNodeId,
        dropoffNodeId: task.dropoffNodeId,
        waitReason: task.waitReason
      })),
    recentEvents: sim.getEventLog()
      .filter((event) =>
        event.timeSec >= state.simTimeSec - 120 &&
        (vehicleIds.length === 0 || event.vehicleId === null || vehicleIds.includes(event.vehicleId))
      )
      .slice(-200)
  });
  sim.retainRecentEventLog(5000);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ snapshots }, null, 2)}\n`);
console.log(JSON.stringify({ outPath, timesSec, status: sim.getClock().status }, null, 2));

function valueAfter(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function stringArg(name: string, fallback: string): string {
  return valueAfter(name) ?? fallback;
}

function numberArg(name: string, fallback: number): number {
  const value = valueAfter(name);
  if (value === null || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.trunc(numberArg(name, fallback));
}
