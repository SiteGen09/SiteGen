# Manage the gensite host tasks.
#   .\manage.ps1 status     - task states, processes, local + public health
#   .\manage.ps1 stop       - stop app + tunnel (site goes offline); crons keep firing but fail harmlessly
#   .\manage.ps1 start      - start app + tunnel now
#   .\manage.ps1 restart    - stop then start (e.g. after `pnpm build`)
#   .\manage.ps1 logs       - tail the newest app/tunnel/cron logs
#   .\manage.ps1 disable    - stop the site AND keep it off (no start at logon, crons paused)
#   .\manage.ps1 enable     - undo disable: re-enable all tasks and start the site
#   .\manage.ps1 uninstall  - stop everything and remove all \gensite\ tasks
param([ValidateSet('status', 'stop', 'start', 'restart', 'logs', 'disable', 'enable', 'uninstall')][string]$Command = 'status')
$path = '\gensite\'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path   # the repo: <repo>\hosting\windows\<script>
$logDir = "$root\hosting\logs"

function Stop-Site {
  foreach ($t in 'gensite-app', 'gensite-tunnel') { Stop-ScheduledTask -TaskPath $path -TaskName $t -ErrorAction SilentlyContinue }
  # Task Scheduler ends the runner script; also end the server/tunnel processes it started.
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cloudflared.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'next\\dist\\bin\\next"? start -H 127\.0\.0\.1|tunnel run gensite|\\run-(app|tunnel)\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Start-Site { foreach ($t in 'gensite-app', 'gensite-tunnel') { Start-ScheduledTask -TaskPath $path -TaskName $t } }
function Show-Status {
  Get-ScheduledTask -TaskPath $path -ErrorAction SilentlyContinue | ForEach-Object {
    $i = $_ | Get-ScheduledTaskInfo
    '{0,-28} {1,-8} last={2} result={3} next={4}' -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime
  }
  foreach ($u in 'http://127.0.0.1:3000/healthz', 'https://gensite.tech/healthz') {
    try { '{0} -> {1}' -f $u, (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 10).Content } catch { '{0} -> DOWN ({1})' -f $u, $_.Exception.Message }
  }
}

switch ($Command) {
  'status'    { Show-Status }
  'stop'      { Stop-Site; 'stopped' }
  'start'     { Start-Site; Start-Sleep 8; Show-Status }
  'restart'   { Stop-Site; Start-Sleep 3; Start-Site; Start-Sleep 8; Show-Status }
  'logs'      { foreach ($pat in 'app-*.err.log', 'app-*.out.log', 'tunnel-*.err.log', 'cron-*.log', 'runner.log') {
                  $f = Get-ChildItem $logDir -Filter $pat -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
                  if ($f) { "===== $($f.Name)"; Get-Content $f.FullName -Tail 15 } } }
  'disable'   { Stop-Site; Get-ScheduledTask -TaskPath $path | Disable-ScheduledTask | Out-Null; Show-Status }
  'enable'    { Get-ScheduledTask -TaskPath $path | Enable-ScheduledTask | Out-Null; Start-Site; Start-Sleep 8; Show-Status }
  'uninstall' { Stop-Site; Get-ScheduledTask -TaskPath $path -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false; 'removed all \gensite\ tasks' }
}
