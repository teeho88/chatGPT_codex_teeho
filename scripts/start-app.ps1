param(
    [Parameter(Mandatory = $true)][string]$BunPath,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [switch]$Hidden
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-web-gpt-' + [guid]::NewGuid().ToString('N'))

try {
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    $readyPath = Join-Path $runDirectory 'ui-ready'
    $outputPath = Join-Path $runDirectory 'stdout.log'
    $errorPath = Join-Path $runDirectory 'stderr.log'
    $env:CODEX_WEB_GPT_UI_READY_FILE = $readyPath
    $bunExecutable = (Get-Command $BunPath -CommandType Application -ErrorAction Stop).Source
    $sourceEntry = Join-Path $projectRoot $ScriptPath
    if (-not (Test-Path -LiteralPath $sourceEntry -PathType Leaf)) {
        throw "Source entry script not found: $sourceEntry"
    }
    Write-Host "Startup logs: $runDirectory"
    $launchArgs = @('run', $ScriptPath, '--production')
    if ($Hidden) { $launchArgs += '--hidden' }
    $appProcess = Start-Process -FilePath $bunExecutable -ArgumentList $launchArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath -PassThru

    while (-not (Test-Path -LiteralPath $readyPath)) {
        $appProcess.Refresh()
        if ($appProcess.HasExited) {
            $appProcess.WaitForExit()
            if ($appProcess.ExitCode -ne 0) {
                Get-Content -LiteralPath $outputPath -Tail 40
                Get-Content -LiteralPath $errorPath -Tail 80
                throw "App startup failed. Logs: $runDirectory"
            }
            exit 0
        }
        Start-Sleep -Milliseconds 250
    }
    exit 0
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
