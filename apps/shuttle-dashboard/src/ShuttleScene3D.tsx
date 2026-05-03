import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { LoadStateRecord, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { summarizeScenarioStaticSceneContract, type ShuttleStaticSceneContract } from '@four-way-shuttle/sim-core/static-scene';

type ShuttleNode = ShuttleScenario['layout']['nodes'][number];
type ShuttleEdge = ShuttleScenario['layout']['edges'][number];
type ShuttleStaticSceneStorageCell = ShuttleStaticSceneContract['storageCells'][number];
type ShuttleStaticScenePad = ShuttleStaticSceneContract['liftPads'][number];
type ShuttleStaticSceneTrackBed = ShuttleStaticSceneContract['trackBeds'][number];

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
const CAD_CANVAS_WIDTH = 2048;
const CAD_CANVAS_HEIGHT = 1536;
const STORAGE_MARKER_HEIGHT_M = 0.16;

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

type StorageField = {
  cells: ShuttleStaticSceneStorageCell[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
  columns: number[];
  rows: number[];
};

export function resolveDashboardStaticSceneContract(scenario: ShuttleScenario): ShuttleStaticSceneContract {
  return summarizeScenarioStaticSceneContract(scenario);
}

function getStorageField(staticScene: ShuttleStaticSceneContract): StorageField | null {
  const cells = staticScene.storageCells;
  if (cells.length === 0) {
    return null;
  }
  const minX = Math.min(...cells.map((cell) => cell.xM - cell.lengthXM / 2));
  const maxX = Math.max(...cells.map((cell) => cell.xM + cell.lengthXM / 2));
  const minZ = Math.min(...cells.map((cell) => cell.zM - cell.lengthZM / 2));
  const maxZ = Math.max(...cells.map((cell) => cell.zM + cell.lengthZM / 2));
  return {
    cells,
    minX,
    maxX,
    minZ,
    maxZ,
    width: maxX - minX,
    depth: maxZ - minZ,
    columns: [...new Set(cells.map((cell) => cell.xM))].sort((left, right) => left - right),
    rows: [...new Set(cells.map((cell) => cell.zM))].sort((left, right) => left - right)
  };
}

function createCadFloorTexture(
  scenario: ShuttleScenario,
  staticScene: ShuttleStaticSceneContract,
  bounds: LayoutBounds
): THREE.CanvasTexture {
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

  ctx.fillStyle = '#0f151c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(75, 88, 101, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(inset, inset, plotWidth, plotHeight);

  for (const track of staticScene.trackBeds) {
    const rect = rectForMeterBox(track.xM, track.zM, Math.max(track.lengthXM, 0.08), Math.max(track.lengthZM, 0.08));
    const isStorageLane = track.category === 'storageLane';
    ctx.fillStyle = isStorageLane ? 'rgba(132, 145, 154, 0.38)' : 'rgba(77, 90, 100, 0.44)';
    ctx.strokeStyle = isStorageLane ? 'rgba(180, 191, 198, 0.64)' : 'rgba(98, 113, 124, 0.58)';
    ctx.lineWidth = 2;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }
  ctx.lineCap = 'butt';

  const storageField = getStorageField(staticScene);
  if (storageField) {
    const left = xToPx(storageField.minX);
    const top = zToPx(storageField.minZ);
    const width = xToPx(storageField.maxX) - left;
    const height = zToPx(storageField.maxZ) - top;

    ctx.fillStyle = 'rgba(66, 80, 91, 0.32)';
    ctx.strokeStyle = 'rgba(142, 162, 176, 0.7)';
    ctx.lineWidth = 3;
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left, top, width, height);
  }

  for (const cell of staticScene.storageCells) {
    const rect = rectForMeterBox(cell.xM, cell.zM, cell.lengthXM, cell.lengthZM);
    ctx.fillStyle = 'rgba(141, 150, 156, 0.18)';
    ctx.strokeStyle = '#6f7b84';
    ctx.lineWidth = 2;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }

  for (const pad of [...staticScene.liftPads, ...staticScene.parkingPads]) {
    const rect = rectForMeterBox(pad.xM, pad.zM, pad.lengthXM, pad.lengthZM);
    ctx.fillStyle = pad.category === 'inboundLift'
      ? 'rgba(79, 143, 203, 0.32)'
      : pad.category === 'outboundLift'
        ? 'rgba(109, 168, 214, 0.32)'
        : 'rgba(122, 135, 148, 0.26)';
    ctx.strokeStyle = pad.category === 'parking' ? '#7a8794' : '#9fb9c8';
    ctx.lineWidth = 2;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }

  for (const node of scenario.layout.nodes) {
    if (node.type !== 'storage' && node.type !== 'lift-blackbox' && node.type !== 'parking') {
      const x = xToPx(node.x);
      const z = zToPx(node.z);
      ctx.fillStyle = node.type === 'inbound' ? '#4f8fcb' : node.type === 'outbound' ? '#6da8d6' : '#e2b84b';
      ctx.beginPath();
      ctx.arc(x, z, node.type === 'intersection' ? 14 : 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function createCadFloor(scenario: ShuttleScenario, staticScene: ShuttleStaticSceneContract, bounds: LayoutBounds): THREE.Mesh {
  const texture = createCadFloorTexture(scenario, staticScene, bounds);
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

function createBoxTrackSegment(
  from: { x: number; z: number },
  to: { x: number; z: number },
  options: {
    gaugeM: number;
    railWidthM: number;
    railHeightM: number;
    y: number;
    railMaterial: THREE.Material;
    bedMaterial?: THREE.Material;
    bedWidthM?: number;
  }
): THREE.Group | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) {
    return null;
  }

  const group = new THREE.Group();
  const centerX = (from.x + to.x) / 2;
  const centerZ = (from.z + to.z) / 2;
  const angle = -Math.atan2(dz, dx);
  const normalX = -dz / length;
  const normalZ = dx / length;

  if (options.bedMaterial && options.bedWidthM) {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(length, 0.025, options.bedWidthM), options.bedMaterial);
    bed.position.set(centerX, options.y - 0.018, centerZ);
    bed.rotation.y = angle;
    bed.receiveShadow = true;
    group.add(bed);
  }

  for (const offset of [-options.gaugeM / 2, options.gaugeM / 2]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(length, options.railHeightM, options.railWidthM),
      options.railMaterial
    );
    rail.position.set(centerX + normalX * offset, options.y, centerZ + normalZ * offset);
    rail.rotation.y = angle;
    rail.castShadow = true;
    rail.receiveShadow = true;
    group.add(rail);
  }

  return group;
}

function trackBedEndpoints(track: ShuttleStaticSceneTrackBed): [{ x: number; z: number }, { x: number; z: number }] {
  if (track.orientation === 'z') {
    return [
      { x: track.xM, z: track.zM - track.lengthZM / 2 },
      { x: track.xM, z: track.zM + track.lengthZM / 2 }
    ];
  }
  return [
    { x: track.xM - track.lengthXM / 2, z: track.zM },
    { x: track.xM + track.lengthXM / 2, z: track.zM }
  ];
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

function createStorageRackBlock(staticScene: ShuttleStaticSceneContract): THREE.Group | null {
  const field = getStorageField(staticScene);
  if (!field) {
    return null;
  }

  const group = new THREE.Group();
  const deckMaterial = material(0x182129, 0.88, 0.05);
  const railMaterial = material(0x929da5, 0.48, 0.24);
  const beamMaterial = material(0x35414a, 0.74, 0.16);
  const markerMaterial = material(0x4b5660, 0.6, 0.22);
  const averageCellLengthM = field.cells.reduce((sum, cell) => sum + cell.lengthXM, 0) / field.cells.length;
  const averageCellDepthM = field.cells.reduce((sum, cell) => sum + cell.lengthZM, 0) / field.cells.length;

  const deck = new THREE.Mesh(new THREE.BoxGeometry(field.width, 0.035, field.depth), deckMaterial);
  deck.position.set((field.minX + field.maxX) / 2, 0.022, (field.minZ + field.maxZ) / 2);
  deck.receiveShadow = true;
  group.add(deck);

  for (const rowZ of field.rows) {
    for (const railZ of [rowZ - averageCellDepthM * 0.38, rowZ + averageCellDepthM * 0.38]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(field.width, 0.045, 0.042), railMaterial);
      rail.position.set((field.minX + field.maxX) / 2, 0.105, railZ);
      rail.castShadow = true;
      rail.receiveShadow = true;
      group.add(rail);
    }
  }

  for (const columnX of field.columns) {
    for (const railX of [columnX - averageCellLengthM * 0.36, columnX + averageCellLengthM * 0.36]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.04, field.depth), railMaterial);
      rail.position.set(railX, 0.108, (field.minZ + field.maxZ) / 2);
      rail.castShadow = true;
      rail.receiveShadow = true;
      group.add(rail);
    }
  }

  const boundaryXs = [
    field.minX,
    ...field.cells.map((cell) => cell.xM + cell.lengthXM / 2)
  ];
  const boundaryZs = [
    field.minZ,
    ...field.cells.map((cell) => cell.zM + cell.lengthZM / 2)
  ];

  for (const x of boundaryXs) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.03, field.depth), beamMaterial);
    beam.position.set(x, 0.09, (field.minZ + field.maxZ) / 2);
    beam.receiveShadow = true;
    group.add(beam);
  }

  for (const z of boundaryZs) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(field.width, 0.03, 0.026), beamMaterial);
    beam.position.set((field.minX + field.maxX) / 2, 0.092, z);
    beam.receiveShadow = true;
    group.add(beam);
  }

  for (const x of boundaryXs) {
    for (const z of boundaryZs) {
      const marker = new THREE.Mesh(new THREE.BoxGeometry(0.055, STORAGE_MARKER_HEIGHT_M, 0.055), markerMaterial);
      marker.position.set(x, STORAGE_MARKER_HEIGHT_M / 2, z);
      marker.castShadow = true;
      marker.receiveShadow = true;
      group.add(marker);
    }
  }

  return group;
}

