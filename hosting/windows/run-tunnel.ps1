# Runs the Cloudflare tunnel (gensite.tech -> 127.0.0.1:3000) and restarts it if it exits.
# Started hidden at logon by the Task Scheduler task \gensite\gensite-tunnel. Logs: <repo>\hosting\logs
$root = (Resolve-Path "$PSScriptRoot\..\..").Path   # the repo: <repo>\hosting\windows\<script>
$logDir = "$root\hosting\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

while ($true) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Add-Content -Encoding utf8 "$logDir\runner.log" "[$stamp] tunnel: starting cloudflared tunnel run gensite"
  $p = Start-Process -FilePath $cloudflared -NoNewWindow -PassThru -Wait -ArgumentList 'tunnel', 'run', 'gensite' `
    -RedirectStandardOutput "$logDir\tunnel-$stamp.out.log" -RedirectStandardError "$logDir\tunnel-$stamp.err.log"
  Add-Content -Encoding utf8 "$logDir\runner.log" "[$(Get-Date -Format 'yyyyMMdd-HHmmss')] tunnel: exited with code $($p.ExitCode); restarting in 10s"
  Start-Sleep -Seconds 10
}
