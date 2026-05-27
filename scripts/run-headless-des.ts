import { writeFileSync } from 'node:fs';

import { createInboundOutboundDemoScenario, runHeadlessDes } from '../packages/shuttle-sim-core/src/index.ts';

const durationSec = durationArg();
const regionCount = integerArg('--regions', 2);
const shuttleCount = integerArg('--shuttles', 8);
const inboundRatePerHour = numberArg('--inbound-pph', 3600);
const outboundRatePerHour = numberArg('--outbound-pph', 3600);
const initialOutboundFullColumns = integerArg('--outbound-full-columns', 4);
const sampleIntervalSec = numberArg('--sample-sec', 3600);
const outputPath = stringArg('--out');

const scenario = createInboundOutboundDemoScenario({
  durationSec,
  vehicles: { count: shuttleCount },
  taskGeneration: {
    inboundRatePerHour,
    outboundRatePerHour,
    inboundOutboundMix: inboundRatePerHour + outboundRatePerHour > 0
      ? inboundRatePerHour / (inboundRatePerHour + outboundRatePerHour)
      : 0.5,
    initialOutboundFullColumns
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: regionCount
  }
});

const result = runHeadlessDes({ scenario, durationSec, sampleIntervalSec });
const json = JSON.stringify(result, null, 2);
if (outputPath) {
  writeFileSync(outputPath, `${json}\n`);
} else {
  console.log(json);
}

function durationArg(): number {
  const days = numberArg('--days', NaN);
  if (Number.isFinite(days)) {
    return days * 24 * 3600;
  }
  const hours = numberArg('--hours', NaN);
  if (Number.isFinite(hours)) {
    return hours * 3600;
  }
  return numberArg('--duration-sec', 6 * 3600);
}

function valueAfter(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function numberArg(name: string, fallback: number): number {
  const value = valueAfter(name);
  if (value === null || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerArg(name: string, fallback: number): number {
  return Math.max(0, Math.round(numberArg(name, fallback)));
}

function stringArg(name: string): string | null {
  const value = valueAfter(name);
  return value && value.trim() !== '' ? value : null;
}
