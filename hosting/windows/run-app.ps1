# Runs the gensite Next.js production server on 127.0.0.1:3000 and restarts it if it exits.
# Started hidden at logon by the Task Scheduler task \gensite\gensite-app. Logs: <repo>\hosting\logs
$root = (Resolve-Path "$PSScriptRoot\..\..").Path   # the repo: <repo>\hosting\windows\<script>
$logDir = "$root\hosting\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source

while ($true) {
  Get-ChildItem $logDir -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Add-Content -Encoding utf8 "$logDir\runner.log" "[$stamp] app: starting next start on 127.0.0.1:3000"
  $p = Start-Process -FilePath $node -WorkingDirectory $root -NoNewWindow -PassThru -Wait `
    -ArgumentList "`"$root\node_modules\next\dist\bin\next`"", 'start', '-H', '127.0.0.1', '-p', '3000' `
    -RedirectStandardOutput "$logDir\app-$stamp.out.log" -RedirectStandardError "$logDir\app-$stamp.err.log"
  Add-Content -Encoding utf8 "$logDir\runner.log" "[$(Get-Date -Format 'yyyyMMdd-HHmmss')] app: exited with code $($p.ExitCode); restarting in 5s"
  Start-Sleep -Seconds 5
}
