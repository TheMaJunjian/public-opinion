[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoRoot
try {
    $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    Write-Host 'Starting API and frontend. Press Ctrl+C to stop.'
    & npm run dev
    if ($LASTEXITCODE -ne 0) { throw "Development server exited with code $LASTEXITCODE" }
}
finally { Pop-Location }
