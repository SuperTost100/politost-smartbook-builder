# How a book is made

Each step below is a button in the app. Steps run in the background as a *run*; the Run panel shows every task, what it waits for and what it cost.

## 1. Sources

Add notes, textbooks, exercise collections and past exams, and mark each as Theory, Exercises, Exams or Mixed. **Prepare** then:

- splits every file into pages and marks pages whose text layer is garbled or empty (math in LaTeX-made PDFs, handwriting, scans);
- keeps each source's own table of contents, or reconstructs one from the page headings and labels it *inferred*;
- splits exam files into sessions and exercises ("Esame del 25 gennaio 2023 – turno 1", "Esercizio 2") and skips duplicate copies of a session;
- uploads the sources to the book's NotebookLM notebook (once per file version);
- builds the topic map, assigns every question to its topics and counts the distinct exam sessions per topic.

## 2. Outline

**Generate outline** asks the planning model for a common index: chapters, sections, objectives, depth and the topics each section covers. Topics in many sessions get *deep* sections and more exercises; topics in none keep a section and the baseline exercises unless you exclude them with a reason. Edit anything, then **Approve outline**. Drafting always uses the approved version.

## 3. Drafting

**Generate book** works chapter by chapter:

1. *Evidence*: NotebookLM (or the local reader) answers a question about the section by quoting the sources. Each quote is located on its page; unlocated quotes are dropped. The most cited garbled pages are transcribed by a vision model so the writer sees clean formulas.
2. *Writing*: the writer gets the section's objectives, the chapter plan, summaries of earlier sections, known formula keys, the notation and the evidence, and returns the section with citation markers and optional plot specs. Plots are drawn by the builder, not by the model, so curves match their formulas.
3. *Clean-up, lint and repair*: some fixes need no model. Function names KaTeX lacks, such as `\cotan` or `\sen`, become `\operatorname{...}`. A formula block reusing a key another section already defines keeps its math and loses the key. Display math is moved out of sentences, and statements are numbered per chapter at compile. Formatting problems that break the reader then trigger one repair request; what remains becomes an issue.
4. *Introduction*, *practice* (authentic exam questions re-read from page images, generated exercises up to the topic targets, labeled exam-style practice when a chapter has no real exam questions; question text that would not render gets the same single repair, and exam questions have no hints, as on the day), *extras* (graphs and Python or MATLAB examples where they help, all checked) and an *independent review*.

With the first-chapter gate on (the default), the run stops after chapter 1. Read it, fix what you need, then press **Continue** in the Run panel; the remaining chapters use the same prompts you have now seen working.

## 4. Review

The Review tab lists lint findings, failed checks and reviewer issues, each pointing at the exact text. For each one: edit the text yourself, **Fix selected issues**, or **Accept as is**.

**Fix** applies the fix to the text. Earlier versions stay in the section's history, so you can restore any of them. Before a fix is applied it passes these checks:

- a change that would delete a heading, a formula or another special block, drop a formula key, leave a `:::` fence open, or break a formula is left out, and its issue stays open with the reason;
- a cheap second model reads each change against the issue and drops any that adds an error or removes more than asked;
- a fix that would remove more than a fifth of the text is not applied; it waits as a proposal in the Manuscript, and so does a fix for a section you edited while it ran.

An instruction you give in the Manuscript ("regenerate with instruction") always becomes a proposal. Proposals never replace your text until you accept them.

**Run review** reads the whole chapter only the first time. After that it reviews only the paragraphs, formulas and boxes written since the last review, such as the text a fix changed; the rest of the chapter is shown to the reviewer for context, and findings outside the new text are dropped. Open issues on text that didn't change stay as they are. A chapter with no new text costs no model call. The reviewer also sees the issues you accepted or dismissed and the ones already fixed, and does not raise them again. Only blockers stop an approved export; majors and minors do not have to reach zero.

Before this, every review re-read the whole chapter and reported a different handful of old passages each time. On Fisica 1, about 80% of the issues in the second and third reviews were in text the earlier reviews had already read, so running a review never brought the count to zero.

**Every finding gets a second opinion** before it reaches the list: another model (the **Second opinion** role, Claude Sonnet by default) re-reads the passage with the sources. It drops findings that are not real, such as a counterexample the setting excludes, and can lower a severity but never raise it. Dropped findings stay visible under **dismissed**, with the reason, and the reviewer is told not to raise them again. If the second opinion can't run, the findings stay as the reviewer wrote them.

**Full review** reviews every section on its own call instead of the whole chapter at once, so fewer problems are missed. It costs about as much as 3 to 5 normal reviews; use it once, before the final export. It replaces the open review issues with what it finds.

Fixes for review issues make the smallest edit that corrects the sentence. The check that decides whether a fix is applied rejects one that adds more than one new sentence of claims or caveats, because those sentences were what the next review found fault with.

## 5. Export

**Validate** runs the reader's own validator plus the builder's lints on the compiled book. Each finding names the section or question it comes from and links to it. **Fix with AI** sends the errors and warnings to the same fix as **Fix selected issues**: sections get a guarded fix, and questions are rewritten and checked again. Findings in generated files, such as a chapter's exam page, go away when the question behind them is fixed. **Approve and export** is available when no blocker is left; **Export draft** always works and is named `-draft`. Every export is reopened and compared with what was compiled before it is offered for download.
