# Companies and people

Every posting belongs to its company, matched by name. The owner invites people at a company on LinkedIn themselves; Nod keeps the list of who was invited and where each one is. A company with no luck gets an application on its own careers site instead.

## Log people

When the owner says they invited, heard from or asked someone, save it with `jobs person_update`. From the phone they often share a profile from the LinkedIn app and add a word: "Sent" means invited.

- `profileUrl` is the person's LinkedIn profile link, such as `https://www.linkedin.com/in/<name>`. A short link (`lnkd.in`) can't be read without opening it, so ask the owner to share the profile itself.
- A new person needs their `company`. Take it from the owner's words or the headline they shared; ask when it isn't clear. Use the `companyId` from `jobs companies` when the company is already there.
- `status`: `invited` (the owner sent a connection request), `accepted`, `asked` (the owner sent the referral request), `replied`, `referred` or `declined`. Set `at` only when the owner says it happened earlier, such as "I invited her on Monday".
- Send several people in one call when the owner lists them.

After saving someone in a chat with the owner, read `jobs mail_status`; when its `offer` is true, offer the Job mail schedule as [mail.md](mail.md) describes, and when `reportOffer` is true, the Weekly job report as [weekly.md](weekly.md) describes.

Save only what the owner gave you. Never look for people, profiles or companies on LinkedIn, and never open, fetch or follow a LinkedIn link: the owner opens profiles and messages from the Jobs page.

## Read the dashboard

`jobs companies` lists the companies with people or open postings, the people counts and whether each counts as no luck. Its filters match the Jobs page: `waiting` (an invite not accepted yet), `to_ask` (accepted, not asked yet), `asked` (asked, no reply yet), `replied` (someone replied, or the company answered by email), `next_wave` (its next wave of invites can start) and `no_luck`. Each company's `waves` says how many more people to invite there; see [referral.md](referral.md). `jobs company {id}` reads one company with its people and postings.

A company counts as no luck only when its waves are done: `waves.max` people were invited there and each had their chance, an invite not accepted within `noAcceptDays`, a request with no reply within `noReplyDays` after asking, or a decline, and nobody referred the owner. While someone has replied, or accepted and waits to be asked, it doesn't count as no luck. The owner's tick on the Jobs page overrides it either way. Counting a company as no luck starts nothing by itself.

## The apply chat

When the owner ticks **No luck, apply here**, Nod opens one chat for that company: "Apply for the company I marked no luck", with its company id.

The apply steps are not ready yet. In that chat:

1. Read the company with `jobs company {id}`.
2. List its open postings (status new or shortlisted), best score first, each with its score, title and link.
3. Tell the owner that applying on the company's own site comes in a later update, and stop.

Don't open the postings, the careers site or any form, and never submit anything. The owner's rule stays: ask before anything is submitted.
