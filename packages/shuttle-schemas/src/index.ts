import { z } from 'zod';

export const Coordinate3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

export const ShuttleNodeTypeSchema = z.enum([
  'storage',
  'aisle',
  'intersection',
  'inbound',
  'outbound',
  'charger',
  'parking',
  'lift-blackbox'
]);

export const ShuttleNodeSchema = z.object({
  id: z.string(),
  type: ShuttleNodeTypeSchema,
  liftKind: z.enum(['inbound', 'outbound']).optional(),
  x: z.number(),
  y: z.number().default(0),
  z: z.number(),
  noStop: z.boolean().default(false),
  noParking: z.boolean().default(false),
  capacity: z.number().int().positive().default(1),
  allowedDirections: z.array(z.string()).default([])
});

export const DirectionModeSchema = z.enum(['oneWay', 'twoWay']);
export const ReservationTypeSchema = z.enum(['edge', 'node', 'zone']);

export const ShuttleEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  lengthM: z.number().positive(),
  directionMode: DirectionModeSchema.default('twoWay'),
  speedLimitEmptyMps: z.number().positive().optional(),
  speedLimitLoadedMps: z.number().positive().optional(),
  reservationType: ReservationTypeSchema.default('edge'),
  conflictGroup: z.string().optional(),
  noParking: z.boolean().default(true)
});

export const ShuttleZoneSchema = z.object({
  id: z.string(),
  type: z.enum(['intersection', 'aisle', 'storage', 'parking']),
  nodeIds: z.array(z.string()).default([]),
  edgeIds: z.array(z.string()).default([]),
  noStop: z.boolean().default(false),
  noParking: z.boolean().default(false),
  capacity: z.number().int().positive().default(1),
  conflictGroup: z.string().optional()
});

export const VehicleConfigSchema = z.object({
  count: z.number().int().positive(),
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  emptySpeedMps: z.number().positive(),
  loadedSpeedMps: z.number().positive(),
  accelerationMps2: z.number().positive(),
  switchDirectionSec: z.number().nonnegative(),
  liftTimeSec: z.number().nonnegative(),
  lowerTimeSec: z.number().nonnegative(),
  maxLoadKg: z.number().positive(),
  safetyRadiusM: z.number().nonnegative(),
  batteryEnabled: z.boolean().default(false),
  initialSoc: z.number().min(0).max(1).default(1)
});

export const TaskGenerationSchema = z.object({
  inboundRatePerHour: z.number().nonnegative(),
  outboundRatePerHour: z.number().nonnegative(),
  inboundOutboundMix: z.number().min(0).max(1).default(0.5),
  arrivalDistribution: z.enum(['deterministic', 'seeded-exponential']).default('deterministic'),
  maxTasks: z.number().int().positive().default(200),
  initialStorageFillPolicy: z.enum(['full-columns', 'zone-balanced-50']).default('full-columns'),
  initialOutboundFullColumns: z.number().int().nonnegative().default(0)
});

export const PhysicsParamsSchema = z.object({
  emptySpeedMps: z.number().positive(),
  loadedSpeedMps: z.number().positive(),
  accelerationMps2: z.number().positive(),
  switchDirectionSec: z.number().nonnegative(),
  liftTimeSec: z.number().nonnegative(),
  lowerTimeSec: z.number().nonnegative(),
  loadedClearanceM: z.number().nonnegative().default(0.2),
  reservationClearanceSec: z.number().nonnegative().default(0.4)
});

export const RoutingPolicySchema = z.object({
  algorithm: z.enum(['astar', 'dijkstra']).default('astar'),
  allowReplan: z.boolean().default(true),
  routeTimeoutSec: z.number().positive().default(12),
  maxReplansPerTask: z.number().int().nonnegative().default(3)
});

export const TrafficPolicySchema = z.object({
  controllerMode: z.enum(['reservation-v2', 'agent-simple', 'agent-minimal', 'agent-refresh']).default('reservation-v2'),
  edgeCapacity: z.number().int().positive().default(1),
  nodeCapacity: z.number().int().positive().default(1),
  zoneCapacity: z.number().int().positive().default(1),
  liftApproachCapacity: z.number().int().positive().default(1),
  sourceBufferCapacity: z.number().int().positive().default(4),
  collisionAvoidanceEnabled: z.boolean().default(true),
  minimumClearanceSec: z.number().nonnegative().default(0.4),
  dynamicAvoidanceClearanceM: z.number().nonnegative().default(0.5),
  priorityAgingSec: z.number().nonnegative().default(20),
  deadlockDetectSec: z.number().positive().default(2),
  deadlockBreakPolicy: z.enum(['lowest-priority-replan', 'oldest-waits-wins']).default('oldest-waits-wins')
});

export const LayoutCalibrationSourceSchema = z.enum(['assumed', 'cad', 'vendor', 'site']);
export const LayoutCalibrationStatusSchema = z.enum(['assumption', 'partial-cad', 'verified']);
export const LayoutCalibrationConfidenceSchema = z.enum(['low', 'medium', 'high']);

export const LayoutCalibrationDimensionSchema = z.object({
  key: z.string(),
  label: z.string(),
  valueM: z.number().nonnegative(),
  source: LayoutCalibrationSourceSchema,
  confidence: LayoutCalibrationConfidenceSchema,
  note: z.string().optional()
});

