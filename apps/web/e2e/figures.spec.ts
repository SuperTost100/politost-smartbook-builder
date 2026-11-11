import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { FIG_ALT, FIG_COMPILE_ERROR, mockFigureApi, type FigureMock } from './figures-mocks';

// The figure dialog (markers 2a-2g of the 0.4.0 mockup) and Add figure (3a-3d), with a mocked API that keeps its state like the
// service does. Set FIGURE_SHOTS to a folder to also write a screenshot of every state.
const SHOTS = process.env.FIGURE_SHOTS;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64');

async function open(page: Page, o: { theme?: 'light' | 'dark'; stock?: boolean; assetsFail?: boolean } = {}): Promise<FigureMock> {
  await page.addInitScript((t) => localStorage.setItem('smartbuilder.theme', t), o.theme ?? 'light');
  await mockApi(page);
  const fm = await mockFigureApi(page, { stock: o.stock, assetsFail: o.assetsFail });
  await page.goto('/books/p1/manuscript/s1');
  await expect(page.locator('.ms-block').first()).toBeVisible();
  return fm;
}

const figureBlock = (page: Page) => page.locator('.ms-block', { has: page.locator('.sb-figure') });
async function openDialog(page: Page) {
  await figureBlock(page).click();
  // Below 1100 px the evidence drawer covers the block's own buttons, so the drawer offers the same entry.
  const narrow = page.viewportSize()!.width < 1100;
  await page.locator(narrow ? '.ev-drawer' : '.ms-actions').getByRole('button', { name: 'Edit figure' }).click();
  const dialog = page.getByRole('dialog', { name: /^Figure/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.fd-preview img')).toHaveJSProperty('complete', true);
  return dialog;
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}-${page.viewportSize()!.width}-${await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')}.png`) });
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
const openSource = async (dialog: ReturnType<Page['locator']>) => { await dialog.locator('summary', { hasText: 'Source' }).click(); await expect(dialog.locator('.cm-editor')).toBeVisible(); };
/** Replaces the whole text of the dialog's source editor. */
async function typeSource(page: Page, text: string) {
  await page.locator('.fd-code .cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test.describe('Extras, Figures tab', () => {
  test('lists the figures the text uses once each, with no editing, and a link into the Manuscript', async ({ page }) => {
    await open(page);
    // Two saves leave two older copies of the figure behind (the service keeps them for History).
    for (const caption of ['Prima didascalia nuova.', 'Seconda didascalia nuova.']) {
      const dialog = await openDialog(page);
      await dialog.getByLabel('Caption').fill(caption);
      await dialog.getByRole('button', { name: 'Save figure' }).click();
      await expect(dialog).toBeHidden();
    }
    await page.goto('/books/p1/extras');
    await expect(page.getByRole('tab', { name: 'Figures (1)' })).toBeVisible();
    await expect(page.locator('.ex-card')).toHaveCount(1);
    const card = page.locator('.ex-card');
    await expect(card).toContainText('Seconda didascalia nuova.');
    await expect(card).toContainText('Fig. 1.2 in 1. Definizione di limite');
    await expect(page.getByRole('button', { name: 'Save figure' })).toHaveCount(0);
    await expect(page.getByLabel('Caption')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import file' })).toHaveCount(0);
    await noOverflow(page);
    await shot(page, 'extras-figures');
    await card.getByRole('link', { name: 'Edit in the Manuscript' }).click();
    await expect(page).toHaveURL(/\/manuscript\/s1$/);
    await expect(page.getByRole('dialog', { name: /^Figure/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /^Figure/ }).getByLabel('Caption')).toHaveValue('Seconda didascalia nuova.');
  });
});

test.describe('History, figure versions', () => {
  test('a version made by a figure action says what it did', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Nuova didascalia');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('dialog', { name: 'History' }).getByText('Figure "Amplificatore invertente": caption changed to "Nuova didascalia"')).toBeVisible();
  });
});

test.describe('History, a Restore', () => {
  test('says it is a restore and which version it restored, and its own note does not describe the difference', async ({ page }) => {
    const fm = await open(page);
    fm.restored = true;
    await page.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('dialog', { name: 'History' });
    const when = await page.evaluate((ms) => new Date(Date.now() - ms).toLocaleString('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), 30 * 60_000);
    await expect(history.getByText(`Restored the version of ${when}`)).toBeVisible();
    // The version that was restored keeps its own note, and the restore stands in the list on its own, not inside a group of earlier edits.
    await expect(history.getByText('Figure "Amplificatore invertente": source rendered')).toHaveCount(1);
    await expect(history.getByText(/earlier edit/)).toHaveCount(0);
    await shot(page, 'history-restore');
  });
});

test.describe('figure dialog, edits that must not be lost', () => {
  const saveButton = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('button', { name: 'Save figure' });

  test('a caption saved in another tab is not replaced silently: the dialog shows it and the author chooses', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('La mia didascalia');
    fm.elsewhere({ caption: 'Didascalia salvata altrove' });
    const headAfterOtherTab = fm.head();
    const notice = dialog.getByRole('alert').filter({ hasText: 'The caption changed while you were editing' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('It is now: “Didascalia salvata altrove”');
    await expect(dialog.getByLabel('Caption')).toHaveValue('La mia didascalia');
    // Nothing is sent until the author has chosen.
    await expect(saveButton(dialog)).toBeDisabled();
    await shot(page, 'conflict-caption');
    await notice.getByRole('button', { name: 'Keep my version' }).click();
    await expect(notice).toBeHidden();
    await saveButton(dialog).click();
    await expect(page.getByText('Figure saved')).toBeVisible();
    expect(fm.writes.filter((w) => w.call.startsWith('PATCH')).map((w) => w.body)).toEqual([{ baseRevId: headAfterOtherTab, caption: 'La mia didascalia' }]);
  });

  test('taking the other caption puts it in the field and leaves nothing to save', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('La mia didascalia');
    fm.elsewhere({ caption: 'Didascalia salvata altrove' });
    const notice = dialog.getByRole('alert').filter({ hasText: 'The caption changed while you were editing' });
    await notice.getByRole('button', { name: 'Use the other version' }).click();
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia salvata altrove');
    await expect(notice).toBeHidden();
    await expect(saveButton(dialog)).toBeDisabled();
  });

  test('a description and a source changed in another tab get the same notice, and Render waits for the choice', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('What it shows').fill('Il mio testo.');
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt)');
    fm.elsewhere({ shows: 'Testo salvato altrove.', source: '#rect(width: 20pt, height: 10pt)' });
    await expect(dialog.getByRole('alert').filter({ hasText: 'The description changed while you were editing' })).toContainText('It is now: “Testo salvato altrove.”');
    const source = dialog.getByRole('alert').filter({ hasText: 'The source changed while you were editing' });
    await expect(source).toContainText('#rect(width: 20pt, height: 10pt)');
    await expect(dialog.getByRole('button', { name: 'Render' })).toBeDisabled();
    await source.getByRole('button', { name: 'Keep my version' }).click();
    await expect(dialog.getByRole('button', { name: 'Render' })).toBeDisabled();
    await dialog.getByRole('alert').filter({ hasText: 'The description changed while you were editing' }).getByRole('button', { name: 'Use the other version' }).click();
    await expect(dialog.getByLabel('What it shows')).toHaveValue('Testo salvato altrove.');
    await expect(dialog.getByRole('button', { name: 'Render' })).toBeEnabled();
  });

  test('an edit to another block of the section does not stop a caption save, which goes on the new head', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('La mia didascalia');
    fm.elsewhere({});
    await expect(dialog.getByText('Drawn just now')).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await saveButton(dialog).click();
    await expect(page.getByText('Figure saved')).toBeVisible();
  });

  for (const how of ['Escape', 'Cancel', 'Close', 'outside'] as const) {
    test(`${how} with an unsaved caption asks before it discards, and Keep editing keeps the text`, async ({ page }) => {
      await open(page);
      const dialog = await openDialog(page);
      await dialog.getByLabel('Caption').fill('Didascalia scritta e non salvata');
      const close = async () => {
        if (how === 'Escape') await page.keyboard.press('Escape');
        else if (how === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        else if (how === 'Close') await dialog.locator('.ui-dialog__head').getByRole('button', { name: 'Close' }).click();
        else await page.mouse.click(4, 4);
      };
      await close();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
      await shot(page, 'discard-ask');
      await dialog.getByRole('button', { name: 'Keep editing' }).click();
      await expect(dialog.getByText('Discard your changes to this figure?')).toBeHidden();
      await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia scritta e non salvata');
      await close();
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(dialog).toBeHidden();
    });
  }

  test('an edited description or a source that is not rendered counts as unsaved, and an untouched dialog closes at once', async ({ page }) => {
    await open(page);
    let dialog = await openDialog(page);
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt)');
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dialog).toBeHidden();
    dialog = await openDialog(page);
    await dialog.getByLabel('What it shows').fill('Un altro testo.');
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await dialog.getByLabel('What it shows').fill(await dialog.getByLabel('What it shows').inputValue());
    await dialog.getByRole('button', { name: 'Discard', exact: true }).waitFor({ state: 'detached' }).catch(() => undefined);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    dialog = await openDialog(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('figure dialog, leaving the page with unsaved edits', () => {
  test('a reload or closing the tab asks first while a field or the source is unsaved, and not otherwise', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    // Nothing typed: the page leaves without a question.
    let asked = 0;
    page.on('dialog', (d) => { if (d.type() === 'beforeunload') asked++; void d.dismiss(); });
    const prompt = async () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    expect(await prompt()).toBe(false);
    await dialog.getByLabel('Caption').fill('Didascalia non salvata');
    expect(await prompt()).toBe(true);
    // The source typed but not rendered counts too.
    await dialog.getByLabel('Caption').fill('Amplificatore invertente con resistenze R₁ e R₂.');
    expect(await prompt()).toBe(false);
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt)');
    expect(await prompt()).toBe(true);
    expect(asked).toBe(0);
  });

  test('a save or a discard takes the prompt away again', async ({ page }) => {
    await open(page);
    let dialog = await openDialog(page);
    const prompt = async () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    await dialog.getByLabel('Caption').fill('Didascalia salvata');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog).toBeHidden();
    expect(await prompt()).toBe(false);
    dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Didascalia scartata');
    expect(await prompt()).toBe(true);
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toBeHidden();
    expect(await prompt()).toBe(false);
  });

  test('browser Back with unsaved edits asks the discard question and stays on the section until the author chooses', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('smartbuilder.theme', 'light'));
    await mockApi(page);
    await mockFigureApi(page);
    await page.goto('/books/p1/manuscript/s2');
    await expect(page.locator('.ms-block').first()).toBeVisible();
    // A move the app makes itself (the outline rail), so Back is a move the router knows about.
    await page.locator('.ms-rail').getByRole('link', { name: /Definizione di limite/ }).click();
    await expect(page).toHaveURL(/manuscript\/s1$/);
    await expect(page.locator('.ms-block', { has: page.locator('.sb-figure') })).toBeVisible();
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Didascalia non salvata');
    await page.goBack();
    await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
    await expect(page).toHaveURL(/manuscript\/s1$/);
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia non salvata');
    await expect(page).toHaveURL(/manuscript\/s1$/);
    await page.goBack();
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(page).toHaveURL(/manuscript\/s2$/);
    await expect(dialog).toBeHidden();
  });
});

test.describe('figure dialog, alt text', () => {
  const saveButton = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('button', { name: 'Save figure' });
  const patches = (fm: FigureMock) => fm.writes.filter((w) => w.call.startsWith('PATCH')).map((w) => w.body);
  const ALT_NOTICE = 'The alt text changed while you were editing';

  test('the field sits under the caption with a hint, and saving sends the new alt text', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    const alt = dialog.getByLabel('Alt text');
    await expect(alt).toHaveValue(FIG_ALT);
    await expect(dialog.getByText('what a reader who cannot see the figure is told', { exact: false })).toBeVisible();
    const below = await dialog.evaluate((d) => d.querySelector('#fd-alt')!.getBoundingClientRect().top - d.querySelector('#fd-caption')!.getBoundingClientRect().bottom);
    expect(below).toBeGreaterThan(0);
    await expect(saveButton(dialog)).toBeDisabled();
    await alt.fill('Un amplificatore operazionale: R1 in serie all\'ingresso, R2 dall\'uscita all\'ingresso invertente.');
    await shot(page, 'alt-text');
    await saveButton(dialog).click();
    await expect(page.getByText('Figure saved')).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(patches(fm)).toEqual([{ baseRevId: 'rvf1', alt: 'Un amplificatore operazionale: R1 in serie all\'ingresso, R2 dall\'uscita all\'ingresso invertente.' }]);
    const reopened = await openDialog(page);
    await expect(reopened.getByLabel('Alt text')).toHaveValue('Un amplificatore operazionale: R1 in serie all\'ingresso, R2 dall\'uscita all\'ingresso invertente.');
  });

  test('caption and alt text go in one save', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Nuova didascalia.');
    await dialog.getByLabel('Alt text').fill('Nuovo testo alternativo.');
    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(patches(fm)).toEqual([{ baseRevId: 'rvf1', caption: 'Nuova didascalia.', alt: 'Nuovo testo alternativo.' }]);
  });

  test('an empty alt text cannot be saved and says why', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Alt text').fill('   ');
    await expect(saveButton(dialog)).toBeDisabled();
    await expect(dialog.getByLabel('Alt text')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText('Alt text is needed', { exact: false })).toBeVisible();
    await shot(page, 'alt-text-empty');
  });

  test('an unsaved alt text asks before it is discarded', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Alt text').fill('Testo alternativo non salvato');
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog.getByLabel('Alt text')).toHaveValue('Testo alternativo non salvato');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test('an alt text saved in another tab gets the same notice as the caption, and the author chooses', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Alt text').fill('Il mio testo alternativo');
    fm.elsewhere({ alt: 'Testo alternativo salvato altrove' });
    const headAfterOtherTab = fm.head();
    const notice = dialog.getByRole('alert').filter({ hasText: ALT_NOTICE });
    await expect(notice).toContainText('It is now: “Testo alternativo salvato altrove”');
    await expect(dialog.getByLabel('Alt text')).toHaveValue('Il mio testo alternativo');
    await expect(saveButton(dialog)).toBeDisabled();
    await shot(page, 'conflict-alt');
    await notice.getByRole('button', { name: 'Keep my version' }).click();
    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(patches(fm)).toEqual([{ baseRevId: headAfterOtherTab, alt: 'Il mio testo alternativo' }]);
  });

  test('taking the other alt text puts it in the field and leaves nothing to save', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Alt text').fill('Il mio testo alternativo');
    fm.elsewhere({ alt: 'Testo alternativo salvato altrove' });
    await dialog.getByRole('alert').filter({ hasText: ALT_NOTICE }).getByRole('button', { name: 'Use the other version' }).click();
    await expect(dialog.getByLabel('Alt text')).toHaveValue('Testo alternativo salvato altrove');
    await expect(saveButton(dialog)).toBeDisabled();
  });

  test('fresh data keeps the alt text the author typed, and a field they did not touch takes the new value', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Alt text').fill('Quello che sto scrivendo');
    fm.elsewhere({ caption: 'Didascalia da un altro tab' });
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia da un altro tab');
    await expect(dialog.getByLabel('Alt text')).toHaveValue('Quello che sto scrivendo');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(saveButton(dialog)).toBeEnabled();
  });
});

