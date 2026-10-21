[CmdletBinding()]
param([switch]$Help)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
$previousEnv = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { $null }
Push-Location -LiteralPath $repoRoot
try {
    if ($Help) {
        & node scripts/sync-vps-db.mjs --help
    }
    else {
        & node scripts/sync-vps-db.mjs
    }
    if ($LASTEXITCODE -ne 0) { throw 'Database sync failed. The previous local connection was preserved.' }
    $currentEnv = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { $null }
    if ($previousEnv -cne $currentEnv) {
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:DATABASE_SCHEMA -ErrorAction SilentlyContinue
    }
}
finally { Pop-Location }
