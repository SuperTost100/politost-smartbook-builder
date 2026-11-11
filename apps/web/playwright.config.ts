import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5300);
const dataDir = mkdtempSync(join(tmpdir(), 'smartbuilder-e2e-'));
// The suite makes no model calls. One test uploads a file, which starts Prepare, and with the model CLIs on PATH that run
// called a real model on the developer's account. The service therefore starts as on CI, where no CLI is installed: with
// a PATH that holds node and the system folders only, and with an empty home folder, because cli-funnel also looks for the
// CLIs in ~/.local/bin, ~/.npm-global/bin and similar places.
const binDir = mkdtempSync(join(tmpdir(), 'smartbuilder-e2e-bin-'));
symlinkSync(process.execPath, join(binDir, 'node'));
const cleanPath = [binDir, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
const emptyHome = mkdtempSync(join(tmpdir(), 'smartbuilder-e2e-home-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `node --import tsx ../service/src/bin/start.ts --port ${port} --data-dir ${dataDir}`,
    env: { ...process.env as Record<string, string>, PATH: cleanPath, HOME: emptyHome },
    cwd: dirname(fileURLToPath(import.meta.url)),
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
