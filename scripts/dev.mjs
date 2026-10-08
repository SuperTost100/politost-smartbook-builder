// Runs the service in watch mode and the web app on Vite, which proxies /api to the service.
// Extra arguments go to the service, for example: npm run dev -- --data-dir ./.data
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const extra = process.argv.slice(2);
const children = [
  spawn(npm, ['run', 'dev', '-w', '@smartbuilder/service', ...(extra.length ? ['--', ...extra] : [])], { stdio: 'inherit' }),
  spawn(npm, ['run', 'dev', '-w', '@smartbuilder/web'], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGINT');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
