// Fixes from the 0.4.0 release check. Each test builds its own book through the API so it does not depend on another spec.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { mockFigureApi } from './figures-mocks';

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

const S1 = 'Primo paragrafo del testo.\n\nSecondo paragrafo del testo.\n\nTerzo paragrafo del testo.';
const S2 = 'Questa sezione sta nello stesso capitolo.';

let n = 0;
/** A book with an approved two-section outline and text in both sections. Returns its id. */
async function makeBook(request: APIRequestContext): Promise<string> {
  n += 1;
  const created = await request.post('/api/projects', { headers: H, data: { title: `Release check ${n}`, subject: 'Analisi', slug: `release-check-${Date.now()}-${n}`, authors: ['Tost'], language: 'it' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = (await created.json()).id as string;
  const o = await request.put(`/api/projects/${id}/outline`, { headers: H, data: { outline, baseRevId: null } });
  expect(o.ok(), await o.text()).toBeTruthy();
  for (const [node, md] of [['s1', S1], ['s2', S2]]) {
    const sec = await request.put(`/api/projects/${id}/sections/${node}`, { headers: H, data: { markdown: md, baseRevId: null } });
    expect(sec.ok(), await sec.text()).toBeTruthy();
  }
  return id;
}

async function uploadMarkdown(request: APIRequestContext, book: string, name: string, text: string): Promise<string> {
  const up = await request.post(`/api/projects/${book}/resources`, { headers: H, multipart: { role: 'theory', file: { name, mimeType: 'text/markdown', buffer: Buffer.from(text) } } });
  expect(up.ok(), await up.text()).toBeTruthy();
  const id = (await up.json())[0].id as string;
  await expect.poll(async () => (await (await request.get(`/api/resources/${id}/pages`)).json()).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return id;
}

/** Shows `notes` as the evidence of the section's first block, whatever the service holds. */
async function citeFirstBlock(page: Page, book: string, notes: unknown[]) {
  await page.route(`**/api/projects/${book}/sections/s1`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const json = await (await route.fetch()).json();
    json.evidence = { id: 'e1', projectId: book, nodeId: 's1', provider: 'notebooklm', query: '', answer: '', notes, createdAt: new Date().toISOString() };
    json.current.citations = { '0': (notes as { id: string }[]).map((x) => x.id) };
    await route.fulfill({ json });
  });
}

test('the evidence drawer says a Markdown source has no page picture, with no retry', async ({ page, request }) => {
  const book = await makeBook(request);
  const rid = await uploadMarkdown(request, book, 'appunti.md', '# Appunti\n\nIl limite di una funzione.');
  await citeFirstBlock(page, book, [{ id: 'n1', quote: 'Il limite di una funzione.', resourceId: rid, page: 0, verified: true, claim: '' }]);
  const images: number[] = [];
  page.on('response', (r) => { if (/\/pages\/\d+\/image/.test(r.url())) images.push(r.status()); });
  await page.goto(`/books/${book}/manuscript/s1`);
  await page.locator('.ms-block').first().click();
  const note = page.getByRole('article', { name: 'Evidence note 1' });
  await expect(note.getByText('This kind of source has no page picture.')).toBeVisible();
  await expect(note.getByText('Il limite di una funzione.')).toBeVisible();
  await expect(note.getByText('The page image did not load.')).toHaveCount(0);
  await expect(note.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(images, 'the drawer does not ask for a picture the source cannot have').toEqual([]);
});

test('a real failure to load a page image keeps the retry', async ({ page, request }) => {
  const book = await makeBook(request);
  const rid = await uploadMarkdown(request, book, 'appunti.md', '# Appunti\n\nTesto.');
  // The same note, but the source is reported as a PDF whose render fails.
  await page.route(`**/api/projects/${book}/resources`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const list = await (await route.fetch()).json();
    await route.fulfill({ json: list.map((r: { id: string }) => (r.id === rid ? { ...r, kind: 'pdf' } : r)) });
  });
  await page.route(`**/api/resources/${rid}/pages/0/image*`, (route) => route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'boom' } } }));
  await citeFirstBlock(page, book, [{ id: 'n1', quote: 'Testo.', resourceId: rid, page: 0, verified: true, claim: '' }]);
  await page.goto(`/books/${book}/manuscript/s1`);
  await page.locator('.ms-block').first().click();
  const note = page.getByRole('article', { name: 'Evidence note 1' });
  await expect(note.getByText('The page image did not load.')).toBeVisible();
  await expect(note.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the evidence sheet has the block\'s Edit button, and it opens the editor above a closed sheet', async ({ page, request }) => {
    const book = await makeBook(request);
    await page.goto(`/books/${book}/manuscript/s1`);
    await page.locator('.ms-block').nth(1).tap();
    const sheet = page.locator('.ev-drawer');
    await expect(sheet).toBeVisible();
    // The sheet covers the block's own Edit button, so a touch on it lands on the sheet.
    const own = page.locator('.ms-actions').getByRole('button', { name: 'Edit', exact: true });
    const box = (await own.boundingBox())!;
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.ev-drawer'), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
    await sheet.getByRole('button', { name: 'Edit', exact: true }).tap();
    await expect(page.getByRole('textbox', { name: /Source of block 2$/ })).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /Source of block 2$/ })).toBeFocused();
  });
});

