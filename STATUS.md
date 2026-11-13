# Status

Smart Builder 0.5.0 alpha, as of 13 November 2026.

## What works today

The whole pipeline runs from sources to an approved `.ptsb` that the Smartbook reader opens: Prepare, course program, outline, drafting with evidence, practice, review and fix, alignment with the program, validation and export. [How a book is made](docs/WORKFLOW.md) describes each step.

The owner's instance holds five real books: Analisi Matematica 1, Fisica 1, Chimica di base, Algebra lineare e geometria and Calcolo numerico (MATLAB). Analisi 1 is the one taken furthest: all 11 chapters were written by 8 October, with no open review issue and an approved export. It was built from 4 sets of notes, 11 years of PoliTo written exams and a 521-page quiz collection (1,063 pages in all). Its first chapter run in early October showed what the pipeline did and cost then:

| Step | Result on Analisi 1 |
|---|---|
| Prepare | 16 files read, 174 exam exercises split into 83 sessions, 720 quiz items stored, 32 topics. *Studio di funzione* appears in 74 of 83 sessions |
| Plan | 11 chapters and 44 sections in teaching order, with deep sections where the exams concentrate |
| Generate (chapter 6) | 3 sections and an introduction (36k characters), 12 numbered formulas, 2 figures, 2 interactive graphs, 1 Python example, 8 exam questions re-read from page images, 6 generated exercises |
| Review and correction | The reviewer found real errors, such as the order of infinitesimals stated backwards. Three rounds of *Fix selected issues* closed every blocker |
| Export | Approved `.ptsb` of 61 KB that opens in the reader with all sections working and 0 formula errors |

Prepare took about 25 minutes on that run, one chapter 11 minutes and three correction rounds about 15 minutes.

### Acceptance run of 11 November

A one-chapter Elettrotecnica book was built on a clean data folder with the default model routes and local evidence, from Markdown notes, an exam file and a pasted program, with the outline trimmed to one chapter by hand. The full report is not in the repository. Its first part, which ran Prepare, Program, Plan and most of Generate, measured this:

- The four sections (881, 961, 810 and 657 words) had correct formulas and worked examples, and the Bode magnitude and phase were drawn from plot specs on a logarithmic frequency axis with the right curve.
- Both drawn circuits had the right topology. The writer's self-check corrected two of the three sections it ran on.
- A solution planted with a factor of 2π missing was caught three ways: by the independent solver, by the Python recomputation in the sandbox, and by a note that part b of the same solution used the right value.
- Exam sessions were read with one call each instead of one per question, and a small Codex call carried about 11.7k input tokens, 29% less than the 16.5k measured before the lean Codex home.
- The run stopped in Generate when the Codex 5-hour window filled. It surfaced problems that the next pull request fixed, among them exam text stored with a literal `\n`, Markdown exam files that did not split, a solutions heading with a qualifier, questions left behind by a deleted source, sentences about "the notes" in the book text, a renamed symbol, and 26 failed calls in 27 seconds on a provider at its limit.

The second part ran on the code of PR #84, with the same data folder and the same routes. It went through Review, Fix, a second Review, Check alignment and an approved export, and measured this:

- **The loop converged in one fix round.** After the second Review the book had no open issue, and the approved export passed the validator with no finding.
- **Cost of the chapter.** The whole chapter took 93 successful model calls and about 1.26M input tokens, and Generate took 72 of those calls and 1.01M. The checks of the 40 exercises and exam questions were 47% of Generate's input, more than drafting and the first chapter review together.
- **The convergence came from lint and the solution checks.** The chapter review reported no issue in either round. It did not see the stray word a fix had left at the end of an exam solution, the symbol `f_t` where the papers write `f_c`, or the wrong cut-off label in a circuit figure.
- **What the run covers.** It is one small chapter of an electrical engineering book with three sections, so the number of rounds and the cost say little about a larger book.

The problems this run found were fixed afterwards in PR #84 and PR #86. Neither fix has been through a second real run.

## What 0.4.0 added

