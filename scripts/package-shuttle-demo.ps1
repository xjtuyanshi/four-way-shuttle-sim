param(
  [int]$ApiPort = 8791,
  [int]$WebPort = 5180,
  [int]$PlaybackSpeed = 5
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$outputRoot = Join-Path $repoRoot 'output'
$demoRoot = Join-Path $outputRoot 'shuttle-demo-oneclick'
$compileRoot = Join-Path $outputRoot '.shuttle-demo-compile'
$zipPath = Join-Path $outputRoot 'shuttle-demo-oneclick.zip'

function Assert-UnderOutput([string]$PathToCheck) {
  $full = [System.IO.Path]::GetFullPath($PathToCheck)
  $outputFull = [System.IO.Path]::GetFullPath($outputRoot)
  if (-not $full.StartsWith($outputFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside output: $full"
  }
}

function Remove-GeneratedPath([string]$PathToRemove) {
  if (Test-Path -LiteralPath $PathToRemove) {
    Assert-UnderOutput $PathToRemove
    Remove-Item -LiteralPath $PathToRemove -Recurse -Force
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $directory = Split-Path -Parent $Path
  if ($directory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Remove-GeneratedPath $demoRoot
Remove-GeneratedPath $compileRoot
if (Test-Path -LiteralPath $zipPath) {
  Assert-UnderOutput $zipPath
  Remove-Item -LiteralPath $zipPath -Force
}

Write-Host "Building dashboard for packaged API target http://localhost:$ApiPort ..."
$previousApiTarget = $env:VITE_SHUTTLE_API_TARGET
$env:VITE_SHUTTLE_API_TARGET = "http://localhost:$ApiPort"
try {
  Push-Location $repoRoot
  corepack pnpm --filter shuttle-dashboard build
  if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed.' }
} finally {
  if ($null -eq $previousApiTarget) {
    Remove-Item Env:\VITE_SHUTTLE_API_TARGET -ErrorAction SilentlyContinue
  } else {
    $env:VITE_SHUTTLE_API_TARGET = $previousApiTarget
  }
  Pop-Location
}

Write-Host 'Compiling API and simulation core JavaScript ...'
New-Item -ItemType Directory -Force -Path $compileRoot | Out-Null
Push-Location $repoRoot
corepack pnpm exec tsc -p apps/shuttle-api/tsconfig.json --outDir $compileRoot --sourceMap false --noEmit false
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  throw 'API compile failed.'
}
Pop-Location

$apiRoot = Join-Path $demoRoot 'api'
$apiSrc = Join-Path $apiRoot 'src'
$webRoot = Join-Path $demoRoot 'web'
$toolsRoot = Join-Path $demoRoot 'tools'
$logsRoot = Join-Path $demoRoot 'logs'
$runtimeRoot = Join-Path $demoRoot 'runtime'

New-Item -ItemType Directory -Force -Path $apiSrc, $webRoot, $toolsRoot, $logsRoot, $runtimeRoot | Out-Null

Write-Host 'Installing packaged runtime dependencies ...'
Write-Utf8NoBom (Join-Path $apiRoot 'package.json') @"
{
  "name": "shuttle-demo-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^5.2.1",
    "ws": "^8.18.3",
    "zod": "^3.25.76"
  }
}
"@

Push-Location $apiRoot
npm install --omit=dev --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  throw 'npm install failed while preparing demo runtime.'
}
Pop-Location

$compiledApiSrc = Join-Path $compileRoot 'apps\shuttle-api\src'
Get-ChildItem -Path $compiledApiSrc -Filter '*.js' |
  Where-Object { $_.Name -notlike '*.test.js' } |
  Copy-Item -Destination $apiSrc -Force

$schemaPackage = Join-Path $apiRoot 'node_modules\@four-way-shuttle\schemas'
$simCorePackage = Join-Path $apiRoot 'node_modules\@four-way-shuttle\sim-core'
Remove-GeneratedPath $schemaPackage
Remove-GeneratedPath $simCorePackage
New-Item -ItemType Directory -Force -Path (Join-Path $schemaPackage 'src'), (Join-Path $simCorePackage 'src') | Out-Null

Copy-Item -Path (Join-Path $compileRoot 'packages\shuttle-schemas\src\*.js') -Destination (Join-Path $schemaPackage 'src') -Force
Copy-Item -Path (Join-Path $compileRoot 'packages\shuttle-sim-core\src\*.js') -Destination (Join-Path $simCorePackage 'src') -Force

Write-Utf8NoBom (Join-Path $schemaPackage 'package.json') @"
{
  "name": "@four-way-shuttle/schemas",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js"
  },
  "dependencies": {
    "zod": "^3.25.76"
  }
}
"@

Write-Utf8NoBom (Join-Path $simCorePackage 'package.json') @"
{
  "name": "@four-way-shuttle/sim-core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./static-scene": "./src/static-scene.js"
  },
  "dependencies": {
    "@four-way-shuttle/schemas": "0.1.0"
  }
}
"@

