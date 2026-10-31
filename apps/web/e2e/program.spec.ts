import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test.describe('course program card', () => {
  test.beforeEach(async ({ page }) => { await mockApi(page); });

  test('shows the parsed items, saves edits, and keeps keys of existing items', async ({ page }) => {
    await page.goto('/books/p1/settings');
    const card = page.getByRole('region', { name: 'Course program' });
    await expect(card.getByRole('heading', { name: 'Course program' })).toBeVisible();
    await expect(card.getByLabel('Title of item 1')).toHaveValue('Limiti di successioni');
    await expect(card.getByLabel('Program text')).toHaveValue(/Modalità d’esame/);
    await expect(card.getByRole('button', { name: 'Save program' })).toBeDisabled();

    await card.getByLabel('Title of item 1').fill('Limiti di successioni numeriche');
    await card.getByRole('button', { name: 'Add item' }).click();
    await card.getByLabel('Title of item 9').fill('Teorema dei valori intermedi');
    await card.getByLabel('Proofs asked').last().fill('Teorema degli zeri');
    await card.getByLabel('Proofs are asked').check();
    await card.getByLabel('Summary').fill('Scritto di 2 ore.');
    await expect(card.getByText('Unsaved changes.')).toBeVisible();

    // Enter inside the card must not submit the whole book form.
    await card.getByLabel('Title of item 9').press('Enter');
    await expect(page).toHaveURL(/\/books\/p1\/settings$/);

    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/program/items'));
    await card.getByRole('button', { name: 'Save program' }).click();
    const body = (await put).postDataJSON() as { items: { key: string; title: string; proofs: string[] }[]; examFormat: { proofs: string; summary: string } };
    expect(body.items).toHaveLength(9);
    expect(body.items[0]).toMatchObject({ key: 'limiti-successioni', title: 'Limiti di successioni numeriche' });
    expect(body.items[8]).toMatchObject({ key: 'teorema-dei-valori-intermedi', proofs: ['Teorema degli zeri'] });
    expect(body.examFormat).toMatchObject({ proofs: 'required', summary: 'Scritto di 2 ore.' });
    await expect(page.getByText('Course program saved')).toBeVisible();
    await expect(card.getByText('Saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('region', { name: 'Course program' }).getByLabel('Title of item 9')).toHaveValue('Teorema dei valori intermedi');
  });

  test('reading again asks first, shows the run, then returns the new list', async ({ page }) => {
    await page.goto('/books/p1/settings');
    const card = page.getByRole('region', { name: 'Course program' });
    await card.getByLabel('Course guide address').fill('not an address');
    await expect(card.getByText('Use a full address that starts with https://.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Read again' })).toBeDisabled();
    await card.getByLabel('Course guide address').fill('https://didattica.polito.it/guide');
    await card.getByRole('button', { name: 'Read again' }).click();
    await expect(page.getByRole('dialog')).toContainText('replaced by a fresh reading');
    await page.getByRole('dialog').getByRole('button', { name: 'Read again' }).click();
    await expect(card.getByText('Reading the program', { exact: true })).toBeVisible();
    await expect(card.getByLabel('Title of item 1')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Reading the program', { exact: true })).toHaveCount(0);
  });

  test('a new book has no program card yet and removes off-program sections by default', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByText('After you create the book, come back to Book setup')).toBeVisible();
    await expect(page.getByLabel('Keep them with a note')).not.toBeChecked();
    await expect(page.getByLabel('Remove off-program sections')).toBeChecked();
  });

  test('the book without a program shows the empty card', async ({ page }) => {
    await page.unrouteAll();
    await mockApi(page, { program: false });
    await page.goto('/books/p1/settings');
    const card = page.getByRole('region', { name: 'Course program' });
    await expect(card.getByRole('button', { name: 'Read program' })).toBeDisabled();
    await card.getByLabel('Program text').fill('Programma\n1. Derivate');
    await expect(card.getByRole('button', { name: 'Read program' })).toBeEnabled();
    await expect(card.getByLabel('Title of item 1')).toHaveCount(0);
  });
});

