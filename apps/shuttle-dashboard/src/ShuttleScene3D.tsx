import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { LoadStateRecord, ShuttleScenario, ShuttleSimState, VehicleState } from '@four-way-shuttle/schemas';
import { summarizeScenarioStaticSceneContract, type ShuttleStaticSceneContract } from '@four-way-shuttle/sim-core/static-scene';
import { flowRgba, FLOW_VISUAL_COLORS, resolveLoadFlowRole, resolveVehicleLoadFlowRole, resolveVehicleTaskFlowRole, type LoadFlowRole } from './flowColors.js';
import { createStorageCellRects, createTrackAreaRects, getStorageFields, type MeterRect, type StorageField } from './layoutVisuals.js';

type ShuttleNode = ShuttleScenario['layout']['nodes'][number];
type ShuttleEdge = ShuttleScenario['layout']['edges'][number];
type ShuttleStaticSceneBlockedCell = ShuttleStaticSceneContract['blockedCells'][number];
type ShuttleStaticScenePad = ShuttleStaticSceneContract['liftPads'][number];
type ShuttleStaticSceneTrackBed = ShuttleStaticSceneContract['trackBeds'][number];

type SceneRuntime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  staticGroup: THREE.Group;
  networkGroup: THREE.Group;
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
  accentMaterial: THREE.MeshStandardMaterial;
  beaconMaterial: THREE.MeshBasicMaterial;
  ringMaterial: THREE.MeshBasicMaterial;
  safetyRing: THREE.Mesh;
  labelSprite: THREE.Sprite | null;
  labelText: string;
};

const FLOOR_Y = 0;
const VEHICLE_BASE_Y = 0.08;
const CAD_CANVAS_WIDTH = 2048;
const CAD_CANVAS_HEIGHT = 1536;
const TARGET_RENDER_FPS = 60;
const CAD_STORAGE_FILL = 'rgba(103, 72, 176, 0.2)';
const CAD_STORAGE_STROKE = 'rgba(176, 111, 255, 0.86)';
const CAD_AISLE_FILL = 'rgba(231, 190, 44, 0.22)';
const CAD_BLOCKED_FILL = 'rgba(101, 118, 111, 0.26)';
const CAD_BLOCKED_STROKE = 'rgba(151, 183, 167, 0.88)';
const TEXTURE_ASSETS = {
  fabric: {
    color: '/assets/textures/ambientcg-fabric001/color.jpg',
    normal: '/assets/textures/ambientcg-fabric001/normal.jpg',
    roughness: '/assets/textures/ambientcg-fabric001/roughness.jpg'
  },
  rubber: {
    color: '/assets/textures/ambientcg-rubber001/color.jpg',
    normal: '/assets/textures/ambientcg-rubber001/normal.jpg',
    roughness: '/assets/textures/ambientcg-rubber001/roughness.jpg'
  },
  metalPlate: {
    color: '/assets/textures/polyhaven-metal-plate/diff.jpg',
    normal: '/assets/textures/polyhaven-metal-plate/normal.jpg',
    roughness: '/assets/textures/polyhaven-metal-plate/rough.jpg'
  }
} as const;
const textureLoader = new THREE.TextureLoader();
const presentationTextureCache = new Map<string, THREE.Texture>();

function toVisualX(x: number): number {
  return x;
}

function toVisualYaw(yaw: number): number {
  return yaw;
}

function toVisualNode(node: ShuttleNode): ShuttleNode {
  return { ...node, x: toVisualX(node.x) };
}

function toVisualMeterRecord<T extends { xM: number }>(record: T): T {
  return { ...record, xM: toVisualX(record.xM) };
}

export function resolveScene3DVisualScenario(scenario: ShuttleScenario): ShuttleScenario {
  return {
    ...scenario,
    layout: {
      ...scenario.layout,
      nodes: scenario.layout.nodes.map(toVisualNode)
    }
  };
}

export function resolveScene3DVisualStaticScene(staticScene: ShuttleStaticSceneContract): ShuttleStaticSceneContract {
  return {
    ...staticScene,
    storageCells: staticScene.storageCells.map(toVisualMeterRecord),
    blockedCells: staticScene.blockedCells.map(toVisualMeterRecord),
    trackBeds: staticScene.trackBeds.map(toVisualMeterRecord),
    liftPads: staticScene.liftPads.map(toVisualMeterRecord),
    parkingPads: staticScene.parkingPads.map(toVisualMeterRecord),
    storageBlockMinXM: toVisualX(staticScene.storageBlockMinXM),
    storageBlockMaxXM: toVisualX(staticScene.storageBlockMaxXM),
    inboundLiftXM: toVisualX(staticScene.inboundLiftXM),
    outboundLiftXM: toVisualX(staticScene.outboundLiftXM)
  };
}

export function resolveScene3DVisualState(state: ShuttleSimState | null): ShuttleSimState | null {
  if (!state) {
    return null;
  }

  return {
    ...state,
    vehicles: state.vehicles.map((vehicle) => ({
      ...vehicle,
      x: toVisualX(vehicle.x),
      yaw: toVisualYaw(vehicle.yaw)
    }))
  };
}

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
          if (texture && texture.userData.presentationTextureAsset !== true) {
            texture.dispose();
          }
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

