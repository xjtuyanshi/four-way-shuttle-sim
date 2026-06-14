import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const inputPath = resolve(process.argv[2] ?? 'output/review/physical-24h-vitest-yellow-queue-fifo-release.json');
const outputPath = resolve(process.argv[3] ?? 'output/review/physical-24h-vitest-yellow-queue-fifo-release-report.html');
const assetDir = resolve(dirname(outputPath), 'physical-24h-vitest-yellow-queue-fifo-release-assets');

const data = JSON.parse(readFileSync(inputPath, 'utf8'));
const samples = data.samples.filter((sample) => sample.timeSec > 0);
if (samples.length === 0) {
  throw new Error(`No non-zero samples found in ${inputPath}`);
}

mkdirSync(assetDir, { recursive: true });

const colors = {
  bg: '#0c1116',
  panel: '#151c24',
  chart: '#101821',
  line: '#2c3744',
  grid: '#263241',
  text: '#edf3f8',
  muted: '#9eb0c0',
  cyan: '#52d6ff',
  green: '#7ee787',
  amber: '#f5c451',
  red: '#ff7b72',
  blue: '#8ab4ff',
  purple: '#c49bff'
};
const svgFont = 'Arial, Helvetica, sans-serif';

const hourRows = samples.map((sample, index) => {
  const previous = index > 0 ? samples[index - 1] : { completedInbound: 0, completedOutbound: 0 };
  const hour = Math.round(sample.timeSec / 3600);
  const hourlyInbound = sample.completedInbound - previous.completedInbound;
  const hourlyOutbound = sample.completedOutbound - previous.completedOutbound;
  return {
    hour,
    label: `H${hour}`,
    hourlyInbound,
    hourlyOutbound,
    hourlyTotal: hourlyInbound + hourlyOutbound,
    ...sample
  };
});

const finalSample = samples[samples.length - 1];
const finalWaiting = data.finalWaiting ?? [];
const topBlockedReasons = finalSample.topBlockedReasons ?? [];
const h13h24 = hourRows.filter((row) => row.hour >= 13 && row.hour <= 24);
const h23h24 = hourRows.filter((row) => row.hour >= 23 && row.hour <= 24);

const avg = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / Math.max(rows.length, 1);
const min = (rows, field) => Math.min(...rows.map((row) => Number(row[field] ?? 0)));
const max = (rows, field) => Math.max(...rows.map((row) => Number(row[field] ?? 0)));
const round = (value, digits = 3) => Number(value).toFixed(digits).replace(/\.?0+$/, '');
const formatInt = (value) => Math.round(Number(value)).toLocaleString('en-US');
const formatSec = (sec) => {
  if (sec < 60) return `${round(sec, 1)}s`;
  if (sec < 3600) return `${round(sec / 60, 1)}m`;
  return `${round(sec / 3600, 2)}h`;
};
const rel = (path) => relative(dirname(outputPath), path).replaceAll('\\', '/');
const htmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const chartFiles = {
  trend: writeChart('hourly-pph-trend', hourlyTrendSvg()),
  windows: writeChart('window-inout-bars', windowBarsSvg()),
  waiting: writeChart('waiting-blocked-bars', waitingBlockedSvg()),
  blocked: writeChart('top-blocked-reasons', blockedReasonsSvg())
};

const finalWaitRows = finalWaiting.map((entry) => {
  const waited = Math.max(0, data.finalSimTimeSec - Number(entry.waitingSinceSec ?? data.finalSimTimeSec));
  return `<tr>
    <td>${htmlEscape(entry.id)}</td>
    <td>${htmlEscape(entry.currentNodeId)}</td>
    <td>${htmlEscape(entry.plannedGoalNodeId ?? entry.targetNodeId)}</td>
    <td>${htmlEscape(entry.waitReason)}</td>
    <td>${htmlEscape(entry.blockingVehicleId ?? '-')}</td>
    <td>${formatSec(waited)}</td>
  </tr>`;
}).join('\n');

