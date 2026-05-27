import { ShuttleScenarioSchema, type ShuttleScenario } from '@four-way-shuttle/schemas';

type DesTaskKind = 'inbound' | 'outbound';
type ColumnMode = 'inbound' | 'outbound';
type CellState = 'empty' | 'stored' | 'reserved-inbound' | 'reserved-outbound';

type DesEventType = 'inbound-arrival' | 'outbound-arrival' | 'lift-slot-release' | 'task-complete';

type DesEvent = {
  id: number;
  timeSec: number;
  type: DesEventType;
  regionIndex?: number;
  liftNodeId?: string;
  task?: DesTask;
};

type DesTask = {
  id: string;
  kind: DesTaskKind;
  regionIndex: number;
  createdAtSec: number;
  pickupNodeId: string;
  dropoffNodeId: string;
  liftNodeId: string;
  storageNodeId: string;
  column: number;
  row: number;
};

type ShuttleResource = {
  id: string;
  nodeId: string;
  busySec: number;
  travelSec: number;
  handlingSec: number;
  resourceWaitSec: number;
  tasks: number;
  inboundTasks: number;
  outboundTasks: number;
};

type LiftResource = {
  id: string;
  kind: DesTaskKind;
  regionIndex: number;
  availableSec: number;
  busySec: number;
  completed: number;
};

type StorageCell = {
  nodeId: string;
  row: number;
  column: number;
  regionIndex: number;
  state: CellState;
};

type StorageColumn = {
  column: number;
  regionIndex: number;
  mode: ColumnMode;
  cells: StorageCell[];
};

export type HeadlessDesOptions = {
  scenario?: ShuttleScenario;
  durationSec?: number;
  sampleIntervalSec?: number;
  maxQueuedTasks?: number;
  liftBufferCapacity?: number;
};

export type HeadlessDesSample = {
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  queuedTasks: number;
  pendingInboundDemand: number;
  pendingOutboundDemand: number;
  storedLoads: number;
};

export type HeadlessDesResult = {
  schemaVersion: 'shuttle.headlessDes.v1';
  scenarioId: string;
  durationSec: number;
  finalSimTimeSec: number;
  wallClockMs: number;
  processedEvents: number;
  generatedInbound: number;
  generatedOutbound: number;
  acceptedInbound: number;
  acceptedOutbound: number;
  skippedInbound: number;
  skippedOutbound: number;
  completedInbound: number;
  completedOutbound: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  queuedTasks: number;
  activeTasks: number;
  pendingInboundDemand: number;
  pendingOutboundDemand: number;
  storedLoads: number;
  storageCapacity: number;
  storageUtilization: number;
  averageShuttleUtilization: number;
  shuttleUtilization: Record<string, {
    busy: number;
    travel: number;
    handling: number;
    resourceWait: number;
    tasks: number;
    inboundTasks: number;
    outboundTasks: number;
  }>;
  liftPph: Record<string, {
    kind: DesTaskKind;
    completed: number;
    pph: number;
    utilization: number;
  }>;
  bottlenecks: Record<string, number>;
  anomalyMarkers: Array<{
    timeSec: number;
    code: string;
    detail: string;
  }>;
  samples: HeadlessDesSample[];
};

class EventQueue {
  private readonly events: DesEvent[] = [];

  get size(): number {
    return this.events.length;
  }

  push(event: DesEvent): void {
    this.events.push(event);
    this.bubbleUp(this.events.length - 1);
  }

