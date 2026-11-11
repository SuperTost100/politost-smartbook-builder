# How a book is made

Each step below is a button in the app. Steps run in the background as a *run*, and the Run panel shows every task, what it waits for and what it cost. Closing the browser does not stop a run. Stopping the service pauses it, and the next start resumes where it left off.

The steps are Sources, Course program, Outline, Drafting, Figures, Review, Alignment with the program and Export. The service code behind them is described in [Architecture](ARCHITECTURE.md).

## 1. Sources

Add notes, textbooks, exercise collections and past exams, and mark each as Theory, Exercises, Exams or Mixed. **Prepare** then:

- splits every file into pages and marks pages whose text layer is garbled or empty (math in LaTeX-made PDFs, handwriting, scans);
- keeps each source's own table of contents, or reconstructs one from the page headings and labels it *inferred*;
- splits exam files into sessions and exercises and skips duplicate copies of a session (see [Exam files](#exam-files));
- uploads the sources to the book's NotebookLM notebook (once per file version), when the evidence setting on Connections is NotebookLM. With Local evidence nothing goes to NotebookLM, and the notice at the top of Sources says so instead of naming it. While the setting is loading or failed to load, the notice says that NotebookLM may be used and the setting is not known yet;
- builds the topic map, assigns every exam question to its topics and counts the distinct exam sessions per topic. Items of exercise collections are not assigned to topics here, because they only serve as examples for the exercise writer, which finds them when it writes a chapter's exercises.

### Exam files

A session starts at "Esame di" and a course name, "Prova scritta", "Appello", "Compito" or "Tema d'esame" with a date (12/02/2024, 12 febbraio 2024 or 2024-02-12, on the line or in the header table after it). An exercise starts at "Esercizio", "Problema", "Quesito", "Domanda" or "Parte" with a number or letter, and sub-questions a), b), c) stay inside it.

A paper written in Markdown is read like the same paper as a PDF. Heading marks and bold or italic marks around a heading are ignored (`**Problema 1** (12 punti)`, `## Esercizio 2`), a pipe table gives one line per cell so a date in the header table counts, and the same plain lines go to Split with AI.

A solution section is headed "Soluzione", "Soluzioni", "Svolgimento" or "Risoluzione", alone or with a qualifier in brackets or naming the session ("Soluzioni (Appello del 12 febbraio 2024)"). A qualifier with a date sends the solutions to the session of that date, so solutions printed after all the papers still reach their own.

The header table of the next paper (the cells "Corso", "Prova", "Matricola" and their values) is printed before its heading. It is left out of the last exercise or solution of the paper before it, but only when the cells directly precede the session heading and hold at least two different labels, so a solution that ends with "Durata" and "20 s" keeps them.

If the split of an exam file looks wrong, the Sources list says so, and so does the Prepare run, which shows a warning next to its completed status. The file gets a warning when no exercise was found, when the whole file came out as one session because no session heading was recognised, or when every session has at most one question. The list shows the sessions and questions found for each exam file. The Run panel lists the warnings of a finished run and calls it Completed with warnings. A book prepared before the split was recorded gets the same counts and warning on its next Prepare run, worked out from the stored questions, which stay as they are.

A file with a warning also shows two buttons in its row. **Mark as not an exam** changes the role to Theory, the one role whose questions no longer count for exam frequency or practice, and can be undone from the same row. **Split with AI** is described next.

### Split with AI

It is the way out when the text rules do not know a paper's layout. You ask for it on one exam file, and it never runs by itself.

The bulk model gets the first lines of each page (as plain text, with Markdown marks removed), then the lines that look like headings (at most 25 lines per page). It answers with the sessions and exercises, each with the page and the exact line where it starts, and where each exercise's official solution starts when the paper prints one. A session is named as the text rules name it ("Appello del 12 febbraio 2024"), so the same paper split either way is stored once.

The builder accepts the answer only when every quoted line is on the page the model names, the boundaries are in page order, every exercise lies inside its session, every solution lies in the session of its exercise and no two exercises share a solution. A quoted line counts as found when it is the start of a line on that page or a line on that page is the start of it, so a short quote such as "Ese" can match the line "Esercizio 3" and the boundary can sit on a different line than the model meant. Look at the sessions and questions it stored before you rely on them. Then it stores the sessions and questions the same way the text rules do, and the topic map classifies them. An answer that does not hold up changes nothing, and the warning stays.

