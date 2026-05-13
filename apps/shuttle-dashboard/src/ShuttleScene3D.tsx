import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { LoadStateRecord, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { summarizeScenarioStaticSceneContract, type ShuttleStaticSceneContract } from '@four-way-shuttle/sim-core/static-scene';

type ShuttleNode = ShuttleScenario['layout']['nodes'][number];
type ShuttleEdge = ShuttleScenario['layout']['edges'][number];
type ShuttleStaticSceneStorageCell = ShuttleStaticSceneContract['storageCells'][number];
type ShuttleStaticSceneBlockedCell = ShuttleStaticSceneContract['blockedCells'][number];
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
  loadOverlayKey: string;
  reservationOverlayKey: string;
  routeOverlayKey: string;
  cameraTarget: THREE.Vector3;
  baseCameraDistance: number;
  baseCameraYaw: number;
  baseCameraPitch: number;
  lastFrameMs: number;
  frameId: number;
  resizeObserver: ResizeObserver;
};

export type ShuttleSceneLayers = {
  traffic: boolean;
  physics: boolean;
  loads: boolean;
  routes: boolean;
};

export type ShuttleSceneCameraView = {
  zoom: number;
  yawOffsetRad: number;
  pitchOffsetRad: number;
};

export type ShuttleSceneRendererInfo = {
  vendor: string;
  renderer: string;
  hardwareAccelerated: boolean;
  webglVersion: 'WebGL1' | 'WebGL2';
};

type VehicleObjectUserData = {
  targetPosition: THREE.Vector3;
  targetYaw: number;
  loadedMesh: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  ringMaterial: THREE.MeshBasicMaterial;
  safetyRing: THREE.Mesh;
  labelSprite: THREE.Sprite | null;
  labelText: string;
};

const FLOOR_Y = 0;
const VEHICLE_BASE_Y = 0.08;
const CAD_CANVAS_WIDTH = 2048;
const CAD_CANVAS_HEIGHT = 1536;
const STORAGE_MARKER_HEIGHT_M = 0.16;
const TARGET_RENDER_FPS = 30;
const CAD_STORAGE_FILL = 'rgba(103, 72, 176, 0.2)';
const CAD_STORAGE_STROKE = 'rgba(176, 111, 255, 0.86)';
const CAD_AISLE_FILL = 'rgba(231, 190, 44, 0.22)';
const CAD_AISLE_STROKE = 'rgba(246, 214, 62, 0.92)';
const CAD_BLOCKED_FILL = 'rgba(101, 118, 111, 0.26)';
const CAD_BLOCKED_STROKE = 'rgba(151, 183, 167, 0.88)';
const CAD_DIMENSION_STROKE = 'rgba(222, 231, 236, 0.76)';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampCameraView(view: ShuttleSceneCameraView): ShuttleSceneCameraView {
  return {
    zoom: clamp(view.zoom, 0.45, 4),
    yawOffsetRad: view.yawOffsetRad,
    pitchOffsetRad: clamp(view.pitchOffsetRad, -0.78, 0.78)
  };
}

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

