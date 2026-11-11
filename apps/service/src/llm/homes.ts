// The service's own config folders for the model CLIs. A CLI loads everything in its home folder: Codex reads the
// owner's global AGENTS.md and skills (about 5,300 input tokens on every call, measured: 16.6k against 11.3k), and Claude
// Code reads CLAUDE.md, skills, plugins and MCP servers (43k tokens on a web call). The book models need none of it,
// so each private home holds only a link to the real login.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Config, paths } from '../config.ts';

type Log = (line: string) => void;
const warned = new Set<string>();

/**
 * Environment that points the CLI at `home` (created on first use) instead of the owner's folder. The login file in it is a link
 * to the real one, so a token refresh still reaches the owner's login. Undefined, meaning the CLI keeps its default folder,
 * when there is no login file to link (a keyring login, say) or the link cannot be made (Windows without symlink rights).
 */
function privateHome(envName: string, sourceDir: string, loginFile: string, home: string, cli: string, log: Log): Record<string, string> | undefined {
  // Absolute, because a relative CODEX_HOME would otherwise be stored as a link target that points nowhere from the private home.
  const real = resolve(sourceDir, loginFile);
  const useDefault = (why: string) => {
    if (!warned.has(envName)) {
      warned.add(envName);
      log(`${cli} runs in its default folder with the owner's instructions and skills, because ${why}.`);
    }
    return undefined;
  };
  if (resolve(sourceDir) === resolve(home)) return useDefault(`${envName} already points at the service's own folder`);
  if (!existsSync(real)) return useDefault(`${real} does not exist (a keyring login?)`);
  const link = join(home, loginFile);
  try {
    mkdirSync(home, { recursive: true });
    const current = lstatSync(link, { throwIfNoEntry: false });
    if (current?.isSymbolicLink() && readlinkSync(link) === real) return { [envName]: home };
    // The CLI replaced the link with a file when it refreshed the token: that file is the newest login, so it goes back to the real place first.
    if (current?.isFile() && current.mtimeMs >= statSync(real).mtimeMs) copyFileSync(link, real);
    rmSync(link, { force: true });
    symlinkSync(real, link);
  } catch (err) {
    return useDefault(`its own folder could not be set up (${err instanceof Error ? err.message : String(err)})`);
  }
  return { [envName]: home };
}

/** Codex without the owner's AGENTS.md and skills. Honours an existing CODEX_HOME as the source of the login. */
export function codexEnv(config: Config, log: Log = console.warn) {
  return privateHome('CODEX_HOME', process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json', paths.codexHome(config), 'Codex', log);
}

/** Claude Code without the owner's CLAUDE.md, skills, plugins, hooks and MCP servers. For web calls, the only ones that load them. */
export function claudeWebEnv(config: Config, log: Log = console.warn) {
  return privateHome('CLAUDE_CONFIG_DIR', process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json', paths.claudeHome(config), 'Claude Code', log);
}

/** Test hook: each missing-login warning is printed once per process. */
export function resetHomeWarnings() {
  warned.clear();
}
