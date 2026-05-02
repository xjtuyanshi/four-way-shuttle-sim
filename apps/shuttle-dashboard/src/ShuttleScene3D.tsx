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

function computeBounds(nodes: ShuttleNode[]): {
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

function createDirectionMarker(
  from: { x: number; z: number },
  to: { x: number; z: number },
  markerMaterial: THREE.Material
): THREE.Mesh | null {
  const direction = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
  if (direction.length() < 0.001) {
    return null;
  }

  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 18), markerMaterial);
  marker.position.set((from.x + to.x) / 2, 0.24, (from.z + to.z) / 2);
  marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return marker;
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

function createPalletLoadObject(widthM: number, depthM: number, crateColor = 0xe2b84b): THREE.Group {
  const group = new THREE.Group();

  const pallet = new THREE.Mesh(new THREE.BoxGeometry(widthM, 0.08, depthM), material(0x8a6b42, 0.8, 0.02));
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

function createStorageBay(node: ShuttleNode): THREE.Group {
  const group = new THREE.Group();
  group.position.set(node.x, 0, node.z);

  const base = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.06, 0.9), material(0x2f4f43, 0.78, 0.04));
  base.position.y = 0.03;
  base.receiveShadow = true;
  group.add(base);

  const railMaterial = material(0x60717f, 0.64, 0.16);
  for (const z of [-0.32, 0.32]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.05, 0.05), railMaterial);
    rail.position.set(0, 0.11, z);
    rail.castShadow = true;
    group.add(rail);
  }

  const postGeometry = new THREE.BoxGeometry(0.06, 0.82, 0.06);
  const postMaterial = material(0x455462, 0.6, 0.18);
  for (const x of [-0.58, 0.58]) {
    for (const z of [-0.45, 0.45]) {
      const post = new THREE.Mesh(postGeometry, postMaterial);
      post.position.set(x, 0.43, z);
      post.castShadow = true;
      group.add(post);
    }
  }

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.05, 0.96), material(0x354553, 0.7, 0.1));
  top.position.y = 0.86;
  top.castShadow = true;
  group.add(top);

  return group;
}

function createVehicleObject(scenario: ShuttleScenario): THREE.Group {
  const group = new THREE.Group();
  const bodyMaterial = material(0x2f8d86, 0.5, 0.22);
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
  const loadMesh = createPalletLoadObject(0.76, 0.58);
  const offset = index % 2 === 0 ? 0.38 : -0.38;
  loadMesh.position.set(node.x + offset, 0.18, node.z + 0.42);
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
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.width, bounds.depth),
    new THREE.MeshStandardMaterial({ color: 0x17212b, roughness: 0.92, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(bounds.centerX, FLOOR_Y, bounds.centerZ);
  floor.receiveShadow = true;
  runtime.staticGroup.add(floor);

  const grid = new THREE.GridHelper(bounds.size, 18, 0x334251, 0x273440);
  grid.position.set(bounds.centerX, FLOOR_Y + 0.006, bounds.centerZ);
  runtime.staticGroup.add(grid);

  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0x536271, roughness: 0.84, metalness: 0.08 });
  const fifoEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0x3f9c77, roughness: 0.78, metalness: 0.06 });
  const fifoMarkerMaterial = new THREE.MeshStandardMaterial({ color: 0xaedbc4, roughness: 0.58, metalness: 0.08 });
  for (const edge of scenario.layout.edges) {
    const from = runtime.nodeById.get(edge.from);
    const to = runtime.nodeById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const isFifoLane = edge.conflictGroup?.startsWith('fifo-lane') ?? false;
    const segment = createSegment(from, to, isFifoLane ? 0.075 : 0.055, isFifoLane ? fifoEdgeMaterial : edgeMaterial, 0.07);
    if (segment) {
      runtime.staticGroup.add(segment);
    }
    if (edge.directionMode === 'oneWay') {
      const marker = createDirectionMarker(from, to, fifoMarkerMaterial);
      if (marker) {
        runtime.staticGroup.add(marker);
      }
    }
  }

  for (const node of scenario.layout.nodes) {
    const isStorage = node.type === 'storage';
    if (isStorage) {
      runtime.staticGroup.add(createStorageBay(node));
    } else {
      const nodeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 24), material(nodeColor(node), 0.66, 0.1));
      nodeMesh.position.set(node.x, 0.09, node.z);
      nodeMesh.castShadow = true;
      nodeMesh.receiveShadow = true;
      runtime.staticGroup.add(nodeMesh);
    }
  }

  runtime.camera.position.set(
    bounds.centerX - bounds.size * 0.68,
    Math.max(7, bounds.size * 0.58),
    bounds.centerZ + bounds.size * 0.82
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
