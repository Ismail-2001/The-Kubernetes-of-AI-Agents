param(
    [switch]$SkipDocker,
    [switch]$SkipCrossCutting,
    [switch]$SkipHelm,
    [switch]$SetupPreCommit
)

$ErrorActionPreference = "Stop"
$script:exitCode = 0
$script:startTime = Get-Date
$script:steps = @()

function Step {
    param([string]$name, [ScriptBlock]$block)
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    $stepStart = Get-Date
    try {
        & $block
        $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
        Write-Host ("  PASS ($secs`s)") -ForegroundColor Green
        $script:steps += @{ name = $name; status = "PASS"; secs = $secs }
    } catch {
        $secs = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
        Write-Host ("  FAIL ($secs`s): $_") -ForegroundColor Red
        $script:exitCode = 1
        $script:steps += @{ name = $name; status = "FAIL"; secs = $secs }
    }
}

function WriteHeader($text) {
    Write-Host ("`n" + ("=" * 60)) -ForegroundColor Yellow
    Write-Host "  $text" -ForegroundColor Yellow
    Write-Host ("=" * 60) -ForegroundColor Yellow
}

# ─── Pre-commit hook setup ──────────────────────────────────────────────
if ($SetupPreCommit) {
    WriteHeader "Setting up pre-commit hook"
    $hookDir = ".git\hooks"
    if (Test-Path $hookDir) {
        $hookContent = @"
#!/bin/sh
# E-GAOP pre-commit hook: run local CI on staged changes
exec powershell -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\ci-local.ps1" -SkipDocker -SkipCrossCutting -SkipHelm
"@
        Set-Content -LiteralPath "$hookDir\pre-commit" -Value $hookContent
        Write-Host "  Pre-commit hook installed at .git/hooks/pre-commit"
    } else {
        Write-Host "  Not a git repository - skipping pre-commit hook"
    }
}

WriteHeader "E-GAOP Local CI Pipeline (aligned with GitHub Actions)"

# ─── Environment checks ─────────────────────────────────────────────────
Step -name "Node.js version" -block {
    $ver = node --version
    Write-Host "  $ver"
    if ($ver -notmatch "v20") {
        Write-Host "  WARNING: GitHub CI uses Node 20, local is $ver" -ForegroundColor Yellow
    }
}

Step -name "npm version" -block {
    $ver = npm --version
    Write-Host "  $ver"
}

# ─── Dependency installation ───────────────────────────────────────────
Step -name "npm ci (clean install)" -block {
    if (Test-Path "node_modules\.package-lock.json") {
        npm ci
    } else {
        npm install
    }
}

# ─── Security Audit ────────────────────────────────────────────────────
Step -name "npm audit (high severity)" -block {
    $output = npm audit --audit-level=high 2>&1
    $exit = $LASTEXITCODE
    if ($exit -eq 0) {
        Write-Host "  0 high-severity vulnerabilities" -ForegroundColor Green
    } else {
        Write-Host "  Vulnerabilities found (exit $exit)" -ForegroundColor Yellow
        Write-Host $output
        throw "npm audit failed"
    }
}

# ─── Lint ──────────────────────────────────────────────────────────────
Step -name "Lint all workspaces" -block {
    npm run lint --workspaces --if-present
}

# ─── Build shared (dependency for all other workspaces) ────────────────
Step -name "Build @e-gaop/shared" -block {
    npm run build --workspace=packages/shared
}

# ─── Type check ────────────────────────────────────────────────────────
Step -name "Type check all workspaces" -block {
    npm run typecheck --workspaces --if-present
}

# ─── Build all ─────────────────────────────────────────────────────────
Step -name "Build all workspaces" -block {
    npm run build --workspaces --if-present
}

# ─── Unit tests ────────────────────────────────────────────────────────
Step -name "Unit tests (all workspaces)" -block {
    npm test --workspaces --if-present -- --passWithNoTests
}

