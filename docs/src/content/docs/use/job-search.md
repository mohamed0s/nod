---
title: Job search
description: Keep your CVs and job profile in Nod, find and score jobs from scans, Telegram channels and alert emails, follow the companies and the people you invited, log LinkedIn invites from an Edge panel beside the page, mark a company no luck, and see what stays private. This page describes a fork of Nod.
sidebar:
  order: 10
---

:::note
The job search is part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have it.
:::

The **Jobs** page holds the jobs Nod found for you, the companies behind them and the people you invited there, your CVs, your job profile, your referral message templates, the sources Nod looks in and the Edge panels you paired. Nod uses them to find, check and score jobs with [career-ops](https://github.com/career-ops-hq/career-ops), which runs in Nod's [workspace](/use/workspace/).

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

## Companies and people

The **Companies** tab lists each company with open postings or people, with its best score and how many people you invited, how many accepted, how many you asked for a referral and how many replied. Every posting joins its company by name, so "Example Co" and "Example Co, Inc." are one company. A posting whose company is hidden, such as "Confidential" or "N/A", joins no company.

Filter the list:

| Filter                  | Shows companies where                                           |
| ----------------------- | --------------------------------------------------------------- |
| Waiting for an accept   | someone you invited hasn't accepted yet                         |
| Accepted, not asked yet | someone accepted and you haven't asked them yet                 |
| Asked, no reply         | someone you asked hasn't replied yet                            |
| No luck                 | you ticked **No luck, apply here**, or Nod counts it as no luck |

Select a company to see its people and postings. Each person shows their status and when it changed, **Open profile** and, once Nod knows their LinkedIn member ID, **Message**. Both open LinkedIn in a new tab for you; Nod itself never opens them. Change a person's status from the list next to them, for example to **Asked** after you send your request. The prepared referral message appears under a person who accepted, with **Copy**, once Nod has prepared it.

### Tell Nod who you invited

You invite people on LinkedIn yourself. The [Edge panel](#the-edge-panel-beside-linkedin) logs them as you go. Without it, tell Nod in chat or Telegram, for example "I invited Sam Example at Example Co" with their profile link, or share a profile from the LinkedIn app to Nod on Telegram and add "Sent". Nod saves them as invited under that company. Say when someone accepts, when you ask them, and when they reply or refer you, and Nod updates them.

### No luck

Nod counts a company as **no luck** when nobody there referred you and each person you invited:

- didn't accept within 7 days of your invite,
- didn't reply within 5 days of your referral request, or
- declined.

While someone there has replied, or accepted and is waiting for your request, the company doesn't count as no luck. The days are the no-luck days on the **Profile** tab. Nod only shows that a company counts as no luck; it doesn't apply anywhere until you tick the box. Select **Keep trying** to keep a company open, and **Let Nod decide** to go back to the days.

### No luck, apply here

Tick **No luck, apply here** on a company to give up on referrals there. Nod opens one chat for it, **Apply for the company I marked no luck**, and **Open the apply chat** takes you to it. Ticking again, or from two windows at once, never opens a second chat. Unticking keeps the chat. If the chat couldn't start, or was deleted, select **Start the apply chat**.

Applying on a company's own site comes in a later update. For now that chat lists the company's open postings with their scores and links, and Nod asks you before anything is submitted.

## The Edge panel beside LinkedIn

A panel in your own Microsoft Edge sits beside LinkedIn. When you send invites from a company's **People** tab, it logs each person under that company with no extra clicks. When someone accepts, it shows them with what you need to ask for a referral.

The panel is the extension in the `extensions/linkedin-helper` folder of your Nod checkout. It isn't in any extension store.

### Install and pair

1. In Edge, open `edge://extensions`, turn on **Developer mode**, select **Load unpacked** and choose the `extensions\linkedin-helper` folder. You do this once.
2. On the **Jobs** page, open **Helper** and select **Pair the Edge panel**. Nod shows a one-time code and copies it.
3. From your checkout, run `powershell -ExecutionPolicy Bypass -File scripts\windows\pair-helper.ps1`. It takes the code from the clipboard, or asks for it, and saves the panel's key with Nod's address in `extensions\linkedin-helper\.pairing.json`.

Select the extension's button in Edge's toolbar to open the panel. It connects within 20 seconds.

The script finds the desktop app from the port file the app writes to its profile at each start, and stops if another program holds that port. It proves it has the code without sending it, and Nod sends the key back encrypted under the code, so a program pretending to be Nod learns neither. Before saving the key, it makes sure no other Windows account can change the extension folder, so nobody else can change the panel's code; when the folder allows that, the script says so and limits it to you, SYSTEM and Administrators. The key never appears on screen or in the terminal, and it never travels after pairing: the panel encrypts and signs each request with keys made from it. Git ignores `.pairing.json`, only your Windows user can open it, and Nod's own **Local files** never read it. A code works once, for 10 minutes, and five wrong codes cancel it. Pairing again replaces the panel's old key, and **Revoke** on the **Helper** tab cuts a panel off at once.

The desktop app uses port `4310` when it's free, so the panel finds Nod after every restart. If Nod had to take another port, or another program answers at the panel's address, the panel says it can't confirm Nod; that program gets only encrypted requests it can't read. Run the script again. The panel talks to Nod only at `127.0.0.1`. For a source run whose server listens on `127.0.0.1` itself, pass its address: `pair-helper.ps1 -Nod http://127.0.0.1:4310`. A server in a container, or a self-hosted server with a public address or a server token, can't use the panel. After you update Nod, select **Reload** on the extension in `edge://extensions`.

### What the panel shows

- **Invites you sent** in the last day and the last 7 days, against the invite limits on the **Profile** tab.
- On a company's LinkedIn page: its people with their status, and **No luck, apply here**, which works like the box on the **Companies** tab.
- **Accepted, waiting for your message**: each person who accepted, with **Open profile**, **Message** once Nod knows their LinkedIn member ID, the prepared message with **Copy message** once Nod has written it, **CV**, and **I sent it**, which marks them asked.

**CV** downloads your main CV, so you can drag it from Edge's downloads into the LinkedIn chat. You paste the message and attach the CV yourself: the panel never sends anything. Arabic and other right-to-left messages are shown right to left, and the panel follows Edge's light or dark theme.

When Nod isn't running, the panel keeps the invites it saw and sends them once Nod answers. It retries an invite Nod couldn't save for a few hours, and drops one only when Nod refuses it, for example when it names a person who is already someone else in your job search, telling you which. Each paired panel can start at most 5 apply chats and add at most 30 new companies in a day. Past that, an invite at a new company waits in the panel until the limit frees up; to save it sooner, or to start another apply chat, use the **Companies** tab or tell Nod in chat.

### What it reads

The panel only reads pages you open in your own Edge, while you look at them:

| Page you open              | What it reads                                                                                                          | What Nod saves                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A company's **People** tab | A card whose button turns to **Pending** after you invite: the name, headline and profile link, and the company's name | The person, as invited under that company. Someone Nod already has keeps their status and company |
| A person's profile         | The profile link and the member ID in the page's own **Message** link to `linkedin.com/messaging/compose`              | The member ID, only for someone you invited who has none yet, so **Message** can open a chat      |
| Your connections list      | The profile links on the page                                                                                          | People you invited who appear there become accepted. Nobody else is saved                         |

The connections list is a backup check for accepts, on until you turn it off with the switch at the bottom of the panel. A later update spots accepts mainly from LinkedIn's "accepted your invitation" emails.

Nod treats everything the panel reads as data from LinkedIn, never as your words. Names and headlines are saved as plain text, profile links must be `https://www.linkedin.com/in/…`, and anything too long or shaped differently is refused. What the panel reads never replaces a member ID Nod already has or joins two people into one; Nod refuses it and keeps both as they are.

### What it never does

- It never clicks, types, scrolls, opens pages or loads anything on LinkedIn by itself. It reads the page you have open.
- Only the extension's background worker talks to Nod, and only on this computer. Its content policy blocks every other address, LinkedIn included, so the worker and the panel can't fetch anything from LinkedIn.
- Nothing Nod runs contacts LinkedIn. **Open profile** and **Message** are links you select.

### The risk you take

LinkedIn's terms ban browser extensions that copy data from its site, even ones that only read what you see. The panel stays outside the page and doesn't change it, so detection is unlikely, but not impossible, and LinkedIn could restrict your account. Use the panel only if you accept that.

The panel reads LinkedIn's current page layout, which LinkedIn changes from time to time. If an invite doesn't show up, tell Nod in chat, as before.

## Who can change job records

| Change                                             | Who                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anything on the Jobs page                          | You. Your own edits need no check                                                                     |
| A CV's text, the profile, adding a CV, the main CV | Nod, only in work that started from your message, such as the conversion chat or a task you asked for |
| The PDF of a Word CV                               | Nod, in work you started or in a schedule                                                             |
| Invite limits and no-luck days                     | Nod, only when your words ask for exactly that change; otherwise it asks you to approve it            |
| Adding postings, their scores and their status     | Nod, in work you started or in a schedule. A schedule changes the status of new postings only         |
| Telegram channels and scanner switches             | Nod, only in work that started from your message                                                      |
| People you invited and their status                | Nod, only in work that started from your message. The Edge panel you paired, from pages you open      |
| No luck, apply here                                | You, on the Jobs page or in the Edge panel                                                            |

These records are your own private data, so most changes skip the [trust check](/trust/). Invite limits and no-luck days go through it like Nod's other settings, because they decide how much Nod does on its own later.

## What stays private

- Your CVs, profile and templates are saved in Nod's database on your computer, never in the code or on GitHub.
- Nod copies them as files into its workspace, under `shared/career-ops`, so career-ops can read them. Nod rewrites a file when its record changes and removes it when it no longer applies, for example when the main CV has no text yet.
- career-ops runs only scripts that don't call a model. Nod's model keys never enter the workspace. Its scans run without the options that open posting pages in a browser.
- Your postings, channels and switches are saved in Nod's database too. Nod's server reads Telegram channels and parses alert emails itself; the links in alerts are saved, never opened to import them.
- People you invited are saved in Nod's database with their name, headline, company, status and profile link. Their profile and message links are only shown for you to open; nothing Nod runs opens or fetches them, or contacts LinkedIn.
- The Edge panel sends what it reads only to Nod on your computer. Its key works only for the panel's own requests, never for the rest of Nod.
- The job search doesn't need LinkedIn: jobs come from scans, Telegram channels, alert emails, links you share and company career pages. To make sure Nod never opens a website, add a rule in chat, such as "Never open linkedin.com, in the browser or with workspace scripts."