test.describe('a figure block', () => {
  async function openFigureBlock(page: Page) {
    await mockApi(page);
    await mockFigureApi(page, {});
    await page.goto('/books/p1/manuscript/s1');
    const block = page.locator('.ms-block', { has: page.locator('.sb-figure') });
    await expect(block).toBeVisible();
    return block;
  }

  test('Enter opens the figure dialog and Escape returns to the block', async ({ page }) => {
    const block = await openFigureBlock(page);
    await block.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: /^Figure/ })).toBeVisible();
    await expect(page.locator('.ms-edit')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /^Figure/ })).toHaveCount(0);
    await expect(block).toBeFocused();
  });

  test('the raw markup has its own button, named for what it is', async ({ page }) => {
    const block = await openFigureBlock(page);
    await block.click();
    const actions = page.locator('.ms-actions');
    await expect(actions.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await actions.getByRole('button', { name: 'Edit markup' }).click();
    await expect(page.locator('.ms-edit .cm-content')).toContainText(':::image');
  });
});

test.describe('reader preview', () => {
  const filler = Array.from({ length: 40 }, (_, i) => `Paragrafo di riempimento numero ${i + 1}, abbastanza lungo da occupare una riga intera della pagina.`).join('\n\n');
  const chapter1 = `## p1 | Primo paragrafo\n\nSi veda il [secondo paragrafo](ref:chapter/1#p2) e il [paragrafo sulle derivate](ref:chapter/2#p2).\n\n${filler}\n\n## p2 | Secondo paragrafo\n\nQui arriva chi segue il collegamento.`;
  const chapter2 = `## p1 | Prima derivata\n\nTesto.\n\n${filler}\n\n## p2 | Retta tangente\n\nQui arriva chi cambia capitolo.`;

  async function openPreview(page: Page) {
    await mockApi(page);
    await page.route(/\/chapters\/c1\/preview$/, (route) => route.fulfill({ json: { markdown: chapter1, number: 1, assets: {} } }));
    await page.route(/\/chapters\/c2\/preview$/, (route) => route.fulfill({ json: { markdown: chapter2, number: 2, assets: {} } }));
    await page.goto('/books/p1/preview/c1');
    await expect(page.getByRole('button', { name: 'secondo paragrafo' })).toBeVisible();
  }

  test('a link to another section of the chapter scrolls to it', async ({ page }) => {
    await openPreview(page);
    await expect(page.locator('#p2')).not.toBeInViewport();
    await page.getByRole('button', { name: 'secondo paragrafo' }).click();
    await expect(page.locator('#p2')).toBeInViewport();
    await expect(page).toHaveURL(/\/preview\/c1$/);
  });

  test('a link to a section of another chapter opens that chapter at the section', async ({ page }) => {
    await openPreview(page);
    await page.getByRole('button', { name: 'paragrafo sulle derivate' }).click();
    await expect(page).toHaveURL(/\/preview\/c2/);
    await expect(page.getByRole('heading', { name: 'Calcolo differenziale' })).toBeVisible();
    await expect(page.locator('#p2')).toBeInViewport();
  });
});
