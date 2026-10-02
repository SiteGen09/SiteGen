# Calls one gensite cron endpoint on the local server with the CRON_SECRET bearer token.
# Used by the Task Scheduler tasks \gensite\gensite-cron-*. Appends one line per run to <repo>\hosting\logs\cron-<date>.log.
param([Parameter(Mandatory)][ValidateSet('sweep-media', 'probe-models', 'reconcile')][string]$Job)

$root = (Resolve-Path "$PSScriptRoot\..\..").Path   # the repo: <repo>\hosting\windows\<script>
$logDir = "$root\hosting\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = "$logDir\cron-$(Get-Date -Format 'yyyyMMdd').log"
if ($Job -eq 'reconcile') {
  # Daily log retention: keep 14 days of app/tunnel/cron logs.
  Get-ChildItem $logDir -File | Where-Object { $_.Name -ne 'runner.log' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
}

$line = Get-Content -LiteralPath "$root\.env.local" | Where-Object { $_ -match '^CRON_SECRET=' } | Select-Object -First 1
$secret = ($line -replace '^CRON_SECRET=', '').Trim().Trim('"').Trim("'")
if (-not $secret) { Add-Content -Encoding utf8 $log "[$(Get-Date -Format s)] $Job FAILED: CRON_SECRET missing in .env.local"; exit 1 }

$started = Get-Date
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/cron/$Job" -Headers @{ Authorization = "Bearer $secret" } -UseBasicParsing -TimeoutSec 330
  $body = $r.Content; if ($body.Length -gt 400) { $body = $body.Substring(0, 400) + '...' }
  Add-Content -Encoding utf8 $log "[$(Get-Date -Format s)] $Job $($r.StatusCode) in $([int]((Get-Date) - $started).TotalSeconds)s $body"
  exit 0
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'no-response' }
  Add-Content -Encoding utf8 $log "[$(Get-Date -Format s)] $Job FAILED ($status) in $([int]((Get-Date) - $started).TotalSeconds)s: $($_.Exception.Message)"
  exit 1
}