- **Figures for any subject.** A book has a subject area, and the area decides which figure kinds the writer may use. Anything the builder has no drawer for is a drawing, written by an illustrator model as Typst or schemdraw code, compiled offline, repaired and checked once against its own picture. Function plots take logarithmic axes, and every figure is shown on the reader's light plate in dark mode. See [Figures](docs/WORKFLOW.md#5-figures).
- **Electronics.** Circuits, logic networks, timing diagrams, Karnaugh maps and block diagrams as drawings, circuit symbols in the American or the European style, Bode plots as two plots on the same log axis, and the symbols the exam papers use (`f_c`, `v_{out}`) passed to the writer.
- **Drafting.** The sections of a chapter are written in order, the text comes back outside JSON, the writer checks its own section once, and a worked example is asked for only where the section teaches a method.
- **Review and fix loop.** A review of changed text reports only blockers and majors. Fixes apply directly, after guards. A review says when it left nothing serious open.
- **Cost.** Exam sessions are read in one call, numeric answers are recomputed in a sandbox, only exams are classified, and Codex and web calls run in lean private homes.
- **Screens.** Book setup (course program, subject area, figure policy, circuit symbols, generation options), Sources (the exam split result with Split with AI), Review (alignment with the program), Connections (usage per provider, Codex usage windows) and the Manuscript's figure dialog and **Add figure**.
- **Existing books.** They need no migration. A book without a subject area gets one inferred from its subject and title, and figures stored before 0.4.0 look right on the light plate. A Markdown exam file prepared before 0.4.0 keeps the questions it was split into, because Prepare reuses the questions of a file that has any and does not split it again. To get the new split, delete the file and upload it again, or press **Split with AI** on it, which replaces its questions but is refused when any of them was edited or checked. A deleted file takes its questions with it, except the ones you edited and the ones a chapter uses that were already read from the pages. Those stay in the book without a source, and the new upload stores its own copies of them.

## What 0.4.1 fixed

0.4.1 changes no feature. It holds one line of text on Sources and the fixes from CodeRabbit's review of the pull requests that 0.4.0 merged before they were reviewed.

- **An excluded source leaves the evidence too.** When you exclude a source after its evidence was gathered, its quotes and pages are no longer sent to the writer, and an index or split task still queued for it is skipped. The cost: the evidence reader's summary is left out of the writer's packet while such a source is excluded, because nothing records which sources the summary drew on, so the section is written from the quotes of the other sources. A copy already uploaded to NotebookLM stays in the notebook until you delete it there.
- **Stricter check of uploaded SVG files.** An SVG that hides a `script`, `foreignObject` or embedding element behind a namespace prefix, or uses an element name with a character outside ASCII, is refused.
- **Fixes can no longer drop a figure or one of two identical headings.** A figure block is deleted only when a figure problem is open. A fix or correction that removes one of two equal headings, formula keys or images is refused, and so is a correction that deletes a whole paragraph.
- **Text around the metadata of a model answer is no longer lost.** An answer with text before or after its metadata JSON is sent to the repair turn instead of being accepted with the text dropped.
- **Two exam turns of one day stay two sessions.** A generic heading takes "Turno" and its letter or number from its own line, so Turno A and Turno B are not merged as duplicates. The session name of an exam file with a printed turn changes the next time that file is split.
- **Remove figure removes only the block you opened.** A picture that sits in two blocks stays in the other one. The request now needs the block index, which only the web app sends.
- **Smaller corrections.** A drawing is not added after a block you removed while it was being drawn, a graph is shown as visible only when a point lies in the x and y range together, `x^0.5` stays as written in a caption, and a unit such as km/h or L is no longer reported as a mismatch against an SI value.
- **Sources and the figure dialog.** Sources says that adding a file or a link starts Prepare by itself and that Prepare reads it with the AI models. The figure dialog now says when another tab removed the open figure, and keeps the redraw notice when the drawing became an image.

## What 0.5.0 alpha changed

From this release the version carries a stage name, so 0.5.0 alpha is the first alpha. The earlier releases keep their names. The change itself is about the formatting of the text a model writes.