function tiledTexture(url: string, repeatX: number, repeatY: number, colorSpace: 'srgb' | 'linear'): THREE.Texture {
  const key = `${url}:${repeatX}:${repeatY}:${colorSpace}`;
  const cached = presentationTextureCache.get(key);
  if (cached) {
    return cached;
  }
  const texture = textureLoader.load(url);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(Math.max(0.1, repeatX), Math.max(0.1, repeatY));
  texture.anisotropy = 8;
  texture.userData.presentationTextureAsset = true;
  if (colorSpace === 'srgb') {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  presentationTextureCache.set(key, texture);
  return texture;
}

function texturedMaterial(
  source: { color: string; normal?: string; roughness?: string },
  options: {
    color?: number;
    repeat?: { x: number; y: number };
    roughness?: number;
    metalness?: number;
    normalScale?: number;
  } = {}
): THREE.MeshStandardMaterial {
  const repeat = options.repeat ?? { x: 1, y: 1 };
  const textured = new THREE.MeshStandardMaterial({
    color: options.color ?? 0xffffff,
    roughness: options.roughness ?? 0.72,
    metalness: options.metalness ?? 0.08,
    map: tiledTexture(source.color, repeat.x, repeat.y, 'srgb'),
    normalMap: source.normal ? tiledTexture(source.normal, repeat.x, repeat.y, 'linear') : undefined,
    roughnessMap: source.roughness ? tiledTexture(source.roughness, repeat.x, repeat.y, 'linear') : undefined
  });
  if (options.normalScale !== undefined) {
    textured.normalScale.set(options.normalScale, options.normalScale);
  }
  return textured;
}

function vehicleDisplayNumber(vehicleId: string): string {
  const ordinal = Number(vehicleId.replace(/\D+/g, ''));
  return Number.isFinite(ordinal) && ordinal > 0 ? String(ordinal) : vehicleId.replace(/^SH-?/i, '');
}

type LayoutBounds = ReturnType<typeof computeBounds>;

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
  const xToPx = (x: number) => inset + ((x - bounds.minX) / spanX) * plotWidth;
  const zToPx = (z: number) => inset + ((z - bounds.minZ) / spanZ) * plotHeight;
  const rectForMeterBox = (centerX: number, centerZ: number, widthM: number, depthM: number) => {
    const left = xToPx(centerX - widthM / 2);
    const right = xToPx(centerX + widthM / 2);
    const top = zToPx(centerZ - depthM / 2);
    const bottom = zToPx(centerZ + depthM / 2);
    return { left, top, width: right - left, height: bottom - top };
  };
  const rectForMeterRect = (meterRect: MeterRect) => ({
    left: xToPx(meterRect.minX),
    top: zToPx(meterRect.minZ),
    width: xToPx(meterRect.maxX) - xToPx(meterRect.minX),
    height: zToPx(meterRect.maxZ) - zToPx(meterRect.minZ)
  });
  const fillMeterRect = (meterRect: MeterRect, fillStyle: string) => {
    const rect = rectForMeterRect(meterRect);
    ctx.fillStyle = fillStyle;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
  };
  const drawMeterRect = (meterRect: MeterRect, fillStyle: string, strokeStyle: string) => {
    const rect = rectForMeterRect(meterRect);
    ctx.fillStyle = fillStyle;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 2;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  };

  ctx.fillStyle = '#0f151c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(75, 88, 101, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(inset, inset, plotWidth, plotHeight);

  for (const rect of createTrackAreaRects(staticScene, ['sideAisle', 'crossAisle', 'parkingConnector'])) {
    fillMeterRect(rect, CAD_AISLE_FILL);
  }

  for (const rect of createTrackAreaRects(staticScene, ['inboundConnector', 'outboundConnector'])) {
    fillMeterRect(rect, rect.category === 'inboundConnector' ? 'rgba(79, 143, 203, 0.22)' : 'rgba(226, 184, 75, 0.24)');
  }

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

  for (const rect of createStorageCellRects(staticScene)) {
    drawMeterRect(rect, 'rgba(157, 108, 255, 0.22)', 'rgba(184, 142, 255, 0.72)');
  }

  for (const cell of staticScene.blockedCells) {
    const rect = rectForMeterBox(cell.xM, cell.zM, cell.lengthXM, cell.lengthZM);
    ctx.fillStyle = CAD_BLOCKED_FILL;
    ctx.strokeStyle = CAD_BLOCKED_STROKE;
    ctx.lineWidth = 3;
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
    if (node.type === 'inbound' || node.type === 'outbound') {
      const x = xToPx(node.x);
      const z = zToPx(node.z);
      ctx.fillStyle = node.type === 'inbound' ? '#9fd9ff' : '#f6d63e';
      ctx.beginPath();
      ctx.arc(x, z, 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function createPresentationMat(bounds: LayoutBounds): THREE.Mesh {
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.width + 4, bounds.depth + 4),
    texturedMaterial(TEXTURE_ASSETS.fabric, {
      color: 0x1a252e,
      repeat: { x: Math.max(2, bounds.width / 3.2), y: Math.max(2, bounds.depth / 3.2) },
      roughness: 0.94,
      metalness: 0.01,
      normalScale: 0.22
    })
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(bounds.centerX, FLOOR_Y - 0.012, bounds.centerZ);
  mat.receiveShadow = true;
  return mat;
}

function createCadFloor(scenario: ShuttleScenario, staticScene: ShuttleStaticSceneContract, bounds: LayoutBounds): THREE.Mesh {
  const texture = createCadFloorTexture(scenario, staticScene, bounds);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.width, bounds.depth),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.9 })
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

function createConveyorTrackSegment(
  from: { x: number; z: number },
  to: { x: number; z: number },
  options: {
    accentColor: number;
    beltMaterial: THREE.Material;
    frameMaterial: THREE.Material;
    rollerMaterial: THREE.Material;
  }
): THREE.Group | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) {
    return null;
  }

  const group = new THREE.Group();
  group.position.set((from.x + to.x) / 2, 0, (from.z + to.z) / 2);
  group.rotation.y = -Math.atan2(dz, dx);

  const beltWidthM = 0.68;
  const bed = new THREE.Mesh(new THREE.BoxGeometry(length, 0.052, beltWidthM), options.beltMaterial);
  bed.position.y = 0.18;
  bed.castShadow = true;
  bed.receiveShadow = true;
  group.add(bed);

  for (const z of [-beltWidthM / 2 - 0.055, beltWidthM / 2 + 0.055]) {
    const sideRail = new THREE.Mesh(new THREE.BoxGeometry(length, 0.09, 0.045), options.frameMaterial);
    sideRail.position.set(0, 0.235, z);
    sideRail.castShadow = true;
    sideRail.receiveShadow = true;
    group.add(sideRail);
  }

  const rollerCount = clamp(Math.floor(length / 0.28), 2, 16);
  for (let index = 0; index < rollerCount; index += 1) {
    const x = rollerCount === 1 ? 0 : -length / 2 + (length * index) / (rollerCount - 1);
    const roller = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.032, beltWidthM * 0.82), options.rollerMaterial);
    roller.position.set(x, 0.252, 0);
    roller.castShadow = true;
    group.add(roller);
  }

  const marker = new THREE.Mesh(new THREE.BoxGeometry(Math.min(0.28, length), 0.035, beltWidthM + 0.16), material(options.accentColor, 0.48, 0.18));
  marker.position.set(length / 2 - Math.min(0.14, length / 2), 0.29, 0);
  marker.castShadow = true;
  group.add(marker);

  return group;
}

