# CV PDFs

## The main CV's PDF

Referral requests and anything else the owner sends to people use the main CV unchanged:

- a CV uploaded as a PDF: that original file;
- a CV uploaded as Word: the PDF made once from its own, untouched markdown, below.

To send it, call `jobs cv_file` (or `jobs cv_file {id}` for another CV), then `share_file` with the `workspaceFile` it returns. If it says the CV has no PDF yet, make one first.

## Make the PDF of a Word CV

1. Run `jobs sync`, so `shared/career-ops/cv.md` holds the main CV's markdown.
2. Read the JSON payload format in `/opt/career-ops/modes/pdf.md` (the section that starts "Write a JSON file with this structure") and fill it from the CV's markdown only, in its own order and wording. This is not tailoring: no job keywords, no reordering, no summary rewrite.
3. Run `career-ops cv:html payload.json cv.html`, then `career-ops cv:verify-ats cv.html`, then `career-ops pdf cv.html cv.pdf`. The pdf step checks the facts against `cv.md`; fix the payload when it reports a difference, never the check. For a Word CV that isn't the main one, `cv.md` is another CV, so compare the payload with that CV's markdown yourself and add `--skip-fact-check`.
4. Save it with `jobs cv_save {id, pdfFile: "<absolute path of cv.pdf>"}`.

## Tailored CVs

A tailored CV is made only when Nod applies through a company's own application form, never while scanning, scoring or asking for a referral. It always starts from the main CV's `cv.md`, follows `/opt/career-ops/modes/pdf.md` for that one posting, and must pass `career-ops cv:verify-facts` and `career-ops cv:verify-ats` before it is used. It is used for that application only and never replaces the main CV.
