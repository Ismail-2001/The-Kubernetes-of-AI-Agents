param(
  [string]$ProjectRoot = "C:\Users\Ismail Sajid\Downloads\Enterprise-Grade-Agent-Orchestration-Platform-main\Enterprise-Grade-Agent-Orchestration-Platform-main"
)

$ErrorActionPreference = "Stop"

# Compile workflow-engine
Write-Host "=== Compiling workflow-engine ===" -ForegroundColor Cyan
Set-Location -LiteralPath "$ProjectRoot\control-plane\workflow-engine"

# Use TypeScript API programmatically
$ts = node -e "const t = require('typescript'); console.log(t.version)" 2>&1
Write-Host "TypeScript $ts found" -ForegroundColor Green

# Compile specific files
$files = @(
  "src\temporal\activities\index.ts",
  "src\temporal\workflows\react-workflow.ts",
  "src\temporal\types.ts",
  "src\temporal\classification.ts"
)

$rootDir = "$ProjectRoot\control-plane\workflow-engine"
$outDir = "$rootDir\dist"

# Read tsconfig
$tsconfigPath = "$rootDir\tsconfig.json"
$tsconfig = Get-Content $tsconfigPath -Raw | ConvertFrom-Json

# Create output directories
New-Item -ItemType Directory -Path "$outDir\temporal\activities" -Force | Out-Null
New-Item -ItemType Directory -Path "$outDir\temporal\workflows" -Force | Out-Null

# Compile each file
foreach ($file in $files) {
  $sourcePath = "$rootDir\$file"
  $relativePath = $file -replace '^src\\', ''
  $outPath = "$outDir\$relativePath" -replace '\.ts$', '.js'
  
  Write-Host "  Compiling $file -> $outPath" -ForegroundColor DarkYellow
  
  # Use tsc via node
  $result = node -e "
    const ts = require('typescript');
    const source = require('fs').readFileSync('$sourcePath', 'utf8');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        strict: false,
        skipLibCheck: true,
        outDir: '$outDir',
        rootDir: '$rootDir\\src'
      }
    });
    require('fs').writeFileSync('$outPath', result.outputText);
    console.log('OK');
  " 2>&1
  
  if ($result -ne "OK") {
    Write-Host "  FAILED: $result" -ForegroundColor Red
    exit 1
  }
}

Write-Host "Compilation complete" -ForegroundColor Green

# Copy to container
Write-Host "`n=== Deploying to containers ===" -ForegroundColor Cyan

$engineContainer = docker ps --filter "name=workflow-engine" --format "{{.ID}}"

Write-Host "Deploying activities..." -ForegroundColor DarkYellow
docker cp "$outDir\temporal\activities\index.js" ${engineContainer}:/app/dist/temporal/activities/index.js 2>&1
docker cp "$outDir\temporal\activities\index.js.map" ${engineContainer}:/app/dist/temporal/activities/index.js.map 2>&1

Write-Host "Deploying react-workflow..." -ForegroundColor DarkYellow
docker cp "$outDir\temporal\workflows\react-workflow.js" ${engineContainer}:/app/dist/temporal/workflows/react-workflow.js 2>&1
docker cp "$outDir\temporal\workflows\react-workflow.js.map" ${engineContainer}:/app/dist/temporal/workflows/react-workflow.js.map 2>&1

Write-Host "`nDeploying LLM router..." -ForegroundColor Cyan
# Compile LLM router
Set-Location -LiteralPath "$ProjectRoot\execution-plane\llm-router"
$llmOutDir = "$ProjectRoot\execution-plane\llm-router\dist"
New-Item -ItemType Directory -Path $llmOutDir -Force | Out-Null

$result = node -e "
  const ts = require('typescript');
  const source = require('fs').readFileSync('$ProjectRoot/execution-plane/llm-router/src/index.ts', 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true
    }
  });
  require('fs').writeFileSync('$llmOutDir/index.js', result.outputText);
  console.log('OK');
" 2>&1

if ($result -ne "OK") {
  Write-Host "LLM router compile FAILED: $result" -ForegroundColor Red
  exit 1
}

$llmContainer = docker ps --filter "name=llm-router" --format "{{.ID}}"
docker cp "$llmOutDir\index.js" ${llmContainer}:/app/dist/index.js 2>&1

Write-Host "All files deployed" -ForegroundColor Green
