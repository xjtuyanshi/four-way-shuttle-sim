import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { LoadStateRecord, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';

type ShuttleNode = ShuttleScenario['layout']['nodes'][number];
type ShuttleEdge = ShuttleScenario['layout']['edges'][number];

type SceneRuntime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  staticGroup: THREE.Group;
  routeGroup: THREE.Group;
  reservationGroup: THREE.Group;
  loadGroup: THREE.Group;
  vehicleGroup: THREE.Group;
  nodeById: Map<string, ShuttleNode>;
  edgeById: Map<string, ShuttleEdge>;
  vehicleObjects: Map<string, THREE.Group>;
  frameId: number;
  resizeObserver: ResizeObserver;
};

export type ShuttleSceneLayers = {
  traffic: boolean;
  physics: boolean;
  loads: boolean;
  routes: boolean;
};

type VehicleObjectUserData = {
  targetPosition: THREE.Vector3;
  targetYaw: number;
  loadedMesh: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  ringMaterial: THREE.MeshBasicMaterial;
  safetyRing: THREE.Mesh;
};

const FLOOR_Y = 0;
const VEHICLE_BASE_Y = 0.08;
const CAD_CELL_LENGTH_M = 1.25;
const CAD_CELL_DEPTH_M = 1.2;
const CAD_CANVAS_WIDTH = 2048;
const CAD_CANVAS_HEIGHT = 1536;

function computeBounds(nodes: ShuttleNode[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  width: number;
  depth: number;
  size: number;
} {
  const xValues = nodes.map((node) => node.x);
  const zValues = nodes.map((node) => node.z);
  const minX = Math.min(...xValues, -4);
  const maxX = Math.max(...xValues, 20);
  const minZ = Math.min(...zValues, -6);
  const maxZ = Math.max(...zValues, 6);
  const width = Math.max(1, maxX - minX + 6);
  const depth = Math.max(1, maxZ - minZ + 6);
  return {
    minX: minX - 3,
    maxX: maxX + 3,
    minZ: minZ - 3,
    maxZ: maxZ + 3,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    width,
    depth,
    size: Math.max(width, depth)
  };
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        for (const key of ['map', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
          const texture = (material as THREE.Material & Partial<Record<typeof key, THREE.Texture>>)[key];
          texture?.dispose();
        }
        material.dispose();
      }
    }
  });
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function material(color: number, roughness = 0.72, metalness = 0.08): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

type LayoutBounds = ReturnType<typeof computeBounds>;

function drawArrow(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const arrowLength = 18;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - Math.cos(angle - Math.PI / 6) * arrowLength, toY - Math.sin(angle - Math.PI / 6) * arrowLength);
  ctx.lineTo(toX - Math.cos(angle + Math.PI / 6) * arrowLength, toY - Math.sin(angle + Math.PI / 6) * arrowLength);
  ctx.closePath();
  ctx.fill();
}

