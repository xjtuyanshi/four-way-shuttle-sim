import { lazy, Suspense, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import type {
  EventLogEntry,
  KpiSnapshot,
  ShuttleScenario,
  ShuttleSimState,
  ShuttleStreamMessage,
  VehicleState
} from '@four-way-shuttle/schemas';

const ShuttleScene3D = lazy(() =>
  import('./ShuttleScene3D.js').then((module) => ({ default: module.ShuttleScene3D }))
);

type PrerequisiteReport = {
  checkedAt: string;
  host: {
    modelName: string | null;
    modelIdentifier: string | null;
    chip: string | null;
    memory: string | null;
    metalSupport: string | null;
    macos: string | null;
  };
  unreal: {
    installedCandidates: string[];
    preferredVersion: '5.7.4';
    status: 'ready' | 'blocked';
    notes: string[];
  };
  xcode: {
    developerDir: string | null;
    version: string | null;
    status: 'ready' | 'blocked';
    notes: string[];
  };
  pixelStreaming: {
    status: 'pending-unreal' | 'ready';
    notes: string[];
  };
};

type CommandStatus = {
  label: string;
  tone: 'idle' | 'ok' | 'warn' | 'error';
};

type PlaybackSpeedResponse = {
  speed: number;
};

type Phase0ValidationRun = {
  seed: number;
  durationSec: number;
  status: string;
  eventLogHash: string;
  eventCount: number;
  completedInbound: number;
  completedOutbound: number;
  totalPph: number;
  inboundPph: number;
  outboundPph: number;
  queuedTasks: number;
  maxQueuedTasks: number;
  maxWaitingVehicles: number;
  maxLiftPortQueueLength: number;
  blockedTimeByReasonSec: Record<string, number>;
  reservationConflictCount: number;
  deadlockCount: number;
  maxObservedSpeedMps: number;
  maxObservedAccelerationMps2: number;
  minVehicleSeparationM: number | null;
  physicalViolationCount: number;
};

type Phase0ValidationResult = {
  checkedAt: string;
  scenarioId: string;
  deterministic: {
    seed: number;
    repeatCount: number;
    pass: boolean;
    hashes: string[];
  };
  seedSweep: {
    seeds: number[];
    durationSec: number;
    runs: Phase0ValidationRun[];
    totalPphMean: number;
    totalPphMin: number;
    totalPphMax: number;
    totalPphRange: number;
  };
  longRun?: {
    seeds: number[];
    durationSec: number;
    runs: Phase0ValidationRun[];
    thresholds?: {
      minTotalPph: number;
      maxQueuedTasks: number;
      maxWaitingVehicles: number;
      maxLiftPortQueueLength: number;
    };
    totalPphMean: number;
    maxQueuedTasks: number;
    maxWaitingVehicles: number;
    maxLiftPortQueueLength: number;
  };
  acceptance: {
    sameSeedEventHashStable: boolean;
    noDeadlocksInSweep: boolean;
    eventLogsPresent: boolean;
    noPhysicalSafetyViolations: boolean;
    noReservationCoverageViolations: boolean;
    longRunEventLogsPresent?: boolean;
    longRunThroughputPositive?: boolean;
    longRunThroughputFloorMet?: boolean;
    longRunQueuesBounded?: boolean;
    noLongRunDeadlocks?: boolean;
    noLongRunPhysicalSafetyViolations?: boolean;
    noLongRunReservationCoverageViolations?: boolean;
    pass: boolean;
  };
};

type SceneLayers = {
  traffic: boolean;
  physics: boolean;
  loads: boolean;
  routes: boolean;
};

const CONTROLLED_PARAMS = [
  {
    label: 'Loaded speed',
    path: '/physicsParams/loadedSpeedMps',
    min: 0.4,
    max: 2.2,
    step: 0.05,
    unit: 'm/s'
  },
  {
    label: 'Empty speed',
    path: '/physicsParams/emptySpeedMps',
    min: 0.4,
    max: 2.6,
    step: 0.05,
    unit: 'm/s'
  },
  {
    label: 'Lift time',
    path: '/physicsParams/liftTimeSec',
    min: 0.5,
    max: 6,
    step: 0.1,
    unit: 's'
  },
  {
    label: 'Inbound rate',
    path: '/taskGeneration/inboundRatePerHour',
    min: 0,
    max: 720,
    step: 1,
    unit: 'PPH'
  },
  {
    label: 'Outbound rate',
    path: '/taskGeneration/outboundRatePerHour',
    min: 0,
    max: 720,
    step: 1,
    unit: 'PPH'
  }
] as const;

const PLAYBACK_SPEEDS = [1, 2, 4, 10] as const;

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatNumber(value: number, digits = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function getPointerValue(source: unknown, pointer: string): unknown {
  const parts = pointer.split('/').slice(1);
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/shuttle-ws`;
}

function mergeEvents(previous: EventLogEntry[], next: EventLogEntry[]): EventLogEntry[] {
  const bySequence = new Map<number, EventLogEntry>();
  for (const event of [...previous, ...next]) {
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-80);
}

export function mergeVehicleStateUpdate(
  previous: ShuttleSimState | null,
  vehicles: VehicleState[],
  simTimeSec: number
): ShuttleSimState | null {
  if (!previous) {
    return previous;
  }
  const incomingById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const existingIds = new Set(previous.vehicles.map((vehicle) => vehicle.id));
  const nextVehicles = previous.vehicles.map((vehicle) => incomingById.get(vehicle.id) ?? vehicle);
  for (const vehicle of vehicles) {
    if (!existingIds.has(vehicle.id)) {
      nextVehicles.push(vehicle);
    }
  }
  return {
    ...previous,
    simTimeSec,
    vehicles: nextVehicles
  };
}

export function mergeKpiUpdate(
  previous: ShuttleSimState | null,
  kpis: KpiSnapshot,
  simTimeSec: number
): ShuttleSimState | null {
  if (!previous) {
    return previous;
  }
  return {
    ...previous,
    simTimeSec,
    kpis
  };
}

function KpiStrip({ kpis }: { kpis: KpiSnapshot | null }) {
  const items = [
    ['Total PPH', kpis ? formatNumber(kpis.totalPph, 1) : '--'],
    ['Inbound PPH', kpis ? formatNumber(kpis.inboundPph, 1) : '--'],
    ['Outbound PPH', kpis ? formatNumber(kpis.outboundPph, 1) : '--'],
    ['P95 cycle', kpis ? `${formatNumber(kpis.p95TaskCycleSec, 1)}s` : '--'],
    ['Conflicts', kpis ? String(kpis.reservationConflictCount) : '--'],
    ['Deadlocks', kpis ? String(kpis.deadlockCount) : '--']
  ];

  return (
    <section className="kpi-strip" aria-label="KPI summary">
      {items.map(([label, value]) => (
        <div className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function VehicleTable({
  vehicles,
  selectedVehicleId,
  onSelectVehicle
}: {
  vehicles: VehicleState[];
  selectedVehicleId: string | null;
  onSelectVehicle: (vehicleId: string) => void;
}) {
  return (
    <section className="panel vehicle-panel">
      <div className="panel-head">
        <h2>Vehicle State</h2>
        <span>{vehicles.length} units</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>State</th>
              <th>Node</th>
              <th>Target</th>
              <th>Speed</th>
              <th>Wait</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((vehicle) => (
              <tr
                className={selectedVehicleId === vehicle.id ? 'selected' : ''}
                key={vehicle.id}
                onClick={() => onSelectVehicle(vehicle.id)}
              >
                <td>{vehicle.id}</td>
                <td><span className={`state-pill ${vehicle.state}`}>{vehicle.state}</span></td>
                <td>{vehicle.currentNodeId}</td>
                <td>{vehicle.targetNodeId ?? '--'}</td>
                <td>{vehicle.speedMps.toFixed(2)}</td>
                <td>{vehicle.waitReason ?? vehicle.blockingVehicleId ?? vehicle.blockingReservationId ?? '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EventLog({ events }: { events: EventLogEntry[] }) {
  return (
    <section className="panel event-panel">
      <div className="panel-head">
        <h2>Event Log</h2>
        <span>latest {events.length}</span>
      </div>
      <div className="event-list">
        {[...events].slice(-18).reverse().map((event) => (
          <div className="event-row" key={event.sequence}>
            <time>{event.timeSec.toFixed(1)}s</time>
            <strong>{event.eventType}</strong>
            <span>{event.vehicleId ?? event.taskId ?? 'system'}</span>
            <small>{event.reason ?? ''}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatStorageCellLabel(nodeId: string): string {
  const match = /^storage-r(\d+)-c(\d+)$/.exec(nodeId);
  if (match) {
    return `R${Number(match[1])} C${Number(match[2])}`;
  }
  return nodeId.replace('storage-', '').toUpperCase();
}

function AuthoritativeMap({ scenario, state }: { scenario: ShuttleScenario | null; state: ShuttleSimState | null }) {
  const geometry = useMemo(() => {
    const nodes = scenario?.layout.nodes ?? [];
    const xValues = nodes.map((node) => node.x);
    const zValues = nodes.map((node) => node.z);
    const minX = Math.min(...xValues, 0) - 2;
    const maxX = Math.max(...xValues, 1) + 2;
    const minZ = Math.min(...zValues, -1) - 2;
    const maxZ = Math.max(...zValues, 1) + 2;
    const width = Math.max(1, maxX - minX);
    const depth = Math.max(1, maxZ - minZ);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));

    const project = (point: { x: number; z: number }) => ({
      left: `${((point.x - minX) / width) * 100}%`,
      top: `${(1 - (point.z - minZ) / depth) * 100}%`
    });

    return { nodes, nodeMap, edges: scenario?.layout.edges ?? [], project };
  }, [scenario]);

  const loads = state?.loads.filter((load) => load.nodeId && load.state !== 'carried') ?? [];
  const activeReservations = state?.reservations ?? [];

  return (
    <div className="authoritative-map" aria-label="Authoritative state map">
      {geometry.edges.map((edge) => {
        const from = geometry.nodeMap.get(edge.from);
        const to = geometry.nodeMap.get(edge.to);
        if (!from || !to) return null;
        const fromPoint = geometry.project(from);
        const toPoint = geometry.project(to);
        const left = parseFloat(fromPoint.left);
        const top = parseFloat(fromPoint.top);
        const dx = parseFloat(toPoint.left) - left;
        const dy = parseFloat(toPoint.top) - top;
        const length = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const reserved = activeReservations.some((reservation) => reservation.resourceId === edge.id);
        return (
          <span
            className={`map-edge ${reserved ? 'reserved' : ''}`}
            key={edge.id}
            style={{
              left: fromPoint.left,
              top: fromPoint.top,
              width: `${length}%`,
              transform: `rotate(${angle}rad)`
            }}
          />
        );
      })}
      {geometry.nodes.map((node) => (
        <span className={`map-node ${node.type}`} key={node.id} style={geometry.project(node)}>
          {node.id}
        </span>
      ))}
      {loads.map((load) => {
        const node = load.nodeId ? geometry.nodeMap.get(load.nodeId) : null;
        return node ? <span className={`map-load ${load.state}`} key={load.id} style={geometry.project(node)} /> : null;
      })}
      {(state?.vehicles ?? []).map((vehicle) => (
        <span
          className={`map-vehicle ${vehicle.state}`}
          key={vehicle.id}
          style={{
            ...geometry.project(vehicle),
            transform: `translate(-50%, -50%) rotate(${vehicle.yaw}rad)`
          }}
        >
          {vehicle.id}
        </span>
      ))}
    </div>
  );
}

function StreamingPane({
  prerequisites,
  scenario,
  state,
  layers,
  selectedVehicleId,
  onToggleLayer
}: {
  prerequisites: PrerequisiteReport | null;
  scenario: ShuttleScenario | null;
  state: ShuttleSimState | null;
  layers: SceneLayers;
  selectedVehicleId: string | null;
  onToggleLayer: (layer: keyof SceneLayers) => void;
}) {
  const unrealReady = prerequisites?.unreal.status === 'ready';
  const xcodeReady = prerequisites?.xcode.status === 'ready';
  const ready = unrealReady && xcodeReady;

  return (
    <section className="stream-pane">
      <div className="stream-header">
        <div>
          <h2>3D SimCore View</h2>
          <p>Browser-side visual twin preview driven by the same authoritative state stream Unreal will consume.</p>
        </div>
        <div className="scene-layer-controls">
          {(Object.keys(layers) as Array<keyof SceneLayers>).map((layer) => (
            <button
              className={layers[layer] ? 'active' : ''}
              key={layer}
              type="button"
              onClick={() => onToggleLayer(layer)}
              aria-pressed={layers[layer]}
            >
              {layer}
            </button>
          ))}
          <span className={`readiness ${ready ? 'ready' : 'blocked'}`}>{ready ? 'ready for UE hookup' : 'blocked prerequisite'}</span>
        </div>
      </div>
      <div className="stream-placeholder">
        <Suspense fallback={<div className="shuttle-scene-loading" />}>
          <ShuttleScene3D
            scenario={scenario}
            state={state}
            layers={layers}
            selectedVehicleId={selectedVehicleId}
          />
        </Suspense>
      </div>
    </section>
  );
}

function TrafficDiagnosticsPanel({ state }: { state: ShuttleSimState | null }) {
  const traffic = state?.traffic;
  const waiting = traffic?.waitingVehicles ?? [];
  const liftPorts = traffic?.liftPorts ?? [];
  const queuedLiftTasks = liftPorts.reduce((sum, port) => sum + port.queueLength, 0);
  const activeLiftPorts = liftPorts.filter((port) => port.activeTaskId).length;

  return (
    <section className="traffic-diagnostics" aria-label="Traffic diagnostics">
      <div>
        <span>Reservations</span>
        <strong>{traffic?.activeReservationCount ?? '--'}</strong>
      </div>
      <div>
        <span>Waiting</span>
        <strong>{waiting.length}</strong>
      </div>
      <div>
        <span>Min separation</span>
        <strong>{traffic?.minVehicleSeparationM === null || traffic?.minVehicleSeparationM === undefined ? '--' : `${traffic.minVehicleSeparationM.toFixed(2)}m`}</strong>
      </div>
      <div>
        <span>Physical violations</span>
        <strong className={traffic?.physicalViolationCount ? 'blocked' : 'ready'}>{traffic?.physicalViolationCount ?? 0}</strong>
      </div>
      <div>
        <span>Port diagnostics</span>
        <strong>{activeLiftPorts}/{liftPorts.length}</strong>
        <small>{queuedLiftTasks} queued</small>
      </div>
      <div className="traffic-wait-list">
        {waiting.length === 0 ? (
          <small>No waiting vehicles</small>
        ) : (
          waiting.map((vehicle) => (
            <small key={vehicle.vehicleId}>
              {vehicle.vehicleId} / {vehicle.waitReason ?? 'blocked'} / {vehicle.blockingVehicleId ?? vehicle.blockingReservationId ?? 'resource'}
            </small>
          ))
        )}
      </div>
      <div className="traffic-lift-list">
        {liftPorts.length === 0 ? (
          <small>No lift ports</small>
        ) : (
          liftPorts.map((port) => (
            <small key={port.nodeId}>
              {port.nodeId} / {port.kind} / q{port.queueLength} / allocated {Math.round(port.utilization * 100)}%
            </small>
          ))
        )}
      </div>
    </section>
  );
}

function FifoInventoryPanel({ scenario, state }: { scenario: ShuttleScenario | null; state: ShuttleSimState | null }) {
  const lanes = useMemo(() => {
    const storageNodes = (scenario?.layout.nodes ?? []).filter((node) => node.type === 'storage');
    const laneByZ = new Map<number, typeof storageNodes>();
    for (const node of storageNodes) {
      const lane = laneByZ.get(node.z) ?? [];
      lane.push(node);
      laneByZ.set(node.z, lane);
    }
    return [...laneByZ.entries()]
      .sort(([leftZ], [rightZ]) => leftZ - rightZ)
      .map(([z, lane]) => ({
        id: `lane-${z}`,
        z,
        cells: lane.sort((left, right) => left.x - right.x || left.id.localeCompare(right.id))
      }));
  }, [scenario]);

  const activeTasks = state?.tasks.filter((task) => task.state !== 'completed' && task.state !== 'failed') ?? [];
  const storedByNode = new Map(
    (state?.loads ?? [])
      .filter((load) => load.state === 'stored' && load.nodeId)
      .map((load) => [load.nodeId!, load])
  );
  const inboundTargets = new Set(
    activeTasks
      .filter((task) => task.kind === 'inbound')
      .map((task) => task.dropoffNodeId)
  );
  const outboundPickups = new Set(
    activeTasks
      .filter((task) => task.kind === 'outbound')
      .map((task) => task.pickupNodeId)
  );
  const storageEmptySec = state?.kpis.blockedTimeByReasonSec['storage-empty'] ?? 0;
  const storageFullSec = state?.kpis.blockedTimeByReasonSec['storage-full'] ?? 0;
  const totalCells = lanes.reduce((sum, lane) => sum + lane.cells.length, 0);
  const occupiedCount = lanes.reduce(
    (sum, lane) => sum + lane.cells.filter((cell) => storedByNode.has(cell.id) || inboundTargets.has(cell.id)).length,
    0
  );

  return (
    <section className="panel fifo-panel" aria-label="FIFO inventory">
      <div className="panel-head">
        <h2>FIFO Inventory</h2>
        <span>{occupiedCount}/{totalCells} cells</span>
      </div>
      <div className="fifo-body">
        <div className="fifo-lanes">
          {lanes.map((lane, laneIndex) => (
            <div className="fifo-lane" key={lane.id}>
              <span className="fifo-lane-label">Row {laneIndex + 1}</span>
              <div className="fifo-cells">
                {lane.cells.map((cell) => {
                  const storedLoad = storedByNode.get(cell.id);
                  const reserved = inboundTargets.has(cell.id);
                  const outbound = outboundPickups.has(cell.id);
                  const status = storedLoad ? 'stored' : reserved ? 'reserved' : 'empty';
                  return (
                    <div className={`fifo-cell ${status} ${outbound ? 'outbound' : ''}`} key={cell.id}>
                      <span>{formatStorageCellLabel(cell.id)}</span>
                      <strong>{storedLoad?.id ?? (reserved ? 'inbound' : '--')}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="fifo-reasons">
          <div>
            <span>Empty wait</span>
            <strong>{formatNumber(storageEmptySec, 1)}s</strong>
          </div>
          <div>
            <span>Full wait</span>
            <strong>{formatNumber(storageFullSec, 1)}s</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function PrerequisitePanel({ report }: { report: PrerequisiteReport | null }) {
  return (
    <section className="panel prereq-panel">
      <div className="panel-head">
        <h2>Mac / UE Gate</h2>
        <span>{report ? new Date(report.checkedAt).toLocaleTimeString() : 'checking'}</span>
      </div>
      {report ? (
        <div className="prereq-grid">
          <div>
            <span>Host</span>
            <strong>{[report.host.modelName, report.host.chip, report.host.memory].filter(Boolean).join(' / ')}</strong>
          </div>
          <div>
            <span>Unreal 5.7.4</span>
            <strong className={report.unreal.status}>{report.unreal.status}</strong>
          </div>
          <div>
            <span>Xcode</span>
            <strong className={report.xcode.status}>{report.xcode.status}</strong>
          </div>
          <div>
            <span>Pixel Streaming</span>
            <strong>{report.pixelStreaming.status}</strong>
          </div>
        </div>
      ) : (
        <p className="muted">Waiting for prerequisite report...</p>
      )}
    </section>
  );
}

function ValidationPanel({
  validation,
  validating,
  onRun
}: {
  validation: Phase0ValidationResult | null;
  validating: boolean;
  onRun: () => void;
}) {
  const seedSweepMaxAccel = validation
    ? Math.max(0, ...validation.seedSweep.runs.map((run) => run.maxObservedAccelerationMps2))
    : 0;
  const longRun = validation?.longRun ?? null;
  const longRunThresholds = longRun?.thresholds ?? null;
  const longRunStatus = (value: boolean | undefined, okLabel: string, blockedLabel: string): string => {
    if (!longRun || value === undefined) return '--';
    return value ? okLabel : blockedLabel;
  };
  const longRunPass = validation
    ? Boolean(
        longRun &&
        validation.acceptance.longRunEventLogsPresent &&
        validation.acceptance.longRunThroughputPositive &&
        validation.acceptance.longRunThroughputFloorMet !== false &&
        validation.acceptance.longRunQueuesBounded &&
        validation.acceptance.noLongRunDeadlocks &&
        validation.acceptance.noLongRunPhysicalSafetyViolations &&
        validation.acceptance.noLongRunReservationCoverageViolations
      )
    : false;

  return (
    <section className="panel validation-panel">
      <div className="panel-head">
        <h2>Validation Gate</h2>
        <button type="button" onClick={onRun} disabled={validating}>{validating ? 'Running' : 'Run'}</button>
      </div>
      {validation ? (
        <div className="validation-grid">
          <div>
            <span>Acceptance</span>
            <strong className={validation.acceptance.pass ? 'ready' : 'blocked'}>{validation.acceptance.pass ? 'pass' : 'fail'}</strong>
          </div>
          <div>
            <span>Same-seed hash</span>
            <strong>{validation.deterministic.pass ? 'stable' : 'unstable'}</strong>
          </div>
          <div>
            <span>Seed sweep PPH</span>
            <strong>{formatNumber(validation.seedSweep.totalPphMean, 1)} avg</strong>
          </div>
          <div>
            <span>Physical safety</span>
            <strong>{validation.acceptance.noPhysicalSafetyViolations ? 'clear' : 'violations'}</strong>
          </div>
          <div>
            <span>Reservation coverage</span>
            <strong>{validation.acceptance.noReservationCoverageViolations ? 'clear' : 'violations'}</strong>
          </div>
          <div>
            <span>Max accel</span>
            <strong>{formatNumber(seedSweepMaxAccel, 2)} m/s2</strong>
          </div>
          <div>
            <span>Hash</span>
            <strong>{validation.deterministic.hashes[0]?.slice(0, 12) ?? '--'}</strong>
          </div>
          <div className="validation-divider">
            <span>Long run</span>
            <strong className={longRunPass ? 'ready' : 'blocked'}>{longRunPass ? 'clear' : 'check'}</strong>
          </div>
          <div>
            <span>Long-run PPH</span>
            <strong>
              {longRun
                ? `${formatNumber(longRun.totalPphMean, 1)} avg / min ${longRunThresholds ? formatNumber(longRunThresholds.minTotalPph, 1) : '--'}`
                : '--'}
            </strong>
          </div>
          <div>
            <span>Queue high water</span>
            <strong>{longRun ? `${longRun.maxQueuedTasks} / ${longRunThresholds?.maxQueuedTasks ?? '--'} tasks` : '--'}</strong>
          </div>
          <div>
            <span>Waiting high water</span>
            <strong>{longRun ? `${longRun.maxWaitingVehicles} / ${longRunThresholds?.maxWaitingVehicles ?? '--'} vehicles` : '--'}</strong>
          </div>
          <div>
            <span>Lift queue high water</span>
            <strong>{longRun ? `${longRun.maxLiftPortQueueLength} / ${longRunThresholds?.maxLiftPortQueueLength ?? '--'} tasks` : '--'}</strong>
          </div>
          <div>
            <span>Long-run deadlocks</span>
            <strong>{longRunStatus(validation.acceptance.noLongRunDeadlocks, 'clear', 'blocked')}</strong>
          </div>
          <div>
            <span>Long-run safety</span>
            <strong>{longRunStatus(validation.acceptance.noLongRunPhysicalSafetyViolations, 'clear', 'violations')}</strong>
          </div>
          <div>
            <span>Long-run coverage</span>
            <strong>{longRunStatus(validation.acceptance.noLongRunReservationCoverageViolations, 'clear', 'violations')}</strong>
          </div>
        </div>
      ) : (
        <p className="muted">Run the deterministic, seed-sweep, and long-run gate before a Pixel Streaming test.</p>
      )}
    </section>
  );
}

export function App() {
  const [scenario, setScenario] = useState<ShuttleScenario | null>(null);
  const [state, setState] = useState<ShuttleSimState | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [prerequisites, setPrerequisites] = useState<PrerequisiteReport | null>(null);
  const [validation, setValidation] = useState<Phase0ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>({ label: 'ready', tone: 'idle' });
  const [playbackSpeed, setPlaybackSpeedState] = useState(1);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [sceneLayers, setSceneLayers] = useState<SceneLayers>({
    traffic: true,
    physics: true,
    loads: true,
    routes: true
  });
  const [isPending, startTransition] = useTransition();
  const reconnectAttemptRef = useRef(0);
  const playbackSpeedChangedRef = useRef(false);

  const kpis = state?.kpis ?? null;
  const vehicles = state?.vehicles ?? [];
  const statusTone = state?.status === 'running' ? 'ok' : state?.status === 'paused' ? 'warn' : 'idle';

  useEffect(() => {
    if (vehicles.length === 0) {
      setSelectedVehicleId(null);
      return;
    }
    if (!selectedVehicleId || !vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) {
      setSelectedVehicleId(vehicles[0]!.id);
    }
  }, [selectedVehicleId, vehicles]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      requestJson<ShuttleScenario>('/api/shuttle/scenario'),
      requestJson<ShuttleSimState>('/api/shuttle/state'),
      requestJson<PrerequisiteReport>('/api/shuttle/prerequisites'),
      requestJson<PlaybackSpeedResponse>('/api/shuttle/playbackSpeed')
    ])
      .then(([nextScenario, nextState, report, speedReport]) => {
        if (cancelled) return;
        setScenario(nextScenario);
        setState(nextState);
        setEvents(nextState.recentEvents);
        setPrerequisites(report);
        if (!playbackSpeedChangedRef.current) {
          setPlaybackSpeedState(speedReport.speed);
        }
      })
      .catch((error) => setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(websocketUrl());
      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data as string) as ShuttleStreamMessage;
        if (message.type === 'connectionRecovered' || message.type === 'simState') {
          startTransition(() => {
            setState(message.state);
            setEvents(message.state.recentEvents);
          });
        }
        if (message.type === 'vehicleState') {
          startTransition(() => {
            setState((previous) => mergeVehicleStateUpdate(previous, message.vehicles, message.simTimeSec));
          });
        }
        if (message.type === 'kpiUpdate') {
          startTransition(() => {
            setState((previous) => mergeKpiUpdate(previous, message.kpis, message.simTimeSec));
          });
        }
        if (message.type === 'taskEvent') {
          setEvents((previous) => mergeEvents(previous, message.events));
        }
        if (message.type === 'error') {
          setCommandStatus({ label: message.message, tone: 'error' });
        }
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        reconnectAttemptRef.current += 1;
        const delay = Math.min(4000, 400 * reconnectAttemptRef.current);
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const paramValues = useMemo(() => {
    if (!scenario) return new Map<string, number>();
    return new Map(CONTROLLED_PARAMS.map((param) => [param.path, Number(getPointerValue(scenario, param.path) ?? 0)]));
  }, [scenario]);

  async function postCommand(path: string, body: unknown = {}): Promise<void> {
    const startedAt = performance.now();
    setCommandStatus({ label: 'sending command...', tone: 'idle' });
    try {
      const response = await requestJson<{ state?: ShuttleSimState; result?: unknown }>(path, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (response.state) {
        setState(response.state);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `ack ${elapsedMs} ms`, tone: 'ok' });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  async function updateParam(path: string, value: number): Promise<void> {
    setScenario((previous) => {
      if (!previous) return previous;
      return structuredClone(previous);
    });
    await postCommand('/api/shuttle/setParam', { path, value });
    const nextScenario = await requestJson<ShuttleScenario>('/api/shuttle/scenario');
    setScenario(nextScenario);
  }

  async function setPlaybackSpeed(speed: number): Promise<void> {
    playbackSpeedChangedRef.current = true;
    setPlaybackSpeedState(speed);
    const startedAt = performance.now();
    setCommandStatus({ label: 'sending command...', tone: 'idle' });
    try {
      const response = await requestJson<PlaybackSpeedResponse & { state?: ShuttleSimState }>('/api/shuttle/playbackSpeed', {
        method: 'POST',
        body: JSON.stringify({ speed })
      });
      setPlaybackSpeedState(response.speed);
      if (response.state) {
        setState(response.state);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `ack ${elapsedMs} ms`, tone: 'ok' });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  async function runValidation(): Promise<void> {
    setValidating(true);
    setCommandStatus({ label: 'running validation...', tone: 'idle' });
    try {
      const response = await requestJson<{ validation: Phase0ValidationResult }>('/api/shuttle/validatePhase0', {
        method: 'POST',
        body: JSON.stringify({ durationSec: 180, longRunDurationSec: 600, repeatCount: 3 })
      });
      setValidation(response.validation);
      setCommandStatus({
        label: response.validation.acceptance.pass ? 'validation passed' : 'validation failed',
        tone: response.validation.acceptance.pass ? 'ok' : 'warn'
      });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setValidating(false);
    }
  }

  function toggleSceneLayer(layer: keyof SceneLayers): void {
    setSceneLayers((current) => ({
      ...current,
      [layer]: !current[layer]
    }));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="mark" aria-hidden="true">S0</div>
          <div>
            <h1>Shuttle Phase 0</h1>
            <p>Authoritative SimCore protocol with Unreal visual twin hook points.</p>
          </div>
        </div>

        <section className="control-block">
          <div className="run-row">
            <button type="button" onClick={() => postCommand('/api/shuttle/resume')}>Resume</button>
            <button type="button" onClick={() => postCommand('/api/shuttle/pause')}>Pause</button>
            <button type="button" onClick={() => postCommand('/api/shuttle/reset', { seed: state?.seed })}>Reset</button>
          </div>
          <div className="speed-row" aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map((speed) => (
              <button
                className={playbackSpeed === speed ? 'active' : ''}
                key={speed}
                type="button"
                onClick={() => setPlaybackSpeed(speed)}
                aria-pressed={playbackSpeed === speed}
              >
                {speed}x
              </button>
            ))}
          </div>
          <div className={`status-line ${commandStatus.tone}`}>
            <span>{state?.status ?? 'loading'}</span>
            <strong>{commandStatus.label} / {playbackSpeed}x{isPending ? ' / rendering' : ''}</strong>
          </div>
        </section>

        <section className="control-block param-block">
          <h2>Scenario Parameters</h2>
          {CONTROLLED_PARAMS.map((param) => {
            const value = paramValues.get(param.path) ?? 0;
            return (
              <label key={param.path}>
                <span>
                  {param.label}
                  <strong>{formatNumber(value, 2)} {param.unit}</strong>
                </span>
                <input
                  type="range"
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={value}
                  onChange={(event) => updateParam(param.path, Number(event.currentTarget.value))}
                />
              </label>
            );
          })}
        </section>

        <PrerequisitePanel report={prerequisites} />
        <ValidationPanel validation={validation} validating={validating} onRun={runValidation} />
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="caption">SimCore / WCS-lite is source of truth</p>
            <h2>{scenario?.name ?? 'Phase 0 Scenario'}</h2>
          </div>
          <div className={`runtime-badge ${statusTone}`}>
            <span>{formatClock(state?.simTimeSec ?? 0)}</span>
            <strong>{state ? `${Math.round((state.simTimeSec / state.durationSec) * 100)}%` : '--'}</strong>
          </div>
        </header>

        <StreamingPane
          prerequisites={prerequisites}
          scenario={scenario}
          state={state}
          layers={sceneLayers}
          selectedVehicleId={selectedVehicleId}
          onToggleLayer={toggleSceneLayer}
        />
        <KpiStrip kpis={kpis} />
        <TrafficDiagnosticsPanel state={state} />
        <FifoInventoryPanel scenario={scenario} state={state} />
        <div className="main-grid">
          <VehicleTable
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={setSelectedVehicleId}
          />
          <EventLog events={events} />
        </div>
      </section>
    </main>
  );
}
