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

Your first CV becomes the **main** CV. Nod scores jobs against it and sends it when it asks someone for a referral, unchanged:

| You uploaded | The PDF Nod sends                             |
| ------------ | --------------------------------------------- |
| A PDF        | The file you uploaded                         |
| A Word file  | The PDF Nod made once from that CV's own text |

To switch, select **Mark as main** on another CV, or tell Nod "make my _name_ CV the main one". Nod uses it from its next step on.

Nod tailors a CV only when it applies on a company's own application form, and always starts from the main CV. Scoring and referral requests never change your CV.

**Edit** changes a CV's name or its text. **Archive** takes a CV off the list; if it was the main CV, the most recently changed one becomes main.

## The profile

The **Profile** tab shows what Nod drafted from your main CV: the name and one-line introduction it uses in messages, your location, target roles, regions, languages, programmes and tracks, work authorization and links. It also holds how many invites a day and a week to send, and after how many days without an accepted invite or a reply a company counts as no luck.

Nothing here is required. Change a field and select **Save profile**, or tell Nod in chat.

## Message templates

The **Templates** tab has one referral message per language. Nod fills these placeholders for each person: `{greeting}`, `{first_name}`, `{company}`, `{programme}`, `{track}`, `{role}`, `{my_name}` and `{my_intro}`. A template with any other placeholder isn't saved. The examples are used until you save your own.

## What stays private

- Your CVs, profile and templates are saved in Nod's database on your computer, never in the code or on GitHub.
- Nod copies them as files into its workspace, under `shared/career-ops`, so career-ops can read them. That copy is replaced whenever they change.
- career-ops runs only scripts that don't call a model. Nod's model keys never enter the workspace.
- Nod never opens LinkedIn.
