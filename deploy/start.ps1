# start.ps1 - Start the local backend and frontend in separate PowerShell windows.
# By default the existing database is preserved. Add -ResetDatabase to clear it first.

[CmdletBinding()]
param(
    [switch]$ResetDatabase,
    [int]$BackendPort = 3000,
    [int]$StartupTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$logDir = Join-Path $repoRoot 'README\logs'
$backendProcess = $null
$frontendProcess = $null

function Stop-ProcessTree($process) {
    if ($null -ne $process -and -not $process.HasExited) {
        & taskkill.exe /F /T /PID $process.Id 2>$null | Out-Null
    }
}

function Test-Port($port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect('localhost', $port, $null, $null)
        return $connection.AsyncWaitHandle.WaitOne(1000) -and $client.Connected
    }
    finally {
        $client.Dispose()
    }
}

try {
    if (-not (Test-Path $backendDir) -or -not (Test-Path $frontendDir)) {
        throw "Cannot find backend or frontend directory under $repoRoot"
    }

    if (Test-Path $logDir) {
        Remove-Item -Path (Join-Path $logDir '*.log') -Force -ErrorAction SilentlyContinue
    }

    Push-Location $backendDir
    try {
        if ($ResetDatabase) {
            Write-Host 'Resetting database and applying migrations...'
            npm exec prisma -- migrate reset --force
            if ($LASTEXITCODE -ne 0) {
                throw "Database reset failed with exit code $LASTEXITCODE"
            }
        }
        else {
            Write-Host 'Applying pending database migrations...'
            npm run db:migrate
            if ($LASTEXITCODE -ne 0) {
                throw "Database migration failed with exit code $LASTEXITCODE"
            }
        }
    }
    finally {
        Pop-Location
    }

    Write-Host 'Starting backend server...'
    $backendProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoExit', '-NoLogo', '-Command', 'npm run dev') `
        -WorkingDirectory $backendDir -PassThru

    Write-Host "Waiting for backend on port $BackendPort..."
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while (-not (Test-Port $BackendPort)) {
        if ((Get-Date) -ge $deadline) {
            throw "Backend did not start within $StartupTimeoutSeconds seconds"
        }
        Start-Sleep -Milliseconds 500
    }

    Write-Host 'Backend is ready.'
    Write-Host 'Starting frontend server...'
    $frontendProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoExit', '-NoLogo', '-Command', 'npm run dev') `
        -WorkingDirectory $frontendDir -PassThru

    Write-Host "`nAll services are running in separate windows."
    Write-Host 'Press SPACE to stop all services and exit.'
    do {
        $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    } while ($key.Character -ne ' ')
}
finally {
    Write-Host 'Stopping services...'
    Stop-ProcessTree $frontendProcess
    Stop-ProcessTree $backendProcess
    Write-Host 'Done.'
}