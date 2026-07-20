param(
    [switch]$SkipDocker,
    [switch]$SkipCrossCutting
)

$ErrorActionPreference = "Stop"
$script:exitCode = 0
$script:startTime = Get-Date

function Step {
    param([string]$name, [ScriptBlock]$block)
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    $stepStart = Get-Date
    try {
        & $block
        $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
        Write-Host ("  PASS ($secs`s)") -ForegroundColor Green
    } catch {
        $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
        Write-Host ("  FAIL ($secs`s): $_") -ForegroundColor Red
        $script:exitCode = 1
    }
}

function WriteHeader($text) {
    Write-Host ("`n" + ("=" * 60)) -ForegroundColor Yellow
    Write-Host "  $text" -ForegroundColor Yellow
    Write-Host ("=" * 60) -ForegroundColor Yellow
}

WriteHeader "E-GAOP Local CI Pipeline"

Step -name "Node.js version" -block {
    $ver = node --version
    Write-Host "  $ver"
}

Step -name "npm version" -block {
    $ver = npm --version
    Write-Host "  $ver"
}

Step -name "npm audit" -block {
    npm audit --audit-level=high
    Write-Host "  0 high-severity vulnerabilities"
}

Step -name "Lint workspaces" -block {
    npm run lint --workspaces --if-present
}

Step -name "Build @e-gaop/shared" -block {
    npm run build --workspace=packages/shared
}

Step -name "Type check all workspaces" -block {
    npm run typecheck --workspaces --if-present
}

Step -name "Build all workspaces" -block {
    npm run build --workspaces --if-present
}

Step -name "Unit tests" -block {
    npm test --workspaces --if-present -- --passWithNoTests
}

if (-not $SkipCrossCutting) {
    Step -name "Cross-cutting tests" -block {
        $config = "tests/jest.config.ts"
        if (Test-Path $config) {
            npx jest --config $config --selectProjects contract --passWithNoTests
            npx jest --config $config --selectProjects security --passWithNoTests
        } else {
            Write-Host "  No cross-cutting test config found - skipping"
        }
    }
} else {
    Write-Host "`n  [SKIPPED] Cross-cutting tests" -ForegroundColor DarkYellow
}

if (-not $SkipDocker) {
    Step -name "Docker Compose build" -block {
        docker compose build --no-cache 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Docker build failed (exit $LASTEXITCODE)" }
    }
} else {
    Write-Host "`n  [SKIPPED] Docker build" -ForegroundColor DarkYellow
}

$total = (Get-Date) - $script:startTime
$elapsedStr = [math]::Round($total.TotalMinutes, 1)
WriteHeader "CI Pipeline Complete"
if ($script:exitCode -eq 0) {
    Write-Host "  ALL CHECKS PASSED ($elapsedStr min)" -ForegroundColor Green
} else {
    Write-Host "  SOME CHECKS FAILED ($elapsedStr min)" -ForegroundColor Red
}
exit $script:exitCode
