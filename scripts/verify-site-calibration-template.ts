import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inputPath = resolve(process.argv[2] ?? 'config/shuttle/customer-site-calibration.template.json');
const failures: string[] = [];
const warnings: string[] = [];

if (!existsSync(inputPath)) {
  fail(`missing calibration file: ${inputPath}`);
} else {
  const payload = JSON.parse(readFileSync(inputPath, 'utf8')) as Record<string, unknown>;
  requireString(payload, 'schemaVersion');
  requireString(payload, 'status');
  requireObject(payload, 'site');
  requireObject(payload, 'demandProfile');
  requireObject(payload, 'liftCycle');
  requireObject(payload, 'shuttleMotion');
  requireObject(payload, 'layoutDimensions');
  requireObject(payload, 'loadAndClearanceEnvelope');
  requireObject(payload, 'blockedCellsAndNoDriveZones');
  requireObject(payload, 'controlPolicy');
  requireArray(payload, 'visualValidationSamples');
  requireObject(payload, 'acceptanceThresholds');

  const demandProfile = objectAt(payload, 'demandProfile');
  requireString(demandProfile, 'grain');
  requireString(demandProfile, 'source');
  requireString(demandProfile, 'units');
  requireArray(demandProfile, 'rows');
  requireExampleRow(demandProfile, 'rows', ['startIso', 'endIso', 'inboundArrivals', 'inboundCompleted', 'outboundRequested', 'outboundCompleted']);

  const liftCycle = objectAt(payload, 'liftCycle');
  requireString(liftCycle, 'source');
  requireString(liftCycle, 'units');
  requireArray(liftCycle, 'ports');
  requireExampleRow(liftCycle, 'ports', ['portId', 'direction', 'sampleCount', 'pickupLiftP50Sec', 'pickupLiftP95Sec', 'dropLowerP50Sec', 'dropLowerP95Sec']);

  const shuttleMotion = objectAt(payload, 'shuttleMotion');
  requireObject(shuttleMotion, 'units');
  for (const key of ['loadedSpeedMps', 'emptySpeedMps', 'accelerationMps2', 'decelerationMps2', 'turnDwellSec', 'reverseDwellSec', 'positionToleranceMm']) {
    requireKey(shuttleMotion, key);
  }

  const layout = objectAt(payload, 'layoutDimensions');
  for (const key of ['storagePitchX', 'storagePitchZ', 'aisleCenterSpacing']) requireKey(layout, key);
  requireArray(layout, 'liftPorts');
  requireArray(layout, 'parkingNodes');
  requireExampleRow(layout, 'liftPorts', ['portId', 'x', 'z', 'direction']);
  requireExampleRow(layout, 'parkingNodes', ['nodeId', 'x', 'z']);

  const envelope = objectAt(payload, 'loadAndClearanceEnvelope');
  for (const key of ['loadFootprintX', 'loadFootprintZ', 'shuttleFootprintX', 'shuttleFootprintZ', 'requiredClearance']) requireKey(envelope, key);

  const blocked = objectAt(payload, 'blockedCellsAndNoDriveZones');
  requireArray(blocked, 'blockedCells');
  requireArray(blocked, 'noDriveRectangles');

  const control = objectAt(payload, 'controlPolicy');
  for (const key of ['dispatchPriority', 'storageAssignmentRule', 'retrievalRule', 'liftQueueCapacity', 'sourceBufferCapacity', 'maxConcurrentReleasedTasks', 'repositionPolicy']) requireKey(control, key);

  requireExampleRow(payload, 'visualValidationSamples', ['sampleId', 'videoFileOrUrl', 'taskId', 'eventTimestampIso', 'expectedObservation']);

  const thresholds = objectAt(payload, 'acceptanceThresholds');
  for (const key of ['inboundPphTarget', 'outboundPphTarget', 'totalPphTarget', 'maxWaitingSharePct', 'maxRepositionSharePct', 'acceptableLiftUtilizationRangePct']) requireKey(thresholds, key);

  const nullCount = countNullish(payload);
  if (payload.status === 'template' && nullCount === 0) warnings.push('template status has no placeholder nulls');
  if (payload.status !== 'template' && nullCount > 0) warnings.push(`non-template calibration still has ${nullCount} placeholder null value(s)`);
}

if (failures.length > 0) {
  console.error(JSON.stringify({ type: 'site-calibration-template-verify-failed', inputPath, failures, warnings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ type: 'site-calibration-template-verify-complete', inputPath, failures: 0, warnings }, null, 2));

function requireKey(parent: Record<string, unknown>, key: string): void {
  if (!(key in parent)) fail(`missing key: ${key}`);
}

function requireString(parent: Record<string, unknown>, key: string): void {
  requireKey(parent, key);
  if (key in parent && typeof parent[key] !== 'string') fail(`${key} must be a string`);
}

function requireObject(parent: Record<string, unknown>, key: string): void {
  requireKey(parent, key);
  if (key in parent && !isPlainObject(parent[key])) fail(`${key} must be an object`);
}

function requireArray(parent: Record<string, unknown>, key: string): void {
  requireKey(parent, key);
  if (key in parent && !Array.isArray(parent[key])) fail(`${key} must be an array`);
}

function requireExampleRow(parent: Record<string, unknown>, arrayKey: string, keys: string[]): void {
  const rows = parent[arrayKey];
  if (!Array.isArray(rows) || rows.length === 0) {
    fail(`${arrayKey} must include at least one template row`);
    return;
  }
  const row = rows[0];
  if (!isPlainObject(row)) {
    fail(`${arrayKey}[0] must be an object`);
    return;
  }
  for (const key of keys) {
    if (!(key in row)) fail(`${arrayKey}[0] missing key: ${key}`);
  }
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countNullish(value: unknown): number {
  if (value === null) return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNullish(item), 0);
  if (isPlainObject(value)) return Object.values(value).reduce((sum, item) => sum + countNullish(item), 0);
  return 0;
}

function fail(message: string): void {
  failures.push(message);
}