# ─── Cross-cutting tests ────────────────────────────────────────────────
if (-not $SkipCrossCutting) {
    Step -name "Cross-cutting tests (contract, security)" -block {
        $config = "tests/jest.config.ts"
        if (Test-Path $config) {
            Write-Host "  Running contract tests..."
            npx jest --config $config --selectProjects contract --passWithNoTests
            Write-Host "  Running security tests..."
            npx jest --config $config --selectProjects security --passWithNoTests
            Write-Host "  Running chaos tests..."
            npx jest --config $config --selectProjects chaos --passWithNoTests
        } else {
            $tsconfig = "tests/jest.config.js"
            if (Test-Path $tsconfig) {
                Write-Host "  Running contract tests..."
                npx jest --config $tsconfig --selectProjects contract --passWithNoTests
                Write-Host "  Running security tests..."
                npx jest --config $tsconfig --selectProjects security --passWithNoTests
                Write-Host "  Running chaos tests..."
                npx jest --config $tsconfig --selectProjects chaos --passWithNoTests
            } else {
                Write-Host "  No cross-cutting test config found - skipping"
            }
        }
    }
} else {
    Write-Host "`n  [SKIPPED] Cross-cutting tests" -ForegroundColor DarkYellow
}

# ─── Docker compose validation ───────────────────────────────────────────
Step -name "Docker Compose config validation" -block {
    $dc = "docker-compose.yml"
    if (Test-Path $dc) {
        docker compose config --quiet 2>&1
        if ($LASTEXITCODE -ne 0) { throw "docker-compose.yml is invalid" }
        Write-Host "  docker-compose.yml validates OK"
    } else {
        Write-Host "  No docker-compose.yml found - skipping"
    }
}

# ─── Docker image build ──────────────────────────────────────────────────
if (-not $SkipDocker) {
    Step -name "Docker Compose build (all services)" -block {
        docker compose build --no-cache 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Docker build failed (exit $LASTEXITCODE)" }
    }
} else {
    Write-Host "`n  [SKIPPED] Docker build" -foreground DarkYellow
}

# ─── Helm chart lint ─────────────────────────────────────────────────────
if (-not $SkipHelm) {
    Step -name "Helm chart lint" -block {
        $chartDir = "charts\e-gaop"
        if (Test-Path $chartDir) {
            # Lint the parent chart (builds deps if needed)
            helm lint $chartDir 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Helm lint failed" }

            # Template render check
            helm template egaop-test $chartDir 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Helm template render failed" }
            Write-Host "  Helm chart lint + template render passed"
        } else {
            Write-Host "  No helm chart found at $chartDir - skipping"
        }
    }
} else {
    Write-Host "`n  [SKIPPED] Helm chart lint" -ForegroundColor DarkYellow
}

# ─── Summary report ─────────────────────────────────────────────────────
$total = (Get-Date) - $script:startTime
$elapsedStr = [math]::Round($total.TotalMinutes, 1)

WriteHeader "CI Pipeline Summary"
Write-Host "  Step                          Status    Time"
Write-Host "  " + ("-" * 45)
foreach ($s in $script:steps) {
    $color = if ($s.status -eq "PASS") { "Green" } else { "Red" }
    Write-Host ("  {0,-30} {1,-8} {2}s" -f $s.name, $s.status, [math]::Round($s.secs, 1)) -ForegroundColor $color
}
Write-Host ("  " + ("-" * 45))
Write-Host ""

if ($script:exitCode -eq 0) {
    Write-Host "  ALL CHECKS PASSED ($elapsedStr min)" -ForegroundColor Green
    Write-Host "  Ready for git push." -ForegroundColor Green
} else {
    Write-Host "  SOME CHECKS FAILED ($elapsedStr min)" -ForegroundColor Red
    Write-Host "  Fix errors above before pushing." -ForegroundColor Red
}
exit $script:exitCode