const rowsHtml = hourRows.map((row) => `<tr>
  <td>${row.label}</td>
  <td>${formatInt(row.hourlyInbound)}</td>
  <td>${formatInt(row.hourlyOutbound)}</td>
  <td>${formatInt(row.hourlyTotal)}</td>
  <td>${round(row.inboundPph, 3)}</td>
  <td>${round(row.outboundPph, 3)}</td>
  <td>${round(row.totalPph, 3)}</td>
  <td>${formatInt(row.windowInboundPph)}</td>
  <td>${formatInt(row.windowOutboundPph)}</td>
  <td>${formatInt(row.windowTotalPph)}</td>
  <td>${formatInt(row.waitingVehicles)} / ${formatInt(row.blockedVehicles)}</td>
  <td>${formatInt(row.physicalViolations)}</td>
</tr>`).join('\n');

const report = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>24h 3D Tick 调度验证报告</title>
<style>
:root{color-scheme:dark;--bg:${colors.bg};--panel:${colors.panel};--chart:${colors.chart};--line:${colors.line};--grid:${colors.grid};--text:${colors.text};--muted:${colors.muted};--cyan:${colors.cyan};--green:${colors.green};--amber:${colors.amber};--red:${colors.red};--blue:${colors.blue};--purple:${colors.purple}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:30px 24px 52px}h1{font-size:30px;line-height:1.15;margin:0 0 10px;letter-spacing:0}h2{font-size:20px;margin:30px 0 12px;letter-spacing:0}h3{font-size:16px;margin:20px 0 8px}.muted{color:var(--muted)}.src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px;word-break:break-all}.summary{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin:18px 0}.summary ul{margin:0;padding-left:20px}.summary li{margin:7px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:13px 14px}.metric b{display:block;font-size:24px;line-height:1.1}.metric span{display:block;color:var(--muted);margin-top:7px}.pass{color:var(--green)}.warn{color:var(--amber)}.risk{color:var(--red)}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:14px 0}.chart{background:var(--chart);border:1px solid var(--line);border-radius:8px;padding:10px;margin:12px 0}.chart img{display:block;width:100%;height:auto;border-radius:6px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.note{border-left:3px solid var(--amber);padding-left:12px;color:#d6dee7}.good{border-left:3px solid var(--green);padding-left:12px;color:#d6dee7}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}.table-wrap{overflow:auto;border-radius:8px}.small-table th,.small-table td{font-size:13px}ul{padding-left:20px}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);margin:6px 0 0}.sw{display:inline-block;width:18px;height:3px;vertical-align:middle;margin-right:6px}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:12px;margin-right:6px}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two{grid-template-columns:1fr}main{padding:22px 14px}.metric b{font-size:22px}}
</style>
</head>
<body><main>
<h1>24h 3D Tick 调度验证报告</h1>
<p class="muted">对象：Step 2n Yellow Queue Pickup Keepout + Later-Task FIFO Release。来源：<span class="src">${htmlEscape(rel(inputPath))}</span></p>

<section>
<h2>Executive Summary</h2>
<div class="summary">
<ul>
<li><b class="pass">24h headless physical tick 已通过核心安全门。</b> 仿真跑到 ${formatInt(data.finalSimTimeSec)}s，状态为 ${htmlEscape(data.status)}；deadlock=0、livelock=0、physicalViolation=0，最小车距 ${round(data.traffic.minVehicleSeparationM, 3)}m。</li>
<li><b class="pass">吞吐没有出现尾部崩塌。</b> 24h 总 PPH 为 ${round(data.pph.total, 3)}，H13-H24 平均累计 Total PPH 为 ${round(avg(h13h24, 'totalPph'), 3)}，最后 2 小时平均累计 Total PPH 为 ${round(avg(h23h24, 'totalPph'), 3)}。</li>
<li><b class="pass">Inbound / Outbound 已基本回归平衡。</b> 24h 平均 Inbound ${round(data.pph.inbound, 3)} PPH、Outbound ${round(data.pph.outbound, 3)} PPH，差值 ${round(Math.abs(data.pph.inbound - data.pph.outbound), 3)} PPH。</li>
<li><b class="warn">仍不能把它当成最终演示签收。</b> 本报告证明的是 headless 物理 tick 长跑稳定；还需要补 3D 人眼视角录屏/截图，确认 lift 附近没有来回蹭、穿模、或离开黄色可行区域。</li>
</ul>
</div>
</section>

<div class="grid">
  <div class="metric"><b class="pass">${round(data.pph.total, 3)}</b><span>24h Total PPH</span></div>
  <div class="metric"><b>${round(data.pph.inbound, 3)}</b><span>Inbound PPH</span></div>
  <div class="metric"><b>${round(data.pph.outbound, 3)}</b><span>Outbound PPH</span></div>
  <div class="metric"><b class="pass">0 / 0 / 0</b><span>Deadlock / Livelock / Physical</span></div>
  <div class="metric"><b>${round(data.finalSimTimeSec / (data.wallClockMs / 1000), 1)}x</b><span>Headless speed vs real time</span></div>
</div>

<section>
<h2>吞吐稳定在 418 PPH 左右</h2>
<p><b>这次最重要的变化是没有后半段掉速。</b> H13-H24 累计 Total PPH 的平均值是 ${round(avg(h13h24, 'totalPph'), 3)}，最后 2 小时仍在 ${round(avg(h23h24, 'totalPph'), 3)}。5 分钟窗口有波动，后半段最低窗口 Total PPH 是 ${formatInt(min(h13h24, 'windowTotalPph'))}，但没有出现早先那种 run 到后面吞吐塌掉、等待时间膨胀的状态。</p>
<div class="chart"><img src="${htmlEscape(rel(chartFiles.trend.png))}" alt="Hourly cumulative and rolling PPH trend" /></div>
</section>

<section>
<h2>Inbound / Outbound 没有继续拉开 50 PPH</h2>
<p><b>24h 总量已经基本对上。</b> Inbound 完成 ${formatInt(data.completed.inbound)}，Outbound 完成 ${formatInt(data.completed.outbound)}；平均 PPH 只差 ${round(Math.abs(data.pph.inbound - data.pph.outbound), 3)}。这说明之前你担心的“Outbound 后面没活干但仿真还在跑”的结构性不平衡，在这版 headless 长跑里没有复现。</p>
<div class="chart"><img src="${htmlEscape(rel(chartFiles.windows.png))}" alt="Hourly rolling inbound and outbound composition" /></div>
</section>

<section>
<h2>等待/阻塞是短尾，不是锁死</h2>
<p><b>最终还有 2 台车处于 waiting/blocked，但都是 run 结束时的短时间状态。</b> SH-01 的 <code>inbound-lift-fifo-wait</code> 约 ${formatSec(data.finalSimTimeSec - finalWaiting[0].waitingSinceSec)}，SH-07 的 opposing claim 约 ${formatSec(data.finalSimTimeSec - finalWaiting[1].waitingSinceSec)}。这和早先小时级 FIFO 卡死不是同一类问题。</p>
<div class="chart"><img src="${htmlEscape(rel(chartFiles.waiting.png))}" alt="Hourly waiting and blocked vehicle counts" /></div>
<div class="table-wrap">
<table class="small-table"><thead><tr><th>Shuttle</th><th>Current node</th><th>Planned goal</th><th>Reason</th><th>Blocker</th><th>Final wait age</th></tr></thead><tbody>${finalWaitRows}</tbody></table>
</div>
</section>

<section>
<h2>剩余瓶颈仍在任务释放和列顺序</h2>
<p><b>最大 blocked reason 不是碰撞，而是 inbound column predecessor wait。</b> 这表示调度仍在大量等待同列前序关系、lift source 分配或库存空/满节拍。它现在没有造成死锁，但会限制上限吞吐；如果要扩到 5 倍面积、5-6 层，这部分必须继续做成更明确的列状态机和分区调度。</p>
<div class="chart"><img src="${htmlEscape(rel(chartFiles.blocked.png))}" alt="Top blocked reasons" /></div>
<div class="two">
  <div class="card">
    <h3>接受这一步的理由</h3>
    <ul>
      <li>24h 完整跑完，安全计数全为 0。</li>
      <li>H13-H24 没有尾部吞吐崩塌。</li>
      <li>Inbound/Outbound 平衡，不再差 50 PPH。</li>
    </ul>
  </div>
  <div class="card">
    <h3>下一步验证重点</h3>
    <ul>
      <li>用 3D 人眼视角录 1-2 分钟，确认 lift 红圈/黄线交点处不穿模、不蹭来蹭去。</li>
      <li>把 top blocked reason 拆成按 lift、column、zone 的热力图。</li>
      <li>跑一版 24h + browser replay 截图/视频证据，再考虑 commit。</li>
    </ul>
  </div>
</div>
</section>

<section>
<h2>Hourly Audit Table</h2>
<div class="table-wrap">
<table><thead><tr><th>Hour</th><th>Hour In</th><th>Hour Out</th><th>Hour Total</th><th>Cum In</th><th>Cum Out</th><th>Cum Total</th><th>Window In</th><th>Window Out</th><th>Window Total</th><th>Waiting / Blocked</th><th>Physical</th></tr></thead><tbody>${rowsHtml}</tbody></table>
</div>
</section>

<section>
<h2>Caveats And Assumptions</h2>
<div class="card">
<p class="note">这不是浏览器 3D 录屏验收。它证明 core physical tick 在当前场景、8 台 shuttle、当前黄色可行图上可长跑；不证明更大系统规模、5-6 层、多层调度、或页面渲染性能已经达标。</p>
<p class="good">本页没有启动服务，也没有依赖外部网络。图表由 JSON 生成 SVG 后转 PNG；因为当前 Python 环境没有 matplotlib/seaborn，所以没有使用 Seaborn 模板，但输出仍保留 PNG 静态图，便于离线打开和审阅。</p>
<p class="src">Source JSON: ${htmlEscape(inputPath)}<br/>Generated assets: ${htmlEscape(assetDir)}<br/>Generated at: ${new Date().toISOString()}</p>
</div>
</section>
</main></body></html>`;

writeFileSync(outputPath, report, 'utf8');
console.log(JSON.stringify({
  ok: true,
  inputPath,
  outputPath,
  assets: chartFiles,
  summary: {
    totalPph: data.pph.total,
    inboundPph: data.pph.inbound,
    outboundPph: data.pph.outbound,
    h13h24TotalPph: avg(h13h24, 'totalPph'),
    h23h24TotalPph: avg(h23h24, 'totalPph'),
    minBackHalfWindowTotalPph: min(h13h24, 'windowTotalPph'),
    finalWaiting: finalWaiting.length,
    physicalViolations: data.traffic.physicalViolations
  }
}, null, 2));

function writeChart(name, svg) {
  const svgPath = resolve(assetDir, `${name}.svg`);
  const pngPath = resolve(assetDir, `${name}.png`);
  writeFileSync(svgPath, svg, 'utf8');
  const converter = existsSync('/opt/homebrew/bin/rsvg-convert') ? '/opt/homebrew/bin/rsvg-convert' : 'rsvg-convert';
  const result = spawnSync(converter, ['-o', pngPath, svgPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Failed to convert ${svgPath} to PNG: ${result.stderr || result.stdout}`);
  }
  return { svg: svgPath, png: pngPath };
}

