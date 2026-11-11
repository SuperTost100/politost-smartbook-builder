# Architecture

PoliTost Smart Builder is one Node process: a Fastify API, a durable task queue on SQLite, and a React app served as static files. Model calls go through installed CLIs via [cli-funnel](https://github.com/SuperTost100/cli-funnel), so they count against the author's existing subscriptions.

```
apps/web        React app (Vite). Talks only to /api.
apps/service    API, queue, pipeline handlers, extraction, model routing, evidence.
packages/domain Shared types and the HTTP contract (src/api.ts).
packages/content Pure functions: source dialect -> reader Markdown, lints, plots, .ptsb.
```

## Content model

The canonical text of each outline section is PoliTost Markdown in a *source dialect*: numbered formulas carry a symbolic `key` instead of `id="N.M"`, references use `{{formula:@key}}` and `ref:section/<id>`, and the `## pN | Title` heading is added by the compiler. Renumbering chapters or moving sections never edits stored text. The same holds for statement labels: the compiler numbers Teorema, Definizione, Esempio and the other kinds per chapter (`Teorema 4.2`) and follows references to them, so writers leave them unnumbered. See `packages/domain/src/index.ts`.

Every edit creates a revision. AI output that arrives after a human edit becomes a *proposal* instead of replacing the text, and so does any answer to an author's instruction. A fix for review issues is applied as a new revision (the old text stays in the history) unless the section changed meanwhile or the fix would remove much of it.

## Queue

`apps/service/src/queue/queue.ts`. Tasks have dependencies, a pool (provider) with a concurrency limit, leases, bounded retries with backoff, quota waits that don't consume attempts, and author waits (`waiting_for_user`) for gates and logins. On startup, tasks that were running are requeued; handlers check committed results before calling a provider again.

A run that ends as failed also ends its tasks that were still queued behind the failure, as cancelled with the note "Not run: an earlier task failed." Retry puts them back. A task that hits a usage limit with no fallback to use waits for the provider's reset time and runs again, and the wait does not use up its attempts.

## Model calls

`apps/service/src/llm/index.ts`. `runRole` picks the route of a role, takes a slot of the route's provider, and calls the CLI through cli-funnel.

- **Limits.** The concurrency setting of a provider counts every call to it, whichever role pool, fallback or second turn it comes from (`llm/slots.ts`). The queue's pool limits stay as they are. A call waits for its slot before its timeout starts, and a waiting call still stops when its task is cancelled.
- **Timeouts.** Checker, bulk, vision, evidence and editor calls stop after 3 minutes and fall back. The other roles get 10 minutes, and so does any role on Antigravity, which runs a whole agent per call. In 30 days of live usage the slowest healthy call of the short roles took 111 s, except one checker call at 254 s.
- **Lean homes.** A Codex call carries about 5,300 input tokens of the owner's `AGENTS.md` and skills. The service therefore runs Codex with its own `CODEX_HOME` under the data folder, which holds only a link to the real `auth.json` (`llm/homes.ts`). A token refresh still reaches the real login. Without an `auth.json` (a keyring login) or where links cannot be made, Codex keeps its default home and the log says so once. Web calls of the `research` role run Claude Code the same way, with its own `CLAUDE_CONFIG_DIR` that holds only the credentials link, and with every built-in tool except WebSearch and WebFetch left out of the model's context. Claude calls without the web already load nothing.
- **Usage rows.** Each call stores its tokens (also cached and cache-writing tokens when the provider reports them), whether it ended in a quota, timeout, truncation, abort or other error, its number within the `runRole` call (a repair turn or a fallback is 2) and whether it ran on the fallback route.
- **Stay on Claude.** The book option `noClaudeFallback` removes the fallback of every role that starts on Claude, so a Claude usage limit waits for its reset. It is off by default and has no screen yet. Set it with `PATCH /api/projects/<id>` and `{"options": {"noClaudeFallback": true}}`.
- **Conversations.** `openRole` makes the first call exactly as `runRole` does (route choice, fallback, cool-downs, timeout, slot, private home, usage row) and returns `{ result, send, close }`. `send(prompt, { images? })` continues with the model that answered. In a live session (Claude Code and Codex keep their process) it sends only the message, and a PNG can go with it, which both providers accept on a turn of an existing session. Without a live session it starts a new conversation that carries the system prompt, the first prompt, the last answer (cut at 12,000 characters) and the message. A follow-up never changes route. When its route fails it throws a `FollowUpError`, a `TaskError` with the kind and wait of the failure, so the caller can keep what it already has. A caller abort passes through unchanged. Each follow-up is a usage row with the next attempt number, has the role's timeout and takes a provider slot only while it runs, so a caller that works between turns does not block the provider. `runRole` is `openRole` followed by `close()`. A follow-up with images on a route that cannot read them is refused before any call.
- **Parsed answers.** `parse: (text) => { ok: true, data } | { ok: false, problem }` is the option for an answer that is not JSON. It gets the text with only terminal codes, control characters and tool-call markup removed (`sanitizeModelCode`), so the caller cleans the rest. When it rejects, `runRole` sends one repair turn with the problem and asks for the full corrected answer in the same format. A second rejection throws the same `TaskError` as a failed schema. No provider JSON schema is sent, and `schema` and `parse` cannot be used together.
- **Long text outside JSON.** The section Markdown, the repaired section and the lab example's code are not JSON strings. The answer is the text, then a line holding only `<<<META>>>`, then one JSON object with the other fields (`llm/body.ts`, `bodyParser`, used through the `parse` option). A draft's JSON holds `figures`, `noFigureReason` and `summary`, and a lab example's holds `id`, `title`, `description` and `expectedOutput`. The repair answer is the text alone. The parser splits at the last separator line, checks the JSON with the zod schema of the small fields and reports a missing separator, unreadable JSON, an empty text or a text with an unmatched code fence as the problem of the repair turn. A fence round the whole answer is removed first. The body is cleaned only of what never belongs in it (terminal codes, control bytes, tool markup, `sanitizeModelMarkdown`), plus the names KaTeX lacks (`\cotan`, `\sen`), so a line break in it is a line break and `\nu`, `\neq` and a row that starts with `i_1` stay as written. A JSON string had to be guessed back into LaTeX, which turned a break before `u` or `i` into `\nu` or `\ni`. The metadata keeps the sanitising of JSON strings. No provider JSON schema is sent for these calls, so the draft prompt carries the schema of the figures. Stored drafts and the web app see the same data as before. The chapter introduction and the other calls still answer in JSON.

Use `withRole`, which closes the conversation in a `finally`, so a throwing callback cannot leak the process. The funnel closes a session that sits idle for a minute, but that is only the backstop. Follow-ups send no response schema, so they are plain text.

```ts
// A writer self-check: one more message in the conversation that wrote the section.
const text = await withRole(ctx, { role: 'writer', system, prompt, parse: parseSection }, async (talk) => {
  try {
    const reply = await talk.send('Check your hypotheses and computations. Answer OK, or the corrected text.');
    return reply.text.trim() === 'OK' ? talk.result.text : reply.text;
  } catch (err) {
    if (err instanceof FollowUpError) return talk.result.text; // keep what we have
    throw err;
  }
});
```

```ts
// A drawing step: a compile error, then the rendered picture, go back in the same conversation.
await withRole(ctx, { role: 'vision', system, prompt: askForDrawing }, async (talk) => {
  const error = compile(talk.result.text); // the caller's compiler
  const fixed = error ? await talk.send(`It does not compile:\n${error}\nSend the full corrected source.`) : talk.result;
  const verdict = await talk.send('This is your picture. Check it. Answer OK, or the corrected source.', { images: [render(fixed.text)] });
});
```

## Drafting

`apps/service/src/pipeline/draft.ts` (`sectionDraft`) and `prompts.ts` (`draftPrompt`).

- **Order.** The `section.draft` task of section k of a chapter depends on the draft task of section k-1 of the same chapter (`sectionSpecs` in `runs.ts`), besides its own evidence task. Chapters, the evidence tasks, the first-chapter gate and the exam guide's dependencies stay as they were. A task that fails leaves the later sections of its chapter queued behind it. Other chapters go on, the run then ends as failed, and the queue marks the blocked sections as cancelled with "Not run: an earlier task failed." A retry of the failed task puts them back (see Queue).
- **Prompt layout.** The system prompt holds everything that is the same for all sections of a book, in this order: role, format rules, the figure rules of the book's subject (or the line that says no figures), the writing instructions and the answer format. The user prompt goes from the stable to the specific: notation and section ids of the book, the chapter plan (without a marker for the current section, so it is the same for every section of the chapter) and the formula keys known so far, the summaries of the sections written before, the figures other sections show, the program items and topics of the section, the evidence, and last the task with the section's title, objectives and depth, followed by a one-line reminder of the answer format (in a real run with Claude Sonnet one of four first answers left out the metadata, and the repair turn put it right). A provider that caches the start of a prompt can reuse the system prompt and the book block across sections, and more across the sections of a chapter. `drafting.test.ts` fails when that shared start gets shorter. The repair prompt has the same order: static rules in the system prompt, then the section, then the problems.
- **Self-check.** `sectionDraft` opens the writer call with `withRole` and, when the book option `selfCheck` is on (the default) and the section is not an exam guide, sends `selfCheckPrompt()` as a follow-up in the same conversation. `OK` keeps the draft. Any other answer goes through the same parser and replaces the draft only when it parses, `lostStructure` (`packages/content/src/patch.ts`: headings, formula keys, `:::` blocks by name, images, open fences) finds nothing lost, `addsCommentary` finds no new opening or closing paragraph that has little in common with the first draft's (a note about the correction would go into the book), it still carries every figure key of the first draft, and `lostCitation` (`pipeline/draft.ts`) finds every `[[n…]]` marker of the first draft in the same paragraph (a paragraph rewritten whole, with less than half of its words left, may lose its markers when the fix guard `applyGuardedChanges` accepts the rewrite). `addsCommentary` compares prose only, so a corrected formula at either end is no note. A `FollowUpError` or an answer that does not hold up keeps the first draft; an abort of the task propagates. The task result has `selfCheck: 'ok' | 'corrected' | 'kept' | 'skipped'` and, for a rejected correction, `selfCheckNote` with the reason. Its usage rows have the writer role and attempt 2 within the call. No screen sets the option: `PATCH /api/projects/<id>` with `{"options": {"selfCheck": false}}`.

## Evidence

Sources are split into pages (`pages` + FTS5). NotebookLM answers come with `cited_text`; the builder locates each passage on a page and drops what it cannot find. Without NotebookLM, FTS5 picks candidate pages and the evidence-reader model returns verbatim quotes that are checked the same way. Pages whose text layer garbles math are transcribed by a vision model on demand and cached.

## Drawn figures

`apps/service/src/figures/drawing` turns drawing source code into a finished SVG. It has no model in it: the caller gives `{ engine, source }` and gets a clean SVG, or an error written for a repair turn. The header of `index.ts` documents the API.

- **Engines.** `typst` compiles Typst with CeTZ, zap (circuits), fletcher (block diagrams, state machines), lilaq (plots), finite (automata) and cetz-plot. `schemdraw` runs Python in the Pyodide that the service already ships, for logic gates, timing diagrams, Karnaugh maps and analog circuits. Typst has no timing package that draws text as outlines, so timing diagrams go through schemdraw.
- **Offline and pinned.** `scripts/fetch-figure-packages.mjs` downloads the Typst packages and Python wheels into `.figure-packages/` (git-ignored) and checks each against a SHA-256 written in the script. `npm start` and `npm run doctor` run it when something is missing, and CI runs it before the tests. Nothing is downloaded while a figure renders. A Typst import outside the allow-list fails before compiling.
- **Sandbox.** Every render is a new child process under Node's permission model, with a timeout, a memory cap, an empty environment and a temp folder that is deleted afterwards (`sandbox.ts`). Node 24 cannot block the network for a child, the same limit as `pipeline/python.ts`. The Typst compiler is a native addon, which needs `--allow-addons` and means the permission flags no longer confine the compiler itself. The child gets a temp `HOME` and a proxy that refuses every connection, so a package download that slipped past the import check fails.
- **Output.** The SVG is transparent with dark ink (`#111827`), has no `<text>` (glyphs are paths, so it looks the same on every device), a tight viewBox and a root marker `data-sb-ink="dark"`. `isInkDrawing(svg)` tests for the marker. `rasterizeDrawing` draws the SVG to PNG with resvg for a vision model.
- **Circuit symbols.** `symbols: 'american' | 'european'` picks a zigzag or a rectangle resistor in both engines. zap does it through a small shim module that the wrapper puts in place of the zap import. schemdraw does it with `elm.style(elm.STYLE_IEC)`.

### The illustrator

The figure kind `drawing` connects the renderer to a model. `figures/drawing/illustrator.ts` (`illustrate`) runs in one `withRole` conversation of the `illustrator` role (default Codex `gpt-6-sol` at medium effort, Claude Sonnet 5.5 as fallback, long timeout class, probe like any role):

1. The system prompt is the role, the output contract (source only), the drawing rules and the cheat sheet of one engine (`figures/drawing/sheets/typst.md` or `schemdraw.md`), so it is the same for every figure of that engine and can be cached. The user prompt carries the caption, `shows`, the family, the book language and the circuit symbol style. `ENGINE_OF_FAMILY` is the one table that picks the engine: schemdraw for `logic`, `timing` and `karnaugh`, Typst for the rest.
2. The answer is plain text. A Markdown fence is removed and an answer without code is sent back. `renderDrawing` compiles it with the book's `circuitSymbols` option. A compile error goes back in the conversation, at most twice.
3. Once, the compiled drawing is rasterised and goes back as a picture with a four-point checklist. The model answers `OK` or a full corrected source, which is compiled like any source with one repair. A correction that fails, or a follow-up that fails (`FollowUpError`), keeps the drawing that compiled before.
4. With no drawing that compiled, the request is dropped with a note, like any failed figure spec.

`buildFigures` calls `illustrate` for the kind. The asset has origin `generated-svg` and the spec `{ kind: 'drawing', engine, source, shows, family, symbols }`. `renderEditedDrawing(ctx, assetId, source)` and `redrawDrawing(ctx, assetId, instruction)` in `figures/drawing/edit.ts` replace the figure's file in place, for a screen that shows and edits the source. Renders are bounded by `MAX_PARALLEL_RENDERS` (2) across all callers, because each one is a child process. Every code block in the cheat sheets is compiled by `sheets.test.ts`, so a sheet cannot rot.

Author changes to a figure (the Manuscript's figure dialog and **Add figure**, see [WORKFLOW.md](WORKFLOW.md)) go through `routes/figures.ts` and `figures/author.ts`. Every write names the section head the author saw (`baseRevId`) and gets 409 when it moved, and every change is one new revision made by `rewriteHead` (`repo/content.ts`), with origin `human` and the block citations carried over. A change of the picture never edits a file in place. `copyAsset` makes a second asset row and file, `renderEditedDrawing` or an upload works on that copy, and the text is pointed at it, so the revision before the change still names the old asset and History shows the old drawing. A copy that is not used is deleted. The two model calls are queue tasks of a run of kind `figure`: `figure.redraw` (`redrawDrawing` on a copy) and `figure.draw` (`buildFigures`, the same path as the writer's drawings, family `other`), both in `pipeline/figureEdit.ts`, pool `illustrator`. They write their revision last, into the head as it is then, and a figure that left the text meanwhile is not put back. Photo searches by hand (`searchStockPhotos` in `figures/stock.ts`) keep their results in memory for 30 minutes and the author picks one by eye, so there is no vision-model check as in the writer's pipeline.

Dark mode. A figure is shown through `<img>`, so the page theme cannot change its colours. The reader solves that with a plate: `.sb-figure-frame` has the background `--figure-plate` (`#fbf8f2` in light mode, `#ddd3c4` in dark mode, from the reader's `tokens.css`), and the image inside it is multiplied onto the plate with `mix-blend-mode: multiply`. A white background takes the plate's colour and dark ink stays dark, so in dark mode a figure is dark ink on a cream plate, never a white box and never dark ink on a dark page. The builder preview uses the same rules (`apps/web/src/reader/reader.css`), and every place that shows a book figure puts it in a `.sb-figure-frame`: the manuscript, editor, reader and export previews through `SmartbookFigure`, and the Extras figure cards. Figures stored before 0.4.0 have a white rectangle and look right on the plate without being redrawn. The plot, chemistry diagram and structure drawers write the same SVG as the drawing renderer: transparent, `INK` as the ink and `data-sb-ink="dark"` on the root (`INK`, `INK_MARKER` and `isInkDrawing` live in `packages/content/src/ink.ts`), so the figure is dark ink on whatever is behind it, and the marker tells such a figure from an older one.
