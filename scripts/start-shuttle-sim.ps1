$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DashboardUrl = 'http://localhost:5180/'
$ApiHealthUrl = 'http://localhost:8791/api/shuttle/health'

function Test-Url {
  param([string]$Url)
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-Url {
  param(
    [string]$Url,
    [int]$TimeoutSec = 60
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (Test-Url $Url) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Start-Detached {
  param([string[]]$ArgumentList)
  Start-Process -FilePath 'corepack.cmd' -ArgumentList $ArgumentList -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
}

Write-Host 'Starting Shuttle Sim services...'

& (Join-Path $PSScriptRoot 'stop-shuttle-sim.ps1') | Out-Host

Push-Location $RepoRoot
try {
  Write-Host 'Building dashboard preview...'
  corepack pnpm --filter shuttle-dashboard build
} finally {
  Pop-Location
}

Start-Detached @('pnpm', 'run', 'dev:api')
Start-Detached @('pnpm', 'run', 'preview:dashboard')

if (-not (Wait-Url $ApiHealthUrl 90)) {
  throw 'Shuttle API did not become ready on http://localhost:8791.'
}

if (-not (Wait-Url $DashboardUrl 90)) {
  throw 'Dashboard did not become ready on http://localhost:5180.'
}

Write-Host 'Loading default all-inbound stress scenario...'
Push-Location $RepoRoot
try {
  corepack pnpm exec tsx scripts/load-all-inbound-stress.ts
} finally {
  Pop-Location
}

Write-Host "Opening $DashboardUrl"
Start-Process $DashboardUrl | Out-Null
Write-Host 'Ready. Use Stop Shuttle Sim.cmd to close the local services.'