Write-Host 'Copying dashboard assets ...'
Copy-Item -Path (Join-Path $repoRoot 'apps\shuttle-dashboard\dist') -Destination $webRoot -Recurse -Force

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtimeRoot 'node.exe') -Force
}

Write-Utf8NoBom (Join-Path $toolsRoot 'web-static-server.mjs') @'
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web', 'dist');
const port = Number(process.argv[3] ?? 5180);
const root = resolve(rootArg);

const mimeByExt = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8']
]);

function contentType(pathname) {
  const dot = pathname.lastIndexOf('.');
  return dot >= 0 ? mimeByExt.get(pathname.slice(dot).toLowerCase()) ?? 'application/octet-stream' : 'application/octet-stream';
}

function safePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname.split('?')[0] ?? '/');
  const candidate = normalize(join(root, decoded === '/' ? 'index.html' : decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return join(root, 'index.html');
  }
  return candidate;
}

const server = http.createServer((request, response) => {
  let pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
  let filePath = safePath(pathname);
  try {
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
  } catch {
    filePath = join(root, 'index.html');
  }
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', contentType(filePath));
  createReadStream(filePath)
    .on('error', () => {
      response.statusCode = 404;
      response.end('Not found');
    })
    .pipe(response);
});

server.listen(port, () => {
  console.log(`Shuttle demo dashboard listening on http://localhost:${port}`);
});
'@

Write-Utf8NoBom (Join-Path $toolsRoot 'load-demo-scenario.mjs') @"
import { createDefaultShuttleScenario } from '../api/node_modules/@four-way-shuttle/sim-core/src/index.js';

const apiBase = process.argv[2] ?? 'http://localhost:$ApiPort/api/shuttle';
const speed = Number(process.argv[3] ?? $PlaybackSpeed);

const scenario = createDefaultShuttleScenario({
  id: 'shuttle-all-inbound-8x-7200',
  name: 'All Inbound 8 Shuttle 7200 PPH Stress',
  liftMode: 'all-inbound',
  durationSec: 7200,
  vehicles: {
    count: 8,
    emptySpeedMps: 2,
    loadedSpeedMps: 1.5,
    accelerationMps2: 1.2,
    liftTimeSec: 0.01,
    lowerTimeSec: 0.01
  },
  physicsParams: {
    emptySpeedMps: 2,
    loadedSpeedMps: 1.5,
    accelerationMps2: 1.2,
    liftTimeSec: 0.01,
    lowerTimeSec: 0.01
  },
  taskGeneration: {
    inboundRatePerHour: 7200,
    outboundRatePerHour: 0,
    inboundOutboundMix: 1,
    arrivalDistribution: 'deterministic',
    maxTasks: 16
  },
  trafficPolicy: {
    controllerMode: 'agent-refresh',
    liftApproachCapacity: 8,
    minimumClearanceSec: 0.4,
    deadlockDetectSec: 2,
    collisionAvoidanceEnabled: true
  }
});

async function post(path, body) {
  const response = await fetch(apiBase + path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(path + ' failed with ' + response.status + ': ' + await response.text());
  }
  return response.json();
}

await post('/loadScenario', scenario);
await post('/playbackSpeed', { speed });
await post('/resume');
const state = await (await fetch(apiBase + '/state')).json();
console.log(JSON.stringify({
  scenarioId: state.scenarioId,
  status: state.status,
  simTimeSec: state.simTimeSec,
  inboundPph: state.kpis?.inboundPph,
  deadlocks: state.kpis?.deadlockCount,
  vehicles: state.vehicles?.length
}, null, 2));
"@

Write-Utf8NoBom (Join-Path $demoRoot 'Start Shuttle Demo.ps1') @"
`$ErrorActionPreference = 'Stop'
`$Root = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$ApiPort = $ApiPort
`$WebPort = $WebPort
`$PlaybackSpeed = $PlaybackSpeed
`$Logs = Join-Path `$Root 'logs'
New-Item -ItemType Directory -Force -Path `$Logs | Out-Null

`$node = Join-Path `$Root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath `$node)) {
  `$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not `$nodeCommand) {
    throw 'Node.js was not found. Install Node.js 20+ or use the bundled package generated on the demo machine.'
  }
  `$node = `$nodeCommand.Source
}

