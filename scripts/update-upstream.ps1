[CmdletBinding()]
param([switch]$Check, [switch]$NoPause, [switch]$CoreOnly)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'update-upstream.cjs'
$arguments = @($script)
if ($Check) { $arguments += '--check' }
if ($CoreOnly) { $arguments += '--core-only' }
& $node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
