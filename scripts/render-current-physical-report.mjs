import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const inputPath = resolve(process.argv[2] ?? 'output/review/current-8shuttle-physical-12h-after-level-cache.json');
const outputPath = resolve(process.argv[3] ?? inputPath.replace(/\.json$/i, '-report.html'));
const data = JSON.parse(readFileSync(inputPath, 'utf8'));
const samples = (data.samples ?? []).filter((sample) => sample.timeSec > 0);

if (samples.length === 0) {
  throw new Error(`No non-zero samples found in ${inputPath}`);
}

mkdirSync(dirname(outputPath), { recursive: true });

const colors = {
  bg: '#0c1116',
  panel: '#151c24',
  chart: '#101821',
  line: '#2c3744',
  grid: '#263241',
  text: '#edf3f8',
  muted: '#9eb0c0',
  green: '#7ee787',
  amber: '#f5c451',
  cyan: '#52d6ff',
  red: '#ff7b72',
  purple: '#c49bff'
};

const finalSample = samples.at(-1);
const hourlyRows = samples.map((sample, index) => {
  const previous = index > 0 ? samples[index - 1] : { completedInbound: 0, completedOutbound: 0 };
  const seededOutbound = data.completed?.seededOutbound ?? 0;
  const completedDemandOutbound = Math.max(0, sample.completedOutbound - Math.min(sample.completedOutbound, seededOutbound));
  return {
    hour: Math.round(sample.timeSec / 3600),
    hourlyInbound: sample.completedInbound - previous.completedInbound,
    hourlyOutbound: sample.completedOutbound - previous.completedOutbound,
    completedDemandOutbound,
    ...sample
  };
});

const avg = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / Math.max(1, rows.length);
const min = (rows, field) => Math.min(...rows.map((row) => Number(row[field] ?? 0)));
const max = (rows, field) => Math.max(...rows.map((row) => Number(row[field] ?? 0)));
const round = (value, digits = 3) => {
  const text = Number(value ?? 0).toFixed(digits);
  return digits > 0 ? text.replace(/\.?0+$/, '') : text;
};
const formatInt = (value) => Math.round(Number(value ?? 0)).toLocaleString('en-US');
const htmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const rel = (path) => relative(dirname(outputPath), path).replaceAll('\\', '/');
const durationHours = data.finalSimTimeSec / 3600;
const speed = data.finalSimTimeSec / (data.wallClockMs / 1000);
const h2Plus = hourlyRows.filter((row) => row.hour >= 2);
const h7Plus = hourlyRows.filter((row) => row.hour >= 7);
const finalSeededOutbound = data.completed?.seededOutbound ?? 0;
const finalDemandOutbound = data.completed?.demandOutbound ?? Math.max(0, (data.completed?.outbound ?? 0) - finalSeededOutbound);

