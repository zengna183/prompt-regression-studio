[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Test-CommandVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$VersionCommand,
    [int]$MinimumMajor = 0
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "[missing] $Name"
    $failures.Add("$Name is not installed or is not on PATH.")
    return
  }

  $versionText = (& $VersionCommand | Select-Object -First 1).ToString().Trim()
  Write-Host "[ready]   $Name $versionText"
  if ($MinimumMajor -gt 0 -and $versionText -match '(\d+)') {
    if ([int]$Matches[1] -lt $MinimumMajor) {
      $failures.Add("$Name $versionText is too old; major version $MinimumMajor or newer is required.")
    }
  }
}

Write-Host "Prompt Regression Studio environment check"
Write-Host "Repository: $repoRoot"
Test-CommandVersion -Name "node" -VersionCommand { node --version } -MinimumMajor 22
Test-CommandVersion -Name "pnpm" -VersionCommand { pnpm --version } -MinimumMajor 11
Test-CommandVersion -Name "git" -VersionCommand { git --version }

$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (Test-Path -LiteralPath $venvPython) {
  $pythonVersion = (& $venvPython --version).Trim()
  Write-Host "[ready]   project Python $pythonVersion"
  if ($pythonVersion -notmatch '(\d+)\.(\d+)' -or
      [version]"$($Matches[1]).$($Matches[2])" -lt [version]"3.12") {
    $failures.Add("The project Python environment must use Python 3.12 or newer.")
  }
} else {
  Write-Host "[missing] project Python environment (.venv)"
  $failures.Add("Run 'pnpm setup:local' to create the project Python environment.")
}

function Resolve-DockerCommand {
  $pathCommand = Get-Command docker -ErrorAction SilentlyContinue
  if ($pathCommand) {
    return $pathCommand.Source
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"),
    "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  return $null
}

$dockerCommand = Resolve-DockerCommand
if ($dockerCommand) {
  Write-Host "[ready]   $(& $dockerCommand --version)"
  & $dockerCommand info *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[ready]   Docker engine is running"
  } else {
    $failures.Add("Docker Desktop is installed but its engine is not running.")
  }
} else {
  Write-Host "[missing] Docker Desktop"
  $failures.Add("Docker Desktop is required for PostgreSQL and Redis.")
}

if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "Environment is not ready:" -ForegroundColor Yellow
  foreach ($failure in $failures) {
    Write-Host "- $failure" -ForegroundColor Yellow
  }
  exit 1
}

Write-Host ""
Write-Host "Environment is ready." -ForegroundColor Green
