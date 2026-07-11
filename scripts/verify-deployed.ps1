# verify-deployed.ps1 — Compares running Docker image build dates against
# the latest git commit touching each service's source directory.
# Exits non-zero if any image predates the latest commit (drift detected).
param([string]$ComposeProject = "enterprise-grade-agent-orchestration-platform-main")

$ErrorActionPreference = "Stop"
$DRIFT = 0

$Services = @{
    "api-server"        = "control-plane/api-server"
    "admin-console"     = "admin-console"
    "workflow-engine"   = "control-plane/workflow-engine"
    "sandbox-runtime"   = "execution-plane/sandbox-runtime"
    "observability-plane" = "observability-plane"
    "memory-plane"      = "memory-plane"
    "tool-proxy"        = "execution-plane/tool-proxy"
    "secret-store"      = "control-plane/secret-store"
    "llm-router"        = "execution-plane/llm-router"
}

foreach ($service in $Services.Keys) {
    $dir = $Services[$service]
    $img = "$ComposeProject-${service}:latest"

    $imgCreated = docker image inspect "$img" --format '{{.Created}}' 2>$null
    if (-not $imgCreated) {
        Write-Host "[MISSING] ${service}: image $img not found" -ForegroundColor Red
        $DRIFT = 1
        continue
    }
    $imgCreated = $imgCreated.Substring(0, 19)

    $gitTs = git log -1 --format="%cI" -- "$dir" 2>$null
    if (-not $gitTs) {
        Write-Host "[WARN]    ${service}: no git history for $dir" -ForegroundColor Yellow
        continue
    }
    $gitTs = $gitTs.Substring(0, 19)

    $imgDate = [DateTimeOffset]::Parse($imgCreated)
    $gitDate = [DateTimeOffset]::Parse($gitTs)

    if ($imgDate -lt $gitDate) {
        Write-Host "[STALE]   ${service}: image=$imgCreated  git=$gitTs" -ForegroundColor Red
        $DRIFT = 1
    } else {
        Write-Host "[OK]      ${service}: image=$imgCreated  git=$gitTs" -ForegroundColor Green
    }
}

Write-Host ""
if ($DRIFT -ne 0) {
    Write-Host "Drift detected. Run: docker compose build --no-cache <service> && docker compose up -d --force-recreate <service>" -ForegroundColor Yellow
    exit 1
}

Write-Host "All images are up to date." -ForegroundColor Green
