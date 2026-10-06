import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';

const sizes = [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }];
const themes = ['light', 'dark'] as const;

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('smartbuilder.theme', t), theme);
}

for (const size of sizes) {
  for (const theme of themes) {
    test.describe(`screens ${size.name} ${theme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height } });
      test.beforeEach(async ({ page }) => { await setTheme(page, theme); await mockApi(page); });

      const shot = async (page: Page, name: string, full = false) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: `e2e/screenshots/${name}-${size.name}-${theme}.png`, fullPage: full });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(1);
      };

      test('projects', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Books' })).toBeVisible(); await shot(page, 'projects'); });
      test('sources', async ({ page }) => { await page.goto('/books/p1/sources/rs1'); await expect(page.getByText('Source inspector')).toBeVisible(); await shot(page, 'sources'); });
      test('outline', async ({ page }) => { await page.goto('/books/p1/outline'); await expect(page.getByRole('heading', { name: 'Topic coverage' })).toBeVisible(); await shot(page, 'outline'); });
      test('manuscript', async ({ page }) => { await page.goto('/books/p1/manuscript/s1'); await expect(page.locator('.ms-block').first()).toBeVisible(); await page.locator('.ms-block').nth(2).click(); await expect(page.locator('.ev-img.is-in').first()).toBeVisible(); await shot(page, 'manuscript'); });
    });
  }
}

test.describe('extra screens', () => {
  test.beforeEach(async ({ page }) => { await mockApi(page); });
  test('manuscript with proposal and editor', async ({ page }) => {
    await page.goto('/books/p1/manuscript/s2');
    await expect(page.getByText('AI proposal ready')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/screenshots/manuscript-proposal-1440-light.png' });
    await page.goto('/books/p1/manuscript/s1');
    await page.locator('.ms-block').nth(3).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-editor')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/screenshots/manuscript-editing-1440-light.png' });
  });
  test('run, connections, review, practice', async ({ page }) => {
    for (const [path, name] of [['/books/p1/run', 'run'], ['/connections', 'connections'], ['/books/p1/review', 'review'], ['/books/p1/practice?tab=exam', 'practice'], ['/books/p1/export', 'export'], ['/books/p1/preview/c1', 'preview'], ['/new', 'new']] as const) {
      await page.goto(path);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `e2e/screenshots/${name}-1440-light.png` });
    }
  });
});
