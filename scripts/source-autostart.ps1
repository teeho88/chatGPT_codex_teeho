$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$batch = Join-Path $projectRoot 'START-APP.bat'
if (-not (Test-Path -LiteralPath $batch -PathType Leaf)) { exit 1 }
Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c ""' + $batch + '" --hidden"') -WorkingDirectory $projectRoot -WindowStyle Hidden
