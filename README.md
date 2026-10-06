<img src="assets/icon.svg" width="64" height="64" alt="">

# PoliTost Smart Builder

Smart Builder turns course material into a [PoliTost smartbook](https://github.com/SuperTost100/politost-smartbook): lecture notes, textbooks and past exams go in, an editable book with numbered formulas, checked exercises, exam practice, graphs and Python examples comes out as a `.ptsb` file the reader opens.

It runs on your computer. The AI work goes through the command-line tools you already pay for (Claude Code, Codex, Cursor Agent, Antigravity) and NotebookLM, so there is no API bill and no account to create.

## What it does

1. **Reads your sources.** PDF (text or scanned), Word, PowerPoint, Markdown and web pages. Pages whose math the PDF text layer garbles are read by a vision model on demand.
2. **Maps the course.** It keeps each source's own index, builds a topic map, splits past exams into questions and counts in how many exam sessions each topic appears.
3. **Proposes a common index** that you edit and approve. Topics the exams test often get more depth and more exercises; topics they never test still get exercises.
4. **Writes each section from evidence.** NotebookLM (or a local search plus a reader model) returns verbatim passages. Every passage is located on its source page; passages that cannot be found are dropped. The writer cites them, and the editor shows the original page with the cited lines highlighted.
5. **Checks its own output.** Lints for the problems that ruined earlier generated books (broken formulas, model commentary in the text, Unicode math, dangling colons), an independent model solves every exercise again, Python examples run in Pyodide, graphs are evaluated over their domain.
6. **Lets you finish the book.** Edit any block with a live formula preview, regenerate a passage with an instruction, accept or reject AI proposals, resolve review issues, then export a validated `.ptsb`.

Human edits are never overwritten: AI output that arrives after you changed a section becomes a proposal you accept or reject.

## Requirements

- Node.js 22.13 or newer (24 recommended; see `.nvmrc`).
- At least one signed-in AI command-line tool: [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), Cursor Agent or Antigravity.
- Optional: [`nlm`](https://github.com/jacob-bd/gemini-notebook-mcp-cli) for NotebookLM evidence, LibreOffice for Word and PowerPoint files.

## Start

```bash
git clone https://github.com/SuperTost100/politost-smartbook-builder.git
cd politost-smartbook-builder
npm ci
npm run doctor     # what is installed and signed in, and how to fix the rest
npm start          # opens on http://localhost:5300
```

To use it from another device on your network (for example a laptop reaching a desktop over Tailscale):

```bash
npm start -- --lan
```

The command prints a link with an access token. Open it once on each device; without the token the service refuses every request.

Closing the browser does not stop generation. Stopping the service pauses it; the next start resumes where it was.

## Documentation

- [Setup and model routing](docs/SETUP.md)
- [How a book is made](docs/WORKFLOW.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Status](STATUS.md)

## License

AGPL-3.0-or-later. Smart Builder uses [MuPDF](https://mupdf.com/) (AGPL) for PDF reading and code adapted from the PoliTost reader (AGPL). Books you make with it are yours and are not covered by this license.
