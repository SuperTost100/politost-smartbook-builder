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
      if (r.right > vw + 1 && !Array.from(el.children).some((c) => c.getBoundingClientRect().right > vw + 1)) {
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
  await expect(page.getByRole('alert').filter({ hasText: 'The section changed while you were editing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /Couldn't save/ })).toBeVisible();
  // The typed text is still in the editor and the service has not been overwritten.
  await expect(page.locator('.ms-edit .cm-content')).toContainText('(bozza)');
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

async function openBlockEditor(page: Page, n: number) {
  await page.locator('.ms-block').nth(n - 1).focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: new RegExp(`Source of block ${n}$`) });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
}

test('an update to another block keeps the unsaved draft, and nothing is saved until the author chooses', async ({ page, request }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  await openBlockEditor(page, 1);
  await page.keyboard.type(' DRAFT-KEEP');
  await page.evaluate(() => document.querySelector('.ms-edit .cm-content')?.setAttribute('data-mark', 'same-editor'));

  // Another writer inserts a block above and changes the last one.
  const head = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  const lastBefore = head.current.markdown.split('\n\n').at(-1) as string;
  const changed = ('Paragrafo inserito sopra.\n\n' + head.current.markdown).replace(lastBefore, `${lastBefore} (aggiornato altrove)`);
  const put = await request.put(`/api/projects/${bookId}/sections/s1`, { headers: H, data: { markdown: changed, baseRevId: head.current.id } });
  expect(put.ok(), await put.text()).toBeTruthy();

  const banner = page.getByRole('alert').filter({ hasText: 'The section changed while you were editing' });
  await expect(banner).toBeVisible();
  // The draft follows its block (now block 2) in the same editor instance.
  const cm = page.locator('.ms-edit .cm-content');
  await expect(cm).toContainText('DRAFT-KEEP');
  await expect(cm).toHaveAttribute('data-mark', 'same-editor');
  await expect(page.getByRole('textbox', { name: /Source of block 2$/ })).toBeVisible();
  await expect(page.locator('.ms-block').first()).toContainText('Paragrafo inserito sopra');
  // Saving is off until the author chooses.
  await expect(page.getByRole('button', { name: 'Save block' })).toBeDisabled();
  await page.keyboard.press('Control+Enter');
  const unchanged = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  expect(unchanged.current.markdown).not.toContain('DRAFT-KEEP');

  await banner.getByRole('button', { name: 'Compare' }).click();
  const dialog = page.getByRole('dialog', { name: /Compare your draft/ });
  await expect(dialog).toContainText('DRAFT-KEEP');
  await page.keyboard.press('Escape');

  await banner.getByRole('button', { name: 'Keep my version (save over latest)' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  const saved = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  expect(saved.current.markdown).toContain('DRAFT-KEEP');
  expect(saved.current.markdown).toContain('Paragrafo inserito sopra');
  expect(saved.current.markdown).toContain('(aggiornato altrove)');
  await expect(banner).toBeHidden();
});

test('discarding the draft leaves the latest text untouched', async ({ page, request }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  await openBlockEditor(page, 1);
  await page.keyboard.type(' DISCARD-ME');
  const head = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  const put = await request.put(`/api/projects/${bookId}/sections/s1`, { headers: H, data: { markdown: head.current.markdown + '\n\nUltimo paragrafo.', baseRevId: head.current.id } });
  expect(put.ok()).toBeTruthy();
  const banner = page.getByRole('alert').filter({ hasText: 'The section changed while you were editing' });
  await expect(banner).toBeVisible();
  await expect(page.locator('.ms-edit .cm-content')).toContainText('DISCARD-ME');
  await banner.getByRole('button', { name: 'Discard my draft' }).click();
  await expect(page.locator('.ms-edit')).toHaveCount(0);
  await expect(page.locator('.ms-block').last()).toContainText('Ultimo paragrafo');
  const after = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  expect(after.current.markdown).not.toContain('DISCARD-ME');
});

test('text typed while a save is on its way stays in the editor as a new draft', async ({ page, request }) => {
  await page.goto(`/books/${bookId}/manuscript/s1`);
  await openBlockEditor(page, 1);
  await page.keyboard.type(' PRIMA');
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/projects/${bookId}/sections/s1`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await held;
    await route.continue();
  });
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Saving' })).toBeVisible();
  await page.keyboard.type(' DOPO');
  release();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(page.locator('.ms-edit .cm-content')).toContainText('PRIMA DOPO');
  await expect(page.getByRole('button', { name: 'Save block' })).toBeEnabled();
  const after = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  expect(after.current.markdown).toContain('PRIMA');
  expect(after.current.markdown).not.toContain('DOPO');
  await page.unroute(`**/api/projects/${bookId}/sections/s1`);
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.ms-edit')).toHaveCount(0);
  const saved = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  expect(saved.current.markdown).toContain('PRIMA DOPO');
});

test('Practice shows a question status change without reloading', async ({ page, request }) => {
  const created = await request.post(`/api/projects/${bookId}/questions`, { headers: H, data: { kind: 'exercise', origin: 'adapted', statement: 'Calcola il limite di sin(x)/x per x che tende a 0.', hint: '', solution: 'Vale 1.', difficulty: 'medio', topicIds: [] } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const q = await created.json();
  await page.goto(`/books/${bookId}/practice`);
  const item = page.locator('.pr-item').filter({ hasText: 'Calcola il limite di sin(x)/x' });
  await expect(item.locator('.ui-badge').first()).toHaveText('draft');
  // Verification finishing elsewhere (here: through the API) must show up on the open screen.
  const patched = await request.patch(`/api/questions/${q.id}`, { headers: H, data: { rev: q.rev, status: 'verified' } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  await expect(item.locator('.ui-badge').first()).toHaveText('verified', { timeout: 10_000 });
});

test('a proposal is accepted against the head that was shown; a 409 shows the message and Reload', async ({ page, request }) => {
  const head = await (await request.get(`/api/projects/${bookId}/sections/s1`)).json();
  const proposal = { ...head.current, id: 'prop-e2e', origin: 'ai', status: 'proposal', markdown: head.current.markdown.replace('Il limite', 'Il limite (proposto)'), parentId: head.current.id };
  await page.route(`**/api/projects/${bookId}/sections/s1`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), proposal } });
  });
  let sent: Record<string, unknown> | null = null;
  await page.route(`**/api/projects/${bookId}/sections/s1/proposal`, async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 409, contentType: 'application/json', json: { error: { code: 'stale_head', message: 'The text changed after you opened this proposal.', action: 'Reload to compare again.' } } });
  });
  await page.goto(`/books/${bookId}/manuscript/s1`);
  const banner = page.getByRole('region', { name: 'AI proposal' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The text changed after you opened this proposal.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  expect(sent).toMatchObject({ action: 'accept', revId: 'prop-e2e', headRevId: head.current.id });
  await expect(banner.getByRole('button', { name: 'Accept' })).toBeDisabled();
});

test('a quota wait shows when it resumes and offers no Continue or Skip', async ({ page }) => {
  const at = new Date(Date.now() + 3 * 3600_000).toISOString();
  const waiting = { taskId: 't-q', reason: 'The provider limit was reached.', action: '', kind: 'quota', retryAt: at };
  const run = { id: 'r-quota', projectId: bookId, kind: 'generate', status: 'running', createdAt: new Date().toISOString(), finishedAt: null, counts: { retry_wait: 1, succeeded: 2 }, waiting };
  const task = { id: 't-q', runId: 'r-quota', kind: 'draft', label: 'Draft 1.1', state: 'retry_wait', attempts: 1, provider: 'claude', error: null, waitReason: waiting.reason, startedAt: null, finishedAt: null };
  await page.route(`**/api/projects/${bookId}/runs`, (route) => route.request().method() === 'GET' ? route.fulfill({ json: [run] }) : route.fallback());
  await page.route('**/api/runs/r-quota', (route) => route.fulfill({ json: { ...run, tasks: [task], usage: [] } }));
  await page.goto(`/books/${bookId}/run`);
  const section = page.getByRole('region', { name: 'Waiting for provider quota' });
  await expect(section).toContainText('Waiting for claude quota — resumes at');
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skip' })).toHaveCount(0);
});

test('Approve and export counts blockers that are only proposed', async ({ page }) => {
  const issue = (id: string, status: string, severity: string) => ({ id, projectId: bookId, nodeId: 's1', questionId: null, revId: null, source: 'review', severity, category: 'math', quote: '', message: 'm', suggestion: '', status, resolution: '', createdAt: new Date().toISOString() });
  await page.route(`**/api/projects/${bookId}/issues`, (route) => route.fulfill({ json: [issue('i1', 'proposed', 'blocker'), issue('i2', 'open', 'minor')] }));
  await page.route(`**/api/projects/${bookId}/validate`, (route) => route.fulfill({ json: { ok: true, errors: [], warnings: [], lint: [] } }));
  await page.goto(`/books/${bookId}/export`);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('No errors. The package is valid.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and export' })).toBeDisabled();
  await expect(page.getByText(/1 blocker issue still unresolved/)).toBeVisible();
});

test('manuscript figures resolve whether the map is keyed by assets/<file> or the bare name', async ({ page }) => {
  const svg = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  for (const key of ['assets/fig.svg', 'fig.svg']) {
    await page.route(`**/api/projects/${bookId}/chapters/c1/preview`, (route) => route.fulfill({ json: { markdown: '## p1 | Definizione\n\n:::image{src="assets/fig.svg" alt="Figura" caption="Una figura"}\n:::\n', number: 1, assets: { [key]: svg } } }));
    await page.goto(`/books/${bookId}/preview/c1`);
    await expect(page.locator('.reader-preview img[alt="Figura"]')).toBeVisible();
    await page.unroute(`**/api/projects/${bookId}/chapters/c1/preview`);
  }
});
