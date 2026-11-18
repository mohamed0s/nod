# Set up the job search

The owner does nothing by hand outside LinkedIn. Nod converts each CV, drafts the profile from it and asks at most one short question.

## Convert a CV

A chat that starts with "Convert my CV '<label>' for job search" has the CV attached. The same steps apply after `jobs cv_add` adds a CV the owner sent in chat.

1. Run `jobs setup_status` and find the CV by its label. Use its `id` below.
2. Extract the text from the attached file in `workspaceAttachments`:
   - PDF: `pdftotext -layout <file> -`. If that gives no text, the PDF is scanned: run `pdftoppm -r 300 -png` and `tesseract` on the pages.
   - DOCX: read paragraphs and tables with python-docx (`import docx`).
3. Write the CV as clean Markdown: a `#` heading with the name, the contact line, then each section as `##` in the CV's own order (summary, experience, education, skills, projects and the rest), with roles newest first as the CV has them. Keep every fact, date and link exactly as written. Fix only broken line wraps and bullets from the extraction. Never add, merge or improve content.
4. Save it with `jobs cv_save {id, markdown}`.
5. For a DOCX, make its PDF as [cv-pdf.md](cv-pdf.md) describes and save it with `jobs cv_save {id, pdfFile}`. A PDF upload keeps its original file as its PDF.
6. Draft the profile from this CV when it is the main CV and `profileRevision` is 0, or when the owner asks: `jobs profile_update {profile}` with what the CV shows:
   - `name`: the name the owner uses in messages;
   - `intro`: one short line, as they'd introduce themselves in a referral request, such as "a data analyst with three years in retail";
   - `location`, `links` (LinkedIn, GitHub, portfolio as written on the CV) and `languages`;
   - `targetRoles`: two to five likely roles that follow from the CV;
   - leave `regions`, `programmes`, `workAuthorization` and `languageRule` empty unless the CV or the owner states them.
7. Run `jobs sync`, then `career-ops doctor`. Its warnings about files Nod doesn't use, such as the tracker or a Playwright MCP, are fine.
8. Tell the owner in two or three lines: the CV is ready, what the profile says, and that they can edit both on the Jobs page.

Ask at most one short question in that chat, and only for something that matters and can't be inferred, such as which regions to search. Save their answer with `profile_update`.

## A CV sent in chat

When the owner sends a PDF or Word file and says it's a CV, or asks to add it, call `jobs cv_add {workspaceFile, label?}` with the file's `workspaceFile` from `workspaceAttachments`. Use the label they give, else a short one from the file name. Then convert it as above. Make it the main CV only if they ask.

## Switch the main CV

When the owner asks to use another CV, call `jobs cv_main {label}` (or `{id}` from `setup_status`), then `jobs sync`. Don't change the profile unless they ask.

## Change the profile

When the owner tells you something for the job profile (a region, a programme and its tracks, how many invites a day), call `jobs profile_update` with only those fields. `noLuck` holds how many days without an accepted invite (`noAcceptDays`) or a reply (`noReplyDays`) count as no luck at a company.