export const LayoutBlockedCellSchema = z.object({
  id: z.string(),
  role: z.enum(['blocked', 'structural']),
  xM: z.number(),
  yM: z.number().default(0),
  zM: z.number(),
  lengthXM: z.number().positive(),
  lengthZM: z.number().positive(),
  source: LayoutCalibrationSourceSchema,
  confidence: LayoutCalibrationConfidenceSchema,
  note: z.string().optional()
});

export const LayoutCalibrationProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: LayoutCalibrationStatusSchema,
  units: z.literal('meter').default('meter'),
  sourceDescription: z.string(),
  dimensions: z.array(LayoutCalibrationDimensionSchema).default([]),
  blockedCells: z.array(LayoutBlockedCellSchema).default([]),
  notes: z.array(z.string()).default([])
});

export const ShuttleScenarioSchema = z.object({
  schemaVersion: z.literal('shuttle.phase0.v0'),
  id: z.string(),
  name: z.string(),
  seed: z.number().int().nonnegative(),
  durationSec: z.number().positive(),
  timeStepSec: z.number().positive().default(0.2),
  vehicles: VehicleConfigSchema,
  layout: z.object({
    units: z.literal('meter').default('meter'),
    calibrationProfile: LayoutCalibrationProfileSchema.nullable().default(null),
    nodes: z.array(ShuttleNodeSchema).min(2),
    edges: z.array(ShuttleEdgeSchema).min(1),
    zones: z.array(ShuttleZoneSchema).default([])
  }),
  taskGeneration: TaskGenerationSchema,
  physicsParams: PhysicsParamsSchema,
  routingPolicy: RoutingPolicySchema,
  trafficPolicy: TrafficPolicySchema
}).superRefine((scenario, context) => {
  const nodeIds = new Set(scenario.layout.nodes.map((node) => node.id));
  const nodesById = new Map(scenario.layout.nodes.map((node) => [node.id, node]));
  const coordinateToleranceM = 1e-6;
  const duplicateNodeIds = scenario.layout.nodes
    .map((node) => node.id)
    .filter((nodeId, index, ids) => ids.indexOf(nodeId) !== index);
  for (const nodeId of new Set(duplicateNodeIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['layout', 'nodes'],
      message: `Duplicate node id ${nodeId}`
    });
  }
  const parkableNonAisleNodes = scenario.layout.nodes.filter((node) =>
    !node.noStop &&
    !node.noParking &&
    (node.type === 'parking' || node.type === 'storage' || node.type === 'charger')
  );
  if (parkableNonAisleNodes.length < scenario.vehicles.count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['vehicles', 'count'],
      message: 'Phase 0 requires at least one parkable non-aisle node per vehicle; storage cells may be used as under-load temporary parking when node capacity is fixed at 1.'
    });
  }
  const storageRows = new Set<string>();
  const storageRowForNodeId = (nodeId: string): string | null => /^storage-r(\d+)-c\d+$/.exec(nodeId)?.[1] ?? null;
  for (const node of scenario.layout.nodes.filter((candidate) => candidate.type === 'storage')) {
    const match = /^storage-r(\d+)-c(\d+)$/.exec(node.id);
    if (!match) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'nodes', node.id, 'id'],
        message: 'Phase 1 FIFO storage nodes must use storage-rNN-cNN ids until explicit row/column metadata is added.'
      });
      continue;
    }
    storageRows.add(match[1]!);
  }
  for (const row of storageRows) {
    for (const sideNodeId of [`left-row-${row}`, `right-row-${row}`]) {
      if (!nodeIds.has(sideNodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'nodes'],
          message: `FIFO storage row ${row} requires side access node ${sideNodeId}.`
        });
      }
    }
  }
  if (scenario.trafficPolicy.edgeCapacity !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['trafficPolicy', 'edgeCapacity'],
      message: 'Phase 0 supports edgeCapacity=1 only; multi-capacity reservations are Phase 1.'
    });
  }
  if (scenario.trafficPolicy.nodeCapacity !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['trafficPolicy', 'nodeCapacity'],
      message: 'Phase 0 supports nodeCapacity=1 only; multi-capacity reservations are Phase 1.'
    });
  }
  if (scenario.trafficPolicy.zoneCapacity !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['trafficPolicy', 'zoneCapacity'],
      message: 'Phase 0 supports zoneCapacity=1 only; multi-capacity reservations are Phase 1.'
    });
  }
  for (const node of scenario.layout.nodes) {
    if (Math.abs(node.y) > coordinateToleranceM) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'nodes', node.id, 'y'],
        message: 'Phase 0/1 custom layouts are single-floor only; node y must be 0 and lifts remain black-box I/O resources.'
      });
    }
    if (node.type === 'lift-blackbox' && !node.liftKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'nodes', node.id, 'liftKind'],
        message: 'Phase 0 lift-blackbox nodes must declare liftKind=inbound or liftKind=outbound.'
      });
    }
    if (node.type !== 'lift-blackbox' && node.liftKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'nodes', node.id, 'liftKind'],
        message: 'liftKind is only valid on lift-blackbox nodes.'
      });
    }
    if (node.capacity !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'nodes', node.id, 'capacity'],
        message: 'Phase 0 supports node capacity=1 only; multi-capacity nodes are Phase 1.'
      });
    }
  }
  for (const zone of scenario.layout.zones) {
    for (const nodeId of zone.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'zones', zone.id, 'nodeIds'],
          message: `Zone ${zone.id} references unknown node ${nodeId}.`
        });
      }
    }
    for (const edgeId of zone.edgeIds) {
      if (!scenario.layout.edges.some((edge) => edge.id === edgeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'zones', zone.id, 'edgeIds'],
          message: `Zone ${zone.id} references unknown edge ${edgeId}.`
        });
      }
    }
    if (zone.capacity !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'zones', zone.id, 'capacity'],
        message: 'Phase 0 supports zone capacity=1 only; multi-capacity zones are Phase 1.'
      });
    }
  }
  for (const edge of scenario.layout.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'edges', edge.id, 'from'],
        message: `Unknown edge from node ${edge.from}`
      });
    }
    if (!to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'edges', edge.id, 'to'],
        message: `Unknown edge to node ${edge.to}`
      });
    }
    if (from && to) {
      const dx = Math.abs(from.x - to.x);
      const dy = Math.abs(from.y - to.y);
      const dz = Math.abs(from.z - to.z);
      if (dy > coordinateToleranceM) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'edges', edge.id],
          message: `Edge ${edge.id} changes vertical level; Phase 0/1 models one floor and treats lifts as black-box I/O.`
        });
      }
      if (dx > coordinateToleranceM && dz > coordinateToleranceM) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'edges', edge.id],
          message: `Edge ${edge.id} is diagonal; four-way shuttle layouts must use orthogonal X/Z track edges only.`
        });
      }
      if (dx <= coordinateToleranceM && dy <= coordinateToleranceM && dz <= coordinateToleranceM) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'edges', edge.id],
          message: `Edge ${edge.id} has identical from/to coordinates; custom layouts must define a physical track segment.`
        });
      }
      if (from.type === 'storage' && to.type === 'storage') {
        const fromRow = storageRowForNodeId(from.id);
        const toRow = storageRowForNodeId(to.id);
        const columnLayout = scenario.layout.calibrationProfile?.id === 'top-lift-column-v1';
        const sameColumn = /^storage-r\d+-c(\d+)$/.exec(from.id)?.[1] === /^storage-r\d+-c(\d+)$/.exec(to.id)?.[1];
        if (fromRow && toRow && fromRow !== toRow && !(columnLayout && sameColumn)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['layout', 'edges', edge.id],
            message: `Edge ${edge.id} crosses storage rows; storage-area traversal must stay horizontal within one FIFO row and cross-row movement must use side/main aisles.`
          });
        }
      }
    }
  }
});