function applyCameraView(runtime: SceneRuntime, view: ShuttleSceneCameraView): void {
  const nextView = clampCameraView(view);
  const distance = runtime.baseCameraDistance / nextView.zoom;
  const yaw = runtime.baseCameraYaw + nextView.yawOffsetRad;
  const pitch = clamp(runtime.baseCameraPitch + nextView.pitchOffsetRad, 0.28, 1.38);
  const horizontalDistance = Math.cos(pitch) * distance;

  runtime.camera.position.set(
    runtime.cameraTarget.x + Math.sin(yaw) * horizontalDistance,
    runtime.cameraTarget.y + Math.sin(pitch) * distance,
    runtime.cameraTarget.z + Math.cos(yaw) * horizontalDistance
  );
  runtime.camera.lookAt(runtime.cameraTarget);
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function detectRendererInfo(renderer: THREE.WebGLRenderer): ShuttleSceneRendererInfo {
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
  const rendererName = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const softwarePattern = /swiftshader|software|llvmpipe|warp/i;
  return {
    vendor,
    renderer: rendererName,
    hardwareAccelerated: !softwarePattern.test(`${vendor} ${rendererName}`),
    webglVersion: renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1'
  };
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
    if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
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

function vehicleDisplayNumber(vehicleId: string): string {
  const ordinal = Number(vehicleId.replace(/\D+/g, ''));
  return Number.isFinite(ordinal) && ordinal > 0 ? String(ordinal) : vehicleId.replace(/^SH-?/i, '');
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

export type CadDimensionAnnotations = {
  storagePitchXLabelMm: string;
  storagePitchZLabelMm: string;
  innerBankGap: {
    startZM: number;
    endZM: number;
    labelMm: string;
  } | null;
};

export function resolveDashboardStaticSceneContract(scenario: ShuttleScenario): ShuttleStaticSceneContract {
  return summarizeScenarioStaticSceneContract(scenario);
}

function createStorageField(cells: ShuttleStaticSceneStorageCell[]): StorageField {
  if (cells.length === 0) {
    throw new Error('Cannot create an empty storage field.');
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

function bandIndex(value: number, sortedValues: number[], splitThresholdM: number): number {
  let band = 0;
  for (let index = 0; index < sortedValues.length; index += 1) {
    if (index > 0 && sortedValues[index]! - sortedValues[index - 1]! > splitThresholdM) {
      band += 1;
    }
    if (sortedValues[index] === value) {
      return band;
    }
  }
  return band;
}

function getStorageFields(staticScene: ShuttleStaticSceneContract): StorageField[] {
  const cells = staticScene.storageCells;
  if (cells.length === 0) {
    return [];
  }
  const xs = [...new Set(cells.map((cell) => cell.xM))].sort((left, right) => left - right);
  const zs = [...new Set(cells.map((cell) => cell.zM))].sort((left, right) => left - right);
  const splitXM = Math.max(staticScene.storagePitchXM * 1.5, 0.01);
  const splitZM = Math.max(staticScene.storagePitchZM * 1.5, 0.01);
  const cellsByField = new Map<string, ShuttleStaticSceneStorageCell[]>();
  for (const cell of cells) {
    const key = `${bandIndex(cell.xM, xs, splitXM)}:${bandIndex(cell.zM, zs, splitZM)}`;
    const fieldCells = cellsByField.get(key) ?? [];
    fieldCells.push(cell);
    cellsByField.set(key, fieldCells);
  }
  return [...cellsByField.values()]
    .map((fieldCells) => createStorageField(fieldCells))
    .sort((left, right) => left.minZ - right.minZ || left.minX - right.minX);
}

function millimeterLabel(valueM: number): string {
  return `${Math.round(valueM * 1000)}`;
}

function calibrationDimensionValue(staticScene: ShuttleStaticSceneContract, key: string): number | null {
  return staticScene.layoutCalibrationProfile?.dimensions.find((dimension) => dimension.key === key)?.valueM ?? null;
}

export function resolveCadDimensionAnnotations(staticScene: ShuttleStaticSceneContract): CadDimensionAnnotations {
  const rows = [...new Set(staticScene.storageCells.map((cell) => cell.zM))].sort((left, right) => left - right);
  const northInnerRowZ = rows.filter((z) => z < 0).at(-1);
  const southInnerRowZ = rows.find((z) => z > 0);
  const measuredInnerGapM = northInnerRowZ !== undefined && southInnerRowZ !== undefined
    ? southInnerRowZ - northInnerRowZ
    : null;
  const calibratedInnerGapM = calibrationDimensionValue(staticScene, 'innerStorageBankGapZ') ?? measuredInnerGapM;

  return {
    storagePitchXLabelMm: millimeterLabel(calibrationDimensionValue(staticScene, 'storageCellPitchX') ?? staticScene.storagePitchXM),
    storagePitchZLabelMm: millimeterLabel(calibrationDimensionValue(staticScene, 'storageCellPitchZ') ?? staticScene.storagePitchZM),
    innerBankGap: northInnerRowZ !== undefined && southInnerRowZ !== undefined && calibratedInnerGapM !== null
      ? {
          startZM: northInnerRowZ,
          endZM: southInnerRowZ,
          labelMm: millimeterLabel(calibratedInnerGapM)
        }
      : null
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
  const dimensionAnnotations = resolveCadDimensionAnnotations(staticScene);
  const xToPx = (x: number) => inset + ((x - bounds.minX) / spanX) * plotWidth;
  const zToPx = (z: number) => inset + ((z - bounds.minZ) / spanZ) * plotHeight;
  const rectForMeterBox = (centerX: number, centerZ: number, widthM: number, depthM: number) => {
    const left = xToPx(centerX - widthM / 2);
    const right = xToPx(centerX + widthM / 2);
    const top = zToPx(centerZ - depthM / 2);
    const bottom = zToPx(centerZ + depthM / 2);
    return { left, top, width: right - left, height: bottom - top };
  };
  const drawDimensionLine = (start: { x: number; z: number }, end: { x: number; z: number }, label: string) => {
    const startX = xToPx(start.x);
    const startZ = zToPx(start.z);
    const endX = xToPx(end.x);
    const endZ = zToPx(end.z);
    const labelX = (startX + endX) / 2;
    const labelZ = (startZ + endZ) / 2;
    ctx.save();
    ctx.strokeStyle = CAD_DIMENSION_STROKE;
    ctx.fillStyle = CAD_DIMENSION_STROKE;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(startX, startZ);
    ctx.lineTo(endX, endZ);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, labelX, labelZ - 14);
    ctx.restore();
  };

  ctx.fillStyle = '#0f151c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(75, 88, 101, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(inset, inset, plotWidth, plotHeight);

  for (const track of staticScene.trackBeds) {
    const rect = rectForMeterBox(track.xM, track.zM, Math.max(track.lengthXM, 0.08), Math.max(track.lengthZM, 0.08));
    const isStorageLane = track.category === 'storageLane';
    ctx.fillStyle = isStorageLane ? CAD_STORAGE_FILL : CAD_AISLE_FILL;
    ctx.strokeStyle = isStorageLane ? CAD_STORAGE_STROKE : CAD_AISLE_STROKE;
    ctx.lineWidth = 2;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }
  ctx.lineCap = 'butt';

  for (const storageField of getStorageFields(staticScene)) {
    const left = xToPx(storageField.minX);
    const top = zToPx(storageField.minZ);
    const width = xToPx(storageField.maxX) - left;
    const height = zToPx(storageField.maxZ) - top;

    ctx.fillStyle = CAD_STORAGE_FILL;
    ctx.strokeStyle = CAD_STORAGE_STROKE;
    ctx.lineWidth = 3;
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left, top, width, height);
  }

  for (const cell of staticScene.storageCells) {
    const rect = rectForMeterBox(cell.xM, cell.zM, cell.lengthXM, cell.lengthZM);
    ctx.fillStyle = 'rgba(94, 70, 164, 0.16)';
    ctx.strokeStyle = '#9d6cff';
    ctx.lineWidth = 2;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    ctx.beginPath();
    ctx.moveTo(rect.left, rect.top);
    ctx.lineTo(rect.left + rect.width, rect.top + rect.height);
    ctx.moveTo(rect.left + rect.width, rect.top);
    ctx.lineTo(rect.left, rect.top + rect.height);
    ctx.stroke();
  }

  for (const cell of staticScene.blockedCells) {
    const rect = rectForMeterBox(cell.xM, cell.zM, cell.lengthXM, cell.lengthZM);
    ctx.fillStyle = CAD_BLOCKED_FILL;
    ctx.strokeStyle = CAD_BLOCKED_STROKE;
    ctx.lineWidth = 3;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    ctx.beginPath();
    ctx.moveTo(rect.left, rect.top);
    ctx.lineTo(rect.left + rect.width, rect.top + rect.height);
    ctx.moveTo(rect.left + rect.width, rect.top);
    ctx.lineTo(rect.left, rect.top + rect.height);
    ctx.stroke();
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
      ctx.fillStyle = node.type === 'inbound' ? '#9fd9ff' : node.type === 'outbound' ? '#f6d63e' : '#f6d63e';
      ctx.beginPath();
      ctx.arc(x, z, node.type === 'intersection' ? 14 : 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (staticScene.storageCells.length > 0) {
    const sample = staticScene.storageCells[0]!;
    drawDimensionLine(
      { x: sample.xM - sample.lengthXM / 2, z: sample.zM - sample.lengthZM * 0.95 },
      { x: sample.xM + sample.lengthXM / 2, z: sample.zM - sample.lengthZM * 0.95 },
      dimensionAnnotations.storagePitchXLabelMm
    );
    drawDimensionLine(
      { x: sample.xM - sample.lengthXM * 0.85, z: sample.zM - sample.lengthZM / 2 },
      { x: sample.xM - sample.lengthXM * 0.85, z: sample.zM + sample.lengthZM / 2 },
      dimensionAnnotations.storagePitchZLabelMm
    );
    if (dimensionAnnotations.innerBankGap) {
      drawDimensionLine(
        { x: sample.xM, z: dimensionAnnotations.innerBankGap.startZM },
        { x: sample.xM, z: dimensionAnnotations.innerBankGap.endZM },
        dimensionAnnotations.innerBankGap.labelMm
      );
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

function createRouteArrow(
  from: { x: number; z: number },
  to: { x: number; z: number },
  color: number,
  y: number,
  scale: number
): THREE.Mesh | null {
  const direction = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
  const length = direction.length();
  if (length < 0.4) {
    return null;
  }
  const unit = direction.normalize();
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.1 * scale, 0.28 * scale, 18),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
  );
  arrow.position.set(to.x - unit.x * 0.34, y, to.z - unit.z * 0.34);
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), unit);
  arrow.renderOrder = 145;
  return arrow;
}

function createRouteGoalMarker(node: ShuttleNode, color: number, selected: boolean): THREE.Group {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(selected ? 0.42 : 0.3, selected ? 0.52 : 0.38, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: selected ? 0.92 : 0.58, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(node.x, 0.285, node.z);
  ring.renderOrder = 140;
  group.add(ring);

  const pin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, selected ? 0.5 : 0.34, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: selected ? 0.88 : 0.5, depthTest: false, depthWrite: false })
  );
  pin.position.set(node.x, selected ? 0.52 : 0.42, node.z);
  pin.renderOrder = 141;
  group.add(pin);
  return group;
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

function createStorageRackField(field: StorageField): THREE.Group {
  const group = new THREE.Group();
  const deckMaterial = material(0x171323, 0.88, 0.05);
  const railMaterial = material(0x7c5cff, 0.48, 0.2);
  const beamMaterial = material(0xb177ff, 0.6, 0.16);
  const markerMaterial = material(0x6b5fa6, 0.6, 0.18);
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

function createStorageRackBlock(staticScene: ShuttleStaticSceneContract): THREE.Group | null {
  const fields = getStorageFields(staticScene);
  if (fields.length === 0) {
    return null;
  }

  const group = new THREE.Group();
  for (const field of fields) {
    group.add(createStorageRackField(field));
  }
  return group;
}

function createStorageTrackCell(cell: ShuttleStaticSceneStorageCell): THREE.Group {
  const group = new THREE.Group();
  group.position.set(cell.xM, cell.yM, cell.zM);

  const railMaterial = material(0x8d78ff, 0.5, 0.2);
  const braceMaterial = material(0xb177ff, 0.48, 0.16);
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

  for (const [startX, startZ, endX, endZ] of [
    [-cell.lengthXM * 0.42, -cell.lengthZM * 0.42, cell.lengthXM * 0.42, cell.lengthZM * 0.42],
    [cell.lengthXM * 0.42, -cell.lengthZM * 0.42, -cell.lengthXM * 0.42, cell.lengthZM * 0.42]
  ] satisfies Array<[number, number, number, number]>) {
    const brace = createSegment({ x: startX, z: startZ }, { x: endX, z: endZ }, 0.012, braceMaterial, 0.165);
    if (brace) {
      group.add(brace);
    }
  }

  const crossTieMaterial = material(0x40365f, 0.76, 0.12);
  for (const x of [-cell.lengthXM * 0.34, 0, cell.lengthXM * 0.34]) {
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.028, cell.lengthZM * 0.9), crossTieMaterial);
    tie.position.set(x, 0.095, 0);
    tie.receiveShadow = true;
    group.add(tie);
  }

  return group;
}

function createBlockedCellMarker(cell: ShuttleStaticSceneBlockedCell): THREE.Group {
  const group = new THREE.Group();
  group.position.set(cell.xM, cell.yM, cell.zM);

  const baseMaterial = material(cell.role === 'structural' ? 0x354640 : 0x473f38, 0.8, 0.08);
  const braceMaterial = material(cell.role === 'structural' ? 0x8fb8a4 : 0xd19d6b, 0.58, 0.12);
  const base = new THREE.Mesh(new THREE.BoxGeometry(cell.lengthXM * 0.94, 0.026, cell.lengthZM * 0.94), baseMaterial);
  base.position.y = 0.071;
  base.receiveShadow = true;
  group.add(base);

  for (const [startX, startZ, endX, endZ] of [
    [-cell.lengthXM * 0.42, -cell.lengthZM * 0.42, cell.lengthXM * 0.42, cell.lengthZM * 0.42],
    [cell.lengthXM * 0.42, -cell.lengthZM * 0.42, -cell.lengthXM * 0.42, cell.lengthZM * 0.42]
  ] satisfies Array<[number, number, number, number]>) {
    const brace = createSegment({ x: startX, z: startZ }, { x: endX, z: endZ }, 0.02, braceMaterial, 0.116);
    if (brace) {
      group.add(brace);
    }
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

  const isInbound = node.liftKind === 'inbound';
  const roleAccent = isInbound ? 0x4f8fcb : 0x6da8d6;
  const padLengthX = pad?.lengthXM ?? 1.5;
  const padLengthZ = pad?.lengthZM ?? 1.15;

  const base = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 1.08, 0.045, padLengthZ * 1.12), material(0x111820, 0.86, 0.08));
  base.position.y = 0.025;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const transferDeck = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.88, 0.055, padLengthZ * 0.78), material(0x322914, 0.72, 0.12));
  transferDeck.position.y = 0.095;
  transferDeck.castShadow = true;
  transferDeck.receiveShadow = true;
  group.add(transferDeck);

  const guideMaterial = material(0xf0ce3b, 0.42, 0.24);
  for (const z of [-padLengthZ * 0.42, padLengthZ * 0.42]) {
    const guideRail = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 1.02, 0.05, 0.045), guideMaterial);
    guideRail.position.set(0, 0.17, z);
    guideRail.castShadow = true;
    group.add(guideRail);
  }

  for (const x of [-padLengthX * 0.46, padLengthX * 0.46]) {
    const sideGuide = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, padLengthZ * 0.88), guideMaterial);
    sideGuide.position.set(x, 0.185, 0);
    sideGuide.castShadow = true;
    group.add(sideGuide);
  }

  const rollerMaterial = material(0x96a3ad, 0.42, 0.28);
  for (let index = 0; index < 7; index += 1) {
    const x = -padLengthX * 0.34 + index * padLengthX * 0.113;
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, padLengthZ * 0.66, 12), rollerMaterial);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, 0.235, 0);
    roller.castShadow = true;
    group.add(roller);
  }

  const postMaterial = material(0xe6eef2, 0.38, 0.32);
  const postAccentMaterial = material(roleAccent, 0.5, 0.22);
  for (const x of [-padLengthX * 0.5, padLengthX * 0.5]) {
    for (const z of [-padLengthZ * 0.46, padLengthZ * 0.46]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.62, 12), postMaterial);
      post.position.set(x, 0.38, z);
      post.castShadow = true;
      group.add(post);

      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.16), postAccentMaterial);
      cap.position.set(x, 0.71, z);
      cap.castShadow = true;
      group.add(cap);
    }
  }

  const portPlate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, padLengthZ * 0.68), material(roleAccent, 0.54, 0.16));
  portPlate.position.set(isInbound ? -padLengthX * 0.58 : padLengthX * 0.58, 0.22, 0);
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

