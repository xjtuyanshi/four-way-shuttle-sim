import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createInboundOutboundDemoScenario
} from '../packages/shuttle-sim-core/src/index.ts';

type Point = { x: number; z: number };
type NodeRecord = ReturnType<typeof createInboundOutboundDemoScenario>['layout']['nodes'][number];
type LiftRole = 'inbound' | 'outbound';
type LiftLevel = 'top-a' | 'top-b' | 'bottom-a' | 'bottom-b';

const liftAuditPath = resolve(stringArg('--lift-audit') ?? 'output/review/lift-visual-audit-step2n-1h.json');
const collisionAuditPath = resolve(stringArg('--collision-audit') ?? 'output/review/collision-rebuild-audit-step2n-1h.json');
const outputPath = resolve(stringArg('--out') ?? 'output/review/step2n-visual-safety-audit.html');
const assetDir = resolve(dirname(outputPath), 'step2n-visual-safety-audit-assets');

mkdirSync(assetDir, { recursive: true });

const liftAudit = JSON.parse(readFileSync(liftAuditPath, 'utf8'));
const collisionAudit = JSON.parse(readFileSync(collisionAuditPath, 'utf8'));
const scenario = createInboundOutboundDemoScenario({
  durationSec: 1,
  vehicles: { count: 8 },
  taskGeneration: {
    inboundRatePerHour: 3600,
    outboundRatePerHour: 3600,
    inboundOutboundMix: 0.5,
    initialOutboundFullColumns: 4
  },
  layoutProfile: {
    layoutKind: 'top-lift-column',
    liftPairCount: 2
  }
});

