import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { FIG_COMPILE_ERROR, mockFigureApi, type FigureMock } from './figures-mocks';

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