function createTrackAreaBlock(rect: MeterRect, areaMaterial: THREE.Material): THREE.Mesh {
  const width = Math.max(rect.maxX - rect.minX, 0.08);
  const depth = Math.max(rect.maxZ - rect.minZ, 0.08);
  const area = new THREE.Mesh(new THREE.BoxGeometry(width, 0.026, depth), areaMaterial);
  area.position.set((rect.minX + rect.maxX) / 2, 0.04, (rect.minZ + rect.maxZ) / 2);
  area.receiveShadow = true;
  return area;
}

function routeNetworkStyle(category: ShuttleStaticSceneTrackBed['category']): {
  color: number;
  edgeColor: number;
  opacity: number;
  edgeOpacity: number;
  widthM: number;
  yM: number;
} {
  switch (category) {
    case 'storageLane':
      return { color: 0x59c7ff, edgeColor: 0xa8e8ff, opacity: 0.42, edgeOpacity: 0.72, widthM: 0.11, yM: 0.148 };
    case 'sideAisle':
    case 'crossAisle':
      return { color: 0x4bd7c8, edgeColor: 0xd6fff8, opacity: 0.34, edgeOpacity: 0.64, widthM: 0.22, yM: 0.13 };
    case 'inboundConnector':
      return { color: FLOW_VISUAL_COLORS.inbound.three, edgeColor: 0xc7ecff, opacity: 0.42, edgeOpacity: 0.7, widthM: 0.18, yM: 0.31 };
    case 'outboundConnector':
      return { color: FLOW_VISUAL_COLORS.outbound.three, edgeColor: 0xffefb8, opacity: 0.44, edgeOpacity: 0.72, widthM: 0.18, yM: 0.31 };
    case 'parkingConnector':
      return { color: 0x8fa1ad, edgeColor: 0xe4edf0, opacity: 0.28, edgeOpacity: 0.52, widthM: 0.16, yM: 0.118 };
    default:
      return { color: 0x8fa1ad, edgeColor: 0xe4edf0, opacity: 0.24, edgeOpacity: 0.48, widthM: 0.12, yM: 0.12 };
  }
}

function createRouteNetworkRibbon(track: ShuttleStaticSceneTrackBed): THREE.Group | null {
  const [from, to] = trackBedEndpoints(track);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) {
    return null;
  }

  const style = routeNetworkStyle(track.category);
  const group = new THREE.Group();
  group.position.set((from.x + to.x) / 2, 0, (from.z + to.z) / 2);
  group.rotation.y = -Math.atan2(dz, dx);

  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(length, 0.018, style.widthM),
    new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.opacity,
      depthWrite: false
    })
  );
  deck.position.y = style.yM;
  deck.renderOrder = 70;
  group.add(deck);

  const edgeMaterial = new THREE.MeshBasicMaterial({
    color: style.edgeColor,
    transparent: true,
    opacity: style.edgeOpacity,
    depthWrite: false
  });
  for (const z of [-style.widthM / 2, style.widthM / 2]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(length, 0.026, 0.024), edgeMaterial);
    edge.position.set(0, style.yM + 0.014, z);
    edge.renderOrder = 71;
    group.add(edge);
  }

  return group;
}

function createRouteNetwork(staticScene: ShuttleStaticSceneContract): THREE.Group {
  const group = new THREE.Group();
  for (const track of staticScene.trackBeds) {
    const ribbon = createRouteNetworkRibbon(track);
    if (ribbon) {
      group.add(ribbon);
    }
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
      return FLOW_VISUAL_COLORS.inbound.three;
    case 'outbound':
      return FLOW_VISUAL_COLORS.outbound.three;
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

function createPalletLoadObject(widthM: number, depthM: number, crateColor = FLOW_VISUAL_COLORS.inbound.three): THREE.Group {
  const group = new THREE.Group();

  const pallet = new THREE.Mesh(new THREE.BoxGeometry(widthM, 0.08, depthM), material(0x6f777d, 0.82, 0.08));
  pallet.position.y = 0.04;
  pallet.castShadow = true;
  pallet.receiveShadow = true;
  group.add(pallet);

  const crateMaterial = material(crateColor, 0.68, 0.02);
  group.userData.crateMaterial = crateMaterial;
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

function createConveyorLoadObject(widthM: number, depthM: number, crateColor = FLOW_VISUAL_COLORS.inbound.three): THREE.Group {
  const group = new THREE.Group();
  const pallet = new THREE.Mesh(new THREE.BoxGeometry(widthM, 0.06, depthM), material(0x78838a, 0.78, 0.1));
  pallet.position.y = 0.03;
  pallet.castShadow = true;
  pallet.receiveShadow = true;
  group.add(pallet);

  const carton = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.74, 0.24, depthM * 0.7), material(crateColor, 0.64, 0.04));
  carton.position.y = 0.18;
  carton.castShadow = true;
  carton.receiveShadow = true;
  group.add(carton);

  const strapMaterial = material(0xf4f7f8, 0.5, 0.04);
  const longitudinalStrap = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.8, 0.018, 0.032), strapMaterial);
  longitudinalStrap.position.y = 0.312;
  group.add(longitudinalStrap);
  const crossStrap = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.02, depthM * 0.74), strapMaterial);
  crossStrap.position.y = 0.318;
  group.add(crossStrap);

  group.userData.crateMaterial = carton.material;
  return group;
}

