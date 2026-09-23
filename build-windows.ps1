[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "build-windows.ps1 can only build the Windows installer."
}

$projectRoot = $PSScriptRoot
$bunVersion = "1.4.0"
$bunAsset = "bun-windows-x64-baseline.zip"
$bunRoot = Join-Path $env:LOCALAPPDATA "codex-chatgpt-web\bun-$bunVersion"
$bunExecutable = Join-Path $bunRoot "bun.exe"

function Confirm-BunVersion([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  $reportedVersion = (& $Path --version | Out-String).Trim()
  return $LASTEXITCODE -eq 0 -and $reportedVersion -eq $bunVersion
}

if (-not (Confirm-BunVersion $bunExecutable)) {
  if (Test-Path -LiteralPath $bunRoot) {
    Write-Host "Cached Bun at $bunRoot is not version $bunVersion. Replacing it."
    Remove-Item -LiteralPath $bunRoot -Recurse -Force
  }

  $downloadRoot = Join-Path $env:TEMP "codex-chatgpt-web-bun-$bunVersion-$PID"
  $archive = Join-Path $downloadRoot $bunAsset
  $checksums = Join-Path $downloadRoot "SHASUMS256.txt"
  $extracted = Join-Path $downloadRoot "extracted"
  $releaseUrl = "https://github.com/oven-sh/bun/releases/download/bun-v$bunVersion"

  New-Item -ItemType Directory -Path $downloadRoot | Out-Null
  try {
    Invoke-WebRequest "$releaseUrl/$bunAsset" -OutFile $archive
    Invoke-WebRequest "$releaseUrl/SHASUMS256.txt" -OutFile $checksums
    $expectedLine = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "  bun-windows-x64-baseline\.zip$" }
    if (@($expectedLine).Count -ne 1) {
      throw "Bun checksums did not contain exactly one $bunAsset entry."
    }
    $expectedHash = ($expectedLine -split "\s+")[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Bun archive checksum mismatch: expected $expectedHash, received $actualHash."
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $extracted
    $downloadedBun = @(Get-ChildItem -LiteralPath $extracted -Filter bun.exe -File -Recurse)
    if ($downloadedBun.Count -ne 1) {
      throw "Bun archive contained $($downloadedBun.Count) bun.exe files."
    }
    New-Item -ItemType Directory -Path $bunRoot -Force | Out-Null
    Copy-Item -LiteralPath $downloadedBun[0].FullName -Destination $bunExecutable
  } finally {
    Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Confirm-BunVersion $bunExecutable)) {
  throw "Bun version validation failed for $bunExecutable."
}

$env:Path = "$(Split-Path -Parent $bunExecutable);$env:Path"

Push-Location $projectRoot
try {
  & $bunExecutable install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Push-Location (Join-Path $projectRoot "launcher")
  try {
    & $bunExecutable install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }

  & $bunExecutable run --cwd launcher build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  & $bunExecutable run --cwd launcher scripts/prepare-runtime.cjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  & $bunExecutable run --cwd launcher scripts/package.cjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$artifactsDirectory = Join-Path $projectRoot "launcher\artifacts"
$installers = @(Get-ChildItem -LiteralPath $artifactsDirectory -Filter "*.exe" -File)
if ($installers.Count -eq 0) {
  throw "Packaging completed but no Windows installer was found in $artifactsDirectory."
}

$installer = $installers | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Installer created: $($installer.FullName)"