function createStorageTrackCell(cell: ShuttleStaticSceneStorageCell): THREE.Group {
  const group = new THREE.Group();
  group.position.set(cell.xM, cell.yM, cell.zM);

  const railMaterial = material(0x9aa5ad, 0.5, 0.24);
  for (const z of [-cell.lengthZM * 0.42, cell.lengthZM * 0.42]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(cell.lengthXM * 0.94, 0.04, 0.04), railMaterial);
    rail.position.set(0, 0.12, z);
    rail.castShadow = true;
    group.add(rail);
  }
  for (const x of [-cell.lengthXM * 0.42, cell.lengthXM * 0.42]) {
    const crossRail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.036, cell.lengthZM * 0.96), railMaterial);
    crossRail.position.set(x, 0.118, 0);
    crossRail.castShadow = true;
    group.add(crossRail);
  }

  const crossTieMaterial = material(0x3f4b54, 0.76, 0.12);
  for (const x of [-cell.lengthXM * 0.34, 0, cell.lengthXM * 0.34]) {
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.028, cell.lengthZM * 0.9), crossTieMaterial);
    tie.position.set(x, 0.095, 0);
    tie.receiveShadow = true;
    group.add(tie);
  }

  return group;
}

function createConveyor(node: ShuttleNode, color: number): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.95), material(0x29333c, 0.68, 0.18));
  frame.position.y = 0.08;
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);

  const rollerMaterial = material(0x96a3ad, 0.42, 0.3);
  for (let index = 0; index < 7; index += 1) {
    const x = -0.78 + index * 0.26;
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.82, 14), rollerMaterial);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, 0.18, 0);
    roller.castShadow = true;
    group.add(roller);
  }

  const dockPlate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.035, 1.05), material(color, 0.58, 0.12));
  dockPlate.position.set(node.type === 'inbound' ? -1.12 : 1.12, 0.19, 0);
  group.add(dockPlate);

  return group;
}

