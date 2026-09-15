[CmdletBinding()]
param(
  [string]$StatusFile
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
  throw "This script must run as Administrator."
}

$restartRequired = $false
$features = @(
  "Microsoft-Windows-Subsystem-Linux",
  "VirtualMachinePlatform"
)

foreach ($feature in $features) {
  Write-Host "Enabling Windows feature: $feature"
  & dism.exe /online /enable-feature "/featurename:$feature" /all /norestart
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 3010) {
    $restartRequired = $true
  } elseif ($exitCode -ne 0) {
    throw "DISM failed for $feature with exit code $exitCode."
  }
}

$status = if ($restartRequired) { "restart-required" } else { "features-enabled" }
if ($StatusFile) {
  Set-Content -LiteralPath $StatusFile -Value $status -Encoding utf8 -NoNewline
}

Write-Host "WSL prerequisites enabled. Status: $status"
