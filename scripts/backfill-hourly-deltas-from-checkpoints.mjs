import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [inputPathArg, outputPathArg] = process.argv.slice(2);
if (!inputPathArg || !outputPathArg) {
  throw new Error('Usage: node scripts/backfill-hourly-deltas-from-checkpoints.mjs <audit.json> <out.json>');
}

const inputPath = resolve(inputPathArg);
const outputPath = resolve(outputPathArg);
const audit = readJson(inputPath);
const baseDir = dirname(inputPath);

const checkpoints = new Map();
for (const checkpoint of audit.checkpoints ?? []) {
  if (typeof checkpoint?.timeSec !== 'number' || typeof checkpoint?.path !== 'string') {
    continue;
  }
  if (checkpoints.has(checkpoint.timeSec)) {
    continue;
  }
  checkpoints.set(checkpoint.timeSec, readJson(resolveMaybeRelative(checkpoint.path, baseDir)));
}

let previousBlockedReasons = new Map();
const backfilledHourly = (audit.hourlyPph ?? []).map((row) => {
  const checkpoint = checkpoints.get(row.timeSec);
  if (!checkpoint) {
    return row;
  }
  const blockedReasons = checkpoint.kpis?.blockedTimeByReasonSec ?? {};
  const nextRow = {
    ...row,
    activeTasks: checkpoint.kpis?.activeTasks ?? row.activeTasks ?? 0,
    queuedTasks: checkpoint.kpis?.queuedTasks ?? row.queuedTasks ?? 0,
    hourlyBlockedReasons: hourlyBlockedReasonDeltas(blockedReasons, previousBlockedReasons),
    taskStates: taskStateCounts(checkpoint.tasks ?? []),
    taskWaitReasons: taskWaitReasonCounts(checkpoint.tasks ?? [])
  };
  previousBlockedReasons = new Map(Object.entries(blockedReasons));
  return nextRow;
});

const output = {
  ...audit,
  hourlyPph: backfilledHourly,
  backfillNotes: [
    ...(Array.isArray(audit.backfillNotes) ? audit.backfillNotes : []),
    'Hourly blocked reason deltas and task-state counts were backfilled from compact hourly checkpoints.'
  ]
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  inputPath,
  outputPath,
  hourlyRows: backfilledHourly.length,
  backfilledRows: backfilledHourly.filter((row) => Array.isArray(row.hourlyBlockedReasons)).length
}, null, 2));

function hourlyBlockedReasonDeltas(current, previous) {
  const reasons = new Set([...Object.keys(current), ...previous.keys()]);
  return [...reasons]
    .map((reason) => ({
      reason,
      sec: round((current[reason] ?? 0) - (previous.get(reason) ?? 0), 3)
    }))
    .filter((row) => row.sec > 1e-9)
    .sort((left, right) => right.sec - left.sec || left.reason.localeCompare(right.reason))
    .slice(0, 12);
}

function taskStateCounts(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    if (task.state === 'completed' || task.state === 'failed') {
      continue;
    }
    counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([state, count]) => ({ state, count }));
}

function taskWaitReasonCounts(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    if (task.state === 'completed' || task.state === 'failed' || !task.waitReason) {
      continue;
    }
    counts.set(task.waitReason, (counts.get(task.waitReason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveMaybeRelative(path, baseDir) {
  if (path.startsWith('/')) {
    return path;
  }
  return resolve(baseDir, path);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