export const VehicleOperationalStateSchema = z.enum([
  'idle',
  'assigned',
  'moving-to-pickup',
  'aligning-under-load',
  'lifting',
  'loaded-moving',
  'lowering',
  'returning',
  'parking',
  'waiting-blocked',
  'charging',
  'faulted'
]);

export const VehicleStateSchema = z.object({
  id: z.string(),
  state: VehicleOperationalStateSchema,
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yaw: z.number(),
  speedMps: z.number().nonnegative(),
  loaded: z.boolean(),
  taskId: z.string().nullable(),
  targetNodeId: z.string().nullable(),
  currentNodeId: z.string(),
  currentEdgeId: z.string().nullable(),
  routeNodeIds: z.array(z.string()),
  plannedGoalNodeId: z.string().nullable().default(null),
  plannedRouteNodeIds: z.array(z.string()).default([]),
  localRouteNodeIds: z.array(z.string()).default([]),
  localRouteReason: z.string().nullable().default(null),
  routeIndex: z.number().int().nonnegative(),
  legRemainingM: z.number().nonnegative(),
  legElapsedSec: z.number().nonnegative(),
  legTravelSec: z.number().nonnegative(),
  phaseRemainingSec: z.number().nonnegative(),
  waitReason: z.string().nullable(),
  blockingReservationId: z.string().nullable(),
  blockingVehicleId: z.string().nullable(),
  blockedTimeSec: z.number().nonnegative(),
  idleTimeSec: z.number().nonnegative(),
  busyTimeSec: z.number().nonnegative()
});

export const TaskStateSchema = z.enum(['queued', 'assigned', 'in-progress', 'completed', 'failed']);
export const TaskKindSchema = z.enum(['inbound', 'outbound']);

export const TaskStateRecordSchema = z.object({
  id: z.string(),
  kind: TaskKindSchema,
  state: TaskStateSchema,
  createdAtSec: z.number().nonnegative(),
  assignedAtSec: z.number().nonnegative().nullable(),
  startedAtSec: z.number().nonnegative().nullable(),
  completedAtSec: z.number().nonnegative().nullable(),
  pickupNodeId: z.string(),
  dropoffNodeId: z.string(),
  loadId: z.string(),
  vehicleId: z.string().nullable(),
  replanCount: z.number().int().nonnegative(),
  waitReason: z.string().nullable()
});

export const LoadStateSchema = z.enum(['waiting', 'carried', 'stored', 'delivered']);

export const LoadStateRecordSchema = z.object({
  id: z.string(),
  state: LoadStateSchema,
  nodeId: z.string().nullable(),
  vehicleId: z.string().nullable(),
  weightKg: z.number().positive()
});

export const ReservationSchema = z.object({
  id: z.string(),
  resourceType: ReservationTypeSchema,
  resourceId: z.string(),
  vehicleId: z.string(),
  taskId: z.string().nullable(),
  startTimeSec: z.number().nonnegative(),
  endTimeSec: z.number().nonnegative(),
  priority: z.number().int(),
  conflictGroup: z.string().nullable(),
  reasonCode: z.string()
});

