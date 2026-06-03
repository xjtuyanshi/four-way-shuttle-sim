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
  edgeTraversalKeys: Set<string>;
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

type VisualClock = {
  latestSimTime: number | null;
  simTime: number | null;
  wallMs: number | null;
};

const FLOOR_Y = 0;
const VEHICLE_BASE_Y = 0.08;
const CAD_CANVAS_WIDTH = 2048;
const CAD_CANVAS_HEIGHT = 1536;
const TARGET_RENDER_FPS = 60;
const MAX_VISUAL_SNAPSHOTS = 48;
const VISUAL_INTERPOLATION_DELAY_WALL_SEC = 0.45;
const CAD_STORAGE_FILL = 'rgba(115, 98, 208, 0.16)';
const CAD_STORAGE_STROKE = 'rgba(177, 138, 255, 0.66)';
const CAD_AISLE_FILL = 'rgba(220, 178, 58, 0.14)';
const CAD_BLOCKED_FILL = 'rgba(101, 118, 111, 0.26)';
const CAD_BLOCKED_STROKE = 'rgba(151, 183, 167, 0.88)';
const TEXTURE_ASSETS = {
  fabric: {
    color: '/assets/textures/ambientcg-fabric001/color.jpg',
    normal: '/assets/textures/ambientcg-fabric001/normal.jpg',
    roughness: '/assets/textures/ambientcg-fabric001/roughness.jpg'
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

function liftPadRole(pad: ShuttleStaticScenePad): LoadFlowRole | null {
  if (pad.category === 'inboundLift') return 'inbound';
  if (pad.category === 'outboundLift') return 'outbound';
  return null;
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

  ctx.fillStyle = '#18222b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(126, 145, 160, 0.2)';
  ctx.lineWidth = 2;
  ctx.strokeRect(inset, inset, plotWidth, plotHeight);

  for (const rect of createTrackAreaRects(staticScene, ['sideAisle', 'crossAisle'])) {
    fillMeterRect(rect, CAD_AISLE_FILL);
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
    drawMeterRect(rect, 'rgba(157, 108, 255, 0.16)', 'rgba(184, 142, 255, 0.54)');
  }

  for (const pad of staticScene.liftPads) {
    const role = liftPadRole(pad);
    if (!role) continue;
    const rect = rectForMeterBox(pad.xM, pad.zM, pad.lengthXM * 1.22, pad.lengthZM * 1.38);
    ctx.fillStyle = role === 'inbound' ? 'rgba(79, 143, 203, 0.32)' : 'rgba(226, 184, 75, 0.36)';
    ctx.strokeStyle = role === 'inbound' ? 'rgba(184, 226, 255, 0.9)' : 'rgba(255, 231, 158, 0.94)';
    ctx.lineWidth = 5;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    ctx.fillStyle = role === 'inbound' ? '#dff4ff' : '#fff0bd';
    ctx.font = '700 34px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(role === 'inbound' ? 'LIFT IN' : 'LIFT OUT', rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  for (const cell of staticScene.blockedCells) {
    const rect = rectForMeterBox(cell.xM, cell.zM, cell.lengthXM, cell.lengthZM);
    ctx.fillStyle = CAD_BLOCKED_FILL;
    ctx.strokeStyle = CAD_BLOCKED_STROKE;
    ctx.lineWidth = 3;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
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
      color: 0x202b33,
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
      return { color: FLOW_VISUAL_COLORS.inbound.three, edgeColor: 0xc7ecff, opacity: 0.34, edgeOpacity: 0.56, widthM: 0.13, yM: 0.126 };
    case 'outboundConnector':
      return { color: FLOW_VISUAL_COLORS.outbound.three, edgeColor: 0xffefb8, opacity: 0.34, edgeOpacity: 0.56, widthM: 0.13, yM: 0.126 };
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

  const woodMaterial = material(0xb28a5a, 0.76, 0.04);
  const stringerMaterial = material(0x7c5d3c, 0.82, 0.03);
  for (const z of [-depthM * 0.31, 0, depthM * 0.31]) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.94, 0.045, depthM * 0.16), woodMaterial);
    slat.position.set(0, 0.055, z);
    slat.castShadow = true;
    slat.receiveShadow = true;
    group.add(slat);
  }
  for (const x of [-widthM * 0.28, widthM * 0.28]) {
    const stringer = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.12, 0.06, depthM * 0.86), stringerMaterial);
    stringer.position.set(x, 0.025, 0);
    stringer.castShadow = true;
    stringer.receiveShadow = true;
    group.add(stringer);
  }

  const crateMaterial = material(crateColor, 0.66, 0.025);
  const crateEdgeMaterial = material(0xf2f0dc, 0.58, 0.02);
  const strapMaterial = material(0x26323b, 0.62, 0.06);
  group.userData.crateMaterial = crateMaterial;
  const crateGeometry = new THREE.BoxGeometry(widthM * 0.42, 0.26, depthM * 0.36);
  for (const [x, z] of [
    [-widthM * 0.22, -depthM * 0.2],
    [widthM * 0.22, -depthM * 0.2],
    [-widthM * 0.22, depthM * 0.2],
    [widthM * 0.22, depthM * 0.2]
  ] satisfies Array<[number, number]>) {
    const crate = new THREE.Mesh(crateGeometry, crateMaterial);
    crate.position.set(x, 0.245, z);
    crate.castShadow = true;
    crate.receiveShadow = true;
    group.add(crate);

    const label = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.11, 0.006, depthM * 0.13), crateEdgeMaterial);
    label.position.set(x + widthM * 0.09, 0.379, z - depthM * 0.06);
    label.castShadow = false;
    group.add(label);
  }

  const crossStrap = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.94, 0.022, depthM * 0.045), strapMaterial);
  crossStrap.position.y = 0.392;
  crossStrap.castShadow = true;
  group.add(crossStrap);
  const lengthStrap = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.045, 0.024, depthM * 0.86), strapMaterial);
  lengthStrap.position.y = 0.398;
  lengthStrap.castShadow = true;
  group.add(lengthStrap);

  return group;
}

