// States of the screens built from the 0.4.0 mockup: Book setup, Sources, Review, Connections and the Run panel's warnings.
// Every test runs on the in-browser API mock; the tests override only the routes whose answer they need.
import { expect, test, type Page, type Route } from '@playwright/test';
import { ROLES, ROLE_LABELS } from '@smartbuilder/domain';
import { mockApi, mockData } from './mocks';

const answer = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

// ---------- Book setup ----------

/** The book as the service keeps it: a PATCH merges its options, and every later GET returns them. */
async function keepBook(page: Page, subject?: string) {
  const base = mockData().projects[0];
  const book = { ...base, subject: subject ?? base.subject, options: { ...base.options } as Record<string, unknown> };
  const patches: { options?: Record<string, unknown> }[] = [];
  await page.route(/\/api\/projects\/p1$/, (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as { options?: Record<string, unknown> };
      patches.push(body);
      book.options = { ...book.options, ...body.options };
      for (const [k, v] of Object.entries(book.options)) if (v === null) delete book.options[k]; // the service clears an option patched to null
    }
    return answer(route, book);
  });
  return { book, patches };
}

test.describe('Book setup', () => {
  test.beforeEach(async ({ page }) => { await mockApi(page); });

  test('the four options save and come back after a reload', async ({ page }) => {
    const { patches } = await keepBook(page, 'Elettrotecnica');
    await page.goto('/books/p1/settings');
    const area = page.getByLabel('Subject area');
    await expect(area).toHaveValue('');
    await expect(area.locator('option:checked')).toHaveText('Automatic (Electronics)');
    await expect(page.getByText('Automatic follows the subject and the title')).toBeVisible();

    await area.selectOption('physics');
    await expect(page.getByText('Automatic follows the subject and the title')).toHaveCount(0);
    await page.getByRole('radio', { name: /Generous/ }).check();
    await page.getByRole('radio', { name: /European/ }).check();
    await page.getByRole('radio', { name: /Pause until it resets/ }).check();
    await page.getByRole('button', { name: 'Save setup' }).click();
    await expect(page.getByText('Book setup saved')).toBeVisible();

    expect(patches).toHaveLength(1);
    expect(patches[0].options).toMatchObject({ subjectArea: 'physics', figurePolicy: 'generous', circuitSymbols: 'european', noClaudeFallback: true });

    await page.goto('/books/p1/settings');
    await expect(page.getByLabel('Subject area')).toHaveValue('physics');
    await expect(page.getByRole('radio', { name: /Generous/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /European/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /Pause until it resets/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /Continue on the fallback model/ })).not.toBeChecked();
  });

  test('a book without an area shows Automatic with the inferred one, and saving keeps it unset', async ({ page }) => {
    const { patches } = await keepBook(page);
    await page.goto('/books/p1/settings');
    await expect(page.getByLabel('Subject area')).toHaveValue('');
    await expect(page.getByLabel('Subject area').locator('option:checked')).toHaveText('Automatic (Mathematics)');
    await expect(page.getByRole('radio', { name: /Where they help/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /Continue on the fallback model/ })).toBeChecked();
    await page.getByRole('button', { name: 'Save setup' }).click();
    await expect(page.getByText('Book setup saved')).toBeVisible();
    expect(patches[0].options).toMatchObject({ subjectArea: null }); // null is how the options patch says "no area"
  });

  test('the inferred area can be pinned, and Automatic takes the pin away', async ({ page }) => {
    const { book, patches } = await keepBook(page);
    await page.goto('/books/p1/settings');
    const area = page.getByLabel('Subject area');
    await expect(area.locator('option:checked')).toHaveText('Automatic (Mathematics)');
    await area.selectOption('mathematics'); // the area Automatic shows: choosing it saves it
    await page.getByRole('button', { name: 'Save setup' }).click();
    await expect(page.getByText('Book setup saved')).toBeVisible();
    expect(patches[0].options).toMatchObject({ subjectArea: 'mathematics' });
    expect(book.options.subjectArea).toBe('mathematics');

    await page.goto('/books/p1/settings');
    await expect(area).toHaveValue('mathematics');
    await area.selectOption('');
    await page.getByRole('button', { name: 'Save setup' }).click();
    await expect(page.getByText('Book setup saved')).toBeVisible();
    expect(patches[1].options).toMatchObject({ subjectArea: null });
    expect(book.options.subjectArea).toBeUndefined();
  });

  test('circuit symbols are offered for electronics and physics and hidden for mathematics', async ({ page }) => {
    await keepBook(page);
    await page.goto('/books/p1/settings');
    await expect(page.getByLabel('Subject area').locator('option:checked')).toHaveText('Automatic (Mathematics)');
    await expect(page.getByRole('radiogroup', { name: 'Circuit symbols' })).toHaveCount(0);
    for (const [area, shown] of [['electronics', true], ['physics', true], ['chemistry', false], ['mechanics', false]] as const) {
      await page.getByLabel('Subject area').selectOption(area);
      await expect(page.getByRole('radiogroup', { name: 'Circuit symbols' })).toHaveCount(shown ? 1 : 0);
    }
    await page.getByLabel('Subject area').selectOption('electronics');
    await expect(page.getByRole('radio', { name: /American/ })).toBeChecked();
    await expect(page.locator('.su-sym svg')).toHaveCount(2);
  });

  test('what the area sets is read from the profile table', async ({ page }) => {
    await keepBook(page);
    await page.goto('/books/p1/settings');
    const effects = page.getByRole('term').filter({ hasText: 'Figure kinds' }).locator('..');
    await expect(effects).toContainText('Function plots');
    await expect(effects).not.toContainText('Molecule structures');
    await page.getByLabel('Subject area').selectOption('chemistry');
    await expect(effects).toContainText('Function plots, molecule structures, energy-level diagrams, orbital boxes, electrochemical cells, periodic table highlights, drawings (circuits, diagrams, sketches), photos');
    await expect(effects).toContainText('Notation hints');
    await expect(effects).toContainText('How to write species, charges, states of matter');
    await expect(effects).not.toContainText('Exam papers');
  });

  test('the figure options are disabled while figures are off', async ({ page }) => {
    await keepBook(page, 'Elettrotecnica');
    await page.goto('/books/p1/settings');
    await expect(page.getByRole('radio', { name: /Generous/ })).toBeEnabled();
    const figures = page.locator('label.ui-switch', { hasText: 'Figures' });
    await figures.click(); // the switch hides its checkbox behind the track, so a click on the label turns it
    await expect(page.getByRole('radio', { name: /Generous/ })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /European/ })).toBeDisabled();
    await figures.click();
    await expect(page.getByRole('radio', { name: /Generous/ })).toBeEnabled();
  });

  test('the usage-limit choice and Connections agree', async ({ page }) => {
    await page.goto('/books/p1/settings');
    await expect(page.getByText('the jobs that start on Claude never use their fallback for this book')).toBeVisible();
    await expect(page.getByText('Any other failure, such as a timeout, is retried and then stops the task.')).toBeVisible();
    await page.goto('/connections');
    await expect(page.getByText('For that book the roles that start on Claude never use their fallback')).toBeVisible();
    await expect(page.getByText('any other failure is retried and then stops the task')).toBeVisible();
  });

  test('the setup page works from the keyboard and does not overflow at 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await keepBook(page, 'Elettrotecnica');
    await page.goto('/books/p1/settings');
    await page.getByRole('radio', { name: /Where they help/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Generous/ })).toBeChecked();
    await noOverflow(page);
  });
});