export const VehicleUtilizationBreakdownSchema = z.object({
  busy: z.number().min(0).max(1),
  productive: z.number().min(0).max(1),
  moving: z.number().min(0).max(1),
  handling: z.number().min(0).max(1),
  waiting: z.number().min(0).max(1),
  idle: z.number().min(0).max(1),
  tasklessTravel: z.number().min(0).max(1),
  queueReserveTravel: z.number().min(0).max(1).default(0),
  wasteReposition: z.number().min(0).max(1).default(0)
});

export const LiftPphSnapshotSchema = z.object({
  kind: z.enum(['inbound', 'outbound']),
  completed: z.number().int().nonnegative(),
  pph: z.number().nonnegative()
});

export const KpiSnapshotSchema = z.object({
  inboundPph: z.number().nonnegative(),
  outboundPph: z.number().nonnegative(),
  totalPph: z.number().nonnegative(),
  windowInboundPph: z.number().nonnegative().default(0),
  windowOutboundPph: z.number().nonnegative().default(0),
  windowTotalPph: z.number().nonnegative().default(0),
  pphWindowSec: z.number().nonnegative().default(0),
  demandOutboundPph: z.number().nonnegative().default(0),
  demandTotalPph: z.number().nonnegative().default(0),
  completedInbound: z.number().int().nonnegative(),
  completedOutbound: z.number().int().nonnegative(),
  completedSeededOutbound: z.number().int().nonnegative().default(0),
  completedDemandOutbound: z.number().int().nonnegative().default(0),
  activeTasks: z.number().int().nonnegative(),
  queuedTasks: z.number().int().nonnegative(),
  averageTaskCycleSec: z.number().nonnegative(),
  p95TaskCycleSec: z.number().nonnegative(),
  averageTaskWaitSec: z.number().nonnegative(),
  vehicleUtilization: z.record(z.number().min(0).max(1)),
  vehicleUtilizationBreakdown: z.record(VehicleUtilizationBreakdownSchema).default({}),
  liftPph: z.record(LiftPphSnapshotSchema).default({}),
  blockedTimeByReasonSec: z.record(z.number().nonnegative()),
  reservationConflictCount: z.number().int().nonnegative(),
  replanCount: z.number().int().nonnegative(),
  deadlockCount: z.number().int().nonnegative(),
  livelockCount: z.number().int().nonnegative(),
  eventLogHash: z.string(),
  theoreticalCapacity: z.object({
    kind: z.enum(['inbound', 'top-lift-column']),
    formulaVersion: z.enum(['inbound-ideal-v1', 'top-lift-four-bound-v1']).default('inbound-ideal-v1'),
    shuttleCount: z.number().int().nonnegative(),
    singleShuttlePph: z.number().nonnegative(),
    fleetPph: z.number().nonnegative(),
    achievedInboundPct: z.number().nonnegative(),
    achievedOutboundPct: z.number().nonnegative().default(0),
    achievedTotalPct: z.number().nonnegative().default(0),
    idealCycleSec: z.number().nonnegative(),
    loadedTravelSec: z.number().nonnegative(),
    emptyReturnSec: z.number().nonnegative(),
    liftAndLowerSec: z.number().nonnegative(),
    averageLoadedDistanceM: z.number().nonnegative(),
    averageEmptyReturnDistanceM: z.number().nonnegative(),
    averageVehicleUtilizationPct: z.number().nonnegative(),
    limitingBound: z.enum(['lift-port', 'shuttle-cycle', 'column-resource', 'network-min-cut']).optional(),
    bounds: z.array(z.object({
      kind: z.enum(['lift-port', 'shuttle-cycle', 'column-resource', 'network-min-cut']),
      pph: z.number().nonnegative(),
      cycleSec: z.number().nonnegative().optional(),
      utilizationBasis: z.string().optional(),
      assumptions: z.array(z.string()).default([])
    })).default([]),
    assumptions: z.array(z.string())
  }).optional()
});

export const EventLogEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  timeSec: z.number().nonnegative(),
  eventType: z.string(),
  vehicleId: z.string().nullable(),
  taskId: z.string().nullable(),
  loadId: z.string().nullable(),
  fromNodeId: z.string().nullable(),
  toNodeId: z.string().nullable(),
  reason: z.string().nullable(),
  position: Coordinate3Schema.nullable(),
  details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
});

export const TrafficWaitingVehicleSchema = z.object({
  vehicleId: z.string(),
  currentNodeId: z.string(),
  targetNodeId: z.string().nullable(),
  waitReason: z.string().nullable(),
  blockedTimeSec: z.number().nonnegative(),
  waitingSinceSec: z.number().nonnegative().nullable(),
  blockingReservationId: z.string().nullable(),
  blockingVehicleId: z.string().nullable()
});

