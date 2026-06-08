import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const reviewJobs: Array<{ label: string; args: string[] }> = [
  {
    label: '24h DES V&V report',
    args: [
      'exec',
      'tsx',
      'scripts/review-des-audit.ts',
      '--hours',
      '24',
      '--out',
      'output/review/shuttle-des-review-24h-vv.json',
      '--html',
      'output/review/shuttle-des-review-24h-vv.html'
    ]
  },
  {
    label: '7d DES V&V report',
    args: [
      'exec',
      'tsx',
      'scripts/review-des-audit.ts',
      '--hours',
      '168',
      '--out',
      'output/review/shuttle-des-review-7d-vv.json',
      '--html',
      'output/review/shuttle-des-review-7d-vv.html'
    ]
  },
  {
    label: 'Review data CSV export',
    args: ['run', 'shuttle:review-data']
  },
  {
    label: 'Site calibration gap report',
    args: ['run', 'shuttle:site-gap']
  },
  {
    label: 'Site validation readiness gate',
    args: ['run', 'shuttle:site-readiness']
  },
  {
    label: 'Review pack hub',
    args: ['run', 'shuttle:review-index']
  },
  {
    label: 'Dashboard review evidence verification',
    args: ['run', 'shuttle:dashboard-evidence-verify']
  },
  {
    label: 'Review pack verification',
    args: ['run', 'shuttle:review-verify']
  }
];

for (const job of reviewJobs) {
  console.log(`\n[review-pack] ${job.label}`);
  const result = spawnSync('pnpm', job.args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`[review-pack] ${job.label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[review-pack] ${job.label} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const outputs = [
  resolve('output/review/shuttle-des-review-24h-vv.json'),
  resolve('output/review/shuttle-des-review-7d-vv.json'),
  resolve('output/review/site-calibration-gap.html'),
  resolve('output/review/site-validation-readiness.html'),
  resolve('output/review/index.html')
];
const missing = outputs.filter((output) => !existsSync(output));
if (missing.length > 0) {
  console.error(`[review-pack] Missing expected outputs:\n${missing.join('\n')}`);
  process.exit(1);
}

const twentyFourHour = readReviewJson(resolve('output/review/shuttle-des-review-24h-vv.json'));
const sevenDay = readReviewJson(resolve('output/review/shuttle-des-review-7d-vv.json'));
console.log(JSON.stringify({
  type: 'review-pack-complete',
  indexHtml: resolve('output/review/index.html'),
  reports: [
    summarize('24h', twentyFourHour),
    summarize('7d', sevenDay)
  ]
}, null, 2));

type ReviewJson = {
  result: {
    totalPph: number;
    inboundPph: number;
    outboundPph: number;
    completedInbound: number;
    completedOutbound: number;
    averageWaitingPct: number;
    averageRepositionPct: number;
    routeModel: { routeUnavailableCount: number };
  };
  dataIntegrity: Array<{ status: string }>;
  physicalAudit: {
    contract: { status: string };
    liveness: { status: string };
  };
};

function readReviewJson(path: string): ReviewJson {
  return JSON.parse(readFileSync(path, 'utf8')) as ReviewJson;
}

function summarize(label: string, report: ReviewJson): Record<string, unknown> {
  return {
    label,
    totalPph: report.result.totalPph,
    inboundPph: report.result.inboundPph,
    outboundPph: report.result.outboundPph,
    completedInbound: report.result.completedInbound,
    completedOutbound: report.result.completedOutbound,
    waitingPct: report.result.averageWaitingPct,
    repositionPct: report.result.averageRepositionPct,
    routeMisses: report.result.routeModel.routeUnavailableCount,
    physicalGate: `${report.physicalAudit.contract.status}/${report.physicalAudit.liveness.status}`,
    dataIntegrityFails: report.dataIntegrity.filter((check) => check.status === 'fail').length
  };
}