// ---------- Sources ----------

const resource = (over: Record<string, unknown>) => ({ ...mockData().resources[0], status: 'ready', ...over });
const examOk = resource({ id: 'rsOk', role: 'exams', filename: 'Temi_desame_2019-2023.pdf', pageCount: 96, size: 11_500_000, splitSessions: 14, splitQuestions: 63, splitWarning: null });
const examBad = (over: Record<string, unknown> = {}) => resource({ id: 'rsBad', role: 'exams', filename: 'esami-2024.pdf', pageCount: 28, size: 3_100_000, splitSessions: 1, splitQuestions: 0, splitWarning: 'no_questions', ...over });
const aiRun = (status: string, warnings: unknown[] = []) => ({ id: 'r7', projectId: 'p1', kind: 'prepare', status, createdAt: ago(1), finishedAt: status === 'running' ? null : ago(0), counts: status === 'running' ? { running: 1 } : { succeeded: 3 }, waiting: null, warnings });

test.describe('Sources: exam split warning', () => {
  /** The resources list the way the service would keep it, so a role change or a finished split shows up on the next fetch. */
  async function keepResources(page: Page, rows: Record<string, unknown>[]) {
    const state = { rows, patches: [] as { rid: string; body: Record<string, unknown> }[], splits: 0 };
    await page.route(/\/api\/projects\/p1\/resources$/, (route) => answer(route, state.rows));
    await page.route(/\/api\/resources\/(\w+)$/, (route) => {
      const req = route.request();
      if (req.method() !== 'PATCH') return route.fallback();
      const rid = /\/api\/resources\/(\w+)$/.exec(req.url())![1];
      const body = req.postDataJSON() as Record<string, unknown>;
      state.patches.push({ rid, body });
      state.rows = state.rows.map((r) => {
        if (r.id !== rid) return r;
        const next = { ...r, ...body };
        // The service reports a split only under the role it was made for.
        return body.role === 'exams' ? { ...next, splitSessions: 1, splitQuestions: 0, splitWarning: 'no_questions' } : body.role ? { ...next, splitSessions: null, splitQuestions: null, splitWarning: null } : next;
      });
      return answer(route, state.rows.find((r) => r.id === rid));
    });
    return state;
  }
  test.beforeEach(async ({ page }) => { await mockApi(page); });

  test('a good split shows its counts and a bad one shows the warning with both actions', async ({ page }) => {
    await keepResources(page, [examOk, examBad(), resource({ id: 'rsMd', role: 'mixed', filename: 'lab.md', kind: 'md' })]);
    await page.goto('/books/p1/sources');
    const ok = page.getByRole('listitem').filter({ hasText: 'Temi_desame_2019-2023.pdf' });
    await expect(ok.getByText('14 sessions · 63 questions found')).toBeVisible();
    await expect(ok.getByRole('alert')).toHaveCount(0);
    const bad = page.getByRole('listitem').filter({ hasText: 'esami-2024.pdf' });
    const warning = bad.getByRole('alert');
    await expect(warning).toContainText('1 session and 0 questions found in esami-2024.pdf');
    await expect(warning).toContainText('No question was split out of this one');
    await expect(warning.getByRole('button', { name: 'Split with AI' })).toBeEnabled();
    await expect(warning.getByRole('button', { name: 'Mark as not an exam' })).toBeEnabled();
    // The two other kinds of warning say what happened in their own words.
    await expect(page.getByRole('listitem').filter({ hasText: 'lab.md' }).getByRole('alert')).toHaveCount(0);
  });

  test('each warning kind is explained in plain words', async ({ page }) => {
    await keepResources(page, [examBad({ splitWarning: 'no_heading', splitSessions: 1, splitQuestions: 12 }), examBad({ id: 'rsThin', filename: 'thin.pdf', splitWarning: 'thin_sessions', splitSessions: 5, splitQuestions: 5 })]);
    await page.goto('/books/p1/sources');
    await expect(page.getByRole('alert').first()).toContainText('1 session and 12 questions found in esami-2024.pdf');
    await expect(page.getByRole('alert').first()).toContainText('no session heading, so the whole file counts as one session');
    await expect(page.getByRole('alert').nth(1)).toContainText('5 sessions and 5 questions found in thin.pdf');
    await expect(page.getByRole('alert').nth(1)).toContainText('Every session has at most one question');
  });

  const splitTask = (over: Record<string, unknown> = {}) => ({ id: 'tk7', runId: 'r7', kind: 'resource.split', label: 'Split esami-2024.pdf with AI', state: 'running', attempts: 1, provider: 'codex', error: null, waitReason: null, resourceId: 'rsBad', applied: null, startedAt: ago(1), finishedAt: null, ...over });
  const NOT_APPLIED = 'The AI split of esami-2024.pdf was not applied. The solution of exercise 2 of "Esame del 12 febbraio 2024" does not start with the line the model quoted on page 9, or it comes before the exercise.';
  /** The newest Prepare run as the service lists it, and its tasks. A test changes `run.summary` and `run.tasks` to move the run on. */
  async function keepRun(page: Page, summary: ReturnType<typeof aiRun> | null, tasks: unknown[] = []) {
    const run = { summary, tasks, detailFetches: 0 };
    await page.route(/\/api\/projects\/p1\/runs$/, (route) => answer(route, run.summary ? [run.summary] : []));
    await page.route(/\/api\/runs\/r7$/, (route) => { run.detailFetches++; return answer(route, { ...run.summary, tasks: run.tasks, usage: [] }); });
    return run;
  }

  test('Split with AI shows the run, and an answer the service did not accept leaves the warning with its reason', async ({ page }) => {
    const state = await keepResources(page, [examBad()]);
    const run = await keepRun(page, null);
    await page.route(/\/api\/resources\/rsBad\/split$/, (route) => { state.splits++; run.summary = aiRun('running'); run.tasks = [splitTask()]; return answer(route, run.summary); });
    await page.goto('/books/p1/sources');
    await page.getByRole('button', { name: 'Split with AI' }).click();
    const busy = page.getByRole('status').filter({ hasText: 'Splitting esami-2024.pdf with AI' });
    await expect(busy).toBeVisible();
    await expect(busy.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/books/p1/run');
    await expect(page.getByRole('button', { name: 'Split with AI' })).toHaveCount(0);

    // The run finishes: the split task says it did not apply, and the run summary carries the reason.
    run.summary = aiRun('completed', [{ taskId: 'tk7', label: 'Split esami-2024.pdf with AI', message: NOT_APPLIED }]);
    run.tasks = [splitTask({ state: 'succeeded', applied: false, finishedAt: ago(0) })];
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The AI split of esami-2024.pdf was not applied.', { timeout: 15_000 });
    await expect(alert).toContainText('The file keeps the split it had.');
    await expect(alert).toContainText('1 session and 0 questions found in esami-2024.pdf');
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(state.splits).toBe(1);
  });

  test('a split the service accepted replaces the warning with the counts', async ({ page }) => {
    const state = await keepResources(page, [examBad()]);
    const run = await keepRun(page, null);
    await page.route(/\/api\/resources\/rsBad\/split$/, (route) => { run.summary = aiRun('running'); run.tasks = [splitTask()]; return answer(route, run.summary); });
    await page.goto('/books/p1/sources');
    await page.getByRole('button', { name: 'Split with AI' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Splitting esami-2024.pdf with AI' })).toBeVisible();
    // The new split is stored by the time the task is done.
    state.rows = [examBad({ splitSessions: 9, splitQuestions: 41, splitWarning: null })];
    run.summary = aiRun('completed');
    run.tasks = [splitTask({ state: 'succeeded', applied: true, finishedAt: ago(0) })];
    await expect(page.getByText('esami-2024.pdf was split with AI')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('9 sessions · 41 questions found')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('the row finds its split again after the page is left and opened again', async ({ page }) => {
    await keepResources(page, [examBad()]);
    const run = await keepRun(page, aiRun('running'), [splitTask(), splitTask({ id: 'tk8', kind: 'resource.questions', label: 'Split other.pdf into questions', resourceId: 'rsOther', state: 'queued' })]);
    await page.goto('/books/p1/sources');
    // No component state knows about this run: the row reads it from the project's runs and their tasks.
    const busy = page.getByRole('status').filter({ hasText: 'Splitting esami-2024.pdf with AI' });
    await expect(busy).toBeVisible();
    await expect(page.getByRole('button', { name: 'Split with AI' })).toHaveCount(0);
    await busy.getByRole('link', { name: 'Open run' }).click();
    await expect(page).toHaveURL(/\/books\/p1\/run$/);
    run.summary = aiRun('completed', [{ taskId: 'tk7', label: 'Split esami-2024.pdf with AI', message: NOT_APPLIED }]);
    run.tasks = [splitTask({ state: 'succeeded', applied: false, finishedAt: ago(0) })];
    await page.getByRole('link', { name: 'Sources' }).first().click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The AI split of esami-2024.pdf was not applied.');
    await expect(alert).toContainText('The file keeps the split it had.');
  });

  test('the split actions wait until the row knows whether a split is running', async ({ page }) => {
    await keepResources(page, [examBad()]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/projects\/p1\/runs$/, async (route) => { await held; return answer(route, [aiRun('running')]); });
    await page.route(/\/api\/runs\/r7$/, (route) => answer(route, { ...aiRun('running'), tasks: [splitTask()], usage: [] }));
    await page.goto('/books/p1/sources');
    // The runs have not arrived yet, so a split may already be under way: the actions are there but cannot be used.
    await expect(page.getByRole('button', { name: 'Split with AI' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Mark as not an exam' })).toBeDisabled();
    release();
    await expect(page.getByRole('status').filter({ hasText: 'Splitting esami-2024.pdf with AI' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Split with AI' })).toHaveCount(0);
  });

  test('a run that fails after a split that was applied says so, and does not say the old split was kept', async ({ page }) => {
    // The split task replaced the questions and left no warning, then the topic map failed.
    await keepResources(page, [examOk, examBad({ splitSessions: 9, splitQuestions: 41, splitWarning: null })]);
    await keepRun(page, aiRun('failed'), [splitTask({ state: 'succeeded', applied: true, finishedAt: ago(1) }), splitTask({ id: 'tk9', kind: 'topics.map', label: 'Map the topics', resourceId: null, state: 'failed' })]);
    await page.goto('/books/p1/sources');
    const note = page.getByRole('listitem').filter({ hasText: 'esami-2024.pdf' }).getByRole('alert');
    await expect(note).toContainText('The new split was saved, but the run failed afterwards, so the topics may not use it yet.');
    await expect(note).not.toContainText('keeps the split it had');
    await expect(note.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('a split task that failed or was cancelled leaves the old split and offers another try', async ({ page }) => {
    await keepResources(page, [examBad()]);
    const run = await keepRun(page, aiRun('failed'), [splitTask({ state: 'failed', error: { message: 'The model answered with text that is not valid.' } })]);
    await page.goto('/books/p1/sources');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The split with AI failed, so the file keeps the split it had. The model answered with text that is not valid.');
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeEnabled();
    run.summary = aiRun('cancelled');
    run.tasks = [splitTask({ state: 'cancelled' })];
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('The split with AI was cancelled, so the file keeps the split it had.');
  });

  test('an excluded file with an empty split does not get the green check', async ({ page }) => {
    await keepResources(page, [resource({ id: 'rsOut', role: 'exams', filename: 'fuori.pdf', included: false, splitSessions: 1, splitQuestions: 0, splitWarning: null })]);
    await page.goto('/books/p1/sources');
    const row = page.getByRole('listitem').filter({ hasText: 'fuori.pdf' });
    await expect(row).toBeVisible();
    await expect(row.getByText(/questions? found/)).toHaveCount(0);
  });

  test('a refusal while Prepare runs is shown in the row and the file keeps its warning', async ({ page }) => {
    await keepResources(page, [examBad()]);
    await page.route(/\/api\/resources\/rsBad\/split$/, (route) => answer(route, { error: { code: 'prepare_running', message: 'Prepare is running. Split this file when it has finished.', action: 'Wait for the run to finish, or open it from the Run panel.' } }, 409));
    await page.goto('/books/p1/sources');
    await page.getByRole('button', { name: 'Split with AI' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Prepare is running. Split this file when it has finished. Wait for the run to finish');
    await expect(alert).toContainText('1 session and 0 questions found');
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  test('a refusal because questions were worked on says so', async ({ page }) => {
    await keepResources(page, [examBad()]);
    await page.route(/\/api\/resources\/rsBad\/split$/, (route) => answer(route, { error: { code: 'questions_in_use', message: 'Some questions of this source were edited or checked already, and a new split would replace them.', action: 'Delete those questions first, or keep the split as it is.' } }, 409));
    await page.goto('/books/p1/sources');
    await page.getByRole('button', { name: 'Split with AI' }).click();
    await expect(page.getByRole('alert')).toContainText('Some questions of this source were edited or checked already');
  });

  test('Mark as not an exam changes the role to Theory, the one role whose questions stop counting, and Undo brings the warning back', async ({ page }) => {
    const state = await keepResources(page, [examBad()]);
    await page.goto('/books/p1/sources');
    await page.getByRole('button', { name: 'Mark as not an exam' }).click();
    const note = page.getByRole('status').filter({ hasText: 'Marked as not an exam' });
    await expect(note).toContainText('The role is now Theory, so the questions of this file no longer count as exam questions');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('Role of esami-2024.pdf')).toHaveValue('theory');
    expect(state.patches).toEqual([{ rid: 'rsBad', body: { role: 'theory' } }]);
    await note.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('alert')).toContainText('1 session and 0 questions found');
    await expect(page.getByLabel('Role of esami-2024.pdf')).toHaveValue('exams');
  });

  test('the warning row fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await keepResources(page, [examOk, examBad()]);
    await page.goto('/books/p1/sources');
    await expect(page.getByRole('alert')).toBeVisible();
    await noOverflow(page);
  });
});

test.describe('Run panel: warnings', () => {
  test('a completed Prepare run with warnings is not shown as a plain success', async ({ page }) => {
    await mockApi(page);
    const run = aiRun('completed', [{ taskId: 'tk', label: 'Split esami-2024.pdf with AI', message: 'The AI split of esami-2024.pdf was not applied. The model found no exercise.' }]);
    await page.route(/\/api\/projects\/p1\/runs$/, (route) => answer(route, [run, { ...aiRun('completed'), id: 'r6', createdAt: ago(60) }]));
    await page.route(/\/api\/runs\/r7$/, (route) => answer(route, { ...run, tasks: [], usage: [] }));
    await page.goto('/books/p1/run');
    const warnings = page.getByRole('region', { name: 'Warnings' });
    await expect(warnings).toContainText('1 warning from this run');
    await expect(warnings).toContainText('Split esami-2024.pdf with AI');
    await expect(warnings).toContainText('The model found no exercise.');
    await expect(page.getByText('Completed with warnings')).toHaveCount(2); // the head badge and the entry in the list
    await expect(page.getByText('Completed', { exact: true })).toHaveCount(1); // the other run has no warnings
  });
});

// ---------- Review ----------

const issue = (id: string, severity: string, over: Record<string, unknown> = {}) => ({ id, projectId: 'p1', nodeId: 's1', questionId: null, revId: null, source: 'review', severity, category: 'clarity', quote: '', message: `Message ${id}`, suggestion: '', status: 'open', resolution: '', createdAt: ago(3), ...over });
const plotAsset = (over: Record<string, unknown> = {}) => ({ id: 'a1', projectId: 'p1', nodeId: 's1', filename: 'rc-filter.svg', mime: 'image/svg+xml', origin: 'plot', spec: null, caption: 'Risposta in frequenza del filtro RC', alt: 'Diagramma di Bode', checks: [], createdAt: ago(60), ...over });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100"><rect width="160" height="100" fill="#fff"/><path d="M10 80 C60 80 70 20 150 20" stroke="#2b2f3a" fill="none" stroke-width="3"/></svg>';

async function reviewData(page: Page, issues: unknown[], opts: { review?: 'completed' | 'none'; assets?: unknown[] } = {}) {
  await mockApi(page);
  await page.route(/\/api\/projects\/p1\/issues$/, (route) => answer(route, issues));
  await page.route(/\/api\/projects\/p1\/assets$/, (route) => answer(route, opts.assets ?? []));
  await page.route(/\/api\/assets\/\w+\/file$/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
  const reviewRun = { id: 'r5', projectId: 'p1', kind: 'review', status: 'completed', createdAt: ago(4), finishedAt: ago(3), counts: { succeeded: 2 }, waiting: null, warnings: [] };
  await page.route(/\/api\/projects\/p1\/runs$/, (route) => answer(route, opts.review === 'none' ? [] : [reviewRun]));
  // The service says where the review stands: clean when every chapter was reviewed and nothing serious is open.
  const serious = (issues as { severity?: string; status?: string }[]).filter((i) => i.severity !== 'minor' && i.status === 'open').length;
  const standing = opts.review === 'none' ? null : { clean: serious === 0, openSerious: serious, reviewedAt: ago(3) };
  await page.route(/\/api\/projects\/p1$/, (route) => answer(route, { ...mockData().projects[0], activeRun: null, review: standing }));
}

test.describe('Review: minor notes', () => {
  const issues = [
    issue('m1', 'major', { category: 'correctness', message: 'Current division is reversed.' }),
    issue('b1', 'blocker', { category: 'correctness', message: 'The solution does not match.' }),
    ...Array.from({ length: 8 }, (_, i) => issue(`n${i + 1}`, 'minor', { category: 'style', message: `Small wording note ${i + 1}.`, source: 'lint' })),
  ];

  test('minor notes are one collapsed group, selected like every other open issue', async ({ page }) => {
    await reviewData(page, issues);
    await page.goto('/books/p1/review');
    await expect(page.getByText('1 blocker, 1 major issue and 8 minor notes in the changed text.')).toBeVisible();
    const group = page.locator('details.rv-minor');
    await expect(group).not.toHaveAttribute('open', '');
    await expect(group.locator('summary')).toContainText('8 minor notes');
    await expect(group.locator('summary')).toContainText('all selected');
    // The blockers and majors are above the group and selected.
    const main = page.getByRole('list', { name: 'Blockers and major issues' });
    await expect(main.getByRole('checkbox')).toHaveCount(2);
    await expect(main.getByRole('checkbox').first()).toBeChecked();
    await expect(page.getByRole('button', { name: 'Fix selected issues (10)' })).toBeEnabled();
    await expect(page.getByLabel('Select all shown')).toBeChecked();
  });

  test('the group is a disclosure that opens from the keyboard and selects per issue and as a whole', async ({ page }) => {
    await reviewData(page, issues);
    await page.goto('/books/p1/review');
    const group = page.locator('details.rv-minor');
    await group.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(group).toHaveAttribute('open', '');
    // Six notes first, then the rest on request.
    await expect(group.getByRole('checkbox', { name: /Select issue/ })).toHaveCount(6);
    await group.getByRole('button', { name: 'Show the other 2 notes' }).click();
    await expect(group.getByRole('checkbox', { name: /Select issue/ })).toHaveCount(8);

    await group.getByRole('checkbox', { name: 'Select issue: Small wording note 1.' }).uncheck();
    await expect(group.locator('summary')).toContainText('7 selected');
    await expect(page.getByRole('button', { name: 'Fix selected issues (9)' })).toBeVisible();
    await expect(page.getByLabel('Select all shown')).not.toBeChecked();

    // With one note cleared the button selects the rest, and with all selected it clears them.
    await group.getByRole('button', { name: 'Select all 8 minor notes' }).click();
    await expect(group.locator('summary')).toContainText('all selected');
    await group.getByRole('button', { name: 'Clear all 8 minor notes' }).click();
    await expect(group.locator('summary')).toContainText('not selected');
    await expect(page.getByRole('button', { name: 'Fix selected issues (2)' })).toBeVisible();
    await group.getByRole('button', { name: 'Select all 8 minor notes' }).click();
    await expect(page.getByRole('button', { name: 'Fix selected issues (10)' })).toBeVisible();

    await page.keyboard.press('Shift+Tab');
    await group.locator('summary').focus();
    await page.keyboard.press('Space');
    await expect(group).not.toHaveAttribute('open', '');
  });

  test('Fix selected sends every selected issue, minor ones included', async ({ page }) => {
    await reviewData(page, issues);
    let sent: { issueIds: string[] } | null = null;
    await page.route(/\/api\/projects\/p1\/issues\/fix$/, (route) => { sent = route.request().postDataJSON(); return answer(route, { id: 'r8', projectId: 'p1', kind: 'regenerate', status: 'running', createdAt: ago(0), finishedAt: null, counts: { running: 1 }, waiting: null, warnings: [] }); });
    await page.goto('/books/p1/review');
    await page.locator('details.rv-minor > summary').click();
    await page.locator('details.rv-minor').getByRole('checkbox', { name: 'Select issue: Small wording note 2.' }).uncheck();
    await page.getByRole('button', { name: 'Fix selected issues (9)' }).click();
    await expect(page.getByText('Fixing 9 issues.')).toBeVisible();
    expect(sent!.issueIds).toHaveLength(9);
    expect(sent!.issueIds).toContain('n1');
    expect(sent!.issueIds).not.toContain('n2');
    expect(sent!.issueIds).toEqual(expect.arrayContaining(['m1', 'b1']));
  });

  test('the Review tab counts every open issue, minor ones too', async ({ page }) => {
    await reviewData(page, [...issues, issue('d1', 'minor', { status: 'dismissed' })]);
    await page.goto('/books/p1/review');
    await expect(page.locator('.sh-tab__count')).toHaveText('10');
  });

  test('with only minor notes the summary says nothing serious was found and the book is ready to export', async ({ page }) => {
    await reviewData(page, issues.filter((i) => i.severity === 'minor').slice(0, 3));
    await page.goto('/books/p1/review');
    const summary = page.getByRole('status').filter({ hasText: 'No blockers or major issues in the changed text. The book is ready to export.' });
    await expect(summary).toContainText('3 minor notes are left, and they do not hold back the export.');
    await expect(summary.getByRole('link', { name: 'Go to Export' })).toHaveAttribute('href', '/books/p1/export');
  });

  test('without a finished review the page does not claim the book is ready', async ({ page }) => {
    await reviewData(page, [], { review: 'none' });
    await page.goto('/books/p1/review');
    await expect(page.getByText('No open issues.')).toBeVisible();
    await expect(page.getByText('The book is ready to export.')).toHaveCount(0);
  });

  test('before the issues are loaded the page claims nothing, and when they fail to load it still does not', async ({ page }) => {
    await reviewData(page, []);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/api\/projects\/p1\/issues$/, async (route) => { await gate; await answer(route, []); });
    await page.goto('/books/p1/review');
    await expect(page.locator('.ui-skeleton').first()).toBeVisible();
    await expect(page.getByText('The book is ready to export.')).toHaveCount(0);
    await expect(page.getByText('No open issues.')).toHaveCount(0);
    release();
    await expect(page.getByText('The book is ready to export.')).toBeVisible();

    await page.unroute(/\/api\/projects\/p1\/issues$/);
    await page.route(/\/api\/projects\/p1\/issues$/, (route) => answer(route, { error: { code: 'boom', message: 'The issues could not be read.' } }, 500));
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('The issues could not be read.');
    await expect(page.getByText('The book is ready to export.')).toHaveCount(0);
    await expect(page.getByText('Nothing to review yet.')).toHaveCount(0);
  });

  test('the review field of the project decides when the service sends it, and a review under way holds the claim back', async ({ page }) => {
    await reviewData(page, [], { review: 'none' });
    const book = (over: Record<string, unknown>) => ({ ...mockData().projects[0], activeRun: null, ...over });
    await page.route(/\/api\/projects\/p1$/, (route) => answer(route, book({ review: { clean: true, openSerious: 0, reviewedAt: ago(3) } })));
    await page.goto('/books/p1/review');
    await expect(page.getByText('The book is ready to export.')).toBeVisible(); // no review run is listed, the field says clean

    await page.unroute(/\/api\/projects\/p1$/);
    await page.route(/\/api\/projects\/p1$/, (route) => answer(route, book({ review: { clean: false, openSerious: 0, reviewedAt: ago(3) } })));
    await page.route(/\/api\/projects\/p1\/runs$/, (route) => answer(route, [{ id: 'r5', projectId: 'p1', kind: 'review', status: 'completed', createdAt: ago(4), finishedAt: ago(3), counts: { succeeded: 2 }, waiting: null, warnings: [] }]));
    await page.reload();
    await expect(page.getByText('No open issues.')).toBeVisible(); // the run completed, but the text changed after it
    await expect(page.getByText('The book is ready to export.')).toHaveCount(0);

    await page.unroute(/\/api\/projects\/p1$/);
    await page.route(/\/api\/projects\/p1$/, (route) => answer(route, book({ review: { clean: true, openSerious: 0, reviewedAt: ago(30) }, activeRun: { id: 'r9', projectId: 'p1', kind: 'review', status: 'running', createdAt: ago(1), finishedAt: null, counts: { running: 1 }, waiting: null, warnings: [] } })));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Reviewing…' })).toBeVisible();
    await expect(page.getByText('The book is ready to export.')).toHaveCount(0);
  });

  test('the severity filter "Minor" opens the group by itself', async ({ page }) => {
    await reviewData(page, issues);
    await page.goto('/books/p1/review');
    await page.getByLabel('Severity').selectOption('minor');
    await expect(page.locator('details.rv-minor')).toHaveAttribute('open', '');
    await expect(page.getByRole('list', { name: 'Blockers and major issues' })).toHaveCount(0);
  });
});

test.describe('Review: figure issues', () => {
  test('an issue about a figure shows its drawing on the figure plate, and one that cannot be tied shows none', async ({ page }) => {
    const second = plotAsset({ id: 'a2', filename: 'bode-phase.svg', caption: 'Fase del filtro RC', alt: 'Fase' });
    await reviewData(page, [
      issue('f1', 'major', { category: 'figure', message: 'The label C is drawn over the label Vout.', quote: ':::image{src="assets/rc-filter.svg" alt="Diagramma di Bode"}' }),
      issue('f2', 'major', { category: 'figure', nodeId: 's2', message: 'The only figure here repeats the text.' }),
      issue('f3', 'minor', { category: 'figure', message: 'A figure of this section has thin lines.' }),
      issue('t1', 'major', { category: 'correctness', message: 'Not a figure issue.' }),
    ], { assets: [plotAsset(), second, plotAsset({ id: 'a3', nodeId: 's2', filename: 'only.svg', caption: 'Unica', alt: '' })] });
    await page.goto('/books/p1/review');
    const tied = page.getByRole('listitem').filter({ hasText: 'The label C is drawn over the label Vout.' });
    await expect(tied.locator('.rv-thumb .sb-figure-frame img')).toBeVisible();
    await expect(tied.locator('.rv-thumb img')).toHaveAttribute('src', '/api/assets/a1/file');
    await expect(tied.locator('.rv-thumb')).toContainText('Risposta in frequenza del filtro RC');
    await expect(tied.getByRole('link', { name: /Open the section with the figure/ })).toHaveAttribute('href', /\/books\/p1\/manuscript\/s1\?issue=f1/);
    // The section s2 has one figure, so an issue about a figure of s2 is about that one.
    const single = page.getByRole('listitem').filter({ hasText: 'The only figure here repeats the text.' });
    await expect(single.locator('.rv-thumb img')).toHaveAttribute('src', '/api/assets/a3/file');
    // Section s1 has two figures and this issue names neither: no thumbnail rather than a guess.
    await page.locator('details.rv-minor > summary').click();
    const ambiguous = page.getByRole('listitem').filter({ hasText: 'A figure of this section has thin lines.' });
    await expect(ambiguous).toBeVisible();
    await expect(ambiguous.locator('.rv-thumb')).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'Not a figure issue.' }).locator('.rv-thumb')).toHaveCount(0);
  });

  test('the thumbnail fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reviewData(page, [issue('f1', 'major', { category: 'figure', message: 'Labels overlap.' })], { assets: [plotAsset()] });
    await page.goto('/books/p1/review');
    await expect(page.locator('.rv-thumb img')).toBeVisible();
    await noOverflow(page);
  });
});

// ---------- Connections ----------

test.describe('Connections: usage and routing', () => {
  test.beforeEach(async ({ page }) => { await mockApi(page); });

  test('the usage table shows calls, tokens, cached share, failures and timeouts per provider', async ({ page }) => {
    await page.goto('/connections');
    const table = page.getByRole('region', { name: 'Model calls per provider' });
    await expect(page.getByRole('heading', { name: 'Usage, last 30 days' })).toBeVisible();
    for (const h of ['Provider', 'Calls', 'Input tokens', 'Cached', 'Output tokens', 'Failed', 'Timeouts']) await expect(table.getByRole('columnheader', { name: h })).toBeVisible();
    const claude = table.getByRole('row').filter({ hasText: 'Claude' });
    await expect(claude).toContainText('1,284');
    await expect(claude).toContainText('41.8M');
    await expect(claude).toContainText('73%');
    await expect(claude).toContainText('2.3M');
    await expect(claude.getByRole('cell').nth(4)).toHaveText('9');
    // Timeouts are amber above 1 call in 100: Codex has 21 of 612, Claude 6 of 1284.
    await expect(table.getByRole('row').filter({ hasText: 'Codex' }).getByRole('cell').nth(5)).toHaveClass(/cn-warn-num/);
    await expect(claude.getByRole('cell').nth(5)).not.toHaveClass(/cn-warn-num/);
    await expect(table.getByRole('row').filter({ hasText: 'All providers' })).toContainText('1,896');
    await expect(table.getByRole('row').filter({ hasText: 'All providers' })).toContainText('68%');
  });

  test('a share that cannot be computed shows a dash, and no calls shows a sentence', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(/\/api\/usage$/, (route) => answer(route, { days: 30, providers: [{ provider: 'claude', models: ['claude-sonnet-5'], calls: 40, inputTokens: 90_000, outputTokens: 4_000, cachedShare: null, failed: 0, timeouts: 0 }], total: { provider: '', models: [], calls: 40, inputTokens: 90_000, outputTokens: 4_000, cachedShare: null, failed: 0, timeouts: 0 } }));
    await page.goto('/connections');
    const row = page.getByRole('region', { name: 'Model calls per provider' }).getByRole('row').filter({ hasText: 'Claude' });
    await expect(row.getByRole('cell').nth(2)).toHaveText(/–\s*Not recorded/);
    await expect(row).toContainText('90K');
    await expect(row.locator('.cn-bar')).toHaveCount(0);
    await noOverflow(page); // the hidden "Not recorded" text must not widen the page

    await page.unroute(/\/api\/usage$/);
    await page.route(/\/api\/usage$/, (route) => answer(route, { days: 30, providers: [], total: { provider: '', models: [], calls: 0, inputTokens: 0, outputTokens: 0, cachedShare: null, failed: 0, timeouts: 0 } }));
    await page.goto('/connections');
    await expect(page.getByText('No model calls in the last 30 days.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Model calls per provider' })).toHaveCount(0);
  });

  test('tokens no call reported show a dash, not zero', async ({ page }) => {
    const none = { provider: 'agy', models: ['gemini'], calls: 3, inputTokens: null, outputTokens: null, cachedShare: null, failed: 0, timeouts: 0 };
    await page.route(/\/api\/usage$/, (route) => answer(route, { days: 30, providers: [none], total: { ...none, provider: '' } }));
    await page.goto('/connections');
    const row = page.getByRole('region', { name: 'Model calls per provider' }).getByRole('row').filter({ hasText: 'agy' });
    await expect(row.getByRole('cell').nth(1)).toHaveText(/–\s*Not reported/);
    await expect(row.getByRole('cell').nth(3)).toHaveText(/–\s*Not reported/);
    await expect(row).not.toContainText('0 tokens');
  });

  test('the usage table shows when the connections request fails, and Check again reads both again', async ({ page }) => {
    let usageReads = 0;
    let connectionReads = 0;
    await page.route(/\/api\/connections$/, (route) => { connectionReads++; return answer(route, { error: { code: 'boom', message: 'The tools could not be checked.' } }, 500); });
    await page.route(/\/api\/usage$/, (route) => { usageReads++; return route.fallback(); });
    await page.goto('/connections');
    await expect(page.getByRole('alert').filter({ hasText: 'The tools could not be checked.' })).toBeVisible();
    const table = page.getByRole('region', { name: 'Model calls per provider' });
    await expect(table.getByRole('row').filter({ hasText: 'claude' })).toContainText('1,284'); // no label without the provider list, so the id
    const [usage0, connections0] = [usageReads, connectionReads];
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => [usageReads > usage0, connectionReads > connections0]).toEqual([true, true]);
  });

  test('the usage table scrolls inside its box on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/connections');
    await expect(page.getByRole('region', { name: 'Model calls per provider' })).toBeVisible();
    await noOverflow(page);
  });

  test('the routing list has one entry for every role of the role table, with no code change here', async ({ page }) => {
    // The saved settings of the mock lack the two newest roles, as the settings of an older version do.
    await page.goto('/connections');
    await expect(page.locator('.cn-role__name')).toHaveCount(ROLES.length);
    const names = await page.locator('.cn-role__name').allTextContents();
    expect(names).toEqual(ROLES.map((r) => ROLE_LABELS[r].label));
  });
});