function createTextBillboard(
  text: string,
  options: { background: string; foreground?: string; border?: string; scale?: { x: number; y: number }; y?: number }
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create label canvas context.');
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = options.background;
  context.strokeStyle = options.border ?? 'rgba(255,255,255,0.82)';
  context.lineWidth = 6;
  context.beginPath();
  context.roundRect(20, 12, 88, 72, 18);
  context.fill();
  context.stroke();
  context.fillStyle = options.foreground ?? '#f8fbff';
  context.font = '700 46px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 64, 50);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  }));
  const scale = options.scale ?? { x: 0.76, y: 0.54 };
  sprite.scale.set(scale.x, scale.y, 1);
  sprite.position.y = options.y ?? 0.72;
  sprite.renderOrder = 200;
  return sprite;
}

function createTaskAssignmentMarker(node: ShuttleNode, label: string): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.52, 0.66, 40),
    new THREE.MeshBasicMaterial({ color: 0x82c7ff, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.42;
  ring.renderOrder = 150;
  group.add(ring);
  group.add(createTextBillboard(label, {
    background: 'rgba(47, 120, 212, 0.92)',
    border: 'rgba(192, 226, 255, 0.96)',
    scale: { x: 0.82, y: 0.58 },
    y: 1.04
  }));
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
    safetyRing,
    labelSprite: null,
    labelText: ''
  } satisfies VehicleObjectUserData;
  return group;
}

