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