function createLiftBlackboxPort(node: ShuttleNode, pad?: ShuttleStaticScenePad): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const isInbound = node.id.includes('inbound');
  const accent = isInbound ? 0x4f8fcb : 0x6da8d6;
  const padLengthX = pad?.lengthXM ?? 1.5;
  const padLengthZ = pad?.lengthZM ?? 1.15;
  const base = new THREE.Mesh(new THREE.BoxGeometry(padLengthX, 0.09, padLengthZ), material(0x111820, 0.86, 0.08));
  base.position.y = 0.055;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const blackbox = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.7, 0.28, padLengthZ * 0.72), material(0x080d11, 0.72, 0.18));
  blackbox.position.y = 0.23;
  blackbox.castShadow = true;
  blackbox.receiveShadow = true;
  group.add(blackbox);

  const rollerMaterial = material(0x96a3ad, 0.42, 0.28);
  for (let index = 0; index < 5; index += 1) {
    const x = -padLengthX * 0.28 + index * padLengthX * 0.14;
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, padLengthZ * 0.62, 12), rollerMaterial);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, 0.39, 0);
    roller.castShadow = true;
    group.add(roller);
  }

  for (const z of [-padLengthZ * 0.45, padLengthZ * 0.45]) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(padLengthX, 0.08, 0.05), material(0x303c45, 0.66, 0.18));
    guard.position.set(0, 0.42, z);
    guard.castShadow = true;
    group.add(guard);
  }

  const portPlate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, padLengthZ * 0.92), material(accent, 0.54, 0.16));
  portPlate.position.set(isInbound ? -padLengthX * 0.55 : padLengthX * 0.55, 0.26, 0);
  portPlate.castShadow = true;
  group.add(portPlate);

  return group;
}