function createCadFloorTexture(scenario: ShuttleScenario, bounds: LayoutBounds): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CAD_CANVAS_WIDTH;
  canvas.height = CAD_CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to create CAD floor texture canvas.');
  }

  const inset = 92;
  const plotWidth = canvas.width - inset * 2;
  const plotHeight = canvas.height - inset * 2;
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const xToPx = (x: number) => inset + ((x - bounds.minX) / spanX) * plotWidth;
  const zToPx = (z: number) => inset + ((z - bounds.minZ) / spanZ) * plotHeight;
  const rectForMeterBox = (centerX: number, centerZ: number, widthM: number, depthM: number) => {
    const left = xToPx(centerX - widthM / 2);
    const right = xToPx(centerX + widthM / 2);
    const top = zToPx(centerZ - depthM / 2);
    const bottom = zToPx(centerZ + depthM / 2);
    return { left, top, width: right - left, height: bottom - top };
  };

  ctx.fillStyle = '#111820';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#22303a';
  ctx.lineWidth = 1;
  for (let x = Math.ceil(bounds.minX); x <= Math.floor(bounds.maxX); x += 1) {
    ctx.beginPath();
    ctx.moveTo(xToPx(x), inset);
    ctx.lineTo(xToPx(x), inset + plotHeight);
    ctx.stroke();
  }
  for (let z = Math.ceil(bounds.minZ); z <= Math.floor(bounds.maxZ); z += 1) {
    ctx.beginPath();
    ctx.moveTo(inset, zToPx(z));
    ctx.lineTo(inset + plotWidth, zToPx(z));
    ctx.stroke();
  }

  ctx.strokeStyle = '#334451';
  ctx.lineWidth = 2;
  for (let x = Math.ceil(bounds.minX / 5) * 5; x <= bounds.maxX; x += 5) {
    ctx.beginPath();
    ctx.moveTo(xToPx(x), inset);
    ctx.lineTo(xToPx(x), inset + plotHeight);
    ctx.stroke();
  }
  for (let z = Math.ceil(bounds.minZ / 5) * 5; z <= bounds.maxZ; z += 5) {
    ctx.beginPath();
    ctx.moveTo(inset, zToPx(z));
    ctx.lineTo(inset + plotWidth, zToPx(z));
    ctx.stroke();
  }

  const nodes = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  for (const edge of scenario.layout.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const isFifoLane = edge.conflictGroup?.startsWith('fifo-lane') ?? false;
    ctx.strokeStyle = isFifoLane ? '#85929b' : '#4d5a64';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = isFifoLane ? 10 : 6;
    ctx.lineCap = 'round';
    if (edge.directionMode === 'oneWay') {
      drawArrow(ctx, xToPx(from.x), zToPx(from.z), xToPx(to.x), zToPx(to.z));
    } else {
      ctx.beginPath();
      ctx.moveTo(xToPx(from.x), zToPx(from.z));
      ctx.lineTo(xToPx(to.x), zToPx(to.z));
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';

  const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
  if (storageNodes.length > 0) {
    const minStorageX = Math.min(...storageNodes.map((node) => node.x - CAD_CELL_LENGTH_M / 2));
    const maxStorageX = Math.max(...storageNodes.map((node) => node.x + CAD_CELL_LENGTH_M / 2));
    const minStorageZ = Math.min(...storageNodes.map((node) => node.z - CAD_CELL_DEPTH_M / 2));
    const maxStorageZ = Math.max(...storageNodes.map((node) => node.z + CAD_CELL_DEPTH_M / 2));
    const left = xToPx(minStorageX);
    const top = zToPx(minStorageZ);
    const width = xToPx(maxStorageX) - left;
    const height = zToPx(maxStorageZ) - top;

    ctx.fillStyle = 'rgba(79, 193, 144, 0.1)';
    ctx.strokeStyle = 'rgba(86, 169, 201, 0.78)';
    ctx.lineWidth = 3;
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left, top, width, height);

    ctx.fillStyle = '#aeb9c3';
    ctx.font = '600 28px Inter, Arial, sans-serif';
    ctx.fillText(`${(maxStorageX - minStorageX).toFixed(1)} m storage field`, left + 16, top - 14);
  }

  ctx.font = '600 22px Inter, Arial, sans-serif';
  for (const node of scenario.layout.nodes) {
    if (node.type === 'storage') {
      const rect = rectForMeterBox(node.x, node.z, CAD_CELL_LENGTH_M, CAD_CELL_DEPTH_M);
      ctx.fillStyle = 'rgba(141, 150, 156, 0.28)';
      ctx.strokeStyle = '#9aa8b5';
      ctx.lineWidth = 2;
      ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
      ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
      ctx.fillStyle = '#d5dde4';
      ctx.fillText(node.id.replace('storage-', '').toUpperCase(), rect.left + 12, rect.top + 28);
    } else {
      const x = xToPx(node.x);
      const z = zToPx(node.z);
      ctx.fillStyle = node.type === 'inbound' ? '#4f8fcb' : node.type === 'outbound' ? '#6da8d6' : node.type === 'parking' ? '#7a8794' : '#e2b84b';
      ctx.beginPath();
      ctx.arc(x, z, node.type === 'intersection' ? 14 : 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d8e1e8';
      ctx.font = '600 18px Inter, Arial, sans-serif';
      ctx.fillText(node.id, x + 18, z - 12);
    }
  }

  ctx.fillStyle = '#e6edf3';
  ctx.font = '700 32px Inter, Arial, sans-serif';
  ctx.fillText('Generated CAD layout - units: meters', inset, 48);
  ctx.font = '500 22px Inter, Arial, sans-serif';
  ctx.fillStyle = '#9aa8b5';
  ctx.fillText(`Storage cell footprint ${CAD_CELL_LENGTH_M.toFixed(2)}m x ${CAD_CELL_DEPTH_M.toFixed(2)}m; nodes and tracks are generated from SimCore coordinates.`, inset, 82);

  const storageRows = [...new Set(storageNodes.map((node) => node.z))].sort((left, right) => left - right);
  const storageColumns = [...new Set(storageNodes.map((node) => node.x))].sort((left, right) => left - right);
  if (storageRows.length > 1 || storageColumns.length > 1) {
    const pitchX = storageColumns.length > 1 ? storageColumns[1]! - storageColumns[0]! : null;
    const pitchZ = storageRows.length > 1 ? storageRows[1]! - storageRows[0]! : null;
    const label = [
      pitchX ? `cell pitch ${pitchX.toFixed(2)}m` : null,
      pitchZ ? `row pitch ${pitchZ.toFixed(2)}m` : null
    ].filter(Boolean).join(' / ');
    ctx.fillStyle = '#d5dde4';
    ctx.font = '600 24px Inter, Arial, sans-serif';
    ctx.fillText(label, inset, canvas.height - 44);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function createCadFloor(scenario: ShuttleScenario, bounds: LayoutBounds): THREE.Mesh {
  const texture = createCadFloorTexture(scenario, bounds);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.width, bounds.depth),
    new THREE.MeshBasicMaterial({ map: texture })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(bounds.centerX, FLOOR_Y - 0.003, bounds.centerZ);
  return floor;
}

function createSegment(
  from: { x: number; z: number },
  to: { x: number; z: number },
  radius: number,
  segmentMaterial: THREE.Material,
  y: number
): THREE.Mesh | null {
  const direction = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
  const length = direction.length();
  if (length < 0.001) {
    return null;
  }

  const segment = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 14), segmentMaterial);
  segment.position.set((from.x + to.x) / 2, y, (from.z + to.z) / 2);
  segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return segment;
}