function Stop-Port([int]`$Port) {
  `$connections = Get-NetTCPConnection -LocalPort `$Port -ErrorAction SilentlyContinue | Where-Object { `$_.State -eq 'Listen' }
  foreach (`$ownerProcessId in (`$connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if (`$ownerProcessId -and `$ownerProcessId -ne `$PID) {
      Stop-Process -Id `$ownerProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Wait-Http([string]`$Url) {
  for (`$i = 0; `$i -lt 60; `$i += 1) {
    try {
      `$response = Invoke-WebRequest -Uri `$Url -UseBasicParsing -TimeoutSec 2
      if (`$response.StatusCode -ge 200 -and `$response.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Timed out waiting for `$Url"
}

Write-Host 'Starting Shuttle demo...'
Stop-Port `$ApiPort
Stop-Port `$WebPort
Start-Sleep -Milliseconds 500

`$apiLog = Join-Path `$Logs 'api.out.log'
`$apiErr = Join-Path `$Logs 'api.err.log'
`$webLog = Join-Path `$Logs 'web.out.log'
`$webErr = Join-Path `$Logs 'web.err.log'
Remove-Item -LiteralPath `$apiLog, `$apiErr, `$webLog, `$webErr -ErrorAction SilentlyContinue

`$env:SHUTTLE_PORT = [string]`$ApiPort
`$env:SHUTTLE_SPEED = [string]`$PlaybackSpeed
`$env:SHUTTLE_TICK_MS = '100'
`$apiScript = Join-Path `$Root 'api\src\server.js'
`$apiProc = Start-Process -FilePath `$node -ArgumentList @(`$apiScript) -WorkingDirectory (Join-Path `$Root 'api') -WindowStyle Hidden -RedirectStandardOutput `$apiLog -RedirectStandardError `$apiErr -PassThru

`$webScript = Join-Path `$Root 'tools\web-static-server.mjs'
`$webDist = Join-Path `$Root 'web\dist'
`$webArgs = @(`$webScript, `$webDist, [string]`$WebPort)
`$webProc = Start-Process -FilePath `$node -ArgumentList `$webArgs -WorkingDirectory `$Root -WindowStyle Hidden -RedirectStandardOutput `$webLog -RedirectStandardError `$webErr -PassThru

`$pidInfo = @{
  api = `$apiProc.Id
  web = `$webProc.Id
  apiPort = `$ApiPort
  webPort = `$WebPort
}
`$pidInfo | ConvertTo-Json | Set-Content -Path (Join-Path `$Logs 'pids.json') -Encoding UTF8

Wait-Http "http://localhost:`$ApiPort/api/shuttle/health"
Wait-Http "http://localhost:`$WebPort/"

`$loader = Join-Path `$Root 'tools\load-demo-scenario.mjs'
& `$node `$loader "http://localhost:`$ApiPort/api/shuttle" `$PlaybackSpeed
if (`$LASTEXITCODE -ne 0) { throw 'Failed to load demo scenario.' }

Start-Process "http://localhost:`$WebPort"
Write-Host "Ready: http://localhost:`$WebPort"
Write-Host "Scenario: 8 shuttle / all inbound / 7200 PPH / avoidance on / `$PlaybackSpeed x"
"@

Write-Utf8NoBom (Join-Path $demoRoot 'Stop Shuttle Demo.ps1') @"
`$ErrorActionPreference = 'SilentlyContinue'
`$Root = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$Logs = Join-Path `$Root 'logs'
`$pidFile = Join-Path `$Logs 'pids.json'
if (Test-Path -LiteralPath `$pidFile) {
  `$pids = Get-Content -LiteralPath `$pidFile | ConvertFrom-Json
  Stop-Process -Id `$pids.api -Force
  Stop-Process -Id `$pids.web -Force
}
foreach (`$port in @($ApiPort, $WebPort)) {
  `$connections = Get-NetTCPConnection -LocalPort `$port | Where-Object { `$_.State -eq 'Listen' }
  foreach (`$ownerProcessId in (`$connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if (`$ownerProcessId -and `$ownerProcessId -ne `$PID) { Stop-Process -Id `$ownerProcessId -Force }
  }
}
Write-Host 'Shuttle demo stopped.'
"@

Write-Utf8NoBom (Join-Path $demoRoot 'Start Shuttle Demo.bat') @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start Shuttle Demo.ps1"
if errorlevel 1 (
  echo.
  echo Shuttle demo failed to start. Check logs in the logs folder.
  pause
)
'@

Write-Utf8NoBom (Join-Path $demoRoot 'Stop Shuttle Demo.bat') @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop Shuttle Demo.ps1"
pause
'@

Write-Utf8NoBom (Join-Path $demoRoot 'README.txt') @"
Shuttle Demo One-Click Package

How to run:
1. Double-click Start Shuttle Demo.bat.
2. The browser opens http://localhost:$WebPort automatically.
3. Use Stop Shuttle Demo.bat when you are done.

Default scenario:
- 8 shuttles
- all inbound
- 7200 PPH request
- collision avoidance on
- playback speed ${PlaybackSpeed}x

This package is prebuilt. It does not need GitHub checkout, pnpm install, or dashboard rebuild.
Logs are written to the logs folder.
"@

Write-Host "Creating zip: $zipPath"
Compress-Archive -Path (Join-Path $demoRoot '*') -DestinationPath $zipPath -Force

Write-Host ''
Write-Host "Demo folder: $demoRoot"
Write-Host "Demo zip:    $zipPath"