export const ConflictSessionSchema = z.object({
  id: z.string(),
  kind: z.enum(['pair', 'resource']),
  resourceKey: z.string(),
  state: z.enum(['open', 'yielding', 'holding-pocket', 'returning', 'cleared', 'timed-out']),
  participantVehicleIds: z.array(z.string()),
  winnerVehicleId: z.string(),
  yielderVehicleId: z.string(),
  createdAtSec: z.number().nonnegative(),
  createdAtTick: z.number().int().nonnegative(),
  updatedAtSec: z.number().nonnegative(),
  expiresAtSec: z.number().nonnegative(),
  timeoutAtSec: z.number().nonnegative(),
  trigger: z.enum(['head-on', 'same-node', 'column-exit', 'swept-footprint', 'deadlock-break']),
  initialBlockerVehicleId: z.string(),
  blockerVehicleId: z.string(),
  yielderOriginalNodeId: z.string(),
  yielderPocketNodeId: z.string().nullable(),
  yielderLocalRouteNodeIds: z.array(z.string()),
  resumeNodeId: z.string().nullable(),
  clearancePolicy: z.enum(['immediate-next-move', 'short-horizon', 'full-route']),
  closeReason: z.string().nullable()
});

export const LiftPortDiagnosticsSchema = z.object({
  nodeId: z.string(),
  kind: z.enum(['inbound', 'outbound']),
  queueLength: z.number().int().nonnegative(),
  waitingTaskIds: z.array(z.string()),
  activeTaskId: z.string().nullable(),
  approachOccupancy: z.number().int().nonnegative().default(0),
  approachCapacity: z.number().int().positive().default(1),
  sourceBufferOccupancy: z.number().int().nonnegative().default(0),
  sourceBufferCapacity: z.number().int().positive().default(1),
  completedTasks: z.number().int().nonnegative().default(0),
  pph: z.number().nonnegative().default(0),
  utilization: z.number().min(0).max(1)
});

export const ShadowLedgerInvariantCountsSchema = z.object({
  staleLocalRouteClaim: z.number().int().nonnegative().default(0),
  blockedWaiterFutureClaim: z.number().int().nonnegative().default(0),
  orphanedYieldHold: z.number().int().nonnegative().default(0),
  reservationOwnerMismatch: z.number().int().nonnegative().default(0),
  duplicateResourceOwner: z.number().int().nonnegative().default(0),
  conflictSessionMismatch: z.number().int().nonnegative().default(0),
  liftFifoInversion: z.number().int().nonnegative().default(0),
  columnModeConflict: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0)
});

export const ShadowLedgerViolationSchema = z.object({
  code: z.string(),
  severity: z.enum(['watch', 'warn', 'critical']),
  resourceKey: z.string().nullable(),
  vehicleId: z.string().nullable(),
  otherVehicleId: z.string().nullable().default(null),
  detail: z.string()
});

export const ShadowStationContractDemandSchema = z.object({
  id: z.string(),
  kind: z.enum(['source-load', 'inbound-task']),
  status: z.enum(['announced', 'ready', 'claimed', 'completed']),
  stationId: z.string(),
  loadId: z.string().nullable(),
  taskId: z.string().nullable(),
  nodeId: z.string().nullable()
});

export const ShadowInboundDemandLedgerEntrySchema = z.object({
  id: z.string(),
  stationId: z.string(),
  status: z.enum(['announced', 'ready', 'claimed', 'completed']),
  source: z.enum(['source-buffer', 'task', 'source-and-task']),
  loadId: z.string().nullable(),
  taskId: z.string().nullable(),
  nodeId: z.string().nullable(),
  loadState: z.string().nullable(),
  taskState: TaskStateSchema.nullable(),
  vehicleId: z.string().nullable()
});

export const ShadowInboundDemandLedgerStatusCountsSchema = z.object({
  announced: z.number().int().nonnegative().default(0),
  ready: z.number().int().nonnegative().default(0),
  claimed: z.number().int().nonnegative().default(0),
  completed: z.number().int().nonnegative().default(0)
});

export const ShadowInboundDemandLedgerStationSummarySchema = z.object({
  stationId: z.string(),
  total: z.number().int().nonnegative(),
  statusCounts: ShadowInboundDemandLedgerStatusCountsSchema.default({})
});

export const ShadowInboundDemandLedgerSchema = z.object({
  schemaVersion: z.literal('shadow-inbound-demand-ledger.v1').default('shadow-inbound-demand-ledger.v1'),
  entryCount: z.number().int().nonnegative().default(0),
  statusCounts: ShadowInboundDemandLedgerStatusCountsSchema.default({}),
  stationSummaries: z.array(ShadowInboundDemandLedgerStationSummarySchema).default([]),
  entries: z.array(ShadowInboundDemandLedgerEntrySchema).default([])
});

export const StationKernelDemandStatusCountsSchema = z.object({
  announced: z.number().int().nonnegative().default(0),
  ready: z.number().int().nonnegative().default(0),
  claimed: z.number().int().nonnegative().default(0),
  servicing: z.number().int().nonnegative().default(0),
  picked: z.number().int().nonnegative().default(0),
  cancelled: z.number().int().nonnegative().default(0)
});

export const StationKernelLeasePhaseCountsSchema = z.object({
  approaching: z.number().int().nonnegative().default(0),
  occupied: z.number().int().nonnegative().default(0),
  serviceGranted: z.number().int().nonnegative().default(0),
  servicing: z.number().int().nonnegative().default(0),
  revoking: z.number().int().nonnegative().default(0)
});

export const StationKernelDemandTokenSchema = z.object({
  id: z.string(),
  stationId: z.string(),
  fifoSeq: z.number().int().nonnegative(),
  source: z.enum(['inbound-task', 'arrival-intent']),
  taskId: z.string().nullable(),
  loadId: z.string().nullable(),
  readyAtSec: z.number().nonnegative(),
  state: z.enum(['announced', 'ready', 'claimed', 'servicing', 'picked', 'cancelled'])
});

