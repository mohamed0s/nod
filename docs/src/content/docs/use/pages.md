---
title: Pages
description: Keep the trackers, dashboards and reports Nod makes as pages you open from the sidebar, and let a schedule keep them current. This page describes a fork of Nod.
sidebar:
  order: 11
---

:::note
Pages are part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have them.
:::

The **Pages** tab keeps HTML pages Nod made for you, such as a tracker it refreshes every morning, a dashboard or a report you'll come back to. Nod updates the same page instead of sending a new file in chat each time, and each page keeps its last 10 versions.

## Ask for a page

Ask in chat, for example "make a page that tracks my reading list and update it every morning". Nod builds the page as one HTML file in its [workspace](/use/workspace/) and publishes it to **Pages**. When you ask for a change, Nod updates the same page.

A [schedule](/use/schedules/) that keeps a page current gathers fresh data on each run and publishes the page again. If nothing changed, the page gets no new version.

You can also keep an HTML file Nod shared in chat. Open the file, then select **Keep in Pages** in the file panel. Nod saves a copy as a new page, and **Open in Pages** takes you to it.

## The Pages tab

The list shows each page with when it was last updated and by which chat or schedule. Select a page to see it.

- **Open chat** or **Open schedules** goes to the chat or the schedules that publish the page.
- **History** lists the kept versions. **View** shows an earlier one, and **Make it the current version** brings it back as a new version. If Nod published a newer version since you opened the page, Nod doesn't change it and asks you to look at the new version first.
- **Rename** changes the page's name. A schedule that updates the page keeps your name.
- **Archive** takes a page off the list, under **Archived**. Nod can't update an archived page until you select **Unarchive**.
- **Delete** removes the page and its versions. Nod deletes their files at its next file cleanup, unless a chat message still shows them.

The list and the open page update by themselves when Nod publishes a new version.

## What a page can do

A page shows in the same sandbox as an HTML file in chat. Its scripts run apart from Nod, your sign-ins and your files.

- **No network.** A page can't load scripts, fonts, images or data from the internet, so Nod puts everything into the file. Charts drawn in the page work.
- **Read-only.** Forms don't submit, and nothing a page saves is kept.
- **Links.** Select a link to an `https://` address to open it in a new browser tab, or in your default browser in the desktop app. A link opens only when you click it: a page can't open a website by itself. Links within the page scroll to their place. Other links, such as email links, don't open. If a page tries to load a website in its place, Nod stops showing it.
- **Light and dark.** Pages follow your computer's light or dark setting.

## Who can change pages

| Change                    | Who                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything on the Pages tab | You                                                                                                                                                                                                                                          |
| Make or update a page     | Nod, in work that started from your message, such as a chat or a task you asked for, and in your schedules. Never in work started by an app event or by Nod's own [proactive checks](/how-it-works/proactivity/), and never in helper agents |
| Read a page               | Nod, including helper agents. Nod's proactive checks can't use pages                                                                                                                                                                         |

Pages are your own private records, so publishing one skips the [trust check](/trust/). A page grants no permission: Nod treats what it shows as data, like any other content.

## What stays private

- Pages are saved in Nod's database and file storage on the computer that runs Nod, never in the code or on GitHub.
- Nod's guide for pages tells it never to put passwords, codes, card details or keys in a page.

## Related resources

- [Schedules](/use/schedules/)
- [Workspace](/use/workspace/)
- [Untrusted content](/trust/untrusted-content/)
