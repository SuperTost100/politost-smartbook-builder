import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const FIXTURE = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '../../../fixtures/sample.md');
const H = { 'x-smartbuilder': '1' };

const outline = {
  chapters: [
    {
      id: 'c1', slug: 'limiti', title: 'Limiti',
      sections: [
        { id: 's1', title: 'Definizione di limite', topicIds: [], depth: 'standard', objectives: [], subsections: [] },
        { id: 's2', title: 'Limiti notevoli', topicIds: [], depth: 'standard', objectives: [], subsections: [] },
      ],
    },
  ],
  exclusions: [],
  notation: '',
};

const SECTION_MD = `Una funzione $f$ ha limite $L$ per $x \\to x_0$ se per ogni $\\varepsilon > 0$ esiste $\\delta > 0$.

:::formula{key="lim-def" label="Definizione di limite"}
$$\\forall \\varepsilon>0\\ \\exists \\delta>0$$
:::

Il limite, se esiste, è unico.`;

let bookId = '';

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** The deepest elements that stick out past the right edge, for a readable failure message. */
async function offenders(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && ![...el.children].some((c) => c.getBoundingClientRect().right > vw + 1)) {
        out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ').join('.')} right=${Math.round(r.right)} "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      }
    }
    return out.slice(0, 6).join(' | ') || 'none found';
  });
}

async function seedOutline(request: APIRequestContext) {
  const put = await request.put(`/api/projects/${bookId}/outline`, { headers: H, data: { outline, baseRevId: null } });
  expect(put.ok(), await put.text()).toBeTruthy();
  const sec = await request.put(`/api/projects/${bookId}/sections/s1`, { headers: H, data: { markdown: SECTION_MD, baseRevId: null } });
  expect(sec.ok(), await sec.text()).toBeTruthy();
}

test.describe.configure({ mode: 'serial' });

test('create a book', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Books', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New book' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await page.getByLabel('Title', { exact: true }).fill('Analisi matematica 1');
  await expect(page.getByLabel('Slug')).toHaveValue('analisi-matematica-1');
  await page.getByLabel('Subject').fill('Analisi matematica');
  await page.getByLabel('Authors').fill('Tost');
  await page.getByRole('button', { name: 'Create book' }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/sources/);
  bookId = new URL(page.url()).pathname.split('/')[2];
  await expect(page.getByRole('heading', { name: 'Sources', level: 1 })).toBeVisible();
  await expect(page.getByText('Selected material is sent to the configured AI providers and NotebookLM.')).toBeVisible();
});

test('upload fixtures/sample.md and see it in Sources', async ({ page }) => {
  await page.goto(`/books/${bookId}/sources`);
  await page.getByTestId('source-file-input').setInputFiles({ name: 'sample.md', mimeType: 'text/markdown', buffer: Buffer.from(readFileSync(FIXTURE)) });
  const row = page.getByRole('list', { name: 'Sources' }).getByRole('listitem').filter({ hasText: 'sample.md' });
  await expect(row).toBeVisible();
  await expect(row.getByText(/Ready|Reading|Queued/)).toBeVisible();
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 20_000 });
  await row.getByRole('link', { name: 'sample.md' }).click();
  await expect(page.getByLabel('Inspector for sample.md')).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Pages' })).toBeVisible();
});

test('seed an outline through the API and approve it', async ({ page, request }) => {
  await seedOutline(request);
  await page.goto(`/books/${bookId}/outline`);
  await expect(page.getByLabel('Title of chapter 1')).toHaveValue('Limiti');
  await expect(page.getByLabel('Title of section 1.2')).toHaveValue('Limiti notevoli');
  await page.getByRole('button', { name: 'Approve outline' }).click();
  await expect(page.getByText('Outline approved')).toBeVisible();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
});