function vehicleUserData(group: THREE.Group): VehicleObjectUserData {
  return group.userData as VehicleObjectUserData;
}

function applyVehicleState(group: THREE.Group, vehicle: VehicleState, layers: ShuttleSceneLayers, selected: boolean): void {
  const data = vehicleUserData(group);
  const labelText = vehicleDisplayNumber(vehicle.id);
  if (data.labelText !== labelText) {
    if (data.labelSprite) {
      group.remove(data.labelSprite);
      disposeObject(data.labelSprite);
    }
    data.labelSprite = createTextBillboard(labelText, {
      background: 'rgba(12, 20, 26, 0.88)',
      border: selected ? 'rgba(130,199,255,0.96)' : 'rgba(216,240,237,0.82)',
      scale: { x: 0.62, y: 0.45 },
      y: 0.74
    });
    data.labelText = labelText;
    group.add(data.labelSprite);
  }
  if (data.labelSprite) {
    data.labelSprite.position.y = selected ? 0.86 : 0.74;
    data.labelSprite.scale.set(selected ? 0.72 : 0.62, selected ? 0.52 : 0.45, 1);
  }
  data.targetPosition.set(vehicle.x, 0, vehicle.z);
  data.targetYaw = vehicle.yaw;
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

  if (vehicle.loaded) {
    data.bodyMaterial.color.setHex(0x3f9c77);
    data.ringMaterial.color.setHex(0x4fc190);
    return;
  }

  if (vehicle.taskId) {
    data.bodyMaterial.color.setHex(0x2f78d4);
    data.ringMaterial.color.setHex(0x82c7ff);
    return;
  }

  data.bodyMaterial.color.setHex(0x6158c7);
  data.ringMaterial.color.setHex(0x8d78ff);
}