export const StationKernelQueueLeaseSchema = z.object({
  id: z.string(),
  stationId: z.string(),
  vehicleId: z.string(),
  admissionCauseId: z.string(),
  serviceDemandId: z.string().nullable(),
  targetKind: z.enum(['queue-slot', 'bounded-approach']),
  targetNodeId: z.string(),
  slotIndex: z.number().int().positive().nullable(),
  phase: z.enum(['approaching', 'occupied', 'service-granted', 'servicing', 'revoking']),
  issuedAtSec: z.number().nonnegative(),
  expiresAtSec: z.number().nonnegative(),
  lastProgressAtSec: z.number().nonnegative(),
  boundedRouteNodeIds: z.array(z.string()).default([]),
  fifoSeq: z.number().int().nonnegative()
});

export const StationKernelStationSummarySchema = z.object({
  stationId: z.string(),
  sourceBufferOccupancy: z.number().int().nonnegative(),
  activeDemandTokenCount: z.number().int().nonnegative(),
  readyDemandTokenCount: z.number().int().nonnegative(),
  claimedDemandTokenCount: z.number().int().nonnegative(),
  servicingDemandTokenCount: z.number().int().nonnegative(),
  arrivalIntentTokenCount: z.number().int().nonnegative().default(0),
  inboundTaskDemandTokenCount: z.number().int().nonnegative().default(0),
  reserveDemandTokenCount: z.number().int().nonnegative().default(0),
  reserveTargetDepth: z.number().int().nonnegative().default(0),
  legacyReserveTargetDepth: z.number().int().nonnegative().default(0),
  reserveCoverageDepth: z.number().int().nonnegative().default(0),
  reserveCoverageGap: z.number().int().nonnegative().default(0),
  leaseCount: z.number().int().nonnegative(),
  sourceOnlyReadyShadowCount: z.number().int().nonnegative().default(0)
});

export const StationKernelDiagnosticsSchema = z.object({
  schemaVersion: z.literal('station-kernel-shadow.v1').default('station-kernel-shadow.v1'),
  mode: z.literal('shadow').default('shadow'),
  demandTokenCount: z.number().int().nonnegative().default(0),
  leaseCount: z.number().int().nonnegative().default(0),
  demandStatusCounts: StationKernelDemandStatusCountsSchema.default({}),
  leasePhaseCounts: StationKernelLeasePhaseCountsSchema.default({}),
  stationSummaries: z.array(StationKernelStationSummarySchema).default([]),
  demandTokens: z.array(StationKernelDemandTokenSchema).default([]),
  queueLeases: z.array(StationKernelQueueLeaseSchema).default([])
});

export const ShadowStationVehicleCommitmentSchema = z.object({
  vehicleId: z.string(),
  kind: z.enum(['queueReservation', 'activeInboundService']),
  stationId: z.string(),
  phase: z.enum(['approaching', 'parked', 'service']).nullable(),
  taskId: z.string().nullable(),
  loadId: z.string().nullable(),
  currentNodeId: z.string(),
  targetNodeId: z.string().nullable(),
  plannedGoalNodeId: z.string().nullable(),
  currentQueueSlot: z.number().int().positive().nullable(),
  targetQueueSlot: z.number().int().positive().nullable(),
  plannedQueueSlot: z.number().int().positive().nullable(),
  routeLeavesTopLevel: z.boolean().default(false)
});

export const ShadowStationRouteLeaseSchema = z.object({
  stationId: z.string(),
  vehicleId: z.string(),
  kind: z.enum(['physicalQueueSlot', 'queueSlotLease', 'approachSegmentLease']),
  phase: z.enum(['occupied', 'targeted', 'planned', 'approaching']),
  resourceKey: z.string(),
  nodeId: z.string().nullable(),
  slotIndex: z.number().int().positive().nullable(),
  taskId: z.string().nullable(),
  loadId: z.string().nullable(),
  routeNodeIds: z.array(z.string()).default([])
});

export const ShadowStationCoordinatorSchema = z.object({
  mode: z.literal('shadow').default('shadow'),
  decision: z.enum([
    'no-ready-demand',
    'pull-queue-reserve',
    'wait-for-reserve-candidate',
    'match-head-reservation',
    'hold-active-service'
  ]),
  targetReserveDepth: z.number().int().nonnegative(),
  queueCoverageGap: z.number().int().nonnegative(),
  activeServiceGap: z.number().int().nonnegative(),
  stationNeedsReservation: z.boolean(),
  eligibleTasklessVehicleCount: z.number().int().nonnegative(),
  dispatchableReserveCandidateCount: z.number().int().nonnegative(),
  candidateReasonCounts: z.record(z.number().int().nonnegative()).default({})
});

export const ShadowStationServiceTransitionSchema = z.object({
  mode: z.literal('shadow').default('shadow'),
  headReservationVehicleId: z.string().nullable(),
  headReservationSlot: z.number().int().positive().nullable(),
  headDemandId: z.string().nullable(),
  headDemandStatus: z.enum(['ready', 'claimed']).nullable(),
  activeServiceVehicleId: z.string().nullable(),
  activeServiceTaskId: z.string().nullable(),
  readyToStartService: z.boolean().default(false),
  gap: z.enum([
    'none',
    'no-ready-demand',
    'waiting-for-head-reservation',
    'waiting-for-demand',
    'ready-reservation-not-bound'
  ])
});

