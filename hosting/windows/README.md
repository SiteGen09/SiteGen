# gensite.tech hosting on this PC

The site is gensite.tech, served through a Cloudflare tunnel to a local Next.js server on 127.0.0.1:3000, using the hosted Supabase Asia project.
Everything runs from Task Scheduler (folder `\gensite\`) as the logged-in user. No admin rights are needed and no windows appear.

| Task | Runs | What |
|---|---|---|
| gensite-app | at logon, auto-restart | `run-app.ps1`: `next start -H 127.0.0.1 -p 3000` in E:\sitegen; restarts 5 s after any exit |
| gensite-tunnel | at logon, auto-restart | `run-tunnel.ps1`: `cloudflared tunnel run gensite`; restarts 10 s after any exit |
| gensite-cron-sweep-media | every 2 min | GET /api/cron/sweep-media |
| gensite-cron-probe-models | hourly at :05 | GET /api/cron/probe-models (~53 tiny upstream probes per run) |
| gensite-cron-reconcile | daily 01:00 (17:00 UTC) | GET /api/cron/reconcile (reclaims stuck holds, syncs Whop); also prunes logs older than 14 days |

The cron scripts read CRON_SECRET from E:\sitegen\.env.local at run time. No secret is stored in the tasks.

## Everyday commands (PowerShell)
    E:\sitegen\hosting\windows\manage.ps1 status      # tasks, next runs, local + public health
    E:\sitegen\hosting\windows\manage.ps1 logs        # newest app / tunnel / cron logs
    E:\sitegen\hosting\windows\manage.ps1 restart     # after a new build: cd E:\sitegen; pnpm build; then restart
    E:\sitegen\hosting\windows\manage.ps1 stop        # take the site offline until next logon
    E:\sitegen\hosting\windows\manage.ps1 disable     # take it offline and keep it off (no start at logon, crons paused)
    E:\sitegen\hosting\windows\manage.ps1 enable      # undo disable
    E:\sitegen\hosting\windows\manage.ps1 start
    E:\sitegen\hosting\windows\manage.ps1 uninstall   # stop and remove all \gensite\ tasks
    E:\sitegen\hosting\windows\register-tasks.ps1  # (re)create the tasks

Disable only the hourly probe: `Disable-ScheduledTask -TaskPath '\gensite\' -TaskName gensite-cron-probe-models`

## Limits of this setup
- The tasks run only while this Windows user is logged on. After a reboot, log in and the site starts on its own.
- On AC power the PC never sleeps; on battery it sleeps after 10 minutes, and sleep takes the site offline.
- Logs: E:\sitegen\hosting\logs (runner.log, app-*.out/err.log, tunnel-*.err.log, cron-YYYYMMDD.log).

## Layout
Everything lives in the repo folder E:\sitegen. The scripts find the repo from their own location, so the folder can be moved: re-run `register-tasks.ps1` from the new place, then `manage.ps1 restart`.

| Path | In git | What |
|---|---|---|
| `hosting\windows\` | yes | these scripts |
| `hosting\logs\` | no (ignored) | runtime logs, pruned after 14 days |
| `hostingackups\` | no (ignored) | one-off backups and migration reports; may hold secrets |

`git clean -x` deletes ignored folders, logs and backups included. Do not run it here.
