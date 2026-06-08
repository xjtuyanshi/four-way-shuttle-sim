import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type MarkerCheck = {
  file: string;
  markers: string[];
};

type ScreenshotCheck = {
  path: string;
  minBytes: number;
};

const sourceChecks: MarkerCheck[] = [
  {
    file: 'apps/shuttle-dashboard/src/App.tsx',
    markers: [
      'DesAnswerFirstPanel',
      'DesPeriodPphPanel',
      'DesDataIntegrityPanel',
      'DesReviewReadinessPanel',
      'DesIeFindingsPanel',
      'DesDispatchAvoidanceAuditPanel',
      'buildDesDispatchAuditRows',
      'DesReservationReplayPanel',
      'buildDesIntegrityChecks',
      'des-route-bottleneck',
      'Top bottleneck',
      'Review Boundary',
      'Site Calibration',
      'Window PPH =',
      'Waiting Share =',
      'liveTrendMarkers',
      'LiveTrendMarker',
      'Lowest total',
      'Peak waiting',
      'samples since reset',
      'Review Cockpit',
      'buildReviewTrafficReadouts',
      'DES Avoidance Live',
      'Customer review live cockpit',
      'buildReviewDesEvidence',
      'DES Task Evidence',
      'Task-level reservation replay summary'
    ]
  },
  {
    file: 'apps/shuttle-dashboard/src/styles.css',
    markers: [
      '.des-answer-panel',
      '.des-hourly-panel',
      '.des-integrity-panel',
      '.des-readiness-panel',
      '.des-findings-panel',
      '.des-dispatch-audit-panel',
      '.des-route-bottleneck',
      '.live-trend-marker-grid',
      '.live-trend-marker',
      '.review-cockpit-panel',
      '.review-traffic-card',
      '.review-des-panel',
      '.review-des-card'
    ]
  }
];

const screenshotChecks: ScreenshotCheck[] = [
  { path: 'output/review/screenshots/dashboard-answer-first-panel.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-review-readiness-panel.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-des-period-pph-panel-focused.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-des-data-integrity-panel-clean.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-des-ie-findings-panel-final.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-des-dispatch-audit-panel-tall.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-des-replay-bottleneck-highlight-final.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-3d-after-trend-wait-summary.png', minBytes: 20_000 },
  { path: 'output/review/screenshots/dashboard-review-cockpit-3d-des-evidence.png', minBytes: 20_000 }
];

const failures: string[] = [];
const checks: Array<{ type: string; target: string; status: 'pass' | 'fail'; detail?: string }> = [];

for (const check of sourceChecks) {
  const absolutePath = resolve(check.file);
  if (!existsSync(absolutePath)) {
    fail('source', check.file, 'missing source file');
    continue;
  }
  const text = readFileSync(absolutePath, 'utf8');
  for (const marker of check.markers) {
    if (text.includes(marker)) {
      pass('source-marker', `${check.file} :: ${marker}`);
    } else {
      fail('source-marker', `${check.file} :: ${marker}`, 'marker not found');
    }
  }
}

for (const screenshot of screenshotChecks) {
  const absolutePath = resolve(screenshot.path);
  if (!existsSync(absolutePath)) {
    fail('screenshot', screenshot.path, 'missing screenshot');
    continue;
  }
  const bytes = statSync(absolutePath).size;
  if (bytes >= screenshot.minBytes) {
    pass('screenshot', screenshot.path, `${bytes} bytes`);
  } else {
    fail('screenshot', screenshot.path, `${bytes} bytes is below ${screenshot.minBytes}`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ type: 'dashboard-review-evidence-verify-failed', failures, checks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ type: 'dashboard-review-evidence-verify-complete', failures: 0, checks }, null, 2));

function pass(type: string, target: string, detail?: string): void {
  checks.push({ type, target, status: 'pass', detail });
}

function fail(type: string, target: string, detail: string): void {
  checks.push({ type, target, status: 'fail', detail });
  failures.push(`${target}: ${detail}`);
}