function createConveyorLoadObject(widthM: number, depthM: number, crateColor = FLOW_VISUAL_COLORS.inbound.three): THREE.Group {
  const group = new THREE.Group();
  const palletMaterial = material(0xb28a5a, 0.76, 0.04);
  for (const z of [-depthM * 0.28, 0, depthM * 0.28]) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.92, 0.042, depthM * 0.14), palletMaterial);
    slat.position.set(0, 0.035, z);
    slat.castShadow = true;
    slat.receiveShadow = true;
    group.add(slat);
  }

  const cartonMaterial = material(crateColor, 0.64, 0.035);
  const carton = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.76, 0.25, depthM * 0.68), cartonMaterial);
  carton.position.y = 0.19;
  carton.castShadow = true;
  carton.receiveShadow = true;
  group.add(carton);

  const label = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.18, 0.006, depthM * 0.18), material(0xf2f0dc, 0.58, 0.02));
  label.position.set(widthM * 0.17, 0.319, -depthM * 0.14);
  group.add(label);

  const strapMaterial = material(0x26323b, 0.62, 0.06);
  const longitudinalStrap = new THREE.Mesh(new THREE.BoxGeometry(widthM * 0.8, 0.018, 0.032), strapMaterial);
  longitudinalStrap.position.y = 0.312;
  group.add(longitudinalStrap);
  const crossStrap = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.02, depthM * 0.74), strapMaterial);
  crossStrap.position.y = 0.318;
  group.add(crossStrap);

  group.userData.crateMaterial = cartonMaterial;
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

function isLiftServiceExitNode(nodeId: string): boolean {
  return /^lift-\d{2}-(?:inbound|outbound)-queue-\d{2}-service-exit$/.test(nodeId);
}

function createLiftBlackboxPort(node: ShuttleNode, pad?: ShuttleStaticScenePad): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const isInbound = node.liftKind === 'inbound';
  const roleAccent = isInbound ? FLOW_VISUAL_COLORS.inbound.three : FLOW_VISUAL_COLORS.outbound.three;
  const padLengthX = Math.max(pad?.lengthXM ?? 1.5, 3.05);
  const padLengthZ = Math.max(pad?.lengthZM ?? 1.15, 2.16);

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

  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0xc8ecff,
    roughness: 0.2,
    metalness: 0.02,
    transparent: true,
    opacity: 0.18
  });
  for (const x of [-padLengthX * 0.36, padLengthX * 0.36]) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.42, padLengthZ * 0.58), glassMaterial);
    guard.position.set(x, 0.38, 0);
    guard.castShadow = true;
    group.add(guard);
  }

  const serviceApron = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 0.62, 0.032, padLengthZ * 0.22), material(roleAccent, 0.5, 0.16));
  serviceApron.position.set(isInbound ? padLengthX * 0.18 : -padLengthX * 0.18, 0.17, isInbound ? -padLengthZ * 0.32 : padLengthZ * 0.32);
  serviceApron.castShadow = true;
  serviceApron.receiveShadow = true;
  group.add(serviceApron);

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

  const beamMaterial = material(0xc7d4da, 0.42, 0.26);
  for (const z of [-padLengthZ * 0.46, padLengthZ * 0.46]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(padLengthX * 1.02, 0.065, 0.06), beamMaterial);
    beam.position.set(0, 0.69, z);
    beam.castShadow = true;
    group.add(beam);
  }
  for (const x of [-padLengthX * 0.5, padLengthX * 0.5]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.065, padLengthZ * 0.92), beamMaterial);
    beam.position.set(x, 0.69, 0);
    beam.castShadow = true;
    group.add(beam);
  }

  const portPlate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, padLengthZ * 0.68), material(roleAccent, 0.54, 0.16));
  portPlate.position.set(isInbound ? padLengthX * 0.58 : -padLengthX * 0.58, 0.22, 0);
  portPlate.castShadow = true;
  group.add(portPlate);

  const liftLabel = createTextBillboard(isInbound ? 'IN LIFT' : 'OUT LIFT', {
    background: isInbound ? 'rgba(24, 86, 128, 0.96)' : 'rgba(130, 91, 18, 0.96)',
    foreground: '#f8fbff',
    border: isInbound ? 'rgba(201, 236, 255, 0.95)' : 'rgba(255, 235, 164, 0.95)',
    scale: { x: 2.7, y: 0.96 },
    y: 1.52
  });
  liftLabel.position.z = -padLengthZ * 0.64;
  group.add(liftLabel);

  return group;
}

