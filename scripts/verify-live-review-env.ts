const apiBaseUrl = process.env.SHUTTLE_API_URL ?? 'http://127.0.0.1:8791';
const dashboardUrl = process.env.SHUTTLE_DASHBOARD_URL ?? 'http://127.0.0.1:5190/';
const desDurationSec = Number(process.env.SHUTTLE_LIVE_VERIFY_DES_SEC ?? 7200);
const desSampleIntervalSec = Number(process.env.SHUTTLE_LIVE_VERIFY_SAMPLE_SEC ?? 900);
const maxActiveTasks = Number(process.env.SHUTTLE_LIVE_VERIFY_MAX_ACTIVE_TASKS ?? 6);

const failures: string[] = [];
const checks: Array<{ check: string; status: 'pass' | 'fail'; detail: string }> = [];

try {
  await verifyDashboard();
  await verifyApiHealth();
  await verifyHeadlessDes();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error(JSON.stringify({ type: 'live-review-env-verify-failed', failures, checks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ type: 'live-review-env-verify-complete', failures: 0, checks }, null, 2));

async function verifyDashboard(): Promise<void> {
  const response = await fetchWithTimeout(dashboardUrl, { timeoutMs: 5000 });
  const text = await response.text();
  expect('dashboard-http', response.ok, `${response.status} ${response.statusText} at ${dashboardUrl}`);
  expect('dashboard-title', text.includes('<title>Shuttle Sim</title>'), 'dashboard HTML contains Shuttle Sim title');
  const isViteDev = text.includes('/@vite/client');
  expect('dashboard-vite', isViteDev || text.includes('/assets/'), 'dashboard looks like a Vite app response');
  if (isViteDev) {
    await verifyDashboardServedSource();
  }
}

async function verifyDashboardServedSource(): Promise<void> {
  const appSourceUrl = new URL('/src/App.tsx', dashboardUrl).toString();
  const styleSourceUrl = new URL('/src/styles.css', dashboardUrl).toString();
  const appSourceResponse = await fetchWithTimeout(appSourceUrl, { timeoutMs: 5000 });
  const styleSourceResponse = await fetchWithTimeout(styleSourceUrl, { timeoutMs: 5000 });
  const appSource = await appSourceResponse.text();
  const styleSource = await styleSourceResponse.text();
  expect('dashboard-source-http', appSourceResponse.ok && styleSourceResponse.ok, `${appSourceResponse.status}/${styleSourceResponse.status} source responses`);
  expect('dashboard-live-markers-source', appSource.includes('liveTrendMarkers') && appSource.includes('LiveTrendMarker'), 'served App.tsx contains live trend marker logic');
  expect('dashboard-live-markers-labels', appSource.includes('Lowest total') && appSource.includes('Peak waiting'), 'served App.tsx contains live marker labels');
  expect('dashboard-live-markers-style', styleSource.includes('.live-trend-marker-grid') && styleSource.includes('.live-trend-marker'), 'served CSS contains live marker styles');
  expect('dashboard-ie-diagnosis-source', appSource.includes('buildLiveTrendDiagnosis') && appSource.includes('IE Trend Diagnosis'), 'served App.tsx contains live IE trend diagnosis');
  expect('dashboard-ie-diagnosis-style', styleSource.includes('.live-diagnosis-grid') && styleSource.includes('.live-diagnosis-card'), 'served CSS contains live IE diagnosis styles');
  expect('dashboard-review-cockpit-source', appSource.includes('Review Cockpit') && appSource.includes('buildReviewTrafficReadouts'), 'served App.tsx contains review cockpit and traffic readouts');
  expect('dashboard-review-cockpit-style', styleSource.includes('.review-cockpit-panel') && styleSource.includes('.review-traffic-card'), 'served CSS contains review cockpit styles');
  expect('dashboard-review-des-evidence-source', appSource.includes('buildReviewDesEvidence') && appSource.includes('DES Task Evidence'), 'served App.tsx contains cockpit DES task evidence');
  expect('dashboard-review-des-evidence-style', styleSource.includes('.review-des-panel') && styleSource.includes('.review-des-card'), 'served CSS contains cockpit DES evidence styles');
}

async function verifyApiHealth(): Promise<void> {
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/shuttle/health`, { timeoutMs: 5000 });
  const body = await response.json() as { ok?: boolean; service?: string; protocol?: string };
  expect('api-health-http', response.ok, `${response.status} ${response.statusText} at ${apiBaseUrl}`);
  expect('api-health-ok', body.ok === true && body.service === 'shuttle-api', `service=${body.service ?? 'unknown'}`);
  expect('api-protocol', body.protocol === 'shuttle.phase0.v0', `protocol=${body.protocol ?? 'unknown'}`);
}

async function verifyHeadlessDes(): Promise<void> {
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/shuttle/runHeadlessDes`, {
    timeoutMs: 30000,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        durationSec: desDurationSec,
        sampleIntervalSec: desSampleIntervalSec,
        maxActiveTasks
      })
    }
  });
  const body = await response.json() as { ok?: boolean; result?: DesResult };
  const result = body.result;
  expect('des-http', response.ok && body.ok === true, `${response.status} ${response.statusText}; ok=${String(body.ok)}`);
  expect('des-result-present', Boolean(result), 'result object returned');
  if (!result) return;

  expect('des-schema-version', result.schemaVersion === 'shuttle.headlessDes.v1', `schemaVersion=${result.schemaVersion ?? 'missing'}`);
  expect('des-positive-pph', result.totalPph > 0 && result.inboundPph > 0 && result.outboundPph > 0, `total=${result.totalPph}, inbound=${result.inboundPph}, outbound=${result.outboundPph}`);
  expect('des-route-model', result.routeModel?.kind === 'yellow-graph-reservation-window', `route kind=${result.routeModel?.kind ?? 'missing'}`);
  expect('des-route-misses', result.routeModel?.routeUnavailableCount === 0, `routeUnavailableCount=${result.routeModel?.routeUnavailableCount ?? 'missing'}`);
  expect('des-reservation-replay', Boolean(result.reservationReplay) && result.reservationReplay.tasks.length > 0, `traced=${result.reservationReplay?.tasks.length ?? 0}`);
  expect('des-top-waits', Array.isArray(result.reservationReplay?.topWaitIntervals), `topWaitIntervals=${result.reservationReplay?.topWaitIntervals?.length ?? 'missing'}`);
  expect('des-issues-array', Array.isArray(result.issues), `issues=${Array.isArray(result.issues) ? result.issues.length : 'missing'}`);
  expect('des-samples', result.samples.length >= Math.floor(desDurationSec / desSampleIntervalSec), `samples=${result.samples.length}`);
}

function expect(check: string, condition: boolean, detail: string): void {
  checks.push({ check, status: condition ? 'pass' : 'fail', detail });
  if (!condition) failures.push(`${check}: ${detail}`);
}

async function fetchWithTimeout(url: string, options: { timeoutMs: number; init?: RequestInit }): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, { ...options.init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

type DesResult = {
  schemaVersion: string;
  inboundPph: number;
  outboundPph: number;
  totalPph: number;
  routeModel?: {
    kind: string;
    routeUnavailableCount: number;
  };
  reservationReplay?: {
    tasks: unknown[];
    topWaitIntervals: unknown[];
  };
  issues: unknown[];
  samples: unknown[];
};