function nodeColor(node: ShuttleNode): number {
  switch (node.type) {
    case 'inbound':
      return 0x4f8fcb;
    case 'outbound':
      return 0x6da8d6;
    case 'storage':
      return 0x4fc190;
    case 'parking':
      return 0x7a8794;
    case 'intersection':
      return 0xe2b84b;
    case 'lift-blackbox':
      return 0xc26f5e;
    default:
      return 0x8ba1b8;
  }
}

function createPalletLoadObject(widthM: number, depthM: number, crateColor = 0x8d969c): THREE.Group {
  const group = new THREE.Group();

  const pallet = new THREE.Mesh(new THREE.BoxGeometry(widthM, 0.08, depthM), material(0x6f777d, 0.82, 0.08));
  pallet.position.y = 0.04;
  pallet.castShadow = true;
  pallet.receiveShadow = true;
  group.add(pallet);

  const crateMaterial = material(crateColor, 0.68, 0.02);
  const crateGeometry = new THREE.BoxGeometry(widthM * 0.42, 0.28, depthM * 0.4);
  for (const [x, z] of [
    [-widthM * 0.22, -depthM * 0.18],
    [widthM * 0.22, -depthM * 0.18],
    [0, depthM * 0.2]
  ] satisfies Array<[number, number]>) {
    const crate = new THREE.Mesh(crateGeometry, crateMaterial);
    crate.position.set(x, 0.22, z);
    crate.castShadow = true;
    crate.receiveShadow = true;
    group.add(crate);
  }

  return group;
}

function createStorageTrackCell(node: ShuttleNode): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const base = new THREE.Mesh(new THREE.BoxGeometry(1.23, 0.04, 1.14), material(0x2b353c, 0.84, 0.05));
  base.position.y = 0.03;
  base.receiveShadow = true;
  group.add(base);

  const railMaterial = material(0x6e7b84, 0.58, 0.22);
  for (const z of [-0.46, 0.46]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.045, 0.045), railMaterial);
    rail.position.set(0, 0.085, z);
    rail.castShadow = true;
    group.add(rail);
  }

  const crossTieMaterial = material(0x38454e, 0.76, 0.12);
  for (const x of [-0.42, 0, 0.42]) {
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.032, 1.08), crossTieMaterial);
    tie.position.set(x, 0.062, 0);
    tie.receiveShadow = true;
    group.add(tie);
  }

  return group;
}