export const ShadowStationHeadReservationSupplyBucketCountsSchema = z.object({
  dispatchable: z.number().int().nonnegative().default(0),
  busy: z.number().int().nonnegative().default(0),
  routeInfeasible: z.number().int().nonnegative().default(0),
  held: z.number().int().nonnegative().default(0),
  noTarget: z.number().int().nonnegative().default(0),
  unavailable: z.number().int().nonnegative().default(0)
});

export const ShadowStationHeadReservationSupplySchema = z.object({
  mode: z.literal('shadow').default('shadow'),
  gap: z.enum([
    'none',
    'no-ready-demand',
    'active-service-present',
    'head-reservation-present',
    'reserve-in-transit',
    'dispatchable-candidate-available',
    'fleet-busy',
    'route-infeasible',
    'held-by-assignment',
    'no-open-station-target',
    'unknown'
  ]),
  readyDemandCount: z.number().int().nonnegative(),
  claimedDemandCount: z.number().int().nonnegative(),
  targetReserveDepth: z.number().int().nonnegative(),
  nearCoveredDepth: z.number().int().nonnegative(),
  physicalHeadReservationVehicleId: z.string().nullable(),
  physicalHeadReservationSlot: z.number().int().positive().nullable(),
  physicalReservationCount: z.number().int().nonnegative(),
  approachingReservationCount: z.number().int().nonnegative(),
  forecastReservationCount: z.number().int().nonnegative(),
  dispatchableReserveCandidateCount: z.number().int().nonnegative(),
  dominantCandidateReason: z.string().nullable(),
  candidateBucketCounts: ShadowStationHeadReservationSupplyBucketCountsSchema.default({}),
  candidateReasonCounts: z.record(z.number().int().nonnegative()).default({})
});

export const ShadowStationContractSnapshotSchema = z.object({
  stationId: z.string(),
  kind: z.literal('inbound'),
  demandCount: z.number().int().nonnegative(),
  readyDemandCount: z.number().int().nonnegative(),
  claimedDemandCount: z.number().int().nonnegative(),
  sourceBufferOccupancy: z.number().int().nonnegative(),
  sourceBufferCapacity: z.number().int().positive(),
  targetDepth: z.number().int().nonnegative(),
  physicalDepth: z.number().int().nonnegative(),
  nearCoveredDepth: z.number().int().nonnegative(),
  farForecastDepth: z.number().int().nonnegative(),
  queueReservationCount: z.number().int().nonnegative(),
  activeServiceDepth: z.number().int().nonnegative(),
  activeAssignmentQueueLeaseCount: z.number().int().nonnegative().default(0),
  tasklessStandbySoftReserveCount: z.number().int().nonnegative().default(0),
  physicalQueueSlotLeaseCount: z.number().int().nonnegative().default(0),
  routeLeaseCount: z.number().int().nonnegative().default(0),
  coordinator: ShadowStationCoordinatorSchema.default({
    decision: 'no-ready-demand',
    targetReserveDepth: 0,
    queueCoverageGap: 0,
    activeServiceGap: 0,
    stationNeedsReservation: false,
    eligibleTasklessVehicleCount: 0,
    dispatchableReserveCandidateCount: 0,
    candidateReasonCounts: {}
  }),
  serviceTransition: ShadowStationServiceTransitionSchema.default({
    headReservationVehicleId: null,
    headReservationSlot: null,
    headDemandId: null,
    headDemandStatus: null,
    activeServiceVehicleId: null,
    activeServiceTaskId: null,
    readyToStartService: false,
    gap: 'no-ready-demand'
  }),
  headReservationSupply: ShadowStationHeadReservationSupplySchema.default({
    gap: 'no-ready-demand',
    readyDemandCount: 0,
    claimedDemandCount: 0,
    targetReserveDepth: 0,
    nearCoveredDepth: 0,
    physicalHeadReservationVehicleId: null,
    physicalHeadReservationSlot: null,
    physicalReservationCount: 0,
    approachingReservationCount: 0,
    forecastReservationCount: 0,
    dispatchableReserveCandidateCount: 0,
    dominantCandidateReason: null,
    candidateBucketCounts: {},
    candidateReasonCounts: {}
  }),
  demands: z.array(ShadowStationContractDemandSchema).default([]),
  vehicleCommitments: z.array(ShadowStationVehicleCommitmentSchema).default([]),
  routeLeases: z.array(ShadowStationRouteLeaseSchema).default([])
});

export const ShadowStationContractInvariantCountsSchema = z.object({
  demandWithoutCoverage: z.number().int().nonnegative().default(0),
  queueReservationOverTarget: z.number().int().nonnegative().default(0),
  physicalDepthOverTarget: z.number().int().nonnegative().default(0),
  activeServiceWithoutDemand: z.number().int().nonnegative().default(0),
  duplicateVehicleCommitment: z.number().int().nonnegative().default(0),
  duplicateRouteLease: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0)
});

export const ShadowStationContractViolationSchema = z.object({
  code: z.string(),
  severity: z.enum(['watch', 'warn', 'critical']),
  stationId: z.string().nullable(),
  vehicleId: z.string().nullable(),
  detail: z.string()
});