test.describe('figure dialog, Save with a source that is not rendered', () => {
  test('the dialog stays open with the "Not rendered yet" line, and closes once nothing is pending', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Didascalia salvata con la sorgente ancora da disegnare.');
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt)');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect.poll(() => fm.writes.filter((w) => w.call.startsWith('PATCH')).length).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Not rendered yet. The figure still shows the last render.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save figure' })).toBeDisabled();
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia salvata con la sorgente ancora da disegnare.');
    // The source is still guarded: closing asks.
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await dialog.getByRole('button', { name: 'Render' }).click();
    await expect(page.getByText('Rendered. The figure in the section is updated.')).toBeVisible();
    await dialog.locator('.ui-dialog__foot').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test('the source stays visible after a save even when its section was collapsed', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt)');
    await dialog.locator('summary', { hasText: 'Source' }).click();
    await dialog.getByLabel('Caption').fill('Altra didascalia.');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog.getByText('Not rendered yet.')).toBeVisible();
  });
});

test.describe('Extras link to a figure', () => {
  test('opens the dialog even when the section in the cache is older than the figure the link names', async ({ page }) => {
    await page.clock.install();
    const fm = await open(page);
    await expect(figureBlock(page)).toBeVisible();
    // Another tab saves a new copy of the figure. This page is not told, so its cached section still has the old one.
    fm.elsewhere({ caption: 'Didascalia nuova da un altro tab.' }, { quiet: true });
    await page.clock.fastForward(11_000);
    await page.getByRole('link', { name: 'Extras' }).click();
    const card = page.locator('.ex-card');
    await expect(card).toContainText('Didascalia nuova da un altro tab.');
    await card.getByRole('link', { name: 'Edit in the Manuscript' }).click();
    const dialog = page.getByRole('dialog', { name: /^Figure/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia nuova da un altro tab.');
    await expect(page).toHaveURL(/\/manuscript\/s1$/);
  });
});

test.describe('figure dialog, what Render and Replace do', () => {
  test('the dialog says they act at once, and after one the closing button reads Close', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await expect(dialog.getByText(/Render and Replace change the figure in the book at once, and the earlier one stays in the section history\./)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt)');
    await dialog.getByRole('button', { name: 'Render' }).click();
    await expect(dialog.getByText('Not rendered yet')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await shot(page, 'after-render');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toBeHidden();
  });

  test('after a Replace the closing button reads Close too, and other unsaved fields still get the discard question', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Ancora da salvare');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'mio.png', mimeType: 'image/png', buffer: PNG });
    await expect(dialog.getByRole('heading', { name: /Uploaded image/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await dialog.locator('.ui-dialog__foot').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog.getByText('Discard your changes to this figure?')).toBeVisible();
  });
});

test.describe('figure dialog, small things', () => {
  test('a save does not ask for the figure it replaced', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Nuova didascalia');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog).toBeHidden();
    const next = await openDialog(page);
    await expect(next.getByLabel('Caption')).toHaveValue('Nuova didascalia');
    await page.waitForTimeout(500);
    expect(fm.notFound).toEqual([]);
  });

  test('a redraw that finishes says so in the dialog', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Instruction for the redraw').fill('Move the labels');
    await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
    await expect(dialog.locator('.fd-redraw__prog')).toBeVisible();
    fm.complete();
    await expect(dialog.getByRole('status').filter({ hasText: 'Redrawn. The earlier drawing is in the section history.' })).toBeVisible({ timeout: 12_000 });
    expect(fm.notFound).toEqual([]);
  });
});

test.describe('figure block (2g)', () => {
  test('a drawn figure shows its badge and an Edit figure entry once selected', async ({ page }) => {
    await open(page);
    await expect(figureBlock(page).locator('.ms-fig-badge')).toHaveText('Drawn');
    await expect(page.getByRole('button', { name: 'Edit figure' })).toHaveCount(0);
    await figureBlock(page).click();
    await expect(page.locator('.ms-actions').getByRole('button', { name: 'Edit figure' })).toBeVisible();
    await expect(page.locator('.ev-drawer').getByRole('button', { name: 'Edit figure' })).toBeVisible();
    await shot(page, '2g-figure-block');
  });

  test('the toolbar button is called Add figures with AI', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('button', { name: 'Add figures with AI' })).toBeVisible();
    await page.getByRole('button', { name: 'Add figures with AI' }).click();
    await expect(page.getByRole('dialog', { name: 'Add figures with AI' })).toBeVisible();
  });
});