function createVehicleObject(scenario: ShuttleScenario): THREE.Group {
  const group = new THREE.Group();
  const bodyMaterial = material(0x287f78, 0.5, 0.22);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0x56a9c9,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(scenario.vehicles.lengthM, scenario.vehicles.heightM, scenario.vehicles.widthM),
    bodyMaterial
  );
  body.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, scenario.vehicles.heightM * 0.58, scenario.vehicles.widthM * 0.36),
    material(0xd8f0ed, 0.45, 0.16)
  );
  nose.position.set(scenario.vehicles.lengthM / 2 + 0.04, VEHICLE_BASE_Y + scenario.vehicles.heightM / 2, 0);
  group.add(nose);

  const forkMaterial = material(0xb8c5c8, 0.42, 0.28);
  for (const z of [-scenario.vehicles.widthM * 0.24, scenario.vehicles.widthM * 0.24]) {
    const fork = new THREE.Mesh(
      new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.78, 0.035, 0.045),
      forkMaterial
    );
    fork.position.set(0.04, VEHICLE_BASE_Y + scenario.vehicles.heightM + 0.025, z);
    fork.castShadow = true;
    group.add(fork);
  }

  const safetyRing = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.02, scenario.vehicles.safetyRadiusM - 0.035), scenario.vehicles.safetyRadiusM, 48),
    ringMaterial
  );
  safetyRing.rotation.x = -Math.PI / 2;
  safetyRing.position.y = FLOOR_Y + 0.018;
  group.add(safetyRing);

  const loadedMesh = createPalletLoadObject(scenario.vehicles.lengthM * 0.72, scenario.vehicles.widthM * 0.78);
  loadedMesh.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM + 0.05;
  loadedMesh.visible = false;
  group.add(loadedMesh);

  group.userData = {
    targetPosition: new THREE.Vector3(),
    targetYaw: 0,
    loadedMesh,
    bodyMaterial,
    ringMaterial,
    safetyRing
  } satisfies VehicleObjectUserData;
  return group;
}

function vehicleUserData(group: THREE.Group): VehicleObjectUserData {
  return group.userData as VehicleObjectUserData;
}

function applyVehicleState(group: THREE.Group, vehicle: VehicleState, layers: ShuttleSceneLayers, selected: boolean): void {
  const data = vehicleUserData(group);
  data.targetPosition.set(vehicle.x, 0, vehicle.z);
  data.targetYaw = -vehicle.yaw;
  data.loadedMesh.visible = vehicle.loaded;
  data.safetyRing.visible = layers.physics;
  data.ringMaterial.opacity = selected ? 0.46 : 0.22;

  if (vehicle.state === 'waiting-blocked') {
    data.bodyMaterial.color.setHex(0x9b7a31);
    data.ringMaterial.color.setHex(0xe2b84b);
    return;
  }

  if (vehicle.state === 'idle') {
    data.bodyMaterial.color.setHex(0x344554);
    data.ringMaterial.color.setHex(0x7a8794);
    return;
  }

  data.bodyMaterial.color.setHex(vehicle.loaded ? 0x3f9c77 : 0x2f8d86);
  data.ringMaterial.color.setHex(vehicle.loaded ? 0x4fc190 : 0x56a9c9);
}

function createLoadMesh(load: LoadStateRecord, node: ShuttleNode, index: number): THREE.Group {
  const loadMesh = createPalletLoadObject(node.type === 'storage' ? 1.04 : 0.78, node.type === 'storage' ? 0.88 : 0.62, load.state === 'waiting' ? 0xb98a4a : 0x8d969c);
  const offset = node.type === 'storage' ? 0 : index % 2 === 0 ? 0.38 : -0.38;
  loadMesh.position.set(node.x + offset, 0.13, node.z + (node.type === 'storage' ? 0 : 0.42));
  loadMesh.userData.loadId = load.id;
  return loadMesh;
}

