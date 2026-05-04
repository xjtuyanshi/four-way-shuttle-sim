import type { ShuttleScenario } from '@four-way-shuttle/schemas';

type LayoutNode = ShuttleScenario['layout']['nodes'][number];
type LiftKind = NonNullable<LayoutNode['liftKind']>;

const DEFAULT_STORAGE_CELL_VISUAL_SIZE_X_M = 1.12;
const DEFAULT_STORAGE_CELL_VISUAL_SIZE_Z_M = 1.08;
const DEFAULT_STORAGE_LANE_TRACK_WIDTH_Z_M = 0.08;
const DEFAULT_AISLE_TRACK_WIDTH_M = 0.1;
const DEFAULT_CONNECTOR_TRACK_WIDTH_M = 0.12;
const DEFAULT_LIFT_PAD_SIZE_X_M = 1.5;
const DEFAULT_LIFT_PAD_SIZE_Z_M = 1.15;

export type ShuttleStaticSceneContract = {
  schemaVersion: 'shuttle.simCoreStaticSceneContract.v1';
  scenarioId: string;
  units: 'meter';
  storageCells: ShuttleStaticSceneStorageCell[];
  trackBeds: ShuttleStaticSceneTrackBed[];
  liftPads: ShuttleStaticScenePad[];
  parkingPads: ShuttleStaticScenePad[];
  storageRows: number;
  storageColumns: number;
  storageCellCount: number;
  trackBedCount: number;
  storageLaneTrackCount: number;
  sideAisleTrackCount: number;
  crossAisleTrackCount: number;
  inboundConnectorTrackCount: number;
  outboundConnectorTrackCount: number;
  parkingConnectorTrackCount: number;
  diagonalTrackCount: number;
  inboundLiftPadCount: number;
  outboundLiftPadCount: number;
  parkingPadCount: number;
  storagePitchXM: number;
  storagePitchZM: number;
  storageBlockMinXM: number;
  storageBlockMaxXM: number;
  storageBlockMinZM: number;
  storageBlockMaxZM: number;
  inboundLiftXM: number;
  outboundLiftXM: number;
  singleLevel: boolean;
  storageIslandCount: number;
  denseStorageIslands: boolean;
  denseStorageBlock: boolean;
  orthogonalTrackOnly: boolean;
  dedicatedLiftPorts: boolean;
  inboundSide: 'left' | 'right' | 'mixed';
  outboundSide: 'left' | 'right' | 'mixed';
};

export type ShuttleStaticSceneStorageCell = {
  id: string;
  row: number;
  column: number;
  xM: number;
  yM: number;
  zM: number;
  lengthXM: number;
  lengthZM: number;
};

export type ShuttleStaticSceneTrackCategory =
  | 'storageLane'
  | 'sideAisle'
  | 'crossAisle'
  | 'inboundConnector'
  | 'outboundConnector'
  | 'parkingConnector';

export type ShuttleStaticSceneTrackBed = {
  id: string;
  category: ShuttleStaticSceneTrackCategory;
  xM: number;
  yM: number;
  zM: number;
  lengthXM: number;
  lengthZM: number;
  orientation: 'x' | 'z';
  row: number;
  side: 'left' | 'right' | 'top' | 'bottom' | 'none';
};

export type ShuttleStaticScenePad = {
  id: string;
  category: 'inboundLift' | 'outboundLift' | 'parking';
  xM: number;
  yM: number;
  zM: number;
  lengthXM: number;
  lengthZM: number;
  side: 'left' | 'right' | 'mixed';
};

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sortedUniqueNumbers(values: number[]): number[] {
  return [...new Set(values.map((value) => round(value, 6)))].sort((left, right) => left - right);
}

function minimumPositivePitch(values: number[]): number {
  const sorted = sortedUniqueNumbers(values);
  const deltas = sorted.slice(1).map((value, index) => round(value - sorted[index]!, 6)).filter((value) => value > 1e-6);
  return deltas.length > 0 ? deltas[0]! : 0;
}

function hasUniformPitch(values: number[], pitch: number): boolean {
  if (values.length <= 2) {
    return true;
  }
  const sorted = sortedUniqueNumbers(values);
  return sorted.slice(1).every((value, index) => Math.abs(round(value - sorted[index]!, 6) - pitch) <= 1e-6);
}

