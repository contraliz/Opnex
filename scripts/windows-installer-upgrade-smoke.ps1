$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$newSetup = Join-Path $repoRoot "desktop-release\Opnex Setup $($package.version).exe"
$runnerTemp = (Resolve-Path $env:RUNNER_TEMP).Path
$testRoot = Join-Path $runnerTemp "opnex-installer-smoke-$([guid]::NewGuid().ToString('N'))"

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

$oldSetup = $env:OPNEX_LEGACY_SETUP
if (-not $oldSetup) { $oldSetup = $env:PSEUDOHARNESS_LEGACY_SETUP }
if (-not $oldSetup -or -not (Test-Path -LiteralPath $oldSetup -PathType Leaf)) {
  throw 'The original v1.1.1 per-user installer was not rebuilt from the immutable v1.1.1 tag.'
}
$legacyInstall = Join-Path $testRoot 'legacy-per-user'
$cleanInstall = Join-Path $testRoot 'clean-per-machine'
$upgradeInstall = $legacyInstall
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
  $uninstaller = Join-Path $installPath 'Uninstall Opnex.exe'
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Uninstaller was not created at $uninstaller"
  }
  $process = Start-Process -FilePath $uninstaller -Verb RunAs -ArgumentList @('/S', '/allusers', "_?=$installPath") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Uninstall failed with exit code $($process.ExitCode): $installPath"
  }
}

function Assert-Uninstalled([string] $installPath, [string] $displayName, [string] $registryRoot) {
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    $remainingFiles = @()
    if (Test-Path -LiteralPath $installPath) {
      # NSIS cannot remove its currently running uninstaller; the task-owned test root is cleaned afterward.
      $remainingFiles = @(
        Get-ChildItem -LiteralPath $installPath -Force -ErrorAction SilentlyContinue |
          Where-Object Name -ne 'Uninstall Opnex.exe'
      )
    }
    $remainingEntries = @(Get-UninstallEntries $registryRoot $displayName)
    if ($remainingFiles.Count -eq 0 -and $remainingEntries.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }

  $remainingNames = @($remainingFiles | ForEach-Object Name) -join ', '
  $entryCount = $remainingEntries.Count
  throw "Uninstall left unexpected files [$remainingNames] and $entryCount registry entries for $displayName."
}

if ((Test-Path -LiteralPath $dataDirectory) -or (Test-Path -LiteralPath $testRoot)) {
  throw 'The isolated installer test requires fresh, task-owned paths; refusing to reuse existing data.'
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  New-Item -ItemType Directory -Path $dataDirectory | Out-Null
  Set-Content -LiteralPath $skillsDatabase -Value $markerText -NoNewline
  Set-Content -LiteralPath $marker -Value $markerText -NoNewline

  # A clean current-version install must register per-machine and can be removed without deleting user data.
  Invoke-Setup $newSetup $cleanInstall
  if (-not (Test-Path -LiteralPath (Join-Path $cleanInstall 'Opnex.exe') -PathType Leaf)) {
    throw 'Clean install did not place the application in the requested isolated directory.'
  }
  Get-UninstallEntry 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' "Opnex $($package.version)" | Out-Null
  Invoke-Uninstall $cleanInstall
  Assert-Uninstalled $cleanInstall "Opnex $($package.version)" 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

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
  if (-not (Test-Path -LiteralPath (Join-Path $upgradeInstall 'Opnex.exe') -PathType Leaf)) {
    throw 'Upgrade did not place the application in the requested per-machine directory.'
  }
  Get-UninstallEntry 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' "Opnex $($package.version)" | Out-Null
  if (@(Get-UninstallEntries 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' 'Pseudoharness 1.1.1').Count -ne 0) {
    throw 'Upgrade left the old per-user uninstall entry behind.'
  }
  if ((Get-Content -LiteralPath $skillsDatabase -Raw) -ne $markerText -or (Get-Content -LiteralPath $marker -Raw) -ne $markerText) {
    throw 'Upgrade changed or removed saved-skill/app-data test markers.'
  }

  Invoke-Uninstall $upgradeInstall
  Assert-Uninstalled $upgradeInstall "Opnex $($package.version)" 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
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
      -not (Split-Path -Leaf $resolvedTestRoot).StartsWith('opnex-installer-smoke-', [StringComparison]::Ordinal)) {
    throw "Refusing to remove a test path outside this run's temporary directory: $resolvedTestRoot"
  }
  if (Test-Path -LiteralPath $resolvedTestRoot) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
