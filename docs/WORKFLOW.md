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
3. *Lint and repair*: formatting problems that break the reader trigger one repair request; what remains becomes an issue.
4. *Introduction*, *practice* (authentic exam questions re-read from page images, generated exercises up to the topic targets, labeled exam-style practice when a chapter has no real exam questions), *extras* (graphs and Python examples where they help, all checked) and an *independent review*.

With the first-chapter gate on (the default), the run stops after chapter 1. Read it, fix what you need, then press **Continue** in the Run panel; the remaining chapters use the same prompts you have now seen working.

## 4. Review

The Review tab lists lint findings, failed checks and reviewer issues, each pointing at the exact text. For each one: edit the text yourself, **Fix selected issues** to get an AI proposal, or **Accept as is**. Proposals never replace your text until you accept them.

## 5. Export

**Validate** runs the reader's own validator plus the builder's lints on the compiled book. **Approve and export** is available when no blocker is left; **Export draft** always works and is named `-draft`. Every export is reopened and compared with what was compiled before it is offered for download.
