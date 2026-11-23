# Nod, with task chats and job search

[![Fork of n8n-io/nod](https://img.shields.io/badge/fork_of-n8n--io%2Fnod-ff91ac?style=flat-square&labelColor=191919&logo=github)](https://github.com/n8n-io/nod)
[![Fork release](https://img.shields.io/github/v/release/mohamed0s/nod?style=flat-square&labelColor=191919&color=ff91ac&label=fork%20release)](https://github.com/mohamed0s/nod/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-ff91ac?style=flat-square&labelColor=191919)](https://github.com/mohamed0s/nod/blob/mine/LICENSE)

A community fork of [Nod](https://github.com/n8n-io/nod), the open source personal agent from the team behind n8n. Nod has its own computer and browser, runs errands on real websites, runs on your machine with the model you choose, and asks before it acts for you.

This fork follows n8n's `main` closely and adds a few changes on top. Everything else works as in n8n's Nod, so [n8n's README](https://github.com/n8n-io/nod#readme) and the [Nod docs](https://nod.n8n.io/docs/) cover it.

> [!NOTE]
> This fork isn't made or supported by n8n. Before you report a bug to n8n, check that it also happens in [n8n's own Nod](https://github.com/n8n-io/nod/releases/latest).

## What this fork adds

| Change                        | What you get                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Each task is its own chat** | A chat list beside **Main**, with **New chat** and one chat per task, grouped into Working, Needs you and Done. A task chat shows only its own messages, live browser and Stop, and sees only its own history. Rename or close any chat. On Telegram, each task gets its own topic. Memory, rules, Vault, files and schedules stay shared. [Tasks](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/use/tasks.md) · [Telegram topics](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/use/channels.mdx#telegram-topics) |
| **Job search**                | A **Jobs** page keeps your CVs (one marked main), the job profile Nod drafts from it, and your referral message templates, with right-to-left text and morning and evening greetings. Nod scores jobs with [career-ops](https://github.com/career-ops-hq/career-ops), installed in the workspace image. [Job search](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/use/job-search.md)                                                                                                                                                 |
| **Windows, from source**      | One install script, for the source run or the desktop app run from your checkout. Nod starts at every Windows sign-in, backs itself up every night, can wake the PC for morning schedules, and takes n8n's updates with one command.                                                                                                                                                                                                                                                                                                                     |
| **Windows installer**         | A GitHub Actions workflow builds and publishes a Windows installer each time the fork takes in an n8n release. Apps installed from it update themselves from this fork's releases, never from n8n's.                                                                                                                                                                                                                                                                                                                                                     |
| **Live desktop development**  | `pnpm run desktop:dev` runs the desktop app from your checkout and follows your edits: web changes are rebuilt and the window reloads, and server changes restart the engine behind the open window once no reply or task is running. The terminal says when a change needs a new runtime or an app restart. [Edit while it runs](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/deploy/desktop-app.mdx#edit-while-it-runs)                                                                                                            |
| **Private by default**        | The Windows install script turns off usage data (`NOD_ANALYTICS_ENABLED=false`) and conversation traces (`NOD_TRACES_URL=`) for the source run. The desktop app run from your checkout sends no usage data either.                                                                                                                                                                                                                                                                                                                                       |

## Install

### Windows app

Download [nod-Setup-x64.exe](https://github.com/mohamed0s/nod/releases/latest/download/nod-Setup-x64.exe) from this fork's [latest release](https://github.com/mohamed0s/nod/releases/latest). It needs Windows 11 x64, WSL 2 and 20 GB of free disk space. The installer isn't code-signed, so Windows SmartScreen asks you to confirm it once.

After that, the app updates itself from this fork's releases, the way n8n's app updates from n8n's. It checks when it starts and every six hours, downloads the new installer in the background, checks it against the release's SHA-256, and offers **Restart to update**. A new release follows each n8n release the fork takes in, so releases can trail the `mine` branch. Each person's data stays on their own computer.

The first release, 0.9.1, can't update itself: it downloads each new installer and refuses it, again and again. If you installed it, install the latest release by hand once.

### From source on Windows 11

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and started once, [Git](https://git-scm.com/), and about 20 GB free. The install script gets Node.js 24 and pnpm if they're missing.

```powershell
git clone https://github.com/mohamed0s/nod.git
cd nod
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

The script:

1. **Checks Node.js and pnpm,** and installs them if they're missing.
2. **Starts Docker Desktop,** if it isn't running.
3. **Creates `.env`,** with a new Vault key and usage data and traces turned off.
4. **Starts Nod at every Windows sign-in,** through the scheduled task `\Nod\start`.
5. **Backs Nod up every night at 03:30,** through the scheduled task `\Nod\backup`. It saves the database, the `.local` folder, and the browser and tools volumes into the `nod-backups` folder next to this one, and keeps the newest 14 (a failed one gets `-failed` added to its folder name and never pushes good ones out). The Vault key isn't saved.
6. **Adds a `nod` desktop shortcut.**
7. **Starts Nod and opens it in your browser.** The first start builds four containers and can take 10 minutes or more.

**Save the `NOD_VAULT_KEY` line from `.env` in your password manager.** Saved logins can't be read without it.

**Morning schedules while the PC sleeps (optional).** Add `-WakeAt 07:20` to the install command. The scheduled task `\Nod\wake` then wakes the PC from sleep at that time and keeps it awake for 90 minutes, starting Nod if it isn't running. It can't wake a PC that's shut down, and wake timers must be allowed in Windows' power options (they are by default).

### From source as the desktop app on Windows 11

This runs the desktop app from your checkout (`pnpm run desktop:dev`) instead of the source run. You get computer use, Nod's own window and tray icon, and it [follows your edits while it runs](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/deploy/desktop-app.mdx#edit-while-it-runs). You need WSL 2, [Git](https://git-scm.com/), and the Windows runtime in the checkout's `windows-runtime` folder (`manifest.json`, `guest.tar.gz` and `bin\docker.exe`, the same files an installed app keeps in `resources\engine\windows-runtime`). Docker Desktop isn't needed.

Pick a profile folder and always give it as the same text. It holds the app's profile, and Nod's private computer is a WSL distribution named after it. Run the script from the checkout the app should run from:

```powershell
git clone https://github.com/mohamed0s/nod.git
cd nod
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -Desktop D:\Nod\desktop
```

The script:

1. **Checks Node.js and pnpm,** and installs them if they're missing.
2. **Gives your Windows user full control of the profile folder.** The app needs it on drives where users only have Modify.
3. **Installs the packages and Electron, and builds the web app once.** Electron's download cache goes in `electron-cache` next to the checkout, so it stays on the same drive.
4. **Starts the app at every Windows sign-in,** through `\Nod\start`, which runs `scripts\windows\desktop-start.ps1`. Each start installs packages again only when a lockfile changed, and logs to `desktop-start.log` in the profile folder.
5. **Backs it up every night at 03:30,** through `\Nod\backup`. It saves the database, the workspace, tools and browser volumes, and the profile files (sessions, Pi settings, attachments, the app identity, `settings.json`, `profile.json` and preferences) into `nod-backups` next to the checkout, and keeps the newest 14. It works while Nod is open. A backup that fails keeps its folder with `-failed` added to the name, so you can read its `backup.log`; failed ones never push good ones out. Only your Windows user, SYSTEM and Administrators can open a backup, and each one has a `README.txt` that says what's inside.
6. **Adds a `Nod` desktop shortcut** in place of the `nod` one. It starts Nod, or shows it if it's running.
7. **Starts Nod.** If it's already running from that folder, it keeps running.

The app keeps its own Vault key in `settings.json`, protected by your Windows user, so the script creates no `.env`. `-WakeAt 07:20` works as above. Leave **Open at login** off in Nod's settings: the scheduled task starts it. To bring your source install's chats, logins and files along first, see [Move a source install into the desktop app](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/deploy/move-to-desktop.mdx).

### From source on macOS or Linux

The fork's changes aren't tied to Windows, but the fork is only tested there, and the Windows scripts don't apply. Follow n8n's [Install from source](https://nod.n8n.io/docs/get-started/install-from-source/) with this fork's address:

```sh
git clone https://github.com/mohamed0s/nod.git
cd nod
corepack enable
pnpm start
```

## Day to day on Windows

| To                         | Source run                                                                  | Desktop app                                                                                         |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Open Nod                   | Double-click the `nod` shortcut, or go to `http://localhost:4310`           | Double-click the `Nod` shortcut, or click Nod's tray icon                                           |
| Stop Nod                   | `powershell -File scripts\windows\stop.ps1`                                 | **Quit Nod** in the tray menu. `stop.ps1` asks Nod to quit the same way and never force-closes it   |
| Start Nod again            | `Start-ScheduledTask -TaskPath '\Nod\' -TaskName start`, or sign out and in | The `Nod` shortcut, the same task, or sign out and in                                               |
| Get n8n's latest changes   | `powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1`       | The same. Nod keeps running and follows the change; the script says when to quit and start it again |
| See what happened at start | `.local\windows-start.log`                                                  | `desktop-start.log` in the profile folder (the one before is `desktop-start.prev.log`)              |
| Back up now                | `powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1`       | `powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1 -Desktop D:\Nod\desktop`       |
| Stop the morning wake      | `Unregister-ScheduledTask -TaskPath '\Nod\' -TaskName wake -Confirm:$false` | The same                                                                                            |

## How this fork stays in step with n8n

```mermaid
flowchart LR
  up["n8n-io/nod<br/>main"] -- "mirrored" --> main["main"]
  up -- "merged, never rebased" --> mine["mine (default branch)<br/>n8n's Nod + this fork's changes"]
```

- **`main`** is an exact copy of n8n's `main`.
- **`mine`**, the default branch, is n8n's Nod plus this fork's changes, one small commit per change.
- **n8n's updates are merged into `mine`, never rebased,** so its history is never rewritten and `git pull` always works.
- **`scripts\windows\update.ps1` does it all:** it stops Nod, merges n8n's latest `main`, pushes both branches to your GitHub copy if you have one, and starts Nod again. If n8n's changes clash with the fork's, it changes nothing and says so. With the desktop app it leaves Nod running, because the app follows server and web changes by itself, and it says when a package, desktop app or runtime change needs a restart.
- **Changes that could help everyone are offered to n8n.** Backup models ([#1361](https://github.com/n8n-io/nod/pull/1361)) started in this fork and are now part of n8n's Nod.

## Build a Windows installer

n8n's own release workflow runs only in n8n's repository: it needs their paid build machines and signing keys. This fork has its own, **Fork Windows release**, and it runs by itself.

1. **Each n8n release starts it.** n8n marks a release by changing `desktop/release.json`. When `scripts\windows\update.ps1` pushes a merge that changes it to `mine`, the workflow builds a release from `mine`. If the fork already has a release for that n8n version, it builds nothing and says which release covers it.
2. **Versions follow n8n's, a step above them.** n8n's 0.9.1 becomes 0.9.200, and another build of it 0.9.201. n8n's 0.9.2 becomes 0.9.300, and n8n's 0.10.0 becomes 0.10.100. A version is never one of n8n's own, and the run stops with an error if it can't pick one.
3. **It builds and checks the installer** on GitHub's machines, then publishes `nod-v<version>` as the fork's latest release. The runtime, about 1.5 GB, is rebuilt when its inputs change and by the first build of each week (from Monday, UTC). Otherwise it's copied from an earlier release, so installed apps download only the new installer. If the copied runtime fails its checks, the run builds a fresh one.
4. **To build one by hand**, open **Actions → Fork Windows release → Run workflow**. It runs only on `mine`. Leave the version empty to number it as above, or enter one in the same range for the current n8n version (0.9.200 to 0.9.299 for n8n's 0.9.1) that's higher than every `nod-v` tag on the fork.

Runs never overlap. A new run waits for the running one, and a newer waiting run replaces an older one. To share a build, send the release link.

The installers aren't code-signed, so installed apps trust this fork's GitHub releases. Each installer's SHA-256 is checked against the release, which protects the download on its way to the PC, and an installer with a broken signature or another publisher's is still refused. But anyone who can publish a release on this fork can ship code to every install. Signing with a key kept in a protected GitHub environment that needs a reviewer's approval would separate uploading a file from shipping code; this fork accepts not having that. See [How installed apps update](https://github.com/mohamed0s/nod/blob/mine/docs/src/content/docs/contribute/desktop-releases.mdx#how-installed-apps-update).

## Troubleshooting

- **"Could not resolve host" or "no such host" during the first start.** Docker Desktop's built-in name lookup can drop requests on some networks.
  1. In Docker Desktop, open **Settings → Docker Engine**.
  2. Add `"dns": ["1.1.1.1", "8.8.8.8"]`.
  3. Apply and restart, then start Nod again.
- **C: is nearly full.** In Docker Desktop, open **Settings → Resources → Advanced**, and move the disk image location to another drive before the first start.

## Credits and license

Nod is made by [n8n](https://n8n.io) and licensed under the [Apache License 2.0](https://github.com/mohamed0s/nod/blob/mine/LICENSE). This fork's changes use the same license. Bundled third-party terms are in [NOTICE](https://github.com/mohamed0s/nod/blob/mine/NOTICE).

The job search uses [career-ops](https://github.com/career-ops-hq/career-ops) by Santiago Fernández de Valderrama and contributors, under the MIT license. The workspace image installs a pinned commit (`abefa6dbdb57fd2971c0d24ec563f24de57477ca`, version 1.39.0) and checks its SHA-256; see [`install-career-ops.sh`](https://github.com/mohamed0s/nod/blob/mine/jobs/workspace/install-career-ops.sh).

This fork isn't affiliated with or endorsed by n8n GmbH.