function setPalletLoadColor(loadMesh: THREE.Group, crateColor: number): void {
  const crateMaterial = loadMesh.userData.crateMaterial as THREE.MeshStandardMaterial | undefined;
  crateMaterial?.color.setHex(crateColor);
}

function createStorageRackField(field: StorageField): THREE.Group {
  const group = new THREE.Group();
  const deckMaterial = material(0x171323, 0.9, 0.04);
  const cellMaterial = material(0x8d78ff, 0.24, 0.08);
  const boundaryMaterial = material(0xb177ff, 0.52, 0.18);
  const averageCellLengthM = field.cells.reduce((sum, cell) => sum + cell.lengthXM, 0) / field.cells.length;
  const averageCellDepthM = field.cells.reduce((sum, cell) => sum + cell.lengthZM, 0) / field.cells.length;

  const deck = new THREE.Mesh(new THREE.BoxGeometry(field.width, 0.035, field.depth), deckMaterial);
  deck.position.set((field.minX + field.maxX) / 2, 0.022, (field.minZ + field.maxZ) / 2);
  deck.receiveShadow = true;
  group.add(deck);

  const cellWidthM = Math.max(averageCellLengthM * 0.68, 0.12);
  const cellDepthM = Math.max(averageCellDepthM * 0.68, 0.12);
  for (const cell of field.cells) {
    const cellDeck = new THREE.Mesh(new THREE.BoxGeometry(cellWidthM, 0.045, cellDepthM), cellMaterial);
    cellDeck.position.set(cell.xM, 0.085, cell.zM);
    cellDeck.castShadow = true;
    cellDeck.receiveShadow = true;
    group.add(cellDeck);
  }

  const columnWidthM = Math.max(averageCellLengthM * 0.08, 0.045);
  for (const x of [field.minX, field.maxX]) {
    const boundary = new THREE.Mesh(new THREE.BoxGeometry(columnWidthM * 0.8, 0.055, field.depth), boundaryMaterial);
    boundary.position.set(x, 0.095, (field.minZ + field.maxZ) / 2);
    boundary.receiveShadow = true;
    group.add(boundary);
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

function createConveyor(node: ShuttleNode, color: number, beltMaterial: THREE.Material, frameMaterial: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.065, 0.86), frameMaterial);
  frame.position.y = 0.08;
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.034, 0.7), beltMaterial);
  belt.position.y = 0.145;
  belt.castShadow = true;
  belt.receiveShadow = true;
  group.add(belt);

  const rollerMaterial = material(0xb8c5c8, 0.36, 0.3);
  for (let index = 0; index < 4; index += 1) {
    const z = -0.27 + index * 0.18;
    const rollerBar = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.026, 0.032), rollerMaterial);
    rollerBar.position.set(0, 0.19, z);
    rollerBar.castShadow = true;
    group.add(rollerBar);
  }

  const railMaterial = material(0x8fa1ad, 0.46, 0.22);
  for (const x of [-0.37, 0.37]) {
    const sideRail = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.09, 0.78), railMaterial);
    sideRail.position.set(x, 0.21, 0);
    sideRail.castShadow = true;
    group.add(sideRail);
  }

  const dockPlate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.82), material(color, 0.58, 0.12));
  dockPlate.position.set(node.type === 'inbound' ? 0.47 : -0.47, 0.22, 0);
  group.add(dockPlate);

  return group;
}

function createLiftBlackboxPort(node: ShuttleNode, pad?: ShuttleStaticScenePad): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const isInbound = node.liftKind === 'inbound';
  const roleAccent = isInbound ? FLOW_VISUAL_COLORS.inbound.three : FLOW_VISUAL_COLORS.outbound.three;
  const padLengthX = pad?.lengthXM ?? 1.5;
  const padLengthZ = pad?.lengthZM ?? 1.15;

  const base = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 1.08, 0.05, padLengthZ * 1.12), material(0x111820, 0.86, 0.08));
  base.position.y = 0.025;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const transferDeck = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.86, 0.06, padLengthZ * 0.76), material(0x26323c, 0.72, 0.18));
  transferDeck.position.y = 0.105;
  transferDeck.castShadow = true;
  transferDeck.receiveShadow = true;
  group.add(transferDeck);

  const liftCar = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.48, 0.12, padLengthZ * 0.52), material(0xd7e2e7, 0.44, 0.24));
  liftCar.position.y = 0.21;
  liftCar.castShadow = true;
  liftCar.receiveShadow = true;
  group.add(liftCar);

  const guideMaterial = material(0x8fa1ad, 0.42, 0.22);
  for (const z of [-padLengthZ * 0.42, padLengthZ * 0.42]) {
    const guideRail = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.96, 0.06, 0.045), guideMaterial);
    guideRail.position.set(0, 0.225, z);
    guideRail.castShadow = true;
    group.add(guideRail);
  }

  for (const x of [-padLengthX * 0.46, padLengthX * 0.46]) {
    const sideGuide = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, padLengthZ * 0.86), guideMaterial);
    sideGuide.position.set(x, 0.24, 0);
    sideGuide.castShadow = true;
    group.add(sideGuide);
  }

  const rollerMaterial = material(0x96a3ad, 0.42, 0.28);
  for (let index = 0; index < 5; index += 1) {
    const x = -padLengthX * 0.28 + index * padLengthX * 0.14;
    const rollerBar = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.026, padLengthZ * 0.56), rollerMaterial);
    rollerBar.position.set(x, 0.292, 0);
    rollerBar.castShadow = true;
    group.add(rollerBar);
  }

  const postMaterial = material(0xe6eef2, 0.38, 0.32);
  const postAccentMaterial = material(roleAccent, 0.5, 0.22);
  for (const x of [-padLengthX * 0.5, padLengthX * 0.5]) {
    for (const z of [-padLengthZ * 0.46, padLengthZ * 0.46]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.07), postMaterial);
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
  portPlate.position.set(isInbound ? padLengthX * 0.58 : -padLengthX * 0.58, 0.22, 0);
  portPlate.castShadow = true;
  group.add(portPlate);

  const statusStrip = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.4, 0.035, 0.08), material(roleAccent, 0.5, 0.08));
  statusStrip.position.set(0, 0.34, isInbound ? -padLengthZ * 0.52 : padLengthZ * 0.52);
  statusStrip.castShadow = true;
  group.add(statusStrip);

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