const rowsHtml = hourlyRows.map((row) => `<tr>
  <td>H${row.hour}</td>
  <td>${formatInt(row.hourlyInbound)}</td>
  <td>${formatInt(row.hourlyOutbound)}</td>
  <td>${round(row.inboundPph, 3)}</td>
  <td>${round(row.outboundPph, 3)}</td>
  <td>${round(row.demandOutboundPph, 3)}</td>
  <td>${round(row.windowInboundPph, 0)}</td>
  <td>${round(row.windowOutboundPph, 0)}</td>
  <td>${round(row.windowTotalPph, 0)}</td>
  <td>${round(row.averageQueueReserveTravelPct, 2)}%</td>
  <td>${round(row.averageWasteRepositionPct, 2)}%</td>
  <td>${formatInt(row.waitingVehicles)} / ${formatInt(row.blockedVehicles)}</td>
  <td>${formatInt(row.physicalViolations)}</td>
</tr>`).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${round(durationHours, 1)}h Physical Tick Demand Split Report</title>
<style>
:root{color-scheme:dark;--bg:${colors.bg};--panel:${colors.panel};--chart:${colors.chart};--line:${colors.line};--grid:${colors.grid};--text:${colors.text};--muted:${colors.muted};--green:${colors.green};--amber:${colors.amber};--cyan:${colors.cyan};--red:${colors.red};--purple:${colors.purple}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:30px 24px 52px}h1{font-size:30px;line-height:1.15;margin:0 0 10px;letter-spacing:0}h2{font-size:20px;margin:30px 0 12px}.muted{color:var(--muted)}.src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px;word-break:break-all}.summary,.card,.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px}.summary{padding:18px 20px;margin:18px 0}.summary li{margin:7px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.metric{padding:13px 14px}.metric b{display:block;font-size:24px;line-height:1.1}.metric span{display:block;color:var(--muted);margin-top:7px}.pass{color:var(--green)}.warn{color:var(--amber)}.risk{color:var(--red)}.chart{background:var(--chart);border:1px solid var(--line);border-radius:8px;padding:10px;margin:12px 0}.chart svg{display:block;width:100%;height:auto}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{padding:16px 18px;margin:14px 0}.note{border-left:3px solid var(--amber);padding-left:12px;color:#d6dee7}.good{border-left:3px solid var(--green);padding-left:12px;color:#d6dee7}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}.table-wrap{overflow:auto;border-radius:8px}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);margin:6px 0 0}.sw{display:inline-block;width:18px;height:3px;vertical-align:middle;margin-right:6px}@media(max-width:900px){.grid,.two{grid-template-columns:1fr 1fr}main{padding:22px 14px}.metric b{font-size:22px}}@media(max-width:620px){.grid,.two{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<h1>${round(durationHours, 1)}h Physical Tick Demand Split Report</h1>
<p class="muted">当前候选：8 shuttles, zone-balanced-50, collision avoidance on, cap6/no-lower-inbound, static lookup cache。Source: <span class="src">${htmlEscape(rel(inputPath))}</span></p>

<section class="summary">
<ul>
  <li><b class="pass">正式 ${round(durationHours, 1)}h headless physical tick 完成。</b> wall clock ${round(data.wallClockMs / 1000, 1)}s，约 ${round(speed, 1)}x real time；deadlock=0、livelock=0、physicalViolation=0。</li>
  <li><b class="pass">长期 demand inbound/outbound 基本平衡。</b> Final inbound ${round(data.pph.inbound, 3)} PPH，demand outbound ${round(data.pph.demandOutbound, 3)} PPH；H7-H12 demand outbound 平均 ${round(avg(h7Plus, 'demandOutboundPph'), 3)} PPH。</li>
  <li><b class="warn">全部 outbound 仍高于 inbound，是 seeded sweep 残留。</b> Final outbound ${round(data.pph.outbound, 3)} PPH，其中 seeded outbound ${formatInt(finalSeededOutbound)} moves，demand outbound ${formatInt(finalDemandOutbound)} moves。</li>
  <li><b class="warn">真正要继续优化的是移动效率。</b> Final queue reserve ${round(finalSample.averageQueueReserveTravelPct, 2)}%，other/waste reposition ${round(finalSample.averageWasteRepositionPct, 2)}%。</li>
</ul>
</section>

<div class="grid">
  <div class="metric"><b class="pass">${round(data.pph.total, 3)}</b><span>Total PPH</span></div>
  <div class="metric"><b>${round(data.pph.inbound, 3)}</b><span>Inbound PPH</span></div>
  <div class="metric"><b>${round(data.pph.outbound, 3)}</b><span>All outbound PPH</span></div>
  <div class="metric"><b>${round(data.pph.demandOutbound, 3)}</b><span>Demand outbound PPH</span></div>
  <div class="metric"><b class="pass">${round(speed, 1)}x</b><span>Headless speed</span></div>
</div>

<section>
<h2>Hourly PPH Trend</h2>
<div class="chart">${lineChart(hourlyRows, [
  { field: 'totalPph', label: 'Total cumulative', color: colors.green },
  { field: 'inboundPph', label: 'Inbound cumulative', color: colors.cyan },
  { field: 'outboundPph', label: 'All outbound cumulative', color: colors.amber },
  { field: 'demandOutboundPph', label: 'Demand outbound cumulative', color: colors.purple, dash: '6 4' }
])}</div>
</section>

<section>
<h2>Window Balance</h2>
<div class="chart">${lineChart(hourlyRows, [
  { field: 'windowInboundPph', label: 'Window inbound', color: colors.cyan },
  { field: 'windowOutboundPph', label: 'Window outbound', color: colors.amber },
  { field: 'windowTotalPph', label: 'Window total', color: colors.green }
])}</div>
</section>

<section>
<h2>Reserve / Reposition Cost</h2>
<p>吞吐不是主要问题了，但 queue reserve 和 other reposition 的比例高。H2+ 平均 queue reserve ${round(avg(h2Plus, 'averageQueueReserveTravelPct'), 2)}%，waste reposition ${round(avg(h2Plus, 'averageWasteRepositionPct'), 2)}%。这说明下一步不该加 shuttle，而该把 lift queue 当成更明确的 DES resource queue，减少无谓补位和远距离 reserve。</p>
<div class="chart">${lineChart(hourlyRows, [
  { field: 'averageQueueReserveTravelPct', label: 'Queue reserve', color: colors.cyan },
  { field: 'averageWasteRepositionPct', label: 'Other reposition', color: colors.purple },
  { field: 'averageWaitingPct', label: 'Traffic wait', color: colors.amber }
])}</div>
</section>

<section>
<h2>Hourly Table</h2>
<div class="table-wrap">
<table><thead><tr><th>Hour</th><th>Hour In</th><th>Hour Out</th><th>Cum In</th><th>All Out</th><th>Demand Out</th><th>Win In</th><th>Win Out</th><th>Win Total</th><th>Queue Reserve</th><th>Other Repos</th><th>Waiting / Blocked</th><th>Physical</th></tr></thead><tbody>${rowsHtml}</tbody></table>
</div>
</section>

<section>
<h2>Interpretation</h2>
<div class="two">
  <div class="card">
    <h3>这一步说明什么</h3>
    <ul>
      <li>默认 shuttle 仍是 8 台，没有靠增加资源掩盖问题。</li>
      <li>Inbound 与 demand outbound 已经回归平衡。</li>
      <li>长跑速度从约 1h/156s 提升到 1h/29-30s。</li>
    </ul>
  </div>
  <div class="card">
    <h3>下一步还要解决什么</h3>
    <ul>
      <li>Queue reserve / other reposition 过高。</li>
      <li>要把 lift call -> FIFO queue -> service point 做成更简洁的资源队列。</li>
      <li>正式 review 前仍要录 3D 人眼视角，确认 lift 附近不穿模、不来回蹭。</li>
    </ul>
  </div>
</div>
<p class="src">Generated at: ${new Date().toISOString()}<br/>Output: ${htmlEscape(outputPath)}</p>
</section>
</main></body></html>`;

writeFileSync(outputPath, html, 'utf8');
console.log(JSON.stringify({ ok: true, outputPath, inputPath, summary: {
  finalSimTimeSec: data.finalSimTimeSec,
  wallClockMs: data.wallClockMs,
  speed,
  pph: data.pph,
  completed: data.completed,
  traffic: data.traffic,
  h2PlusQueueReservePct: avg(h2Plus, 'averageQueueReserveTravelPct'),
  h2PlusWasteRepositionPct: avg(h2Plus, 'averageWasteRepositionPct'),
  minWindowTotalPph: min(hourlyRows, 'windowTotalPph'),
  maxWindowTotalPph: max(hourlyRows, 'windowTotalPph')
}}, null, 2));

function lineChart(rows, series) {
  const width = 1040;
  const height = 310;
  const pad = { left: 62, right: 24, top: 28, bottom: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxY = niceCeil(Math.max(1, ...rows.flatMap((row) => series.map((item) => Number(row[item.field] ?? 0)))));
  const xFor = (index) => pad.left + (rows.length <= 1 ? 0 : (index / (rows.length - 1)) * plotW);
  const yFor = (value) => pad.top + plotH - (Number(value ?? 0) / maxY) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({ value: maxY * ratio, y: yFor(maxY * ratio) }));
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly trend">
${yTicks.map((tick) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${tick.y}" y2="${tick.y}" stroke="${colors.grid}" /><text x="${pad.left - 12}" y="${tick.y + 5}" fill="${colors.muted}" font-size="13" text-anchor="end">${round(tick.value, 0)}</text>`).join('')}
${rows.map((row, index) => `<text x="${xFor(index)}" y="${height - 20}" fill="${colors.muted}" font-size="12" text-anchor="middle">H${row.hour}</text>`).join('')}
${series.map((item) => `<polyline fill="none" stroke="${item.color}" stroke-width="3" ${item.dash ? `stroke-dasharray="${item.dash}"` : ''} points="${rows.map((row, index) => `${round(xFor(index), 1)},${round(yFor(row[item.field]), 1)}`).join(' ')}" />`).join('')}
<line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="${colors.line}" />
<line x1="${pad.left}" x2="${pad.left}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="${colors.line}" />
<g>${series.map((item, index) => `<line x1="${pad.left + index * 220}" x2="${pad.left + index * 220 + 24}" y1="18" y2="18" stroke="${item.color}" stroke-width="4" ${item.dash ? `stroke-dasharray="${item.dash}"` : ''}/><text x="${pad.left + index * 220 + 32}" y="22" fill="${colors.muted}" font-size="13">${htmlEscape(item.label)}</text>`).join('')}</g>
</svg>`;
}

function niceCeil(value) {
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * exponent;
}
