import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const currentPath = resolve('config/shuttle/customer-site-calibration.current-review.json');
const reviewPath = resolve('output/review/shuttle-des-review-24h-vv.json');
const failures: string[] = [];
const checks: Array<{ check: string; status: 'pass' | 'fail'; detail: string }> = [];
const workDir = mkdtempSync(join(tmpdir(), 'shuttle-site-readiness-'));

try {
  const blockedOutput = runReadiness(currentPath, 'current-review');
  expect(
    'current-review-blocked',
    blockedOutput.decision === 'blocked-by-site-data' && blockedOutput.counts.blocked > 0,
    `decision=${blockedOutput.decision}, blocked=${blockedOutput.counts.blocked}`
  );

  const readyFixturePath = join(workDir, 'ready-site-calibration.json');
  writeFileSync(readyFixturePath, `${JSON.stringify(buildReadyCalibrationFixture(), null, 2)}\n`);
  const readyOutput = runReadiness(readyFixturePath, 'ready-fixture');
  expect(
    'ready-fixture-ready',
    readyOutput.decision === 'ready-for-site-comparison' && readyOutput.counts.ready === 10 && readyOutput.counts.blocked === 0,
    `decision=${readyOutput.decision}, ready=${readyOutput.counts.ready}, blocked=${readyOutput.counts.blocked}`
  );

  const thresholdFailFixture = buildReadyCalibrationFixture();
  thresholdFailFixture.acceptanceThresholds.totalPphTarget = 999;
  const thresholdFailPath = join(workDir, 'threshold-fail-site-calibration.json');
  writeFileSync(thresholdFailPath, `${JSON.stringify(thresholdFailFixture, null, 2)}\n`);
  const thresholdFailOutput = runReadiness(thresholdFailPath, 'threshold-fail-fixture');
  const comparison = thresholdFailOutput.rows.find((row) => row.id === '24h-result-threshold-comparison');
  expect(
    'threshold-fail-partial',
    thresholdFailOutput.decision === 'blocked-by-site-data' && comparison?.status === 'partial',
    `decision=${thresholdFailOutput.decision}, comparison=${comparison?.status ?? 'missing'}`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(JSON.stringify({ type: 'site-validation-readiness-verify-failed', failures, checks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ type: 'site-validation-readiness-verify-complete', failures: 0, checks }, null, 2));

type ReadinessOutput = {
  decision: string;
  counts: { ready: number; partial: number; blocked: number };
  rows: Array<{ id: string; status: string }>;
};

type CalibrationFixture = ReturnType<typeof buildReadyCalibrationFixture>;

function runReadiness(inputPath: string, label: string): ReadinessOutput {
  const outJson = join(workDir, `${label}.json`);
  const outHtml = join(workDir, `${label}.html`);
  const result = spawnSync('pnpm', [
    'exec',
    'tsx',
    'scripts/build-site-validation-readiness.ts',
    inputPath,
    '--review',
    reviewPath,
    '--out-json',
    outJson,
    '--html',
    outHtml
  ], { cwd: resolve('.'), encoding: 'utf8' });
  if (result.error) {
    fail(label, result.error.message);
    return emptyOutput();
  }
  if (result.status !== 0) {
    fail(label, `${result.stderr}\n${result.stdout}`.trim());
    return emptyOutput();
  }
  return JSON.parse(readFileSync(outJson, 'utf8')) as ReadinessOutput;
}

function buildReadyCalibrationFixture() {
  const demandRows = Array.from({ length: 24 }, (_, index) => ({
    startIso: `2026-06-01T${String(index).padStart(2, '0')}:00:00-07:00`,
    endIso: `2026-06-01T${String(index + 1).padStart(2, '0')}:00:00-07:00`,
    inboundArrivals: 120,
    inboundCompleted: 119,
    outboundRequested: 118,
    outboundCompleted: 116,
    notes: 'fixture row for readiness verification'
  }));
  return {
    schemaVersion: 'shuttle.customerSiteCalibration.v1',
    status: 'customer-site-ready-fixture',
    site: {
      customerName: 'Fixture Customer',
      facilityName: 'Fixture Facility',
      timezone: 'America/Los_Angeles',
      coordinateSystem: 'fixture CAD coordinates in mm',
      preparedBy: 'readiness self-test',
      preparedAtIso: '2026-06-08T00:00:00-07:00'
    },
    demandProfile: {
      grain: 'hour',
      source: 'fixture WCS/MES task export',
      units: 'loads/hour',
      rows: demandRows
    },
    liftCycle: {
      source: 'fixture PLC timestamps',
      units: 'seconds',
      ports: [
        liftPort('in-01', 'inbound'),
        liftPort('out-01', 'outbound')
      ]
    },
    shuttleMotion: {
      source: 'fixture vendor motion spec',
      units: { speed: 'm/s', acceleration: 'm/s^2', dwell: 'seconds', tolerance: 'mm' },
      loadedSpeedMps: 1.5,
      emptySpeedMps: 2,
      accelerationMps2: 0.6,
      decelerationMps2: 0.6,
      turnDwellSec: 1,
      reverseDwellSec: 1.2,
      positionToleranceMm: 10,
      notes: 'fixture numeric motion profile'
    },
    layoutDimensions: {
      source: 'fixture customer CAD',
      units: 'mm',
      storagePitchX: 1250,
      storagePitchZ: 1350,
      aisleCenterSpacing: 1800,
      liftPorts: [
        { portId: 'in-01', x: 1000, z: 1000, direction: 'inbound', notes: 'fixture inbound lift' },
        { portId: 'out-01', x: 8000, z: 1000, direction: 'outbound', notes: 'fixture outbound lift' }
      ],
      parkingNodes: [
        { nodeId: 'park-01', x: 2000, z: 1200, notes: 'fixture parking node' },
        { nodeId: 'park-02', x: 7000, z: 1200, notes: 'fixture parking node' }
      ]
    },
    loadAndClearanceEnvelope: {
      source: 'fixture vendor drawings',
      units: 'mm',
      loadFootprintX: 1200,
      loadFootprintZ: 1000,
      loadOverhangX: 50,
      loadOverhangZ: 50,
      shuttleFootprintX: 1350,
      shuttleFootprintZ: 1100,
      rollerTransferFootprintX: 1450,
      rollerTransferFootprintZ: 1150,
      requiredClearance: 100,
      notes: 'fixture clearance standard'
    },
    blockedCellsAndNoDriveZones: {
      source: 'fixture CAD/site survey',
      blockedCells: [
        { cellId: 'B-001', reason: 'structural column', notes: 'fixture blocked cell' }
      ],
      noDriveRectangles: [
        { zoneId: 'ND-001', minX: 4000, maxX: 4500, minZ: 2000, maxZ: 2500, reason: 'maintenance access' }
      ]
    },
    controlPolicy: {
      source: 'fixture WCS/WES rules',
      dispatchPriority: 'oldest-task-first-with-direction-balance',
      storageAssignmentRule: 'nearest-valid-storage-column',
      retrievalRule: 'fifo-with-lift-balance',
      liftQueueCapacity: 4,
      sourceBufferCapacity: 4,
      maxConcurrentReleasedTasks: 6,
      repositionPolicy: 'return-to-nearest-park-node',
      notes: 'fixture controls policy'
    },
    visualValidationSamples: [
      visualSample('clip-001'),
      visualSample('clip-002'),
      visualSample('clip-003')
    ],
    acceptanceThresholds: {
      source: 'fixture signed review threshold',
      inboundPphTarget: 100,
      outboundPphTarget: 100,
      totalPphTarget: 200,
      maxWaitingSharePct: 10,
      maxRepositionSharePct: 12,
      acceptableLiftUtilizationRangePct: { min: 40, max: 90 },
      notes: 'fixture thresholds that current 24h report should pass'
    }
  };
}

function liftPort(portId: string, direction: string): Record<string, unknown> {
  return {
    portId,
    direction,
    sampleCount: 60,
    pickupLiftP50Sec: 30,
    pickupLiftP95Sec: 36,
    dropLowerP50Sec: 30,
    dropLowerP95Sec: 36,
    bufferReleaseP50Sec: 4,
    bufferReleaseP95Sec: 8,
    notes: 'fixture PLC sample'
  };
}

function visualSample(sampleId: string): Record<string, unknown> {
  return {
    sampleId,
    videoFileOrUrl: `fixture://${sampleId}.mp4`,
    taskId: `task-${sampleId}`,
    eventTimestampIso: '2026-06-01T12:00:00-07:00',
    expectedObservation: 'vehicle arrival, lift action, load attach/detach, and departure',
    notes: 'fixture visual validation sample'
  };
}

function emptyOutput(): ReadinessOutput {
  return { decision: 'missing', counts: { ready: 0, partial: 0, blocked: 0 }, rows: [] };
}

function expect(check: string, condition: boolean, detail: string): void {
  if (condition) {
    checks.push({ check, status: 'pass', detail });
  } else {
    fail(check, detail);
  }
}

function fail(check: string, detail: string): void {
  checks.push({ check, status: 'fail', detail });
  failures.push(`${check}: ${detail}`);
}
