# The weekly job report

`jobs report {since}` reads what happened since that time (7 days when left out) and how the whole search is going:

- `period`: invites, accepts, requests, replies and referrals since `since`, plus applications, employer replies, interviews and rejections;
- `funnel`: everyone invited so far, by how far they got (invited, accepted, asked, replied, referred), with each step's rate out of the one before, overall and by company, by language and by template version;
- `applications` with their outcomes, `interviews`, `replies`, and `followUpsDue`.

The numbers come from the records. Never add to them or estimate one that isn't there.

## Offer the weekly report

`jobs mail_status` returns `reportOffer: true` once someone was asked for a referral, until the offer is made. Offer it once, in a chat with the owner or in the Job radar's message, unless `nod schedule_list` already has a "Weekly job report": every Sunday evening Nod updates a page with the week's numbers and sends a short summary. Then call `jobs offer_made {offer: "weekly_report"}`, whatever they answer.

When the owner says yes, in the chat where they said it, create the schedule with `nod schedule_create`: title "Weekly job report", cron `0 19 * * 0` in the owner's time zone, delivered to this chat, on the light model. Its prompt: "Make the weekly job report as the job-search guide's weekly reference describes."

## Each run

1. `jobs report {page: true}`. It returns the numbers and `pageFile`, an HTML page made from them.
2. Publish it as the pages guide describes: `pages list`, then `pages publish {title: "Job search weekly", workspaceFile: pageFile}`, with the `pageId` of the existing "Job search weekly" page when there is one. Don't change the file.
3. Send one short message: the week's invites, accepts and replies, any interview or reply from a company, the follow-ups due, and one line on what led to replies, such as the template or language with the best reply rate when at least five people were asked with it. Say the page is updated in Pages.
