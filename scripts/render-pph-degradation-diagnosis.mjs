import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const inputPath = resolve(process.argv[2] ?? 'output/review/physical-24h-shadow-ledger-hotspot-audit.json');
const outputPath = resolve(process.argv[3] ?? inputPath.replace(/\.json$/i, '-degradation-diagnosis.html'));
const data = JSON.parse(readFileSync(inputPath, 'utf8'));

const vendorDir = resolve(dirname(outputPath), 'vendor');
const localPlotlyPath = resolve(vendorDir, 'plotly-2.35.2.min.js');
const plotlySrc = existsSync(localPlotlyPath)
  ? relative(dirname(outputPath), localPlotlyPath).replaceAll('\\', '/')
  : 'https://cdn.plot.ly/plotly-2.35.2.min.js';

mkdirSync(dirname(outputPath), { recursive: true });

const hourlyRows = data.hourlyPph ?? [];
const windows = data.tenMinuteWindows ?? [];
const finalWaiting = data.finalWaitingVehicles ?? [];
const vehicles = Array.from(new Set(windows.map((row) => row.vehicleId))).sort();
const windowIndexes = Array.from(new Set(windows.map((row) => row.windowIndex))).sort((a, b) => a - b);
const groupedWindows = windowIndexes.map((windowIndex) => {
  const rows = windows.filter((row) => row.windowIndex === windowIndex);
  const startSec = rows[0]?.startSec ?? 0;
  const waitReasonSec = new Map();
  for (const row of rows) {
    for (const [reason, sec] of Object.entries(row.waitReasonSec ?? {})) {
      waitReasonSec.set(reason, (waitReasonSec.get(reason) ?? 0) + Number(sec ?? 0));
    }
  }
  const sortedReasons = Array.from(waitReasonSec, ([reason, sec]) => ({ reason, sec }))
    .sort((a, b) => b.sec - a.sec);
  return {
    windowIndex,
    startSec,
    endSec: rows[0]?.endSec ?? startSec + 600,
    hour: startSec / 3600,
    completedTasks: sum(rows, 'completedTasks'),
    inboundTasks: sum(rows, 'completedInboundTasks'),
    outboundTasks: sum(rows, 'completedOutboundTasks'),
    blockedSec: sum(rows, 'blockedSec'),
    idleSec: sum(rows, 'idleSec'),
    movingSec: sum(rows, 'movingSec'),
    criticalVehicles: rows.filter((row) => row.riskLevel === 'critical').length,
    warnVehicles: rows.filter((row) => row.riskLevel === 'warn').length,
    watchVehicles: rows.filter((row) => row.riskLevel === 'watch').length,
    routeUnavailableSec: waitReasonSec.get('route-unavailable') ?? 0,
    nodeOccupiedSec: waitReasonSec.get('node-occupied') ?? 0,
    localYieldHoldSec: waitReasonSec.get('local-yield-hold') ?? 0,
    inboundLiftFifoWaitSec: waitReasonSec.get('inbound-lift-fifo-wait') ?? 0,
    topReasons: sortedReasons.slice(0, 5)
  };
});

const firstCriticalWindow = groupedWindows.find((row) => row.criticalVehicles > 0);
const firstZeroWindow = groupedWindows.find((row) => row.completedTasks === 0);
const firstSustainedZeroWindow = groupedWindows.find((row, index) => {
  if (row.completedTasks !== 0) return false;
  return groupedWindows.slice(index, index + 3).length === 3 &&
    groupedWindows.slice(index, index + 3).every((candidate) => candidate.completedTasks === 0);
});
const lastStableHour = [...hourlyRows].reverse().find((row) => Number(row.hourlyTotal ?? 0) >= 450);
const collapseHour = hourlyRows.find((row) => Number(row.hourlyTotal ?? 0) < 300);
const firstCriticalEvidence = windows
  .filter((row) => firstCriticalWindow && row.windowIndex === firstCriticalWindow.windowIndex && row.riskLevel !== 'ok')
  .slice(0, 12);
