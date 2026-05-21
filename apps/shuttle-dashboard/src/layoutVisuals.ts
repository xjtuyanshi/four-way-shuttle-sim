import type { ShuttleStaticSceneContract, ShuttleStaticSceneTrackCategory } from '@four-way-shuttle/sim-core/static-scene';

export type MeterRect = {
  id: string;
  category: ShuttleStaticSceneTrackCategory | 'storageCell' | 'storageColumn';
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type StorageField = {
  cells: ShuttleStaticSceneContract['storageCells'];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
  columns: number[];
  rows: number[];
};

function createStorageField(cells: ShuttleStaticSceneContract['storageCells']): StorageField {
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

export function getStorageFields(staticScene: ShuttleStaticSceneContract): StorageField[] {
  const cells = staticScene.storageCells;
  if (cells.length === 0) {
    return [];
  }
  const xs = [...new Set(cells.map((cell) => cell.xM))].sort((left, right) => left - right);
  const zs = [...new Set(cells.map((cell) => cell.zM))].sort((left, right) => left - right);
  const splitXM = Math.max(staticScene.storagePitchXM * 1.5, 0.01);
  const splitZM = Math.max(staticScene.storagePitchZM * 1.5, 0.01);
  const cellsByField = new Map<string, ShuttleStaticSceneContract['storageCells']>();
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

function rectsCanMerge(left: MeterRect, right: MeterRect): boolean {
  if (left.category !== right.category) {
    return false;
  }
  const epsilon = 0.0001;
  const sameZSpan = Math.abs(left.minZ - right.minZ) <= epsilon && Math.abs(left.maxZ - right.maxZ) <= epsilon;
  const sameXSpan = Math.abs(left.minX - right.minX) <= epsilon && Math.abs(left.maxX - right.maxX) <= epsilon;
  const xTouchOrOverlap = left.maxX + epsilon >= right.minX && right.maxX + epsilon >= left.minX;
  const zTouchOrOverlap = left.maxZ + epsilon >= right.minZ && right.maxZ + epsilon >= left.minZ;
  return (sameZSpan && xTouchOrOverlap) || (sameXSpan && zTouchOrOverlap);
}

function mergePair(left: MeterRect, right: MeterRect): MeterRect {
  return {
    id: `${left.id}+${right.id}`,
    category: left.category,
    minX: Math.min(left.minX, right.minX),
    maxX: Math.max(left.maxX, right.maxX),
    minZ: Math.min(left.minZ, right.minZ),
    maxZ: Math.max(left.maxZ, right.maxZ)
  };
}

export function mergeMeterRects(sourceRects: MeterRect[]): MeterRect[] {
  const rects = [...sourceRects];
  let changed = true;
  while (changed) {
    changed = false;
    for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
        const left = rects[leftIndex]!;
        const right = rects[rightIndex]!;
        if (!rectsCanMerge(left, right)) {
          continue;
        }
        rects.splice(rightIndex, 1);
        rects.splice(leftIndex, 1, mergePair(left, right));
        changed = true;
        break;
      }
      if (changed) {
        break;
      }
    }
  }
  return rects.map((rect, index) => ({ ...rect, id: `${rect.category}-${index}` }));
}

export function createTrackAreaRects(
  staticScene: ShuttleStaticSceneContract,
  categories: ShuttleStaticSceneTrackCategory[]
): MeterRect[] {
  const categorySet = new Set(categories);
  return mergeMeterRects(staticScene.trackBeds
    .filter((track) => categorySet.has(track.category))
    .map((track) => ({
      id: track.id,
      category: track.category,
      minX: track.xM - track.lengthXM / 2,
      maxX: track.xM + track.lengthXM / 2,
      minZ: track.zM - track.lengthZM / 2,
      maxZ: track.zM + track.lengthZM / 2
    })));
}

export function createStorageColumnRects(staticScene: ShuttleStaticSceneContract): MeterRect[] {
  const rects: MeterRect[] = [];
  getStorageFields(staticScene).forEach((field, fieldIndex) => {
    const averageCellLengthM = field.cells.reduce((sum, cell) => sum + cell.lengthXM, 0) / field.cells.length;
    const columnWidthM = Math.max(averageCellLengthM * 0.16, 0.08);
    field.columns.forEach((columnX, columnIndex) => {
      rects.push({
        id: `storage-column-${fieldIndex}-${columnIndex}`,
        category: 'storageColumn',
        minX: columnX - columnWidthM / 2,
        maxX: columnX + columnWidthM / 2,
        minZ: field.minZ,
        maxZ: field.maxZ
      });
    });
  });
  return rects;
}

export function createStorageCellRects(staticScene: ShuttleStaticSceneContract): MeterRect[] {
  return staticScene.storageCells.map((cell) => {
    const widthM = Math.max(cell.lengthXM * 0.72, 0.12);
    const depthM = Math.max(cell.lengthZM * 0.72, 0.12);
    return {
      id: `storage-cell-${cell.id}`,
      category: 'storageCell',
      minX: cell.xM - widthM / 2,
      maxX: cell.xM + widthM / 2,
      minZ: cell.zM - depthM / 2,
      maxZ: cell.zM + depthM / 2
    };
  });
}
