// Backup: npm run backup -- <out.tar.gz>     Restore: npm run restore -- <backup.tar.gz> --data-dir <empty folder>
// The database snapshot uses VACUUM INTO, which is consistent even while the service runs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, paths } from '../config.ts';

const args = process.argv.slice(2);
const command = args[0];
const target = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
const config = parseArgs(args.slice(target ? 2 : 1));

if (command === 'backup') {
  const out = resolve(target ?? `smartbuilder-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  const snapshot = join(config.dataDir, 'backup-snapshot.sqlite');
  rmSync(snapshot, { force: true });
  const db = new DatabaseSync(paths.db(config));
  db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  db.close();
  const entries = ['backup-snapshot.sqlite', ...(existsSync(join(config.dataDir, 'projects')) ? ['projects'] : [])];
  execFileSync('tar', ['-czf', out, '-C', config.dataDir, ...entries], { stdio: 'inherit' });
  rmSync(snapshot, { force: true });
  console.log(`Backup written to ${out}`);
} else if (command === 'restore') {
  if (!target) throw new Error('Give the backup file to restore.');
  mkdirSync(config.dataDir, { recursive: true });
  if (readdirSync(config.dataDir).some((f) => f !== 'tmp' && f !== 'scratch')) {
    console.error(`${config.dataDir} is not empty. Restore into an empty folder with --data-dir, or move the current data away first.`);
    process.exit(1);
  }
  execFileSync('tar', ['-xzf', resolve(target), '-C', config.dataDir], { stdio: 'inherit' });
  renameSync(join(config.dataDir, 'backup-snapshot.sqlite'), paths.db(config));
  console.log(`Restored into ${config.dataDir}. Start with: npm start -- --data-dir "${config.dataDir}"`);
} else {
  console.log('Usage: npm run backup -- [file.tar.gz] [--data-dir dir]\n       npm run restore -- <file.tar.gz> --data-dir <empty dir>');
}
