import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';

// Every book figure sits on the reader's plate (--figure-plate), which is light in both themes, so dark ink stays readable and an
// old white rectangle takes the plate's colour. The fixtures are real drawer output (plot, structure, chemistry diagram, drawing).
// The "old" variant is the same figure as the drawers wrote it before 0.4.0: a white rectangle behind it and no marker.
const NAMES = ['plot', 'structure', 'diagram', 'drawing'] as const;
const read = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${n}.svg`), 'utf8');
const NEW: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, read(n)]));
const OLD: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, NEW[n].replace(' data-sb-ink="dark"', '').replace(/(<title>.*?<\/title>)/, '$1<rect width="100%" height="100%" fill="#FFFFFF"/>')]));
const PLATE = { light: [251, 248, 242], dark: [221, 211, 196] } as const;
const INK_RGB = [0x11, 0x18, 0x27] as const;
const luminance = (c: readonly number[]) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: readonly number[], b: readonly number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = (c: readonly number[]) => `rgb(${c.join(', ')})`;

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
  const source = ['### Quattro figure', 'Le figure seguenti sono disegnate dal builder.', ...NAMES.map((n) => `:::image{src="assets/${n}.svg" alt="Figure ${n}" caption="Disegno di tipo ${n}"}\n:::`)].join('\n\n');
  const section = { chapterId: 'c1', sectionId: 's1', title: 'Quattro figure', proposal: null, evidence: null, issues: [], compiled, current: { id: 'rv1', projectId: 'p1', nodeId: 's1', kind: 'section', markdown: source, origin: 'human', model: null, parentRevId: null, status: 'current', citations: {}, createdAt: '2026-11-11T10:00:00Z' } };
  await page.route('**/api/projects/p1/manuscript', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ chapterId: 'c1', number: 1, title: 'Figure di prova', intro: null, sections: [section] }]) }));
  await page.route('**/api/assets/*/file', (r) => r.fulfill({ contentType: 'image/svg+xml', body: files[/assets\/(\w+)\/file/.exec(r.request().url())![1]] }));
  await page.route('**/api/projects/p1/assets', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(NAMES.map((n) => ({ id: n, projectId: 'p1', nodeId: null, filename: `${n}.svg`, mime: 'image/svg+xml', origin: n === 'drawing' ? 'generated-svg' : n === 'diagram' ? 'diagram' : n, spec: null, caption: `Disegno ${n}`, alt: `Figure ${n}`, checks: [], createdAt: '2026-11-11T10:00:00Z' }))) }));
}

/** Every figure image sits in a frame with the plate colour, with no filter, multiplied onto the plate. */
async function expectPlate(page: Page, frame: string, theme: 'light' | 'dark') {
  const plate = PLATE[theme];
  await expect(page.locator(frame).first()).toHaveCSS('background-color', rgb(plate));
  for (const n of NAMES) {
    const img = page.locator(`${frame} img[alt="Figure ${n}"]`);
    await expect(img).toHaveCSS('filter', 'none');
    await expect(img).toHaveCSS('mix-blend-mode', 'multiply');
  }
  expect(contrast(INK_RGB, plate), 'ink on the plate').toBeGreaterThanOrEqual(7);
}

for (const width of [1440, 390]) for (const theme of ['light', 'dark'] as const) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const variant of ['new', 'old'] as const) test(`reader preview, ${variant} figures, ${theme} theme`, async ({ page }) => {
      await open(page, variant, theme);
      await page.goto('/books/p1/preview/c1');
      await expect(page.locator('.sb-figure-frame img')).toHaveCount(4);
      await expectPlate(page, '.sb-figure-frame', theme);
      await expect(page.locator('.sb-figure-frame img').first()).toHaveJSProperty('complete', true);
      await page.waitForTimeout(300);
      const dir = process.env.FIGURE_SHOTS;
      if (dir) await page.screenshot({ path: join(dir, `reader-preview-${variant}-${theme}-${width}.png`), fullPage: true });
    });
  });
}

for (const theme of ['light', 'dark'] as const) test(`extras figure cards use the plate, ${theme} theme`, async ({ page }) => {
  await open(page, 'new', theme);
  await page.goto('/books/p1/extras');
  await expect(page.locator('.ex-fig img')).toHaveCount(4);
  await expectPlate(page, '.ex-fig', theme);
  const dir = process.env.FIGURE_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `extras-new-${theme}-${page.viewportSize()!.width}.png`), fullPage: true });
});
