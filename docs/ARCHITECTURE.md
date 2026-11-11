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

## Evidence

Sources are split into pages (`pages` + FTS5). NotebookLM answers come with `cited_text`; the builder locates each passage on a page and drops what it cannot find. Without NotebookLM, FTS5 picks candidate pages and the evidence-reader model returns verbatim quotes that are checked the same way. Pages whose text layer garbles math are transcribed by a vision model on demand and cached.

## Drawn figures

`apps/service/src/figures/drawing` turns drawing source code into a finished SVG. It has no model in it: the caller gives `{ engine, source }` and gets a clean SVG, or an error written for a repair turn. The header of `index.ts` documents the API.

- **Engines.** `typst` compiles Typst with CeTZ, zap (circuits), fletcher (block diagrams, state machines), lilaq (plots), finite (automata) and cetz-plot. `schemdraw` runs Python in the Pyodide that the service already ships, for logic gates, timing diagrams, Karnaugh maps and analog circuits. Typst has no timing package that draws text as outlines, so timing diagrams go through schemdraw.
- **Offline and pinned.** `scripts/fetch-figure-packages.mjs` downloads the Typst packages and Python wheels into `.figure-packages/` (git-ignored) and checks each against a SHA-256 written in the script. `npm start` and `npm run doctor` run it when something is missing, and CI runs it before the tests. Nothing is downloaded while a figure renders. A Typst import outside the allow-list fails before compiling.
- **Sandbox.** Every render is a new child process under Node's permission model, with a timeout, a memory cap, an empty environment and a temp folder that is deleted afterwards (`sandbox.ts`). Node 24 cannot block the network for a child, the same limit as `pipeline/python.ts`. The Typst compiler is a native addon, which needs `--allow-addons` and means the permission flags no longer confine the compiler itself. The child gets a temp `HOME` and a proxy that refuses every connection, so a package download that slipped past the import check fails.
- **Output.** The SVG is transparent with dark ink (`#111827`), has no `<text>` (glyphs are paths, so it looks the same on every device), a tight viewBox and a root marker `data-sb-ink="dark"`. `isInkDrawing(svg)` tests for the marker. `rasterizeDrawing` draws the SVG to PNG with resvg for a vision model.
- **Circuit symbols.** `symbols: 'american' | 'european'` picks a zigzag or a rectangle resistor in both engines. zap does it through a small shim module that the wrapper puts in place of the zap import. schemdraw does it with `elm.style(elm.STYLE_IEC)`.

Dark mode in the reader. A figure is shown through `<img>`, so a page theme cannot change its colours. Every drawn figure is transparent with dark ink (`INK`) and carries `data-sb-ink="dark"` on its root: the drawing renderer, and also the plot, chemistry diagram and structure drawers (`INK`, `INK_MARKER` and `isInkDrawing` live in `packages/content/src/ink.ts`). A viewer reads the SVG text when it builds the image URL and, when the root has the marker, sets `data-ink` on the `<img>`. Then `[data-theme='dark'] .sb-figure-frame img[data-ink]` applies `filter: invert(1) hue-rotate(180deg)`: dark ink turns light, and the hue rotation brings curve and highlight colours back close to where they were. A light mat behind the figure was tried and rejected, because it is the white box this replaces. Figures without the marker (photos, uploads, figures drawn before 0.4.0 with a white rectangle) are shown as they are. The builder preview does this in `apps/web/src/lib/inkFigure.ts` and `apps/web/src/reader/reader.css`, and the reader needs the same rule.

Figures stored before 0.4.0 still have their white rectangle. `npm run redraw-figures -- --project <id> [--dry-run]` draws the stored plots, diagrams and structures again from their specs, in place, with the same file name, caption and alt text. Photos, uploads and drawings are skipped, and a figure whose spec no longer validates is left as it is and listed.