function createLiftBufferPad(node: ShuttleNode): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);
  const role = node.type === 'outbound' ? 'outbound' : 'inbound';
  const accent = FLOW_VISUAL_COLORS[role].three;

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.035, 0.58), material(0x14212c, 0.76, 0.08));
  base.position.y = 0.04;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.032, 0.4), material(accent, 0.48, 0.08));
  belt.position.y = 0.085;
  belt.castShadow = true;
  belt.receiveShadow = true;
  group.add(belt);

  const railMaterial = material(0xdce7ea, 0.44, 0.16);
  for (const x of [-0.32, 0.32]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.09, 0.5), railMaterial);
    rail.position.set(x, 0.13, 0);
    rail.castShadow = true;
    group.add(rail);
  }

  return group;
}

function createLiftServiceDockMarker(point: { x: number; z: number }, role: LoadFlowRole): THREE.Group {
  const group = new THREE.Group();
  group.position.set(point.x, 0, point.z);
  const accent = FLOW_VISUAL_COLORS[role].three;

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.08, 0.062, 0.68),
    material(role === 'inbound' ? 0x17344c : 0x47371a, 0.7, 0.08)
  );
  base.position.y = 0.075;
  base.receiveShadow = true;
  group.add(base);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.44, 0.55, 36),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.74, side: THREE.DoubleSide })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.135;
  group.add(halo);

  const label = createTextBillboard(role === 'inbound' ? 'P' : 'D', {
    background: flowRgba(role, 0.96),
    foreground: role === 'outbound' ? '#171207' : '#f8fbff',
    border: role === 'outbound' ? 'rgba(255, 238, 180, 0.95)' : 'rgba(192, 226, 255, 0.95)',
    scale: { x: 0.58, y: 0.44 },
    y: 0.68
  });
  group.add(label);

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
  context.roundRect(10, 12, 108, 72, 18);
  context.fill();
  context.stroke();
  context.fillStyle = options.foreground ?? '#f8fbff';
  const fontSize = text.length > 8 ? 20 : text.length > 4 ? 24 : 46;
  context.font = `800 ${fontSize}px Arial, sans-serif`;
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

