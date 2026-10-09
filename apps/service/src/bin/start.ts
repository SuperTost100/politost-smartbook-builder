import { networkInterfaces, hostname } from 'node:os';
import { lockDataDir, parseArgs } from '../config.ts';
import { createContext } from '../context.ts';
import { buildServer, lanToken } from '../server.ts';
import { registerHandlers } from '../pipeline/index.ts';

const config = parseArgs(process.argv.slice(2));
const lock = lockDataDir(config);
if ('heldBy' in lock) {
  console.error(`Another Smart Builder service (process ${lock.heldBy}) is using ${config.dataDir}. Stop it first, or start this one with --data-dir <another folder>.`);
  process.exit(1);
}
process.on('exit', lock.release);
const ctx = createContext(config);
registerHandlers(ctx);
const app = await buildServer(ctx);
await app.listen({ host: config.host, port: config.port });
ctx.queue.start();

const lines = [`PoliTost Smart Builder ${config.version}`, `Data: ${config.dataDir}`];
if (config.lan) {
  const token = lanToken(ctx);
  const addrs = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
  lines.push('Open one of these links on the device you work from:');
  for (const h of [hostname(), ...addrs]) lines.push(`  http://${h}:${config.port}/?token=${token}`);
} else {
  lines.push(`Open http://localhost:${config.port}`);
}
if (config.dev) lines.push('Dev mode: the web app runs on Vite at http://localhost:5173');
lines.push('Closing the browser does not stop generation. Press Ctrl+C to stop the service.');
console.log(lines.join('\n'));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Stopping. Running tasks resume on the next start.');
  await ctx.queue.stop();
  await app.close();
  ctx.db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
ctx.events.prune();
export { shutdown };