test.describe('figure dialog, a drawn figure', () => {
  test('idle: the picture on the plate, caption, description, collapsed source and the redraw field (2a, 2b, 2c, 2d)', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await expect(dialog.getByRole('heading', { name: /Figure 1\.2\s+Drawn/ })).toBeVisible();
    await expect(dialog.locator('.fd-preview')).toHaveClass(/sb-figure-frame/);
    await expect(dialog.getByLabel('Caption')).toHaveValue(/Amplificatore invertente/);
    await expect(dialog.getByLabel('What it shows')).toHaveValue(/inverting amplifier/);
    await expect(dialog.getByText('Changing it does not change the picture until you redraw.')).toBeVisible();
    await expect(dialog.getByText(/in English/)).toHaveCount(0);
    await expect(dialog.locator('details.fd-details')).not.toHaveAttribute('open', '');
    await expect(dialog.getByText('Typst', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Instruction for the redraw')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Redraw with AI' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Save figure' })).toBeDisabled();
    await expect(dialog.getByText(/The earlier drawing stays in this section's history/)).toBeVisible();
    await expect(dialog.getByText(/up to 2 MB/)).toBeVisible();
    await noOverflow(page);
    await shot(page, '2a-idle');
  });

  test('saving the caption and the description sends the head the dialog was opened on', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Amplificatore invertente, nuova didascalia.');
    await dialog.getByLabel('What it shows').fill('An op-amp with R1 and R2, grounded input.');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(page.getByText('Figure saved')).toBeVisible();
    await expect(dialog).toBeHidden();
    const save = fm.writes.find((w) => w.call.startsWith('PATCH'))!;
    expect(save.body).toEqual({ baseRevId: 'rvf1', caption: 'Amplificatore invertente, nuova didascalia.', shows: 'An op-amp with R1 and R2, grounded input.' });
  });

  test('the source opens in a monospace editor with the engine named, and Render replaces the picture (2c)', async ({ page }) => {
    const fm = await open(page);
    fm.renderMs = 700;
    const dialog = await openDialog(page);
    const before = await dialog.locator('.fd-preview img').getAttribute('src');
    await openSource(dialog);
    await expect(dialog.locator('.cm-gutters')).toBeVisible();
    await expect(dialog.getByLabel('Drawing source')).toContainText('opamp("U1"');
    await shot(page, '2c-source-open');
    await typeSource(page, '#circle(radius: 9pt)');
    await expect(dialog.getByText(/Not rendered yet/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Render' }).click();
    // Rendering: the picture dims, the button is busy, and nothing else can be saved meanwhile.
    await expect(dialog.getByText('Rendering the source…')).toBeVisible();
    await expect(dialog.locator('.fd-preview')).toHaveClass(/is-busy/);
    await expect(dialog.getByRole('button', { name: 'Save figure' })).toBeDisabled();
    await shot(page, '2c-rendering');
    await expect(page.getByText('Rendered. The figure in the section is updated.')).toBeVisible();
    await expect(dialog.locator('.fd-preview')).not.toHaveClass(/is-busy/);
    expect(await dialog.locator('.fd-preview img').getAttribute('src')).not.toBe(before);
    expect(fm.writes.find((w) => w.call.endsWith('/render'))!.body).toEqual({ baseRevId: 'rvf1', source: '#circle(radius: 9pt)' });
    await expect(page.locator('.ms-block .sb-figure img')).toHaveAttribute('src', await dialog.locator('.fd-preview img').getAttribute('src') as string);
  });

  test('a source that does not compile shows the compiler line under the editor and keeps the last drawing (2c)', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await openSource(dialog);
    await typeSource(page, FIG_COMPILE_ERROR.includes('Rf') ? ['#canvas({', '  resistor("R2", label: $Rf$)', '})'].join('\n') : '');
    await dialog.getByRole('button', { name: 'Render' }).click();
    const err = dialog.getByRole('alert').filter({ hasText: 'error at line 9' });
    await expect(err).toBeVisible();
    await expect(err).toContainText('unknown variable: Rf');
    await expect(dialog.getByText('Does not compile', { exact: true })).toBeVisible();
    await expect(dialog.getByText('The source below does not compile. The book still shows the last drawing that did.')).toBeVisible();
    await expect(dialog.getByText('Not rendered. Fix the line above, then press Render.')).toBeVisible();
    await expect(dialog.locator('.fd-preview')).toHaveClass(/is-stale/);
    await expect(dialog.getByRole('button', { name: 'Redraw with AI' })).toBeDisabled();
    await noOverflow(page);
    await shot(page, '2c-compile-error');
  });

  test('redraw: the task runs, the dialog says so, Escape does not close it, and the new drawing arrives (2d)', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    const before = await dialog.locator('.fd-preview img').getAttribute('src');
    await openSource(dialog);
    await dialog.getByLabel('Instruction for the redraw').fill('Move the labels off the wires');
    await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
    await expect(dialog.getByText('Redrawing with your instruction…')).toBeVisible();
    await expect(dialog.locator('.fd-redraw__prog')).toContainText('“Move the labels off the wires”');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Render' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Save figure' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Remove figure' })).toBeDisabled();
    await expect(dialog.getByLabel('Caption')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await noOverflow(page);
    await shot(page, '2d-redrawing');
    expect(fm.writes.find((w) => w.call.endsWith('/redraw'))!.body).toEqual({ baseRevId: 'rvf1', instruction: 'Move the labels off the wires' });
    fm.complete();
    await expect(page.getByText('Redrawn. The earlier drawing is in the section history.')).toBeVisible({ timeout: 12_000 });
    await expect(dialog.getByText('Redrawing with your instruction…')).toBeHidden();
    await expect.poll(async () => dialog.locator('.fd-preview img').getAttribute('src')).not.toBe(before);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('redraw cancelled from the dialog stops the task', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Instruction for the redraw').fill('Bigger');
    await dialog.getByLabel('Instruction for the redraw').press('Enter');
    await expect(dialog.locator('.fd-redraw__prog')).toBeVisible();
    await dialog.locator('.fd-redraw__prog').getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.locator('.fd-redraw__prog')).toBeHidden({ timeout: 12_000 });
    expect(fm.writes.some((w) => w.call === 'cancel')).toBe(true);
  });

  test('a redraw that fails says why, and the figure is unchanged (2d)', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    const before = await dialog.locator('.fd-preview img').getAttribute('src');
    await dialog.getByLabel('Instruction for the redraw').fill('Make it red');
    await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
    await expect(dialog.locator('.fd-redraw__prog')).toBeVisible();
    fm.runStatus = 'failed';
    fm.runError = 'error at line 3: unknown variable: Rf';
    const failed = dialog.getByRole('alert').filter({ hasText: 'The redraw failed' });
    await expect(failed).toBeVisible({ timeout: 12_000 });
    await expect(failed).toContainText('unknown variable: Rf');
    await expect(failed).toContainText('The figure is unchanged');
    await expect(dialog.getByLabel('Instruction for the redraw')).toBeVisible();
    expect(await dialog.locator('.fd-preview img').getAttribute('src')).toBe(before);
    await noOverflow(page);
    await shot(page, '2d-redraw-failed');
    await failed.getByRole('button', { name: 'Dismiss' }).click();
    await expect(failed).toBeHidden();
  });

  test('replace with an image says what happens, then the figure is an uploaded image without source (2e)', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await expect(dialog.getByText(/The figure then stops being a drawing and its source is removed/)).toBeVisible();
    await dialog.locator('input[type=file]').setInputFiles({ name: 'mio.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText('Image replaced. The earlier figure is in the section history.')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /Uploaded image/ })).toBeVisible();
    await expect(dialog.getByLabel('What it shows')).toHaveCount(0);
    await expect(dialog.locator('summary')).toHaveCount(0);
    await expect(dialog.getByText('Redraw with AI', { exact: true })).toHaveCount(0);
    expect(fm.writes.some((w) => w.call.endsWith('/replace'))).toBe(true);
    await shot(page, '2e-replaced');
  });

  test('an image over 2 MB or in another format is refused before it is sent (2e)', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.locator('input[type=file]').setInputFiles({ name: 'grande.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 10) });
    await expect(dialog.getByRole('alert')).toContainText('The limit is 2 MB');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'foto.gif', mimeType: 'image/gif', buffer: PNG });
    await expect(dialog.getByRole('alert')).toContainText('PNG, JPEG, SVG or WebP');
    expect(fm.writes.some((w) => w.call.endsWith('/replace'))).toBe(false);
    await shot(page, '2e-refused');
  });

  test('remove asks first, Keep backs out, and Remove figure takes the block out of the text (2f)', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Remove figure' }).click();
    await expect(dialog.getByText('Remove this figure from the section?')).toBeVisible();
    await shot(page, '2f-confirm');
    await dialog.getByRole('button', { name: 'Keep' }).click();
    await expect(dialog.getByText('Remove this figure from the section?')).toBeHidden();
    await dialog.getByRole('button', { name: 'Remove figure' }).click();
    await dialog.getByRole('button', { name: 'Remove figure' }).last().click();
    await expect(page.getByText('Figure removed. It stays in the section history.')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(figureBlock(page)).toHaveCount(0);
    expect(fm.writes.find((w) => w.call.endsWith('/remove'))!.body).toEqual({ baseRevId: 'rvf1' });
  });

  test('when the text moved on, saving says so and nothing is lost (409)', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    fm.stale = true;
    await dialog.getByLabel('Caption').fill('Un altro testo');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'This text changed since you opened it.' })).toBeVisible();
    await expect(dialog.getByLabel('Caption')).toHaveValue('Un altro testo');
  });

  test('keyboard: focus never reaches the page behind, every control has a name, Escape closes it', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await openSource(dialog);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      // A native modal dialog wraps focus through the browser's own controls (the page body in a test), never to the page behind it.
      expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest('dialog[open]'))).toBe(true);
    }
    const unnamed = await dialog.evaluate((d) => [...d.querySelectorAll<HTMLElement>('button, input, textarea, [role=textbox]')].filter((el) => {
      const label = el.getAttribute('aria-label') || el.textContent?.trim() || (el as HTMLInputElement).labels?.[0]?.textContent?.trim();
      return !label;
    }).map((el) => el.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.ms-actions').getByRole('button', { name: 'Edit figure' })).toBeFocused();
  });
});

