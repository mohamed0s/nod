# CV PDFs

## The main CV's PDF

Referral requests and anything else the owner sends to people use the main CV unchanged:

- a CV uploaded as a PDF: that original file, whatever happens to its text;
- a CV uploaded as Word: the PDF made from its current text, below. When its text changes, Nod drops the old PDF.

To send it, call `jobs cv_file` (or `jobs cv_file {id}` for another CV), then `share_file` with the `workspaceFile` it returns. If it says the CV has no PDF for its current text, make one first.

## Make the PDF of a Word CV

1. Call `jobs cv_get {id}`. Note its `revision` and `pdfFile`, the one path Nod accepts the PDF from: `shared/career-ops/output/cv-<id>.pdf`. Below, `<dir>` is that output folder and `<id>` the CV's id.
2. Run `jobs sync`, so `shared/career-ops/cv.md` holds the main CV's text.
3. Read the JSON payload format in `/opt/career-ops/modes/pdf.md` (the section that starts "Write a JSON file with this structure") and fill it from the CV's text only, in its own order and wording. This is not tailoring: no job keywords, no reordering, no summary rewrite.
4. Keep every file in `<dir>` and pass absolute paths, because `career-ops pdf` refuses files outside the career-ops folder. Run `career-ops cv:html <dir>/cv-<id>.json <dir>/cv-<id>.html`, then `career-ops cv:verify-ats <dir>/cv-<id>.html`, then `career-ops pdf <dir>/cv-<id>.html <dir>/cv-<id>.pdf`. The pdf step checks the facts against `cv.md`; fix the payload when it reports a difference, never the check. For a Word CV that isn't the main one, `cv.md` is another CV, so compare the payload with that CV's text yourself and add `--skip-fact-check`.
5. Save it with `jobs cv_save {id, pdf: true, revision}`, using the `revision` from step 1. If the text changed since, make the PDF again.

## Tailored CVs

A tailored CV is made only when Nod applies through a company's own application form, as [apply.md](apply.md) describes, never while scoring or asking for a referral. It is for that one posting and never replaces the main CV. Below, `<dir>` is `shared/career-ops/output` and `<id>` the posting's id.

1. Run `jobs sync`, so `shared/career-ops/cv.md` holds the main CV's text.
2. Read the posting on the company's own page, and in `/opt/career-ops/modes/pdf.md` the keyword strategy and steps 3 and 10 to 15 of the full pipeline. Take 15 to 20 keywords from the posting. Lead with what `cv.md` already shows, reorder bullets and projects by relevance, and work a keyword into an existing achievement only where `cv.md` supports it. Never add a skill, figure, date, link or result that `cv.md` doesn't have, and keep each job title as `cv.md` writes it.
3. Write the payload in pdf.md's JSON format to `<dir>/tailored-<id>.json`, and pass absolute paths to every command.
4. Run `career-ops cv:html <dir>/tailored-<id>.json <dir>/tailored-<id>.html`, then `career-ops cv:verify-facts <dir>/tailored-<id>.html` and `career-ops cv:verify-ats <dir>/tailored-<id>.html`. Both must pass: fix the payload when one reports a problem, never the check. Then run `career-ops pdf <dir>/tailored-<id>.html <dir>/tailored-<id>.pdf`.
5. Save it with `jobs cv_tailored {postingId}`. Nod keeps it with that posting, shows it on the Jobs page, and returns `uploadFile`, a copy named for the owner, to upload on the form.
