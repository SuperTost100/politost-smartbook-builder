import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5300);
const dataDir = mkdtempSync(join(tmpdir(), 'smartbuilder-e2e-'));

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
    cwd: dirname(fileURLToPath(import.meta.url)),
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