function createTaskAssignmentMarker(node: ShuttleNode, label: string, role: LoadFlowRole): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.52, 0.66, 40),
    new THREE.MeshBasicMaterial({ color: FLOW_VISUAL_COLORS[role].three, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.42;
  ring.renderOrder = 150;
  group.add(ring);
  group.add(createTextBillboard(label, {
    background: flowRgba(role, 0.92),
    foreground: role === 'outbound' ? '#15120b' : '#f8fbff',
    border: role === 'outbound' ? 'rgba(255, 238, 180, 0.96)' : 'rgba(192, 226, 255, 0.96)',
    scale: { x: 0.82, y: 0.58 },
    y: 1.04
  }));
  return group;
}

function isLiftWorkcellNode(node: ShuttleNode): boolean {
  return node.type === 'inbound' ||
    node.type === 'outbound' ||
    node.type === 'lift-blackbox' ||
    node.id.startsWith('lift-');
}

function createVehicleObject(scenario: ShuttleScenario): THREE.Group {
  const group = new THREE.Group();
  const bodyMaterial = material(0xe5eef2, 0.44, 0.16);
  const chassisMaterial = material(0x72818a, 0.56, 0.18);
  const deckMaterial = material(0xa7b5bd, 0.5, 0.12);
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: FLOW_VISUAL_COLORS.inbound.three,
    emissive: 0x0b2230,
    roughness: 0.36,
    metalness: 0.16
  });
  const beaconMaterial = new THREE.MeshBasicMaterial({
    color: FLOW_VISUAL_COLORS.inbound.three,
    transparent: true,
    opacity: 0.92
  });
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0x56a9c9,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.98, scenario.vehicles.heightM * 0.34, scenario.vehicles.widthM * 0.92),
    chassisMaterial
  );
  chassis.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.22;
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  group.add(chassis);

  const undertray = new THREE.Mesh(
    new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.78, scenario.vehicles.heightM * 0.1, scenario.vehicles.widthM * 0.66),
    deckMaterial
  );
  undertray.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.44;
  undertray.castShadow = true;
  undertray.receiveShadow = true;
  group.add(undertray);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.84, scenario.vehicles.heightM * 0.56, scenario.vehicles.widthM * 0.78),
    bodyMaterial
  );
  body.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.62;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const topPanel = new THREE.Mesh(
    new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.52, 0.035, scenario.vehicles.widthM * 0.46),
    deckMaterial
  );
  topPanel.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.93;
  topPanel.castShadow = true;
  topPanel.receiveShadow = true;
  group.add(topPanel);

  for (const z of [-scenario.vehicles.widthM * 0.43, scenario.vehicles.widthM * 0.43]) {
    const statusRail = new THREE.Mesh(
      new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.74, 0.052, 0.052),
      accentMaterial
    );
    statusRail.position.set(0, VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.72, z);
    statusRail.castShadow = true;
    group.add(statusRail);
  }

  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.045, 20), beaconMaterial);
  beacon.position.set(-scenario.vehicles.lengthM * 0.24, VEHICLE_BASE_Y + scenario.vehicles.heightM * 1.03, 0);
  beacon.castShadow = true;
  group.add(beacon);

  const noseMaterial = material(0xf4f9fa, 0.36, 0.16);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, scenario.vehicles.heightM * 0.44, scenario.vehicles.widthM * 0.46),
    noseMaterial
  );
  nose.position.set(scenario.vehicles.lengthM * 0.49, VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.62, 0);
  nose.castShadow = true;
  group.add(nose);

  const lightMaterial = new THREE.MeshBasicMaterial({ color: 0x82c7ff, transparent: true, opacity: 0.86 });
  for (const z of [-scenario.vehicles.widthM * 0.36, scenario.vehicles.widthM * 0.36]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.16), lightMaterial);
    light.position.set(scenario.vehicles.lengthM * 0.52, VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.73, z);
    group.add(light);
  }

  const forkMaterial = texturedMaterial(TEXTURE_ASSETS.metalPlate, {
    color: 0xc6d2d6,
    repeat: { x: 0.9, y: 0.35 },
    roughness: 0.42,
    metalness: 0.34,
    normalScale: 0.12
  });
  for (const z of [-scenario.vehicles.widthM * 0.24, scenario.vehicles.widthM * 0.24]) {
    const fork = new THREE.Mesh(
      new THREE.BoxGeometry(scenario.vehicles.lengthM * 0.76, 0.035, 0.045),
      forkMaterial
    );
    fork.position.set(0.02, VEHICLE_BASE_Y + scenario.vehicles.heightM + 0.025, z);
    fork.castShadow = true;
    group.add(fork);
  }

  const wheelMaterial = material(0x26323b, 0.68, 0.18);
  for (const x of [-scenario.vehicles.lengthM * 0.34, scenario.vehicles.lengthM * 0.34]) {
    for (const z of [-scenario.vehicles.widthM * 0.48, scenario.vehicles.widthM * 0.48]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.07, 18), wheelMaterial);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, VEHICLE_BASE_Y + 0.08, z);
      wheel.castShadow = true;
      group.add(wheel);
    }
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
    accentMaterial,
    beaconMaterial,
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