A file whose questions you edited or checked already is not split again, because that would replace them. The check is made again right before the replacement, so an edit made while the model was working is kept. The action is refused while a Prepare run of the book is active, because the topic map of that run would not wait for the new questions. If a source is not an exam, change its role in the Sources list.

### Deleting a source

Deleting a source removes the pages, the stored file and the questions read from it, together with the review problems about those questions, so nothing from it keeps counting or stays in the book. Two kinds of question stay:

- one whose text you edited (a changed difficulty or topic alone does not keep it);
- one a chapter uses that was already read from the pages. A question given to a chapter but not read yet goes, because nothing could read it once the pages are gone.

The delete dialog warns about the questions whatever the file's role is now, because the role can change after questions were read. The questions that stay lose their source and page range and are your own from then on, and the delete says how many went and how many stayed.

A source you only exclude keeps its questions, but they stop counting. A paper that another file repeats is stored again as a new copy, because only questions that count are compared when a session is checked for being a duplicate. So the corrected upload of an exam file, after deleting the first one, is stored in full.

## 2. Course program

Once the book exists, open **Book setup**, paste the program from the PoliTo course guide or give the guide's address, then press **Read program**. The planning model turns it into a list of items, each with its title, the program's own wording and whether the exam asks its proof, plus the exam format (written, oral, which proofs). Include the "Modalità d'esame" part when the guide has it, because it decides how much weight proofs get.

You can edit every item. Reading the program again keeps the key of every item whose title stays the same, so the outline's references to it still work. An item whose title changes gets a new key.

Under *What goes in the book*, *Sections outside the course program* sets what happens to material the program doesn't ask for when you align the book (step 7): **Remove off-program sections** (the default) or **Keep them with a note**.

Book setup also sets the book's subject area, which decides the figures the writer may use (see [Figures](#5-figures)), the circuit symbols and the other generation options.

A book without a program works as before: it covers the topics of its sources, and the exams decide how deep each one goes.

## 3. Outline

**Generate outline** asks the planning model for a common index: chapters, sections, objectives, depth and the topics each section covers.

- With a program, the planner is asked to place every item in the section or sections that teach it or to list it as left out with a reason. Nothing enforces this, so a model can omit an item from both. Check the coverage list before you approve the outline. Source topics outside the program are excluded with a reason. A topic the program or the exams need as a prerequisite can stay as a short recap inside a related section, without a section of its own. The exams then decide only the depth: topics in many sessions get *deep* sections and more exercises.
- Without a program, topics in no session keep a section and the baseline exercises unless you exclude them with a reason.

Edit anything, then **Approve outline**. Drafting always uses the approved version.

## 4. Drafting

**Generate book** works chapter by chapter. Chapters run side by side, but the sections of one chapter are written in order, so the writer of section 2 reads the summary and the formula keys of section 1. Evidence is gathered for all sections of a chapter at once. If a section fails, the sections after it in its chapter wait, the other chapters go on, and the run ends as failed with the cause shown on the section that failed. A retry of that section lets the rest of its chapter continue.

With the first-chapter gate on (the default), the run stops after chapter 1. Read it, fix what you need, then press **Continue** in the Run panel. The remaining chapters use the same prompts you have now seen working.

### Evidence

NotebookLM (or the local reader) answers a question about the section by quoting the sources. Each quote is located on its page, and unlocated quotes are dropped. The most cited garbled pages are transcribed by a vision model so the writer sees clean formulas. The writer gets the verified quotes, the evidence reader's answer and the full clean text of at most two of those transcribed pages, the most cited first. A page with a good text layer is not sent whole, because the quotes come from it.

### Writing

The writer gets:

- the section's objectives, its program items and the exam format;
- the chapter plan, the summaries of earlier sections, the known formula keys and the notation;
- the subscripted symbols the exam papers use on the section's topics (`f_c`, `v_{out}`, taken from the statements of the questions that count), with the instruction to use them for the same quantities unless they conflict with the book's notation, so the book and its practice agree;
- the evidence.

It returns the section with citation markers and the specs of any figures it adds, plus a short summary. The section is the plain-text body of the answer, and only the small fields follow it as JSON after a line `<<<META>>>`, so no formula is ever inside a JSON string. The repair of a formatting problem and the lab example's code are answered the same way (the format is described in [Architecture](ARCHITECTURE.md#model-calls)).