test.describe('outline with a program', () => {
  test.beforeEach(async ({ page }) => { await mockApi(page); });

  test('sections list their program items and the coverage names what is missing', async ({ page }) => {
    await page.goto('/books/p1/outline');
    const cov = page.getByRole('region', { name: 'Program coverage' });
    await expect(cov.getByText('2 uncovered')).toBeVisible();
    await expect(cov.getByText('Integrali impropri')).toBeVisible();
    await expect(cov.getByText('Il programma le rimanda al corso di Analisi 2.')).toBeVisible();
    await expect(page.getByLabel('Program items of section 1.1').getByText('Limiti di successioni')).toBeVisible();
    await expect(page.getByLabel('Program items of section 1.3').getByText('No program item')).toBeVisible();
    await expect(page.getByText('Exam guide', { exact: true })).toBeVisible();

    await cov.getByRole('button', { name: 'Leave out' }).first().click();
    await cov.getByLabel(/Reason for leaving out/).fill('Fuori dal tempo del corso');
    await cov.locator('form').getByRole('button', { name: 'Leave out' }).click();
    await expect(cov.getByText('1 uncovered')).toBeVisible();
    await expect(cov.getByText('Fuori dal tempo del corso')).toBeVisible();
  });
});

test.describe('alignment panel', () => {
  test('checks, selects findings, and applies after a confirm', async ({ page }) => {
    await mockApi(page, { alignment: false });
    await page.goto('/books/p1/review');
    const panel = page.getByRole('region', { name: 'Course alignment' });
    await expect(panel.getByText('Compares the outline')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Align book' })).toHaveCount(0);

    await panel.getByRole('button', { name: 'Check alignment' }).click();
    for (const group of ['Missing from the book', 'Too thin for the exam', 'Proofs the exam asks', 'Outside the program', 'Order', 'Exam guides']) {
      await expect(panel.getByText(group, { exact: true })).toBeVisible();
    }
    await expect(panel.getByText('Serie numeriche', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText('Whole section', { exact: true })).toBeVisible();
    // Everything that can be applied starts selected; order findings cannot be.
    const boxes = panel.getByRole('checkbox');
    await expect(boxes).toHaveCount(8);
    const order = panel.getByRole('checkbox', { name: /Cannot be applied/ });
    await expect(order).toBeDisabled();
    await expect(order).not.toBeChecked();
    await expect(panel.getByRole('button', { name: 'Align book (7)' })).toBeEnabled();

    // Leave out the exam guide.
    await panel.getByRole('checkbox', { name: /Chapter 2 has exam questions/ }).uncheck();
    await expect(panel.getByRole('button', { name: 'Align book (6)' })).toBeEnabled();

    await panel.getByRole('button', { name: 'Align book (6)' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Adds 2 sections for missing program items');
    await expect(dialog).toContainText('Removes 1 section from the outline');
    await expect(dialog).toContainText('Cuts 1 off-program passage');
    await expect(dialog).toContainText('Put back returns each one to where it was');
    await expect(dialog).not.toContainText('exam guide');

    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/alignment/apply'));
    await dialog.getByRole('button', { name: 'Align book' }).click();
    const body = (await post).postDataJSON() as { reportId: string; findings: number[] };
    expect(body).toEqual({ reportId: 'al2', findings: [0, 1, 2, 3, 4, 5] });

    await expect(panel.getByText('Removed section 1.3 Continuità from the outline.')).toBeVisible();
    const removed = panel.getByRole('list', { name: 'Removed sections' });
    await removed.getByRole('button', { name: 'Put back' }).click();
    await expect(removed.getByText(/^Put back /)).toBeVisible();
    await expect(removed.getByRole('button', { name: 'Put back' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Align book/ })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  test('without a program it points to Book setup', async ({ page }) => {
    await mockApi(page, { program: false });
    await page.goto('/books/p1/review');
    const panel = page.getByRole('region', { name: 'Course alignment' });
    await expect(panel.getByText('Add the course program')).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Open Book setup' })).toHaveAttribute('href', '/books/p1/settings');
    await expect(panel.getByRole('button', { name: /Check/ })).toHaveCount(0);
  });

  test('a report on an older outline cannot be applied', async ({ page }) => {
    await mockApi(page, { staleReport: true });
    await page.goto('/books/p1/review');
    const panel = page.getByRole('region', { name: 'Course alignment' });
    await expect(panel.getByText('The outline changed after this check')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Align book/ })).toBeDisabled();
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('program card, outline and alignment fit the width', async ({ page }) => {
    await mockApi(page);
    for (const [path, name] of [['/books/p1/settings', 'Course program'], ['/books/p1/outline', 'Program coverage'], ['/books/p1/review', 'Course alignment']] as const) {
      await page.goto(path);
      await expect(page.getByRole('region', { name })).toBeVisible();
      await noOverflow(page);
    }
  });
});
