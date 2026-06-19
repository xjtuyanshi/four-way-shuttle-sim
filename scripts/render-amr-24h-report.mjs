import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const inputPath = resolve(process.argv[2] ?? 'output/review/physical-24h-amr-audit.json');
const outputPath = resolve(process.argv[3] ?? inputPath.replace(/\.json$/i, '-report.html'));
const vendorDir = resolve(dirname(outputPath), 'vendor');
const localPlotlyPath = resolve(vendorDir, 'plotly-2.35.2.min.js');
const plotlySrc = existsSync(localPlotlyPath)
  ? relative(dirname(outputPath), localPlotlyPath).replaceAll('\\', '/')
  : 'https://cdn.plot.ly/plotly-2.35.2.min.js';
const data = JSON.parse(readFileSync(inputPath, 'utf8'));

mkdirSync(dirname(outputPath), { recursive: true });

const hourlyRows = data.hourlyPph ?? [];
const windows = data.tenMinuteWindows ?? [];
const amrSummary = data.amrSummary ?? [];
const anomalies = data.anomalies ?? [];
const flaggedWindows = windows.filter((row) => row.riskCodes?.length > 0);
const criticalAnomalies = anomalies.filter((item) => item.severity === 'critical');
const warningAnomalies = anomalies.filter((item) => item.severity === 'warn');
const durationHours = data.finalSimTimeSec / 3600;
const speed = data.finalSimTimeSec / Math.max(1, data.wallClockMs / 1000);
const lastHourly = hourlyRows.at(-1) ?? {};

