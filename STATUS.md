# Status

Last updated 7 October 2026.

## What works

The full V1 pipeline runs end to end on real course material. It was tested on the Analisi 1 sources (4 sets of notes, 11 years of PoliTo written exams, a 521-page quiz collection: 1,063 pages in total).

| Step | Result on Analisi 1 |
|---|---|
| Prepare | 16 files read, 174 exam exercises split into 83 sessions, 720 quiz items stored, 32 topics. Exam frequency is plausible: *studio di funzione* appears in 74 of 83 sessions, limits and continuity in about 40 |
| Plan | Opus proposed 11 chapters and 44 sections in teaching order, with deep sections where the exams concentrate |
| Generate (chapter 6, *Limiti notevoli e confronto asintotico*) | 3 sections and an introduction (36k characters), 12 numbered formulas, 2 figures, 2 interactive graphs, 1 Python example that ran in Pyodide, 8 authentic exam questions re-read from page images, 6 generated exercises |
| Evidence | NotebookLM returned 17–18 notes per section; every note was located on its source page |
| Review and correction | The reviewer (GPT-6-Sol) found real errors: the order of infinitesimals stated backwards, the sequence characterization without x_n ≠ x_0, x! in a hierarchy over the reals. Three rounds of *Fix selected issues*, reviewed and accepted, closed every blocker |
| Export | Approved `.ptsb` (61 KB). It opens in the actual PoliTost reader with all sections working and 0 formula errors |

Wall-clock time on this machine: Prepare about 25 minutes (most of it was the Antigravity bottleneck, since fixed), outline 1 minute, one chapter 11 minutes, three correction rounds about 15 minutes.

Model use for everything above, including the failed calls caused by bugs that are now fixed:

| Role | Model | Calls | Input tokens | Output tokens |
|---|---|---|---|---|
| Writer | Claude Sonnet 5 | 32 (6 failed on a schema bug) | 350k | 191k |
| Planner | Claude Opus 5.5 | 1 | 6k | 10k |
| Reviewer | GPT-6-Sol | 36 | 619k | 37k |
| Bulk (classification, extraction) | GPT-6-Luna | 65 | 1.07M | 103k |
| Vision | GPT-6-Luna | 24 | 332k | 14k |
| Bulk, before the switch | Gemini 3.8 Flash (Antigravity) | 5 | 488k | 225k |

About 80% of the Luna bulk tokens went to classifying exam questions once for the whole book. One chapter needs roughly 15 Sonnet calls and 15 Sol calls including corrections.

## Decisions made while you were away

- **Antigravity became a fallback.** Gemini through Antigravity took 4–5 minutes and about 90k input tokens per call, because the CLI runs a full agent each time. Batch roles (bulk, local evidence) now default to GPT-6-Luna low, at about 20 seconds per call.
- **Graphs ship as Plotly data.** The reader's `function` graphs only understand `x`, digits and `+ - * / ^`, so `sin(x)` draws an empty curve. The reader's own example book has this bug too. The builder samples curves with a whitelisted evaluator and ships them as `plotly` graphs, which the reader renders.
- **Figures are plotted, not drawn by the model.** The writer returns a plot spec, and the builder renders the SVG, so the curve matches the formula. Captions are plain text, because the reader prints them as text, and they are numbered `Fig. 6.1`.
- **Exports contain only chapters with text.** The chapters keep their outline numbers, so formulas stay `6.x` as more chapters are written. Links into chapters not yet written become plain text, with a minor warning.
- **Missing official solutions are written and checked.** Two 2024 sessions were published without solutions; the writer solves them and the reviewer checks the result.
- **Unreadable exam questions leave the book.** The issue stays open until you type the question in.
- **Blockers mean a different result.** A solution is a blocker only when the independent result differs. Gaps in the reasoning keep the severity the reviewer gives them.
- **I approved in your place.** You asked for no human in the loop, so I approved the outline and accepted the AI proposals. I read the proposals before accepting them.

## Fix and review loop (changed 7 October, evening)