function updateDynamicScene(
  runtime: SceneRuntime,
  scenario: ShuttleScenario,
  state: ShuttleSimState | null,
  layers: ShuttleSceneLayers,
  selectedVehicleId: string | null
): void {
  const activeVehicleIds = new Set((state?.vehicles ?? []).map((vehicle) => vehicle.id));
  for (const [vehicleId, object] of runtime.vehicleObjects) {
    if (!activeVehicleIds.has(vehicleId)) {
      runtime.vehicleGroup.remove(object);
      disposeObject(object);
      runtime.vehicleObjects.delete(vehicleId);
    }
  }

  for (const vehicle of state?.vehicles ?? []) {
    let object = runtime.vehicleObjects.get(vehicle.id);
    if (!object) {
      object = createVehicleObject(scenario);
      object.position.set(vehicle.x, 0, vehicle.z);
      object.rotation.y = -vehicle.yaw;
      runtime.vehicleObjects.set(vehicle.id, object);
      runtime.vehicleGroup.add(object);
    }
    applyVehicleState(object, vehicle, layers, selectedVehicleId === vehicle.id);
  }

  clearGroup(runtime.loadGroup);
  if (layers.loads) {
    const loads = (state?.loads ?? []).filter((load) => load.nodeId && load.state !== 'carried');
    loads.forEach((load, index) => {
      const node = load.nodeId ? runtime.nodeById.get(load.nodeId) : null;
      if (node) {
        runtime.loadGroup.add(createLoadMesh(load, node, index));
      }
    });
  }

  clearGroup(runtime.reservationGroup);
  if (layers.traffic) {
    const activeReservations = state?.reservations ?? [];
    for (const reservation of activeReservations) {
      if (reservation.resourceType === 'edge') {
        const edge = runtime.edgeById.get(reservation.resourceId);
        const from = edge ? runtime.nodeById.get(edge.from) : null;
        const to = edge ? runtime.nodeById.get(edge.to) : null;
        if (!from || !to) {
          continue;
        }
        const reservedSegment = createSegment(
          from,
          to,
          0.095,
          new THREE.MeshBasicMaterial({ color: 0xe2b84b, transparent: true, opacity: 0.8 }),
          0.11
        );
        if (reservedSegment) {
          runtime.reservationGroup.add(reservedSegment);
        }
      }

      if (reservation.resourceType === 'node') {
        const node = runtime.nodeById.get(reservation.resourceId);
        if (!node) {
          continue;
        }
        const marker = new THREE.Mesh(
          new THREE.RingGeometry(0.42, 0.5, 36),
          new THREE.MeshBasicMaterial({ color: 0xe2b84b, transparent: true, opacity: 0.72, side: THREE.DoubleSide })
        );
        marker.rotation.x = -Math.PI / 2;
        marker.position.set(node.x, 0.035, node.z);
        runtime.reservationGroup.add(marker);
      }
    }
  }

  clearGroup(runtime.routeGroup);
  if (layers.routes) {
    for (const vehicle of state?.vehicles ?? []) {
      if (selectedVehicleId && vehicle.id !== selectedVehicleId) {
        continue;
      }
      const routeNodes = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
      if (routeNodes.length < 2 && !vehicle.targetNodeId) {
        continue;
      }
      const routePoints = [
        { x: vehicle.x, z: vehicle.z },
        ...routeNodes.slice(1).map((nodeId) => runtime.nodeById.get(nodeId)).filter((node): node is ShuttleNode => Boolean(node))
      ];
      for (let index = 1; index < routePoints.length; index += 1) {
        const routeSegment = createSegment(
          routePoints[index - 1]!,
          routePoints[index]!,
          selectedVehicleId === vehicle.id ? 0.06 : 0.035,
          new THREE.MeshBasicMaterial({
            color: selectedVehicleId === vehicle.id ? 0x56a9c9 : 0x7a8794,
            transparent: true,
            opacity: selectedVehicleId === vehicle.id ? 0.86 : 0.48
          }),
          0.18
        );
        if (routeSegment) {
          runtime.routeGroup.add(routeSegment);
        }
      }
    }
  }
}

