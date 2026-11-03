# How a book is made

Each step below is a button in the app. Steps run in the background as a *run*; the Run panel shows every task, what it waits for and what it cost.

## 1. Sources

Add notes, textbooks, exercise collections and past exams, and mark each as Theory, Exercises, Exams or Mixed. **Prepare** then:

- splits every file into pages and marks pages whose text layer is garbled or empty (math in LaTeX-made PDFs, handwriting, scans);
- keeps each source's own table of contents, or reconstructs one from the page headings and labels it *inferred*;
- splits exam files into sessions and exercises ("Esame del 25 gennaio 2023 – turno 1", "Esercizio 2") and skips duplicate copies of a session;
- uploads the sources to the book's NotebookLM notebook (once per file version);
- builds the topic map, assigns every question to its topics and counts the distinct exam sessions per topic.

## 2. Course program

Once the book exists, open **Book setup**, paste the program from the PoliTo course guide or give the guide's address, then press **Read program**. The planning model turns it into a list of items, each with its title, the program's own wording and whether the exam asks its proof, plus the exam format (written, oral, which proofs). Include the "Modalità d'esame" part when the guide has it, because it decides how much weight proofs get. You can edit every item, and reading the program again keeps the item keys, so the outline's references to them still work.

Under *What goes in the book*, *Sections outside the course program* sets what happens to material the program doesn't ask for when you align the book (step 6): **Remove off-program sections** (the default) or **Keep them with a note**.

A book without a program works as before, with the exams alone deciding what to cover.

## 3. Outline

**Generate outline** asks the planning model for a common index: chapters, sections, objectives, depth and the topics each section covers. With a program, every item goes in the section that teaches it or is listed as left out with a reason, and source topics outside the program are excluded. The exams then decide only the depth: topics in many sessions get *deep* sections and more exercises. Without a program, topics in no session keep a section and the baseline exercises unless you exclude them with a reason. Edit anything, then **Approve outline**. Drafting always uses the approved version.

## 4. Drafting

**Generate book** works chapter by chapter:

1. *Evidence*: NotebookLM (or the local reader) answers a question about the section by quoting the sources. Each quote is located on its page; unlocated quotes are dropped. The most cited garbled pages are transcribed by a vision model so the writer sees clean formulas.
2. *Writing*: the writer gets the section's objectives, its program items and the exam format, the chapter plan, summaries of earlier sections, known formula keys, the notation and the evidence, and returns the section with citation markers and optional plot specs. When the exam asks for a proof, the section gives it in full after "**Dimostrazione richiesta all'esame.**". Plots are drawn by the builder, not by the model, so curves match their formulas.
3. *Clean-up, lint and repair*: some fixes need no model. Function names KaTeX lacks, such as `\cotan` or `\sen`, become `\operatorname{...}`. A formula block reusing a key another section already defines keeps its math and loses the key. A link to a section id the model miscopied points at the section that id was meant for when only one matches, and becomes plain text otherwise. Terminal codes left in model output are removed. Display math is moved out of sentences, and statements are numbered per chapter at compile. A reference to a formula reads "(7.2)" in the reader: a chip in the same chapter, a link to the formula in another chapter, and parentheses the writer put around it are dropped so it never shows as "((7.2))". Formatting problems that break the reader then trigger one repair request; what remains becomes an issue. A placeholder such as `[?]` or `???` is a blocker.
4. *Exam guide*: every chapter whose topics appear in past exams closes with "Come viene chiesto all'esame", written from its classified exam questions. The builder computes the session counts in it ("N of M sessions"), not the model.
5. *Introduction*, *practice* (authentic exam questions re-read from page images, generated exercises up to the topic targets, labeled exam-style practice when a chapter has no real exam questions; question text that would not render gets the same single repair, and exam questions have no hints, as on the day), *extras* (graphs and Python or MATLAB examples where they help, all checked) and an *independent review*.

With the first-chapter gate on (the default), the run stops after chapter 1. Read it, fix what you need, then press **Continue** in the Run panel; the remaining chapters use the same prompts you have now seen working.

## 5. Review

The Review tab lists lint findings, failed checks and reviewer issues, each pointing at the exact text. For each one: edit the text yourself, **Fix selected issues**, or **Accept as is**.

**Fix** applies the fix to the text. Earlier versions stay in the section's history, so you can restore any of them. Before a fix is applied it passes these checks:

