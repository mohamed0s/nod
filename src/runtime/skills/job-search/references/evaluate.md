# Check and score jobs

Run `jobs sync` first. Paths below are relative to `shared/career-ops/` unless they start with `/opt/career-ops`.

## Short check

Every new posting gets a short check. It must stay cheap: read only `modes/_brief.md` and the posting's record from `jobs list {scored: "none"}` (title, company, place, link and the source's `excerpt`), never `cv.md`, the profile or the full rubric. Open a posting's page only when its record says too little to decide, and only on a site the owner's rules allow. Follow the steps and verdict table in `/opt/career-ops/modes/triage.md`: a verdict (pass, marginal or fail), a 1-5 score and the reason.

Save the checks in batches with `jobs posting_update {postings: [{id, score, check: "short", summary}]}`, the summary being the reason in one line. Give a clear fail `status: "skipped"` too. A record that isn't a job posting at all, such as an advert in a channel, is a fail.

Short checks belong in work that runs on the light model. When the owner sets up a recurring job search, suggest running it on the light model of their connection and name the saving; change the model only when they agree.

## Full score

Only the top few postings that pass get a full score: five a day unless the owner says otherwise, highest short-check score first (`jobs list {scored: "short", minScore: 3, limit: 5}`). A posting the owner sends by itself always gets one.

1. Read `cv.md`, `modes/_profile.md` and `config/profile.yml`.
2. Read `/opt/career-ops/modes/_shared.md` and, in `/opt/career-ops/modes/oferta.md`, the parts that score: Step 0 (archetype), Blocks A to D, Block G (legitimacy) and the verdict. Read them with `rg` or `sed` by heading rather than the whole file.
3. Check the posting is live with Nod's `browser` or the employer's own page. A closed posting gets no score. When its link is on a site the owner's rules avoid, follow [scan.md](scan.md#a-link-on-a-site-to-avoid).
4. Score from 1 to 5 as the rubric says, and keep its evidence rules: a requirement counts as met only when `cv.md` shows it.
5. Save it with `jobs posting_update {postings: [{id, score, check: "full", summary}]}`, the summary naming the two or three reasons that decide it.
6. Report the score, those reasons, the gaps, and the apply path (the company's own careers page or ATS link).

Don't write career-ops reports, tracker rows, cover letters or tailored CVs while scoring. Scoring never makes a CV: a tailored CV is made only when Nod applies on a company's own form.
