import type { ShuttleScenario } from '@four-way-shuttle/schemas';

type LayoutNode = ShuttleScenario['layout']['nodes'][number];

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
  const hasLeftAisle = scenario.layout.nodes.some((node) => node.id.startsWith('left-'));
  const hasRightAisle = scenario.layout.nodes.some((node) => node.id.startsWith('right-'));
  const crossAisleTrackCount = scenario.layout.edges.filter((edge) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to || from.type !== 'aisle' || to.type !== 'aisle') {
      return false;
    }
    return from.z === to.z && ((from.id.startsWith('left-') && to.id.startsWith('right-')) || (from.id.startsWith('right-') && to.id.startsWith('left-')));
  }).length;
  const inboundLiftNodes = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.id.startsWith('inbound-lift-'));
  const outboundLiftNodes = scenario.layout.nodes.filter((node) => node.type === 'lift-blackbox' && node.id.startsWith('outbound-lift-'));
  const parkingNodes = scenario.layout.nodes.filter((node) => node.type === 'parking');
  const inboundSide = sideForNodes(inboundLiftNodes, storageBlockMinXM, storageBlockMaxXM);
  const outboundSide = sideForNodes(outboundLiftNodes, storageBlockMinXM, storageBlockMaxXM);
  const storageLaneTrackCount = storageRows;
  const sideAisleTrackCount = Number(hasLeftAisle) + Number(hasRightAisle);
  const inboundConnectorTrackCount = inboundLiftNodes.length;
  const outboundConnectorTrackCount = outboundLiftNodes.length;
  const parkingConnectorTrackCount = parkingNodes.length;
  const trackBedCount =
    storageLaneTrackCount +
    sideAisleTrackCount +
    crossAisleTrackCount +
    inboundConnectorTrackCount +
    outboundConnectorTrackCount +
    parkingConnectorTrackCount;

  const addTrackFromNodes = (
    target: ShuttleStaticSceneTrackBed[],
    options: {
      id: string;
      category: ShuttleStaticSceneTrackCategory;
      fromNodeId: string;
      toNodeId: string;
      widthM: number;
      row: number;
      side: ShuttleStaticSceneTrackBed['side'];
    }
  ) => {
    const from = nodesById.get(options.fromNodeId);
    const to = nodesById.get(options.toNodeId);
    if (!from || !to) {
      return;
    }
    const deltaX = Math.abs(to.x - from.x);
    const deltaZ = Math.abs(to.z - from.z);
    const orientation = deltaX >= deltaZ ? 'x' : 'z';
    target.push({
      id: options.id,
      category: options.category,
      xM: round((from.x + to.x) / 2, 6),
      yM: round((from.y + to.y) / 2, 6),
      zM: round((from.z + to.z) / 2, 6),
      lengthXM: round(orientation === 'x' ? deltaX : options.widthM, 6),
      lengthZM: round(orientation === 'z' ? deltaZ : options.widthM, 6),
      orientation,
      row: options.row,
      side: options.side
    });
  };

  const trackBeds: ShuttleStaticSceneTrackBed[] = [];
  for (const row of [...storageRowsById].sort((left, right) => left - right)) {
    const rowLabel = String(row).padStart(2, '0');
    addTrackFromNodes(trackBeds, {
      id: `storage-lane-r${rowLabel}`,
      category: 'storageLane',
      fromNodeId: `left-row-${rowLabel}`,
      toNodeId: `right-row-${rowLabel}`,
      widthM: DEFAULT_STORAGE_LANE_TRACK_WIDTH_Z_M,
      row,
      side: 'none'
    });
  }
  addTrackFromNodes(trackBeds, {
    id: 'side-aisle-left',
    category: 'sideAisle',
    fromNodeId: 'left-top',
    toNodeId: 'left-bottom',
    widthM: DEFAULT_AISLE_TRACK_WIDTH_M,
    row: 0,
    side: 'left'
  });
  addTrackFromNodes(trackBeds, {
    id: 'side-aisle-right',
    category: 'sideAisle',
    fromNodeId: 'right-top',
    toNodeId: 'right-bottom',
    widthM: DEFAULT_AISLE_TRACK_WIDTH_M,
    row: 0,
    side: 'right'
  });
  addTrackFromNodes(trackBeds, {
    id: 'cross-aisle-top',
    category: 'crossAisle',
    fromNodeId: 'left-top',
    toNodeId: 'right-top',
    widthM: DEFAULT_AISLE_TRACK_WIDTH_M,
    row: 0,
    side: 'top'
  });
  addTrackFromNodes(trackBeds, {
    id: 'cross-aisle-bottom',
    category: 'crossAisle',
    fromNodeId: 'left-bottom',
    toNodeId: 'right-bottom',
    widthM: DEFAULT_AISLE_TRACK_WIDTH_M,
    row: 0,
    side: 'bottom'
  });
  for (const node of sortedById(inboundLiftNodes)) {
    const rowMatch = /-(a|b)$/.exec(node.id);
    const targetRow = rowMatch?.[1] === 'a' ? 1 : storageRows;
    const rowLabel = String(targetRow).padStart(2, '0');
    addTrackFromNodes(trackBeds, {
      id: `${node.id}-right-row-${rowLabel}`,
      category: 'inboundConnector',
      fromNodeId: node.id,
      toNodeId: `right-row-${rowLabel}`,
      widthM: DEFAULT_CONNECTOR_TRACK_WIDTH_M,
      row: targetRow,
      side: 'right'
    });
  }
  for (const node of sortedById(outboundLiftNodes)) {
    const rowMatch = /-(a|b)$/.exec(node.id);
    const targetRow = rowMatch?.[1] === 'a' ? 1 : storageRows;
    const rowLabel = String(targetRow).padStart(2, '0');
    addTrackFromNodes(trackBeds, {
      id: `${node.id}-left-row-${rowLabel}`,
      category: 'outboundConnector',
      fromNodeId: node.id,
      toNodeId: `left-row-${rowLabel}`,
      widthM: DEFAULT_CONNECTOR_TRACK_WIDTH_M,
      row: targetRow,
      side: 'left'
    });
  }
  addTrackFromNodes(trackBeds, {
    id: 'parking-a-right-top',
    category: 'parkingConnector',
    fromNodeId: 'parking-a',
    toNodeId: 'right-top',
    widthM: DEFAULT_CONNECTOR_TRACK_WIDTH_M,
    row: 0,
    side: 'right'
  });
  addTrackFromNodes(trackBeds, {
    id: 'parking-b-right-bottom',
    category: 'parkingConnector',
    fromNodeId: 'parking-b',
    toNodeId: 'right-bottom',
    widthM: DEFAULT_CONNECTOR_TRACK_WIDTH_M,
    row: 0,
    side: 'right'
  });

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
    storagePitchXM: minimumPositivePitch(storageNodes.map((node) => node.x)),
    storagePitchZM: minimumPositivePitch(storageNodes.map((node) => node.z)),
    storageBlockMinXM,
    storageBlockMaxXM,
    storageBlockMinZM,
    storageBlockMaxZM,
    inboundLiftXM: averageX(inboundLiftNodes),
    outboundLiftXM: averageX(outboundLiftNodes),
    singleLevel: sortedUniqueNumbers(scenario.layout.nodes.map((node) => node.y)).length === 1,
    denseStorageBlock:
      expectedCellCount > 0 &&
      storageNodes.length === expectedCellCount &&
      storageXs.length === storageColumns &&
      storageZs.length === storageRows &&
      completeIdGrid,
    orthogonalTrackOnly: diagonalTrackCount === 0,
    dedicatedLiftPorts:
      inboundLiftNodes.length > 0 &&
      outboundLiftNodes.length > 0 &&
      inboundSide !== 'mixed' &&
      outboundSide !== 'mixed' &&
      inboundSide !== outboundSide,
    inboundSide,
    outboundSide
  };
}
