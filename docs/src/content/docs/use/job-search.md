---
title: Job search
description: Keep your CVs and job profile in Nod, switch the main CV, and see what stays private. This page describes a fork of Nod.
sidebar:
  order: 10
---

:::note
The job search is part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have it.
:::

The **Jobs** page holds your CVs, your job profile and your referral message templates. Nod uses them to check and score jobs with [career-ops](https://github.com/career-ops-hq/career-ops), which runs in Nod's [workspace](/use/workspace/).

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

## Who can change job records

| Change                                             | Who                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anything on the Jobs page                          | You. Your own edits need no check                                                                     |
| A CV's text, the profile, adding a CV, the main CV | Nod, only in work that started from your message, such as the conversion chat or a task you asked for |
| The PDF of a Word CV                               | Nod, in work you started or in a schedule                                                             |
| Invite limits and no-luck days                     | Nod, only when your words ask for exactly that change; otherwise it asks you to approve it            |

These records are your own private data, so most changes skip the [trust check](/trust/). Invite limits and no-luck days go through it like Nod's other settings, because they decide how much Nod does on its own later.

## What stays private

- Your CVs, profile and templates are saved in Nod's database on your computer, never in the code or on GitHub.
- Nod copies them as files into its workspace, under `shared/career-ops`, so career-ops can read them. Nod rewrites a file when its record changes and removes it when it no longer applies, for example when the main CV has no text yet.
- career-ops runs only scripts that don't call a model. Nod's model keys never enter the workspace.
- The job search doesn't need LinkedIn: jobs come from alert emails, links you share and company career pages. To make sure Nod never opens a website, add a rule in chat, such as "Never open linkedin.com, in the browser or with workspace scripts."
