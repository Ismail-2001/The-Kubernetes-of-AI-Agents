param(
    [switch]$NoCache,
    [string[]]$Services = @(),
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
$startTime = Get-Date

# Image map: service name -> Dockerfile path
$imageMap = @{
    "api-server"        = @{ dockerfile = "control-plane/api-server/Dockerfile";        image = "egaop/api-server" }
    "secret-store"      = @{ dockerfile = "control-plane/secret-store/Dockerfile";      image = "egaop/secret-store" }
    "workflow-engine"   = @{ dockerfile = "control-plane/workflow-engine/Dockerfile";   image = "egaop/workflow-engine" }
    "llm-router"        = @{ dockerfile = "execution-plane/llm-router/Dockerfile";      image = "egaop/llm-router" }
    "tool-proxy"        = @{ dockerfile = "execution-plane/tool-proxy/Dockerfile";      image = "egaop/tool-proxy" }
    "sandbox-runtime"   = @{ dockerfile = "execution-plane/sandbox-runtime/Dockerfile"; image = "egaop/sandbox-runtime" }
    "memory-plane"      = @{ dockerfile = "memory-plane/Dockerfile";                    image = "egaop/memory-plane" }
    "observability-plane" = @{ dockerfile = "observability-plane/Dockerfile";           image = "egaop/observability-plane" }
    "admin-console"     = @{ dockerfile = "admin-console/Dockerfile";                   image = "egaop/admin-console" }
    "base-runtime"      = @{ dockerfile = "execution-plane/sandbox-runtime/base-runtime/Dockerfile"; image = "egaop-base-runtime" }
    "migrate"           = @{ dockerfile = "infrastructure/migrate/Dockerfile";           image = "egaop/migrate" }
}

if ($Services.Count -eq 0) {
    $Services = $imageMap.Keys | Sort-Object
}

Write-Host "=== Docker Build All ===" -ForegroundColor Cyan
Write-Host "Tag: $Tag"
Write-Host "Services: $($Services -join ', ')"
if ($NoCache) { Write-Host "No-cache: ON" -ForegroundColor Yellow }
Write-Host ("=" * 50)

$results = @()
foreach ($svc in $Services) {
    if (-not $imageMap.ContainsKey($svc)) {
        Write-Host "WARNING: Unknown service '$svc', skipping" -ForegroundColor Yellow
        continue
    }
    $info = $imageMap[$svc]
    $imageTag = "$($info.image):$Tag"
    $buildArgs = @("build", "-f", $info.dockerfile, "-t", $imageTag, ".")
    if ($NoCache) { $buildArgs = @("build", "--no-cache", "-f", $info.dockerfile, "-t", $imageTag, ".") }

    Write-Host "`n--- Building $svc -> $imageTag ---" -ForegroundColor Cyan
    $stepStart = Get-Date
    try {
        $output = docker $buildArgs 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            Write-Host "  FAILED (exit $exitCode)" -ForegroundColor Red
            Write-Host $output
            $results += @{ service = $svc; status = "FAIL"; secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1) }
        } else {
            $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
            Write-Host "  PASS ($secs`s)" -ForegroundColor Green
            $results += @{ service = $svc; status = "PASS"; secs = $secs }
        }
    } catch {
        Write-Host "  ERROR: $_" -ForegroundColor Red
        $results += @{ service = $svc; status = "ERROR"; secs = 0 }
    }
}

$total = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
Write-Host "`n=== Build Summary ===" -ForegroundColor Yellow
Write-Host ("{0,-25} {1,-8} {2}" -f "Service", "Status", "Time")
Write-Host ("-" * 45)
$failCount = 0
foreach ($r in $results) {
    $color = if ($r.status -eq "PASS") { "Green" } else { "Red" }
    if ($r.status -ne "PASS") { $failCount++ }
    Write-Host ("{0,-25} {1,-8} {2}s" -f $r.service, $r.status, $r.secs) -ForegroundColor $color
}
Write-Host ("-" * 45)
if ($failCount -eq 0) {
    Write-Host "ALL $($results.Count) IMAGES BUILT ($total min)" -ForegroundColor Green
} else {
    Write-Host "$failCount FAILURES ($total min)" -ForegroundColor Red
    exit 1
}
