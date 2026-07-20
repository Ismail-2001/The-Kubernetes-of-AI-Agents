param(
    [string]$ClusterName = "egaop-test",
    [string]$Tag = "latest",
    [switch]$NoCache,
    [switch]$SkipBuild,
    [switch]$DestroyFirst
)

$ErrorActionPreference = "Stop"
$script:startTime = Get-Date
$HELM_RELEASE = "egaop-test"
$HELM_CHART = "charts/e-gaop"

function Step {
    param([string]$name, [ScriptBlock]$block)
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    $stepStart = Get-Date
    try {
        & $block
        $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
        Write-Host "  PASS ($secs`s)" -ForegroundColor Green
    } catch {
        $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
        Write-Host "  FAIL ($secs`s): $_" -ForegroundColor Red
        throw $_
    }
}

function WriteHeader($text) {
    Write-Host ("`n" + ("=" * 60)) -ForegroundColor Yellow
    Write-Host "  $text" -ForegroundColor Yellow
    Write-Host ("=" * 60) -ForegroundColor Yellow
}

# ─── Prerequisites check ─────────────────────────────────────────────────
Step -name "Prerequisites" -block {
    $tools = @("kind", "kubectl", "helm", "docker")
    foreach ($t in $tools) {
        $found = Get-Command $t -ErrorAction SilentlyContinue
        if (-not $found) { throw "$t not found in PATH" }
        Write-Host "  $t: $($found.Source)"
    }
}

# ─── Destroy existing cluster if requested ──────────────────────────────
if ($DestroyFirst) {
    Step -name "Destroy existing cluster '$ClusterName'" -block {
        $existing = kind get clusters 2>&1
        if ($existing -contains $ClusterName) {
            kind delete cluster --name $ClusterName
            Write-Host "  Cluster '$ClusterName' deleted"
        } else {
            Write-Host "  No cluster '$ClusterName' to delete"
        }
    }
}

# ─── Create Kind cluster ────────────────────────────────────────────────
Step -name "Create Kind cluster '$ClusterName'" -block {
    $existing = kind get clusters 2>&1
    if ($existing -contains $ClusterName) {
        Write-Host "  Cluster '$ClusterName' already exists"
        kubectl cluster-info --context "kind-$ClusterName" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Cluster context broken, recreating..." -ForegroundColor Yellow
            kind delete cluster --name $ClusterName
        } else {
            return
        }
    }

    $kindConfig = @"
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 3001
        hostPort: 3001
        protocol: TCP
      - containerPort: 3000
        hostPort: 3000
        protocol: TCP
"@
    $tmpFile = [System.IO.Path]::GetTempFileName()
    Set-Content -LiteralPath $tmpFile -Value $kindConfig
    try {
        kind create cluster --name $ClusterName --config $tmpFile
    } finally {
        Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  Cluster '$ClusterName' created"
}

# ─── Set kubectl context ────────────────────────────────────────────────
Step -name "Set kubectl context" -block {
    kubectl config use-context "kind-$ClusterName" 2>&1 | Out-Null
    Write-Host "  Context: kind-$ClusterName"
    $nodes = kubectl get nodes 2>&1
    Write-Host "  Nodes:`n$nodes"
}

# ─── Build Docker images ────────────────────────────────────────────────
if (-not $SkipBuild) {
    Step -name "Build Docker images" -block {
        & "$PSScriptRoot/docker-build-all.ps1" -Tag $Tag @($NoCache ? "-NoCache" : @())
    }
} else {
    Write-Host "`n  [SKIPPED] Docker build" -ForegroundColor DarkYellow
}

# ─── Load images into Kind ──────────────────────────────────────────────
Step -name "Load images into Kind" -block {
    $images = @(
        "egaop/api-server:$Tag",
        "egaop/secret-store:$Tag",
        "egaop/workflow-engine:$Tag",
        "egaop/llm-router:$Tag",
        "egaop/tool-proxy:$Tag",
        "egaop/sandbox-runtime:$Tag",
        "egaop/memory-plane:$Tag",
        "egaop/observability-plane:$Tag",
        "egaop/admin-console:$Tag",
        "egaop-base-runtime:$Tag"
    )
    foreach ($img in $images) {
        Write-Host "  Loading $img..."
        kind load docker-image --name $ClusterName $img 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to load $img" }
    }
    Write-Host "  All $($images.Count) images loaded"
}

# ─── Build Helm dependencies ────────────────────────────────────────────
Step -name "Build Helm dependencies" -block {
    helm dependency build $HELM_CHART 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Helm dependency build failed" }
}

# ─── Deploy Helm chart ─────────────────────────────────────────────────
Step -name "Deploy Helm chart" -block {
    $existing = helm list --filter "$HELM_RELEASE" -q 2>&1
    if ($existing -eq $HELM_RELEASE) {
        Write-Host "  Upgrading existing release '$HELM_RELEASE'..."
        helm upgrade $HELM_RELEASE $HELM_CHART --namespace default --install --wait --timeout 10m 2>&1
    } else {
        Write-Host "  Installing new release '$HELM_RELEASE'..."
        helm install $HELM_RELEASE $HELM_CHART --namespace default --wait --timeout 10m 2>&1
    }
    if ($LASTEXITCODE -ne 0) { throw "Helm deploy failed" }
}

# ─── Verify deployment ──────────────────────────────────────────────────
Step -name "Verify pods" -block {
    Start-Sleep -Seconds 10
    $pods = kubectl get pods -o wide 2>&1
    Write-Host "`n$pods"

    # Check for CrashLoopBackOff or pending pods
    $badPods = kubectl get pods --no-headers 2>&1 | Where-Object { $_ -match "CrashLoopBackOff|Error|Pending|Init:Error" }
    if ($badPods) {
        Write-Host "`nWARNING: Some pods are not healthy:" -ForegroundColor Yellow
        Write-Host $badPods
    } else {
        Write-Host "`nAll pods appear healthy" -ForegroundColor Green
    }
}

$total = [math]::Round(((Get-Date) - $script:startTime).TotalMinutes, 1)
WriteHeader "Deployment Complete"
Write-Host "  Cluster:    kind-$ClusterName"
Write-Host "  Release:    $HELM_RELEASE"
Write-Host "  Chart:      $HELM_CHART"
Write-Host "  Tag:        $Tag"
Write-Host "  Time:       $total min"
Write-Host "`n  Commands:"
Write-Host "    kubectl get pods -w"
Write-Host "    kubectl logs -f deployment/egaop-test-api-server"
Write-Host "    helm list"
if ($existing -ne $HELM_RELEASE) {
    Write-Host "`n  NOTE: Create required Secrets before using the system:"
    Write-Host "    kubectl create secret generic egaop-secrets --from-literal=openai-api-key=<your-key>"
}
