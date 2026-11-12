# Setup

## Install

```bash
npm ci
npm run doctor
```

`doctor` checks Node, the data folder, the figure packages, each AI command-line tool, NotebookLM and LibreOffice, and says what to do about anything missing.

## Figure packages

Drawn figures (circuits, logic networks, timing diagrams and the like) are compiled on your computer from Typst packages and Python wheels. They are not part of the repository. `npm start` and `npm run doctor` download what is missing into `.figure-packages/` at the repository root, about 7 MB in 23 downloads, and check each file against a SHA-256 hash that is written in `scripts/fetch-figure-packages.mjs`. A file that does not match is refused. To fetch them by hand, for example before going offline, run:

```bash
npm run figure-packages
```

Nothing is downloaded while a figure renders, so a book keeps drawing after the first download with no network. If the first download fails, `npm start` prints a warning and starts anyway, and drawings fail with a message that says how many packages are missing until `npm run figure-packages` succeeds. `npm run figure-packages -- --check` only reports what is missing. The folder is ignored by git, and `scripts/fetch-figure-packages.mjs` lists every package with its version and licence.

## AI tools

Smart Builder calls the tools through [cli-funnel](https://github.com/SuperTost100/cli-funnel), with every tool disabled except in one call: the web research that **Find outside sources** makes allows Claude Code's WebSearch and WebFetch, so that model can read pages on the web. Every other call only reads the text the builder sends and writes text back. No call can run commands or touch your files.

| Tool | Sign in | Used by default for |
|---|---|---|
| Claude Code | `claude` then `/login` | Section text and blocker fixes (Sonnet), the second opinion on every review finding (Sonnet), the outline once per book (Opus), outside research (Sonnet) |
| Codex | `codex login` | Everything routine on GPT-6-Luna: classification, page reading, exercises, introductions, non-blocker fixes, first solution checks. GPT-6-Sol reviews chapters, draws figures (the illustrator) and gives a second opinion when a solution check finds a problem |
| Antigravity | `agy` | Fallback for classification and the local evidence reader (Gemini Flash) |
| Cursor Agent | `cursor-agent login` | Nothing by default |

Each job (a *role*) has a primary model and a fallback, and you change them under **Connections**. The defaults spend the expensive models only where a student would notice: Sonnet writes the section text and fixes blockers in it, and fixes change only the paragraphs involved. Everything else runs on GPT-6-Luna, with GPT-6-Sol as a second opinion. A few rules behind the defaults:

- The reviewer should come from a different vendor than the writer, so it does not share the writer's blind spots. The same goes for the second opinion and the reviewer.
- Reading pages needs a model that accepts images (Claude or Codex).
- Calls through Cursor to Claude models are billed at API prices, so use Claude Code for those.
- When a subscription hits its limit, the task waits and resumes after the reset, or switches to the role's fallback. Nothing is lost. A provider that reported a limit gets no further calls until its reset, and the Connections screen shows the usage windows of Codex.
- A book can stay on Claude whatever happens: *When Claude usage runs out* in Book setup removes the fallback of every role that starts on Claude for that book, so its tasks wait for the reset.

### The service's own CLI homes

Codex and Claude Code load everything in their config folder on every call: the owner's `AGENTS.md`, `CLAUDE.md`, skills, plugins and MCP servers. For the book models that is about 5,300 extra input tokens per Codex call and more on Claude Code, and none of it helps. So the service makes two private folders under the data folder:

| Folder | For | Holds |
|---|---|---|
| `codex-home/` | Every Codex call | A link to your real `~/.codex/auth.json` |
| `claude-home/` | Web calls of the outside research role | A link to your real `~/.claude/.credentials.json` |

Each folder holds only a link to the real login file and nothing else, so a token refresh still reaches your real login, and your own instructions and skills are not read. The service creates them when it first needs them, and you can delete them, because they come back. A different `CODEX_HOME` or `CLAUDE_CONFIG_DIR` in the environment is honoured as the place of the real login. If there is no login file to link (a login kept in the system keyring) or links cannot be made (Windows without symlink rights), the tool runs in its default folder and the service log says so once.

Calls to Claude Code without the web need no private folder, because they already load nothing.

## Settings

Settings live in two places.

**Connections** holds what belongs to the computer and applies to every book:

- *Model routing*: the primary and fallback model of each role, with a **Test** button per role.
- *Evidence*: NotebookLM or Local.
- *Concurrency*: how many tasks each provider runs at once, 1 to 8. Lower it if you hit usage limits.
- *Stock photos*: a free [Pixabay](https://pixabay.com/api/docs/) or [Pexels](https://www.pexels.com/api/) key. Wikimedia Commons needs none and is always searched. The keys are stored in the data folder, and the service never sends them back to the browser.
- *Usage*: the calls, tokens, cached share, failures and timeouts of the last 30 days per provider. It is read-only.

**Book setup** holds what belongs to one book: language, audience and goals, the course program, the subject area, the figure policy (*Where they help* or *Generous*), the circuit symbols (shown for physics and electronics), the lab language, which extras to write, exercises per topic, the first-chapter gate, what Align book does with off-program sections and *When Claude usage runs out*. The writer's self-check has no screen yet (see [How a book is made](WORKFLOW.md#writing)).

## NotebookLM

Install the bridge and sign in on a computer with a browser:

```bash
uv tool install notebooklm-mcp-cli
nlm login --storage file
```

`--storage file` keeps the session in `~/.notebooklm-mcp-cli/` instead of the system keychain, so it can be copied. If Smart Builder runs on a machine without a screen (a home server, a remote desktop box), sign in on your laptop and copy the session over:

```bash
# on the laptop; use any Chromium-based browser
NLM_BROWSER_PATH="/Applications/Helium.app/Contents/MacOS/Helium" \
  uvx --from notebooklm-mcp-cli nlm login --storage file
scp -r ~/.notebooklm-mcp-cli/profiles ~/.notebooklm-mcp-cli/config.toml server:.notebooklm-mcp-cli/
```

A session copied this way lasts only hours: refreshing it needs a signed-in Chrome profile on the machine that runs `nlm`. To give a headless server its own profile, sign in once through Chrome's remote debugging view:

```bash
# on the server
Xvfb :42 -screen 0 1280x900x24 &
DISPLAY=:42 google-chrome --user-data-dir=$HOME/.notebooklm-mcp-cli/chrome-profiles/default \
  --remote-debugging-port=9222 --no-first-run https://notebooklm.google.com &
# from your laptop: ssh -L 9222:localhost:9222 server, then open
#   http://localhost:9222/devtools/inspector.html?ws=localhost:9222/devtools/page/<id from /json>
# and sign in through the live screencast. Then, on the server:
nlm login --provider openclaw --cdp-url http://127.0.0.1:9222 --storage file --force
# close Chrome and Xvfb, and check that a headless refresh works:
nlm auth refresh
```

A cron entry such as `17 */6 * * * nlm auth refresh` keeps the session fresh when nothing else uses it.

Once the server has its own profile, the session refreshes its short-lived tokens by itself. When Google expires the login (usually after weeks), the Connections screen says so and evidence switches to the local reader until you sign in again.

Without NotebookLM, set **Evidence** to *Local* under Connections: the builder searches the extracted pages and a reader model quotes them. Quotes are verified against the page text either way.

## Data

Everything lives in one folder: the database, your original files, rendered pages, figures and exports.

| System | Default |
|---|---|
| macOS | `~/Library/Application Support/PoliTost Smart Builder` |
| Linux | `~/.local/share/politost-smart-builder` |
| Windows | `%APPDATA%\PoliTost Smart Builder` |

Override with `--data-dir <folder>` or `SMARTBUILDER_DATA_DIR`.

```bash
npm run backup -- my-backup.tar.gz
npm run restore -- my-backup.tar.gz --data-dir /path/to/empty/folder
```

The backup takes a consistent database snapshot, so it is safe while the service runs.

Your sources are sent to the AI tools and, when evidence is set to NotebookLM, to NotebookLM. Exclude a source on the Sources screen to keep it out of the steps that follow. Prepare starts as soon as you upload a file, so the first lines of its pages may already have gone to the AI tools by then. A copy that was already uploaded to NotebookLM stays in the notebook until you delete it there, although Smart Builder no longer asks it questions about that source. The data folder also holds the two private CLI homes (see above) and the access token of LAN mode.

## Network

By default the service only answers `localhost`. `npm start -- --lan` listens on every interface and requires the access token from the printed link (stored as a cookie). Changing requests also need a custom header, so other websites you visit cannot trigger actions.

## Start on login (macOS, optional)

Save as `~/Library/LaunchAgents/com.politost.smartbuilder.plist`, adjust the paths, then `launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.politost.smartbuilder</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/politost-smartbook-builder && npm start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/smartbuilder.log</string>
  <key>StandardErrorPath</key><string>/tmp/smartbuilder.log</string>
</dict></plist>
```

On Linux, a systemd user service with `ExecStart=/usr/bin/env npm start --prefix %h/politost-smartbook-builder` does the same.
