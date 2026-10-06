import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  /** LAN mode: bind to all interfaces and require the access token cookie. */
  lan: boolean;
  dev: boolean;
  webDist: string;
  version: string;
}

export function defaultDataDir(): string {
  if (process.env.SMARTBUILDER_DATA_DIR) return resolve(process.env.SMARTBUILDER_DATA_DIR);
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'PoliTost Smart Builder');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'PoliTost Smart Builder');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'politost-smart-builder');
  }
}

export function parseArgs(argv: string[]): Config {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const lan = flag('lan');
  const dataDir = value('data-dir') ? resolve(value('data-dir')!) : defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    lan,
    host: value('host') ?? (lan ? '0.0.0.0' : '127.0.0.1'),
    port: Number(value('port') ?? process.env.PORT ?? 5300),
    dev: flag('dev'),
    webDist: resolve(import.meta.dirname, '../../web/dist'),
    version: '0.1.0',
  };
}

/** Per-project file layout inside the data directory. */
export const paths = {
  db: (c: Config) => join(c.dataDir, 'smartbuilder.sqlite'),
  project: (c: Config, projectId: string) => join(c.dataDir, 'projects', projectId),
  resources: (c: Config, projectId: string) => join(c.dataDir, 'projects', projectId, 'resources'),
  pageCache: (c: Config, projectId: string, resourceId: string) => join(c.dataDir, 'projects', projectId, 'pages', resourceId),
  assets: (c: Config, projectId: string) => join(c.dataDir, 'projects', projectId, 'assets'),
  exports: (c: Config, projectId: string) => join(c.dataDir, 'projects', projectId, 'exports'),
  tmp: (c: Config) => join(c.dataDir, 'tmp'),
  /** Empty folder used as cwd for model CLIs. */
  scratch: (c: Config) => join(c.dataDir, 'scratch'),
  lanToken: (c: Config) => join(c.dataDir, 'lan-token'),
};