function vehicleRouteColor(vehicle: VehicleState): number {
  if (vehicle.loaded) return 0x4fc190;
  if (vehicle.taskId) return 0x56a9c9;
  return 0x8d78ff;
}

function createLoadMesh(load: LoadStateRecord, node: ShuttleNode, index: number): THREE.Group {
  const loadMesh = createPalletLoadObject(node.type === 'storage' ? 1.04 : 0.78, node.type === 'storage' ? 0.88 : 0.62, load.state === 'waiting' ? 0xb98a4a : 0x8d969c);
  const offset = node.type === 'storage' ? 0 : index % 2 === 0 ? 0.38 : -0.38;
  loadMesh.position.set(node.x + offset, 0.13, node.z + (node.type === 'storage' ? 0 : 0.42));
  loadMesh.userData.loadId = load.id;
  return loadMesh;
}

function loadOverlayKey(state: ShuttleSimState | null, layers: ShuttleSceneLayers): string {
  if (!layers.loads) return 'off';
  return (state?.loads ?? [])
    .filter((load) => load.nodeId && load.state !== 'carried')
    .map((load) => `${load.id}:${load.state}:${load.nodeId ?? ''}:${load.vehicleId ?? ''}`)
    .sort()
    .join('|');
}

function reservationOverlayKey(state: ShuttleSimState | null, layers: ShuttleSceneLayers): string {
  if (!layers.traffic) return 'off';
  return (state?.reservations ?? [])
    .map((reservation) =>
      `${reservation.id}:${reservation.resourceType}:${reservation.resourceId}:${reservation.vehicleId}:${Math.round(reservation.endTimeSec * 10)}`
    )
    .sort()
    .join('|');
}

