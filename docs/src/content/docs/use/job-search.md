---
title: Job search
description: Keep your CVs and job profile in Nod, find and score jobs from scans, Telegram channels and alert emails, and see what stays private. This page describes a fork of Nod.
sidebar:
  order: 10
---

:::note
The job search is part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have it.
:::

The **Jobs** page holds the jobs Nod found for you, your CVs, your job profile, your referral message templates and the sources Nod looks in. Nod uses them to find, check and score jobs with [career-ops](https://github.com/career-ops-hq/career-ops), which runs in Nod's [workspace](/use/workspace/).

## Add a CV

1. Open **Jobs** in the sidebar.
2. On the **CVs** tab, select **Add a CV** and choose a PDF or Word (`.docx`) file.

Nod saves the file and opens a new chat, **Convert the CV I just added for job search**, with the file attached. In that chat Nod:

1. reads the text and saves it as the CV's text (Markdown);
2. for a Word file, makes a PDF from that text;
3. drafts your job profile from the CV;
4. asks you at most one short question, only for something it can't tell from the CV.

You can also send a CV from your phone: attach it in chat or Telegram and say it's a CV. Nod adds it to the same list.

## The main CV

Your first CV becomes the **main** CV. Nod scores jobs against it and sends it, unchanged, when it asks someone for a referral:

| You uploaded | The PDF Nod sends                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------- |
| A PDF        | The file you uploaded, even after you edit the CV's text                                          |
| A Word file  | The PDF Nod made from the CV's current text. When the text changes, Nod makes the PDF again first |

To switch, select **Mark as main** on another CV, or tell Nod "make my _name_ CV the main one". Nod uses it from its next step on.

Nod tailors a CV only when it applies on a company's own application form, and always starts from the main CV. Scoring and referral requests never change your CV.

## Edit, archive and delete

- **Edit** changes a CV's name or its text. If Nod saves a newer version while you're editing, the card says so, and your edit is kept until you save or load the newer version.
- **History** lists the last 20 versions of a CV's text, from you or from Nod. **Restore** brings one back as a new version. The **Profile** tab has the same for the profile.
- **Archive** takes a CV off the list and keeps its files. If it was the main CV, the most recently changed one becomes main.
- **Delete** removes the CV and its history. Nod deletes its uploaded file and PDF at its next file cleanup, unless a chat message still shows them.

## The profile

The **Profile** tab shows what Nod drafted from your main CV: the name and one-line introduction it uses in messages, your location, target roles, regions, languages, programmes and tracks, work authorization and links. It also holds how many invites a day and a week to send, and after how many days without an accepted invite or a reply a company counts as no luck.

Nothing here is required. Change a field and select **Save profile**, or tell Nod in chat. If the profile changed since you opened it, Nod doesn't save your version and asks you to reload it.

## Message templates

The **Templates** tab has one referral message per language. Pick the language from the list, or **Other language** to type a tag such as `pt-BR`. Arabic and other right-to-left languages are shown right to left.

Nod fills these placeholders for each person: `{greeting}`, `{first_name}`, `{company}`, `{programme}`, `{track}`, `{role}`, `{my_name}` and `{my_intro}`. Select a field under the message to insert it where the cursor is. A template with any other placeholder isn't saved.

`{greeting}` comes from the template's greetings: the morning one before noon and the evening one after, in your time zone, or **Any time** when that one is empty.

The examples are used until you save your own.

## Where jobs come from

Nod looks for jobs in the sources that are on, on the **Sources** tab:

| Source                              | How Nod reads it                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company career sites and job boards | career-ops scans the companies you follow and a few remote job boards through their public APIs, such as Greenhouse, Lever and Ashby. Your target roles and regions decide which postings it keeps |
| Weekly sweep (off at first)         | career-ops reads every company that Greenhouse, Lever and Ashby list publicly, once a week                                                                                                         |
| Telegram channels                   | Nod reads the public web preview of each channel you add (`t.me/s/<channel>`), without signing in, and remembers the last post it read                                                             |
| Job-alert emails                    | When your Gmail is connected, Nod reads recent job alerts and takes the title, company, place and link from each one, without reading the email out to the model                                   |
| Boards without an API               | Nod's own browser, signed out, on search result pages only                                                                                                                                         |

The same job from two sources shows once, with both sources: Nod matches postings by their link and by company, title and place.

When a posting's link is on a site your rules tell Nod to avoid, Nod doesn't open it. It looks for the same job on the company's own careers page instead, and otherwise scores it from what the alert says.

## The Job radar

When Nod drafts your profile, it offers the **Job radar** once: every morning at 07:30 in your time zone it looks in every source that is on, gives each new posting a short check, fully scores the five best, and sends you one short message with the new jobs worth a look, each with its score, company, title and link. When nothing new is worth a look, it sends nothing. It's a normal schedule, so you can change or pause it on the **Scheduled** page.

Nod also suggests a few public Telegram job channels for your regions and roles. It saves only the ones you accept.

## Postings

The **Postings** tab lists the jobs Nod found, best score first. Filter by status (new, shortlisted, skipped or all), score and source. Each posting shows its score (a short check, or **full** for a full score), Nod's one-line reason and where it came from. Its title opens the job in a new tab.

Select **Shortlist** or **Skip**, or **Back to new**. Your choice stays: the Job radar changes the status of new postings only. If a posting changed since you loaded the list, Nod doesn't save your change and asks you to reload.

## Sources

The **Sources** tab lists your Telegram channels, with when Nod last read each one and why a read failed, and which scanners are on. Add a channel by its name, `@name` or `t.me` link, turn one off, or remove it. Scanner switches take effect from Nod's next run: the Job radar and other scheduled work never import from a source that is off.

## Who can change job records

| Change                                             | Who                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anything on the Jobs page                          | You. Your own edits need no check                                                                     |
| A CV's text, the profile, adding a CV, the main CV | Nod, only in work that started from your message, such as the conversion chat or a task you asked for |
| The PDF of a Word CV                               | Nod, in work you started or in a schedule                                                             |
| Invite limits and no-luck days                     | Nod, only when your words ask for exactly that change; otherwise it asks you to approve it            |
| Adding postings, their scores and their status     | Nod, in work you started or in a schedule. A schedule changes the status of new postings only         |
| Telegram channels and scanner switches             | Nod, only in work that started from your message                                                      |

These records are your own private data, so most changes skip the [trust check](/trust/). Invite limits and no-luck days go through it like Nod's other settings, because they decide how much Nod does on its own later.

## What stays private

- Your CVs, profile and templates are saved in Nod's database on your computer, never in the code or on GitHub.
- Nod copies them as files into its workspace, under `shared/career-ops`, so career-ops can read them. Nod rewrites a file when its record changes and removes it when it no longer applies, for example when the main CV has no text yet.
- career-ops runs only scripts that don't call a model. Nod's model keys never enter the workspace. Its scans run without the options that open posting pages in a browser.
- Your postings, channels and switches are saved in Nod's database too. Nod's server reads Telegram channels and parses alert emails itself; the links in alerts are saved, never opened to import them.
- The job search doesn't need LinkedIn: jobs come from scans, Telegram channels, alert emails, links you share and company career pages. To make sure Nod never opens a website, add a rule in chat, such as "Never open linkedin.com, in the browser or with workspace scripts."