function createParkingPad(node: ShuttleNode, pad?: ShuttleStaticScenePad): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);
  const padLengthX = pad?.lengthXM ?? 1.5;
  const padLengthZ = pad?.lengthZM ?? 1.15;
  const padMesh = new THREE.Mesh(new THREE.BoxGeometry(padLengthX, 0.035, padLengthZ), material(0x222c35, 0.82, 0.08));
  padMesh.position.y = 0.025;
  padMesh.receiveShadow = true;
  group.add(padMesh);
  const borderMaterial = material(0x6f7e8d, 0.66, 0.16);
  for (const z of [-padLengthZ * 0.42, padLengthZ * 0.42]) {
    const border = new THREE.Mesh(new THREE.BoxGeometry(padLengthX, 0.035, 0.04), borderMaterial);
    border.position.set(0, 0.075, z);
    group.add(border);
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
  const staticScene = resolveDashboardStaticSceneContract(scenario);
  const liftPadById = new Map(staticScene.liftPads.map((pad) => [pad.id, pad]));
  const parkingPadById = new Map(staticScene.parkingPads.map((pad) => [pad.id, pad]));

  const bounds = computeBounds(scenario.layout.nodes);
  const floor = createCadFloor(scenario, staticScene, bounds);
  floor.receiveShadow = true;
  runtime.staticGroup.add(floor);

  const storageBlock = createStorageRackBlock(staticScene);
  if (storageBlock) {
    runtime.staticGroup.add(storageBlock);
  }

  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0x64727c, roughness: 0.64, metalness: 0.22 });
  const fifoEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0x8a969f, roughness: 0.58, metalness: 0.24 });
  const edgeBedMaterial = new THREE.MeshStandardMaterial({ color: 0x1a232b, roughness: 0.86, metalness: 0.06 });
  for (const track of staticScene.trackBeds) {
    const [from, to] = trackBedEndpoints(track);
    const isFifoLane = track.category === 'storageLane';
    const segment = createBoxTrackSegment(from, to, {
      gaugeM: isFifoLane ? 0.92 : 0.74,
      railWidthM: isFifoLane ? 0.045 : 0.052,
      railHeightM: isFifoLane ? 0.042 : 0.052,
      y: isFifoLane ? 0.155 : 0.12,
      railMaterial: isFifoLane ? fifoEdgeMaterial : edgeMaterial,
      bedMaterial: isFifoLane ? undefined : edgeBedMaterial,
      bedWidthM: isFifoLane ? undefined : 0.92
    });
    if (segment) {
      runtime.staticGroup.add(segment);
    }
  }

  for (const cell of staticScene.storageCells) {
    runtime.staticGroup.add(createStorageTrackCell(cell));
  }

  for (const node of scenario.layout.nodes) {
    if (node.type === 'storage') {
      continue;
    }
    if (node.type === 'inbound') {
      runtime.staticGroup.add(createConveyor(node, 0x4f8fcb));
      continue;
    }
    if (node.type === 'outbound') {
      runtime.staticGroup.add(createConveyor(node, 0x6da8d6));
      continue;
    }
    if (node.type === 'lift-blackbox') {
      runtime.staticGroup.add(createLiftBlackboxPort(node, liftPadById.get(node.id)));
      continue;
    }
    if (node.type === 'parking') {
      runtime.staticGroup.add(createParkingPad(node, parkingPadById.get(node.id)));
      continue;
    }
    const nodeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.06, 24), material(nodeColor(node), 0.66, 0.1));
    nodeMesh.position.set(node.x, 0.055, node.z);
    nodeMesh.castShadow = true;
    nodeMesh.receiveShadow = true;
    runtime.staticGroup.add(nodeMesh);
  }

  runtime.camera.position.set(
    bounds.centerX - bounds.size * 0.18,
    Math.max(13, bounds.size * 0.86),
    bounds.centerZ + bounds.size * 0.28
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