  pop(): DesEvent | null {
    if (this.events.length === 0) {
      return null;
    }
    const first = this.events[0]!;
    const last = this.events.pop()!;
    if (this.events.length > 0) {
      this.events[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private compare(left: DesEvent, right: DesEvent): number {
    return left.timeSec - right.timeSec || left.id - right.id;
  }

  private bubbleUp(index: number): void {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.compare(this.events[parent]!, this.events[cursor]!) <= 0) {
        break;
      }
      [this.events[parent], this.events[cursor]] = [this.events[cursor]!, this.events[parent]!];
      cursor = parent;
    }
  }

  private bubbleDown(index: number): void {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      let smallest = cursor;
      if (left < this.events.length && this.compare(this.events[left]!, this.events[smallest]!) < 0) {
        smallest = left;
      }
      if (right < this.events.length && this.compare(this.events[right]!, this.events[smallest]!) < 0) {
        smallest = right;
      }
      if (smallest === cursor) {
        break;
      }
      [this.events[cursor], this.events[smallest]] = [this.events[smallest]!, this.events[cursor]!];
      cursor = smallest;
    }
  }
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseStoragePosition(nodeId: string): { row: number; column: number } | null {
  const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
  return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
}

function intervalForRate(ratePerHour: number): number {
  return ratePerHour > 0 ? 3600 / ratePerHour : Number.POSITIVE_INFINITY;
}

function travelTimeSec(distanceM: number, speedMps: number, accelerationMps2: number): number {
  const speed = Math.max(0.001, speedMps);
  const acceleration = Math.max(0.001, accelerationMps2);
  const accelDistance = speed * speed / acceleration;
  if (distanceM <= accelDistance) {
    return 2 * Math.sqrt(distanceM / acceleration);
  }
  return 2 * (speed / acceleration) + (distanceM - accelDistance) / speed;
}

function staticLayoutDistanceM(
  nodePositions: Map<string, { x: number; z: number }>,
  cache: Map<string, number>,
  fromNodeId: string,
  toNodeId: string
): number {
  if (fromNodeId === toNodeId) {
    return 0;
  }
  const key = `${fromNodeId}>${toNodeId}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const from = nodePositions.get(fromNodeId);
  const to = nodePositions.get(toNodeId);
  const distanceM = from && to ? Math.abs(from.x - to.x) + Math.abs(from.z - to.z) : Infinity;
  cache.set(key, distanceM);
  return distanceM;
}

function inferRegionIndexFromLiftId(liftNodeId: string): number {
  const match = /^lift-(\d+)-/.exec(liftNodeId);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

export function runHeadlessDes(options: HeadlessDesOptions = {}): HeadlessDesResult {
  const startedAtMs = Date.now();
  if (!options.scenario) {
    throw new Error('runHeadlessDes requires an explicit scenario.');
  }
  const scenario = ShuttleScenarioSchema.parse(options.scenario);
  const durationSec = Math.max(0, options.durationSec ?? scenario.durationSec);
  const sampleIntervalSec = Math.max(1, options.sampleIntervalSec ?? Math.min(3600, Math.max(60, durationSec / 240)));
  const maxQueuedTasks = Math.max(1, options.maxQueuedTasks ?? Math.max(128, scenario.vehicles.count * 16, scenario.taskGeneration.maxTasks * 4));
  const liftBufferCapacity = Math.max(1, Math.round(options.liftBufferCapacity ?? 4));
  const nodePositions = new Map(scenario.layout.nodes.map((node) => [node.id, { x: node.x, z: node.z }]));
  const distanceCache = new Map<string, number>();

  const storageCells = scenario.layout.nodes
    .map((node) => ({ node, position: parseStoragePosition(node.id) }))
    .filter((entry): entry is { node: ShuttleScenario['layout']['nodes'][number]; position: { row: number; column: number } } =>
      entry.node.type === 'storage' && entry.position !== null
    );
  const totalColumns = Math.max(0, ...storageCells.map((entry) => entry.position.column));
  const totalRows = Math.max(0, ...storageCells.map((entry) => entry.position.row));
  const inboundLifts = scenario.layout.nodes
    .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
    .sort((left, right) => left.id.localeCompare(right.id));
  const outboundLifts = scenario.layout.nodes
    .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound')
    .sort((left, right) => left.id.localeCompare(right.id));
  const regionCount = Math.max(1, inboundLifts.length, outboundLifts.length);
  const columnsPerRegion = Math.max(1, Math.ceil(totalColumns / regionCount));
  const regionForColumn = (column: number): number => Math.min(regionCount - 1, Math.max(0, Math.floor((column - 1) / columnsPerRegion)));

  const columns = new Map<number, StorageColumn>();
  for (let column = 1; column <= totalColumns; column += 1) {
    columns.set(column, {
      column,
      regionIndex: regionForColumn(column),
      mode: column <= scenario.taskGeneration.initialOutboundFullColumns ? 'outbound' : 'inbound',
      cells: []
    });
  }
  for (const entry of storageCells) {
    const column = columns.get(entry.position.column);
    if (!column) {
      continue;
    }
    column.cells.push({
      nodeId: entry.node.id,
      row: entry.position.row,
      column: entry.position.column,
      regionIndex: column.regionIndex,
      state: entry.position.column <= scenario.taskGeneration.initialOutboundFullColumns ? 'stored' : 'empty'
    });
  }
  for (const column of columns.values()) {
    column.cells.sort((left, right) => right.row - left.row);
  }

  const lifts = new Map<string, LiftResource>();
  for (let index = 0; index < inboundLifts.length; index += 1) {
    const lift = inboundLifts[index]!;
    lifts.set(lift.id, { id: lift.id, kind: 'inbound', regionIndex: inferRegionIndexFromLiftId(lift.id) || index, availableSec: 0, busySec: 0, completed: 0 });
  }
  for (let index = 0; index < outboundLifts.length; index += 1) {
    const lift = outboundLifts[index]!;
    lifts.set(lift.id, { id: lift.id, kind: 'outbound', regionIndex: inferRegionIndexFromLiftId(lift.id) || index, availableSec: 0, busySec: 0, completed: 0 });
  }

  const liftForRegion = (kind: DesTaskKind, regionIndex: number): LiftResource | null => {
    const candidates = [...lifts.values()].filter((lift) => lift.kind === kind);
    if (candidates.length === 0) {
      return null;
    }
    return candidates.find((lift) => lift.regionIndex === regionIndex) ?? candidates[regionIndex % candidates.length] ?? candidates[0]!;
  };

  const shuttles: ShuttleResource[] = Array.from({ length: scenario.vehicles.count }, (_, index) => {
    const parking = scenario.layout.nodes.find((node) => node.id === `parking-${String(index + 1).padStart(2, '0')}`) ??
      scenario.layout.nodes.find((node) => node.type === 'parking') ??
      scenario.layout.nodes[0]!;
    return {
      id: `SH-${String(index + 1).padStart(2, '0')}`,
      nodeId: parking.id,
      busySec: 0,
      travelSec: 0,
      handlingSec: 0,
      resourceWaitSec: 0,
      tasks: 0,
      inboundTasks: 0,
      outboundTasks: 0
    };
  });
  const freeShuttleIds = new Set(shuttles.map((shuttle) => shuttle.id));
  const shuttleById = new Map(shuttles.map((shuttle) => [shuttle.id, shuttle]));

  let eventId = 0;
  const events = new EventQueue();
  const pushEvent = (event: Omit<DesEvent, 'id'>): void => {
    events.push({ ...event, id: eventId });
    eventId += 1;
  };

  let nextInboundRegion = 0;
  let nextOutboundRegion = 0;
  const inboundIntervalSec = intervalForRate(scenario.taskGeneration.inboundRatePerHour);
  const outboundIntervalSec = intervalForRate(scenario.taskGeneration.outboundRatePerHour);
  if (Number.isFinite(inboundIntervalSec)) {
    pushEvent({ type: 'inbound-arrival', timeSec: 0, regionIndex: nextInboundRegion });
  }
  if (Number.isFinite(outboundIntervalSec)) {
    pushEvent({ type: 'outbound-arrival', timeSec: outboundIntervalSec / 2, regionIndex: nextOutboundRegion });
  }

  const queuedTasks: DesTask[] = [];
  const activeTasks = new Set<string>();
  const liftReservations = new Map<string, number>();
  const bottlenecks: Record<string, number> = {};
  const anomalyMarkers: HeadlessDesResult['anomalyMarkers'] = [];
  const anomalyKeys = new Set<string>();
  const samples: HeadlessDesSample[] = [];
  let nextSampleSec = 0;
  let taskSequence = 0;
  let processedEvents = 0;
  let generatedInbound = 0;
  let generatedOutbound = 0;
  let acceptedInbound = 0;
  let acceptedOutbound = 0;
  let skippedInbound = 0;
  let skippedOutbound = 0;
  let completedInbound = 0;
  let completedOutbound = 0;
  let currentTimeSec = 0;

  const countBottleneck = (code: string, amount = 1): void => {
    bottlenecks[code] = (bottlenecks[code] ?? 0) + amount;
  };
  const markAnomaly = (code: string, detail: string): void => {
    if (anomalyKeys.has(code)) {
      return;
    }
    anomalyKeys.add(code);
    anomalyMarkers.push({ timeSec: round(currentTimeSec), code, detail });
  };
  const storedLoadCount = (): number => {
    let count = 0;
    for (const column of columns.values()) {
      for (const cell of column.cells) {
        if (cell.state === 'stored' || cell.state === 'reserved-outbound') {
          count += 1;
        }
      }
    }
    return count;
  };
  const pendingInboundTotal = (): number => 0;
  const pendingOutboundTotal = (): number => 0;
  const recordSamplesThrough = (timeSec: number): void => {
    while (nextSampleSec <= timeSec + 1e-9 && nextSampleSec <= durationSec + 1e-9) {
      const elapsedHours = Math.max(nextSampleSec / 3600, 1e-9);
      samples.push({
        timeSec: round(nextSampleSec),
        completedInbound,
        completedOutbound,
        inboundPph: round(completedInbound / elapsedHours, 3),
        outboundPph: round(completedOutbound / elapsedHours, 3),
        totalPph: round((completedInbound + completedOutbound) / elapsedHours, 3),
        queuedTasks: queuedTasks.length,
        pendingInboundDemand: pendingInboundTotal(),
        pendingOutboundDemand: pendingOutboundTotal(),
        storedLoads: storedLoadCount()
      });
      nextSampleSec += sampleIntervalSec;
    }
  };

  const refreshColumnModes = (): void => {
    for (const column of columns.values()) {
      const hasStoredOrOutboundReserved = column.cells.some((cell) => cell.state === 'stored' || cell.state === 'reserved-outbound');
      const hasInboundReserved = column.cells.some((cell) => cell.state === 'reserved-inbound');
      const hasEmpty = column.cells.some((cell) => cell.state === 'empty');
      if (column.mode === 'outbound' && !hasStoredOrOutboundReserved) {
        column.mode = 'inbound';
      } else if (column.mode === 'inbound' && !hasEmpty && !hasInboundReserved) {
        column.mode = 'outbound';
      }
    }
  };

  const allocateInboundTask = (regionIndex: number): DesTask | null => {
    refreshColumnModes();
    const column = [...columns.values()]
      .filter((candidate) => candidate.regionIndex === regionIndex && candidate.mode === 'inbound')
      .sort((left, right) => left.column - right.column)
      .find((candidate) => candidate.cells.some((cell) => cell.state === 'empty'));
    const cell = column?.cells.find((candidate) => candidate.state === 'empty');
    const lift = liftForRegion('inbound', regionIndex);
    if (!column || !cell || !lift) {
      return null;
    }
    cell.state = 'reserved-inbound';
    taskSequence += 1;
    return {
      id: `des-task-${String(taskSequence).padStart(8, '0')}`,
      kind: 'inbound',
      regionIndex,
      createdAtSec: currentTimeSec,
      pickupNodeId: lift.id,
      dropoffNodeId: cell.nodeId,
      liftNodeId: lift.id,
      storageNodeId: cell.nodeId,
      column: column.column,
      row: cell.row
    };
  };

  const allocateOutboundTask = (regionIndex: number): DesTask | null => {
    refreshColumnModes();
    const column = [...columns.values()]
      .filter((candidate) => candidate.regionIndex === regionIndex && candidate.mode === 'outbound')
      .sort((left, right) => left.column - right.column)
      .find((candidate) => candidate.cells.some((cell) => cell.state === 'stored'));
    const cell = column?.cells.find((candidate) => candidate.state === 'stored');
    const lift = liftForRegion('outbound', regionIndex);
    if (!column || !cell || !lift) {
      return null;
    }
    cell.state = 'reserved-outbound';
    taskSequence += 1;
    return {
      id: `des-task-${String(taskSequence).padStart(8, '0')}`,
      kind: 'outbound',
      regionIndex,
      createdAtSec: currentTimeSec,
      pickupNodeId: cell.nodeId,
      dropoffNodeId: lift.id,
      liftNodeId: lift.id,
      storageNodeId: cell.nodeId,
      column: column.column,
      row: cell.row
    };
  };

  const taskDurationForShuttle = (task: DesTask, shuttle: ShuttleResource): {
    completeSec: number;
    liftSlotReleaseSec: number;
    emptyTravelSec: number;
    loadedTravelSec: number;
    handlingSec: number;
    resourceWaitSec: number;
  } => {
    const emptyDistanceM = staticLayoutDistanceM(nodePositions, distanceCache, shuttle.nodeId, task.pickupNodeId);
    const loadedDistanceM = staticLayoutDistanceM(nodePositions, distanceCache, task.pickupNodeId, task.dropoffNodeId);
    const emptyTravelSec = travelTimeSec(emptyDistanceM, scenario.physicsParams.emptySpeedMps, scenario.physicsParams.accelerationMps2);
    const loadedTravelSec = travelTimeSec(loadedDistanceM, scenario.physicsParams.loadedSpeedMps, scenario.physicsParams.accelerationMps2);
    const lift = lifts.get(task.liftNodeId);
    const handlingSec = scenario.physicsParams.liftTimeSec + scenario.physicsParams.lowerTimeSec;
    if (!Number.isFinite(emptyTravelSec) || !Number.isFinite(loadedTravelSec) || !lift) {
      return { completeSec: Infinity, liftSlotReleaseSec: Infinity, emptyTravelSec: Infinity, loadedTravelSec: Infinity, handlingSec, resourceWaitSec: 0 };
    }

    if (task.kind === 'inbound') {
      const pickupReadySec = currentTimeSec + emptyTravelSec;
      const pickupStartSec = Math.max(pickupReadySec, lift.availableSec);
      const resourceWaitSec = pickupStartSec - pickupReadySec;
      const liftSlotReleaseSec = pickupStartSec + scenario.physicsParams.liftTimeSec;
      const completeSec = pickupStartSec + scenario.physicsParams.liftTimeSec + loadedTravelSec + scenario.physicsParams.lowerTimeSec;
      return { completeSec, liftSlotReleaseSec, emptyTravelSec, loadedTravelSec, handlingSec, resourceWaitSec };
    }

    const liftArrivalSec = currentTimeSec + emptyTravelSec + scenario.physicsParams.liftTimeSec + loadedTravelSec;
    const lowerStartSec = Math.max(liftArrivalSec, lift.availableSec);
    const resourceWaitSec = lowerStartSec - liftArrivalSec;
    const completeSec = lowerStartSec + scenario.physicsParams.lowerTimeSec;
    return { completeSec, liftSlotReleaseSec: completeSec, emptyTravelSec, loadedTravelSec, handlingSec, resourceWaitSec };
  };

  const liftReservationCount = (liftNodeId: string): number => liftReservations.get(liftNodeId) ?? 0;
  const reserveLiftSlot = (liftNodeId: string): void => {
    liftReservations.set(liftNodeId, liftReservationCount(liftNodeId) + 1);
  };
  const releaseLiftSlot = (liftNodeId: string): void => {
    const next = Math.max(0, liftReservationCount(liftNodeId) - 1);
    if (next === 0) {
      liftReservations.delete(liftNodeId);
    } else {
      liftReservations.set(liftNodeId, next);
    }
  };

  const skipDemand = (kind: DesTaskKind, code: string, amount = 1): void => {
    if (kind === 'inbound') {
      skippedInbound += amount;
    } else {
      skippedOutbound += amount;
    }
    countBottleneck(code, amount);
  };

  const tryAcceptDemand = (kind: DesTaskKind, regionIndex: number): void => {
    if (kind === 'inbound') {
      generatedInbound += 1;
    } else {
      generatedOutbound += 1;
    }

    const lift = liftForRegion(kind, regionIndex);
    if (!lift) {
      skipDemand(kind, `${kind}-lift-unavailable:r${regionIndex + 1}`);
      markAnomaly(`${kind}-lift-unavailable`, `${kind} has no lift for region ${regionIndex + 1}.`);
      return;
    }
    if (queuedTasks.length >= maxQueuedTasks) {
      skipDemand(kind, 'task-queue-cap');
      markAnomaly('task-queue-cap', `Task queue reached ${maxQueuedTasks}; new demand ticks are skipped, not backlogged.`);
      return;
    }
    if (liftReservationCount(lift.id) >= liftBufferCapacity) {
      skipDemand(kind, `${kind}-lift-buffer-full:r${regionIndex + 1}`);
      return;
    }

    const task = kind === 'inbound' ? allocateInboundTask(regionIndex) : allocateOutboundTask(regionIndex);
    if (!task) {
      const code = kind === 'inbound'
        ? `inbound-storage-unavailable:r${regionIndex + 1}`
        : `outbound-inventory-unavailable:r${regionIndex + 1}`;
      skipDemand(kind, code);
      return;
    }

    reserveLiftSlot(task.liftNodeId);
    if (kind === 'inbound') {
      acceptedInbound += 1;
    } else {
      acceptedOutbound += 1;
    }
    queuedTasks.push(task);
  };

  const dispatchQueuedTasks = (): void => {
    while (queuedTasks.length > 0 && freeShuttleIds.size > 0) {
      let bestTaskIndex = -1;
      let bestShuttle: ShuttleResource | null = null;
      let bestTiming: ReturnType<typeof taskDurationForShuttle> | null = null;
      let bestCompleteSec = Infinity;
      const freeShuttles = [...freeShuttleIds].map((id) => shuttleById.get(id)!).filter(Boolean);
      for (let taskIndex = 0; taskIndex < queuedTasks.length; taskIndex += 1) {
        const task = queuedTasks[taskIndex]!;
        for (const shuttle of freeShuttles) {
          const timing = taskDurationForShuttle(task, shuttle);
          if (timing.completeSec < bestCompleteSec) {
            bestTaskIndex = taskIndex;
            bestShuttle = shuttle;
            bestTiming = timing;
            bestCompleteSec = timing.completeSec;
          }
        }
      }
      if (bestTaskIndex < 0 || !bestShuttle || !bestTiming || !Number.isFinite(bestTiming.completeSec)) {
        countBottleneck('route-unavailable');
        markAnomaly('route-unavailable', 'A queued DES task has no static path in the current layout graph.');
        return;
      }

      const [task] = queuedTasks.splice(bestTaskIndex, 1);
      if (!task) {
        return;
      }
      const lift = lifts.get(task.liftNodeId)!;
      if (task.kind === 'inbound') {
        const pickupReadySec = currentTimeSec + bestTiming.emptyTravelSec;
        const pickupStartSec = Math.max(pickupReadySec, lift.availableSec);
        lift.availableSec = pickupStartSec + scenario.physicsParams.liftTimeSec;
        lift.busySec += scenario.physicsParams.liftTimeSec;
        pushEvent({ type: 'lift-slot-release', timeSec: bestTiming.liftSlotReleaseSec, liftNodeId: task.liftNodeId });
      } else {
        const liftArrivalSec = currentTimeSec + bestTiming.emptyTravelSec + scenario.physicsParams.liftTimeSec + bestTiming.loadedTravelSec;
        const lowerStartSec = Math.max(liftArrivalSec, lift.availableSec);
        lift.availableSec = lowerStartSec + scenario.physicsParams.lowerTimeSec;
        lift.busySec += scenario.physicsParams.lowerTimeSec;
      }
      const taskBusySec = Math.max(0, bestTiming.completeSec - currentTimeSec);
      const observedBusySec = Math.max(0, Math.min(bestTiming.completeSec, durationSec) - currentTimeSec);
      const observedRatio = taskBusySec > 1e-9 ? Math.min(1, observedBusySec / taskBusySec) : 0;
      bestShuttle.busySec += observedBusySec;
      bestShuttle.travelSec += (bestTiming.emptyTravelSec + bestTiming.loadedTravelSec) * observedRatio;
      bestShuttle.handlingSec += bestTiming.handlingSec * observedRatio;
      bestShuttle.resourceWaitSec += bestTiming.resourceWaitSec * observedRatio;
      bestShuttle.tasks += 1;
      if (task.kind === 'inbound') {
        bestShuttle.inboundTasks += 1;
      } else {
        bestShuttle.outboundTasks += 1;
      }
      activeTasks.add(task.id);
      freeShuttleIds.delete(bestShuttle.id);
      pushEvent({ type: 'task-complete', timeSec: bestTiming.completeSec, task: { ...task, id: `${task.id}:${bestShuttle.id}` } });
    }
  };

  const completeTask = (taskWithShuttle: DesTask): void => {
    const [taskId, shuttleId] = taskWithShuttle.id.split(':');
    const shuttle = shuttleId ? shuttleById.get(shuttleId) : null;
    if (taskId) {
      activeTasks.delete(taskId);
    }
    if (shuttle) {
      shuttle.nodeId = taskWithShuttle.dropoffNodeId;
      freeShuttleIds.add(shuttle.id);
    }
    const column = columns.get(taskWithShuttle.column);
    const cell = column?.cells.find((candidate) => candidate.nodeId === taskWithShuttle.storageNodeId);
    if (cell) {
      cell.state = taskWithShuttle.kind === 'inbound' ? 'stored' : 'empty';
    }
    const lift = lifts.get(taskWithShuttle.liftNodeId);
    if (lift) {
      lift.completed += 1;
    }
    if (taskWithShuttle.kind === 'inbound') {
      completedInbound += 1;
    } else {
      releaseLiftSlot(taskWithShuttle.liftNodeId);
      completedOutbound += 1;
    }
    refreshColumnModes();
  };

  const scheduleNextArrival = (kind: DesTaskKind, regionIndex: number): void => {
    if (kind === 'inbound') {
      if (Number.isFinite(inboundIntervalSec)) {
        nextInboundRegion = (regionIndex + 1) % regionCount;
        pushEvent({ type: 'inbound-arrival', timeSec: currentTimeSec + inboundIntervalSec, regionIndex: nextInboundRegion });
      }
    } else {
      if (Number.isFinite(outboundIntervalSec)) {
        nextOutboundRegion = (regionIndex + 1) % regionCount;
        pushEvent({ type: 'outbound-arrival', timeSec: currentTimeSec + outboundIntervalSec, regionIndex: nextOutboundRegion });
      }
    }
  };

  recordSamplesThrough(0);
  while (events.size > 0) {
    const event = events.pop()!;
    if (event.timeSec > durationSec + 1e-9) {
      break;
    }
    currentTimeSec = event.timeSec;
    recordSamplesThrough(currentTimeSec);
    processedEvents += 1;

    if (event.type === 'inbound-arrival') {
      tryAcceptDemand('inbound', event.regionIndex ?? 0);
      scheduleNextArrival('inbound', event.regionIndex ?? 0);
    } else if (event.type === 'outbound-arrival') {
      tryAcceptDemand('outbound', event.regionIndex ?? 0);
      scheduleNextArrival('outbound', event.regionIndex ?? 0);
    } else if (event.type === 'lift-slot-release' && event.liftNodeId) {
      releaseLiftSlot(event.liftNodeId);
    } else if (event.type === 'task-complete' && event.task) {
      completeTask(event.task);
    }

    dispatchQueuedTasks();
  }
  currentTimeSec = durationSec;
  recordSamplesThrough(durationSec);

  const elapsedHours = Math.max(durationSec / 3600, 1e-9);
  const shuttleUtilization = Object.fromEntries(shuttles.map((shuttle) => [shuttle.id, {
    busy: round(Math.min(1, shuttle.busySec / Math.max(durationSec, 1)), 4),
    travel: round(shuttle.travelSec / Math.max(durationSec, 1), 4),
    handling: round(shuttle.handlingSec / Math.max(durationSec, 1), 4),
    resourceWait: round(shuttle.resourceWaitSec / Math.max(durationSec, 1), 4),
    tasks: shuttle.tasks,
    inboundTasks: shuttle.inboundTasks,
    outboundTasks: shuttle.outboundTasks
  }]));
  const liftPph = Object.fromEntries([...lifts.values()].sort((left, right) => left.id.localeCompare(right.id)).map((lift) => [lift.id, {
    kind: lift.kind,
    completed: lift.completed,
    pph: round(lift.completed / elapsedHours, 3),
    utilization: round(Math.min(1, lift.busySec / Math.max(durationSec, 1)), 4)
  }]));
  const finalStoredLoads = storedLoadCount();

  return {
    schemaVersion: 'shuttle.headlessDes.v1',
    scenarioId: scenario.id,
    durationSec,
    finalSimTimeSec: durationSec,
    wallClockMs: Date.now() - startedAtMs,
    processedEvents,
    generatedInbound,
    generatedOutbound,
    acceptedInbound,
    acceptedOutbound,
    skippedInbound,
    skippedOutbound,
    completedInbound,
    completedOutbound,
    inboundPph: round(completedInbound / elapsedHours, 3),
    outboundPph: round(completedOutbound / elapsedHours, 3),
    totalPph: round((completedInbound + completedOutbound) / elapsedHours, 3),
    queuedTasks: queuedTasks.length,
    activeTasks: activeTasks.size,
    pendingInboundDemand: pendingInboundTotal(),
    pendingOutboundDemand: pendingOutboundTotal(),
    storedLoads: finalStoredLoads,
    storageCapacity: storageCells.length,
    storageUtilization: round(finalStoredLoads / Math.max(1, storageCells.length), 4),
    averageShuttleUtilization: round(shuttles.reduce((sum, shuttle) => sum + Math.min(1, shuttle.busySec / Math.max(durationSec, 1)), 0) / Math.max(1, shuttles.length), 4),
    shuttleUtilization,
    liftPph,
    bottlenecks,
    anomalyMarkers,
    samples
  };
}
