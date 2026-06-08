import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const jobs: Array<{ label: string; args: string[] }> = [
  {
    label: 'TypeScript typecheck',
    args: ['-r', '--if-present', 'typecheck']
  },
  {
    label: 'Review pack artifact verification',
    args: ['run', 'shuttle:review-verify']
  },
  {
    label: 'Dashboard evidence verification',
    args: ['run', 'shuttle:dashboard-evidence-verify']
  },
  {
    label: 'Site calibration template verification',
    args: ['run', 'shuttle:site-template-verify']
  },
  {
    label: 'Current review calibration verification',
    args: ['run', 'shuttle:site-current-verify']
  },
  {
    label: 'Site validation readiness gate',
    args: ['run', 'shuttle:site-readiness']
  },
  {
    label: 'Site validation readiness self-test',
    args: ['run', 'shuttle:site-readiness-verify']
  },
  {
    label: 'Live dashboard/API environment verification',
    args: ['run', 'shuttle:live-env-verify']
  }
];

for (const job of jobs) {
  console.log(`\n[review-preflight] ${job.label}`);
  const result = spawnSync('pnpm', job.args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`[review-preflight] ${job.label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[review-preflight] ${job.label} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const twentyFourHourPath = resolve('output/review/shuttle-des-review-24h-vv.json');
const sevenDayPath = resolve('output/review/shuttle-des-review-7d-vv.json');
const issueRegisterPath = resolve('output/review/data/review-issue-register.json');
const siteGapPath = resolve('output/review/site-calibration-gap.json');
const siteReadinessPath = resolve('output/review/site-validation-readiness.json');

const missing = [twentyFourHourPath, sevenDayPath, issueRegisterPath, siteGapPath, siteReadinessPath].filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(JSON.stringify({ type: 'review-preflight-missing-artifacts', missing }, null, 2));
  process.exit(1);
}

const twentyFourHour = readJson<ReviewReport>(twentyFourHourPath);
const sevenDay = readJson<ReviewReport>(sevenDayPath);
const issueRegister = readJson<{ rows: Array<{ severity: string; category: string }> }>(issueRegisterPath);
const siteGap = readJson<{ counts: { needsSiteData: number; internalAssumption: number; readyForComparison: number } }>(siteGapPath);
const siteReadiness = readJson<{ decision: string; counts: { ready: number; partial: number; blocked: number } }>(siteReadinessPath);

const summary = {
  type: 'review-preflight-complete',
  generatedAtIso: new Date().toISOString(),
  failures: 0,
  links: {
    dashboard: process.env.SHUTTLE_DASHBOARD_URL ?? 'http://127.0.0.1:5190/',
    reviewHub: 'http://127.0.0.1:8123/index.html',
    apiHealth: `${process.env.SHUTTLE_API_URL ?? 'http://127.0.0.1:8791'}/api/shuttle/health`
  },
  reports: [
    summarizeReport('24h', twentyFourHour),
    summarizeReport('7d', sevenDay)
  ],
  issueRegister: {
    rows: issueRegister.rows.length,
    needsSiteData: issueRegister.rows.filter((row) => row.severity === 'needs-site-data').length,
    watch: issueRegister.rows.filter((row) => row.severity === 'watch').length,
    categories: [...new Set(issueRegister.rows.map((row) => row.category))].sort()
  },
  siteGap: siteGap.counts,
  siteReadiness: {
    decision: siteReadiness.decision,
    ...siteReadiness.counts
  }
};

const outputPath = resolve('output/review/review-preflight-latest.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n[review-preflight] Refresh review hub with latest preflight artifact`);
const refreshResult = spawnSync('pnpm', ['run', 'shuttle:review-index'], { stdio: 'inherit' });
if (refreshResult.error) {
  console.error(`[review-preflight] Review hub refresh failed: ${refreshResult.error.message}`);
  process.exit(1);
}
if (refreshResult.status !== 0) {
  console.error(`[review-preflight] Review hub refresh exited with ${refreshResult.status}`);
  process.exit(refreshResult.status ?? 1);
}

console.log(JSON.stringify({ ...summary, outputPath }, null, 2));

type ReviewReport = {
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function summarizeReport(label: string, report: ReviewReport): Record<string, unknown> {
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
