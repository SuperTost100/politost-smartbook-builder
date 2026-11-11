import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';

// Drawn figures are transparent with dark ink and carry data-sb-ink="dark". The preview lights them up on a dark page.
// The fixtures are real drawer output (plot, structure, chemistry diagram, drawing). The "old" variant is the same figure
// as the drawers wrote it before 0.4.0: a white rectangle behind it and no marker. It has to stay as it was.
const NAMES = ['plot', 'structure', 'diagram', 'drawing'] as const;
const read = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${n}.svg`), 'utf8');
const NEW: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, read(n)]));
const OLD: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, NEW[n].replace(' data-sb-ink="dark"', '').replace(/(<title>.*?<\/title>)/, '$1<rect width="100%" height="100%" fill="#FFFFFF"/>')]));
const FILTER = 'invert(1) hue-rotate(180deg)';

const compiled = `## p1 | Figure di prova

### Quattro figure

Le figure seguenti sono disegnate dal builder.

${NAMES.map((n, i) => `:::image{src="assets/${n}.svg" alt="Figure ${n}" caption="Fig. 1.${i + 1} — Disegno di tipo ${n}"}\n:::`).join('\n\n')}
`;

async function open(page: Page, variant: 'new' | 'old', theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('smartbuilder.theme', t), theme);
  await mockApi(page);
  const files = variant === 'new' ? NEW : OLD;
  const assets = Object.fromEntries(NAMES.flatMap((n) => [[`assets/${n}.svg`, `/api/assets/${n}/file`], [`${n}.svg`, `/api/assets/${n}/file`]]));
  await page.route('**/api/projects/p1/chapters/*/preview', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ markdown: compiled, number: 1, assets }) }));
  await page.route('**/api/assets/*/file', (r) => r.fulfill({ contentType: 'image/svg+xml', body: files[/assets\/(\w+)\/file/.exec(r.request().url())![1]] }));
  await page.route('**/api/projects/p1/assets', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(NAMES.map((n) => ({ id: n, projectId: 'p1', nodeId: null, filename: `${n}.svg`, mime: 'image/svg+xml', origin: n === 'drawing' ? 'generated-svg' : n === 'diagram' ? 'diagram' : n, spec: null, caption: `Disegno ${n}`, alt: `Figure ${n}`, checks: [], createdAt: '2026-11-11T10:00:00Z' }))) }));
}

const filterOf = (page: Page, name: string, within: string) => page.locator(`${within} img[alt="Figure ${name}"]`).evaluate((el) => getComputedStyle(el).filter);

for (const width of [1440, 390]) for (const theme of ['light', 'dark'] as const) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const variant of ['new', 'old'] as const) test(`reader preview, ${variant} figures, ${theme} theme`, async ({ page }) => {
      await open(page, variant, theme);
      await page.goto('/books/p1/preview/c1');
      await expect(page.locator('.sb-figure-frame img')).toHaveCount(4);
      const lit = theme === 'dark' && variant === 'new';
      await expect(page.locator('.sb-figure-frame img[data-ink="dark"]')).toHaveCount(variant === 'new' ? 4 : 0);
      for (const n of NAMES) {
        await expect.poll(() => filterOf(page, n, '.sb-figure-frame'), { message: `${n} filter` }).toBe(lit ? FILTER : 'none');
      }
      await expect(page.locator('.sb-figure-frame img').first()).toHaveJSProperty('complete', true);
      await page.waitForTimeout(300);
      const dir = process.env.FIGURE_SHOTS;
      if (dir) await page.screenshot({ path: join(dir, `reader-preview-${variant}-${theme}-${width}.png`), fullPage: true });
    });
  });
}

test('extras figures tab shows a marked figure light on a dark page', async ({ page }) => {
  await open(page, 'new', 'dark');
  await page.goto('/books/p1/extras');
  await expect(page.locator('.ex-fig img[data-ink="dark"]')).toHaveCount(4);
  await expect.poll(() => filterOf(page, 'plot', '.ex-fig')).toBe(FILTER);
  await expect(page.locator('.ex-fig').first()).toHaveCSS('background-color', 'rgb(23, 27, 34)');
  const dir = process.env.FIGURE_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `extras-new-dark-${page.viewportSize()!.width}.png`), fullPage: true });
});

test('extras figures tab keeps an older figure on its white mat in dark mode', async ({ page }) => {
  await open(page, 'old', 'dark');
  await page.goto('/books/p1/extras');
  await expect(page.locator('.ex-fig img')).toHaveCount(4);
  await expect(page.locator('.ex-fig img[data-ink]')).toHaveCount(0);
  await expect(page.locator('.ex-fig').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});