const topRouteUnavailableVehicles = aggregateByVehicle('route-unavailable');
const topFrozenVehicles = vehicles.map((vehicleId) => {
  const rows = windows.filter((row) => row.vehicleId === vehicleId);
  return {
    vehicleId,
    criticalWindows: rows.filter((row) => row.riskLevel === 'critical').length,
    zeroCompletionWindows: rows.filter((row) => row.completedTasks === 0).length,
    routeUnavailableSec: rows.reduce((total, row) => total + Number(row.waitReasonSec?.['route-unavailable'] ?? 0), 0),
    nodeOccupiedSec: rows.reduce((total, row) => total + Number(row.waitReasonSec?.['node-occupied'] ?? 0), 0),
    localYieldHoldSec: rows.reduce((total, row) => total + Number(row.waitReasonSec?.['local-yield-hold'] ?? 0), 0)
  };
}).sort((a, b) => b.criticalWindows - a.criticalWindows || b.routeUnavailableSec - a.routeUnavailableSec);

const payload = {
  generatedAt: new Date().toISOString(),
  inputPath,
  plotlySrc,
  hourlyRows,
  windows,
  groupedWindows,
  vehicles,
  finalWaiting,
  firstCriticalWindow,
  firstZeroWindow,
  firstSustainedZeroWindow,
  lastStableHour,
  collapseHour,
  firstCriticalEvidence,
  topRouteUnavailableVehicles,
  topFrozenVehicles,
  pph: data.pph,
  traffic: data.traffic
};
const payloadJson = JSON.stringify(payload).replaceAll('<', '\\u003c');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PPH Degradation Diagnosis</title>
<script src="${escapeHtml(plotlySrc)}"></script>
<style>
:root{color-scheme:dark;--bg:#0b1117;--panel:#151d26;--panel2:#101821;--line:#2b3847;--grid:#253242;--text:#eef5fb;--muted:#9db1c2;--good:#76e39b;--warn:#f2c14e;--bad:#ff756f;--cyan:#55d7ff;--blue:#8db6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1280px;margin:0 auto;padding:28px 22px 52px}h1{font-size:30px;line-height:1.15;margin:0 0 8px;letter-spacing:0}h2{font-size:20px;margin:28px 0 10px;letter-spacing:0}h3{font-size:16px;margin:18px 0 8px}.muted{color:var(--muted)}.src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px;word-break:break-all}.summary,.card,.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px}.summary{padding:16px 18px;margin:18px 0}.summary li{margin:7px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0}.metric{padding:13px 14px}.metric b{display:block;font-size:23px;line-height:1.1}.metric span{display:block;color:var(--muted);margin-top:7px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.chart{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;margin:12px 0;min-height:390px}.chart.tall{min-height:520px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{padding:16px 18px;margin:12px 0}.table-wrap{overflow:auto;border-radius:8px}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line)}th,td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin:2px;color:var(--muted);font-size:12px}.plotly-notice{display:none;border:1px solid #ff756fa0;background:#321b20;color:#ffd5d2;border-radius:8px;padding:12px 14px;margin:12px 0}.plotly-notice.show{display:block}@media(max-width:900px){.grid,.two{grid-template-columns:1fr}main{padding:22px 14px}}
</style>
</head>
<body>
<main>
<h1>PPH Degradation Diagnosis</h1>
<p class="muted">这份报告专门定位“前三四小时/前半段稳定，后面 PPH 下降”的原因。Source: <span class="src">${escapeHtml(relative(process.cwd(), inputPath))}</span></p>
<div id="plotly-notice" class="plotly-notice">Plotly 没有加载成功；如果离线打开，请联网刷新，或把 plotly-2.35.2.min.js 放到报告旁边的 vendor/ 目录。</div>

<section>
<h2>结论</h2>
<div class="summary">
<ul>
  <li><b class="bad">这不是正常的累积平均回落。</b> 旧 24h 结果里，H13-H14 仍有约 ${formatInt(hourByNumber(13)?.hourlyTotal)}-${formatInt(hourByNumber(14)?.hourlyTotal)} PPH；H15 降到 ${formatInt(hourByNumber(15)?.hourlyTotal)}，H17 只剩 ${formatInt(hourByNumber(17)?.hourlyTotal)}，H18 后为 ${formatInt(hourByNumber(18)?.hourlyTotal)}。</li>
  <li><b class="bad">第一个明确冻结窗口：</b>${formatWindow(firstCriticalWindow)}，开始出现 AMR 原地 600 秒、0 completion、risk=critical。</li>
  <li><b class="bad">第一个连续 0 产出窗口：</b>${formatWindow(firstSustainedZeroWindow)}。从这里开始，PPH 图的下降基本只是 0 产出的小时把累计平均拉低。</li>
  <li><b class="warn">主导原因：</b>route-unavailable 在 H14 附近快速变成主导等待；后面叠加 node-occupied 和 local-yield-hold，形成有效车队数下降。</li>
  <li><b class="warn">系统层判断：</b>这是交通资源/路由恢复出口的问题，不是单纯 lift service time 太长，也不是 demand 不够。</li>
</ul>
</div>
</section>

<div class="grid">
  <div class="metric"><b>${formatInt(lastStableHour?.hourlyTotal)}</b><span>最后稳定小时 PPH H${lastStableHour?.hour ?? '?'}</span></div>
  <div class="metric"><b class="bad">${formatInt(collapseHour?.hourlyTotal)}</b><span>首次低于 300 PPH H${collapseHour?.hour ?? '?'}</span></div>
  <div class="metric"><b class="bad">${formatInt(firstCriticalWindow?.completedTasks)}</b><span>首个 critical 10m 总完成数</span></div>
  <div class="metric"><b>${formatInt(data.pph?.total)}</b><span>24h 累计 Total PPH</span></div>
  <div class="metric"><b>${formatInt(data.pph?.windowTotal)}</b><span>最终 5m Window PPH</span></div>
</div>

<section>
<h2>Hourly PPH Collapse</h2>
<div id="hourly-pph" class="chart"></div>
</section>

<section>
<h2>10 分钟产出与冻结信号</h2>
<p class="muted">每个点是 10 分钟窗口。可以看到产出不是随机波动，而是 critical AMR 数量上来以后，completed tasks 快速掉到 0。</p>
<div id="window-tasks" class="chart"></div>
</section>

<section>
<h2>每台 AMR 的 10 分钟任务完成数</h2>
<div id="task-matrix" class="chart tall"></div>
<div id="task-lines" class="chart"></div>
</section>

<section>
<h2>等待原因如何接管系统</h2>
<p class="muted">这里把每 10 分钟所有 AMR 的等待秒数按原因叠加。H14 以后 route-unavailable 持续占满多个 AMR 的 600 秒窗口，这是最强证据。</p>
<div id="wait-reasons" class="chart"></div>
</section>

<section>
<h2>冻结车辆和等待链</h2>
<div class="two">
  <div class="card">
    <h3>冻结车辆排序</h3>
    <div class="table-wrap"><table><thead><tr><th>AMR</th><th>Critical windows</th><th>0-task windows</th><th>Route unavailable h</th><th>Node occupied h</th><th>Local yield h</th></tr></thead><tbody>${frozenVehicleRows()}</tbody></table></div>
  </div>
  <div class="card">
    <h3>最终等待状态</h3>
    <div class="table-wrap"><table><thead><tr><th>AMR</th><th>Node</th><th>Target</th><th>Reason</th><th>Blocker</th><th>Blocked h</th></tr></thead><tbody>${finalWaitingRows()}</tbody></table></div>
  </div>
</div>
</section>

<section>
<h2>首个 Critical Window 证据</h2>
<p class="muted">这是第一个从“可接受排队”变成“原地冻结”的窗口。它定义了下一步修复的入口。</p>
<div class="table-wrap"><table><thead><tr><th>Window</th><th>AMR</th><th>Risk</th><th>Codes</th><th>Tasks</th><th>State</th><th>Wait</th><th>Blocker</th><th>Start</th><th>End</th><th>Blocked sec</th><th>Path m</th></tr></thead><tbody>${firstCriticalRows()}</tbody></table></div>
</section>

<section>
<h2>下一步系统修复方向</h2>
<div class="summary">
<ul>
  <li><b>不要再单点补每一种 waitReason。</b> route-unavailable、node-occupied、local-yield-hold 都应该进入同一个资源恢复 contract：每个 active AMR 必须有 move、FIFO wait、或可解释的 retry/backoff，不允许无限 holding。</li>
  <li><b>先查 route-unavailable 出口。</b> SH-01/SH-03/SH-05 在 storage 节点之间找路失败且 blockedTime 持续增长，说明 route planner / claim release / storage-pocket unwind 三者至少一个没有回收。</li>
  <li><b>再查 idle blocker。</b> 最终状态里 SH-06 被 idle SH-08 挡住，说明 idle 车占着可行线关键 node 时没有被系统性驱离。</li>
  <li><b>验证方式：</b>修复后先跑 6h，确认 H1-H6 不出现 critical；再跑 12h，必须覆盖 H14-H18 同类窗口；最后跑 24h，并用本报告对比。</li>
</ul>
</div>
<p class="src">Generated: ${escapeHtml(payload.generatedAt)}<br/>Output: ${escapeHtml(outputPath)}</p>
</section>
</main>

<script id="payload" type="application/json">${payloadJson}</script>
<script>
(function () {
  const payload = JSON.parse(document.getElementById('payload').textContent);
  if (typeof Plotly === 'undefined') {
    document.getElementById('plotly-notice').classList.add('show');
    return;
  }
  const layoutBase = {
    paper_bgcolor: '#101821',
    plot_bgcolor: '#101821',
    font: { color: '#eef5fb' },
    margin: { l: 58, r: 24, t: 38, b: 52 },
    xaxis: { gridcolor: '#253242', zerolinecolor: '#253242' },
    yaxis: { gridcolor: '#253242', zerolinecolor: '#253242' },
    legend: { orientation: 'h', y: -0.2 }
  };
  const hours = payload.hourlyRows.map((row) => 'H' + row.hour);
  const collapseX = payload.collapseHour ? 'H' + payload.collapseHour.hour : null;
  const shapes = collapseX ? [{ type: 'line', xref: 'x', yref: 'paper', x0: collapseX, x1: collapseX, y0: 0, y1: 1, line: { color: '#ff756f', dash: 'dot', width: 2 } }] : [];
  Plotly.newPlot('hourly-pph', [
    { type: 'scatter', mode: 'lines+markers', name: 'Hour Total', x: hours, y: payload.hourlyRows.map((row) => row.hourlyTotal), line: { color: '#55d7ff', width: 3 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Inbound', x: hours, y: payload.hourlyRows.map((row) => row.hourlyInbound), line: { color: '#76e39b', width: 2 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Outbound', x: hours, y: payload.hourlyRows.map((row) => row.hourlyOutbound), line: { color: '#f2c14e', width: 2 } },
    { type: 'scatter', mode: 'lines', name: 'Cumulative Total PPH', x: hours, y: payload.hourlyRows.map((row) => row.totalPph), line: { color: '#c49bff', width: 2, dash: 'dash' } }
  ], { ...layoutBase, title: 'Hourly PPH: stable until resource collapse', shapes, yaxis: { ...layoutBase.yaxis, title: 'PPH' } }, { responsive: true });

  const windowX = payload.groupedWindows.map((row) => 'H' + row.hour.toFixed(1));
  Plotly.newPlot('window-tasks', [
    { type: 'bar', name: '10m completed tasks', x: windowX, y: payload.groupedWindows.map((row) => row.completedTasks), marker: { color: '#55d7ff' } },
    { type: 'scatter', mode: 'lines+markers', name: 'critical AMRs', x: windowX, y: payload.groupedWindows.map((row) => row.criticalVehicles), yaxis: 'y2', line: { color: '#ff756f', width: 3 } },
    { type: 'scatter', mode: 'lines+markers', name: 'blocked sec / 600', x: windowX, y: payload.groupedWindows.map((row) => row.blockedSec / 600), yaxis: 'y2', line: { color: '#f2c14e', width: 2 } }
  ], { ...layoutBase, title: '10-minute output versus frozen AMR count', barmode: 'group', yaxis: { ...layoutBase.yaxis, title: 'Completed tasks' }, yaxis2: { title: 'AMR count / blocked units', overlaying: 'y', side: 'right', gridcolor: '#253242' } }, { responsive: true });

  const vehicles = payload.vehicles;
  const indexes = Array.from(new Set(payload.windows.map((row) => row.windowIndex))).sort((a, b) => a - b);
  const labels = indexes.map((index) => 'H' + ((index - 1) / 6).toFixed(1));
  const taskZ = vehicles.map((vehicleId) => indexes.map((index) => {
    const row = payload.windows.find((candidate) => candidate.vehicleId === vehicleId && candidate.windowIndex === index);
    return row ? row.completedTasks : null;
  }));
  Plotly.newPlot('task-matrix', [{
    type: 'heatmap',
    x: labels,
    y: vehicles,
    z: taskZ,
    colorscale: [[0, '#1d2732'], [0.35, '#2d6cdf'], [0.7, '#55d7ff'], [1, '#76e39b']],
    colorbar: { title: 'Tasks' }
  }], { ...layoutBase, title: 'AMR task completion matrix, every 10 minutes', yaxis: { ...layoutBase.yaxis, autorange: 'reversed' } }, { responsive: true });

  Plotly.newPlot('task-lines', vehicles.map((vehicleId) => ({
    type: 'scatter',
    mode: 'lines',
    name: vehicleId,
    x: labels,
    y: indexes.map((index) => {
      const row = payload.windows.find((candidate) => candidate.vehicleId === vehicleId && candidate.windowIndex === index);
      return row ? row.completedTasks : null;
    })
  })), { ...layoutBase, title: 'Per-AMR 10-minute task count lines', yaxis: { ...layoutBase.yaxis, title: 'Tasks per 10m' } }, { responsive: true });

  Plotly.newPlot('wait-reasons', [
    { type: 'scatter', mode: 'lines', stackgroup: 'one', name: 'route-unavailable', x: windowX, y: payload.groupedWindows.map((row) => row.routeUnavailableSec), line: { color: '#ff756f' } },
    { type: 'scatter', mode: 'lines', stackgroup: 'one', name: 'node-occupied', x: windowX, y: payload.groupedWindows.map((row) => row.nodeOccupiedSec), line: { color: '#f2c14e' } },
    { type: 'scatter', mode: 'lines', stackgroup: 'one', name: 'local-yield-hold', x: windowX, y: payload.groupedWindows.map((row) => row.localYieldHoldSec), line: { color: '#c49bff' } },
    { type: 'scatter', mode: 'lines', stackgroup: 'one', name: 'inbound-lift-fifo-wait', x: windowX, y: payload.groupedWindows.map((row) => row.inboundLiftFifoWaitSec), line: { color: '#76e39b' } }
  ], { ...layoutBase, title: 'Wait reasons, summed across AMRs by 10-minute window', yaxis: { ...layoutBase.yaxis, title: 'Seconds per 10m window' } }, { responsive: true });
})();
</script>
</body>
</html>`;

writeFileSync(outputPath, html);
console.log(JSON.stringify({
  inputPath,
  outputPath,
  firstCriticalWindow,
  firstSustainedZeroWindow,
  lastStableHour,
  collapseHour
}, null, 2));

function aggregateByVehicle(reason) {
  return vehicles.map((vehicleId) => {
    const sec = windows
      .filter((row) => row.vehicleId === vehicleId)
      .reduce((total, row) => total + Number(row.waitReasonSec?.[reason] ?? 0), 0);
    return { vehicleId, sec };
  }).sort((a, b) => b.sec - a.sec);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function hourByNumber(hour) {
  return hourlyRows.find((row) => row.hour === hour);
}

function formatInt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'NA';
  return Math.round(Number(value)).toLocaleString('en-US');
}

function formatHours(sec) {
  if (!Number.isFinite(Number(sec))) return 'NA';
  return (Number(sec) / 3600).toFixed(2);
}

function formatWindow(window) {
  if (!window) return '未找到';
  return `W${window.windowIndex} / H${window.hour.toFixed(1)} (${formatInt(window.completedTasks)} tasks, ${window.criticalVehicles} critical AMR)`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function frozenVehicleRows() {
  return topFrozenVehicles.map((row) => `<tr><td>${escapeHtml(row.vehicleId)}</td><td>${formatInt(row.criticalWindows)}</td><td>${formatInt(row.zeroCompletionWindows)}</td><td>${formatHours(row.routeUnavailableSec)}</td><td>${formatHours(row.nodeOccupiedSec)}</td><td>${formatHours(row.localYieldHoldSec)}</td></tr>`).join('');
}

function finalWaitingRows() {
  return finalWaiting.map((row) => `<tr><td>${escapeHtml(row.vehicleId)}</td><td>${escapeHtml(row.currentNodeId)}</td><td>${escapeHtml(row.targetNodeId)}</td><td>${escapeHtml(row.waitReason)}</td><td>${escapeHtml(row.blockingVehicleId ?? '')}</td><td>${formatHours(row.blockedTimeSec)}</td></tr>`).join('');
}

function firstCriticalRows() {
  return firstCriticalEvidence.map((row) => `<tr><td>W${formatInt(row.windowIndex)} H${(row.startSec / 3600).toFixed(1)}</td><td>${escapeHtml(row.vehicleId)}</td><td>${escapeHtml(row.riskLevel)}</td><td>${escapeHtml((row.riskCodes ?? []).join(', '))}</td><td>${formatInt(row.completedTasks)}</td><td>${escapeHtml(row.endState)}</td><td>${escapeHtml(row.endWaitReason ?? '')}</td><td>${escapeHtml(row.endBlockingVehicleId ?? '')}</td><td>${escapeHtml(row.startNodeId)}</td><td>${escapeHtml(row.endNodeId)}</td><td>${formatInt(row.blockedSec)}</td><td>${formatInt(row.pathLengthM)}</td></tr>`).join('');
}