function applyVehicleVisualStatus(
  data: VehicleObjectUserData,
  {
    bodyColor,
    accentColor,
    ringColor,
    emissiveColor,
    beaconOpacity = 0.92
  }: {
    bodyColor: number;
    accentColor: number;
    ringColor: number;
    emissiveColor: number;
    beaconOpacity?: number;
  }
): void {
  data.bodyMaterial.color.setHex(bodyColor);
  data.accentMaterial.color.setHex(accentColor);
  data.accentMaterial.emissive.setHex(emissiveColor);
  data.beaconMaterial.color.setHex(accentColor);
  data.beaconMaterial.opacity = beaconOpacity;
  data.ringMaterial.color.setHex(ringColor);
}

function applyVehicleState(group: THREE.Group, state: ShuttleSimState, vehicle: VehicleState, layers: ShuttleSceneLayers, selected: boolean): void {
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
  setPalletLoadColor(data.loadedMesh, FLOW_VISUAL_COLORS[resolveVehicleLoadFlowRole(state, vehicle)].three);
  data.safetyRing.visible = layers.physics;
  data.ringMaterial.opacity = selected ? 0.46 : 0.22;

  if (vehicle.state === 'waiting-blocked') {
    applyVehicleVisualStatus(data, {
      bodyColor: 0xf0e4c8,
      accentColor: 0xe2b84b,
      ringColor: 0xe2b84b,
      emissiveColor: 0x382407
    });
    return;
  }

  if (vehicle.state === 'idle') {
    applyVehicleVisualStatus(data, {
      bodyColor: 0xd6e0e3,
      accentColor: 0x8fa1ae,
      ringColor: 0x8fa1ae,
      emissiveColor: 0x071017,
      beaconOpacity: 0.56
    });
    return;
  }

  if (vehicle.loaded) {
    const loadRole = resolveVehicleLoadFlowRole(state, vehicle);
    applyVehicleVisualStatus(data, {
      bodyColor: 0xe4edf0,
      accentColor: FLOW_VISUAL_COLORS[loadRole].three,
      ringColor: FLOW_VISUAL_COLORS[loadRole].three,
      emissiveColor: loadRole === 'outbound' ? 0x302103 : 0x071d2d
    });
    return;
  }

  if (vehicle.taskId) {
    const taskRole = resolveVehicleTaskFlowRole(state, vehicle) ?? 'inbound';
    applyVehicleVisualStatus(data, {
      bodyColor: 0xe1eaed,
      accentColor: FLOW_VISUAL_COLORS[taskRole].three,
      ringColor: FLOW_VISUAL_COLORS[taskRole].three,
      emissiveColor: taskRole === 'outbound' ? 0x302103 : 0x071d2d
    });
    return;
  }

  applyVehicleVisualStatus(data, {
    bodyColor: 0xdde6e9,
    accentColor: 0x8d78ff,
    ringColor: 0x8d78ff,
    emissiveColor: 0x140e32
  });
}

function vehicleRouteColor(state: ShuttleSimState, vehicle: VehicleState): number {
  const taskRole = resolveVehicleTaskFlowRole(state, vehicle);
  if (taskRole) return FLOW_VISUAL_COLORS[taskRole].three;
  return 0x8d78ff;
}

function createLoadMesh(state: ShuttleSimState, load: LoadStateRecord, node: ShuttleNode, index: number): THREE.Group {
  const conveyorLoad = node.type === 'inbound' || node.type === 'outbound' || node.type === 'lift-blackbox';
  const loadRole = resolveLoadFlowRole(state, load);
  const loadMesh = conveyorLoad
    ? createConveyorLoadObject(0.68, 0.58, FLOW_VISUAL_COLORS[loadRole].three)
    : createPalletLoadObject(
        node.type === 'storage' ? 1.04 : 0.78,
        node.type === 'storage' ? 0.88 : 0.62,
        FLOW_VISUAL_COLORS[loadRole].three
      );
  const y = node.type === 'storage' ? 0.13 : conveyorLoad ? 0.3 : 0.18;
  loadMesh.position.set(node.x, y, node.z);
  loadMesh.userData.loadId = load.id;
  loadMesh.userData.loadIndex = index;
  return loadMesh;
}

