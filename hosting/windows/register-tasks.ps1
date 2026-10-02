# Registers the gensite Task Scheduler tasks for the current user (no admin needed).
# Tasks live in the Task Scheduler folder \gensite\ and run only while this user is logged on.
# Re-running this script updates the tasks in place.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot   # <repo>\hosting\windows
$path = '\gensite\'
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# conhost --headless keeps the scripts fully hidden (no window flashing every 2 minutes).
function Action([string]$script, [string]$extra = '') {
  New-ScheduledTaskAction -Execute 'conhost.exe' -WorkingDirectory $dir `
    -Argument "--headless powershell.exe -NoProfile -NonInteractive -File `"$dir\$script`" $extra".Trim()
}

$longRunning = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -Hidden
$cron = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -Hidden

$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
Register-ScheduledTask -TaskPath $path -TaskName 'gensite-app' -Force -Principal $principal -Settings $longRunning `
  -Trigger $logon -Action (Action 'run-app.ps1') -Description 'gensite.tech Next.js server on 127.0.0.1:3000 (auto-restart)' | Out-Null
Register-ScheduledTask -TaskPath $path -TaskName 'gensite-tunnel' -Force -Principal $principal -Settings $longRunning `
  -Trigger $logon -Action (Action 'run-tunnel.ps1') -Description 'cloudflared tunnel run gensite (auto-restart)' | Out-Null

$today = (Get-Date).Date
$every2m = New-ScheduledTaskTrigger -Once -At $today -RepetitionInterval (New-TimeSpan -Minutes 2)
$hourly = New-ScheduledTaskTrigger -Once -At $today.AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)
$daily = New-ScheduledTaskTrigger -Daily -At '01:00'   # 17:00 UTC, as in vercel.json
Register-ScheduledTask -TaskPath $path -TaskName 'gensite-cron-sweep-media' -Force -Principal $principal -Settings $cron `
  -Trigger $every2m -Action (Action 'run-cron.ps1' '-Job sweep-media') -Description 'GET /api/cron/sweep-media every 2 minutes' | Out-Null
Register-ScheduledTask -TaskPath $path -TaskName 'gensite-cron-probe-models' -Force -Principal $principal -Settings $cron `
  -Trigger $hourly -Action (Action 'run-cron.ps1' '-Job probe-models') -Description 'GET /api/cron/probe-models hourly (:05)' | Out-Null
Register-ScheduledTask -TaskPath $path -TaskName 'gensite-cron-reconcile' -Force -Principal $principal -Settings $cron `
  -Trigger $daily -Action (Action 'run-cron.ps1' '-Job reconcile') -Description 'GET /api/cron/reconcile daily 01:00 local (17:00 UTC)' | Out-Null

Get-ScheduledTask -TaskPath $path | Select-Object TaskName, State