Writing the remaining 10 chapters worked, but fixing them did not converge. *Fix selected issues* left every fix as a proposal, and none was accepted. 288 proposals were written, a later fix replaced 243 of them, and the reviews kept re-reading the unchanged first draft. Each pass found 8 to 9 issues per chapter, more than half of them the same passages as before. The loop used about 10M input tokens.

What changed:
- A fix is applied to the text directly, after rule guards (no lost headings, formulas or `:::` fences, at most 3 deleted paragraphs, no new lint errors) and a cheap Luna check of each change. Changes that fail are dropped and their issue stays open with the reason. A fix that would remove more than a fifth of a section stays a proposal.
- *Run review* skips chapters that did not change, tells the reviewer which sections changed, and gives it the issues already fixed, dismissed or accepted.
- Model output is cleaned of control characters that had eaten LaTeX backslashes (`$+\x1finfty$`).
- A call that times out moves to the role's fallback model. Fisica 1's Prepare had hung three times on Luna.

On the Analisi book I accepted 39 of the 45 waiting proposals after automatic checks. I rejected 6 that lost text: one deleted the whole *Problema di Cauchy* subsection. I also fixed a duplicated Weierstrass formula key and an exam question using `\cotan`.

## Open issues on the Analisi book

Four issues were accepted as exceptions and are visible in the Review tab:
- the substitution principle should also require f, g ≠ 0 in a punctured neighbourhood (a real refinement for your pass);
- the list of reference functions does not cover x₀ = −∞;
- the reviewer read ℝ\* as "nonzero reals". The book's notation defines it as the extended line, and the reviewer now receives that notation;
- one June 2024 question could not be read from its scan, so it is not in the book.

Authentic exam questions have no hints because the official papers give none. Generating hints is not implemented yet.

## Not done or only partly done

- **Outside research** (the per-book "verified outside material" option) is stored but no research step uses it yet.
- **Licensed photographs and raster image generation** are not implemented. Figures are function plots or files you import.
- **MATLAB examples** are not generated. Python examples are, and they run in a permission-restricted Node child process with Pyodide. Node 24 cannot restrict network access, which the comment in `pipeline/python.ts` documents.
- **Quiz items** (720 multiple-choice questions) are stored but not classified or imported into practice.
- **DOCX, PPTX, Markdown and web links** pass their unit tests (LibreOffice conversion, safe fetch) but were not part of the real book run.
- **Autosave** is explicit (Save block, or Ctrl/Cmd+Enter) rather than debounced, so each save is one revision.
- **The NotebookLM login** now lives in a Chrome profile on the devbox (signed in through T3's browser on 7 October), so `nlm auth refresh` renews it headlessly. A cron job runs that every 6 hours. If Google ever forces a new sign-in, repeat the steps in docs/SETUP.md.

## Independent reviews

GPT-6.1-Sol reviewed each milestone through `codex exec`.
1. Backend after the first implementation: 18 findings, one of them a blocker (Python isolation). All were fixed with regression tests (commit a12a4e2).
2. The fixes, the acceptance-run changes and the web app. It confirmed 16 of the 18 earlier fixes and found 15 new issues (8 major, 7 minor, no blockers). The worst were these: a manuscript refresh could discard an unsaved block edit, accepting an old proposal could overwrite newer edits, and *Verify again* re-imported questions you had repaired. All 15 are fixed with regression tests, along with the 2 incomplete earlier fixes.

## Tests and CI

`npm test` runs 110 content tests and 183 service tests. `npm run test:e2e` runs 47 Playwright tests against a real service with no model calls. GitHub CI runs typecheck, unit tests, the web build and the end-to-end tests on the Node version in `.nvmrc` (24), and it is green.

## Your running instance

The service runs on the devbox in LAN mode with the default data folder. Open it from your Mac with the token link printed at startup. It is in `/tmp/sb.log`, and the token is stored in `~/.local/share/politost-smart-builder/lan-token`. The Analisi book is there with all 11 chapters written. Its approved export of chapter 6 is under *Export*; the full book is being reviewed and fixed.

To restart it yourself:

```bash
cd ~/.t3/projects/politost-smartbook-builder
npm start -- --lan
```
