param(
  [int]$Concurrency = 3,
  [int]$TotalRuns = 6
)

$ErrorActionPreference = "Stop"

function Log($msg, $color) { Write-Host $msg -ForegroundColor $color }

$results = [System.Collections.Concurrent.ConcurrentBag[PSCustomObject]]::new()
$timings = [System.Collections.Concurrent.ConcurrentBag[double]]::new()

Log "=== E-GAOP Concurrent Load Test ===" "Cyan"
Log "Concurrency: $Concurrency, Runs: $TotalRuns" "Cyan"

# Get auth token
try {
  $reg = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/register" -Method Post `
    -ContentType "application/json" `
    -Body (@{ name = "loadtest5"; email = "loadtest5@test.com"; password = "LoadTestPass123" } | ConvertTo-Json)
  $token = $reg.data.token
} catch {
  $log = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post `
    -ContentType "application/json" `
    -Body (@{ email = "loadtest5@test.com"; password = "LoadTestPass123" } | ConvertTo-Json)
  $token = $log.data.token
}
Log "Auth OK" "Green"

# Create agent
try { $agent = Invoke-RestMethod -Uri "http://localhost:3001/api/agents" -Method Post `
  -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" `
  -Body (@{ name = "loadtest-agent5"; namespace = "default"; spec = @{ model = "gpt-4o-mini" } } | ConvertTo-Json) } catch {}
$agentId = "loadtest-agent5"

$headers = @{ Authorization = "Bearer $token" }
$startTime = Get-Date

# Run parallel
$pool = [RunspaceFactory]::CreateRunspacePool(1, $Concurrency)
$pool.Open()
$runspaces = @()

for ($i = 1; $i -le $TotalRuns; $i++) {
  $ps = [PowerShell]::Create()
  $ps.RunspacePool = $pool
  $scriptBlock = {
    param($u, $h, $b, $i, $res, $tim)
    $s = Get-Date
    try {
      $r = Invoke-RestMethod -Uri $u -Method Post -Headers $h -ContentType "application/json" -Body $b -TimeoutSec 120
      $el = ((Get-Date) - $s).TotalSeconds
      $res.Add([PSCustomObject]@{ idx=$i; execId=$r.data.executionId; wfId=$r.data.workflowId; ok=$true; sec=[Math]::Round($el, 2) })
      $tim.Add($el)
    } catch {
      $el = ((Get-Date) - $s).TotalSeconds
      $res.Add([PSCustomObject]@{ idx=$i; execId=""; wfId=""; ok=$false; sec=[Math]::Round($el, 2); err=$_.Exception.Message.Substring(0, 80) })
    }
  }
  $body = @{ input = @{ prompt = "say hello" }; namespace = "default" } | ConvertTo-Json
  [void]$ps.AddScript($scriptBlock).AddArgument("http://localhost:3001/api/agents/$agentId/run").AddArgument($headers).AddArgument($body).AddArgument($i).AddArgument($results).AddArgument($timings)
  $runspaces += @{ ps=$ps; handle=$ps.BeginInvoke() }
}

# Monitor
$done = 0; $lastDone = -1
while ($done -lt $runspaces.Count) {
  $done = ($runspaces | Where-Object { $_.handle.IsCompleted }).Count
  if ($done -ne $lastDone) { Log "  $done / $TotalRuns started..." "DarkYellow"; $lastDone = $done }
  Start-Sleep 1
}

$totalTime = ((Get-Date) - $startTime).TotalSeconds
$pool.Close()

$all = $results.ToArray()
$good = ($all | Where-Object { $_.ok }).Count
$bad = ($all | Where-Object { -not $_.ok }).Count
$secs = $timings.ToArray()
$avg = if ($secs.Count -gt 0) { ($secs | Measure-Object -Average).Average } else { 0 }
$max = if ($secs.Count -gt 0) { ($secs | Measure-Object -Maximum).Maximum } else { 0 }

Log "`n=== RESULTS ===" "Cyan"
Log "Wall time: ${totalTime}s" "White"
Log "Started: $good / $TotalRuns | Failed: $bad" "White"
Log "Avg start: $([Math]::Round($avg, 3))s | Max: $([Math]::Round($max, 3))s" "White"
Log "Throughput: $([Math]::Round($TotalRuns / $totalTime, 2)) runs/s" "White"

if ($bad -gt 0) {
  Log "FAILURES:" "Red"
  $all | Where-Object { -not $_.ok } | ForEach-Object { Log "  #$($_.idx): $($_.err)" "Red" }
}

# Check completion
Log "`n=== COMPLETION (waiting 30s) ===" "Cyan"
Start-Sleep 30

$ok = 0; $fail = 0
foreach ($r in ($all | Where-Object { $_.ok })) {
  try {
    $json = docker exec enterprise-grade-agent-orchestration-platform-main-temporal-1 sh -c "temporal workflow describe --address 172.19.0.17:7233 --namespace egaop -w $($r.wfId) -o json" 2>&1
    $desc = $json | ConvertFrom-Json
    if ($desc.result.status -eq "SUCCEEDED") { $ok++ }
    else { $fail++; Log "  FAILED: $($r.wfId) - $($desc.result.status): $($desc.result.error)" "Red" }
  } catch { $fail++; Log "  QUERY ERR: $($r.wfId)" "DarkRed" }
}

$rate = if ($good -gt 0) { [Math]::Round(($ok / $good) * 100, 1) } else { 0 }
Log "Started: $good | Completed: $ok | Errors: $fail | Rate: ${rate}%" "Yellow"
Log "DONE" "Green"
