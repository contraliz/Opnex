$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$newSetup = Join-Path $repoRoot "desktop-release\Pseudoharness Setup $($package.version).exe"
$runnerTemp = (Resolve-Path $env:RUNNER_TEMP).Path
$testRoot = Join-Path $runnerTemp "pseudoharness-installer-smoke-$([guid]::NewGuid().ToString('N'))"

if ($testRoot -match '\s') {
  throw "RUNNER_TEMP must not contain spaces for NSIS /D path testing: $runnerTemp"
}
if (-not (Test-Path -LiteralPath $newSetup -PathType Leaf)) {
  throw "Current setup package was not found: $newSetup"
}

node (Join-Path $PSScriptRoot 'verify-windows-installer.mjs')
if ($LASTEXITCODE -ne 0) {
  throw 'The packaged Windows elevation manifest check failed.'
}

$oldSetup = Join-Path $testRoot 'Pseudoharness.Setup.1.1.1.exe'
$legacyInstall = Join-Path $testRoot 'legacy-per-user'
$cleanInstall = Join-Path $testRoot 'clean-per-machine'
$upgradeInstall = $legacyInstall
$oldSetupUrl = 'https://github.com/contraliz/pseudoharness/releases/download/v1.1.1/Pseudoharness.Setup.1.1.1.exe'
$oldSetupSha256 = 'AA53AC52EA5384CACA9C7D3C0F6CA219CC0529FE747C55BFCA7225EE936CD527'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'Pseudoharness'
$skillsDatabase = Join-Path $dataDirectory 'skills.sqlite3'
$marker = Join-Path $dataDirectory 'installer-upgrade-smoke.marker'
$markerText = 'isolated installer test data; must survive installs and uninstalls'

function Get-UninstallEntries([string] $registryRoot, [string] $displayName) {
  return @(
    Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue |
      ForEach-Object {
        $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        if ($entry.DisplayName -eq $displayName) { $entry }
      }
  )
}

function Get-UninstallEntry([string] $registryRoot, [string] $displayName) {
  $matches = @(Get-UninstallEntries $registryRoot $displayName)
  if ($matches.Count -ne 1) {
    throw "Expected one $displayName uninstall entry under $registryRoot; found $($matches.Count)."
  }
  return $matches[0]
}

function Invoke-Setup([string] $setupPath, [string] $installPath) {
  $process = Start-Process -FilePath $setupPath -ArgumentList @('/S', "/D=$installPath") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Setup failed with exit code $($process.ExitCode): $setupPath"
  }
}

function Invoke-Uninstall([string] $installPath) {
  $uninstaller = Join-Path $installPath 'Uninstall Pseudoharness.exe'
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Uninstaller was not created at $uninstaller"
  }
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/allusers', "_?=$installPath") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Uninstall failed with exit code $($process.ExitCode): $installPath"
  }
}

if ((Test-Path -LiteralPath $dataDirectory) -or (Test-Path -LiteralPath $testRoot)) {
  throw 'The isolated installer test requires fresh, task-owned paths; refusing to reuse existing data.'
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  Invoke-WebRequest -Uri $oldSetupUrl -OutFile $oldSetup
  $actualSha256 = (Get-FileHash -LiteralPath $oldSetup -Algorithm SHA256).Hash
  if ($actualSha256 -ne $oldSetupSha256) {
    throw "The 1.1.1 baseline installer hash did not match the published artifact."
  }

  New-Item -ItemType Directory -Path $dataDirectory | Out-Null
  Set-Content -LiteralPath $skillsDatabase -Value $markerText -NoNewline
  Set-Content -LiteralPath $marker -Value $markerText -NoNewline

  # A clean current-version install must register per-machine and can be removed without deleting user data.
  Invoke-Setup $newSetup $cleanInstall
  if (-not (Test-Path -LiteralPath (Join-Path $cleanInstall 'Pseudoharness.exe') -PathType Leaf)) {
    throw 'Clean install did not place the application in the requested isolated directory.'
  }
  Get-UninstallEntry 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' "Pseudoharness $($package.version)" | Out-Null
  Invoke-Uninstall $cleanInstall
  if (Test-Path -LiteralPath $cleanInstall) {
    throw 'Clean uninstall left the task-owned install directory behind.'
  }

  # Install the last release in per-user mode, then upgrade in place to per-machine.
  Invoke-Setup $oldSetup $legacyInstall
  if (-not (Test-Path -LiteralPath (Join-Path $legacyInstall 'Pseudoharness.exe') -PathType Leaf)) {
    throw 'The 1.1.1 per-user baseline did not install in the isolated directory.'
  }
  $legacyEntry = Get-UninstallEntry 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' 'Pseudoharness 1.1.1'
  if ($legacyEntry.UninstallString -notlike "*$legacyInstall*") {
    throw 'The 1.1.1 test installation was not registered at its isolated path.'
  }

  Invoke-Setup $newSetup $upgradeInstall
  if (-not (Test-Path -LiteralPath (Join-Path $upgradeInstall 'Pseudoharness.exe') -PathType Leaf)) {
    throw 'Upgrade did not place the application in the requested per-machine directory.'
  }
  Get-UninstallEntry 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' "Pseudoharness $($package.version)" | Out-Null
  if (@(Get-UninstallEntries 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' 'Pseudoharness 1.1.1').Count -ne 0) {
    throw 'Upgrade left the old per-user uninstall entry behind.'
  }
  if ((Get-Content -LiteralPath $skillsDatabase -Raw) -ne $markerText -or (Get-Content -LiteralPath $marker -Raw) -ne $markerText) {
    throw 'Upgrade changed or removed saved-skill/app-data test markers.'
  }

  Invoke-Uninstall $upgradeInstall
  if (Test-Path -LiteralPath $upgradeInstall) {
    throw 'Upgrade uninstall left the task-owned install directory behind.'
  }
  if ((Get-Content -LiteralPath $skillsDatabase -Raw) -ne $markerText -or (Get-Content -LiteralPath $marker -Raw) -ne $markerText) {
    throw 'Uninstall changed or removed saved-skill/app-data test markers.'
  }

  Write-Output 'Clean install, per-user 1.1.1 to per-machine upgrade, uninstall, and user-data retention passed.'
}
finally {
  if (Test-Path -LiteralPath $skillsDatabase) { Remove-Item -LiteralPath $skillsDatabase -Force }
  if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
  if ((Test-Path -LiteralPath $dataDirectory) -and -not (Get-ChildItem -LiteralPath $dataDirectory -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $dataDirectory
  }

  $resolvedRunnerTemp = [System.IO.Path]::GetFullPath($runnerTemp).TrimEnd('\') + '\'
  $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
  if (-not $resolvedTestRoot.StartsWith($resolvedRunnerTemp, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $resolvedTestRoot).StartsWith('pseudoharness-installer-smoke-', [StringComparison]::Ordinal)) {
    throw "Refusing to remove a test path outside this run's temporary directory: $resolvedTestRoot"
  }
  if (Test-Path -LiteralPath $resolvedTestRoot) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
