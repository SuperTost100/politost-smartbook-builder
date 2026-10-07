# Setup

## Install

```bash
npm ci
npm run doctor
```

`doctor` checks Node, the data folder, each AI command-line tool, NotebookLM and LibreOffice, and says what to do about anything missing.

## AI tools

Smart Builder calls the tools through [cli-funnel](https://github.com/SuperTost100/cli-funnel), always with every tool disabled: the models only read the text the builder sends and write text back. They cannot run commands or touch your files.

| Tool | Sign in | Used by default for |
|---|---|---|
| Claude Code | `claude` then `/login` | Section text and blocker fixes (Sonnet), the outline once per book (Opus) |
| Codex | `codex login` | Everything routine on GPT-6-Luna: classification, page reading, exercises, introductions, non-blocker fixes, first solution checks. GPT-6-Sol reviews chapters and gives a second opinion when a solution check finds a problem |
| Antigravity | `agy` | Fallback for classification and the local evidence reader (Gemini Flash) |
| Cursor Agent | `cursor-agent login` | Nothing by default |

Each job (a *role*) has a primary model and a fallback; change them under **Connections**. The defaults spend the expensive models only where a student would notice: Sonnet writes the section text and fixes blockers in it, and fixes change only the paragraphs involved. Everything else runs on GPT-6-Luna, with GPT-6-Sol as a second opinion. A few rules behind the defaults:

- The reviewer should come from a different vendor than the writer, so it does not share the writer's blind spots.
- Reading pages needs a model that accepts images (Claude or Codex).
- Calls through Cursor to Claude models are billed at API prices; use Claude Code for those.
- When a subscription hits its limit, the task waits and resumes after the reset, or switches to the role's fallback. Nothing is lost.

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

Your sources are sent to the AI tools and to NotebookLM you configured. Exclude a source on the Sources screen to keep it out.

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
