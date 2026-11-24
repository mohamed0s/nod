---
title: Job search
description: Keep your CVs and job profile in Nod, find and score jobs from scans, Telegram channels and alert emails, follow the companies and the people you invited, get a referral message for each accept, pace invites in waves, pair a browser helper, mark a company no luck, and see what stays private. This page describes a fork of Nod.
sidebar:
  order: 10
---

:::note
The job search is part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have it.
:::

The **Jobs** page holds the jobs Nod found for you, the companies behind them and the people you invited there, your CVs, your job profile, your referral message templates, the sources Nod looks in and the browser helpers you paired. Nod uses them to find, check and score jobs with [career-ops](https://github.com/career-ops-hq/career-ops), which runs in Nod's [workspace](/use/workspace/).

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

The **Profile** tab shows what Nod drafted from your main CV: the name and one-line introduction it uses in messages, your location, target roles, regions, languages, programmes and tracks, work authorization and links. It also holds how many invites a day and a week to send, after how many days without an accepted invite or a reply someone has had their chance, and the [waves](#waves-and-limits): how many people to invite at a company at a time, and at most.

Nothing here is required. Change a field and select **Save profile**, or tell Nod in chat. If the profile changed since you opened it, Nod doesn't save your version and asks you to reload it.

## Message templates

The **Templates** tab has one referral message per language. Pick the language from the list, or **Other language** to type a tag such as `pt-BR`. Arabic and other right-to-left languages are shown right to left.

Nod fills these placeholders for each person: `{greeting}`, `{first_name}`, `{company}`, `{programme}`, `{track}`, `{role}`, `{my_name}` and `{my_intro}`. Select a field under the message to insert it where the cursor is. A template with any other placeholder isn't saved.

`{greeting}` comes from the template's greetings, by the time in your time zone when the message is shown: **Morning** from 5:00 to 11:59, **Afternoon** from 12:00 to 16:59 and **Evening** from 17:00 to 4:59, or **Any time** when that one is empty.

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

## Companies and people

The **Companies** tab lists each company with open postings or people, with its best score and how many people you invited, how many accepted, how many you asked for a referral and how many replied. Every posting joins its company by name, so "Example Co" and "Example Co, Inc." are one company. A posting whose company is hidden, such as "Confidential" or "N/A", joins no company.

Filter the list:

| Filter                  | Shows companies where                                           |
| ----------------------- | --------------------------------------------------------------- |
| Waiting for an accept   | someone you invited hasn't accepted yet                         |
| Accepted, not asked yet | someone accepted and you haven't asked them yet                 |
| Asked, no reply         | someone you asked hasn't replied yet                            |
| Next wave               | its next [wave](#waves-and-limits) of invites can start         |
| No luck                 | you ticked **No luck, apply here**, or Nod counts it as no luck |

Select a company to see its people and postings. Each person shows their status and when it changed, **Open profile** and, once Nod knows their LinkedIn member ID, **Message**. Both open LinkedIn in a new tab for you; Nod itself never opens them. Change a person's status from the list next to them, for example to **Asked** after you send your request. Under a person who accepted is their [referral message](#referral-messages). Each company also shows its [wave](#waves-and-limits), and the list shows today's and this week's invites against your limits.

### Tell Nod who you invited

You invite people on LinkedIn yourself. A [paired browser helper](#a-paired-browser-helper) can log them as you go. Without one, tell Nod in chat or Telegram, for example "I invited Sam Example at Example Co" with their profile link, or share a profile from the LinkedIn app to Nod on Telegram and add "Sent". Nod saves them as invited under that company. Say when someone accepts, when you ask them, and when they reply or refer you, and Nod updates them.

### Referral messages

When someone you invited accepts, Nod prepares the message you send them, by itself:

1. **It fills your template without a model.** `{first_name}` is the first word of their name, `{company}` the company, `{my_name}` and `{my_intro}` come from your profile. `{programme}`, `{track}` and `{role}` come, in this order, from what you told Nod in chat, the posting you named, the company's best-scored open posting that has them (its title is the role), and your profile when it has exactly one programme (with exactly one track) or one target role. `{greeting}` stays as it is and is filled in for the time of day whenever the message is shown. When something the template uses has no value, Nod saves no message and says what it needs; tell Nod in chat, or add it and select **Make it**.
2. **The language** is the one you chose for that person, otherwise the one Nod guesses from their profile through **Language by country** on the **Profile** tab, otherwise your default message language. Nod uses the template for that exact language, then its base language (`ar` for `ar-EG`), then your default language's template.
3. **Nod's small model tailors it once.** It gets your filled-in message, in each language you have a template for when you haven't chosen one, and the person's name, headline and company as data, never as instructions; their first name and company inside your message count as data too. It may change only what fits this person, such as Arabic gender agreement, the form of their name or the spacing around the greeting. It keeps your words, facts, order and length, invents nothing about you or them, and adds no claim, flattery or request. It also writes one or two sentences on what it changed and why. Nod sets its version aside, and keeps your template filled in, when it picks a language you have no template for, leaves a field such as `{company}` in, drops the greeting, adds anything your message didn't have that looks like a link, a web or email address, a handle or a phone number (including formatted links), or makes the message much longer or shorter; the message says why. The same happens when the model fails or none is set up. This runs in the background, a few at a time, and each request shows in **Usage** like Nod's other small model requests.
4. **Nod tells you once** on Telegram or WhatsApp, in the chat where you last wrote to Nod (the main chat, not a task's topic): who accepted at which company, **Open profile** and, when Nod knows their member ID, **Message**, and the message ready to paste. The message comes as a code block, exactly as saved, so tapping it copies it on Telegram; when it can't arrive in one piece, Nod asks you to copy it from the **Companies** tab instead. For your first 10 messages it adds what it changed and why. You get one message per accept, even when a helper, the connections list and a chat message report the same accept at once. When Nod couldn't fill the message at first, it says what it needs, and sends the message itself once more when it's made. It reaches you only after you've written to Nod there at least once, and on WhatsApp only within 24 hours of your last WhatsApp message to Nod. It sends nothing to the person: you paste the message on LinkedIn yourself and attach your main CV.

Replying to that message on Telegram or WhatsApp starts a new message to Nod; it doesn't answer anything Nod asked before. A bare "yes" sent after it doesn't approve an earlier question either: answer that question by replying to it.

On the **Companies** tab, each message shows its state (template filled in, tailoring, tailored, not tailored, edited or needs details), with **Copy**, **Edit**, **Remake** and the **Language** list. **Edit** saves your own version; Nod never replaces it by itself, and a tailoring that finishes after your edit is dropped. **Remake** and choosing another language there make the message again, and replace your edits. Nod in chat, the helper's language buttons and a language set in chat keep your edits, unless you ask Nod to replace them. If the message changed since you opened it, Nod doesn't save your change and asks you to reload.

You can also ask Nod in chat for a message, or to change one. In chat, Nod changes only what you ask, under the same rules, and for your first 10 messages it says what it changed and why.

### Waves and limits

Nod suggests inviting a company's people in waves: 5 at a time, up to 10 a company, by default. Each company shows where it is:

| Wave line                   | Means                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Wave 2: invite 3 more today | the wave has room; the number also stays within today's and this week's invite limits                          |
| Wave 1 is full              | someone you invited is still within their chance; the line says when the next wave opens, or who waits for you |
| Wave 2 can start            | everyone invited so far had their chance and fewer than the most were invited                                  |
| Someone referred you here   | the waves stop at the first referral                                                                           |
| All 10 invited              | the most were invited and everyone had their chance                                                            |

Someone had their chance when they didn't accept within 7 days of your invite, didn't reply within 5 days of your referral request, or declined. Someone who accepted and waits for your request, or who replied, is still within their chance. Today and this week follow your time zone: this week is today and the six days before it. Change the sizes and days on the **Profile** tab.

Nod can't stop an invite you send. Invites past your limits are still logged, and the counts say plainly that you're over.

### No luck

Nod counts a company as **no luck** only when its waves are done: you invited the most people there (10 by default), each had their chance, and nobody referred you. Your tick overrides it both ways. Nod only shows that a company counts as no luck; it doesn't apply anywhere until you tick the box. Select **Keep trying** to keep a company open, and **Let Nod decide** to go back to the waves.

### No luck, apply here

Tick **No luck, apply here** on a company to give up on referrals there. Nod opens one chat for it, **Apply for the company I marked no luck**, and **Open the apply chat** takes you to it. Ticking again, or from two windows at once, never opens a second chat. Unticking keeps the chat. If the chat couldn't start, or was deleted, select **Start the apply chat**.

Applying on a company's own site comes in a later update. For now that chat lists the company's open postings with their scores and links, and Nod asks you before anything is submitted.

## A paired browser helper

A browser helper is a companion you install separately; it isn't part of Nod or of this fork. Once paired, it reaches Nod through a few routes of its own, only on this computer, and can:

- log people you invited, under their company;
- add the LinkedIn member ID of someone you invited who has none yet, so **Message** can open a chat;
- mark people you invited as accepted, from a list of their profile links;
- show a company's people, and the invites you sent in the last day and the last 7 days against the invite limits on the **Profile** tab;
- show who accepted and is waiting for your message, with the prepared message, its language, what Nod changed and why, and the company's wave;
- switch the language of a person's message, which makes it again, unless you edited it;
- make the message for someone who accepted before Nod prepared messages;
- download your main CV;
- change a person's status, and tick **No luck, apply here**, which works like the box on the **Companies** tab.

Its key opens nothing else in Nod.

### Pair a helper

1. On the **Jobs** page, open **Helper** and select **Pair a helper**. Nod shows a one-time code and copies it.
2. Run the helper's own pairing script, as its instructions say. It proves it has the code without sending it, and Nod sends the helper's key back encrypted under the code, so a program pretending to be Nod learns neither.

A code works once, for 10 minutes, and five wrong codes cancel it. Pairing the same helper again replaces its old key. The **Helper** tab lists paired helpers with when each was last used, and **Revoke** cuts one off at once.

A helper works only with a Nod that listens only on this computer, and reaches it only at `127.0.0.1`: the desktop app, or a source run whose server listens on `127.0.0.1` itself. A server in a container, or a self-hosted server with a public address or a server token, can't use one. The desktop app uses port `4310` when it's free, so a helper finds Nod after every restart, and writes its port, process ID and program path to `engine-port.json` in its profile at each start, so a pairing script can check that it's talking to the app. If Nod had to take another port, pair the helper again.

### What Nod accepts from a helper

Nod treats everything a helper sends as data, never as your words. Names and headlines are saved as plain text, profile links must be `https://www.linkedin.com/in/…`, and anything too long or shaped differently is refused. Someone Nod already has keeps their status and company. A helper never replaces a member ID Nod already has or joins two people into one; Nod refuses it and keeps both as they are. A list of profile links marks only people you invited as accepted; nobody else is saved.

Each paired helper can start at most 5 apply chats and add at most 30 new companies in a day. Past that, Nod answers with the time until the limit frees up. To save an invite at a new company sooner, or to start another apply chat, use the **Companies** tab or tell Nod in chat.

## Who can change job records

| Change                                             | Who                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anything on the Jobs page                          | You. Your own edits need no check                                                                     |
| A CV's text, the profile, adding a CV, the main CV | Nod, only in work that started from your message, such as the conversion chat or a task you asked for |
| The PDF of a Word CV                               | Nod, in work you started or in a schedule                                                             |
| Invite limits, no-luck days and waves              | Nod, only when your words ask for exactly that change; otherwise it asks you to approve it            |
| Adding postings, their scores and their status     | Nod, in work you started or in a schedule. A schedule changes the status of new postings only         |
| Telegram channels and scanner switches             | Nod, only in work that started from your message                                                      |
| People you invited and their status                | Nod, only in work that started from your message. A browser helper you paired                         |
| Referral messages                                  | Nod makes one when someone accepts. Nod in chat, only in work that started from your message          |
| No luck, apply here                                | You, on the Jobs page or through a browser helper you paired                                          |

These records are your own private data, so most changes skip the [trust check](/trust/). Invite limits, no-luck days and waves go through it like Nod's other settings, because they decide how much Nod does on its own later.

## What stays private

- Your CVs, profile and templates are saved in Nod's database on your computer, never in the code or on GitHub.
- Nod copies them as files into its workspace, under `shared/career-ops`, so career-ops can read them. Nod rewrites a file when its record changes and removes it when it no longer applies, for example when the main CV has no text yet.
- career-ops runs only scripts that don't call a model. Nod's model keys never enter the workspace. Its scans run without the options that open posting pages in a browser.
- Your postings, channels and switches are saved in Nod's database too. Nod's server reads Telegram channels and parses alert emails itself; the links in alerts are saved, never opened to import them.
- People you invited are saved in Nod's database with their name, headline, company, status and profile link. Their profile and message links are only shown for you to open; nothing Nod runs opens or fetches them, or contacts LinkedIn.
- To tailor a referral message, Nod sends your small model your filled-in message, your language-by-country rule when you haven't chosen the person's language, and the person's name, headline and company, and nothing else. The message Nod sends you about an accept goes only to you.
- A paired browser helper's key works only for its own requests to Nod on this computer, never for the rest of Nod.
- The job search doesn't need LinkedIn: jobs come from scans, Telegram channels, alert emails, links you share and company career pages. To make sure Nod never opens a website, add a rule in chat, such as "Never open linkedin.com, in the browser or with workspace scripts."