function loadOverlayKey(state: ShuttleSimState | null, layers: ShuttleSceneLayers): string {
  if (!layers.loads) return 'off';
  return (state?.loads ?? [])
    .filter((load) => load.nodeId && load.state !== 'carried')
    .map((load) => `${load.id}:${load.state}:${load.nodeId ?? ''}:${load.vehicleId ?? ''}:${state ? resolveLoadFlowRole(state, load) : 'inbound'}`)
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
    .map((task) => `${task.id}:${task.kind}:${task.vehicleId}:${task.state}:${task.pickupNodeId}:${task.dropoffNodeId}`)
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

function isAxisAlignedRouteSegment(from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const tolerance = 1e-6;
  return Math.abs(from.x - to.x) <= tolerance || Math.abs(from.z - to.z) <= tolerance;
}

function remainingRouteNodeIds(vehicle: VehicleState, preferredNodeIds: string[]): string[] {
  const fallback = vehicle.routeNodeIds.slice(Math.max(0, vehicle.routeIndex));
  const source = preferredNodeIds.length >= 2 ? preferredNodeIds : fallback;
  if (source.length < 2) {
    return source;
  }

  if (vehicle.currentEdgeId && vehicle.targetNodeId) {
    const targetIndex = source.indexOf(vehicle.targetNodeId);
    if (targetIndex >= 0) {
      return [vehicle.currentNodeId, ...source.slice(targetIndex)];
    }
  }

  const currentIndex = source.indexOf(vehicle.currentNodeId);
  if (currentIndex >= 0) {
    return source.slice(currentIndex);
  }

  return fallback.length >= 2 ? fallback : source;
}

function addRoutePath(
  group: THREE.Group,
  points: Array<{ x: number; z: number }>,
  options: { color: number; radius: number; opacity: number; y: number; arrows: boolean; arrowScale: number }
): void {
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (!isAxisAlignedRouteSegment(from, to)) {
      continue;
    }
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
  runtime.networkGroup.visible = layers.routes;

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
    if (state) {
      applyVehicleState(object, state, vehicle, layers, selectedVehicleId === vehicle.id);
    }
  }

  const nextLoadOverlayKey = loadOverlayKey(state, layers);
  if (runtime.loadOverlayKey !== nextLoadOverlayKey) {
    runtime.loadOverlayKey = nextLoadOverlayKey;
    clearGroup(runtime.loadGroup);
  }
  if (layers.loads && state && runtime.loadGroup.children.length === 0) {
    const loads = state.loads.filter((load) => load.nodeId && load.state !== 'carried');
    loads.forEach((load, index) => {
      const node = load.nodeId ? runtime.nodeById.get(load.nodeId) : null;
      if (node) {
        runtime.loadGroup.add(createLoadMesh(state, load, node, index));
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
      if (selectedVehicleId !== vehicle.id || isLiftWorkcellNode(pickupNode)) {
        continue;
      }
      runtime.routeGroup.add(createTaskAssignmentMarker(pickupNode, vehicleDisplayNumber(vehicle.id), task.kind));
    }

    for (const vehicle of state?.vehicles ?? []) {
      const selected = selectedVehicleId === vehicle.id;
      const routeColor = state ? vehicleRouteColor(state, vehicle) : 0x8d78ff;
      const plannedRouteNodes = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
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
      if (goalNode && selected) {
        runtime.routeGroup.add(createRouteGoalMarker(goalNode, routeColor, selected));
      }
    }
  }
}

function buildStaticScene(runtime: SceneRuntime, scenario: ShuttleScenario, cameraView: ShuttleSceneCameraView): void {
  const visualScenario = resolveScene3DVisualScenario(scenario);
  const staticScene = resolveDashboardStaticSceneContract(scenario);
  const visualStaticScene = resolveScene3DVisualStaticScene(staticScene);

  clearGroup(runtime.staticGroup);
  clearGroup(runtime.networkGroup);
  clearGroup(runtime.routeGroup);
  clearGroup(runtime.reservationGroup);
  clearGroup(runtime.loadGroup);
  clearGroup(runtime.vehicleGroup);
  runtime.loadOverlayKey = '';
  runtime.reservationOverlayKey = '';
  runtime.routeOverlayKey = '';
  runtime.vehicleObjects.clear();
  runtime.nodeById = new Map(visualScenario.layout.nodes.map((node) => [node.id, node]));
  runtime.edgeById = new Map(visualScenario.layout.edges.map((edge) => [edge.id, edge]));
  const liftPadById = new Map(visualStaticScene.liftPads.map((pad) => [pad.id, pad]));
  const parkingPadById = new Map(visualStaticScene.parkingPads.map((pad) => [pad.id, pad]));

  const bounds = computeBounds(visualScenario.layout.nodes);
  runtime.staticGroup.add(createPresentationMat(bounds));
  const floor = createCadFloor(visualScenario, visualStaticScene, bounds);
  floor.receiveShadow = true;
  runtime.staticGroup.add(floor);

  const storageBlock = createStorageRackBlock(visualStaticScene);
  if (storageBlock) {
    runtime.staticGroup.add(storageBlock);
  }

  const aisleAreaMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f2d1d,
    roughness: 0.82,
    metalness: 0.04,
    transparent: true,
    opacity: 0.72
  });
  const parkingAreaMaterial = new THREE.MeshStandardMaterial({
    color: 0x26313b,
    roughness: 0.84,
    metalness: 0.04,
    transparent: true,
    opacity: 0.64
  });
  for (const rect of createTrackAreaRects(visualStaticScene, ['sideAisle', 'crossAisle', 'parkingConnector'])) {
    runtime.staticGroup.add(createTrackAreaBlock(rect, rect.category === 'parkingConnector' ? parkingAreaMaterial : aisleAreaMaterial));
  }

  runtime.networkGroup.add(createRouteNetwork(visualStaticScene));

  const conveyorBeltMaterial = texturedMaterial(TEXTURE_ASSETS.rubber, {
    color: 0x22282d,
    repeat: { x: 3.2, y: 0.9 },
    roughness: 0.9,
    metalness: 0.01,
    normalScale: 0.16
  });
  const conveyorFrameMaterial = texturedMaterial(TEXTURE_ASSETS.metalPlate, {
    color: 0x26323c,
    repeat: { x: 1.8, y: 0.6 },
    roughness: 0.62,
    metalness: 0.28,
    normalScale: 0.12
  });
  const conveyorRollerMaterial = material(0xc8d1d8, 0.36, 0.38);
  for (const track of visualStaticScene.trackBeds.filter((candidate) => candidate.category === 'inboundConnector' || candidate.category === 'outboundConnector')) {
    const [from, to] = trackBedEndpoints(track);
    const segment = createConveyorTrackSegment(from, to, {
      accentColor: track.category === 'inboundConnector' ? FLOW_VISUAL_COLORS.inbound.three : FLOW_VISUAL_COLORS.outbound.three,
      beltMaterial: conveyorBeltMaterial,
      frameMaterial: conveyorFrameMaterial,
      rollerMaterial: conveyorRollerMaterial
    });
    if (segment) {
      runtime.staticGroup.add(segment);
    }
  }

  for (const cell of visualStaticScene.blockedCells) {
    runtime.staticGroup.add(createBlockedCellMarker(cell));
  }

  for (const node of visualScenario.layout.nodes) {
    if (node.type === 'storage') {
      continue;
    }
    if (node.type === 'inbound') {
      runtime.staticGroup.add(createConveyor(node, FLOW_VISUAL_COLORS.inbound.three, conveyorBeltMaterial, conveyorFrameMaterial));
      continue;
    }
    if (node.type === 'outbound') {
      runtime.staticGroup.add(createConveyor(node, FLOW_VISUAL_COLORS.outbound.three, conveyorBeltMaterial, conveyorFrameMaterial));
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
    if (node.type === 'intersection' || node.type === 'aisle') {
      continue;
    }
    const nodeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.06, 24), material(nodeColor(node), 0.66, 0.1));
    nodeMesh.position.set(node.x, 0.055, node.z);
    nodeMesh.castShadow = true;
    nodeMesh.receiveShadow = true;
    runtime.staticGroup.add(nodeMesh);
  }

  runtime.root.scale.set(1, 1, 1);
  runtime.root.position.set(0, 0, 0);
  runtime.cameraTarget.set(bounds.centerX, 0, bounds.centerZ);
  const defaultCameraOffset = new THREE.Vector3(0, Math.max(13, bounds.size * 0.86), bounds.size * 0.34);
  runtime.baseCameraDistance = defaultCameraOffset.length();
  runtime.baseCameraYaw = Math.atan2(defaultCameraOffset.x, defaultCameraOffset.z);
  runtime.baseCameraPitch = Math.asin(defaultCameraOffset.y / Math.max(0.001, runtime.baseCameraDistance));
  applyCameraView(runtime, cameraView);
}

