// Fixes from the 0.4.0 release check. Each test builds its own book through the API so it does not depend on another spec.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

