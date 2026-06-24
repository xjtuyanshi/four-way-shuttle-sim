import {
  ShuttleSimCore,
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

const scenario = createInboundOutboundDemoScenario({
  durationSec: 60,
  vehicles: { count: 8 },
  taskGeneration: {
    inboundRatePerHour: 0,
    outboundRatePerHour: 0,
    inboundOutboundMix: 0.5,
    initialOutboundFullColumns: 4,
    initialStorageFillPolicy: 'zone-balanced-50',
    storageSelectionPolicy: 'sequential'
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: 2
  },
  trafficPolicy: {
    collisionAvoidanceEnabled: true
  }
});

const sim = new ShuttleSimCore(scenario) as any;
sim.start();

function pos(nodeId: string) {
  const node = sim.scenario.layout.nodes.find((candidate: any) => candidate.id === nodeId);
  if (!node) throw new Error(`missing node ${nodeId}`);
  return { x: node.x, z: node.z };
}

function place(vehicleId: string, nodeId: string) {
  const vehicle = sim.vehicles.find((candidate: any) => candidate.id === vehicleId);
  const p = pos(nodeId);
  vehicle.currentNodeId = nodeId;
  vehicle.targetNodeId = null;
  vehicle.currentEdgeId = null;
  vehicle.routeNodeIds = [nodeId];
  vehicle.plannedRouteNodeIds = [nodeId];
  vehicle.localRouteNodeIds = [];
  vehicle.routeIndex = 0;
  vehicle.x = p.x;
  vehicle.z = p.z;
  vehicle.yaw = 0;
  vehicle.speedMps = 0;
  vehicle.legRemainingM = 0;
  vehicle.legElapsedSec = 0;
  vehicle.legTravelSec = 0;
  vehicle.waitReason = null;
  vehicle.blockingVehicleId = null;
  vehicle.blockingReservationId = null;
  vehicle.phaseRemainingSec = 0;
  return vehicle;
}

sim.currentNodeOccupancy = new Map();
const sh01 = place('SH-01', 'column-top-b-c20');
const sh07 = place('SH-07', 'module-02-spine-top-b');
const sh08 = place('SH-08', 'column-top-b-c21');
for (const vehicle of [sh01, sh07]) {
  sim.currentNodeOccupancy.set(vehicle.currentNodeId, vehicle.id);
}

sh01.state = 'waiting-blocked';
sh01.targetNodeId = 'column-top-b-c21';
sh01.waitReason = 'min-separation';
sh01.blockingVehicleId = 'SH-08';

sh07.state = 'waiting-blocked';
sh07.loaded = true;
sh07.targetNodeId = 'column-top-b-c21';
sh07.waitReason = 'node-clearing';
sh07.blockingVehicleId = 'SH-08';

sh08.state = 'moving-to-pickup';
sh08.loaded = false;
sh08.taskId = null;
sh08.targetNodeId = 'column-top-a-c21';
sh08.currentEdgeId = 'column-top-a-c21-column-top-b-c21';
sh08.routeNodeIds = [
  'column-top-b-c21',
  'column-top-a-c21',
  'module-02-spine-top-a',
  'column-top-a-c22',
  'column-top-a-c23'
];
sh08.plannedRouteNodeIds = [...sh08.routeNodeIds];
sh08.localRouteNodeIds = [...sh08.routeNodeIds];
sh08.localRouteReason = 'access-blocker-clearance';
sh08.plannedGoalNodeId = 'column-top-a-c23';
sh08.routeIndex = 0;
sh08.legRemainingM = 1.6;
sh08.legElapsedSec = 0;
sh08.legTravelSec = 3.3094010767585034;
sh08.legMotionMode = 'profile';
sh08.targetSpeedMps = 2;
sh08.legStartYaw = sh08.yaw;

function digest() {
  return {
    state: sh08.state,
    currentNodeId: sh08.currentNodeId,
    targetNodeId: sh08.targetNodeId,
    currentEdgeId: sh08.currentEdgeId,
    routeIndex: sh08.routeIndex,
    waitReason: sh08.waitReason,
    blockingVehicleId: sh08.blockingVehicleId,
    legElapsedSec: sh08.legElapsedSec,
    legRemainingM: sh08.legRemainingM,
    legTravelSec: sh08.legTravelSec,
    speedMps: sh08.speedMps,
    x: sh08.x,
    z: sh08.z,
    yaw: sh08.yaw
  };
}

console.log(JSON.stringify({ type: 'start', sh08: digest() }));
for (let index = 0; index < 25; index += 1) {
  sim.advanceMovement(sh08, 0.2);
  console.log(JSON.stringify({ type: 'tick', index, sh08: digest() }));
}
