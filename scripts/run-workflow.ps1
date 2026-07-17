param(
  [string]$Prompt = "Write a poem about AI to /tmp/poem.txt, then read it back, then summarize what you did",
  [string]$AgentId = "loadtest-agent5"
)

$ErrorActionPreference = "Stop"

# Login
$log = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post `
  -ContentType "application/json" `
  -Body (@{ email = "loadtest5@test.com"; password = "LoadTestPass123" } | ConvertTo-Json)
$token = $log.data.token
Write-Host "Auth OK" -ForegroundColor Green

# Let the workflow use its default system prompt (includes all tool formats)

# Run agent
$runBody = @{
  input = @{
    prompt = $Prompt
  }
  namespace = "default"
} | ConvertTo-Json

Write-Host "Starting execution..." -ForegroundColor Cyan
$result = Invoke-RestMethod -Uri "http://localhost:3001/api/agents/$AgentId/run" -Method Post `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $runBody `
  -TimeoutSec 120

$execId = $result.data.executionId
$wfId = $result.data.workflowId
Write-Host "ExecutionId: $execId" -ForegroundColor Yellow
Write-Host "WorkflowId: $wfId" -ForegroundColor Yellow

# Poll for result via Temporal CLI
Write-Host "Waiting for workflow to complete..." -ForegroundColor Cyan
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep 2
  try {
    $raw = docker exec enterprise-grade-agent-orchestration-platform-main-temporal-1 sh -c "temporal workflow describe --address 127.0.0.1:7233 --namespace egaop -w $wfId -o json 2>/dev/null" 2>&1
    $desc = $raw | ConvertFrom-Json
    $status = $desc.workflowExecutionInfo.status
    Write-Host "  [$i] Status: $status" -ForegroundColor DarkYellow
    if ($status -eq "WORKFLOW_EXECUTION_STATUS_COMPLETED" -or $status -eq "WORKFLOW_EXECUTION_STATUS_FAILED" -or $status -eq "WORKFLOW_EXECUTION_STATUS_TIMED_OUT") {
      Write-Host "`n=== RESULT ===" -ForegroundColor Cyan
      $desc.result | Format-List | Out-Host

      Write-Host "`n=== SUMMARY ===" -ForegroundColor Green
      Write-Host "Status: $($desc.result.status)" -ForegroundColor White
      Write-Host "Iterations: $($desc.result.iterations)" -ForegroundColor White
      Write-Host "Tool calls: $(($desc.result.toolCalls | Measure-Object).Count)" -ForegroundColor White
      Write-Host "Total cost: $($desc.result.totalCost)" -ForegroundColor White
      Write-Host "Duration: $($desc.workflowExecutionInfo.executionDuration)" -ForegroundColor White
      Write-Host "Output: $($desc.result.output)" -ForegroundColor White

      Write-Host "`n=== TOOL CALLS ===" -ForegroundColor Cyan
      $desc.result.toolCalls | ForEach-Object { Write-Host "  $($_.iteration): $($_.toolName) [$($_.status)] $($_.latencyMs)ms" }

      break
    }
  } catch {
    Write-Host "  [$i] Temporal query error (may still be running)" -ForegroundColor DarkRed
  }
}
