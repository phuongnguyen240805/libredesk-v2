$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env.production")) {
    Write-Host "Missing .env.production. Copy .env.production.example to .env.production and fill secrets first." -ForegroundColor Red
    exit 1
}

function Get-DotEnvValue([string]$Name, [string]$DefaultValue) {
    $line = Get-Content ".env.production" |
        Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
        Select-Object -Last 1
    if (-not $line) { return $DefaultValue }
    return (($line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

$network = Get-DotEnvValue "LIORA_PLATFORM_NETWORK" "liora-platform"

docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker daemon is not available."
}

docker network inspect $network *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating external Docker network: $network"
    docker network create $network | Out-Null
}

Write-Host "Validating production compose..."
docker compose --env-file .env.production -f docker-compose.production.yml config | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Building and starting LibreDesk production stack..."
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
docker compose --env-file .env.production -f docker-compose.production.yml ps
Write-Host ""
Write-Host "Published host ports should only be 9001, 3100 and 3200 (or your overrides)."