function createTaskAssignmentMarker(point: { x: number; z: number }, label: string, role: LoadFlowRole): THREE.Group {
  const group = new THREE.Group();
  group.position.set(point.x, 0, point.z);
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
    node.id.startsWith('lift-') ||
    node.id.startsWith('parking-lift-');
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
  const visualLengthM = scenario.vehicles.widthM * 0.96;
  const visualWidthM = scenario.vehicles.widthM * 0.96;

  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(visualLengthM * 0.98, scenario.vehicles.heightM * 0.34, visualWidthM * 0.92),
    chassisMaterial
  );
  chassis.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.22;
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  group.add(chassis);

  const undertray = new THREE.Mesh(
    new THREE.BoxGeometry(visualLengthM * 0.78, scenario.vehicles.heightM * 0.1, visualWidthM * 0.66),
    deckMaterial
  );
  undertray.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.44;
  undertray.castShadow = true;
  undertray.receiveShadow = true;
  group.add(undertray);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(visualLengthM * 0.84, scenario.vehicles.heightM * 0.56, visualWidthM * 0.78),
    bodyMaterial
  );
  body.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.62;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const topPanel = new THREE.Mesh(
    new THREE.BoxGeometry(visualLengthM * 0.52, 0.035, visualWidthM * 0.46),
    deckMaterial
  );
  topPanel.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.93;
  topPanel.castShadow = true;
  topPanel.receiveShadow = true;
  group.add(topPanel);

  const headingShape = new THREE.Shape();
  headingShape.moveTo(visualLengthM * 0.28, 0);
  headingShape.lineTo(-visualLengthM * 0.16, visualWidthM * 0.16);
  headingShape.lineTo(-visualLengthM * 0.1, 0);
  headingShape.lineTo(-visualLengthM * 0.16, -visualWidthM * 0.16);
  headingShape.closePath();
  const headingArrow = new THREE.Mesh(
    new THREE.ShapeGeometry(headingShape),
    new THREE.MeshBasicMaterial({
      color: 0xf4f9fa,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide
    })
  );
  headingArrow.rotation.x = -Math.PI / 2;
  headingArrow.position.y = VEHICLE_BASE_Y + scenario.vehicles.heightM * 1.02;
  group.add(headingArrow);

  for (const z of [-visualWidthM * 0.43, visualWidthM * 0.43]) {
    const statusRail = new THREE.Mesh(
      new THREE.BoxGeometry(visualLengthM * 0.74, 0.052, 0.052),
      accentMaterial
    );
    statusRail.position.set(0, VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.72, z);
    statusRail.castShadow = true;
    group.add(statusRail);
  }

  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.045, 20), beaconMaterial);
  beacon.position.set(-visualLengthM * 0.24, VEHICLE_BASE_Y + scenario.vehicles.heightM * 1.03, 0);
  beacon.castShadow = true;
  group.add(beacon);

  const noseMaterial = material(0xf4f9fa, 0.36, 0.16);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, scenario.vehicles.heightM * 0.44, visualWidthM * 0.46),
    noseMaterial
  );
  nose.position.set(visualLengthM * 0.49, VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.62, 0);
  nose.castShadow = true;
  group.add(nose);

  const lightMaterial = new THREE.MeshBasicMaterial({ color: 0x82c7ff, transparent: true, opacity: 0.86 });
  for (const z of [-visualWidthM * 0.36, visualWidthM * 0.36]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.16), lightMaterial);
    light.position.set(visualLengthM * 0.52, VEHICLE_BASE_Y + scenario.vehicles.heightM * 0.73, z);
    group.add(light);
  }

  const forkMaterial = texturedMaterial(TEXTURE_ASSETS.metalPlate, {
    color: 0xc6d2d6,
    repeat: { x: 0.9, y: 0.35 },
    roughness: 0.42,
    metalness: 0.34,
    normalScale: 0.12
  });
  for (const z of [-visualWidthM * 0.24, visualWidthM * 0.24]) {
    const fork = new THREE.Mesh(
      new THREE.BoxGeometry(visualLengthM * 0.76, 0.035, 0.045),
      forkMaterial
    );
    fork.position.set(0.02, VEHICLE_BASE_Y + scenario.vehicles.heightM + 0.025, z);
    fork.castShadow = true;
    group.add(fork);
  }

  const wheelMaterial = material(0x26323b, 0.68, 0.18);
  for (const x of [-visualLengthM * 0.34, visualLengthM * 0.34]) {
    for (const z of [-visualWidthM * 0.48, visualWidthM * 0.48]) {
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

  const loadedMesh = createPalletLoadObject(visualLengthM * 0.74, visualWidthM * 0.78);
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

function applyVehicleState(runtime: SceneRuntime, group: THREE.Group, state: ShuttleSimState, vehicle: VehicleState, layers: ShuttleSceneLayers, selected: boolean): void {
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
  const displayPose = routeDisplayPoseForVehicle(runtime, vehicle);
  data.targetPosition.set(displayPose.x, 0, displayPose.z);
  data.targetYaw = displayPose.yaw;
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
  const conveyorLoad = node.type === 'inbound' || node.type === 'outbound' || node.type === 'lift-blackbox' || isLiftServiceExitNode(node.id);
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
      Math.round(vehicle.x * 100),
      Math.round(vehicle.z * 100),
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

function edgeTraversalKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}>${toNodeId}`;
}

function createEdgeTraversalKeys(edges: ShuttleEdge[]): Set<string> {
  const keys = new Set<string>();
  for (const edge of edges) {
    keys.add(edgeTraversalKey(edge.from, edge.to));
    if (edge.directionMode === 'twoWay') {
      keys.add(edgeTraversalKey(edge.to, edge.from));
    }
  }
  return keys;
}

function liftWorkcellRole(nodeId: string): 'inbound' | 'outbound' | null {
  const match = /^(?:lift|parking-lift)-\d{2}-(inbound|outbound)(?:$|-)/.exec(nodeId);
  return match ? match[1] as 'inbound' | 'outbound' : null;
}

function isLiftRouteDisplaySnapNode(nodeId: string): boolean {
  return /^lift-\d{2}-(?:inbound|outbound)-(?:buffer-access|queue-access|queue-\d{2}-(?:access|entry-access|service-exit))$/.test(nodeId) ||
    /^parking-lift-\d{2}-(?:inbound|outbound)-queue(?:-\d{2})?$/.test(nodeId);
}

type TopLiftDisplayRailLevel = 'top-a' | 'top-b';

function topLiftDisplayRailLevel(nodeId: string): TopLiftDisplayRailLevel | null {
  const column = /^column-(top-[ab])-c\d+$/.exec(nodeId);
  if (column) {
    return column[1] as TopLiftDisplayRailLevel;
  }
  const spine = /^(?:module-\d+|module-boundary-\d+)-spine-(top-[ab])$/.exec(nodeId);
  return spine ? spine[1] as TopLiftDisplayRailLevel : null;
}

function isTopLiftDisplayRailNode(nodeId: string): boolean {
  return topLiftDisplayRailLevel(nodeId) !== null;
}

function defaultLiftRouteDisplaySnapLevel(nodeId: string): TopLiftDisplayRailLevel | null {
  const role = liftWorkcellRole(nodeId);
  if (role === 'outbound') {
    return 'top-a';
  }
  if (role === 'inbound') {
    return 'top-b';
  }
  return null;
}

function isTopLiftDisplayRailLevelNode(nodeId: string, level: TopLiftDisplayRailLevel): boolean {
  return new RegExp(`^column-${level}-c\\d+$`).test(nodeId) ||
    new RegExp(`^(?:module-\\d+|module-boundary-\\d+)-spine-${level}$`).test(nodeId);
}

function liftDisplayLevelForRouteNode(nodeIds: string[], index: number): TopLiftDisplayRailLevel | null {
  const nodeId = nodeIds[index];
  if (!nodeId || !isLiftRouteDisplaySnapNode(nodeId)) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previousNodeId = nodeIds[cursor]!;
    const railLevel = topLiftDisplayRailLevel(previousNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftRouteDisplaySnapNode(previousNodeId)) {
      break;
    }
  }

  for (let cursor = index + 1; cursor < nodeIds.length; cursor += 1) {
    const nextNodeId = nodeIds[cursor]!;
    const railLevel = topLiftDisplayRailLevel(nextNodeId);
    if (railLevel) {
      return railLevel;
    }
    if (!isLiftRouteDisplaySnapNode(nextNodeId)) {
      break;
    }
  }

  return defaultLiftRouteDisplaySnapLevel(nodeId);
}

function liftDisplayLevelsForRoute(nodeIds: string[]): Array<TopLiftDisplayRailLevel | null> {
  return nodeIds.map((_, index) => liftDisplayLevelForRouteNode(nodeIds, index));
}

function routeDisplayPointForNode(
  runtime: SceneRuntime,
  nodeId: string,
  fallback: { x: number; z: number },
  preferredLevel: TopLiftDisplayRailLevel | null = null
): { x: number; z: number } {
  if (!isLiftRouteDisplaySnapNode(nodeId)) {
    return fallback;
  }
  let nearest: ShuttleNode | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const displayLevel = preferredLevel ?? defaultLiftRouteDisplaySnapLevel(nodeId);
  for (const node of runtime.nodeById.values()) {
    if (displayLevel ? !isTopLiftDisplayRailLevelNode(node.id, displayLevel) : !isTopLiftDisplayRailNode(node.id)) {
      continue;
    }
    const distance = Math.hypot(node.x - fallback.x, node.z - fallback.z);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest ? { x: nearest.x, z: nearest.z } : fallback;
}

function routeDisplayPointForVehicle(
  runtime: SceneRuntime,
  vehicle: VehicleState,
  currentPreferredLevel: TopLiftDisplayRailLevel | null = null,
  targetPreferredLevel: TopLiftDisplayRailLevel | null = null
): { x: number; z: number } {
  const rawPoint = { x: vehicle.x, z: vehicle.z };
  const currentNode = runtime.nodeById.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? runtime.nodeById.get(vehicle.targetNodeId) : null;
  if (
    vehicle.currentEdgeId &&
    currentNode &&
    targetNode &&
    (isLiftRouteDisplaySnapNode(currentNode.id) || isLiftRouteDisplaySnapNode(targetNode.id))
  ) {
    const dx = targetNode.x - currentNode.x;
    const dz = targetNode.z - currentNode.z;
    const lengthSq = dx * dx + dz * dz;
    const progress = lengthSq <= 1e-9
      ? 0
      : clamp(((rawPoint.x - currentNode.x) * dx + (rawPoint.z - currentNode.z) * dz) / lengthSq, 0, 1);
    const displayFrom = routeDisplayPointForNode(runtime, currentNode.id, { x: currentNode.x, z: currentNode.z }, currentPreferredLevel);
    const displayTo = routeDisplayPointForNode(runtime, targetNode.id, { x: targetNode.x, z: targetNode.z }, targetPreferredLevel);
    return {
      x: displayFrom.x + (displayTo.x - displayFrom.x) * progress,
      z: displayFrom.z + (displayTo.z - displayFrom.z) * progress
    };
  }
  return routeDisplayPointForNode(runtime, vehicle.currentNodeId, rawPoint, currentPreferredLevel);
}

function routeDisplayPoseForVehicle(runtime: SceneRuntime, vehicle: VehicleState): { x: number; z: number; yaw: number } {
  const routeNodeIds = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
  const fallbackRouteNodeIds = routeNodeIds.length >= 2 ? routeNodeIds : remainingRouteNodeIds(vehicle, vehicle.routeNodeIds);
  const displayLevels = liftDisplayLevelsForRoute(fallbackRouteNodeIds);
  const point = routeDisplayPointForVehicle(runtime, vehicle, displayLevels[0] ?? null, displayLevels[1] ?? null);
  const nextNodeId = fallbackRouteNodeIds[1];
  const nextNode = nextNodeId ? runtime.nodeById.get(nextNodeId) : null;
  if (nextNode) {
    const nextPoint = routeDisplayPointForNode(runtime, nextNode.id, { x: nextNode.x, z: nextNode.z }, displayLevels[1] ?? null);
    const dx = nextPoint.x - point.x;
    const dz = nextPoint.z - point.z;
    if (Math.hypot(dx, dz) > 1e-6) {
      return { ...point, yaw: Math.atan2(-dz, dx) };
    }
  }
  return { ...point, yaw: vehicle.yaw };
}

function routeSegmentsForNodeIds(
  runtime: SceneRuntime,
  vehicle: VehicleState,
  nodeIds: string[]
): Array<{ from: { x: number; z: number }; to: { x: number; z: number } }> {
  if (nodeIds.length < 2) {
    return [];
  }
  const displayLevels = liftDisplayLevelsForRoute(nodeIds);
  const segments: Array<{ from: { x: number; z: number }; to: { x: number; z: number } }> = [];
  let fromNodeId = nodeIds[0]!;
  let graphFromPoint = routeRenderStartPoint(runtime, vehicle);
  let displayFromPoint = routeDisplayPointForVehicle(runtime, vehicle, displayLevels[0] ?? null, displayLevels[1] ?? null);
  for (let index = 1; index < nodeIds.length; index += 1) {
    const toNodeId = nodeIds[index]!;
    const toNode = runtime.nodeById.get(toNodeId);
    if (!toNode) {
      fromNodeId = toNodeId;
      continue;
    }
    const graphToPoint = { x: toNode.x, z: toNode.z };
    const displayToPoint = routeDisplayPointForNode(runtime, toNodeId, graphToPoint, displayLevels[index] ?? null);
    if (
      runtime.edgeTraversalKeys.has(edgeTraversalKey(fromNodeId, toNodeId)) &&
      isAxisAlignedRouteSegment(graphFromPoint, graphToPoint) &&
      isAxisAlignedRouteSegment(displayFromPoint, displayToPoint) &&
      Math.hypot(displayToPoint.x - displayFromPoint.x, displayToPoint.z - displayFromPoint.z) > 1e-6
    ) {
      segments.push({ from: displayFromPoint, to: displayToPoint });
    }
    fromNodeId = toNodeId;
    graphFromPoint = graphToPoint;
    displayFromPoint = displayToPoint;
  }
  return segments;
}

function isAxisAlignedRouteSegment(from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const tolerance = 1e-6;
  return Math.abs(from.x - to.x) <= tolerance || Math.abs(from.z - to.z) <= tolerance;
}

function snapPointToAxisAlignedLeg(
  point: { x: number; z: number },
  from: { x: number; z: number },
  to: { x: number; z: number }
): { x: number; z: number } {
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minZ = Math.min(from.z, to.z);
  const maxZ = Math.max(from.z, to.z);
  if (Math.abs(from.x - to.x) <= Math.abs(from.z - to.z)) {
    return { x: from.x, z: clamp(point.z, minZ, maxZ) };
  }
  return { x: clamp(point.x, minX, maxX), z: from.z };
}

function routeRenderStartPoint(runtime: SceneRuntime, vehicle: VehicleState): { x: number; z: number } {
  const currentNode = runtime.nodeById.get(vehicle.currentNodeId);
  const targetNode = vehicle.targetNodeId ? runtime.nodeById.get(vehicle.targetNodeId) : null;
  if (vehicle.currentEdgeId && currentNode && targetNode) {
    return snapPointToAxisAlignedLeg(vehicle, currentNode, targetNode);
  }
  if (!vehicle.currentEdgeId && currentNode) {
    return { x: currentNode.x, z: currentNode.z };
  }
  return { x: vehicle.x, z: vehicle.z };
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
  segments: Array<{ from: { x: number; z: number }; to: { x: number; z: number } }>,
  options: { color: number; radius: number; opacity: number; y: number; arrows: boolean; arrowScale: number }
): void {
  for (let index = 0; index < segments.length; index += 1) {
    const { from, to } = segments[index]!;
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
    if (options.arrows && (index + 1) % 3 === 0) {
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
  runtime.networkGroup.visible = layers.physics;

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
      const displayPose = routeDisplayPoseForVehicle(runtime, vehicle);
      object.position.set(displayPose.x, 0, displayPose.z);
      object.rotation.y = displayPose.yaw;
      runtime.vehicleObjects.set(vehicle.id, object);
      runtime.vehicleGroup.add(object);
    }
    if (state) {
      applyVehicleState(runtime, object, state, vehicle, layers, selectedVehicleId === vehicle.id);
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
      if (node && (!isLiftWorkcellNode(node) || load.state === 'waiting')) {
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
        const displayFrom = routeDisplayPointForNode(runtime, from.id, from);
        const displayTo = routeDisplayPointForNode(runtime, to.id, to);
        const reservedSegment = createSegment(
          displayFrom,
          displayTo,
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
        const displayPoint = routeDisplayPointForNode(runtime, node.id, node);
        marker.position.set(displayPoint.x, 0.035, displayPoint.z);
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
      if (selectedVehicleId !== vehicle.id) {
        continue;
      }
      runtime.routeGroup.add(createTaskAssignmentMarker(
        isLiftWorkcellNode(pickupNode) ? pickupNode : routeDisplayPointForNode(runtime, pickupNode.id, pickupNode),
        vehicleDisplayNumber(vehicle.id),
        task.kind
      ));
    }

    for (const vehicle of state?.vehicles ?? []) {
      const selected = selectedVehicleId === vehicle.id;
      const routeColor = state ? vehicleRouteColor(state, vehicle) : 0x8d78ff;
      const plannedRouteNodes = remainingRouteNodeIds(vehicle, vehicle.plannedRouteNodeIds);
      const plannedRouteSegments = routeSegmentsForNodeIds(runtime, vehicle, plannedRouteNodes);
      if (plannedRouteSegments.length > 0) {
        addRoutePath(runtime.routeGroup, plannedRouteSegments, {
          color: routeColor,
          radius: selected ? 0.065 : 0.04,
          opacity: selected ? 0.92 : 0.72,
          y: selected ? 0.29 : 0.24,
          arrows: selected,
          arrowScale: selected ? 1.15 : 0.85
        });
      }

      const localRouteSegments = routeSegmentsForNodeIds(runtime, vehicle, vehicle.localRouteNodeIds);
      if (localRouteSegments.length > 0) {
        addRoutePath(runtime.routeGroup, localRouteSegments, {
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
  runtime.edgeTraversalKeys = createEdgeTraversalKeys(visualScenario.layout.edges);
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
  for (const rect of createTrackAreaRects(visualStaticScene, ['sideAisle', 'crossAisle'])) {
    runtime.staticGroup.add(createTrackAreaBlock(rect, aisleAreaMaterial));
  }

  runtime.networkGroup.add(createRouteNetwork(visualStaticScene));

  for (const cell of visualStaticScene.blockedCells) {
    runtime.staticGroup.add(createBlockedCellMarker(cell));
  }

  for (const node of visualScenario.layout.nodes) {
    if (node.type === 'storage') {
      continue;
    }
    if (node.type === 'inbound' || node.type === 'outbound') {
      runtime.staticGroup.add(createLiftBufferPad(node));
      continue;
    }
    if (node.type === 'lift-blackbox') {
      runtime.staticGroup.add(createLiftBlackboxPort(node, liftPadById.get(node.id)));
      continue;
    }
    if (isLiftServiceExitNode(node.id)) {
      runtime.staticGroup.add(createLiftServiceDockMarker(
        node,
        liftWorkcellRole(node.id) ?? 'inbound'
      ));
      continue;
    }
    if (node.type === 'parking') {
      if (node.id.startsWith('parking-lift-')) {
        runtime.networkGroup.add(createParkingPad(node, parkingPadById.get(node.id)));
      } else {
        runtime.staticGroup.add(createParkingPad(node, parkingPadById.get(node.id)));
      }
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
  const defaultCameraOffset = new THREE.Vector3(0, Math.max(16, bounds.size * 1.08), bounds.size * 0.14);
  runtime.baseCameraDistance = defaultCameraOffset.length();
  runtime.baseCameraYaw = Math.atan2(defaultCameraOffset.x, defaultCameraOffset.z);
  runtime.baseCameraPitch = Math.asin(defaultCameraOffset.y / Math.max(0.001, runtime.baseCameraDistance));
  applyCameraView(runtime, cameraView);
}

type VehiclePoseSnapshot = Pick<
  VehicleState,
  'x' | 'z' | 'yaw' | 'currentEdgeId' | 'currentNodeId' | 'targetNodeId' | 'taskId' | 'loaded'
>;
type VehicleSnapshot = { simTime: number; wallMs: number; vehicles: Map<string, VehiclePoseSnapshot> };

function poseHasSameMotionLeg(left: VehiclePoseSnapshot, right: VehiclePoseSnapshot): boolean {
  return (
    left.currentEdgeId === right.currentEdgeId &&
    left.currentNodeId === right.currentNodeId &&
    left.targetNodeId === right.targetNodeId &&
    left.taskId === right.taskId &&
    left.loaded === right.loaded
  );
}

function appendVehicleSnapshot(snapshots: VehicleSnapshot[], snapshot: VehicleSnapshot): VehicleSnapshot[] {
  const latest = snapshots.at(-1);
  if (!latest || snapshot.simTime < latest.simTime - 1e-9) {
    return [snapshot];
  }
  if (Math.abs(snapshot.simTime - latest.simTime) < 1e-9) {
    return [...snapshots.slice(0, -1), snapshot];
  }
  return [...snapshots, snapshot].slice(-MAX_VISUAL_SNAPSHOTS);
}

function visualInterpolationDelaySimSec(playbackSpeed: number): number {
  return Math.min(6, Math.max(0.25, playbackSpeed * VISUAL_INTERPOLATION_DELAY_WALL_SEC));
}

function visualRenderSimTime(
  snapshots: VehicleSnapshot[],
  playbackSpeed: number,
  running: boolean,
  nowMs: number,
  clock: VisualClock
): number {
  const latest = snapshots.at(-1);
  const oldest = snapshots[0];
  if (!latest || !oldest) return 0;
  const estimatedServerNowSec = latest.simTime + Math.max(0, (nowMs - latest.wallMs) / 1000) * playbackSpeed;
  const targetTimeSec = Math.min(
    latest.simTime,
    Math.max(oldest.simTime, estimatedServerNowSec - visualInterpolationDelaySimSec(playbackSpeed))
  );

  if (
    !running ||
    snapshots.length < 2 ||
    clock.simTime === null ||
    clock.wallMs === null ||
    clock.latestSimTime === null ||
    latest.simTime < clock.latestSimTime - 1e-9 ||
    clock.simTime < oldest.simTime - 1e-9 ||
    clock.simTime > latest.simTime + 1e-9
  ) {
    clock.simTime = running ? targetTimeSec : latest.simTime;
    clock.wallMs = nowMs;
    clock.latestSimTime = latest.simTime;
    return clock.simTime;
  }

  const elapsedWallSec = Math.max(0, (nowMs - clock.wallMs) / 1000);
  const nominalNextSec = clock.simTime + elapsedWallSec * playbackSpeed;
  const monotonicTargetSec = targetTimeSec < clock.simTime ? clock.simTime : targetTimeSec;
  const nextSec = Math.min(latest.simTime, Math.max(oldest.simTime, Math.min(nominalNextSec, monotonicTargetSec)));
  clock.simTime = nextSec;
  clock.wallMs = nowMs;
  clock.latestSimTime = latest.simTime;
  return nextSec;
}

function sampleVehiclePosesForFrame(
  snapshots: VehicleSnapshot[],
  playbackSpeed: number,
  running: boolean,
  nowMs: number,
  clock: VisualClock
): Map<string, VehiclePoseSnapshot> {
  const latest = snapshots.at(-1);
  if (!latest) return new Map();
  if (!running || snapshots.length < 2) return latest.vehicles;

  const renderTime = visualRenderSimTime(snapshots, playbackSpeed, running, nowMs, clock);
  let afterIndex = snapshots.findIndex((snapshot) => snapshot.simTime >= renderTime - 1e-9);
  if (afterIndex < 0) afterIndex = snapshots.length - 1;
  const before = snapshots[Math.max(0, afterIndex - 1)] ?? latest;
  const after = snapshots[afterIndex] ?? latest;
  const snapshotDtSec = after.simTime - before.simTime;
  if (snapshotDtSec <= 0) return latest.vehicles;

  const alpha = Math.min(1, Math.max(0, (renderTime - before.simTime) / snapshotDtSec));
  const sampled = new Map<string, VehiclePoseSnapshot>();
  for (const [vehicleId, pose] of after.vehicles.entries()) {
    const previous = before.vehicles.get(vehicleId);
    if (!previous) {
      sampled.set(vehicleId, pose);
      continue;
    }
    if (!poseHasSameMotionLeg(previous, pose)) {
      sampled.set(vehicleId, alpha >= 1 ? pose : previous);
      continue;
    }
    sampled.set(vehicleId, {
      ...pose,
      x: previous.x + (pose.x - previous.x) * alpha,
      z: previous.z + (pose.z - previous.z) * alpha,
      yaw: previous.yaw + normalizeAngle(pose.yaw - previous.yaw) * alpha
    });
  }
  return sampled;
}

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
  const snapshotsRef = useRef<VehicleSnapshot[]>([]);
  const visualClockRef = useRef<VisualClock>({ latestSimTime: null, simTime: null, wallMs: null });
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
    scene.background = new THREE.Color(0x101922);
    scene.fog = new THREE.Fog(0x101922, 42, 112);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
      edgeTraversalKeys: new Set(),
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
      const fallbackPositionAlpha = 1 - Math.exp(-dtSec * 28);
      const fallbackYawAlpha = 1 - Math.exp(-dtSec * 14);
      const running = runningRef.current;
      const speed = playbackSpeedRef.current;
      const sampledPoses = sampleVehiclePosesForFrame(snapshotsRef.current, speed, running, nowMs, visualClockRef.current);
      for (const [vehicleId, object] of runtime.vehicleObjects.entries()) {
        const data = vehicleUserData(object);
        const sampledPose = sampledPoses.get(vehicleId);
        if (sampledPose) {
          object.position.set(sampledPose.x, 0, sampledPose.z);
          object.rotation.y = sampledPose.yaw;
        } else {
          object.position.lerp(data.targetPosition, fallbackPositionAlpha);
          object.rotation.y += normalizeAngle(data.targetYaw - object.rotation.y) * fallbackYawAlpha;
        }
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
        vehicles: new Map(visualState.vehicles.map((vehicle) => {
          const displayPose = routeDisplayPoseForVehicle(runtime, vehicle);
          return [
            vehicle.id,
            {
              x: displayPose.x,
              z: displayPose.z,
              yaw: displayPose.yaw,
              currentEdgeId: vehicle.currentEdgeId,
              currentNodeId: vehicle.currentNodeId,
              targetNodeId: vehicle.targetNodeId,
              taskId: vehicle.taskId,
              loaded: vehicle.loaded
            }
          ];
        }))
      };
      snapshotsRef.current = appendVehicleSnapshot(snapshotsRef.current, newSnap);
    }
    runningRef.current = visualState?.status === 'running';
  }, [scenario, state, layers, selectedVehicleId]);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed ?? 1;
  }, [playbackSpeed]);

  return <div className="shuttle-scene-3d" ref={hostRef} />;
}