const payload = {
  generatedAt: new Date().toISOString(),
  inputPath,
  data: {
    ...data,
    tenMinuteWindows: windows,
    hourlyPph: hourlyRows,
    amrSummary,
    anomalies
  }
};
const payloadJson = JSON.stringify(payload).replaceAll('<', '\\u003c');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>24h AMR Physical Tick Audit Report</title>
<script src="${htmlEscape(plotlySrc)}"></script>
<style>
:root{color-scheme:dark;--bg:#0c1116;--panel:#151c24;--chart:#101821;--line:#2c3744;--grid:#263241;--text:#edf3f8;--muted:#9eb0c0;--cyan:#52d6ff;--green:#7ee787;--amber:#f5c451;--red:#ff7b72;--blue:#8ab4ff;--purple:#c49bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1260px;margin:0 auto;padding:30px 24px 52px}h1{font-size:30px;line-height:1.15;margin:0 0 10px;letter-spacing:0}h2{font-size:20px;margin:30px 0 12px;letter-spacing:0}h3{font-size:16px;margin:20px 0 8px}.muted{color:var(--muted)}.src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px;word-break:break-all}.summary,.card,.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px}.summary{padding:18px 20px;margin:18px 0}.summary ul{margin:0;padding-left:20px}.summary li{margin:7px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.metric{padding:13px 14px}.metric b{display:block;font-size:24px;line-height:1.1}.metric span{display:block;color:var(--muted);margin-top:7px}.pass{color:var(--green)}.warn{color:var(--amber)}.risk{color:var(--red)}.chart{background:var(--chart);border:1px solid var(--line);border-radius:8px;padding:10px;margin:12px 0;min-height:390px}.chart.tall{min-height:520px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{padding:16px 18px;margin:14px 0}.note{border-left:3px solid var(--amber);padding-left:12px;color:#d6dee7}.good{border-left:3px solid var(--green);padding-left:12px;color:#d6dee7}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}.table-wrap{overflow:auto;border-radius:8px}.small-table th,.small-table td{font-size:13px}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:12px;margin-right:6px}.plotly-notice{display:none;border:1px solid #ff7b72a0;background:#331b1f;color:#ffd7d2;border-radius:8px;padding:12px 14px;margin:12px 0}.plotly-notice.show{display:block}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two{grid-template-columns:1fr}main{padding:22px 14px}.metric b{font-size:22px}}@media(max-width:620px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<h1>24h AMR Physical Tick Audit Report</h1>
<p class="muted">Plotly interactive report. 8-shuttle physical tick audit, every ${formatSec(data.assumptions.tenMinuteSec)} AMR rollup, every ${formatSec(data.assumptions.hourlySec)} PPH rollup. Source: <span class="src">${htmlEscape(rel(inputPath))}</span></p>
<div id="plotly-notice" class="plotly-notice">Plotly 没有加载成功。若你是离线打开本页，请先把 <span class="src">plotly-2.35.2.min.js</span> 放到报告旁边的 <span class="src">vendor/</span> 目录，或联网后刷新。</div>

<section>
<h2>Technical Summary</h2>
<div class="summary">
<ul>
  <li><b class="${criticalAnomalies.length === 0 ? 'pass' : 'risk'}">24h run ${htmlEscape(data.status)} at ${round(durationHours, 1)}h.</b> Final total PPH ${round(data.pph.total, 3)}, inbound ${round(data.pph.inbound, 3)}, outbound ${round(data.pph.outbound, 3)}; headless speed ${round(speed, 1)}x real time.</li>
  <li><b class="${criticalAnomalies.length === 0 ? 'pass' : 'risk'}">AMR critical stuck signals: ${criticalAnomalies.length}.</b> The audit found ${warningAnomalies.length} warning anomalies and ${flaggedWindows.length} flagged 10-minute AMR windows.</li>
  <li><b class="${data.traffic.physicalViolations === 0 ? 'pass' : 'risk'}">Physical safety counters:</b> deadlock=${data.traffic.deadlocks}, livelock=${data.traffic.livelocks}, physicalViolation=${data.traffic.physicalViolations}, min separation ${round(data.traffic.minVehicleSeparationM ?? 0, 3)}m.</li>
  <li><b class="warn">新增矩阵：</b>每台 AMR 每 10 分钟完成任务数。持续 0 completion 不自动等于异常，但如果同时出现高 loopiness / 小 bbox / blocked，它就是强证据。</li>
</ul>
</div>
</section>

<div class="grid">
  <div class="metric"><b class="pass">${round(data.pph.total, 3)}</b><span>Total PPH</span></div>
  <div class="metric"><b>${round(data.pph.inbound, 3)}</b><span>Inbound PPH</span></div>
  <div class="metric"><b>${round(data.pph.outbound, 3)}</b><span>Outbound PPH</span></div>
  <div class="metric"><b class="${criticalAnomalies.length === 0 ? 'pass' : 'risk'}">${criticalAnomalies.length}</b><span>Critical AMR anomalies</span></div>
  <div class="metric"><b>${round(speed, 1)}x</b><span>Headless speed</span></div>
</div>

<section>
<h2>10-Minute Task Completion Matrix</h2>
<p><b>这是你刚才说的那个矩阵。</b> 横轴是 10 分钟窗口，纵轴是 AMR，颜色是该 AMR 在窗口内完成的任务数。连续大片 0 completion 要和下面的 risk heatmap、loopiness、blocked time 一起看。</p>
<div id="task-matrix" class="chart tall"></div>
</section>

<section>
<h2>AMR 10-Minute Task Completion Lines</h2>
<p><b>这张折线图专门看“单台车是否连续几个窗口没干活”。</b> 每条线是一台 AMR，纵轴是每 10 分钟完成任务数；如果某台车连续贴近 0，再对照 risk matrix 和 loopiness，就能判断是正常排队还是异常打转/卡住。</p>
<div id="task-lines" class="chart"></div>
</section>

<section>
<h2>AMR Risk Matrix</h2>
<p><b>这张图解释 0 completion 是“正常排队/长任务”还是“异常打转/卡住”。</b> Watch=1, Warn=2, Critical=3；hover 可以看到 bbox、path、net displacement、loopiness、blocked seconds、wait reason。</p>
<div id="risk-matrix" class="chart tall"></div>
</section>

<section>
<h2>Hourly PPH Stayed Observable</h2>
<p><b>每小时 PPH 仍单独记录。</b> Last row: ${formatInt(lastHourly.hourlyInbound ?? 0)} inbound moves, ${formatInt(lastHourly.hourlyOutbound ?? 0)} outbound moves, cumulative total ${round(lastHourly.totalPph ?? data.pph.total, 3)} PPH.</p>
<div id="hourly-pph" class="chart"></div>
</section>

<section>
<h2>Motion, Waiting, And Completion By AMR</h2>
<p><b>这张图把“动了多少”和“做了多少事”放在一起。</b> 如果某台车 path 很长但 completion 很低，说明它可能在浪费移动；如果 blocked 很高但 path 很低，说明更像队列/resource hold。</p>
<div id="amr-bars" class="chart"></div>
</section>

<section>
<h2>Loopiness Versus Completion</h2>
<p><b>这里专门看打转。</b> 点越靠右代表 10 分钟内 loopiness 越高，越靠上代表完成任务越多；右下角是最值得 review 的窗口。</p>
<div id="loopiness-scatter" class="chart"></div>
</section>

<section>
<h2>Anomaly Reasons</h2>
<p><b>Warnings are grouped by detection rule.</b> The rules are intentionally simple: long wait, small-area loop, node ping-pong, zero-task-moving, stationary active window, and core safety counters.</p>
<div id="anomaly-reasons" class="chart"></div>
</section>

<section>
<h2>AMR Summary Table</h2>
<div class="table-wrap">
<table><thead><tr><th>AMR</th><th>Path m</th><th>Completed</th><th>Moving h</th><th>Idle h</th><th>Blocked h</th><th>Flagged windows</th><th>Critical</th><th>Max loopiness</th><th>Max confined run</th><th>Top wait reason</th></tr></thead><tbody>${amrSummaryRows()}</tbody></table>
</div>
</section>

<section>
<h2>Hourly PPH Table</h2>
<div class="table-wrap">
<table><thead><tr><th>Hour</th><th>Hour In</th><th>Hour Out</th><th>Hour Total</th><th>Cum In PPH</th><th>Cum Out PPH</th><th>Cum Total PPH</th><th>Waiting</th><th>Blocked</th><th>Physical</th></tr></thead><tbody>${hourlyRowsHtml()}</tbody></table>
</div>
</section>

<section>
<h2>Flagged 10-Minute Windows</h2>
<p><b>This is the audit trail for long-time fixed-position or small-loop behavior.</b> It is capped to the first 100 flagged windows in the visible report; the JSON contains all rows.</p>
<div class="table-wrap">
<table class="small-table"><thead><tr><th>Window</th><th>AMR</th><th>Risk</th><th>Codes</th><th>Completed</th><th>Path m</th><th>Net m</th><th>BBox m</th><th>Loopiness</th><th>Blocked sec</th><th>Start node</th><th>End node</th><th>Wait reason</th></tr></thead><tbody>${flaggedRowsHtml()}</tbody></table>
</div>
</section>

<section>
<h2>Scope, Definitions, And Method</h2>
<div class="card">
<p><b>Audit precision:</b> vehicle position is read every ${formatSec(data.assumptions.auditEverySec)} and rolled into ${formatSec(data.assumptions.tenMinuteSec)} windows. PPH is recorded every hour. Scenario: ${formatInt(data.assumptions.shuttleCount)} shuttles, ${data.assumptions.initialStorageFillPolicy}, storage selection ${data.assumptions.storageSelectionPolicy}, collision avoidance ${data.assumptions.collisionAvoidance}.</p>
<p><b>Task completion matrix:</b> completed task count is grouped by task.completedAtSec and task.vehicleId inside each 10-minute window.</p>
<p><b>Small-area loop metric:</b> path length inside the window divided by net displacement and bounding-box size. A warning requires path >= ${data.thresholds.smallLoopPathM}m, bbox <= ${data.thresholds.smallLoopBboxM}m, and loopiness >= ${data.thresholds.smallLoopLoopiness}.</p>
<p><b>Zero-task-moving metric:</b> a watch signal requires 0 completed tasks, moving >= ${formatSec(data.thresholds.zeroTaskMovingSec)}, bbox <= ${data.thresholds.smallLoopBboxM}m, and path >= ${data.thresholds.smallLoopPathM}m in a 10-minute window.</p>
</div>
</section>

<section>
<h2>Limitations And Next Checks</h2>
<div class="two">
  <div class="card">
    <h3>What this proves</h3>
    <ul>
      <li>24h core physical tick can be run and audited without the browser render loop.</li>
      <li>Hourly PPH and every-10-minute AMR task/motion windows are available for comparison.</li>
      <li>Stuck, long wait, small loop, node ping-pong, zero-task-moving, and stationary signals are measurable.</li>
    </ul>
  </div>
  <div class="card">
    <h3>What still needs visual review</h3>
    <ul>
      <li>3D lift approach behavior around the red-circle/yellow-line service points.</li>
      <li>Actual visual collision/passing behavior when two shuttles appear close.</li>
      <li>Whether warnings are acceptable FIFO waits or ugly shuttle retargeting.</li>
    </ul>
  </div>
</div>
<p class="src">JSON: ${htmlEscape(inputPath)}<br/>Plotly source: ${htmlEscape(plotlySrc)}<br/>Generated: ${new Date().toISOString()}</p>
</section>

<script id="audit-data" type="application/json">${payloadJson}</script>
<script>
(function () {
  const root = JSON.parse(document.getElementById('audit-data').textContent);
  const data = root.data;
  const hourly = data.hourlyPph || [];
  const windows = data.tenMinuteWindows || [];
  const amrSummary = data.amrSummary || [];
  const anomalies = data.anomalies || [];
  const vehicles = Array.from(new Set(windows.map((row) => row.vehicleId))).sort();
  const windowIndexes = Array.from(new Set(windows.map((row) => row.windowIndex))).sort((a, b) => a - b);
  const windowLabels = windowIndexes.map((index) => 'H' + (index / 6).toFixed(index % 6 === 0 ? 0 : 1));
  const byKey = new Map(windows.map((row) => [row.vehicleId + '|' + row.windowIndex, row]));
  const darkLayout = {
    paper_bgcolor: '#101821',
    plot_bgcolor: '#101821',
    font: { color: '#edf3f8', family: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' },
    margin: { l: 84, r: 28, t: 46, b: 62 },
    xaxis: { gridcolor: '#263241', zerolinecolor: '#263241' },
    yaxis: { gridcolor: '#263241', zerolinecolor: '#263241' },
    legend: { orientation: 'h', y: 1.12, x: 0 }
  };
  const config = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

  if (!window.Plotly) {
    document.getElementById('plotly-notice').classList.add('show');
    return;
  }

  Plotly.newPlot('task-matrix', [{
    type: 'heatmap',
    x: windowLabels,
    y: vehicles,
    z: vehicles.map((vehicle) => windowIndexes.map((index) => byKey.get(vehicle + '|' + index)?.completedTasks ?? 0)),
    text: vehicles.map((vehicle) => windowIndexes.map((index) => {
      const row = byKey.get(vehicle + '|' + index);
      return row ? [
        vehicle + ' ' + 'H' + (row.endSec / 3600).toFixed(2),
        'completed=' + row.completedTasks + ' (in=' + row.completedInboundTasks + ', out=' + row.completedOutboundTasks + ')',
        'path=' + row.pathLengthM + 'm bbox=' + row.bboxDiagonalM + 'm',
        'loopiness=' + row.loopinessIndex,
        'blocked=' + row.blockedSec + 's',
        'codes=' + (row.riskCodes || []).join(', ')
      ].join('<br>') : ''
    })),
    hovertemplate: '%{text}<extra></extra>',
    colorscale: [[0, '#17212d'], [0.35, '#24506a'], [0.7, '#52d6ff'], [1, '#7ee787']],
    colorbar: { title: 'tasks / 10m' }
  }], {
    ...darkLayout,
    title: { text: 'AMR x 10-minute task completions', x: 0.02 },
    xaxis: { ...darkLayout.xaxis, title: '10-minute window', tickangle: -45, dtick: 6 },
    yaxis: { ...darkLayout.yaxis, title: 'AMR' }
  }, config);

  Plotly.newPlot('task-lines', vehicles.map((vehicle, index) => {
    const palette = ['#52d6ff', '#7ee787', '#f5c451', '#ff7b72', '#8ab4ff', '#c49bff', '#ffab70', '#9be9a8'];
    return {
      type: 'scatter',
      mode: 'lines+markers',
      name: vehicle,
      x: windowLabels,
      y: windowIndexes.map((windowIndex) => byKey.get(vehicle + '|' + windowIndex)?.completedTasks ?? 0),
      text: windowIndexes.map((windowIndex) => {
        const row = byKey.get(vehicle + '|' + windowIndex);
        return row ? [
          vehicle + ' H' + (row.startSec / 3600).toFixed(2) + '-' + (row.endSec / 3600).toFixed(2),
          'completed=' + row.completedTasks + ' (in=' + row.completedInboundTasks + ', out=' + row.completedOutboundTasks + ')',
          'risk=' + row.riskLevel + ' codes=' + (row.riskCodes || []).join(', '),
          'path=' + row.pathLengthM + 'm bbox=' + row.bboxDiagonalM + 'm',
          'loopiness=' + row.loopinessIndex + ' blocked=' + row.blockedSec + 's',
          row.startNodeId + ' -> ' + row.endNodeId
        ].join('<br>') : vehicle + ' no window data';
      }),
      hovertemplate: '%{text}<extra></extra>',
      line: { color: palette[index % palette.length], width: 2.5 },
      marker: { color: palette[index % palette.length], size: 5 }
    };
  }), {
    ...darkLayout,
    title: { text: 'AMR completed tasks per 10-minute window', x: 0.02 },
    xaxis: { ...darkLayout.xaxis, title: '10-minute window', tickangle: -45, dtick: 6 },
    yaxis: { ...darkLayout.yaxis, title: 'Completed tasks / 10m', rangemode: 'tozero' }
  }, config);

  const riskValue = (level) => level === 'critical' ? 3 : level === 'warn' ? 2 : level === 'watch' ? 1 : 0;
  Plotly.newPlot('risk-matrix', [{
    type: 'heatmap',
    x: windowLabels,
    y: vehicles,
    z: vehicles.map((vehicle) => windowIndexes.map((index) => riskValue(byKey.get(vehicle + '|' + index)?.riskLevel))),
    text: vehicles.map((vehicle) => windowIndexes.map((index) => {
      const row = byKey.get(vehicle + '|' + index);
      return row ? [
        vehicle + ' ' + 'H' + (row.startSec / 3600).toFixed(2) + '-' + (row.endSec / 3600).toFixed(2),
        'risk=' + row.riskLevel + ' codes=' + (row.riskCodes || []).join(', '),
        'completed=' + row.completedTasks,
        'path=' + row.pathLengthM + 'm net=' + row.netDisplacementM + 'm bbox=' + row.bboxDiagonalM + 'm',
        'loopiness=' + row.loopinessIndex + ' confinement=' + row.confinementIndex,
        'blocked=' + row.blockedSec + 's wait=' + (row.endWaitReason || '-'),
        row.startNodeId + ' -> ' + row.endNodeId
      ].join('<br>') : ''
    })),
    hovertemplate: '%{text}<extra></extra>',
    zmin: 0,
    zmax: 3,
    colorscale: [[0, '#17212d'], [0.33, '#39506a'], [0.66, '#f5c451'], [1, '#ff7b72']],
    colorbar: { title: 'risk', tickmode: 'array', tickvals: [0, 1, 2, 3], ticktext: ['ok', 'watch', 'warn', 'critical'] }
  }], {
    ...darkLayout,
    title: { text: 'AMR 10-minute risk matrix', x: 0.02 },
    xaxis: { ...darkLayout.xaxis, title: '10-minute window', tickangle: -45, dtick: 6 },
    yaxis: { ...darkLayout.yaxis, title: 'AMR' }
  }, config);

  Plotly.newPlot('hourly-pph', [
    { type: 'scatter', mode: 'lines+markers', name: 'Inbound cumulative', x: hourly.map((row) => 'H' + row.hour), y: hourly.map((row) => row.inboundPph), line: { color: '#52d6ff', width: 3 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Outbound cumulative', x: hourly.map((row) => 'H' + row.hour), y: hourly.map((row) => row.outboundPph), line: { color: '#7ee787', width: 3 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Total cumulative', x: hourly.map((row) => 'H' + row.hour), y: hourly.map((row) => row.totalPph), line: { color: '#f5c451', width: 4 } },
    { type: 'scatter', mode: 'lines', name: 'Rolling window total', x: hourly.map((row) => 'H' + row.hour), y: hourly.map((row) => row.windowTotalPph), line: { color: '#8ab4ff', width: 2, dash: 'dash' } }
  ], {
    ...darkLayout,
    title: { text: 'Hourly PPH trend', x: 0.02 },
    yaxis: { ...darkLayout.yaxis, title: 'PPH' }
  }, config);

  Plotly.newPlot('amr-bars', [
    { type: 'bar', name: 'Total path m', x: amrSummary.map((row) => row.vehicleId), y: amrSummary.map((row) => row.totalPathM), marker: { color: '#52d6ff' }, yaxis: 'y' },
    { type: 'bar', name: 'Blocked h', x: amrSummary.map((row) => row.vehicleId), y: amrSummary.map((row) => row.blockedSec / 3600), marker: { color: '#ff7b72' }, yaxis: 'y2' },
    { type: 'bar', name: 'Completed tasks', x: amrSummary.map((row) => row.vehicleId), y: amrSummary.map((summary) => windows.filter((row) => row.vehicleId === summary.vehicleId).reduce((sum, row) => sum + (row.completedTasks || 0), 0)), marker: { color: '#7ee787' }, yaxis: 'y3' }
  ], {
    ...darkLayout,
    barmode: 'group',
    title: { text: 'AMR motion, blocked time, and completed tasks', x: 0.02 },
    yaxis: { title: 'Path meters', gridcolor: '#263241' },
    yaxis2: { title: 'Blocked hours', overlaying: 'y', side: 'right', showgrid: false },
    yaxis3: { title: 'Completed tasks', overlaying: 'y', side: 'right', position: 0.95, showgrid: false, visible: false }
  }, config);

  Plotly.newPlot('loopiness-scatter', [{
    type: 'scattergl',
    mode: 'markers',
    x: windows.map((row) => row.loopinessIndex),
    y: windows.map((row) => row.completedTasks),
    text: windows.map((row) => [
      row.vehicleId + ' H' + (row.startSec / 3600).toFixed(2) + '-' + (row.endSec / 3600).toFixed(2),
      'completed=' + row.completedTasks,
      'risk=' + row.riskLevel + ' codes=' + (row.riskCodes || []).join(', '),
      'path=' + row.pathLengthM + 'm net=' + row.netDisplacementM + 'm bbox=' + row.bboxDiagonalM + 'm',
      'blocked=' + row.blockedSec + 's',
      row.startNodeId + ' -> ' + row.endNodeId
    ].join('<br>')),
    hovertemplate: '%{text}<extra></extra>',
    marker: {
      size: windows.map((row) => 6 + Math.min(16, (row.blockedSec || 0) / 60)),
      color: windows.map((row) => riskValue(row.riskLevel)),
      colorscale: [[0, '#52d6ff'], [0.33, '#39506a'], [0.66, '#f5c451'], [1, '#ff7b72']],
      cmin: 0,
      cmax: 3,
      opacity: 0.82,
      colorbar: { title: 'risk' }
    }
  }], {
    ...darkLayout,
    title: { text: 'Loopiness vs completed tasks per 10 minutes', x: 0.02 },
    xaxis: { ...darkLayout.xaxis, title: 'Loopiness index' },
    yaxis: { ...darkLayout.yaxis, title: 'Completed tasks / 10m' }
  }, config);

  const reasonCounts = Object.entries(anomalies.reduce((counts, row) => {
    counts[row.code] = (counts[row.code] || 0) + 1;
    return counts;
  }, {})).sort((a, b) => b[1] - a[1]);
  Plotly.newPlot('anomaly-reasons', [{
    type: 'bar',
    orientation: 'h',
    x: reasonCounts.map((row) => row[1]).reverse(),
    y: reasonCounts.map((row) => row[0]).reverse(),
    marker: { color: '#f5c451' },
    hovertemplate: '%{y}: %{x}<extra></extra>'
  }], {
    ...darkLayout,
    title: { text: 'Anomaly reason counts', x: 0.02 },
    xaxis: { ...darkLayout.xaxis, title: 'Count' },
    yaxis: { ...darkLayout.yaxis, automargin: true }
  }, config);
})();
</script>
</main></body></html>`;

writeFileSync(outputPath, html, 'utf8');
console.log(JSON.stringify({
  ok: true,
  inputPath,
  outputPath,
  plotlySrc,
  summary: {
    finalSimTimeSec: data.finalSimTimeSec,
    wallClockMs: data.wallClockMs,
    pph: data.pph,
    criticalAnomalies: criticalAnomalies.length,
    warningAnomalies: warningAnomalies.length,
    flaggedWindows: flaggedWindows.length
  }
}, null, 2));

function amrSummaryRows() {
  return amrSummary.map((row) => {
    const completed = windows
      .filter((window) => window.vehicleId === row.vehicleId)
      .reduce((sum, window) => sum + Number(window.completedTasks ?? 0), 0);
    return `<tr>
      <td>${htmlEscape(row.vehicleId)}</td>
      <td>${formatInt(row.totalPathM)}</td>
      <td>${formatInt(completed)}</td>
      <td>${round(row.movingSec / 3600, 2)}</td>
      <td>${round(row.idleSec / 3600, 2)}</td>
      <td>${round(row.blockedSec / 3600, 2)}</td>
      <td>${formatInt(row.flaggedWindows)}</td>
      <td>${formatInt(row.criticalWindows)}</td>
      <td>${round(row.maxLoopinessIndex, 2)}</td>
      <td>${formatSec(row.maxConfinedRunSec)}</td>
      <td>${htmlEscape(row.topWaitReasons?.[0]?.reason ?? '-')} ${row.topWaitReasons?.[0] ? `(${formatSec(row.topWaitReasons[0].sec)})` : ''}</td>
    </tr>`;
  }).join('\n');
}

function hourlyRowsHtml() {
  return hourlyRows.map((row) => `<tr>
    <td>H${formatInt(row.hour)}</td>
    <td>${formatInt(row.hourlyInbound)}</td>
    <td>${formatInt(row.hourlyOutbound)}</td>
    <td>${formatInt(row.hourlyTotal)}</td>
    <td>${round(row.inboundPph, 3)}</td>
    <td>${round(row.outboundPph, 3)}</td>
    <td>${round(row.totalPph, 3)}</td>
    <td>${formatInt(row.waitingVehicles)}</td>
    <td>${formatInt(row.blockedVehicles)}</td>
    <td>${formatInt(row.physicalViolations)}</td>
  </tr>`).join('\n');
}

function flaggedRowsHtml() {
  return flaggedWindows.slice(0, 100).map((row) => `<tr>
    <td>${formatWindow(row.startSec)}-${formatWindow(row.endSec)}</td>
    <td>${htmlEscape(row.vehicleId)}</td>
    <td>${htmlEscape(row.riskLevel)}</td>
    <td>${htmlEscape(row.riskCodes.join(', '))}</td>
    <td>${formatInt(row.completedTasks ?? 0)}</td>
    <td>${round(row.pathLengthM, 2)}</td>
    <td>${round(row.netDisplacementM, 2)}</td>
    <td>${round(row.bboxDiagonalM, 2)}</td>
    <td>${round(row.loopinessIndex, 2)}</td>
    <td>${round(row.blockedSec, 1)}</td>
    <td>${htmlEscape(row.startNodeId)}</td>
    <td>${htmlEscape(row.endNodeId)}</td>
    <td>${htmlEscape(row.endWaitReason ?? '-')}</td>
  </tr>`).join('\n') || '<tr><td colspan="13">No flagged 10-minute windows.</td></tr>';
}

function formatWindow(sec) {
  return `H${round(sec / 3600, 2)}`;
}

function formatSec(sec) {
  const value = Number(sec ?? 0);
  if (value < 60) return `${round(value, 1)}s`;
  if (value < 3600) return `${round(value / 60, 1)}m`;
  return `${round(value / 3600, 2)}h`;
}

function round(value, digits = 3) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function formatInt(value) {
  return Math.round(Number(value ?? 0)).toLocaleString('en-US');
}

function rel(path) {
  return relative(dirname(outputPath), path).replaceAll('\\', '/');
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
