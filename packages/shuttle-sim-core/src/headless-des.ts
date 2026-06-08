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

type DesIssueSeverity = 'critical' | 'warning' | 'observation';

type DesIssue = {
  id: string;
  severity: DesIssueSeverity;
  title: string;
  metric: string;
  detail: string;
  recommendation: string;
};

type WaitInterval = {
  shuttleId: string;
  taskId: string;
  reason: 'lift-resource-wait' | 'traffic-reservation-wait';
  resourceId?: string | null;
  startSec: number;
  endSec: number;
};

type ShuttleResource = {
  id: string;
  nodeId: string;
  busySec: number;
  travelSec: number;
  handlingSec: number;
  resourceWaitSec: number;
  liftWaitSec: number;
  trafficWaitSec: number;
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

type YellowGraph = {
  drivableNodeIds: Set<string>;
  adjacency: Map<string, Array<{ to: string; lengthM: number; edgeId: string }>>;
  serviceNodeByNodeId: Map<string, string>;
  routeCache: Map<string, YellowRoute>;
  routeUnavailableCount: number;
};

type YellowRoute = {
  nodeIds: string[];
  segments: Array<{
    from: string;
    to: string;
    edgeId: string;
    lengthM: number;
  }>;
  distanceM: number;
};

type RouteTiming = {
  distanceM: number;
  travelSec: number;
  trafficWaitSec: number;
  endSec: number;
  nodeIds: string[];
  waitIntervals: Array<{
    resourceId: string;
    startSec: number;
    endSec: number;
  }>;
  windows: number;
};

type TaskTiming = {
  completeSec: number;
  liftSlotReleaseSec: number;
  emptyTravelSec: number;
  loadedTravelSec: number;
  handlingSec: number;
  liftWaitSec: number;
  trafficWaitSec: number;
  emptyRoute: RouteTiming;
  loadedRoute: RouteTiming;
};

export type HeadlessDesReplayPhase = {
  kind: 'empty-travel' | 'loaded-travel' | 'traffic-wait' | 'lift-wait' | 'lift-handle' | 'lower-handle';
  startSec: number;
  endSec: number;
  resourceId?: string;
};

export type HeadlessDesTaskTrace = {
  taskId: string;
  shuttleId: string;
  kind: DesTaskKind;
  regionIndex: number;
  createdAtSec: number;
  dispatchSec: number;
  completeSec: number;
  pickupNodeId: string;
  dropoffNodeId: string;
  storageNodeId: string;
  liftNodeId: string;
  emptyRouteNodeIds: string[];
  loadedRouteNodeIds: string[];
  emptyTravelSec: number;
  loadedTravelSec: number;
  liftWaitSec: number;
  trafficWaitSec: number;
  handlingSec: number;
  phases: HeadlessDesReplayPhase[];
};

export type HeadlessDesReservationReplay = {
  taskTraceLimit: number;
  tracedTaskCount: number;
  omittedTaskCount: number;
  tasks: HeadlessDesTaskTrace[];
  topWaitIntervals: Array<{
    shuttleId: string;
    taskId: string;
    reason: WaitInterval['reason'];
    resourceId: string | null;
    startSec: number;
    endSec: number;
    waitSec: number;
  }>;
};

export type HeadlessDesOptions = {
  scenario?: ShuttleScenario;
  durationSec?: number;
  sampleIntervalSec?: number;
  maxQueuedTasks?: number;
  liftBufferCapacity?: number;
  maxActiveTasks?: number;
  traceTaskLimit?: number;
};

export type HeadlessDesSample = {
  timeSec: number;
  completedInbound: number;
  completedOutbound: number;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  windowTotalPph: number;
  waitingVehicles: number;
  queuedTaskAgeMaxSec: number;
  maxContinuousWaitingSec: number;
  averageWaitingPct: number;
  averageRepositionPct: number;
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
  averageWaitingPct: number;
  averageRepositionPct: number;
  maxContinuousWaitingSec: number;
  maxQueuedTaskAgeSec: number;
  sustainedCongestionWindows: number;
  controlPolicy: {
    maxActiveTasks: number;
    backpressureHoldCount: number;
  };
  repositionBreakdown: Record<string, {
    seconds: number;
    pct: number;
  }>;
  waitReasonBreakdown: Record<string, {
    seconds: number;
    pct: number;
  }>;
  trafficBottlenecks: Array<{
    resourceId: string;
    waitSec: number;
    waitCount: number;
  }>;
  routeModel: {
    kind: 'yellow-graph-reservation-window';
    drivableNodeCount: number;
    drivableEdgeCount: number;
    mappedServiceNodeCount: number;
    routeUnavailableCount: number;
    reservationResourceCount: number;
    reservationWindowCount: number;
    trafficWaitSec: number;
  };
  shuttleUtilization: Record<string, {
    busy: number;
    travel: number;
    handling: number;
    resourceWait: number;
    liftWait: number;
    trafficWait: number;
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
  issues: DesIssue[];
  anomalyMarkers: Array<{
    timeSec: number;
    code: string;
    detail: string;
  }>;
  reservationReplay: HeadlessDesReservationReplay;
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

function isYellowGridNodeId(nodeId: string): boolean {
  return (
    /^storage-r\d+-c\d+$/.test(nodeId) ||
    /^(?:left|right)-row-\d+$/.test(nodeId) ||
    /^column-(?:(?:top|bottom)-[ab]|middle)-c\d+$/.test(nodeId) ||
    /^(?:module-\d+|module-boundary-\d+)-spine-(?:top|bottom)-[ab]$/.test(nodeId) ||
    /^(?:module-\d+|module-boundary-\d+)-spine-middle$/.test(nodeId)
  );
}

function isAxisAlignedNodePair(
  nodePositions: Map<string, { x: number; z: number }>,
  fromNodeId: string,
  toNodeId: string
): boolean {
  const from = nodePositions.get(fromNodeId);
  const to = nodePositions.get(toNodeId);
  return Boolean(from && to && (Math.abs(from.x - to.x) < 1e-6 || Math.abs(from.z - to.z) < 1e-6));
}

function createYellowGraph(scenario: ShuttleScenario): YellowGraph {
  const nodePositions = new Map(scenario.layout.nodes.map((node) => [node.id, { x: node.x, z: node.z }]));
  const drivableNodeIds = new Set(scenario.layout.nodes.filter((node) => isYellowGridNodeId(node.id)).map((node) => node.id));
  const adjacency = new Map<string, Array<{ to: string; lengthM: number; edgeId: string }>>();
  const serviceNodeByNodeId = new Map<string, string>();

  const addArc = (from: string, to: string, lengthM: number, edgeId: string): void => {
    const arcs = adjacency.get(from) ?? [];
    arcs.push({ to, lengthM, edgeId });
    adjacency.set(from, arcs);
  };

  for (const edge of scenario.layout.edges) {
    if (!drivableNodeIds.has(edge.from) || !drivableNodeIds.has(edge.to) || !isAxisAlignedNodePair(nodePositions, edge.from, edge.to)) {
      continue;
    }
    addArc(edge.from, edge.to, edge.lengthM, edge.id);
    if (edge.directionMode === 'twoWay') {
      addArc(edge.to, edge.from, edge.lengthM, edge.id);
    }
  }

  for (const node of scenario.layout.nodes) {
    if (drivableNodeIds.has(node.id)) {
      serviceNodeByNodeId.set(node.id, node.id);
      continue;
    }
    const topLiftMatch = /^lift-(\d{2})-(inbound|outbound)$/.exec(node.id);
    if (topLiftMatch) {
      const moduleNodeId = `module-${topLiftMatch[1]}-spine-${topLiftMatch[2] === 'inbound' ? 'top-a' : 'bottom-b'}`;
      if (drivableNodeIds.has(moduleNodeId)) {
        serviceNodeByNodeId.set(node.id, moduleNodeId);
        continue;
      }
    }
    const connectedYellowNodeId = scenario.layout.edges
      .flatMap((edge) => edge.from === node.id ? [edge.to] : edge.to === node.id ? [edge.from] : [])
      .find((nodeId) => drivableNodeIds.has(nodeId) && isAxisAlignedNodePair(nodePositions, node.id, nodeId));
    if (connectedYellowNodeId) {
      serviceNodeByNodeId.set(node.id, connectedYellowNodeId);
      continue;
    }
    const nearestYellowNode = [...drivableNodeIds]
      .map((nodeId) => {
        const candidate = nodePositions.get(nodeId)!;
        return { nodeId, distanceM: Math.abs(candidate.x - node.x) + Math.abs(candidate.z - node.z) };
      })
      .sort((left, right) => left.distanceM - right.distanceM || left.nodeId.localeCompare(right.nodeId))[0];
    if (nearestYellowNode) {
      serviceNodeByNodeId.set(node.id, nearestYellowNode.nodeId);
    }
  }

  return {
    drivableNodeIds,
    adjacency,
    serviceNodeByNodeId,
    routeCache: new Map(),
    routeUnavailableCount: 0
  };
}

function yellowGraphRoute(graph: YellowGraph, fromNodeId: string, toNodeId: string): YellowRoute {
  const fromServiceNodeId = graph.serviceNodeByNodeId.get(fromNodeId);
  const toServiceNodeId = graph.serviceNodeByNodeId.get(toNodeId);
  if (!fromServiceNodeId || !toServiceNodeId) {
    graph.routeUnavailableCount += 1;
    return emptyUnavailableRoute();
  }
  if (fromServiceNodeId === toServiceNodeId) {
    return { nodeIds: [fromServiceNodeId], segments: [], distanceM: 0 };
  }
  const key = `${fromServiceNodeId}>${toServiceNodeId}`;
  const cached = graph.routeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const route = shortestYellowGraphRoute(graph, fromServiceNodeId, toServiceNodeId);
  graph.routeCache.set(key, route);
  if (!Number.isFinite(route.distanceM)) {
    graph.routeUnavailableCount += 1;
  }
  return route;
}

function emptyUnavailableRoute(): YellowRoute {
  return { nodeIds: [], segments: [], distanceM: Infinity };
}

function shortestYellowGraphRoute(graph: YellowGraph, fromNodeId: string, toNodeId: string): YellowRoute {
  if (fromNodeId === toNodeId) {
    return { nodeIds: [fromNodeId], segments: [], distanceM: 0 };
  }
  const distances = new Map<string, number>([[fromNodeId, 0]]);
  const previous = new Map<string, { nodeId: string; edgeId: string; lengthM: number }>();
  const visited = new Set<string>();
  while (true) {
    let currentNodeId: string | null = null;
    let currentDistance = Infinity;
    for (const [nodeId, distance] of distances) {
      if (!visited.has(nodeId) && distance < currentDistance) {
        currentNodeId = nodeId;
        currentDistance = distance;
      }
    }
    if (!currentNodeId) {
      return emptyUnavailableRoute();
    }
    if (currentNodeId === toNodeId) {
      const nodeIds = [toNodeId];
      const segments: YellowRoute['segments'] = [];
      let cursor = toNodeId;
      while (cursor !== fromNodeId) {
        const step = previous.get(cursor);
        if (!step) {
          return emptyUnavailableRoute();
        }
        segments.push({
          from: step.nodeId,
          to: cursor,
          edgeId: step.edgeId,
          lengthM: step.lengthM
        });
        cursor = step.nodeId;
        nodeIds.push(cursor);
      }
      nodeIds.reverse();
      segments.reverse();
      return { nodeIds, segments, distanceM: currentDistance };
    }
    visited.add(currentNodeId);
    for (const edge of graph.adjacency.get(currentNodeId) ?? []) {
      const nextDistance = currentDistance + edge.lengthM;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, {
          nodeId: currentNodeId,
          edgeId: edge.edgeId,
          lengthM: edge.lengthM
        });
      }
    }
  }
}

function inferRegionIndexFromLiftId(liftNodeId: string): number {
  const match = /^lift-(\d+)-/.exec(liftNodeId);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

function routeReservationTiming(input: {
  graph: YellowGraph;
  resourceAvailableSec: Map<string, number>;
  fromNodeId: string;
  toNodeId: string;
  startSec: number;
  speedMps: number;
  accelerationMps2: number;
  clearanceSec: number;
  commit: boolean;
}): RouteTiming {
  const route = yellowGraphRoute(input.graph, input.fromNodeId, input.toNodeId);
  if (!Number.isFinite(route.distanceM)) {
    return {
      distanceM: Infinity,
      travelSec: Infinity,
      trafficWaitSec: 0,
      endSec: Infinity,
      nodeIds: [],
      waitIntervals: [],
      windows: 0
    };
  }
  if (route.segments.length === 0 || route.distanceM <= 1e-9) {
    return {
      distanceM: route.distanceM,
      travelSec: 0,
      trafficWaitSec: 0,
      endSec: input.startSec,
      nodeIds: route.nodeIds,
      waitIntervals: [],
      windows: 0
    };
  }

  const travelSec = travelTimeSec(route.distanceM, input.speedMps, input.accelerationMps2);
  let cursorSec = input.startSec;
  let trafficWaitSec = 0;
  let windows = 0;
  const waitIntervals: RouteTiming['waitIntervals'] = [];
  const plannedWindows: Array<{ resourceId: string; endSec: number }> = [];

  for (const segment of route.segments) {
    const traversalSec = Math.max(0.001, travelSec * (segment.lengthM / route.distanceM));
    const resourceIds = [
      `edge:${segment.edgeId}`,
      `node:${segment.to}`
    ];
    const availableSec = Math.max(
      cursorSec,
      ...resourceIds.map((resourceId) => input.resourceAvailableSec.get(resourceId) ?? 0)
    );
    if (availableSec > cursorSec + 1e-9) {
      const blockingResourceId = resourceIds
        .filter((resourceId) => Math.abs((input.resourceAvailableSec.get(resourceId) ?? 0) - availableSec) <= 1e-9)
        .sort()[0] ?? resourceIds[0]!;
      waitIntervals.push({ resourceId: blockingResourceId, startSec: cursorSec, endSec: availableSec });
      trafficWaitSec += availableSec - cursorSec;
      cursorSec = availableSec;
    }

    const windowEndSec = cursorSec + traversalSec + input.clearanceSec;
    for (const resourceId of resourceIds) {
      plannedWindows.push({ resourceId, endSec: windowEndSec });
    }
    windows += resourceIds.length;
    cursorSec += traversalSec;
  }

  if (input.commit) {
    for (const window of plannedWindows) {
      input.resourceAvailableSec.set(
        window.resourceId,
        Math.max(input.resourceAvailableSec.get(window.resourceId) ?? 0, window.endSec)
      );
    }
  }

  return {
    distanceM: route.distanceM,
    travelSec,
    trafficWaitSec,
    endSec: cursorSec,
    nodeIds: route.nodeIds,
    waitIntervals,
    windows
  };
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
  const maxActiveTasks = Math.max(1, Math.round(options.maxActiveTasks ?? scenario.vehicles.count));
  const traceTaskLimit = Math.max(0, Math.round(options.traceTaskLimit ?? 120));
  const yellowGraph = createYellowGraph(scenario);

  const storageCells = scenario.layout.nodes
    .map((node) => ({ node, position: parseStoragePosition(node.id) }))
    .filter((entry): entry is { node: ShuttleScenario['layout']['nodes'][number]; position: { row: number; column: number } } =>
      entry.node.type === 'storage' && entry.position !== null
    );
  const totalColumns = Math.max(0, ...storageCells.map((entry) => entry.position.column));
  const inboundLifts = scenario.layout.nodes
    .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'inbound')
    .sort((left, right) => left.id.localeCompare(right.id));
  const outboundLifts = scenario.layout.nodes
    .filter((node) => node.type === 'lift-blackbox' && node.liftKind === 'outbound')
    .sort((left, right) => left.id.localeCompare(right.id));
  const regionCount = Math.max(1, inboundLifts.length, outboundLifts.length);
  const columnsPerRegion = Math.max(1, Math.ceil(totalColumns / regionCount));
  const regionForColumn = (column: number): number => Math.min(regionCount - 1, Math.max(0, Math.floor((column - 1) / columnsPerRegion)));
  const zoneColumnSpan = Math.max(1, Math.ceil(totalColumns / 2));
  const zoneStoredColumnCount = Math.floor(zoneColumnSpan / 2);
  const initialCellIsStored = (position: { row: number; column: number }): boolean => {
    if (scenario.taskGeneration.initialStorageFillPolicy === 'zone-balanced-50') {
      const zoneColumnOffset = (position.column - 1) % zoneColumnSpan;
      return zoneColumnOffset < zoneStoredColumnCount;
    }
    return position.column <= scenario.taskGeneration.initialOutboundFullColumns;
  };
  const initialColumnMode = (column: number): ColumnMode => {
    if (scenario.taskGeneration.initialStorageFillPolicy === 'zone-balanced-50') {
      const zoneColumnOffset = (column - 1) % zoneColumnSpan;
      return zoneColumnOffset < zoneStoredColumnCount ? 'outbound' : 'inbound';
    }
    return column <= scenario.taskGeneration.initialOutboundFullColumns ? 'outbound' : 'inbound';
  };

  const columns = new Map<number, StorageColumn>();
  for (let column = 1; column <= totalColumns; column += 1) {
    columns.set(column, {
      column,
      regionIndex: regionForColumn(column),
      mode: initialColumnMode(column),
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
      state: initialCellIsStored(entry.position) ? 'stored' : 'empty'
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
      liftWaitSec: 0,
      trafficWaitSec: 0,
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
  const reservationResourceAvailableSec = new Map<string, number>();
  const bottlenecks: Record<string, number> = {};
  const completionTimes: Array<{ timeSec: number; kind: DesTaskKind }> = [];
  const waitIntervals: WaitInterval[] = [];
  const queuedTaskWaitSecById = new Map<string, number>();
  const repositionBreakdownSec: Record<string, number> = { 'to-task-pickup': 0 };
  const waitReasonBreakdownSec: Record<string, number> = { 'lift-resource-wait': 0, 'traffic-reservation-wait': 0 };
  const trafficWaitByResourceSec = new Map<string, number>();
  const trafficWaitCountByResource = new Map<string, number>();
  const taskTraces: HeadlessDesTaskTrace[] = [];
  const anomalyMarkers: HeadlessDesResult['anomalyMarkers'] = [];
  const anomalyKeys = new Set<string>();
  const samples: HeadlessDesSample[] = [];
  const sustainedCongestionSamples: HeadlessDesSample[] = [];
  let reservationWindowCount = 0;
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
  let backpressureHoldCount = 0;

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
      const windowStartSec = Math.max(0, nextSampleSec - sampleIntervalSec);
      const windowHours = Math.max((nextSampleSec - windowStartSec) / 3600, 1e-9);
      const windowCompleted = nextSampleSec <= 1e-9
        ? 0
        : completionTimes.filter((completion) =>
          completion.timeSec > windowStartSec + 1e-9 &&
          completion.timeSec <= nextSampleSec + 1e-9
        ).length;
      const waitingNow = waitIntervals.filter((interval) =>
        interval.startSec <= nextSampleSec + 1e-9 &&
        interval.endSec > nextSampleSec + 1e-9
      );
      const completedWaitMax = waitIntervals.reduce((max, interval) => Math.max(max, interval.endSec - interval.startSec), 0);
      const activeWaitMax = waitingNow.reduce((max, interval) => Math.max(max, nextSampleSec - interval.startSec), 0);
      const queuedTaskAgeMaxSec = queuedTasks.reduce((max, task) => Math.max(max, nextSampleSec - task.createdAtSec), 0);
      const cumulativeWaitingSec = shuttles.reduce((sum, shuttle) => sum + shuttle.resourceWaitSec, 0);
      const cumulativeRepositionSec = Object.values(repositionBreakdownSec).reduce((sum, value) => sum + value, 0);
      const denominator = Math.max(1, nextSampleSec * Math.max(1, shuttles.length));
      samples.push({
        timeSec: round(nextSampleSec),
        completedInbound,
        completedOutbound,
        inboundPph: round(completedInbound / elapsedHours, 3),
        outboundPph: round(completedOutbound / elapsedHours, 3),
        totalPph: round((completedInbound + completedOutbound) / elapsedHours, 3),
        windowTotalPph: round(windowCompleted / windowHours, 3),
        waitingVehicles: waitingNow.length,
        queuedTaskAgeMaxSec: round(queuedTaskAgeMaxSec, 3),
        maxContinuousWaitingSec: round(Math.max(completedWaitMax, activeWaitMax), 3),
        averageWaitingPct: round(cumulativeWaitingSec / denominator * 100, 3),
        averageRepositionPct: round(cumulativeRepositionSec / denominator * 100, 3),
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

  const routeHotspotPenaltySec = (route: YellowRoute): number => {
    return route.segments.reduce((sum, segment) => {
      const edgeWait = trafficWaitByResourceSec.get(`edge:${segment.edgeId}`) ?? 0;
      const nodeWait = trafficWaitByResourceSec.get(`node:${segment.to}`) ?? 0;
      return sum + (edgeWait + nodeWait) * 0.025;
    }, 0);
  };

  const storageCandidateScore = (input: {
    kind: DesTaskKind;
    liftNodeId: string;
    cell: StorageCell;
    column: StorageColumn;
  }): number => {
    const route = input.kind === 'inbound'
      ? yellowGraphRoute(yellowGraph, input.liftNodeId, input.cell.nodeId)
      : yellowGraphRoute(yellowGraph, input.cell.nodeId, input.liftNodeId);
    if (!Number.isFinite(route.distanceM)) {
      return Infinity;
    }
    const timing = routeReservationTiming({
      graph: yellowGraph,
      resourceAvailableSec: reservationResourceAvailableSec,
      fromNodeId: input.kind === 'inbound' ? input.liftNodeId : input.cell.nodeId,
      toNodeId: input.kind === 'inbound' ? input.cell.nodeId : input.liftNodeId,
      startSec: currentTimeSec + scenario.physicsParams.liftTimeSec,
      speedMps: scenario.physicsParams.loadedSpeedMps,
      accelerationMps2: scenario.physicsParams.accelerationMps2,
      clearanceSec: scenario.physicsParams.reservationClearanceSec,
      commit: false
    });
    const columnPressure = input.column.cells.filter((cell) =>
      cell.state === 'reserved-inbound' || cell.state === 'reserved-outbound'
    ).length * 12;
    const laneBalancePenalty = input.kind === 'inbound'
      ? input.cell.row <= 2 || input.cell.row >= 13 ? 4 : 0
      : input.cell.row <= 2 || input.cell.row >= 13 ? 0 : 2;
    return route.distanceM +
      timing.trafficWaitSec * 4 +
      routeHotspotPenaltySec(route) +
      columnPressure +
      laneBalancePenalty;
  };

  const selectStorageCandidate = (
    kind: DesTaskKind,
    regionIndex: number,
    lift: LiftResource
  ): { column: StorageColumn; cell: StorageCell } | null => {
    const candidates = [...columns.values()]
      .filter((candidate) => candidate.regionIndex === regionIndex && candidate.mode === (kind === 'inbound' ? 'inbound' : 'outbound'))
      .flatMap((column) => column.cells
        .filter((cell) => kind === 'inbound' ? cell.state === 'empty' : cell.state === 'stored')
        .map((cell) => ({ column, cell }))
      );
    if (candidates.length === 0) {
      return null;
    }
    if (scenario.taskGeneration.storageSelectionPolicy !== 'traffic-aware') {
      return candidates.sort((left, right) =>
        left.column.column - right.column.column ||
        (kind === 'inbound' ? right.cell.row - left.cell.row : right.cell.row - left.cell.row)
      )[0] ?? null;
    }
    return candidates
      .map((candidate) => ({
        ...candidate,
        score: storageCandidateScore({
          kind,
          liftNodeId: lift.id,
          cell: candidate.cell,
          column: candidate.column
        })
      }))
      .sort((left, right) =>
        left.score - right.score ||
        left.column.column - right.column.column ||
        right.cell.row - left.cell.row
      )[0] ?? null;
  };

  const allocateInboundTask = (regionIndex: number): DesTask | null => {
    refreshColumnModes();
    const lift = liftForRegion('inbound', regionIndex);
    const selection = lift ? selectStorageCandidate('inbound', regionIndex, lift) : null;
    if (!selection || !lift) {
      return null;
    }
    const { column, cell } = selection;
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
    const lift = liftForRegion('outbound', regionIndex);
    const selection = lift ? selectStorageCandidate('outbound', regionIndex, lift) : null;
    if (!selection || !lift) {
      return null;
    }
    const { column, cell } = selection;
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

  const taskDurationForShuttle = (task: DesTask, shuttle: ShuttleResource, commit = false): TaskTiming => {
    const emptyRoute = routeReservationTiming({
      graph: yellowGraph,
      resourceAvailableSec: reservationResourceAvailableSec,
      fromNodeId: shuttle.nodeId,
      toNodeId: task.pickupNodeId,
      startSec: currentTimeSec,
      speedMps: scenario.physicsParams.emptySpeedMps,
      accelerationMps2: scenario.physicsParams.accelerationMps2,
      clearanceSec: scenario.physicsParams.reservationClearanceSec,
      commit
    });
    const lift = lifts.get(task.liftNodeId);
    const handlingSec = scenario.physicsParams.liftTimeSec + scenario.physicsParams.lowerTimeSec;
    if (!Number.isFinite(emptyRoute.travelSec) || !lift) {
      return {
        completeSec: Infinity,
        liftSlotReleaseSec: Infinity,
        emptyTravelSec: Infinity,
        loadedTravelSec: Infinity,
        handlingSec,
        liftWaitSec: 0,
        trafficWaitSec: emptyRoute.trafficWaitSec,
        emptyRoute,
        loadedRoute: emptyRoute
      };
    }

    if (task.kind === 'inbound') {
      const pickupReadySec = emptyRoute.endSec;
      const pickupStartSec = Math.max(pickupReadySec, lift.availableSec);
      const liftWaitSec = pickupStartSec - pickupReadySec;
      const liftSlotReleaseSec = pickupStartSec + scenario.physicsParams.liftTimeSec;
      const loadedRoute = routeReservationTiming({
        graph: yellowGraph,
        resourceAvailableSec: reservationResourceAvailableSec,
        fromNodeId: task.pickupNodeId,
        toNodeId: task.dropoffNodeId,
        startSec: liftSlotReleaseSec,
        speedMps: scenario.physicsParams.loadedSpeedMps,
        accelerationMps2: scenario.physicsParams.accelerationMps2,
        clearanceSec: scenario.physicsParams.reservationClearanceSec,
        commit
      });
      const completeSec = loadedRoute.endSec + scenario.physicsParams.lowerTimeSec;
      if (commit) {
        reservationWindowCount += emptyRoute.windows + loadedRoute.windows;
      }
      return {
        completeSec,
        liftSlotReleaseSec,
        emptyTravelSec: emptyRoute.travelSec,
        loadedTravelSec: loadedRoute.travelSec,
        handlingSec,
        liftWaitSec,
        trafficWaitSec: emptyRoute.trafficWaitSec + loadedRoute.trafficWaitSec,
        emptyRoute,
        loadedRoute
      };
    }

    const loadedRoute = routeReservationTiming({
      graph: yellowGraph,
      resourceAvailableSec: reservationResourceAvailableSec,
      fromNodeId: task.pickupNodeId,
      toNodeId: task.dropoffNodeId,
      startSec: emptyRoute.endSec + scenario.physicsParams.liftTimeSec,
      speedMps: scenario.physicsParams.loadedSpeedMps,
      accelerationMps2: scenario.physicsParams.accelerationMps2,
      clearanceSec: scenario.physicsParams.reservationClearanceSec,
      commit
    });
    if (commit) {
      reservationWindowCount += emptyRoute.windows + loadedRoute.windows;
    }
    const liftArrivalSec = loadedRoute.endSec;
    const lowerStartSec = Math.max(liftArrivalSec, lift.availableSec);
    const liftWaitSec = lowerStartSec - liftArrivalSec;
    const completeSec = lowerStartSec + scenario.physicsParams.lowerTimeSec;
    return {
      completeSec,
      liftSlotReleaseSec: completeSec,
      emptyTravelSec: emptyRoute.travelSec,
      loadedTravelSec: loadedRoute.travelSec,
      handlingSec,
      liftWaitSec,
      trafficWaitSec: emptyRoute.trafficWaitSec + loadedRoute.trafficWaitSec,
      emptyRoute,
      loadedRoute
    };
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

  const buildReplayTrace = (
    task: DesTask,
    shuttle: ShuttleResource,
    timing: TaskTiming,
    liftWaitStartSec: number,
    liftWaitEndSec: number
  ): HeadlessDesTaskTrace => {
    const phases: HeadlessDesReplayPhase[] = [];
    const addPhase = (phase: HeadlessDesReplayPhase): void => {
      if (phase.endSec > phase.startSec + 1e-9) {
        phases.push({
          ...phase,
          startSec: round(phase.startSec, 3),
          endSec: round(phase.endSec, 3)
        });
      }
    };
    addPhase({ kind: 'empty-travel', startSec: currentTimeSec, endSec: timing.emptyRoute.endSec });
    for (const interval of timing.emptyRoute.waitIntervals) {
      addPhase({ kind: 'traffic-wait', startSec: interval.startSec, endSec: interval.endSec, resourceId: interval.resourceId });
    }
    if (task.kind === 'inbound') {
      addPhase({ kind: 'lift-wait', startSec: liftWaitStartSec, endSec: liftWaitEndSec, resourceId: task.liftNodeId });
      addPhase({ kind: 'lift-handle', startSec: liftWaitEndSec, endSec: timing.liftSlotReleaseSec, resourceId: task.liftNodeId });
      addPhase({ kind: 'loaded-travel', startSec: timing.liftSlotReleaseSec, endSec: timing.loadedRoute.endSec });
      for (const interval of timing.loadedRoute.waitIntervals) {
        addPhase({ kind: 'traffic-wait', startSec: interval.startSec, endSec: interval.endSec, resourceId: interval.resourceId });
      }
      addPhase({ kind: 'lower-handle', startSec: timing.loadedRoute.endSec, endSec: timing.completeSec, resourceId: task.storageNodeId });
    } else {
      const pickupHandleEndSec = timing.emptyRoute.endSec + scenario.physicsParams.liftTimeSec;
      addPhase({ kind: 'lift-handle', startSec: timing.emptyRoute.endSec, endSec: pickupHandleEndSec, resourceId: task.storageNodeId });
      addPhase({ kind: 'loaded-travel', startSec: pickupHandleEndSec, endSec: timing.loadedRoute.endSec });
      for (const interval of timing.loadedRoute.waitIntervals) {
        addPhase({ kind: 'traffic-wait', startSec: interval.startSec, endSec: interval.endSec, resourceId: interval.resourceId });
      }
      addPhase({ kind: 'lift-wait', startSec: liftWaitStartSec, endSec: liftWaitEndSec, resourceId: task.liftNodeId });
      addPhase({ kind: 'lower-handle', startSec: liftWaitEndSec, endSec: timing.completeSec, resourceId: task.liftNodeId });
    }

    phases.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec || left.kind.localeCompare(right.kind));
    return {
      taskId: task.id,
      shuttleId: shuttle.id,
      kind: task.kind,
      regionIndex: task.regionIndex,
      createdAtSec: round(task.createdAtSec, 3),
      dispatchSec: round(currentTimeSec, 3),
      completeSec: round(timing.completeSec, 3),
      pickupNodeId: task.pickupNodeId,
      dropoffNodeId: task.dropoffNodeId,
      storageNodeId: task.storageNodeId,
      liftNodeId: task.liftNodeId,
      emptyRouteNodeIds: timing.emptyRoute.nodeIds,
      loadedRouteNodeIds: timing.loadedRoute.nodeIds,
      emptyTravelSec: round(timing.emptyTravelSec, 3),
      loadedTravelSec: round(timing.loadedTravelSec, 3),
      liftWaitSec: round(timing.liftWaitSec, 3),
      trafficWaitSec: round(timing.trafficWaitSec, 3),
      handlingSec: round(timing.handlingSec, 3),
      phases
    };
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
      if (activeTasks.size >= maxActiveTasks) {
        backpressureHoldCount += 1;
        countBottleneck('active-task-backpressure');
        return;
      }
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
      const committedTiming = taskDurationForShuttle(task, bestShuttle, true);
      bestTiming = committedTiming;
      queuedTaskWaitSecById.set(task.id, currentTimeSec - task.createdAtSec);
      const lift = lifts.get(task.liftNodeId)!;
      let liftWaitStartSec = 0;
      let liftWaitEndSec = 0;
      if (task.kind === 'inbound') {
        const pickupReadySec = bestTiming.emptyRoute.endSec;
        const pickupStartSec = Math.max(pickupReadySec, lift.availableSec);
        liftWaitStartSec = pickupReadySec;
        liftWaitEndSec = pickupStartSec;
        lift.availableSec = pickupStartSec + scenario.physicsParams.liftTimeSec;
        lift.busySec += scenario.physicsParams.liftTimeSec;
        pushEvent({ type: 'lift-slot-release', timeSec: bestTiming.liftSlotReleaseSec, liftNodeId: task.liftNodeId });
      } else {
        const liftArrivalSec = bestTiming.loadedRoute.endSec;
        const lowerStartSec = Math.max(liftArrivalSec, lift.availableSec);
        liftWaitStartSec = liftArrivalSec;
        liftWaitEndSec = lowerStartSec;
        lift.availableSec = lowerStartSec + scenario.physicsParams.lowerTimeSec;
        lift.busySec += scenario.physicsParams.lowerTimeSec;
      }
      const taskBusySec = Math.max(0, bestTiming.completeSec - currentTimeSec);
      const observedBusySec = Math.max(0, Math.min(bestTiming.completeSec, durationSec) - currentTimeSec);
      const observedRatio = taskBusySec > 1e-9 ? Math.min(1, observedBusySec / taskBusySec) : 0;
      bestShuttle.busySec += observedBusySec;
      bestShuttle.travelSec += (bestTiming.emptyTravelSec + bestTiming.loadedTravelSec) * observedRatio;
      bestShuttle.handlingSec += bestTiming.handlingSec * observedRatio;
      bestShuttle.liftWaitSec += bestTiming.liftWaitSec * observedRatio;
      bestShuttle.trafficWaitSec += bestTiming.trafficWaitSec * observedRatio;
      bestShuttle.resourceWaitSec += (bestTiming.liftWaitSec + bestTiming.trafficWaitSec) * observedRatio;
      repositionBreakdownSec['to-task-pickup'] = round((repositionBreakdownSec['to-task-pickup'] ?? 0) + bestTiming.emptyTravelSec * observedRatio);
      waitReasonBreakdownSec['lift-resource-wait'] = round((waitReasonBreakdownSec['lift-resource-wait'] ?? 0) + bestTiming.liftWaitSec * observedRatio);
      waitReasonBreakdownSec['traffic-reservation-wait'] = round((waitReasonBreakdownSec['traffic-reservation-wait'] ?? 0) + bestTiming.trafficWaitSec * observedRatio);
      for (const interval of [...bestTiming.emptyRoute.waitIntervals, ...bestTiming.loadedRoute.waitIntervals]) {
        const waitSec = interval.endSec - interval.startSec;
        trafficWaitByResourceSec.set(interval.resourceId, (trafficWaitByResourceSec.get(interval.resourceId) ?? 0) + waitSec);
        trafficWaitCountByResource.set(interval.resourceId, (trafficWaitCountByResource.get(interval.resourceId) ?? 0) + 1);
        waitIntervals.push({
          shuttleId: bestShuttle.id,
          taskId: task.id,
          reason: 'traffic-reservation-wait',
          resourceId: interval.resourceId,
          startSec: interval.startSec,
          endSec: interval.endSec
        });
      }
      if (liftWaitEndSec - liftWaitStartSec > 1e-9) {
        waitIntervals.push({
          shuttleId: bestShuttle.id,
          taskId: task.id,
          reason: 'lift-resource-wait',
          resourceId: task.liftNodeId,
          startSec: liftWaitStartSec,
          endSec: liftWaitEndSec
        });
      }
      if (taskTraces.length < traceTaskLimit) {
        taskTraces.push(buildReplayTrace(task, bestShuttle, bestTiming, liftWaitStartSec, liftWaitEndSec));
      }
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
    completionTimes.push({ timeSec: currentTimeSec, kind: taskWithShuttle.kind });
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
    liftWait: round(shuttle.liftWaitSec / Math.max(durationSec, 1), 4),
    trafficWait: round(shuttle.trafficWaitSec / Math.max(durationSec, 1), 4),
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
  const denominator = Math.max(1, durationSec * Math.max(1, shuttles.length));
  const totalWaitingSec = shuttles.reduce((sum, shuttle) => sum + shuttle.resourceWaitSec, 0);
  const totalRepositionSec = Object.values(repositionBreakdownSec).reduce((sum, value) => sum + value, 0);
  const maxContinuousWaitingSec = waitIntervals.reduce((max, interval) => Math.max(max, interval.endSec - interval.startSec), 0);
  const maxQueuedTaskAgeSec = Math.max(0, ...queuedTasks.map((task) => durationSec - task.createdAtSec), ...queuedTaskWaitSecById.values());
  const repositionBreakdown = Object.fromEntries(Object.entries(repositionBreakdownSec).map(([reason, seconds]) => [reason, {
    seconds: round(seconds, 3),
    pct: round(seconds / denominator * 100, 3)
  }]));
  const waitReasonBreakdown = Object.fromEntries(Object.entries(waitReasonBreakdownSec).map(([reason, seconds]) => [reason, {
    seconds: round(seconds, 3),
    pct: round(seconds / denominator * 100, 3)
  }]));
  const trafficBottlenecks = [...trafficWaitByResourceSec.entries()]
    .map(([resourceId, waitSec]) => ({
      resourceId,
      waitSec: round(waitSec, 3),
      waitCount: trafficWaitCountByResource.get(resourceId) ?? 0
    }))
    .sort((left, right) => right.waitSec - left.waitSec || right.waitCount - left.waitCount || left.resourceId.localeCompare(right.resourceId))
    .slice(0, 20);
  const topWaitIntervals = waitIntervals
    .map((interval) => ({
      shuttleId: interval.shuttleId,
      taskId: interval.taskId,
      reason: interval.reason,
      resourceId: interval.resourceId ?? null,
      startSec: round(interval.startSec, 3),
      endSec: round(interval.endSec, 3),
      waitSec: round(interval.endSec - interval.startSec, 3)
    }))
    .sort((left, right) => right.waitSec - left.waitSec || left.startSec - right.startSec)
    .slice(0, 80);
  const nonZeroWindowSamples = samples.filter((sample) => sample.timeSec > 1e-9 && sample.windowTotalPph > 0);
  const referenceWindowPph = Math.max(0, ...nonZeroWindowSamples.map((sample) => sample.windowTotalPph));
  let sustainedCongestionWindows = 0;
  let currentCongestionWindows = 0;
  const congestionWaitingThreshold = Math.max(2, Math.ceil(shuttles.length * 0.4));
  for (const sample of samples) {
    const congested = sample.timeSec > sampleIntervalSec + 1e-9 &&
      referenceWindowPph > 0 &&
      sample.windowTotalPph < referenceWindowPph * 0.7 &&
      sample.waitingVehicles >= congestionWaitingThreshold;
    if (congested) {
      currentCongestionWindows += 1;
      sustainedCongestionWindows = Math.max(sustainedCongestionWindows, currentCongestionWindows);
      sustainedCongestionSamples.push(sample);
    } else {
      currentCongestionWindows = 0;
    }
  }
  const issues = detectDesIssues({
    scenario,
    samples,
    durationSec,
    averageWaitingPct: totalWaitingSec / denominator * 100,
    averageRepositionPct: totalRepositionSec / denominator * 100,
    trafficReservationWaitPct: shuttles.reduce((sum, shuttle) => sum + shuttle.trafficWaitSec, 0) / denominator * 100,
    maxContinuousWaitingSec,
    sustainedCongestionWindows,
    referenceWindowPph,
    finalWindowPph: samples.at(-1)?.windowTotalPph ?? 0,
    congestionWaitingThreshold,
    bottlenecks,
    processedEvents,
    durationStepEquivalent: durationSec / Math.max(0.001, scenario.timeStepSec),
    routeUnavailableCount: yellowGraph.routeUnavailableCount
  });

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
    averageWaitingPct: round(totalWaitingSec / denominator * 100, 3),
    averageRepositionPct: round(totalRepositionSec / denominator * 100, 3),
    maxContinuousWaitingSec: round(maxContinuousWaitingSec, 3),
    maxQueuedTaskAgeSec: round(maxQueuedTaskAgeSec, 3),
    sustainedCongestionWindows,
    controlPolicy: {
      maxActiveTasks,
      backpressureHoldCount
    },
    repositionBreakdown,
    waitReasonBreakdown,
    trafficBottlenecks,
    routeModel: {
      kind: 'yellow-graph-reservation-window',
      drivableNodeCount: yellowGraph.drivableNodeIds.size,
      drivableEdgeCount: [...yellowGraph.adjacency.values()].reduce((sum, edges) => sum + edges.length, 0),
      mappedServiceNodeCount: yellowGraph.serviceNodeByNodeId.size,
      routeUnavailableCount: yellowGraph.routeUnavailableCount,
      reservationResourceCount: reservationResourceAvailableSec.size,
      reservationWindowCount,
      trafficWaitSec: round(shuttles.reduce((sum, shuttle) => sum + shuttle.trafficWaitSec, 0), 3)
    },
    shuttleUtilization,
    liftPph,
    bottlenecks,
    issues,
    anomalyMarkers,
    reservationReplay: {
      taskTraceLimit: traceTaskLimit,
      tracedTaskCount: taskTraces.length,
      omittedTaskCount: Math.max(0, completedInbound + completedOutbound - taskTraces.length),
      tasks: taskTraces,
      topWaitIntervals
    },
    samples
  };
}

function detectDesIssues(input: {
  scenario: ShuttleScenario;
  samples: HeadlessDesSample[];
  durationSec: number;
  averageWaitingPct: number;
  averageRepositionPct: number;
  trafficReservationWaitPct: number;
  maxContinuousWaitingSec: number;
  sustainedCongestionWindows: number;
  referenceWindowPph: number;
  finalWindowPph: number;
  congestionWaitingThreshold: number;
  bottlenecks: Record<string, number>;
  processedEvents: number;
  durationStepEquivalent: number;
  routeUnavailableCount: number;
}): DesIssue[] {
  const issues: DesIssue[] = [];
  const liftAndLowerSec = input.scenario.physicsParams.liftTimeSec + input.scenario.physicsParams.lowerTimeSec;
  const latestSample = input.samples.at(-1);

  if (input.sustainedCongestionWindows >= 3) {
    issues.push({
      id: 'sustained-congestion',
      severity: 'critical',
      title: 'Sustained throughput degradation without hard-failure semantics',
      metric: `${input.sustainedCongestionWindows} consecutive low windows; final window=${round(input.finalWindowPph, 1)} PPH; waiting=${latestSample?.waitingVehicles ?? 0}`,
      detail: `Window throughput stayed below 70% of the DES reference window while at least ${input.congestionWaitingThreshold} vehicles were waiting. This is the long-run failure mode the 24h tick audit exposed after 15h.`,
      recommendation: 'Treat this as a liveness/degradation failure even when deadlock/livelock counters are zero; inspect wait reasons and dispatch/lift contention before using this run for customer capacity claims.'
    });
  }

  if (input.routeUnavailableCount > 0) {
    issues.push({
      id: 'yellow-graph-route-unavailable',
      severity: 'critical',
      title: 'DES task route is not available on the yellow graph',
      metric: `route unavailable count=${input.routeUnavailableCount}`,
      detail: 'At least one DES task endpoint could not be connected through the verified yellow-grid route graph. This means the analytical DES is no longer using the same feasible movement area as the physical replay.',
      recommendation: 'Fix lift service-node mapping or layout graph connectivity before using the DES run for customer review.'
    });
  }

  if (input.averageWaitingPct >= 15) {
    issues.push({
      id: 'high-waiting',
      severity: 'warning',
      title: 'High cumulative waiting share',
      metric: `average waiting=${round(input.averageWaitingPct, 1)}%, max continuous wait=${round(input.maxContinuousWaitingSec, 1)}s`,
      detail: 'The fleet spends a material share of available time waiting on constrained resources instead of moving or handling load.',
      recommendation: 'Break down waiting by lift, queue, and conflict reason; add dispatch backpressure so tasks are not released into saturated lift zones.'
    });
  }

  if (input.trafficReservationWaitPct >= 10) {
    issues.push({
      id: 'high-traffic-reservation-wait',
      severity: 'warning',
      title: 'Traffic reservation wait dominates fleet delay',
      metric: `traffic reservation wait=${round(input.trafficReservationWaitPct, 1)}%`,
      detail: 'The event-driven reservation model is spending a large share of fleet time waiting for yellow-grid edge/node time windows, which points to corridor contention rather than lift handling alone.',
      recommendation: 'Treat this as a traffic-control bottleneck: inspect the busiest yellow-grid corridors, add dispatch backpressure near lifts, and compare alternate parking/task assignment policies before claiming final capacity.'
    });
  }

  if (input.averageRepositionPct >= 20) {
    issues.push({
      id: 'high-reposition',
      severity: 'warning',
      title: 'High empty travel / reposition share',
      metric: `average reposition=${round(input.averageRepositionPct, 1)}%`,
      detail: 'The DES model counts empty travel to task pickup as reposition. A 20%+ share means task assignment or parking strategy is spending too much travel before productive load movement.',
      recommendation: 'Hold idle shuttles near demand-weighted lift/column zones and assign tasks by total cycle cost, not only next available shuttle.'
    });
  }

  if (liftAndLowerSec < 5) {
    issues.push({
      id: 'unrealistic-handling-time',
      severity: 'warning',
      title: 'Lift/lower handling time is not review-realistic',
      metric: `lift=${input.scenario.physicsParams.liftTimeSec}s, lower=${input.scenario.physicsParams.lowerTimeSec}s`,
      detail: 'Near-instant handling hides lift bottlenecks and makes pickup/dropoff synchronization visually misleading.',
      recommendation: 'Use the agreed customer assumption, for example lift=30s and lower=30s or the separate real values if known.'
    });
  }

  if (input.processedEvents < input.durationStepEquivalent * 0.2) {
    issues.push({
      id: 'des-speedup',
      severity: 'observation',
      title: 'DES advances without fixed 1s ticks',
      metric: `events=${input.processedEvents}, tick-equivalent=${round(input.durationStepEquivalent, 0)}`,
      detail: 'The headless DES runner advances through demand, lift, and task completion events instead of stepping every simulated second.',
      recommendation: 'Use this path for 24h and 7d analytical sweeps; reserve physical tick simulation for visual replay and targeted traffic debugging.'
    });
  }

  if (issues.length === 0) {
    issues.push({
      id: 'no-des-review-issues',
      severity: 'observation',
      title: 'No DES review thresholds tripped',
      metric: '0 critical/warning DES issues',
      detail: 'The configured DES review thresholds did not detect sustained congestion, high waiting, high reposition, or unrealistic handling time.',
      recommendation: 'Keep this run as a baseline and rerun after each dispatch or layout-policy change.'
    });
  }

  return issues;
}