function splitBandCount(values: number[], pitch: number): number {
  const sorted = sortedUniqueNumbers(values);
  if (sorted.length === 0) {
    return 0;
  }
  const splitThreshold = Math.max(pitch * 1.5, 1e-6);
  return sorted.slice(1).reduce((count, value, index) => (
    value - sorted[index]! > splitThreshold ? count + 1 : count
  ), 1);
}

function averageX(nodes: LayoutNode[]): number {
  if (nodes.length === 0) {
    return 0;
  }
  return round(nodes.reduce((total, node) => total + node.x, 0) / nodes.length, 6);
}

function sideForNodes(nodes: LayoutNode[], storageMinX: number, storageMaxX: number): 'left' | 'right' | 'mixed' {
  if (nodes.length === 0) {
    return 'mixed';
  }
  if (nodes.every((node) => node.x > storageMaxX)) {
    return 'right';
  }
  if (nodes.every((node) => node.x < storageMinX)) {
    return 'left';
  }
  return 'mixed';
}

function sortedById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function sideForX(x: number, storageMinX: number, storageMaxX: number): 'left' | 'right' | 'mixed' {
  if (x > storageMaxX) {
    return 'right';
  }
  if (x < storageMinX) {
    return 'left';
  }
  return 'mixed';
}

function rowForNodeId(nodeId: string): number {
  const storageMatch = /^storage-r(\d+)-c\d+$/.exec(nodeId);
  if (storageMatch) {
    return Number(storageMatch[1]);
  }
  const sideRowMatch = /^(?:left|right)-row-(\d+)$/.exec(nodeId);
  return sideRowMatch ? Number(sideRowMatch[1]) : 0;
}

function liftKindForNode(node: LayoutNode): LiftKind | null {
  if (node.type !== 'lift-blackbox') {
    return null;
  }
  return node.liftKind ?? null;
}

function sideForTrack(
  from: LayoutNode,
  to: LayoutNode,
  storageMinX: number,
  storageMaxX: number,
  storageMinZ: number,
  storageMaxZ: number
): ShuttleStaticSceneTrackBed['side'] {
  const x = (from.x + to.x) / 2;
  const z = (from.z + to.z) / 2;
  if (x < storageMinX) {
    return 'left';
  }
  if (x > storageMaxX) {
    return 'right';
  }
  if (z < storageMinZ) {
    return 'top';
  }
  if (z > storageMaxZ) {
    return 'bottom';
  }
  return 'none';
}

function trackCategoryForEdge(
  edge: ShuttleScenario['layout']['edges'][number],
  from: LayoutNode,
  to: LayoutNode
): ShuttleStaticSceneTrackCategory {
  if (from.type === 'parking' || to.type === 'parking') {
    return 'parkingConnector';
  }
  const liftNode = from.type === 'lift-blackbox' ? from : to.type === 'lift-blackbox' ? to : null;
  if (liftNode && liftKindForNode(liftNode) === 'inbound') {
    return 'inboundConnector';
  }
  if (liftNode && liftKindForNode(liftNode) === 'outbound') {
    return 'outboundConnector';
  }
  if (edge.conflictGroup?.startsWith('fifo-lane')) {
    return 'storageLane';
  }
  return Math.abs(to.x - from.x) >= Math.abs(to.z - from.z) ? 'crossAisle' : 'sideAisle';
}

