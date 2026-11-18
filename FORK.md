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
- **Private by default.** The installer turns off usage data
  (`NOD_ANALYTICS_ENABLED=false`) and conversation traces (`NOD_TRACES_URL=`).
- **One-command install on Windows,** with Nod starting at every sign-in.

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

## Day to day

| To                         | Do this                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| Open Nod                   | Double-click the `nod` shortcut, or go to `http://localhost:4310`           |
| Stop Nod                   | `powershell -File scripts\windows\stop.ps1`                                 |
| Start Nod again            | `Start-ScheduledTask -TaskPath '\Nod\' -TaskName start`, or sign out and in |
| Update                     | `powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1`       |
| See what happened at start | `.local\windows-start.log`                                                  |
| Back up now                | `powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1`       |

## Troubleshooting

- **"Could not resolve host" or "no such host" during the first start.**
  Docker Desktop's built-in name lookup can drop requests on some networks.
  1. In Docker Desktop, open Settings > Docker Engine.
  2. Add `"dns": ["1.1.1.1", "8.8.8.8"]`.
  3. Apply and restart, then start Nod again.
- **C: is nearly full.** In Docker Desktop, open Settings > Resources >
  Advanced, and move the disk image location to another drive before the
  first start.