export const ShadowStationContractDiagnosticsSchema = z.object({
  schemaVersion: z.literal('shadow-station-contracts.v1').default('shadow-station-contracts.v1'),
  enabled: z.boolean().default(false),
  stationCount: z.number().int().nonnegative().default(0),
  invariantCounts: ShadowStationContractInvariantCountsSchema.default({}),
  stations: z.array(ShadowStationContractSnapshotSchema).default([]),
  inboundDemandLedger: ShadowInboundDemandLedgerSchema.default({}),
  stationKernel: StationKernelDiagnosticsSchema.default({}),
  violations: z.array(ShadowStationContractViolationSchema).default([])
});

export const ShadowResourceLedgerDiagnosticsSchema = z.object({
  schemaVersion: z.literal('shadow-resource-ledger.v1').default('shadow-resource-ledger.v1'),
  enabled: z.boolean().default(false),
  leaseCount: z.number().int().nonnegative().default(0),
  currentOccupancyLeaseCount: z.number().int().nonnegative().default(0),
  reservationLeaseCount: z.number().int().nonnegative().default(0),
  futureClaimLeaseCount: z.number().int().nonnegative().default(0),
  invariantCounts: ShadowLedgerInvariantCountsSchema.default({}),
  violations: z.array(ShadowLedgerViolationSchema).default([]),
  stationContracts: ShadowStationContractDiagnosticsSchema.default({})
});

export const TrafficDiagnosticsSchema = z.object({
  trafficMode: z.enum(['flow-debug', 'segment-safe', 'agent-simple', 'agent-minimal', 'agent-refresh']).default('flow-debug'),
  safetyValidated: z.boolean().default(false),
  collisionAvoidanceEnabled: z.boolean().default(true),
  longHorizonReservationEnabled: z.boolean().default(false),
  clearThroughLookaheadEnabled: z.boolean().default(false),
  clearThroughMaxLookaheadLegs: z.number().int().nonnegative().default(0),
  activeFutureGrantCount: z.number().int().nonnegative().default(0),
  legacyZoneHoldEnabled: z.boolean().default(false),
  activeReservationCount: z.number().int().nonnegative(),
  waitingVehicles: z.array(TrafficWaitingVehicleSchema),
  conflictSessions: z.array(ConflictSessionSchema).default([]),
  liftPorts: z.array(LiftPortDiagnosticsSchema).default([]),
  deadlockCandidateVehicleIds: z.array(z.string()),
  shadowLedger: ShadowResourceLedgerDiagnosticsSchema.default({}),
  minVehicleSeparationM: z.number().nonnegative().nullable(),
  maxObservedSpeedMps: z.number().nonnegative(),
  physicalViolationCount: z.number().int().nonnegative()
});

export const ShuttleSimStateSchema = z.object({
  schemaVersion: z.literal('shuttle.phase0.state.v0'),
  scenarioId: z.string(),
  sessionId: z.string(),
  status: z.enum(['idle', 'running', 'paused', 'completed', 'error']),
  simTimeSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  seed: z.number().int().nonnegative(),
  vehicles: z.array(VehicleStateSchema),
  tasks: z.array(TaskStateRecordSchema),
  loads: z.array(LoadStateRecordSchema),
  reservations: z.array(ReservationSchema),
  traffic: TrafficDiagnosticsSchema,
  kpis: KpiSnapshotSchema,
  recentEvents: z.array(EventLogEntrySchema),
  error: z.string().nullable()
});

export const ShuttleCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('loadScenario'), scenario: ShuttleScenarioSchema }),
  z.object({ type: z.literal('reset'), seed: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('setParam'), path: z.string().regex(/^\//), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ type: z.literal('startRun'), durationSec: z.number().positive().optional(), seed: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('exportLog') })
]);

export const ShuttleStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('simState'), state: ShuttleSimStateSchema }),
  z.object({ type: z.literal('vehicleState'), vehicles: z.array(VehicleStateSchema), simTimeSec: z.number().nonnegative() }),
  z.object({ type: z.literal('taskEvent'), events: z.array(EventLogEntrySchema), simTimeSec: z.number().nonnegative() }),
  z.object({ type: z.literal('kpiUpdate'), kpis: KpiSnapshotSchema, simTimeSec: z.number().nonnegative() }),
  z.object({ type: z.literal('error'), message: z.string(), simTimeSec: z.number().nonnegative().optional() }),
  z.object({ type: z.literal('connectionRecovered'), state: ShuttleSimStateSchema })
]);

export type Coordinate3 = z.infer<typeof Coordinate3Schema>;
export type LayoutCalibrationProfile = z.infer<typeof LayoutCalibrationProfileSchema>;
export type LayoutBlockedCell = z.infer<typeof LayoutBlockedCellSchema>;
export type ShuttleScenario = z.infer<typeof ShuttleScenarioSchema>;
export type VehicleState = z.infer<typeof VehicleStateSchema>;
export type TaskStateRecord = z.infer<typeof TaskStateRecordSchema>;
export type LoadStateRecord = z.infer<typeof LoadStateRecordSchema>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type TrafficDiagnostics = z.infer<typeof TrafficDiagnosticsSchema>;
export type ConflictSession = z.infer<typeof ConflictSessionSchema>;
export type LiftPphSnapshot = z.infer<typeof LiftPphSnapshotSchema>;
export type KpiSnapshot = z.infer<typeof KpiSnapshotSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
export type ShuttleSimState = z.infer<typeof ShuttleSimStateSchema>;
export type ShuttleCommand = z.infer<typeof ShuttleCommandSchema>;
export type ShuttleStreamMessage = z.infer<typeof ShuttleStreamMessageSchema>;