The writer's rules:

- A worked example and a typical-mistake box are asked only when the section teaches a method or a computation. The writer is told never to add sentences to reach a length. The word range of each depth (400-800, 800-1,500, 1,200-2,200) only describes the usual size.
- It never mentions its sources to the reader ("the notes", "the material provided", what they do or do not contain). The model-commentary lint flags such a sentence as a blocker in Italian and English. It needs words that name the author's material (notes, appunti, dispense, the provided material, the evidence) in a sentence about what they contain, so "la potenza fornita dalle fonti di tensione" passes. A gap in what the sources cover is the alignment check's job, never a sentence in the book.
- Proofs follow the exam format. A recap section that teaches no program item gives proofs only as far as the explanation needs and never marks them. In the other sections, when the exam asks for proofs, every theorem with a standard proof gets it in full after the line "**Dimostrazione richiesta all'esame.**" ("**Proof asked at the exam.**" in an English book), and when the program lists only some proofs, only those results get it. A written exam without proofs keeps them brief and unmarked.
- Figures are described in [Figures](#5-figures).

**The writer's self-check.** After the answer parses, the writer checks its own section once. It gets one more message in the same conversation, which asks it to look at every statement for missing hypotheses, every derivation step, every computation and numeric result with its unit and sign, and every reference to a formula key. It answers `OK` or the full corrected answer in the same format.

A correction replaces the draft only when it parses, keeps every heading, formula key, `:::` block, image, figure and citation marker of the first draft (a paragraph rewritten whole may lose its marker), and does not open or close with a note about what it changed. The follow-up forbids such a note, and a real run produced one anyway. If the follow-up fails (a usage limit, a timeout) or the correction does not hold up, the first draft stays and nothing else changes.

The draft task records which happened as `selfCheck`: `ok`, `corrected`, `kept` or `skipped`, and `selfCheckNote` says why a correction was not used. Exam guides do not get this turn. It costs one more call per section, mostly output tokens, because the writer's context is already loaded. It is the book option `selfCheck`, on by default and without a screen yet: switch it off with `PATCH /api/projects/<id>` and `{"options": {"selfCheck": false}}`.

### Clean-up, lint and repair

Some fixes need no model:

- Function names KaTeX lacks, such as `\cotan` or `\sen`, become `\operatorname{...}`.
- A formula block reusing a key another section already defines keeps its math and loses the key.
- A link to a section id the model miscopied points at the section that id was meant for when only one matches, and becomes plain text otherwise.
- Terminal codes and control characters left in model output are removed, and a line break in the writer's text stays a line break.
- Display math is moved out of sentences, and statements are numbered per chapter at compile.
- A reference to a formula reads "(7.2)" in the reader: a chip in the same chapter, a link to the formula in another chapter. Parentheses the writer put around it are dropped so it never shows as "((7.2))".

Formatting problems that break the reader then trigger one repair request, and what remains becomes an issue. A placeholder such as `[?]` or `???` is a blocker, and so is a literal backslash followed by `n` or `t` in text outside math and code, which is a line break or a tab that was never decoded. The lint covers every book text, questions and solutions included, so Validate reports it and an approved export is blocked by it, whatever path wrote the text. A draft export stays available.

### Exam guide

Every chapter whose topics appear in past exams closes with an exam guide, "Come viene chiesto all'esame" in an Italian book and "How the exam asks it" in an English one, written from its classified exam questions. The builder computes the session counts in it ("N of M sessions"), not the model.

### Introduction, practice, extras and review

Each chapter then gets an introduction, its practice, its extras and an independent review.

**Practice** has authentic exam questions re-read from page images, generated exercises up to the topic targets, and labeled exam-style practice when a chapter has no real exam questions. Question text that would not render gets one formatting repair, answered as plain text. The repair may change line breaks, spacing, math delimiters and markup but never a word or a number (a number includes its sign, decimal separator and exponent, and a Unicode symbol such as τ and its LaTeX command `\tau` count as the same). A repair that does is not applied, and its reason is written only on issues the author has not closed meanwhile. Exam questions have no hints, as on the day.

- *Reading exam questions.* When a session has two or more questions still to read, one call reads them all from the same pages instead of one call per question, so the pages are sent once. The answer is plain text, one part per question (`@@@ statement 2`, `@@@ solution 2`, or `@@@ unreadable 2`), so no statement or solution is a JSON string and a line break arrives as a line break. It must list exactly the numbers of the stored questions, none missing and none invented, and a malformed answer gets one repair turn. If it still does not hold up, or if the session spans more than 12 pages or more than 60,000 characters of transcript, each question is read by its own call. A question read on its own gets the same plain-text answer. A question you edited, or one already read from the pages, is not read again.
- *Examples from exercise collections.* The exercise writer gets at most 6 items of the collections as examples of level and style. Items already assigned to the chapter's topics come first. The others are found by searching the collections' pages for the words of the chapter's topic and section names, then keeping the items whose own text contains those words, those with a known answer first. This costs no model call. The items are a source and not book content: the reader has no multiple-choice format, so they are not exported.
- *Checking solutions.* A second model solves each exercise again and compares. When the final answer is one or more numbers with a unit, that same answer also carries a short Python computation of the values from the statement. It runs in the same sandbox as the Python examples, and its values are compared with the ones the solution states, within the number of significant figures the solution gives (4.7 kΩ and 4700 Ω are the same value). A value that differs is a blocker that names both numbers, and the reviewer model is asked, as for any different result. When a fix then rewrites the printed solution of an authentic exam question, the question becomes "adapted" (the origin badge on the Practice screen) and the issue's resolution says so in one sentence, with the old value and the value the check computed, or "rewritten by <model>" when the check gave none. A computation that fails, prints nothing or cannot be paired with a stated value is ignored, and so is any answer that is not a number, such as an expression or an interval.

**Extras** are interactive graphs and lab examples, added where they help and all checked. A graph or example whose check failed is left out of the export and listed as a finding on the Export screen. An edited graph is checked again when you save it in Extras. An edited example goes back to draft because running it needs the sandbox, so it ships unchecked.

- *Graphs* are sampled by the builder and shipped as Plotly data. A graph can have a log axis, shipped as a Plotly axis of type `log`, and the numeric check reads a log axis in data units and counts only positive values on it. A Bode plot is one graph with a second graph (`pair`) on the same frequency axis, stored as two graphs of the section.
- *Lab examples* are Python or MATLAB, set per book in Book setup (*Lab language*). Python examples run in Pyodide and MATLAB examples in numbl, the MATLAB-compatible interpreter the reader uses. Both run in a permission-restricted Node child process, which cannot block the network on Node 24 (the comment in `pipeline/python.ts` says so). A Python book gets up to one example per chapter. A MATLAB book gets up to one per section, and its writer puts commands in inline code, since the reader has no code blocks. numbl lacks `format long`, `fminsearch`, `spline`, `ode45` and 3-D plots. `fzero`, `integral`, `hilb` and `vander` come from `pipeline/matlabShims.ts`, a copy of the reader's file.

**Outside research** is a separate action. With the book option "Use verified outside material" on, **Find outside sources** in the Manuscript asks Claude to search the web with every local tool switched off. The builder opens each page and keeps an addition only if its quote is there. Additions arrive as a proposal that lists the pages. It is not part of Generate.

## 5. Figures

A book has a subject area: mathematics, physics, chemistry, electronics, computer science, mechanics or other. Set it in Book setup, or leave it on Automatic, which follows the book's subject and title. The area decides which figure kinds the writer is offered, and the table is `packages/domain/src/subjects.ts`. A mathematics book is offered plots and drawings, a chemistry book every kind.

### Kinds

| Kind | What it is | Who makes it |
| --- | --- | --- |
| Function plot | A curve from a spec, with `linear` or `log` axes (`xScale`, `yScale`). A log axis needs a positive range, is sampled in the exponent and has a grid of labelled powers of ten. | The builder draws it from the writer's spec, so the curve matches the formula. |
| Molecule structure | Drawn from SMILES, Lewis or skeletal. The writer also gives the formula as the text writes it, and a structure whose formula does not match its SMILES is dropped. | The builder. |
| Chemistry diagram | Energy levels (MO, enthalpy, Hess cycles), orbital boxes (the electron count is checked against the species), electrochemical cells, and the periodic table with highlighted groups and trend arrows. | The builder. |
| Drawing | Anything the kinds above cannot draw, in every subject area: circuits, logic networks, timing diagrams, Karnaugh maps, state machines, block diagrams, trees, free-body sketches. | The illustrator model writes Typst or schemdraw code, and the builder compiles it. |
| Photo | From Wikimedia Commons (no key), Pixabay or Pexels (a key on the Connections screen). Only photos with a licence a book can credit, and the credit line ends the caption. When the writer asks for a photo, a vision model checks each candidate before it goes in. | Searched by the builder. |

AI image generation is not implemented. Captions are plain text, because the reader prints them as text, and figures are numbered per chapter (`Fig. 6.1`). A figure without a caption shows no label and takes no number, so the numbers a reader sees never skip.

### How a figure gets into the text

- The writer decides. With the `figurePolicy` option on `helpful` (the default) it adds a figure where the student has to see a relation, a structure or an object, and a section with nothing to show gets none. `generous` asks for a figure in most sections (up to 3 per section). The `figures` option switches figures off.
- A cheap model drops decorative figures before they are built, wherever they are born: in a draft, in a fix and in **Add figures with AI**.
- A drawing is described by the writer in English as `shows` (two to five sentences: every element, how they connect, every label and value, what to notice) and a `family` (circuit, logic, timing, karnaugh, state-machine, block-diagram, plot, sketch, tree-graph or other). A separate **illustrator** role (default Codex `gpt-6-sol`, fallback Claude Sonnet 5.5) writes the code. The builder compiles it and sends compile errors back (at most twice). Then it shows the model its own picture once, with a checklist, and takes `OK` or a corrected source. A drawing that does not compile after two repairs is dropped with a note, as any failed figure is.
- A Bode plot is asked for as two plot figures, magnitude and phase, one after the other, with the same log frequency axis.
- The reviewer flags figures that do not match the text or add nothing, and no longer asks for missing ones. A fix gets the figure rules only when it handles a figure problem or an author instruction. To change a drawn figure in a fix, the writer returns a new `shows`, which draws a new figure.
- **Add figures with AI** in the toolbar asks the writer for figures in a section, a chapter or the whole book, or a `figures` run with `missingOnly` does. It adds figures to written text without changing it, and the result is applied unless the author edited the section meanwhile.

Circuit symbols (the zigzag resistor of American books or the rectangle of European ones) are the book option *Circuit symbols*, which Book setup shows for physics and electronics. The default is American.

### Figures you change yourself

Select a figure block in the Manuscript and press **Edit figure**. The dialog shows the figure on the reader's plate and lets you change its caption, replace it with an image of your own (PNG, JPEG, SVG or WebP, up to 2 MB, and an SVG goes through the same safety check as a generated one) or remove it.

A figure drawn by the illustrator also shows *What it shows* (the writer's description, which changes nothing until you redraw), its **Source** with a **Render** button, and **Redraw with AI**. Render compiles the source you edited. When it does not compile, the dialog shows the compiler's message with its line number and the book keeps the last drawing that did. Redraw with AI sends the description, the current source and your one-line instruction to the illustrator as a task in the Run panel and takes about a minute. A description you edited goes with the redraw, and the new drawing keeps it.

**Add figure** in the block editor's action row inserts one figure after the block you are editing, and saves your unsaved changes to that block first. You can describe a drawing (the illustrator draws it as a task, with a placeholder under the block meanwhile), upload an image, or search photos. The photo search lists only photos with a licence a book can credit, never offers a photo the book already shows, and ends the caption with the service's credit line.

Every change of a figure is a new version of the section. A new picture, and a new caption or description too, is a new copy of the figure next to the old one, so restoring an older version brings back its drawing, its caption and its description. Replacing a drawing with an image drops its source from the section, and the older versions keep it. A change is refused with a message when the section changed since you opened the dialog. A redraw that finishes after you saved other text puts the new drawing into your latest text and leaves everything else as you wrote it. A redraw whose figure you changed meanwhile (a caption, a render, a replacement) or removed is dropped, so it never undoes your change. Model output that started before a figure change arrives as a proposal and never removes it.

### In dark mode

A figure is dark ink on a transparent background, shown on a cream plate, so it reads the same in the light and the dark theme. Figures made before 0.4.0 have a white background and look right on the plate without being redrawn.

## 6. Review

The Review tab lists lint findings, failed checks and reviewer issues, each pointing at the exact text. For each one: edit the text yourself, **Fix selected issues**, or **Accept as is**.

### Fix

**Fix** applies the fix to the text. Earlier versions stay in the section's history, so you can restore any of them. Before a fix is applied it passes these checks:

- a change that would delete a heading, a formula or another special block, drop a formula key, leave a `:::` fence open, or break a formula is left out, and its issue stays open with the reason;
- a change that raises the count of blocker or major lint findings for any one rule is reverted, even if it lowers others (a change that swaps one finding for another of the same rule and severity passes this guard);
- a cheap second model reads each change against the issue and drops any that adds an error or removes more than asked. It also rejects a change that adds more than one new sentence of claims or caveats, because those sentences were what the next review found fault with. When that check can't run, the other guards decide alone and the limit isn't enforced;
- a fix that would remove more than a fifth of the text is not applied. It waits as a proposal in the Manuscript, and so does a fix for a section you edited while it ran.

The fix model is told these rules in its prompt, generated from the guard's own limits, so it does not delete a heading, a formula or more blocks than the guard allows. It makes the smallest edit that corrects the sentence. It reads only the evidence notes that the blocks it fixes cite, and the whole packet when it cannot tell which blocks those are. It answers in plain text, one part per changed block, so LaTeX backslashes arrive as written. A malformed answer gets one repair turn.

A fix model can also answer that the section already resolves an issue, which happens when an earlier fix or an edit by hand dealt with it. The cheap model then checks that claim against the current text. A confirmed issue is closed as fixed with the reason "Already resolved in the current text", an unconfirmed one stays open with the reason shown, and so does one whose section changed while the fix and the check ran.

Two kinds of issue the text fix cannot solve go elsewhere:

- A figure issue that asks for a figure where none exists goes to the figures pass for that section, with the issue as the brief. Each figure it proposes names the issue it answers, so an issue closes only when a surviving figure answers it. A figure issue about a figure that is already in the section stays with the text fix.
- A graph that failed its check is redrawn, one redraw for each failing graph (a Bode pair has two), and each redraw answers only the issues about its graph. The graph of the answer with the failing graph's id replaces it (the only graph of the answer when none has the id), and only when it passes and the author did not edit or delete that graph meanwhile.

In both cases the issue stays open with the reason when nothing lands.

Program issues (step 7) are the exception to the smallest-edit rule: a fix for a thin section or a missing proof may add the material it needs, and a fix for an off-program passage may delete whole subsections, formulas and boxes. When such a fix is applied directly, a formula it deletes becomes a plain name wherever other sections referred to it. Accepting the same fix as a proposal doesn't do this, so check those references yourself.

An instruction you give in the Manuscript ("regenerate with instruction") always becomes a proposal. Proposals never replace your text until you accept them. Your own edits are never overwritten: AI output that arrives after you changed a section becomes a proposal too.

### Run review

**Run review** reads the whole chapter only the first time, and that review reports everything. The reviewer is also given the subscripted symbols the exam papers use on the chapter's topics, as the writer is, and reports a symbol that differs from the exam papers' symbol for the same quantity (the cut-off frequency written `f_t` where the papers write `f_c`) as one major notation finding per symbol. A minor issue there means a wrong word, symbol, unit or reference that could mislead a student. Style, wording and "could be clearer" are not reported at any severity.

After the first review it reviews only the paragraphs, formulas and boxes written since the last review, such as the text a fix changed:

- It receives the sections that changed in full, the other sections as the short summaries their drafts recorded, and the evidence of the changed sections only, which made the prompt a third of the first review's size on a test chapter where one section of four changed.
- It reports only blockers and majors, and any minor it still returns is dropped before the second opinion. Findings outside the new text are dropped too. Open issues on text that didn't change stay as they are.
- A chapter with no new text costs no model call.
- The reviewer also sees the issues you accepted or dismissed and the ones already fixed, and does not raise them again.

Only blockers stop an approved export. Majors and minors do not have to reach zero.

A review that leaves no open blocker or major says so. The result of each chapter review carries `clean` and `openSerious`, and the project summary the Review screen reads (`GET /api/projects/:id`) carries `review: { clean, openSerious, reviewedAt }`. `clean` is true when every chapter with text was reviewed at its current text and no blocker or major is open or waiting as a proposal anywhere in the book. Text changed after a review, a new open blocker or a new proposal makes it false again. Reviews and fixes still start only when you press the buttons: nothing loops by itself.

**Every finding gets a second opinion** before it reaches the list. Another model (the **Second opinion** role, Claude Sonnet by default) re-reads the passage with the sources. It drops findings that are not real, such as a counterexample the setting excludes, and can lower a severity but never raise it. Dropped findings stay visible under **dismissed**, with the reason, and the reviewer is told not to raise them again. If the second opinion can't run, the findings stay as the reviewer wrote them.

**Full review** reviews every section on its own call instead of the whole chapter at once, so fewer problems are missed. It reports everything, as the first review does. It costs about as much as 3 to 5 normal reviews, so use it once, before the final export. It replaces the open review issues with what it finds.

## 7. Alignment with the program

This step is for books that already exist, including ones written before they had a program. Add the program in Book setup first.

**Check alignment**, in the Review tab, sends one planning call with the program and a digest of the book: headings, statement labels, whether each proof is present, lengths and exam sessions, but not the full text. Program items you left out in the outline (the exclusions, with their reason) are not sent and are never reported as missing, thin or without their proof, and Align book skips such a finding in an older report. The report has six groups:

| Group | What it lists | What **Align book** does |
| --- | --- | --- |
| Missing from the book | Program items no section teaches | If a written section is planned for the item, opens a review issue and the fix teaches it there. If the planned section isn't written yet, writes it. Otherwise adds a section where the check suggests and writes it |
| Too thin for the exam | Items taught more briefly than the exam needs | Opens a review issue, and the fix expands the section |
| Proofs the exam asks | Proofs the exam asks that the section doesn't give | Opens a review issue, and the fix adds the proof |
| Outside the program | Sections and passages the program doesn't list and no in-program part of the book needs | Removes a section, or keeps it with a note, as Book setup says. A passage becomes a review issue whose fix cuts it, or puts the note before it in keep mode |
| Order | A section placed before one it depends on | Nothing: move the section in the outline yourself |
| Exam guides | Chapters without an exam guide | Adds the guide and writes it from the exam questions |

Ids, keys and quotes in the report that don't match the book are dropped. A new report starts with every finding selected that Align book can apply. Deselect the ones you disagree with, then press **Align book**. A new section in a finished chapter gets its evidence, a draft and a chapter review, while the chapter's introduction, practice and graphs are not redone.

A section needed to understand the in-program parts counts as needed, even when it is outside the program. When a removed section was linked from other sections or they used its formulas, those links become their plain label and the formula references become the formula's name. Generated exercises that link to a removed section or use its formulas leave the book with it. A past exam question or a source exercise still in the book that does the same keeps the section, which is then kept with a note, and so is a chapter's only section.

Removing a section writes a new outline revision, rewrites the links and formula references in other sections and takes the generated exercises out of the book, as described above. The section's own text stays in the database, and the report lists every removed section with a **Put back** button that returns it to where it was. The links that became plain text and the detached exercises don't come back with it.

## 8. Export

**Validate** runs the reader's own validator plus the builder's lints on the compiled book. Each finding names the section or question it comes from and links to it. **Fix with AI** sends the errors and warnings to the same fix as **Fix selected issues**: sections get a guarded fix, and questions are rewritten and checked again. A question fix for a formatting finding (a literal `\n`, a formula that does not render) is applied only when the statement, hint and solution keep the same words and numbers once markup, math delimiters, line breaks and spacing are set aside. Otherwise the text stays and the issue stays open with the reason. Findings in generated files, such as a chapter's exam page, go away when the question behind them is fixed.

**Approve and export** is available when no blocker is left. **Export draft** always works and is named `-draft`. Every export is reopened and compared with what was compiled before it is offered for download.

The export holds only chapters with text. Chapters keep their outline numbers, so formulas stay `6.x` as more chapters are written, and links into chapters not yet written become plain text with a minor warning.

## Editing as you go

You can edit any block of the Manuscript with a live formula preview, and regenerate a passage with an instruction. The open block is saved 3 seconds after you stop typing and when you leave it. Each save is a revision, and History folds your own edits made within 10 minutes of each other into one row. The AI never overwrites your edits (see [Fix](#fix)).
