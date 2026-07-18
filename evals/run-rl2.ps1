# run-rl2.ps1 — Run RL-2 eval and compare against RL-1 baseline
# Prerequisites: Docker stack running (api-server on localhost:3001)
param(
  [switch]$NoRun
)

if (-not $NoRun) {
  Write-Host "=== Running RL-2 eval ==="
  cd evals
  node run-evals.mjs
  if ($LASTEXITCODE -ne 0) { Write-Host "Eval run failed"; exit 1 }
  
  # Find the latest result file
  $latest = Get-ChildItem results/*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Write-Host "No result file found"; exit 1 }
  
  # Save as RL-2 baseline
  Copy-Item $latest.FullName -Destination "baselines/RL-2.json" -Force
  Write-Host "Saved RL-2 from $($latest.Name)"
}

Write-Host "`n=== Comparing RL-1 vs RL-2 ==="
cd evals
node compare-evals.mjs RL-1 RL-2