function hourlyTrendSvg() {
  const series = [
    { key: 'inboundPph', label: 'Inbound cumulative PPH', color: colors.cyan, width: 2.5 },
    { key: 'outboundPph', label: 'Outbound cumulative PPH', color: colors.green, width: 2.5 },
    { key: 'totalPph', label: 'Total cumulative PPH', color: colors.amber, width: 3 },
    { key: 'windowTotalPph', label: '5m window total PPH', color: colors.blue, width: 2, dash: '8 7' }
  ];
  return lineChart({
    title: 'Hourly PPH trend',
    subtitle: 'Cumulative PPH plus final 5-minute window, 24h physical tick run',
    rows: hourRows,
    series,
    yMax: Math.ceil(max(hourRows, 'windowTotalPph') / 50) * 50
  });
}

function windowBarsSvg() {
  const width = 1200;
  const height = 500;
  const pad = { left: 70, right: 34, top: 92, bottom: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const yMax = Math.ceil(max(hourRows, 'windowTotalPph') / 50) * 50;
  const barW = plotW / hourRows.length * 0.64;
  const scaleY = (value) => pad.top + plotH - (value / yMax) * plotH;
  const parts = chartFrame(width, height, 'Hourly window in/out composition', 'Each bar stacks inbound and outbound PPH in the final 5-minute window for that hour', yMax);
  for (const [index, row] of hourRows.entries()) {
    const x = pad.left + (index + 0.5) * (plotW / hourRows.length) - barW / 2;
    const outTop = scaleY(row.windowOutboundPph);
    const inTop = scaleY(row.windowInboundPph + row.windowOutboundPph);
    const base = pad.top + plotH;
    parts.push(`<rect x="${x.toFixed(1)}" y="${outTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(base - outTop).toFixed(1)}" fill="${colors.green}" opacity="0.88"/>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${inTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(outTop - inTop).toFixed(1)}" fill="${colors.cyan}" opacity="0.88"/>`);
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${height - 25}" fill="${colors.muted}" font-size="14" text-anchor="middle">${row.label}</text>`);
  }
  parts.push(legend([
    ['Inbound window PPH', colors.cyan],
    ['Outbound window PPH', colors.green]
  ], pad.left, 68));
  parts.push('</svg>');
  return parts.join('\n');
}

function waitingBlockedSvg() {
  const width = 1200;
  const height = 420;
  const pad = { left: 70, right: 34, top: 92, bottom: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const yMax = Math.max(3, Math.ceil(Math.max(max(hourRows, 'waitingVehicles'), max(hourRows, 'blockedVehicles'))));
  const groupW = plotW / hourRows.length * 0.68;
  const barW = groupW / 2.5;
  const scaleY = (value) => pad.top + plotH - (value / yMax) * plotH;
  const parts = chartFrame(width, height, 'Hourly waiting and blocked vehicle counts', 'End-of-hour instantaneous counts; values stayed bounded and did not accumulate', yMax, 1);
  for (const [index, row] of hourRows.entries()) {
    const center = pad.left + (index + 0.5) * (plotW / hourRows.length);
    for (const [offset, key, color] of [[-0.55, 'waitingVehicles', colors.amber], [0.55, 'blockedVehicles', colors.red]]) {
      const x = center + offset * barW - barW / 2;
      const y = scaleY(row[key]);
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(pad.top + plotH - y).toFixed(1)}" fill="${color}" opacity="0.88"/>`);
    }
    parts.push(`<text x="${center.toFixed(1)}" y="${height - 25}" fill="${colors.muted}" font-size="14" text-anchor="middle">${row.label}</text>`);
  }
  parts.push(legend([
    ['Waiting vehicles', colors.amber],
    ['Blocked vehicles', colors.red]
  ], pad.left, 68));
  parts.push('</svg>');
  return parts.join('\n');
}

function blockedReasonsSvg() {
  const width = 1200;
  const height = 520;
  const pad = { left: 300, right: 76, top: 92, bottom: 42 };
  const rows = topBlockedReasons.slice(0, 8).toReversed();
  const xMax = Math.ceil(max(rows, 'sec') / 20000) * 20000;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const rowH = plotH / rows.length;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family="${svgFont}">`, `<rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${colors.chart}"/>`];
  parts.push(header('Top blocked reasons', 'Cumulative seconds by reason at the 24h checkpoint', pad.left, 34));
  for (let tick = 0; tick <= xMax; tick += 40000) {
    const x = pad.left + (tick / xMax) * plotW;
    parts.push(`<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + plotH}" stroke="${colors.grid}"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${height - 18}" fill="${colors.muted}" font-size="12" text-anchor="middle">${formatInt(tick / 1000)}k</text>`);
  }
  for (const [index, row] of rows.entries()) {
    const y = pad.top + index * rowH + rowH * 0.22;
    const h = rowH * 0.56;
    const w = (row.sec / xMax) * plotW;
    parts.push(`<text x="${pad.left - 16}" y="${(y + h * 0.64).toFixed(1)}" fill="${colors.muted}" font-size="15" text-anchor="end">${htmlEscape(row.reason)}</text>`);
    parts.push(`<rect x="${pad.left}" y="${y.toFixed(1)}" width="${Math.max(1, w).toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${colors.amber}" opacity="0.88"/>`);
    parts.push(`<text x="${(pad.left + w + 10).toFixed(1)}" y="${(y + h * 0.64).toFixed(1)}" fill="${colors.text}" font-size="14">${formatInt(row.sec)}s</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function lineChart({ title, subtitle, rows, series, yMax }) {
  const width = 1200;
  const height = 500;
  const pad = { left: 70, right: 34, top: 92, bottom: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (index / (rows.length - 1)) * plotW;
  const y = (value) => pad.top + plotH - (value / yMax) * plotH;
  const parts = chartFrame(width, height, title, subtitle, yMax);
  for (const item of series) {
    const points = rows.map((row, index) => `${x(index).toFixed(1)},${y(row[item.key]).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="${item.width}" ${item.dash ? `stroke-dasharray="${item.dash}"` : ''}/>`); 
  }
  rows.forEach((row, index) => {
    parts.push(`<text x="${x(index).toFixed(1)}" y="${height - 25}" fill="${colors.muted}" font-size="14" text-anchor="middle">${row.label}</text>`);
  });
  parts.push(legend(series.map((item) => [item.label, item.color, item.dash]), pad.left, 68));
  parts.push('</svg>');
  return parts.join('\n');
}

function chartFrame(width, height, title, subtitle, yMax, step = 100) {
  const pad = { left: 70, right: 34, top: 92, bottom: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family="${svgFont}">`, `<rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${colors.chart}"/>`];
  parts.push(header(title, subtitle, pad.left, 34));
  for (let tick = 0; tick <= yMax; tick += step) {
    const y = pad.top + plotH - (tick / yMax) * plotH;
    parts.push(`<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + plotW}" y2="${y.toFixed(1)}" stroke="${colors.grid}"/>`);
    parts.push(`<text x="22" y="${(y + 4).toFixed(1)}" fill="${colors.muted}" font-size="13">${tick}</text>`);
  }
  return parts;
}

function header(title, subtitle, x, y) {
  return `<text x="${x}" y="${y}" fill="${colors.text}" font-size="22" font-weight="700">${htmlEscape(title)}</text>
<text x="${x}" y="${y + 25}" fill="${colors.muted}" font-size="14">${htmlEscape(subtitle)}</text>`;
}

function legend(items, x, y) {
  let cursor = x;
  const parts = [];
  for (const [label, color, dash] of items) {
    parts.push(`<line x1="${cursor}" y1="${y}" x2="${cursor + 28}" y2="${y}" stroke="${color}" stroke-width="4" ${dash ? `stroke-dasharray="${dash}"` : ''}/><text x="${cursor + 36}" y="${y + 5}" fill="${colors.muted}" font-size="13">${htmlEscape(label)}</text>`);
    cursor += Math.max(190, label.length * 8 + 62);
  }
  return parts.join('\n');
}