function routeOverlayKey(
  state: ShuttleSimState | null,
  layers: ShuttleSceneLayers,
  selectedVehicleId: string | null
): string {
  if (!layers.routes) return 'off';
  const routeKey = (state?.vehicles ?? [])
    .map((vehicle) => [
      vehicle.id,
      vehicle.routeIndex,
      vehicle.currentNodeId,
      vehicle.currentEdgeId ?? '',
      vehicle.targetNodeId ?? '',
      vehicle.plannedGoalNodeId ?? '',
      vehicle.plannedRouteNodeIds.join('>'),
      vehicle.localRouteReason ?? '',
      vehicle.localRouteNodeIds.join('>')
    ].join(':'))
    .join('|');
  const pickupAssignmentKey = (state?.tasks ?? [])
    .filter((task) => task.vehicleId && task.state !== 'completed' && task.state !== 'failed')
    .map((task) => `${task.id}:${task.vehicleId}:${task.state}:${task.pickupNodeId}:${task.dropoffNodeId}`)
    .sort()
    .join('|');
  return `${routeKey}::selected:${selectedVehicleId ?? ''}::tasks:${pickupAssignmentKey}`;
}

function routePointsForNodeIds(
  runtime: SceneRuntime,
  vehicle: VehicleState,
  nodeIds: string[]
): Array<{ x: number; z: number }> {
  if (nodeIds.length < 2) {
    return [];
  }
  return [
    { x: vehicle.x, z: vehicle.z },
    ...nodeIds.slice(1).map((nodeId) => runtime.nodeById.get(nodeId)).filter((node): node is ShuttleNode => Boolean(node))
  ];
}

