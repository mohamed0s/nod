# This fork of Nod

This is a fork of [n8n-io/nod](https://github.com/n8n-io/nod), kept close to
upstream. It runs Nod from source on Windows and adds a few changes. The
`mine` branch holds them; `main` mirrors upstream.

## What's different

- **Each task is its own chat.** The web app has a chat list beside the main
  chat: **New chat**, **Main**, and one entry per task, grouped into Working,
  Needs you and Done.
  - A task chat shows only that task's messages, its live browser and its own
    Stop.
  - Typing in a task chat goes only to that task.
  - Finished chats stay in the list, so you can continue them later in the
    same session, or close them.
  - Memory, rules, Vault, files and schedules stay shared.
- **Job search.** A **Jobs** page keeps your CVs (one is the main CV), the
  job profile Nod drafts from it, and referral message templates. Nod checks
  and scores jobs with [career-ops](https://github.com/career-ops-hq/career-ops),
  installed in the workspace image. See the docs page
  [Job search](docs/src/content/docs/use/job-search.md).
- **Model fallback.** **Settings > Models** keeps up to three backup models.
  When the model in use is busy or unavailable (a rate limit, an overload, a
  timeout, a network or quota error), Nod retries it once, then continues the
  same request on each backup in order. Action checks start again on the backup
  so they never mix models, and the reply says which model was used. See
  [Backup models](docs/src/content/docs/connect/models.mdx#backup-models).
- **Private by default.** The installer turns off usage data
  (`NOD_ANALYTICS_ENABLED=false`) and conversation traces (`NOD_TRACES_URL=`).
- **One-command install on Windows,** with Nod starting at every sign-in.

## Credits

The job search uses [career-ops](https://github.com/career-ops-hq/career-ops)
by Santiago Fernández de Valderrama and contributors, under the MIT license.
The workspace image installs a pinned commit
(`abefa6dbdb57fd2971c0d24ec563f24de57477ca`, version 1.39.0) and checks its
SHA-256; see `jobs/workspace/install-career-ops.sh`. Its license is in
[NOTICE](NOTICE).

## Install on Windows 11

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installed and started once, [Git](https://git-scm.com/), and about 20 GB free.
The installer gets Node.js 24 and pnpm for you if they're missing.

```powershell
git clone https://github.com/mohamed0s/nod.git
cd nod
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

The installer:

1. **Checks Node.js and pnpm,** and installs them if they're missing.
2. **Starts Docker Desktop,** if it isn't running.
3. **Creates `.env`,** with a new Vault key and usage data and traces turned
   off.
4. **Starts Nod at every Windows sign-in,** through the scheduled task
   `\Nod\start`.
5. **Backs Nod up every night at 03:30,** through the scheduled task
   `\Nod\backup`.
   - **What's saved:** the database, the `.local` folder, and the browser and
     tools volumes.
   - **Where:** the `nod-backups` folder next to this one. The newest 14 are
     kept.
   - **Not saved:** the Vault key.
6. **Adds a `nod` desktop shortcut.**
7. **Starts Nod and opens it in your browser.** The first start builds four
   containers and can take 10 minutes or more.

**Save the `NOD_VAULT_KEY` line from `.env` in your password manager.** Saved
logins can't be read without it.

**Morning schedules while the PC sleeps (optional).** Add `-WakeAt 07:20` to
the install command. The scheduled task `\Nod\wake` then wakes the PC from
sleep at that time and keeps it awake for 90 minutes, starting Nod if it isn't
running. It can't wake a PC that's shut down, and wake timers must be allowed
in Windows' power options (they are by default).

## Day to day

| To                         | Do this                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| Open Nod                   | Double-click the `nod` shortcut, or go to `http://localhost:4310`           |
| Stop Nod                   | `powershell -File scripts\windows\stop.ps1`                                 |
| Start Nod again            | `Start-ScheduledTask -TaskPath '\Nod\' -TaskName start`, or sign out and in |
| Update                     | `powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1`       |
| See what happened at start | `.local\windows-start.log`                                                  |
| Back up now                | `powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1`       |
| Stop the morning wake      | `Unregister-ScheduledTask -TaskPath '\Nod\' -TaskName wake -Confirm:$false` |

## Troubleshooting

- **"Could not resolve host" or "no such host" during the first start.**
  Docker Desktop's built-in name lookup can drop requests on some networks.
  1. In Docker Desktop, open Settings > Docker Engine.
  2. Add `"dns": ["1.1.1.1", "8.8.8.8"]`.
  3. Apply and restart, then start Nod again.
- **C: is nearly full.** In Docker Desktop, open Settings > Resources >
  Advanced, and move the disk image location to another drive before the
  first start.
