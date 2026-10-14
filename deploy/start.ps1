# Run from the repository root in this terminal. No database reset is performed.
[CmdletBinding()]
param(
    [switch]$Production
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 24 before starting Gonglun.'
}
$nodeMajor = & node -p "process.versions.node.split('.')[0]"
if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 24) {
    throw 'Gonglun requires Node.js 24 or later.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
    throw 'Run npm ci in the repository root first.'
}
if ($Production -and -not (Test-Path -LiteralPath (Join-Path $repoRoot 'apps/server/dist/main.js'))) {
    throw 'Run npm run build in the repository root first.'
}

Push-Location -LiteralPath $repoRoot
try {
    if ($Production) {
        Write-Host 'Starting the built application on http://localhost:3000. Press Ctrl+C to stop.'
        & npm.cmd start
    }
    else {
        Write-Host 'Starting development on http://localhost:5173 (API: 3000). Press Ctrl+C to stop.'
        & npm.cmd run dev
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Gonglun exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