test.describe('figure dialog, other figures', () => {
  test('a figure that is not a drawing has a caption, replace and remove, and no source', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.locator('input[type=file]').setInputFiles({ name: 'mio.png', mimeType: 'image/png', buffer: PNG });
    await expect(dialog.getByRole('heading', { name: /Uploaded image/ })).toBeVisible();
    await expect(dialog.getByText(/The new image takes the place of this one/)).toBeVisible();
    await expect(dialog.getByLabel('Caption')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Remove figure' })).toBeVisible();
    expect(fm.figures().filter((f) => f.origin === 'imported')).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(figureBlock(page).locator('.ms-fig-badge')).toHaveText('Image');
  });
});

test.describe('Add figure', () => {
  async function openChooser(page: Page, o: { stock?: boolean } = {}) {
    const fm = await open(page, o);
    await page.locator('.ms-block').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ms-edit .cm-editor')).toBeVisible();
    const button = page.getByRole('button', { name: 'Add figure', exact: true });
    await button.click();
    const pop = page.getByRole('dialog', { name: 'Add a figure' });
    await expect(pop).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    return { fm, pop, button };
  }

  test('the chooser opens from the editor row with the three ways in, and Escape closes only the chooser (3a)', async ({ page }) => {
    const { pop, button } = await openChooser(page);
    await expect(pop.getByRole('button', { name: /Describe a drawing/ })).toBeVisible();
    await expect(pop.getByRole('button', { name: /Upload an image/ })).toBeVisible();
    await expect(pop.getByRole('button', { name: /Search photos/ })).toBeVisible();
    await expect(pop.getByText('The figure goes after this block.')).toBeVisible();
    await shot(page, '3a-chooser');
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(button).toBeFocused();
    await expect(page.locator('.ms-edit .cm-editor')).toBeVisible();
    await noOverflow(page);
  });

  test('describe a drawing: the text is saved first, a placeholder shows while it is drawn, then the figure is in the text (3b)', async ({ page }) => {
    const { fm, pop } = await openChooser(page);
    await page.locator('.ms-edit .cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Un periodo aggiunto.');
    // Clicking in the text closed the chooser: open it again.
    await page.getByRole('button', { name: 'Add figure', exact: true }).click();
    await pop.getByRole('button', { name: /Describe a drawing/ }).click();
    await expect(pop.getByText(/in English/)).toHaveCount(0);
    await shot(page, '3b-describe');
    await pop.getByLabel('What should the drawing show?').fill('An op-amp with R1 and R2, the input grounded.');
    await pop.getByLabel('Caption').fill('Amplificatore di prova');
    await pop.getByRole('button', { name: 'Draw it' }).click();
    const ghost = page.locator('.ms-ghost-fig');
    await expect(ghost).toContainText('Drawing the figure from your description, then rendering it.');
    await expect(pop).toBeHidden();
    // The typed text was written before the task was started, and the task names the saved head and the block.
    const calls = fm.writes.map((w) => w.call);
    expect(calls.findIndex((c) => c.startsWith('PUT'))).toBeLessThan(calls.findIndex((c) => c.endsWith('/figures/draw')));
    expect(fm.writes.find((w) => w.call.endsWith('/figures/draw'))!.body).toEqual({ baseRevId: 'rvf2', afterBlock: 1, description: 'An op-amp with R1 and R2, the input grounded.', caption: 'Amplificatore di prova' });
    await shot(page, '3b-drawing');
    fm.complete();
    await expect(page.getByText(/Figure added after block 2/)).toBeVisible({ timeout: 12_000 });
    await expect(ghost).toBeHidden();
    await expect(page.locator('.ms-block .sb-figure')).toHaveCount(2);
    await expect(page.locator('.ms-block', { has: page.locator('.sb-figure') }).first().locator('.ms-fig-badge')).toHaveText('Drawn');
  });

  test('describe a drawing that fails says why under the block (3b)', async ({ page }) => {
    const { fm, pop } = await openChooser(page);
    await pop.getByRole('button', { name: /Describe a drawing/ }).click();
    await pop.getByLabel('What should the drawing show?').fill('Something odd');
    await pop.getByRole('button', { name: 'Draw it' }).click();
    await expect(page.locator('.ms-ghost-fig')).toBeVisible();
    fm.runStatus = 'failed';
    fm.runError = 'The drawing did not compile after two repairs.';
    const failed = page.locator('.ms-ghost-fig--failed');
    await expect(failed).toContainText('The drawing did not compile after two repairs.', { timeout: 12_000 });
    await shot(page, '3b-failed');
    await failed.getByRole('button', { name: 'Dismiss' }).click();
    await expect(failed).toBeHidden();
  });

  test('upload an image: a file and a caption put it after the block, and a file over 2 MB is refused (3c)', async ({ page }) => {
    const { fm, pop } = await openChooser(page);
    await pop.getByRole('button', { name: /Upload an image/ }).click();
    await expect(pop.getByRole('button', { name: 'Add figure' })).toBeDisabled();
    await pop.locator('input[type=file]').setInputFiles({ name: 'grande.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 10) });
    await expect(pop.getByRole('alert')).toContainText('The limit is 2 MB');
    await pop.locator('input[type=file]').setInputFiles({ name: 'schema.png', mimeType: 'image/png', buffer: PNG });
    await expect(pop.getByText('schema.png')).toBeVisible();
    await pop.getByLabel('Caption').fill('Schema del circuito di prova');
    await shot(page, '3c-upload');
    await pop.getByRole('button', { name: 'Add figure' }).click();
    await expect(page.getByText('Image added after block 2')).toBeVisible();
    await expect(page.locator('.ms-block .sb-figure')).toHaveCount(2);
    expect(fm.writes.some((w) => w.call.endsWith('/figures/upload'))).toBe(true);
  });

  test('search photos: the results are pickable, a caption can be added, and the photo goes in with its credit (3d)', async ({ page }) => {
    const { fm, pop } = await openChooser(page, { stock: true });
    await pop.getByRole('button', { name: /Search photos/ }).click();
    await expect(pop.getByRole('button', { name: 'Add photo' })).toBeDisabled();
    await pop.getByLabel('Search photos', { exact: true }).fill('scheda elettronica');
    await pop.getByRole('button', { name: 'Search', exact: true }).click();
    const results = pop.getByRole('group', { name: 'Photo results' });
    await expect(results.getByRole('button')).toHaveCount(4);
    await expect(results.locator('img').first()).toHaveJSProperty('complete', true);
    await expect(pop.getByText('Only photos with a licence a book can credit are listed.')).toBeVisible();
    await results.getByRole('button').nth(1).click();
    await expect(results.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await pop.getByLabel('Caption').fill('Una scheda');
    await shot(page, '3d-search');
    await pop.getByRole('button', { name: 'Add photo' }).click();
    await expect(page.getByText('Photo added after block 2')).toBeVisible();
    expect(fm.writes.find((w) => w.call.endsWith('/figures/photo'))!.body).toMatchObject({ searchId: 'sr1', index: 1, caption: 'Una scheda', afterBlock: 1 });
    await expect(page.locator('.ms-block .sb-figure')).toHaveCount(2);
  });

  test('search photos with no result says so and how to go on', async ({ page }) => {
    const { pop } = await openChooser(page, { stock: false });
    await pop.getByRole('button', { name: /Search photos/ }).click();
    await pop.getByLabel('Search photos', { exact: true }).fill('nulla');
    await pop.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(pop.getByRole('alert')).toContainText('Try other words.');
  });

  test('when the text moved on, adding a figure says so and the chooser stays open (409)', async ({ page }) => {
    const { fm, pop } = await openChooser(page);
    fm.stale = true;
    await pop.getByRole('button', { name: /Upload an image/ }).click();
    await pop.locator('input[type=file]').setInputFiles({ name: 'schema.png', mimeType: 'image/png', buffer: PNG });
    await pop.getByRole('button', { name: 'Add figure' }).click();
    await expect(pop.getByRole('alert')).toContainText('This text changed since you opened it.');
    await expect(pop).toBeVisible();
  });
});


test.describe('review findings of the figure dialog', () => {
  test('source typed while a render runs is kept when the rendered source arrives', async ({ page }) => {
    const fm = await open(page);
    fm.renderMs = 900;
    const dialog = await openDialog(page);
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 8pt)');
    const before = await dialog.locator('.fd-preview img').getAttribute('src');
    await dialog.getByRole('button', { name: 'Render' }).click();
    await expect(dialog.getByText('Rendering the source…').first()).toBeVisible();
    await page.locator('.fd-code .cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' // still typing');
    // The new picture is the figure's new asset: its details have arrived.
    await expect.poll(async () => dialog.locator('.fd-preview img').getAttribute('src'), { timeout: 12_000 }).not.toBe(before);
    await expect(dialog.locator('.fd-code .cm-content')).toContainText('// still typing');
    await expect(dialog.getByText('Not rendered yet. The figure still shows the last render.')).toBeVisible();
  });

  test('after a Render the next request names the new figure and the new head, so a redraw starts from the rendered source', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    const first = fm.figures()[0].id;
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt) // R_1');
    await dialog.getByRole('button', { name: 'Render' }).click();
    await expect(dialog.getByText('Rendered just now')).toBeVisible();
    const rendered = fm.figures().find((f) => f.id !== first)!;
    await dialog.getByLabel('Instruction for the redraw').fill('Make the capacitor label C bigger');
    await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
    await expect(dialog.locator('.fd-redraw__prog')).toBeVisible();
    const redraw = fm.writes.find((w) => w.call.endsWith('/redraw'))!;
    expect(redraw.call).toBe(`POST /api/projects/p1/sections/s1/figures/${rendered.id}/redraw`);
    expect(redraw.body).toEqual({ baseRevId: fm.head(), instruction: 'Make the capacitor label C bigger' });
    expect(fm.notFound).toEqual([]);
  });

  test('a dialog opened again after a save shows the figure as the book has it now, and never asks for the figure it replaced', async ({ page }) => {
    const fm = await open(page);
    let dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Didascalia nuova.');
    await dialog.getByLabel('Alt text').fill('Alt nuovo.');
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog).toBeHidden();
    dialog = await openDialog(page);
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia nuova.');
    await expect(dialog.getByLabel('Alt text')).toHaveValue('Alt nuovo.');
    await expect(dialog.getByRole('button', { name: 'Save figure' })).toBeDisabled();
    expect(fm.notFound).toEqual([]);
  });

  test('while the page fetches the figure a Render made, the dialog holds its buttons instead of asking for the old figure', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    const first = fm.figures()[0].id;
    await openSource(dialog);
    await typeSource(page, '#circle(radius: 9pt) // R_1');
    await dialog.getByLabel('Instruction for the redraw').fill('Make the capacitor label C bigger');
    fm.readMs = 600;
    await dialog.getByRole('button', { name: 'Render' }).click();
    await expect(page.getByText('Rendered. The figure in the section is updated.')).toBeVisible();
    // The new figure's details are on their way: the old ones still on screen belong to a head the book has left.
    await expect(dialog.getByRole('button', { name: 'Redraw with AI' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Render' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Redraw with AI' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
    const rendered = fm.figures().find((f) => f.id !== first)!;
    expect(fm.writes.filter((w) => w.call.endsWith('/redraw')).map((w) => w.call)).toEqual([`POST /api/projects/p1/sections/s1/figures/${rendered.id}/redraw`]);
    expect(fm.notFound).toEqual([]);
  });

  test('a dialog opened again after a save does not show the figure it replaced while the new one loads', async ({ page }) => {
    const fm = await open(page);
    let dialog = await openDialog(page);
    await dialog.getByLabel('Caption').fill('Didascalia nuova.');
    fm.readMs = 900; // the new figure's details are still on their way when the dialog closes
    await dialog.getByRole('button', { name: 'Save figure' }).click();
    await expect(dialog).toBeHidden();
    await figureBlock(page).click();
    await page.locator('.ms-actions').getByRole('button', { name: 'Edit figure' }).click();
    dialog = page.getByRole('dialog', { name: /^Figure/ });
    await expect(dialog.getByRole('status', { name: 'Loading the figure' })).toBeVisible();
    await expect(dialog.getByLabel('Caption')).toHaveCount(0);
    await expect(dialog.getByLabel('Caption')).toHaveValue('Didascalia nuova.');
    expect(fm.notFound).toEqual([]);
  });

  test('Redraw with AI sends the description as it is in the field', async ({ page }) => {
    const fm = await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('What it shows').fill('An op-amp with a 10 kΩ feedback resistor.');
    await dialog.getByLabel('Instruction for the redraw').fill('Draw it again');
    await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
    await expect(dialog.locator('.fd-redraw__prog')).toBeVisible();
    expect(fm.writes.find((w) => w.call.endsWith('/redraw'))!.body).toEqual({ baseRevId: 'rvf1', instruction: 'Draw it again', shows: 'An op-amp with a 10 kΩ feedback resistor.' });
    fm.complete();
    await expect(page.getByText('Redrawn. The earlier drawing is in the section history.')).toBeVisible({ timeout: 12_000 });
    await expect(dialog.getByLabel('What it shows')).toHaveValue('An op-amp with a 10 kΩ feedback resistor.');
    await expect(dialog.getByRole('button', { name: 'Save figure' })).toBeDisabled();
  });

  test('when the asset list fails the dialog says so instead of showing a skeleton forever', async ({ page }) => {
    await open(page, { assetsFail: true });
    await figureBlock(page).click();
    await page.locator('.ms-actions').getByRole('button', { name: 'Edit figure' }).click();
    const dialog = page.getByRole('dialog', { name: /^Figure/ });
    await expect(dialog.getByRole('alert')).toContainText('The asset list could not be read.', { timeout: 15_000 });
    await expect(dialog.getByRole('status', { name: 'Loading the figure' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('a figure whose picture is not among the book\'s figures says so', async ({ page }) => {
    await open(page);
    // The list loads, but without the picture this block names.
    await page.route(/\/api\/projects\/p1\/assets$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.reload();
    await figureBlock(page).click();
    await page.locator('.ms-actions').getByRole('button', { name: 'Edit figure' }).click();
    const dialog = page.getByRole('dialog', { name: /^Figure/ });
    await expect(dialog.getByRole('alert')).toContainText('The picture of this figure is not among the book', { timeout: 15_000 });
    await expect(dialog.getByRole('status', { name: 'Loading the figure' })).toHaveCount(0);
  });

  test('Redraw with AI needs a description', async ({ page }) => {
    await open(page);
    const dialog = await openDialog(page);
    await dialog.getByLabel('Instruction for the redraw').fill('Draw it again');
    await expect(dialog.getByRole('button', { name: 'Redraw with AI' })).toBeEnabled();
    await dialog.getByLabel('What it shows').fill('   ');
    await expect(dialog.getByRole('button', { name: 'Redraw with AI' })).toBeDisabled();
  });

  test('browser Back to another section closes the dialog', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('smartbuilder.theme', 'light'));
    await mockApi(page);
    await mockFigureApi(page);
    await page.goto('/books/p1/manuscript/s2');
    await expect(page.locator('.ms-block').first()).toBeVisible();
    // An in-app move to s1, so Back is a move inside the page.
    await page.evaluate(() => { history.pushState({}, '', '/books/p1/manuscript/s1'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.locator('.ms-block', { has: page.locator('.sb-figure') })).toBeVisible();
    const dialog = await openDialog(page);
    await page.goBack();
    await expect(page).toHaveURL(/manuscript\/s2$/);
    await expect(dialog).toBeHidden();
  });

  test('on a narrow screen focus goes back to the Edit figure button of the drawer that opened the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.ev-drawer').getByRole('button', { name: 'Edit figure' })).toBeFocused();
  });

  test('Add figure waits for the autosave that is on its way and goes on from the revision it wrote', async ({ page }) => {
    const fm = await open(page);
    fm.putMs = 1500;
    await page.locator('.ms-block').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ms-edit .cm-editor')).toBeVisible();
    await page.locator('.ms-edit .cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Un periodo aggiunto.');
    // The autosave starts about three seconds after the last key and is slow to answer.
    await expect.poll(() => fm.writes.filter((w) => w.call.startsWith('PUT')).length, { timeout: 8_000 }).toBe(1);
    await page.getByRole('button', { name: 'Add figure', exact: true }).click();
    const pop = page.getByRole('dialog', { name: 'Add a figure' });
    await pop.getByRole('button', { name: /Describe a drawing/ }).click();
    await pop.getByLabel('What should the drawing show?').fill('An op-amp.');
    await pop.getByRole('button', { name: 'Draw it' }).click();
    await expect(page.locator('.ms-ghost-fig')).toBeVisible({ timeout: 12_000 });
    expect(fm.writes.filter((w) => w.call.startsWith('PUT')).length).toBe(1);
    expect((fm.writes.find((w) => w.call.endsWith('/figures/draw'))!.body as { baseRevId: string }).baseRevId).toBe(fm.head());
  });
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark'] as const) {
  test.describe(`${width} px, ${theme}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test(`the figure dialog fits the screen in every state`, async ({ page }) => {
      const fm = await open(page, { theme });
      fm.renderMs = 500;
      const dialog = await openDialog(page);
      const fits = async (what: string) => {
        const box = await dialog.boundingBox();
        expect(box!.x, `${what}: left edge`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${what}: right edge`).toBeLessThanOrEqual(width + 1);
        expect(await dialog.evaluate((d) => d.querySelector('.ui-dialog__body')!.scrollWidth - d.querySelector('.ui-dialog__body')!.clientWidth), `${what}: body overflow`).toBeLessThanOrEqual(1);
        await noOverflow(page);
      };
      await fits('idle');
      await shot(page, 'state-idle');
      await openSource(dialog);
      await fits('source');
      await shot(page, 'state-source');
      await typeSource(page, '#canvas({ resistor("R2", label: $Rf$) })');
      await dialog.getByRole('button', { name: 'Render' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: 'error at line 9' })).toBeVisible();
      await fits('compile error');
      await shot(page, 'state-error');
      await typeSource(page, '#circle(radius: 9pt)');
      await dialog.getByRole('button', { name: 'Render' }).click();
      await expect(dialog.getByText('Rendering the source…')).toBeVisible();
      await fits('rendering');
      await shot(page, 'state-rendering');
      await expect(page.getByText('Rendered. The figure in the section is updated.')).toBeVisible();
      await dialog.getByLabel('Instruction for the redraw').fill('Move the labels off the wires');
      await dialog.getByRole('button', { name: 'Redraw with AI' }).click();
      await expect(dialog.locator('.fd-redraw__prog')).toBeVisible();
      await fits('redraw');
      await shot(page, 'state-redraw');
      fm.runStatus = 'failed';
      fm.runError = 'The drawing did not compile after two repairs.';
      await expect(dialog.getByRole('alert').filter({ hasText: 'The redraw failed' })).toBeVisible({ timeout: 12_000 });
      await fits('redraw failed');
      await shot(page, 'state-redraw-failed');
    });

    test(`the Add figure chooser fits the screen`, async ({ page }) => {
      await open(page, { theme, stock: true });
      await page.locator('.ms-block').nth(1).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Add figure', exact: true }).click();
      const pop = page.getByRole('dialog', { name: 'Add a figure' });
      for (const name of [/Describe a drawing/, /Upload an image/, /Search photos/]) {
        await pop.getByRole('button', { name }).click();
        const box = await pop.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
        await noOverflow(page);
        await shot(page, `chooser-${String(name).replace(/[^a-z]/gi, '').slice(0, 12)}`);
      }
    });
  });
}