function buildStaticScene(runtime: SceneRuntime, scenario: ShuttleScenario): void {
  clearGroup(runtime.staticGroup);
  clearGroup(runtime.routeGroup);
  clearGroup(runtime.reservationGroup);
  clearGroup(runtime.loadGroup);
  clearGroup(runtime.vehicleGroup);
  runtime.vehicleObjects.clear();
  runtime.nodeById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  runtime.edgeById = new Map(scenario.layout.edges.map((edge) => [edge.id, edge]));

  const bounds = computeBounds(scenario.layout.nodes);
  const floor = createCadFloor(scenario, bounds);
  floor.receiveShadow = true;
  runtime.staticGroup.add(floor);

  const grid = new THREE.GridHelper(bounds.size, 12, 0x26323b, 0x1d272f);
  grid.position.set(bounds.centerX, FLOOR_Y + 0.006, bounds.centerZ);
  runtime.staticGroup.add(grid);

  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0x4f5b64, roughness: 0.82, metalness: 0.12 });
  const fifoEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0x687782, roughness: 0.76, metalness: 0.14 });
  for (const edge of scenario.layout.edges) {
    const from = runtime.nodeById.get(edge.from);
    const to = runtime.nodeById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const isFifoLane = edge.conflictGroup?.startsWith('fifo-lane') ?? false;
    const segment = createSegment(from, to, isFifoLane ? 0.058 : 0.048, isFifoLane ? fifoEdgeMaterial : edgeMaterial, 0.07);
    if (segment) {
      runtime.staticGroup.add(segment);
    }
  }

  for (const node of scenario.layout.nodes) {
    const isStorage = node.type === 'storage';
    if (isStorage) {
      runtime.staticGroup.add(createStorageTrackCell(node));
    } else {
      const nodeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 24), material(nodeColor(node), 0.66, 0.1));
      nodeMesh.position.set(node.x, 0.045, node.z);
      nodeMesh.castShadow = true;
      nodeMesh.receiveShadow = true;
      runtime.staticGroup.add(nodeMesh);
    }
  }

  runtime.camera.position.set(
    bounds.centerX - bounds.size * 0.34,
    Math.max(12, bounds.size * 0.72),
    bounds.centerZ + bounds.size * 0.48
  );
  runtime.camera.lookAt(bounds.centerX, 0, bounds.centerZ);
}

export function ShuttleScene3D({
  scenario,
  state,
  layers,
  selectedVehicleId
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: ShuttleSceneLayers;
  selectedVehicleId: string | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d141b);
    scene.fog = new THREE.Fog(0x0d141b, 32, 86);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    const root = new THREE.Group();
    const staticGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    const reservationGroup = new THREE.Group();
    const loadGroup = new THREE.Group();
    const vehicleGroup = new THREE.Group();
    root.add(staticGroup, routeGroup, reservationGroup, loadGroup, vehicleGroup);
    scene.add(root);

    const ambient = new THREE.HemisphereLight(0xffffff, 0x25323d, 1.35);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-8, 18, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.camera.left = -28;
    key.shadow.camera.right = 28;
    key.shadow.camera.top = 28;
    key.shadow.camera.bottom = -28;
    scene.add(key);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const runtime: SceneRuntime = {
      renderer,
      scene,
      camera,
      root,
      staticGroup,
      routeGroup,
      reservationGroup,
      loadGroup,
      vehicleGroup,
      nodeById: new Map(),
      edgeById: new Map(),
      vehicleObjects: new Map(),
      frameId: 0,
      resizeObserver: new ResizeObserver(resize)
    };
    runtime.resizeObserver.observe(host);
    resize();

    const render = () => {
      runtime.frameId = window.requestAnimationFrame(render);
      for (const object of runtime.vehicleObjects.values()) {
        const data = vehicleUserData(object);
        object.position.lerp(data.targetPosition, 0.22);
        object.rotation.y += normalizeAngle(data.targetYaw - object.rotation.y) * 0.24;
      }
      renderer.render(scene, camera);
    };
    render();
    runtimeRef.current = runtime;

    return () => {
      window.cancelAnimationFrame(runtime.frameId);
      runtime.resizeObserver.disconnect();
      clearGroup(staticGroup);
      clearGroup(routeGroup);
      clearGroup(reservationGroup);
      clearGroup(loadGroup);
      clearGroup(vehicleGroup);
      renderer.dispose();
      host.removeChild(renderer.domElement);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !scenario) {
      return;
    }
    buildStaticScene(runtime, scenario);
    updateDynamicScene(runtime, scenario, state, layers, selectedVehicleId);
  }, [scenario]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !scenario) {
      return;
    }
    updateDynamicScene(runtime, scenario, state, layers, selectedVehicleId);
  }, [scenario, state, layers, selectedVehicleId]);

  return <div className="shuttle-scene-3d" ref={hostRef} />;
}
