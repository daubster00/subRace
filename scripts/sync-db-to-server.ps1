#!/usr/bin/env pwsh
# scripts/sync-db-to-server.ps1
# Push the local SQLite DB into the server's `subrace_data` docker volume,
# OVERWRITING whatever is on the server. Use after backfilling locally when
# you want the server to start serving the same dataset.
#
# Setup once:
#   - Add an SSH alias to ~/.ssh/config (e.g. Host subrace-prod ...).
#   - Create .env.deploy at the repo root (gitignored) with:
#         DEPLOY_HOST=subrace-prod
#         DEPLOY_PATH=/opt/subrace        # the dir containing docker-compose.yml
#
# Run:
#   pwsh scripts/sync-db-to-server.ps1
#   # or override on the command line:
#   pwsh scripts/sync-db-to-server.ps1 -SshHost subrace-prod -RemotePath /opt/subrace
#
# What it does, end to end:
#   1. Copies the local DB (incl. WAL/SHM) into a server temp dir over scp.
#   2. Stops subrace-web + subrace-worker on the server.
#   3. Runs a throwaway alpine container mounted on the `subrace_data` volume
#      to swap the DB files in place (preserving node:node ownership = uid 1000).
#   4. Restarts the stack and waits for the web healthcheck to come back.

[CmdletBinding()]
param(
    [string]$SshHost,
    [string]$RemotePath,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# --- resolve config from .env.deploy if not passed in -----------------------
$envFile = Join-Path $repoRoot '.env.deploy'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') {
            $name = $Matches[1]
            $value = $Matches[2].Trim('"').Trim("'")
            if ($name -eq 'DEPLOY_HOST' -and -not $SshHost) { $SshHost = $value }
            if ($name -eq 'DEPLOY_PATH' -and -not $RemotePath) { $RemotePath = $value }
        }
    }
}
if (-not $SshHost -or -not $RemotePath) {
    throw "Need DEPLOY_HOST + DEPLOY_PATH. Set them in .env.deploy or pass -SshHost / -RemotePath."
}

# --- preflight: local DB files exist? ---------------------------------------
$localDbDir = Join-Path $repoRoot 'data'
$localDb    = Join-Path $localDbDir 'subrace.db'
if (-not (Test-Path $localDb)) { throw "Local DB not found: $localDb" }

$dbSize = (Get-Item $localDb).Length / 1MB
Write-Host ("[preflight] Local DB: {0:N1} MB" -f $dbSize)

# Confirm before destructive action on the server.
Write-Host ""
Write-Host "About to OVERWRITE the SQLite DB inside the 'subrace_data' volume on:"
Write-Host "  ssh host : $SshHost"
Write-Host "  repo path: $RemotePath"
Write-Host ""
if (-not $Yes) {
    $reply = Read-Host "Type 'yes' to continue"
    if ($reply -ne 'yes') { Write-Host "Aborted."; exit 1 }
} else {
    Write-Host "(skipping confirmation: -Yes was set)"
}

# --- 1) stage on the server -------------------------------------------------
$remoteTmp = "/tmp/subrace-db-sync-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
Write-Host "[1/4] Creating remote staging dir: $remoteTmp"
& ssh $SshHost "mkdir -p $remoteTmp"
if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed" }

Write-Host "[2/4] Uploading DB files via scp..."
# Copy WAL/SHM too if they exist — SQLite merges them on next open.
$filesToCopy = @($localDb)
foreach ($suffix in '-wal','-shm') {
    $p = Join-Path $localDbDir "subrace.db$suffix"
    if (Test-Path $p) { $filesToCopy += $p }
}
& scp @filesToCopy "${SshHost}:${remoteTmp}/"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

# --- 2) swap on the server (web/worker stopped while we touch the volume) ----
# Use a single-quoted here-string so PowerShell does not expand $vars locally;
# the remote shell does the work. REPO_PATH / TMP_DIR placeholders are filled in
# before send.
$remoteScript = @'
set -euo pipefail
cd "REPO_PATH"
echo "[remote] Stopping web + worker..."
sudo docker compose stop web worker
echo "[remote] Swapping DB inside subrace_data volume..."
sudo docker run --rm \
  -v subrace_data:/data \
  -v "TMP_DIR":/in \
  alpine sh -c '
    set -eu
    rm -f /data/subrace.db /data/subrace.db-wal /data/subrace.db-shm
    cp /in/subrace.db /data/subrace.db
    [ -f /in/subrace.db-wal ] && cp /in/subrace.db-wal /data/subrace.db-wal || true
    [ -f /in/subrace.db-shm ] && cp /in/subrace.db-shm /data/subrace.db-shm || true
    # node user inside the runner image is uid 1000.
    chown 1000:1000 /data/subrace.db /data/subrace.db-wal /data/subrace.db-shm 2>/dev/null || true
  '
echo "[remote] Cleaning up staging dir..."
rm -rf "TMP_DIR"
echo "[remote] Bringing the stack back up..."
sudo docker compose up -d
'@
$remoteScript = $remoteScript.Replace('REPO_PATH', $RemotePath).Replace('TMP_DIR', $remoteTmp)

Write-Host "[3/4] Executing remote swap..."
& ssh $SshHost $remoteScript
if ($LASTEXITCODE -ne 0) { throw "remote swap failed" }

# --- 3) verify --------------------------------------------------------------
Write-Host "[4/4] Waiting for web healthcheck..."
$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
do {
    Start-Sleep -Seconds 5
    $status = & ssh $SshHost "cd '$RemotePath' && sudo docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null | grep subrace-web"
    Write-Host "  $status"
    if ($status -match 'healthy') { $healthy = $true; break }
} while ((Get-Date) -lt $deadline)

if ($healthy) {
    Write-Host ""
    Write-Host "[OK] DB sync complete. subrace-web is healthy."
} else {
    Write-Warning "Web did not report healthy within 90s. Check with: ssh $SshHost 'cd $RemotePath && sudo docker compose logs --tail=50 web'"
    exit 2
}