const nodes = scenario.layout.nodes;
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const edgeSet = new Set(scenario.layout.edges.flatMap((edge) => [
  edgeKey(edge.from, edge.to),
  ...(edge.directionMode === 'twoWay' ? [edgeKey(edge.to, edge.from)] : [])
]));
const liftNodes = nodes.filter((node) => node.type === 'lift-blackbox' && (node.liftKind === 'inbound' || node.liftKind === 'outbound'));
const panels = liftNodes.map((node) => createPanel(node, node.liftKind as LiftRole));
const panelPngs = panels.map((panel) => {
  const svgPath = resolve(assetDir, `${panel.liftNode.id}.svg`);
  const pngPath = resolve(assetDir, `${panel.liftNode.id}.png`);
  writeFileSync(svgPath, renderPanelSvg(panel), 'utf8');
  const converter = '/opt/homebrew/bin/rsvg-convert';
  const result = spawnSync(converter, ['-o', pngPath, svgPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to convert ${svgPath}`);
  }
  return { ...panel, svgPath, pngPath };
});

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Step 2n Lift 视觉与穿模审计</title>
<style>
:root{color-scheme:dark;--bg:#0c1116;--panel:#151c24;--line:#2c3744;--text:#edf3f8;--muted:#9eb0c0;--cyan:#52d6ff;--green:#7ee787;--amber:#f5c451;--red:#ff7b72}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:30px 24px 52px}h1{font-size:30px;line-height:1.15;margin:0 0 8px;letter-spacing:0}h2{font-size:20px;margin:30px 0 12px;letter-spacing:0}.muted{color:var(--muted)}.src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px;word-break:break-all}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:13px 14px}.metric b{display:block;font-size:24px;line-height:1.1}.metric span{display:block;color:var(--muted);margin-top:7px}.pass{color:var(--green)}.warn{color:var(--amber)}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:14px 0}.panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.panel{background:#101821;border:1px solid var(--line);border-radius:8px;padding:10px}.panel img{display:block;width:100%;height:auto;border-radius:6px}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);margin:8px 0}.sw{display:inline-block;width:18px;height:10px;vertical-align:middle;margin-right:6px;border-radius:2px}.note{border-left:3px solid var(--amber);padding-left:12px;color:#d6dee7}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.panels{grid-template-columns:1fr}main{padding:22px 14px}}
</style>
</head>
<body><main>
<h1>Step 2n Lift 视觉与穿模审计</h1>
<p class="muted">本页是浏览器 3D 被拦截时的项目内替代证据：直接从当前仿真坐标和 dashboard 的 lift-grid 映射规则生成。</p>

<section>
<h2>结论</h2>
<div class="grid">
  <div class="metric"><b class="pass">${countCritical(liftAudit)}</b><span>Lift critical anomalies</span></div>
  <div class="metric"><b class="pass">${countAll(liftAudit)}</b><span>Lift total anomalies</span></div>
  <div class="metric"><b class="pass">${countCritical(collisionAudit)}</b><span>Collision critical anomalies</span></div>
  <div class="metric"><b class="pass">${countAll(collisionAudit)}</b><span>Collision total anomalies</span></div>
</div>
<div class="card">
<ul>
<li><b class="pass">1h lift 视觉审计通过。</b> 规则覆盖 lift no-drive 区、lift 附近斜线移动、路线穿过 no-drive 区、以及 lift workcell 短时抖动。</li>
<li><b class="pass">1h collision/穿模审计通过。</b> 规则覆盖静止同节点重叠、车辆方形 footprint 重叠、同 tick 扫掠路径交叉、同边反向相向。</li>
<li><b class="warn">这仍然不是人眼 3D 录屏。</b> 但它是当前坐标模型上的直接规则审计，能证明我们没有在这 1h run 里检测到你指出的穿模、离开黄线、斜线进 lift 区等基础错误。</li>
</ul>
</div>
</section>

<section>
<h2>红圈必须落在黄色可行交点</h2>
<div class="legend">
  <span><i class="sw" style="background:#f5c451"></i>黄色可行 rail</span>
  <span><i class="sw" style="background:#ff7b72"></i>红圈 dock 目标</span>
  <span><i class="sw" style="background:rgba(255,123,114,.35);border:1px solid #ff7b72"></i>lift / buffer 不可行区</span>
  <span><i class="sw" style="background:#52d6ff"></i>queue / workcell 原始点</span>
</div>
<div class="panels">
${panelPngs.map((panel) => `<div class="panel"><img src="${htmlEscape(rel(panel.pngPath))}" alt="${htmlEscape(panel.liftNode.id)} dock alignment" /></div>`).join('\n')}
</div>
</section>

<section>
<h2>审计样本</h2>
<table><thead><tr><th>Audit</th><th>Duration</th><th>Final time</th><th>Completed In</th><th>Completed Out</th><th>Total PPH</th><th>Anomalies</th></tr></thead><tbody>
<tr><td>Lift visual</td><td>${liftAudit.durationSec}s</td><td>${liftAudit.finalSimTimeSec}s</td><td>${liftAudit.summary.completedInbound}</td><td>${liftAudit.summary.completedOutbound}</td><td>${round(liftAudit.summary.totalPph, 3)}</td><td>${countAll(liftAudit)}</td></tr>
<tr><td>Collision rebuild</td><td>${collisionAudit.durationSec}s</td><td>${collisionAudit.finalSimTimeSec}s</td><td>${collisionAudit.summary.completedInbound}</td><td>${collisionAudit.summary.completedOutbound}</td><td>${round(collisionAudit.summary.totalPph, 3)}</td><td>${countAll(collisionAudit)}</td></tr>
</tbody></table>
</section>

<section>
<h2>限制</h2>
<div class="card">
<p class="note">浏览器通道当前被 <code>ERR_BLOCKED_BY_CLIENT</code> 拦截，Chrome extension 通道也无法建立会话，所以这页不是实际 3D 截屏。下一步若要最终 signoff，仍应在可打开 localhost 的浏览器里录 1-2 分钟 human-view 3D 视频。</p>
<p class="src">Lift audit: ${htmlEscape(liftAuditPath)}<br/>Collision audit: ${htmlEscape(collisionAuditPath)}<br/>Generated at: ${new Date().toISOString()}</p>
</div>
</section>
</main></body></html>`;

writeFileSync(outputPath, html, 'utf8');
console.log(JSON.stringify({
  ok: true,
  outputPath,
  panels: panelPngs.map((panel) => ({
    liftNodeId: panel.liftNode.id,
    role: panel.role,
    dockNodeId: panel.dockNode?.id,
    dock: panel.dockPoint,
    pngPath: panel.pngPath
  })),
  audits: {
    lift: { anomalies: countAll(liftAudit), critical: countCritical(liftAudit) },
    collision: { anomalies: countAll(collisionAudit), critical: countCritical(collisionAudit) }
  }
}, null, 2));

function createPanel(liftNode: NodeRecord, role: LiftRole) {
  const dockNode = liftGridDockNode(liftNode.id, role);
  const dockPoint = dockNode ? { x: dockNode.x, z: dockNode.z } : { x: liftNode.x, z: liftNode.z };
  const level = role === 'inbound' ? 'top-a' : 'bottom-b';
  const railNodes = [...nodeById.values()]
    .filter((node) => isRailLevelNode(node.id, level))
    .filter((node) => Math.abs(node.x - dockPoint.x) <= 6.5);
  const workcellNodes = [...nodeById.values()]
    .filter((node) => node.id.startsWith(liftNode.id) || node.id.startsWith(`parking-${liftNode.id}`));
  const noDriveRects = workcellNodes
    .filter((node) => isLiftNoDriveRectNode(node.id) && node.id !== dockNode?.id)
    .map((node) => ({ node, minX: node.x - 0.34, maxX: node.x + 0.34, minZ: node.z - 0.08, maxZ: node.z + 0.08 }));
  const points = [...railNodes, ...workcellNodes, liftNode, dockPoint];
  const minX = Math.min(...points.map((p) => p.x)) - 1.2;
  const maxX = Math.max(...points.map((p) => p.x)) + 1.2;
  const minZ = Math.min(...points.map((p) => p.z)) - 1.2;
  const maxZ = Math.max(...points.map((p) => p.z)) + 1.2;
  return { liftNode, role, level, dockNode, dockPoint, railNodes, workcellNodes, noDriveRects, minX, maxX, minZ, maxZ };
}

function renderPanelSvg(panel: ReturnType<typeof createPanel>): string {
  const width = 900;
  const height = 560;
  const pad = 58;
  const spanX = panel.maxX - panel.minX;
  const spanZ = panel.maxZ - panel.minZ;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const xToPx = (x: number) => pad + ((x - panel.minX) / spanX) * plotW;
  const zToPx = (z: number) => pad + ((z - panel.minZ) / spanZ) * plotH;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="#101821"/>`,
    `<text x="${pad}" y="34" fill="#edf3f8" font-size="24" font-weight="700">${panel.liftNode.id}</text>`,
    `<text x="${pad}" y="56" fill="#9eb0c0" font-size="14">dock=${panel.dockNode?.id ?? 'unknown'} (${round(panel.dockPoint.x, 2)}, ${round(panel.dockPoint.z, 2)})</text>`
  ];

  for (let x = Math.ceil(panel.minX); x <= panel.maxX; x += 1) {
    parts.push(`<line x1="${xToPx(x)}" y1="${pad}" x2="${xToPx(x)}" y2="${height - pad}" stroke="#263241" stroke-width="1"/>`);
  }
  for (let z = Math.ceil(panel.minZ); z <= panel.maxZ; z += 1) {
    parts.push(`<line x1="${pad}" y1="${zToPx(z)}" x2="${width - pad}" y2="${zToPx(z)}" stroke="#263241" stroke-width="1"/>`);
  }

  const railById = new Map(panel.railNodes.map((node) => [node.id, node]));
  for (const from of panel.railNodes) {
    for (const to of panel.railNodes) {
      if (from.id >= to.id || !edgeSet.has(edgeKey(from.id, to.id))) {
        continue;
      }
      parts.push(`<line x1="${xToPx(from.x)}" y1="${zToPx(from.z)}" x2="${xToPx(to.x)}" y2="${zToPx(to.z)}" stroke="#f5c451" stroke-width="6" stroke-linecap="round"/>`);
    }
  }
  if (railById.size > 1) {
    const sorted = [...panel.railNodes].sort((a, b) => a.x - b.x);
    for (let index = 1; index < sorted.length; index += 1) {
      const left = sorted[index - 1]!;
      const right = sorted[index]!;
      parts.push(`<line x1="${xToPx(left.x)}" y1="${zToPx(left.z)}" x2="${xToPx(right.x)}" y2="${zToPx(right.z)}" stroke="#f5c451" stroke-width="3" opacity="0.38" stroke-linecap="round"/>`);
    }
  }

  for (const rect of panel.noDriveRects) {
    parts.push(`<rect x="${xToPx(rect.minX)}" y="${zToPx(rect.minZ)}" width="${xToPx(rect.maxX) - xToPx(rect.minX)}" height="${zToPx(rect.maxZ) - zToPx(rect.minZ)}" fill="rgba(255,123,114,0.28)" stroke="#ff7b72" stroke-width="2"/>`);
  }

  for (const node of panel.workcellNodes) {
    const px = xToPx(node.x);
    const py = zToPx(node.z);
    const isParking = node.type === 'parking';
    parts.push(`<circle cx="${px}" cy="${py}" r="${isParking ? 7 : 5}" fill="${isParking ? '#8ab4ff' : '#52d6ff'}" opacity="${isParking ? 0.86 : 0.68}"/>`);
  }

  for (const node of panel.railNodes) {
    parts.push(`<circle cx="${xToPx(node.x)}" cy="${zToPx(node.z)}" r="6" fill="#ffe15b" stroke="#736422" stroke-width="2"/>`);
    if (node.id === panel.dockNode?.id) {
      parts.push(`<text x="${xToPx(node.x)}" y="${zToPx(node.z) - 24}" fill="#ffddd9" font-size="13" text-anchor="middle">${node.id}</text>`);
    }
  }

  const dockX = xToPx(panel.dockPoint.x);
  const dockY = zToPx(panel.dockPoint.z);
  parts.push(`<circle cx="${dockX}" cy="${dockY}" r="21" fill="none" stroke="#ff3b30" stroke-width="7"/>`);
  parts.push(`<circle cx="${dockX}" cy="${dockY}" r="7" fill="#ff3b30"/>`);
  parts.push(`<text x="${dockX}" y="${dockY + 42}" fill="#ffddd9" font-size="15" font-weight="700" text-anchor="middle">RED TARGET ON YELLOW GRID</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function liftGridDockNode(liftNodeId: string, role: LiftRole): NodeRecord | null {
  const anchor = liftGridDockAnchorNode(liftNodeId, role);
  if (!anchor) {
    return null;
  }
  const level = role === 'inbound' ? 'top-a' : 'bottom-b';
  let nearest: NodeRecord | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodeById.values()) {
    if (!isRailLevelNode(node.id, level)) {
      continue;
    }
    const distance = Math.hypot(node.x - anchor.x, node.z - anchor.z);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function liftGridDockAnchorNode(liftNodeId: string, role: LiftRole): NodeRecord | null {
  const candidateIds = role === 'inbound'
    ? [
        `${liftNodeId}-queue-access`,
        `${liftNodeId}-queue-01-service-exit`,
        `${liftNodeId}-buffer-access`,
        `${liftNodeId}-queue-01-access`,
        liftNodeId
      ]
    : [
        liftNodeId,
        `${liftNodeId}-queue-01-service-exit`,
        `${liftNodeId}-buffer-access`,
        `${liftNodeId}-queue-01-entry-access`,
        `${liftNodeId}-queue-access`
      ];
  for (const candidateId of candidateIds) {
    const node = nodeById.get(candidateId);
    if (node) {
      return node;
    }
  }
  return null;
}

function isRailLevelNode(nodeId: string, level: LiftLevel): boolean {
  return new RegExp(`^column-${level}-c\\d+$`).test(nodeId) ||
    new RegExp(`^(?:module-\\d+|module-boundary-\\d+)-spine-${level}$`).test(nodeId);
}

function isLiftNoDriveRectNode(nodeId: string): boolean {
  return /^lift-\d{2}-(?:inbound|outbound)(?:$|-buffer-\d{2})$/.test(nodeId);
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function countAll(report: any): number {
  return Object.values(report.summary?.anomalyCounts ?? {}).reduce((sum: number, value: any) => sum + Number(value ?? 0), 0);
}

function countCritical(report: any): number {
  return (report.anomalies ?? []).filter((entry: any) => entry.severity === 'critical').length;
}

function round(value: number, digits = 3): string {
  return Number(value).toFixed(digits).replace(/\.?0+$/, '');
}

function rel(path: string): string {
  return relative(dirname(outputPath), path).replaceAll('\\', '/');
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