- a change that would delete a heading, a formula or another special block, drop a formula key, leave a `:::` fence open, or break a formula is left out, and its issue stays open with the reason;
- a change that adds a blocker or a major lint finding of any kind is reverted, even if it removes others;
- a cheap second model reads each change against the issue and drops any that adds an error or removes more than asked;
- a fix that would remove more than a fifth of the text is not applied; it waits as a proposal in the Manuscript, and so does a fix for a section you edited while it ran.

An instruction you give in the Manuscript ("regenerate with instruction") always becomes a proposal. Proposals never replace your text until you accept them.

**Run review** reads the whole chapter only the first time. After that it reviews only the paragraphs, formulas and boxes written since the last review, such as the text a fix changed; the rest of the chapter is shown to the reviewer for context, and findings outside the new text are dropped. Open issues on text that didn't change stay as they are. A chapter with no new text costs no model call. The reviewer also sees the issues you accepted or dismissed and the ones already fixed, and does not raise them again. Only blockers stop an approved export; majors and minors do not have to reach zero.

Before this, every review re-read the whole chapter and reported a different handful of old passages each time. On Fisica 1, about 80% of the issues in the second and third reviews were in text the earlier reviews had already read, so running a review never brought the count to zero.

**Every finding gets a second opinion** before it reaches the list: another model (the **Second opinion** role, Claude Sonnet by default) re-reads the passage with the sources. It drops findings that are not real, such as a counterexample the setting excludes, and can lower a severity but never raise it. Dropped findings stay visible under **dismissed**, with the reason, and the reviewer is told not to raise them again. If the second opinion can't run, the findings stay as the reviewer wrote them.

**Full review** reviews every section on its own call instead of the whole chapter at once, so fewer problems are missed. It costs about as much as 3 to 5 normal reviews; use it once, before the final export. It replaces the open review issues with what it finds.

Fixes for review issues make the smallest edit that corrects the sentence. The check that decides whether a fix is applied rejects one that adds more than one new sentence of claims or caveats, because those sentences were what the next review found fault with. Program issues (step 6) are the exception: a fix for a thin section or a missing proof may add the material it needs, and a fix for an off-program passage may delete whole subsections, formulas and boxes. A formula it deletes becomes a plain name wherever other sections referred to it.

## 6. Alignment with the program

This step is for books that already exist, including ones written before they had a program. Add the program in Book setup first.

**Check alignment**, in the Review tab, sends one planning call with a digest of the book: headings, statement labels, whether each proof is present, lengths and exam sessions, but not the full text. The report has six groups:

| Group | What it lists | What **Align book** does |
| --- | --- | --- |
| Missing from the book | Program items no section teaches | Adds a section where the check suggests and writes it |
| Too thin for the exam | Items taught more briefly than the exam needs | Opens a review issue, and the fix expands the section |
| Proofs the exam asks | Proofs the exam asks that the section doesn't give | Opens a review issue, and the fix adds the proof |
| Outside the program | Sections and passages the exam doesn't ask and the rest of the book doesn't need | Removes a section, or keeps it with a note, as Book setup says. A passage becomes a review issue, and its fix cuts it |
| Order | A section placed before one it depends on | Nothing: move the section in the outline yourself |
| Exam guides | Chapters without "Come viene chiesto all'esame" | Adds the guide and writes it from the exam questions |

Ids, keys and quotes in the report that don't match the book are dropped. A new report starts with every finding selected that Align book can apply. Deselect the ones you disagree with, then press **Align book**. A new section in a finished chapter gets its evidence, a draft and a chapter review, while the chapter's introduction, practice and graphs are not redone.

A section needed to understand the in-program parts counts as needed, even when it is outside the program. When a removed section was linked from other sections or they used its formulas, those links become their plain label and the formula references become the formula's name. Generated exercises about a removed section leave the book with it. A past exam question still in the book keeps its section, which is then kept with a note, and so is a chapter's only section.

Removing a section only writes a new outline revision, so its text stays in the database. The report lists every removed section with a **Put back** button that returns it to where it was. The links that became plain text don't come back with it.

## 7. Export

**Validate** runs the reader's own validator plus the builder's lints on the compiled book. Each finding names the section or question it comes from and links to it. **Fix with AI** sends the errors and warnings to the same fix as **Fix selected issues**: sections get a guarded fix, and questions are rewritten and checked again. Findings in generated files, such as a chapter's exam page, go away when the question behind them is fixed. **Approve and export** is available when no blocker is left; **Export draft** always works and is named `-draft`. Every export is reopened and compared with what was compiled before it is offered for download.