function addRoutePath(
  group: THREE.Group,
  points: Array<{ x: number; z: number }>,
  options: { color: number; radius: number; opacity: number; y: number; arrows: boolean; arrowScale: number }
): void {
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const routeMaterial = new THREE.MeshBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: options.opacity,
      depthTest: false,
      depthWrite: false
    });
    const routeSegment = createSegment(
      from,
      to,
      options.radius,
      routeMaterial,
      options.y
    );
    if (routeSegment) {
      routeSegment.renderOrder = 130;
      group.add(routeSegment);
    }
    if (options.arrows && index % 3 === 0) {
      const arrow = createRouteArrow(from, to, options.color, options.y + 0.05, options.arrowScale);
      if (arrow) {
        group.add(arrow);
      }
    }
  }
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
      object.rotation.y = 0;
      runtime.vehicleObjects.set(vehicle.id, object);
      runtime.vehicleGroup.add(object);
    }
    applyVehicleState(object, vehicle, layers, selectedVehicleId === vehicle.id);
  }

  const nextLoadOverlayKey = loadOverlayKey(state, layers);
  if (runtime.loadOverlayKey !== nextLoadOverlayKey) {
    runtime.loadOverlayKey = nextLoadOverlayKey;
    clearGroup(runtime.loadGroup);
  }
  if (layers.loads && runtime.loadGroup.children.length === 0) {
    const loads = (state?.loads ?? []).filter((load) => load.nodeId && load.state !== 'carried');
    loads.forEach((load, index) => {
      const node = load.nodeId ? runtime.nodeById.get(load.nodeId) : null;
      if (node) {
        runtime.loadGroup.add(createLoadMesh(load, node, index));
      }
    });
  }

  const nextReservationOverlayKey = reservationOverlayKey(state, layers);
  if (runtime.reservationOverlayKey !== nextReservationOverlayKey) {
    runtime.reservationOverlayKey = nextReservationOverlayKey;
    clearGroup(runtime.reservationGroup);
  }
  if (layers.traffic && runtime.reservationGroup.children.length === 0) {
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

  const nextRouteOverlayKey = routeOverlayKey(state, layers, selectedVehicleId);
  if (runtime.routeOverlayKey !== nextRouteOverlayKey) {
    runtime.routeOverlayKey = nextRouteOverlayKey;
    clearGroup(runtime.routeGroup);
  }
  if (layers.routes && runtime.routeGroup.children.length === 0) {
    const vehicleById = new Map((state?.vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
    for (const task of state?.tasks ?? []) {
      const vehicle = task.vehicleId ? vehicleById.get(task.vehicleId) : null;
      const pickupNode = runtime.nodeById.get(task.pickupNodeId);
      if (!vehicle || !pickupNode || vehicle.loaded || task.state === 'completed' || task.state === 'failed') {
        continue;
      }
      runtime.routeGroup.add(createTaskAssignmentMarker(pickupNode, vehicleDisplayNumber(vehicle.id)));
    }

    for (const vehicle of state?.vehicles ?? []) {
      const selected = selectedVehicleId === vehicle.id;
      const routeColor = vehicleRouteColor(vehicle);
      const plannedRouteNodes = vehicle.plannedRouteNodeIds.length >= 2
        ? vehicle.plannedRouteNodeIds
        : vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
      const plannedRoutePoints = routePointsForNodeIds(runtime, vehicle, plannedRouteNodes);
      if (plannedRoutePoints.length >= 2) {
        addRoutePath(runtime.routeGroup, plannedRoutePoints, {
          color: routeColor,
          radius: selected ? 0.065 : 0.04,
          opacity: selected ? 0.92 : 0.72,
          y: selected ? 0.29 : 0.24,
          arrows: selected,
          arrowScale: selected ? 1.15 : 0.85
        });
      }

      const localRoutePoints = routePointsForNodeIds(runtime, vehicle, vehicle.localRouteNodeIds);
      if (localRoutePoints.length >= 2) {
        addRoutePath(runtime.routeGroup, localRoutePoints, {
          color: 0xe2b84b,
          radius: selected ? 0.074 : 0.044,
          opacity: selected ? 0.96 : 0.74,
          y: selected ? 0.335 : 0.295,
          arrows: true,
          arrowScale: selected ? 1.25 : 0.95
        });
      }

      const goalNode = vehicle.plannedGoalNodeId ? runtime.nodeById.get(vehicle.plannedGoalNodeId) : null;
      if (goalNode) {
        runtime.routeGroup.add(createRouteGoalMarker(goalNode, routeColor, selected));
      }
    }
  }
}

function buildStaticScene(runtime: SceneRuntime, scenario: ShuttleScenario, cameraView: ShuttleSceneCameraView): void {
  clearGroup(runtime.staticGroup);
  clearGroup(runtime.routeGroup);
  clearGroup(runtime.reservationGroup);
  clearGroup(runtime.loadGroup);
  clearGroup(runtime.vehicleGroup);
  runtime.loadOverlayKey = '';
  runtime.reservationOverlayKey = '';
  runtime.routeOverlayKey = '';
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

  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xf0ce3b, roughness: 0.52, metalness: 0.18 });
  const fifoEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0x8d78ff, roughness: 0.54, metalness: 0.2 });
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

  for (const cell of staticScene.blockedCells) {
    runtime.staticGroup.add(createBlockedCellMarker(cell));
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

  runtime.root.scale.set(-1, 1, 1);
  runtime.root.position.set(bounds.centerX * 2, 0, 0);
  runtime.cameraTarget.set(bounds.centerX, 0, bounds.centerZ);
  const defaultCameraOffset = new THREE.Vector3(0, Math.max(13, bounds.size * 0.86), -bounds.size * 0.34);
  runtime.baseCameraDistance = defaultCameraOffset.length();
  runtime.baseCameraYaw = Math.atan2(defaultCameraOffset.x, defaultCameraOffset.z);
  runtime.baseCameraPitch = Math.asin(defaultCameraOffset.y / Math.max(0.001, runtime.baseCameraDistance));
  applyCameraView(runtime, cameraView);
}