test('open the manuscript, edit and save a block', async ({ page }) => {
  await page.goto(`/books/${bookId}/manuscript`);
  await expect(page).toHaveURL(/\/manuscript\/s1/);
  const blocks = page.getByRole('listitem').filter({ has: page.locator('.content-flow') });
  await expect(blocks.first()).toContainText('Una funzione');
  const last = page.locator('.ms-block').last();
  await last.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: /Source of block 3/ });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Questo segue dalla disuguaglianza triangolare.');
  await expect(page.locator('.se-preview')).toContainText('disuguaglianza triangolare');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(page.locator('.ms-block').last()).toContainText('disuguaglianza triangolare');
  // The edit is a new revision and shows up in History.
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'History' }).getByText('You').first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a stale save shows the server message and never overwrites', async ({ page, request }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  await page.locator('.ms-block').first().focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: /Source of block 1/ });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' (bozza)');
  // Someone else saves first.
  const head = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  const other = await request.put(`/api/projects/${bookId}/sections/s1`, { headers: H, data: { markdown: head.current.markdown + '\n\nParagrafo aggiunto altrove.', baseRevId: head.current.id } });
  expect(other.ok()).toBeTruthy();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('button', { name: 'Load latest' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /Couldn't save/ })).toBeVisible();
  const after = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  expect(after.current.markdown).toContain('Paragrafo aggiunto altrove');
  expect(after.current.markdown).not.toContain('(bozza)');
});

test('theme toggle persists', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const before = await html.getAttribute('data-theme');
  const next = before === 'dark' ? 'light' : 'dark';
  await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).click();
  await expect(html).toHaveAttribute('data-theme', next);
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', next);
  expect(await page.evaluate(() => localStorage.getItem('smartbuilder.theme'))).toBe(next);
});

test('keyboard focus is always visible', async ({ page }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  await expect(page.locator('.ms-block').first()).toBeVisible();
  const seen = new Set<string>();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const box = el.closest('.cm-editor') ? getComputedStyle(el.closest('.cm-editor')!) : cs;
      const hasRing = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (box.outlineStyle !== 'none' && parseFloat(box.outlineWidth) >= 2) || cs.boxShadow !== 'none';
      return { label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName, hasRing };
    });
    if (!info) continue;
    seen.add(info.label);
    expect(info.hasRing, `focus ring missing on "${info.label}"`).toBeTruthy();
  }
  expect(seen.size).toBeGreaterThan(5);
});

test('blocks move with the arrow keys and Space opens evidence', async ({ page }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  const first = page.locator('.ms-block').first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.ms-block').nth(1)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('complementary', { name: /Evidence for block 2/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: /Evidence for block/ })).toHaveCount(0);
});

test.describe('mobile layout at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const path of ['/', '/connections', 'sources', 'outline', 'manuscript/s1', 'practice', 'extras', 'review', 'export', 'run']) {
    test(`no horizontal overflow: ${path}`, async ({ page }) => {
      await page.goto(path.startsWith('/') ? path : `/books/${bookId}/${path}`);
      await page.waitForTimeout(600);
      expect(await overflow(page), `Elements wider than the viewport: ${await offenders(page)}`).toBeLessThanOrEqual(1);
    });
  }
});

test('every screen loads without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const paths = ['/', '/connections', '/new', 'settings', 'sources', 'outline', 'manuscript/s1', 'preview/c1', 'practice', 'practice?tab=exam', 'extras', 'extras?tab=ide', 'extras?tab=graphs', 'review', 'export', 'run'];
  for (const path of paths) {
    await page.goto(path.startsWith('/') ? path : `/books/${bookId}/${path}`);
    await expect(page.locator('main h1, main .ms-title').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('the Run pill opens the run panel', async ({ page }) => {
  await page.goto(`/books/${bookId}/sources`);
  await page.getByRole('button', { name: /Idle|Drafting|Paused|Waiting|Preparing|Planning/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Run' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/No runs yet|tasks finished/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('outline rail moves with the arrow keys', async ({ page }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  const rail = page.getByRole('navigation', { name: 'Manuscript outline' });
  await rail.getByRole('link', { name: /Definizione di limite/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rail.getByRole('link', { name: /Limiti notevoli/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(rail.getByRole('button', { name: /Limiti/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(rail.getByRole('link', { name: /Limiti notevoli/ })).toBeHidden();
});

test('new sources appear without reloading', async ({ page, request }) => {
  await page.goto(`/books/${bookId}/sources`);
  await expect(page.getByText('sample.md').first()).toBeVisible();
  const up = await request.post(`/api/projects/${bookId}/resources`, { headers: H, multipart: { role: 'exams', file: { name: 'live-update.md', mimeType: 'text/markdown', buffer: Buffer.from('# Prova\n\nTesto.') } } });
  expect(up.ok(), await up.text()).toBeTruthy();
  await expect(page.getByRole('link', { name: 'live-update.md' })).toBeVisible({ timeout: 10_000 });
});
