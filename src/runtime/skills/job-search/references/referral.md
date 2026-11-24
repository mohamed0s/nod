# Referral messages

The owner asks someone who accepted their LinkedIn invite for a referral with a message they paste on LinkedIn themselves. Nod prepares it from the owner's saved template. You never send it, never open LinkedIn, and never look for people there.

## How a message is made

When a person becomes `accepted`, Nod fills the template for them by itself, without a model: `{first_name}` from their name, `{company}`, `{my_name}` and `{my_intro}` from the profile, and `{programme}`, `{track}` and `{role}` from the company's best open posting or the profile. `{greeting}` stays as it is and becomes the greeting for the time of day when the message is shown. Then Nod's small model tailors it once, and the owner gets the message on their chat channel with the person's **Open profile** and **Message** links. The Companies tab of the Jobs page shows the same message with **Copy**, **Edit**, **Remake** and the language.

The language is the owner's choice for that person, otherwise the guess from the person's country through the profile's `languageRule`, otherwise its default.

## When the owner asks for a message

1. Find the person with `jobs companies` and `jobs company {id}`. When the owner names someone who isn't there yet, save them first with `jobs person_update`.
2. `jobs company` shows the person's message, if one was made, in `draftInfo`. Show its `text` when the owner only wants to see it.
3. To make it again, or for someone without one, call `jobs draft_prepare {personId}`. Pass `postingId` when the owner names the job, and `programme`, `track` or `role` when the owner gives them. Pass `language` only when the owner names the language for that person; it becomes their choice for that person.
4. When the result has `missing`, nothing was saved. Ask the owner for those values in one short question, then call `draft_prepare` again with them. When `missing` holds `template`, ask the owner to save a template on the Jobs page, Templates tab.
5. A message the owner edited is replaced only when the owner asks for it: then pass `replace: true`. Never set it on your own.

`draft_prepare` returns `text` (the greeting filled in) and `raw` (as saved, with `{greeting}`), the `language`, `draftRevision` and the company's `waves`.

## Changing a message

Change a message only when the owner asks. Follow the `rules` that `draft_prepare` returns: keep the owner's words, facts, order and length, change only what fits this person, invent nothing, add no claim, flattery or request, add no link, web or email address, handle or phone number, and keep `{greeting}`.

Save the change with `jobs draft_save {personId, text, changes, revision}`: start from `raw`, keep `{greeting}`, and send `draftRevision` as `revision`. A message the owner edited is replaced only with `replace: true`, when the owner asked for that change. For the owner's first 10 messages, `changes` is required: one or two short sentences on what you changed and why. A refusal for a stale revision means the message changed meanwhile: read it again with `jobs company`.

## After the owner sends it

The owner pastes the message on LinkedIn and attaches their main CV, unchanged. When they say they sent it, save `status: "asked"` with `jobs person_update`.

## Waves of invites

Nod suggests inviting a company's people in waves of `waves.size` (5), up to `waves.max` (10) people a company, within the profile's `inviteLimits` for the day and the week in the owner's time zone. Each company's `waves` says where it is:

- `open`: invite up to `more` people now;
- `waiting`: the wave is full and someone is still within their chance;
- `next`: everyone invited had their chance and fewer than `max` were invited, so the next wave can start;
- `stopped`: someone referred the owner;
- `done`: `max` were invited and everyone had their chance.

Nod can't stop an invite the owner sends. Over the limits, say so plainly, and never tell the owner to invite more than `more`.