export function summarizeScenarioStaticSceneContract(scenario: ShuttleScenario): ShuttleStaticSceneContract {
  const storageNodes = scenario.layout.nodes.filter((node) => node.type === 'storage');
  const storageCells: ShuttleStaticSceneStorageCell[] = [];
  const storageCellIds = new Set<string>();
  const storageRowsById = new Set<number>();
  const storageColumnsById = new Set<number>();
  for (const node of storageNodes) {
    const match = /^storage-r(\d+)-c(\d+)$/.exec(node.id);
    if (!match) {
      continue;
    }
    storageRowsById.add(Number(match[1]));
    storageColumnsById.add(Number(match[2]));
    storageCellIds.add(`${Number(match[1])}:${Number(match[2])}`);
    storageCells.push({
      id: node.id,
      row: Number(match[1]),
      column: Number(match[2]),
      xM: round(node.x, 6),
      yM: round(node.y, 6),
      zM: round(node.z, 6),
      lengthXM: DEFAULT_STORAGE_CELL_VISUAL_SIZE_X_M,
      lengthZM: DEFAULT_STORAGE_CELL_VISUAL_SIZE_Z_M
    });
  }

  const storageXs = sortedUniqueNumbers(storageNodes.map((node) => node.x));
  const storageZs = sortedUniqueNumbers(storageNodes.map((node) => node.z));
  const storageRows = storageRowsById.size;
  const storageColumns = storageColumnsById.size;
  const storagePitchXM = minimumPositivePitch(storageNodes.map((node) => node.x));
  const storagePitchZM = minimumPositivePitch(storageNodes.map((node) => node.z));
  const storageColumnIslandCount = splitBandCount(storageXs, storagePitchXM);
  const storageRowBankCount = splitBandCount(storageZs, storagePitchZM);
  const storageIslandCount = storageColumnIslandCount * storageRowBankCount;
  const storageBlockMinXM = storageXs[0] ?? 0;
  const storageBlockMaxXM = storageXs[storageXs.length - 1] ?? 0;
  const storageBlockMinZM = storageZs[0] ?? 0;
  const storageBlockMaxZM = storageZs[storageZs.length - 1] ?? 0;
  const expectedCellCount = storageRows * storageColumns;
  const completeIdGrid =
    storageRows > 0 &&
    storageColumns > 0 &&
    Array.from({ length: storageRows }, (_, rowIndex) => rowIndex + 1).every((row) =>
      Array.from({ length: storageColumns }, (_, columnIndex) => columnIndex + 1).every((column) =>
        storageCellIds.has(`${row}:${column}`)
      )
    );

  const nodesById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  const diagonalTrackCount = scenario.layout.edges.filter((edge) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    return Boolean(from && to && Math.abs(from.x - to.x) > 1e-6 && Math.abs(from.z - to.z) > 1e-6);
  }).length;
  const inboundLiftNodes = scenario.layout.nodes.filter((node) => liftKindForNode(node) === 'inbound');
  const outboundLiftNodes = scenario.layout.nodes.filter((node) => liftKindForNode(node) === 'outbound');
  const parkingNodes = scenario.layout.nodes.filter((node) => node.type === 'parking');
  const inboundSide = sideForNodes(inboundLiftNodes, storageBlockMinXM, storageBlockMaxXM);
  const outboundSide = sideForNodes(outboundLiftNodes, storageBlockMinXM, storageBlockMaxXM);

  const trackBeds: ShuttleStaticSceneTrackBed[] = [];
  for (const edge of scenario.layout.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const deltaX = Math.abs(to.x - from.x);
    const deltaZ = Math.abs(to.z - from.z);
    const orientation = deltaX >= deltaZ ? 'x' : 'z';
    const category = trackCategoryForEdge(edge, from, to);
    const widthM = category === 'storageLane'
      ? DEFAULT_STORAGE_LANE_TRACK_WIDTH_Z_M
      : category === 'inboundConnector' || category === 'outboundConnector' || category === 'parkingConnector'
        ? DEFAULT_CONNECTOR_TRACK_WIDTH_M
        : DEFAULT_AISLE_TRACK_WIDTH_M;
    trackBeds.push({
      id: edge.id,
      category,
      xM: round((from.x + to.x) / 2, 6),
      yM: round((from.y + to.y) / 2, 6),
      zM: round((from.z + to.z) / 2, 6),
      lengthXM: round(orientation === 'x' ? deltaX : widthM, 6),
      lengthZM: round(orientation === 'z' ? deltaZ : widthM, 6),
      orientation,
      row: Math.max(rowForNodeId(edge.from), rowForNodeId(edge.to)),
      side: sideForTrack(from, to, storageBlockMinXM, storageBlockMaxXM, storageBlockMinZM, storageBlockMaxZM)
    });
  }

  const storageLaneTrackCount = trackBeds.filter((track) => track.category === 'storageLane').length;
  const sideAisleTrackCount = trackBeds.filter((track) => track.category === 'sideAisle').length;
  const crossAisleTrackCount = trackBeds.filter((track) => track.category === 'crossAisle').length;
  const inboundConnectorTrackCount = trackBeds.filter((track) => track.category === 'inboundConnector').length;
  const outboundConnectorTrackCount = trackBeds.filter((track) => track.category === 'outboundConnector').length;
  const parkingConnectorTrackCount = trackBeds.filter((track) => track.category === 'parkingConnector').length;
  const trackBedCount = trackBeds.length;

  const liftPads: ShuttleStaticScenePad[] = sortedById([
    ...inboundLiftNodes.map((node) => ({
      id: node.id,
      category: 'inboundLift' as const,
      xM: round(node.x, 6),
      yM: round(node.y, 6),
      zM: round(node.z, 6),
      lengthXM: DEFAULT_LIFT_PAD_SIZE_X_M,
      lengthZM: DEFAULT_LIFT_PAD_SIZE_Z_M,
      side: sideForX(node.x, storageBlockMinXM, storageBlockMaxXM)
    })),
    ...outboundLiftNodes.map((node) => ({
      id: node.id,
      category: 'outboundLift' as const,
      xM: round(node.x, 6),
      yM: round(node.y, 6),
      zM: round(node.z, 6),
      lengthXM: DEFAULT_LIFT_PAD_SIZE_X_M,
      lengthZM: DEFAULT_LIFT_PAD_SIZE_Z_M,
      side: sideForX(node.x, storageBlockMinXM, storageBlockMaxXM)
    }))
  ]);
  const parkingPads: ShuttleStaticScenePad[] = sortedById(parkingNodes.map((node) => ({
    id: node.id,
    category: 'parking' as const,
    xM: round(node.x, 6),
    yM: round(node.y, 6),
    zM: round(node.z, 6),
    lengthXM: DEFAULT_LIFT_PAD_SIZE_X_M,
    lengthZM: DEFAULT_LIFT_PAD_SIZE_Z_M,
    side: sideForX(node.x, storageBlockMinXM, storageBlockMaxXM)
  })));

  return {
    schemaVersion: 'shuttle.simCoreStaticSceneContract.v1',
    scenarioId: scenario.id,
    units: scenario.layout.units,
    storageCells: sortedById(storageCells),
    trackBeds: sortedById(trackBeds),
    liftPads,
    parkingPads,
    storageRows,
    storageColumns,
    storageCellCount: storageNodes.length,
    trackBedCount,
    storageLaneTrackCount,
    sideAisleTrackCount,
    crossAisleTrackCount,
    inboundConnectorTrackCount,
    outboundConnectorTrackCount,
    parkingConnectorTrackCount,
    diagonalTrackCount,
    inboundLiftPadCount: inboundLiftNodes.length,
    outboundLiftPadCount: outboundLiftNodes.length,
    parkingPadCount: parkingNodes.length,
    storagePitchXM,
    storagePitchZM,
    storageBlockMinXM,
    storageBlockMaxXM,
    storageBlockMinZM,
    storageBlockMaxZM,
    inboundLiftXM: averageX(inboundLiftNodes),
    outboundLiftXM: averageX(outboundLiftNodes),
    singleLevel: sortedUniqueNumbers(scenario.layout.nodes.map((node) => node.y)).length === 1,
    storageIslandCount,
    denseStorageIslands:
      storageIslandCount > 0 &&
      storageNodes.length === expectedCellCount &&
      storageXs.length === storageColumns &&
      storageZs.length === storageRows &&
      completeIdGrid,
    denseStorageBlock:
      expectedCellCount > 0 &&
      storageNodes.length === expectedCellCount &&
      storageXs.length === storageColumns &&
      storageZs.length === storageRows &&
      completeIdGrid &&
      hasUniformPitch(storageNodes.map((node) => node.x), storagePitchXM) &&
      hasUniformPitch(storageNodes.map((node) => node.z), storagePitchZM),
    orthogonalTrackOnly: diagonalTrackCount === 0,
    dedicatedLiftPorts:
      inboundLiftNodes.length > 0 &&
      outboundLiftNodes.length > 0,
    inboundSide,
    outboundSide
  };
}