export function ShuttleScene3D({
  scenario,
  state,
  layers,
  selectedVehicleId,
  cameraView,
  onCameraViewChange,
  onRendererInfo
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: ShuttleSceneLayers;
  selectedVehicleId: string | null;
  cameraView: ShuttleSceneCameraView;
  onCameraViewChange: (view: ShuttleSceneCameraView) => void;
  onRendererInfo?: (info: ShuttleSceneRendererInfo) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const cameraViewRef = useRef<ShuttleSceneCameraView>(cameraView);
  const onCameraViewChangeRef = useRef(onCameraViewChange);
  const onRendererInfoRef = useRef(onRendererInfo);

  useEffect(() => {
    cameraViewRef.current = cameraView;
    const runtime = runtimeRef.current;
    if (runtime) {
      applyCameraView(runtime, cameraView);
    }
  }, [cameraView]);

  useEffect(() => {
    onCameraViewChangeRef.current = onCameraViewChange;
  }, [onCameraViewChange]);

  useEffect(() => {
    onRendererInfoRef.current = onRendererInfo;
  }, [onRendererInfo]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c141a);
    scene.fog = new THREE.Fog(0x0c141a, 42, 112);

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    onRendererInfoRef.current?.(detectRendererInfo(renderer));

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    const root = new THREE.Group();
    const staticGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    const reservationGroup = new THREE.Group();
    const loadGroup = new THREE.Group();
    const vehicleGroup = new THREE.Group();
    root.add(staticGroup, routeGroup, reservationGroup, loadGroup, vehicleGroup);
    scene.add(root);

    const ambient = new THREE.HemisphereLight(0xffffff, 0x26343e, 1.55);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 1.85);
    key.position.set(-8, 18, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -28;
    key.shadow.camera.right = 28;
    key.shadow.camera.top = 28;
    key.shadow.camera.bottom = -28;
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x7abed0, 0.8);
    rim.position.set(16, 12, -14);
    scene.add(rim);

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
      loadOverlayKey: '',
      reservationOverlayKey: '',
      routeOverlayKey: '',
      cameraTarget: new THREE.Vector3(),
      baseCameraDistance: 1,
      baseCameraYaw: 0,
      baseCameraPitch: 0.9,
      lastFrameMs: performance.now(),
      frameId: 0,
      resizeObserver: new ResizeObserver(resize)
    };
    runtime.resizeObserver.observe(host);
    resize();

    let pointerDrag: { pointerId: number; x: number; y: number } | null = null;
    const updateCameraFromPointer = (nextView: ShuttleSceneCameraView) => {
      const clampedView = clampCameraView(nextView);
      cameraViewRef.current = clampedView;
      onCameraViewChangeRef.current(clampedView);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      const dx = event.clientX - pointerDrag.x;
      const dy = event.clientY - pointerDrag.y;
      pointerDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      const current = cameraViewRef.current;
      updateCameraFromPointer({
        ...current,
        yawOffsetRad: current.yawOffsetRad - dx * 0.008,
        pitchOffsetRad: current.pitchOffsetRad + dy * 0.006
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pointerDrag?.pointerId === event.pointerId) {
        pointerDrag = null;
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = cameraViewRef.current;
      updateCameraFromPointer({
        ...current,
        zoom: current.zoom * (event.deltaY > 0 ? 0.9 : 1.1)
      });
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    const render = (nowMs: number) => {
      runtime.frameId = window.requestAnimationFrame(render);
      if (nowMs - runtime.lastFrameMs < 1000 / TARGET_RENDER_FPS) {
        return;
      }
      const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - runtime.lastFrameMs) / 1000));
      runtime.lastFrameMs = nowMs;
      const positionAlpha = 1 - Math.exp(-dtSec * 12);
      const yawAlpha = 1 - Math.exp(-dtSec * 14);
      for (const object of runtime.vehicleObjects.values()) {
        const data = vehicleUserData(object);
        object.position.lerp(data.targetPosition, positionAlpha);
        object.rotation.y += normalizeAngle(data.targetYaw - object.rotation.y) * yawAlpha;
      }
      renderer.render(scene, camera);
    };
    runtime.frameId = window.requestAnimationFrame(render);
    runtimeRef.current = runtime;

    return () => {
      window.cancelAnimationFrame(runtime.frameId);
      runtime.resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
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
    buildStaticScene(runtime, scenario, cameraViewRef.current);
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
