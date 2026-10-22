[CmdletBinding()]
param([switch]$Check, [switch]$NoPause)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'update-upstream.cjs'
$arguments = @($script)
if ($Check) { $arguments += '--check' }
& $node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
