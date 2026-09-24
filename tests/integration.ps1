# E-GAOP Integration Tests (PowerShell)
$ErrorActionPreference = "Continue"
$NAMESPACE = "egaop"
$PASS = 0
$FAIL = 0
$TOTAL = 0

function Assert-True($condition, $msg) {
    $script:TOTAL++
    if ($condition) { $script:PASS++; Write-Host "  [PASS] $msg" -ForegroundColor Green }
    else { $script:FAIL++; Write-Host "  [FAIL] $msg" -ForegroundColor Red }
}

function Get-Pod($label) {
    kubectl get pod -n $NAMESPACE -l $label -o jsonpath='{.items[0].metadata.name}' 2>$null
}

function Invoke-Health($pod, $port, $path) {
    $nodeScript = "const http = require('http'); http.get('http://127.0.0.1:$port$path', r => { let d=''; r.on('data', c => d+=c); r.on('end', () => console.log(d)); }).on('error', e => console.log('ERR:'+e.message))"
    try {
        $result = kubectl exec -n $NAMESPACE $pod -- node -e $nodeScript 2>$null
        return $result
    } catch { return "TIMEOUT" }
}

Write-Host "`n=== E-GAOP Integration Tests ===" -ForegroundColor Cyan

# 1. Pod Health
Write-Host "`n--- 1. Pod Health ---" -ForegroundColor Yellow
$notRunning = kubectl get pods -n $NAMESPACE --no-headers 2>$null | Where-Object { $_ -notmatch "Running" -and $_ -notmatch "Completed" }
$notReady = kubectl get pods -n $NAMESPACE --no-headers 2>$null | Where-Object {
    $_ -match "Running" -and
    $_ -notmatch "sandbox-runtime" -and
    $_ -match '^\S+\s+(\d+)/(\d+)' -and
    ([int]$Matches[1] -ne [int]$Matches[2])
}
Assert-True (-not $notRunning) "All pods are Running"
Assert-True (-not $notReady) "All Running pods fully ready (sandbox-runtime expected 0/1 in Kind: Docker unreachable)"

# 2. Liveness (/healthz = always 200)
Write-Host "`n--- 2. Liveness Contract ---" -ForegroundColor Yellow
$apiPod = Get-Pod "app.kubernetes.io/name=api-server"
$wfPod = Get-Pod "app.kubernetes.io/name=workflow-engine"
$sandboxPod = Get-Pod "app.kubernetes.io/name=sandbox-runtime"
$llmPod = Get-Pod "app.kubernetes.io/name=llm-router"
$secretPod = Get-Pod "app.kubernetes.io/name=secret-store"
$toolPod = Get-Pod "app.kubernetes.io/name=tool-proxy"

$checks = @(
    @($apiPod, 15051, "api-server"),
    @($wfPod, 15058, "workflow-engine"),
    @($sandboxPod, 15054, "sandbox-runtime"),
    @($llmPod, 15053, "llm-router"),
    @($secretPod, 15057, "secret-store"),
    @($toolPod, 15052, "tool-proxy")
)
foreach ($c in $checks) {
    $pod = $c[0]; $port = $c[1]; $name = $c[2]
    if (-not $pod) { continue }
    $resp = Invoke-Health $pod $port "/healthz"
    Assert-True ($resp -match '"status":"SERVING"') "$name liveness returns SERVING (port $port)"
}

# 3. Readiness (/readyz checks dependencies)
Write-Host "`n--- 3. Readiness Contract ---" -ForegroundColor Yellow
$resp = Invoke-Health $apiPod 15051 "/readyz"
Assert-True ($resp -match '"postgres"') "api-server readiness checks postgres"
Assert-True ($resp -match '"status":"SERVING"') "api-server readiness is SERVING"

$resp = Invoke-Health $wfPod 15058 "/readyz"
Assert-True ($resp -match '"postgres"') "workflow-engine readiness checks postgres"
Assert-True ($resp -match '"temporal"') "workflow-engine readiness checks temporal"
Assert-True ($resp -match '"name":"temporal","status":"healthy"') "workflow-engine temporal is healthy"

$resp = Invoke-Health $sandboxPod 15054 "/readyz"
Assert-True ($resp -match '"docker"') "sandbox-runtime readiness checks docker"
Assert-True ($resp -match '"NOT_SERVING"') "sandbox-runtime is NOT_SERVING (no Docker)"

$resp = Invoke-Health $llmPod 15053 "/readyz"
Assert-True ($resp -match '"circuit_breaker"') "llm-router readiness checks circuit breaker"
Assert-True ($resp -match '"status":"SERVING"') "llm-router readiness is SERVING"

$resp = Invoke-Health $secretPod 15057 "/readyz"
Assert-True ($resp -match '"postgres"') "secret-store readiness checks postgres"
Assert-True ($resp -match '"status":"SERVING"') "secret-store readiness is SERVING"

# 4. Network Connectivity
Write-Host "`n--- 4. Network Connectivity ---" -ForegroundColor Yellow
$resp = Invoke-Health $apiPod 15051 "/readyz"
Assert-True ($resp -match '"name":"postgres","status":"healthy"') "api-server -> postgres reachable"

$resp = Invoke-Health $wfPod 15058 "/readyz"
Assert-True ($resp -match '"name":"postgres","status":"healthy"') "workflow-engine -> postgres reachable"

# 5. Health Response Format (contract compliance)
Write-Host "`n--- 5. Health Response Format ---" -ForegroundColor Yellow
$resp = Invoke-Health $apiPod 15051 "/healthz"
Assert-True ($resp -match '"version"' -and $resp -match '"uptime_s"' -and $resp -match '"timestamp"') "api-server liveness has contract fields"

$resp = Invoke-Health $wfPod 15058 "/healthz"
Assert-True ($resp -match '"version"' -and $resp -match '"uptime_s"' -and $resp -match '"timestamp"') "workflow-engine liveness has contract fields"

$resp = Invoke-Health $sandboxPod 15054 "/healthz"
Assert-True ($resp -match '"version"' -and $resp -match '"uptime_s"' -and $resp -match '"timestamp"') "sandbox-runtime liveness has contract fields"

$resp = Invoke-Health $llmPod 15053 "/healthz"
Assert-True ($resp -match '"version"' -and $resp -match '"uptime_s"' -and $resp -match '"timestamp"') "llm-router liveness has contract fields"

# 6. OPA
Write-Host "`n--- 6. OPA ---" -ForegroundColor Yellow
$opaPod = Get-Pod "app.kubernetes.io/name=opa"
Assert-True (-not [string]::IsNullOrEmpty($opaPod)) "OPA pod exists"

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Total: $TOTAL  Passed: $PASS  Failed: $FAIL" -ForegroundColor $(if ($FAIL -gt 0) { "Red" } else { "Green" })
Write-Host "========================================" -ForegroundColor Cyan

if ($FAIL -gt 0) { exit 1 }
