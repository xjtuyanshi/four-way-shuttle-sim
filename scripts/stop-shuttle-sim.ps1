$ErrorActionPreference = 'SilentlyContinue'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ports = @(8791, 5180)
$targetPids = New-Object System.Collections.Generic.HashSet[int]

Get-NetTCPConnection -LocalPort $ports -ErrorAction SilentlyContinue |
  ForEach-Object {
    if ($_.OwningProcess) { [void]$targetPids.Add([int]$_.OwningProcess) }
  }

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    (
      $_.CommandLine -match 'pnpm run dev:api|pnpm run preview:dashboard|pnpm --filter shuttle-api dev|pnpm --filter shuttle-dashboard preview' -or
      ($_.CommandLine.Contains($RepoRoot) -and $_.CommandLine -match 'tsx src/server\.ts|vite preview')
    )
  } |
  ForEach-Object { [void]$targetPids.Add([int]$_.ProcessId) }

if ($targetPids.Count -eq 0) {
  Write-Host 'No Shuttle Sim services found.'
  exit 0
}

foreach ($targetPid in $targetPids) {
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1
Write-Host "Stopped Shuttle Sim services: $($targetPids -join ', ')"
