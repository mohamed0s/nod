# Job mail

Nod reads the owner's job mail itself, without a model: LinkedIn's "accepted your invitation" and message emails, and replies from companies the owner applied to or contacted. Nod's server searches the Gmail account linked to LinkedIn, checks each sender, matches the emails to the records, pings the owner and records each email once. Nod only records and tells: it never replies to these emails, messages anyone or changes the calendar because of them.

## The mailbox

The owner may have several Gmail accounts connected. Job mail reads only the one they linked to LinkedIn, saved once with `jobs mail_setup {account}` (an id from `jobs mail_status` `accounts`) or on the Sources tab of the Jobs page. Never guess it: with one account, name its address and use it only when the owner agrees; with several, ask which one.

## Offer the Job mail schedule

`jobs mail_status` returns `offer: true` once the owner has Gmail connected and someone invited, until the offer is made. Offer it once, in a chat with the owner or in the Job radar's message, in one short message: every 30 minutes from 08:00 to 22:30 in their time zone, Nod checks the linked Gmail account for accepts and replies, and skips the check when no new mail arrived. Then call `jobs offer_made {offer: "job_mail"}`, whatever they answer.

When the owner says yes, in the chat where they said it:

1. Choose the account with them, as above.
2. Create the schedule with `nod schedule_create` as the schedules guide describes: title "Job mail", recurring, cron `*/30 8-22 * * *` (08:00 to 22:30) in the owner's time zone, `watch` with the account's connectionId, delivered to this chat, on the light model as [evaluate.md](evaluate.md) suggests. Its prompt: "Run Job mail as the job-search guide's mail reference describes. Message me only about accepts or replies Nod couldn't match, or a problem."
3. Save both with `jobs mail_setup {account, scheduleId}`. Nod accepts only a schedule made from the owner's message in this chat. Only that schedule's runs, and work the owner starts, can apply job mail to the records.

## Each run

1. Call `jobs match_mail {}`. Nod searches the linked account for new job mail since the last run and applies it. There is nothing to search or pass yourself.
2. Follow its `next`. Nod already pinged the owner about every accept and reply it matched, so don't repeat them. When `toAsk` has entries, ask the owner in one short message who each one is, by the name and date given; save their answer with `person_update`. Mention `reasons` only when they need the owner. Otherwise send nothing.

When `match_mail` says no account is chosen, say so once: the owner chooses it on the Sources tab. Never read job mail with `apps` to apply it yourself.

## What match_mail does

Every email must have one To header that names the linked account, and the sender's DKIM signature that Gmail checked must cover that header; Cc doesn't count, and a forwarded copy sent to someone else is skipped.

- **Accepts:** only from LinkedIn's own invitation sender, and only when the first Authentication-Results header Gmail added shows DMARC passing for linkedin.com and LinkedIn's DKIM signature passing. It finds the person by the `/in/` profile link or member id in the email when their saved name is the name in the email, otherwise by that exact name among people still `invited`. A match becomes `accepted`, which makes the referral message and the ping, as [referral.md](referral.md) describes. No match, more than one, or a saved person without a name changes nothing and comes back in `toAsk`.
- **LinkedIn replies:** a message notification from LinkedIn's own sender, under the same check, moves the person who wrote to `replied` and pings the owner. A message from someone who isn't in the job search is ignored.
- **Employer replies:** an email at a company the owner applied to or asked someone at, from the company's own domain when it also names the company, one of its jobs or links to its posting, or from a hiring system such as Greenhouse, Lever, Ashby or Workday that names the company or links to its posting. Gmail must show a passing DKIM signature from the sender's own domain. Sign-in emails are skipped. Nod's small model labels it `interview`, `rejection`, `other` or `unrelated`; `unrelated` is dropped without a ping, and any other answer becomes `other`. When the model can't answer, the email waits for the next run. A label is saved on the company, and on the posting when Nod can tell which, and the owner gets a ping.

## Follow-ups

Someone the owner asked counts as a follow-up due once `followUpDays` (3 unless the owner changed it on the Profile tab) passed without a reply. `jobs company` shows it as `followUp` (`waiting`, `due`, `done` or `dismissed`), and each company has `followUps`, the number due. A follow-up is due once per person.

Nod has no follow-up template. When the owner asks, draft a short follow-up in chat from their referral message and the person's record; the owner sends it on LinkedIn. When they say they followed up, or don't want to, save it with `jobs follow_up {personId, state: "done"}` or `"dismissed"`.