- **Headings come out at the right level.** A section heading a model wrote as `##` or `####` is corrected to `###` by the builder when the text is stored, so you no longer fix them by hand. Code, `:::` blocks and display math are left alone.
- **Display math is laid out by code.** There is no blank line inside a `$$` formula, and a display formula that follows a sentence directly gets blank lines around it.
- **Lint reports the text as it is stored.** Before, a `math-mixed` note could describe the model's raw answer after the builder had already fixed it. Now every note is about the text you see.
- **Formatting notes are settled without a model.** *Fix selected issues* closes the formatting notes (`math-mixed`, `math-blank-line` and `heading-level`) by formatting the text in code, so a fix that holds only such notes makes no model call. When it holds other notes too, the model is not asked about the formatting ones. Before, a model acted on notes about text that was already right and could damage a formula.
- **A book that is already written can be repaired.** `npm run normalize-text -- --project <id> --dry-run` lists what the formatter would change. Without `--dry-run` it writes the changes. It skips sections you edited by hand, unless you pass `--include-hand-edits`.
- **What the formatter cannot repair:** words that a fix model already changed, such as a deleted comma or a duplicated line. Those stay as they are until you correct them.

## Decisions that still explain the design

- **Antigravity is a fallback.** Gemini through Antigravity took 4 to 5 minutes and about 90k input tokens per call, because the CLI runs a whole agent each time. Batch roles default to GPT-6-Luna.
- **Graphs ship as Plotly data.** The reader's `function` graphs understand only `x`, digits and `+ - * / ^`, so `sin(x)` draws nothing. The builder samples curves with a whitelisted evaluator and ships `plotly` graphs.
- **Exports contain only chapters with text.** Chapters keep their outline numbers, so formulas stay `6.x`. Links into chapters not yet written become plain text with a minor warning.
- **Missing official solutions are written and checked.** The writer solves the exam question and the reviewer checks it.
- **Unreadable exam questions leave the book** until you type the question in.
- **A solution is a blocker only when the independent result differs.** Gaps in the reasoning keep the severity the reviewer gives them.
- **Fixes apply directly.** On 7 October, fixes left as proposals never converged: 288 proposals were written, a later fix replaced 243 of them, and the loop used about 10M input tokens. Fixes now go through guards and a cheap check, and a fix that would remove more than a fifth of a section stays a proposal. On 11 November, reviews and fixes had used 75M of 132M input tokens on four books, which led to the narrower reviews of 0.4.0.
- **A review reads only what changed.** Every review used to re-read the whole chapter and report a different handful of old passages each time. On Fisica 1, about 80% of the issues in the second and third reviews were in text that earlier reviews had already read, so running a review never brought the count to zero.
- **Exam questions have no hints**, as in the real exam.

## Known limits

Not working or not tested:

- **Real exam papers of an electronics course** have not been through the splitter. It was tested on Analisi, Fisica and Chimica papers and on a paper written for the acceptance run.
- **A lab example you edit by hand ships unchecked.** An edited graph is checked again when you save it, but an example goes back to draft because running it needs the sandbox, and a draft example is exported.
- **The builder's look follows an older version of the reader's design.** The colours, type and figure plate follow the reader's tokens, but components added to the reader since then are not in the builder.
- **Four calls still return long text inside a JSON string**: the generated exercises, the written-out missing solution, the **Fix with AI** rewrite of a question, and the chapter introduction. A backslash before `n` or `t` in them could still be misread as a line break. The draft, its repair, the lab example, the fixes, the exam readers and the formatting repair of question text answer in plain text.
- **The reviewer does not read exam questions.** A wrong exam solution is found by the solution check, not by the chapter review.
- **DOCX, PPTX, Markdown and web links** pass their unit tests (LibreOffice conversion, safe fetch) but were not part of the real book runs. A Markdown exam paper was split in the acceptance run only.
- **Drawings and photos are checked by a model, not by a person.** A drawing can compile and still be wrong in a detail, so look at each one. In the acceptance run both circuits had the right wiring, and one had a doubled wire next to the input.
- **The sandbox for Python, MATLAB and drawings** cannot block the network on Node 24, and it caps memory only where `/proc` exists (Linux).
- **Quiz items** are examples of level and style, not book content, because the reader has no multiple-choice format. The Fisica quiz file splits into 573 items but has no answers: its right options are only highlighted in the PDF.
- **Outside research** is a per-section action ("Find outside sources") and not part of Generate. AI image generation is not implemented.
- **A book with Python on may get no lab example.** The picker chose none in the acceptance run, although a Python book is meant to get one per chapter.
- **The number of rounds to a clean review** was measured on Analisi (three rounds after the fix change) and on the small Elettrotecnica chapter (one fix round), and is not known for the other books yet.
- **The exam header clean-up knows a fixed list of labels**: Corso, Corso di Laurea, Prova, Durata, Nome e cognome, Matricola, Data, Docente and Anno accademico. A paper whose header table uses other labels keeps those cells at the end of the previous paper's last solution.
- **The new plain-text exam reader has not read a real session yet.** Its parser and its guard have tests, but the acceptance run used sessions read before the change.
- **The NotebookLM login** on the owner's server lives in a Chrome profile that a cron job refreshes every 6 hours. If Google forces a new sign-in, repeat the steps in [Setup](docs/SETUP.md#notebooklm).

