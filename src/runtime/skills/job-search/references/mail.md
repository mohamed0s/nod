# Job mail

Nod reads the owner's job mail without a model: LinkedIn's "accepted your invitation" and message emails, and replies from companies the owner applied to or contacted. The server matches them to the records, pings the owner and records each email once. Nod only records and tells: it never replies to these emails, messages anyone or changes the calendar because of them.

## The mailbox

The owner may have several Gmail accounts connected. Job mail reads only the one they linked to LinkedIn, saved once with `jobs mail_setup {account}` (an id from `jobs mail_status` `accounts`) or on the Sources tab of the Jobs page. Never guess it: with one account, name its address and use it only when the owner agrees; with several, ask which one.

## Offer the Job mail schedule

`jobs mail_status` returns `offer: true` once the owner has Gmail connected and someone invited, until the offer is made. Offer it only in a chat with the owner, once, in one short message: every 30 minutes from 08:00 to 23:00 in their time zone, Nod checks the linked Gmail account for accepts and replies, and skips the check when no new mail arrived. Then call `jobs mail_setup {offered: true}`, whatever they answer.

When the owner says yes:

1. Choose the account with them, as above.
2. Create the schedule with `nod schedule_create` as the schedules guide describes: title "Job mail", recurring, cron `*/30 8-22 * * *` in the owner's time zone, `watch` with the account's connectionId, delivered to this chat, on the light model as [evaluate.md](evaluate.md) suggests. Its prompt: "Run Job mail as the job-search guide's mail reference describes. Message me only about accepts or replies Nod couldn't match, or a problem."
3. Save both with `jobs mail_setup {account, scheduleId}`. Only that schedule's runs, and work the owner starts, can apply job mail to the records.

## Each run

1. `jobs mail_status`. Stop when `account` is null and say so once: the owner chooses it on the Sources tab.
2. Run one `codemode` script so the email text never passes through the conversation:
   - search the account with `apps` `GMAIL_FETCH_EMAILS`, passing `query` from `mail_status` exactly as given, `max_results` 50, and the option the tool's schema offers for each message's full headers and body;
   - pass the result as the app returned it to `jobs match_mail {emails}`, or its `workspaceFile` when the app saved the result to one, and return only what `match_mail` returns.
3. Follow its `next`. Nod already pinged the owner about every accept and reply it matched, so don't repeat them. When `toAsk` has entries, ask the owner in one short message who each one is, by the name and date given; save their answer with `person_update`. Mention `reasons` only when they need the owner. Otherwise send nothing.

Never retype, summarise or filter the emails yourself before `match_mail`: it checks the sender itself. An email Nod's safety check withheld, or one Gmail returned without headers, isn't recorded, so the next run reads it again.

## What match_mail does

- **Accepts:** only from LinkedIn's own invitation sender, and only when Gmail's Authentication-Results header shows LinkedIn's DKIM, SPF or DMARC passing. It finds the person by the `/in/` profile link or member id in the email, when their name agrees with the email's, else by the exact name among people still `invited`. A match becomes `accepted`, which makes the referral message and the ping, as [referral.md](referral.md) describes. No match, or more than one, changes nothing and comes back in `toAsk`.
- **LinkedIn replies:** a message notification from LinkedIn's own sender moves the person who wrote to `replied` and pings the owner. A message from someone who isn't in the job search is ignored.
- **Employer replies:** an email from a company's own domain, or from a hiring system such as Greenhouse, Lever, Ashby or Workday that names the company or links to its posting, at a company the owner applied to or asked someone at. Nod's small model labels it `interview`, `rejection` or `other`; a label outside those becomes `other`. It is saved on the company, and on the posting when Nod can tell which, and the owner gets a ping.

## Follow-ups

Someone the owner asked counts as a follow-up due once `followUpDays` (3 unless the owner changed it on the Profile tab) passed without a reply. `jobs company` shows it as `followUp` (`waiting`, `due`, `done` or `dismissed`), and each company has `followUps`, the number due. A follow-up is due once per person.

Nod has no follow-up template. When the owner asks, draft a short follow-up in chat from their referral message and the person's record; the owner sends it on LinkedIn. When they say they followed up, or don't want to, save it with `jobs follow_up {personId, state: "done"}` or `"dismissed"`.
