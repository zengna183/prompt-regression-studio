[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-MinimumMajorVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$VersionText,
    [Parameter(Mandatory = $true)][int]$MinimumMajor
  )

  if ($VersionText -notmatch '(\d+)' -or [int]$Matches[1] -lt $MinimumMajor) {
    throw "$Name $MinimumMajor or newer is required; found '$VersionText'."
  }
}

function Resolve-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.12 --version *> $null
    if ($LASTEXITCODE -eq 0) {
      return @{ Executable = "py"; Arguments = @("-3.12") }
    }
  }

  foreach ($candidate in @("python", "python3")) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) {
      $version = & $candidate -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
      if ([version]$version -ge [version]"3.12") {
        return @{ Executable = $candidate; Arguments = @() }
      }
    }
  }

  throw "Python 3.12 or newer was not found. Install Python and run this command again."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer was not found."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm 11 was not found. Run 'corepack enable' and try again."
}
Assert-MinimumMajorVersion -Name "Node.js" -VersionText (& node --version) -MinimumMajor 22
Assert-MinimumMajorVersion -Name "pnpm" -VersionText (& pnpm --version) -MinimumMajor 11

Push-Location $repoRoot
try {
  Write-Host "Installing Node.js workspace dependencies..."
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

  $venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $venvPython)) {
    $python = Resolve-PythonCommand
    Write-Host "Creating the project Python environment..."
    & $python.Executable @($python.Arguments) -m venv ".venv"
    if ($LASTEXITCODE -ne 0) { throw "Python environment creation failed." }
  }

  Write-Host "Installing Python workspace packages..."
  & $venvPython -m pip install "setuptools>=75"
  if ($LASTEXITCODE -ne 0) { throw "setuptools installation failed." }
  & $venvPython -m pip install --no-build-isolation --no-deps `
    -e "packages/python/core" `
    -e "packages/python/plugin-sdk" `
    -e "plugins/official/promptfoo"
  if ($LASTEXITCODE -ne 0) { throw "Python package installation failed." }

  if (-not (Test-Path -LiteralPath ".env")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
    $content = Get-Content -Raw -LiteralPath ".env"
    $content = $content.Replace(
      "DIAGNOSIS_PYTHON_EXECUTABLE=python",
      "DIAGNOSIS_PYTHON_EXECUTABLE=../../.venv/Scripts/python.exe"
    )
    Set-Content -LiteralPath ".env" -Value $content -NoNewline
    Write-Host "Created .env for the local Python environment."
  }

  Write-Host ""
  Write-Host "Local dependencies are ready." -ForegroundColor Green
  Write-Host "Next: install/start Docker Desktop, then run 'pnpm local:init'."
} finally {
  Pop-Location
}