Small shortcuts, each with a comment in the code that says how to upgrade it: a proof is recognised by its label (`pipeline/align.ts`), a symbol without a subscript is left out of the exam symbols (`pipeline/exam.ts`), a heading of an unusual shape is not shown to Split with AI (`pipeline/examSplit.ts`), a figure issue that quotes a paragraph counts as asking for a missing figure (`pipeline/review.ts`), and enrichment edits are told apart by comparing stored texts (`pipeline/enrich.ts`).

## Tests and CI

`npm test` runs 231 content tests (229 pass and 2 are skipped because they need two real books that are not in the repository) and 925 service tests. `npm run test:e2e` runs 220 Playwright tests against a real service with no model calls. GitHub CI runs typecheck, unit tests, the web build and the end-to-end tests on the Node version in `.nvmrc` (24).

The figure renderers have a snapshot test, and every code block in the drawing cheat sheets is compiled by a test, so a sheet cannot go stale.

## Dependencies

| What | Version |
|---|---|
| Node | 24 (`.nvmrc`), 22.13 or newer works |
| TypeScript | 7.0 |
| Fastify | 5.12 |
| React, Vite | 19.3 and 8.3 |
| content-core | 0.5.1 |
| KaTeX | 0.19 |
| cli-funnel | 0.9.1 |
| numbl | 0.4.22 (the reader pins the same version) |
| MuPDF | 1.28 |
| Pyodide | 314.0 |
| Typst compiler (`typst-ts-node-compiler`) | 0.7.0, which bundles Typst 0.14.2 |
| resvg | 2.6.2 |
| openchemlib | 9.26 |

The Typst packages and Python wheels of drawn figures are pinned by SHA-256 in `scripts/fetch-figure-packages.mjs` and updated together with the compiler.

Model calls go through cli-funnel. When an answer fails validation on Claude Code or Codex, the repair turn continues the same conversation and sends only the problems. Claude Code and Codex report their limits with a reset time, which sets how long a provider stays out of first place and how long the queue waits, and Codex's usage windows are read at most once a minute.

## Independent reviews

GPT-6.1-Sol reviewed each milestone of the first build through `codex exec`. The first review of the backend found 18 issues, one a blocker (Python isolation). The second confirmed 16 of the 18 fixes and found 15 new issues, no blocker, and all were fixed with regression tests. Pull requests since then are reviewed by CodeRabbit, which is asked for on each one.

## Running the owner's instance

The service runs on the devbox as the systemd user service `smartbuilder.service`, in LAN mode with the default data folder. It has been a service since 13 October, so it survives a reboot. After pulling a new version, restart it with `systemctl --user restart smartbuilder`, which rebuilds the web app first. The access token is in `~/.local/share/politost-smart-builder/lan-token` and the log is `service.log` in the same folder.