type VehicleSnapshot = { simTime: number; wallMs: number; vehicles: Map<string, { x: number; z: number; yaw: number }> };

export function ShuttleScene3D({
  scenario,
  state,
  layers,
  selectedVehicleId,
  cameraView,
  playbackSpeed,
  onCameraViewChange,
  onRendererInfo
}: {
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: ShuttleSceneLayers;
  selectedVehicleId: string | null;
  cameraView: ShuttleSceneCameraView;
  playbackSpeed?: number;
  onCameraViewChange: (view: ShuttleSceneCameraView) => void;
  onRendererInfo?: (info: ShuttleSceneRendererInfo) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const cameraViewRef = useRef<ShuttleSceneCameraView>(cameraView);
  const onCameraViewChangeRef = useRef(onCameraViewChange);
  const onRendererInfoRef = useRef(onRendererInfo);
  const snapshotsRef = useRef<{ prev: VehicleSnapshot | null; curr: VehicleSnapshot | null }>({ prev: null, curr: null });
  const playbackSpeedRef = useRef<number>(playbackSpeed ?? 1);
  const runningRef = useRef<boolean>(false);

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
    const networkGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    const reservationGroup = new THREE.Group();
    const loadGroup = new THREE.Group();
    const vehicleGroup = new THREE.Group();
    root.add(staticGroup, networkGroup, routeGroup, reservationGroup, loadGroup, vehicleGroup);
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
      networkGroup,
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

    const extrapolatedTarget = new THREE.Vector3();
    const render = (nowMs: number) => {
      runtime.frameId = window.requestAnimationFrame(render);
      if (nowMs - runtime.lastFrameMs < 1000 / TARGET_RENDER_FPS) {
        return;
      }
      const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - runtime.lastFrameMs) / 1000));
      runtime.lastFrameMs = nowMs;
      const fallbackPositionAlpha = 1 - Math.exp(-dtSec * 28);
      const yawAlpha = 1 - Math.exp(-dtSec * 14);
      const { prev, curr } = snapshotsRef.current;
      const running = runningRef.current;
      const speed = playbackSpeedRef.current;
      let snapshotDtSec = 0;
      let projectionSec = 0;
      let extrapolating = false;
      if (running && prev && curr) {
        snapshotDtSec = curr.simTime - prev.simTime;
        if (snapshotDtSec > 0) {
          const wallElapsedSec = (performance.now() - curr.wallMs) / 1000;
          projectionSec = Math.max(0, Math.min(0.6, wallElapsedSec * speed));
          extrapolating = projectionSec > 0;
        }
      }
      for (const [vehicleId, object] of runtime.vehicleObjects.entries()) {
        const data = vehicleUserData(object);
        let useExtrapolated = false;
        extrapolatedTarget.copy(data.targetPosition);
        if (extrapolating && prev && curr) {
          const previous = prev.vehicles.get(vehicleId);
          const current = curr.vehicles.get(vehicleId);
          if (previous && current) {
            const dx = (current.x - previous.x) / snapshotDtSec;
            const dz = (current.z - previous.z) / snapshotDtSec;
            if (dx * dx + dz * dz > 1e-6) {
              extrapolatedTarget.set(current.x + dx * projectionSec, 0, current.z + dz * projectionSec);
              useExtrapolated = true;
            }
          }
        }
        if (useExtrapolated) {
          object.position.copy(extrapolatedTarget);
        } else {
          object.position.lerp(extrapolatedTarget, fallbackPositionAlpha);
        }
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
      clearGroup(networkGroup);
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
    updateDynamicScene(runtime, scenario, resolveScene3DVisualState(state), layers, selectedVehicleId);
  }, [scenario]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !scenario) {
      return;
    }
    const visualState = resolveScene3DVisualState(state);
    updateDynamicScene(runtime, scenario, visualState, layers, selectedVehicleId);
    if (visualState) {
      const newSnap: VehicleSnapshot = {
        simTime: visualState.simTimeSec,
        wallMs: performance.now(),
        vehicles: new Map(visualState.vehicles.map((vehicle) => [vehicle.id, { x: vehicle.x, z: vehicle.z, yaw: vehicle.yaw }]))
      };
      const cur = snapshotsRef.current.curr;
      if (!cur || cur.simTime !== newSnap.simTime) {
        snapshotsRef.current.prev = cur;
        snapshotsRef.current.curr = newSnap;
      } else {
        snapshotsRef.current.curr = newSnap;
      }
    }
    runningRef.current = visualState?.status === 'running';
  }, [scenario, state, layers, selectedVehicleId]);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed ?? 1;
  }, [playbackSpeed]);

  return <div className="shuttle-scene-3d" ref={hostRef} />;
}
