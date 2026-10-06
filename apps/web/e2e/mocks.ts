/** In-browser API mock for screenshots and layout checks: independent of the service routes. */
import type { Page, Route } from '@playwright/test';

const now = new Date();
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

const emptyCounts = { resources: 0, sections: 0, drafted: 0, questions: 0, openIssues: 0 };
const baseOptions = { outsideMaterial: false, ide: true, graphs: true, figures: true, firstChapterGate: true, outlineGate: true, exercisesPerTopic: 3, exercisesPerHotTopic: 6, chapterScope: [] };

const projects = [
  {
    id: 'p1', title: 'Analisi matematica 1: limiti, derivate e integrali per Ingegneria Gestionale', subject: 'Analisi matematica', slug: 'analisi-1', authors: ['Tost'], language: 'it',
    audience: 'Primo anno', goals: '', options: baseOptions, stage: 'drafting', outlineRevId: 'o1', createdAt: ago(9000), updatedAt: ago(12), archivedAt: null,
    counts: { resources: 3, sections: 9, drafted: 4, questions: 22, openIssues: 3 },
    activeRun: { id: 'r1', projectId: 'p1', kind: 'generate', status: 'running', createdAt: ago(30), finishedAt: null, counts: { succeeded: 4, running: 2, queued: 12 }, waiting: null },
  },
  { id: 'p2', title: 'Fisica tecnica', subject: 'Fisica tecnica', slug: 'fisica-tecnica', authors: [], language: 'it', audience: '', goals: '', options: baseOptions, stage: 'sources', outlineRevId: null, createdAt: ago(5000), updatedAt: ago(3000), archivedAt: null, counts: emptyCounts, activeRun: null },
  { id: 'p3', title: 'Chimica generale', subject: 'Chimica', slug: 'chimica', authors: ['Tost'], language: 'it', audience: '', goals: '', options: baseOptions, stage: 'review', outlineRevId: 'o2', createdAt: ago(20000), updatedAt: ago(4000), archivedAt: null, counts: { resources: 2, sections: 12, drafted: 12, questions: 30, openIssues: 0 }, activeRun: null },
];

const resources = [
  { id: 'rs1', projectId: 'p1', kind: 'pdf', role: 'theory', filename: 'Dispense_Analisi_1_Capitoli_1-6.pdf', url: null, sha256: 'a'.repeat(64), size: 4_820_000, included: true, status: 'ready', error: null, pageCount: 142, pagesNeedingVision: 6, pagesTranscribed: 2, createdAt: ago(9000) },
  { id: 'rs2', projectId: 'p1', kind: 'pdf', role: 'exams', filename: 'Temi_desame_2019-2024.pdf', url: null, sha256: 'b'.repeat(64), size: 12_100_000, included: true, status: 'extracting', error: null, pageCount: 0, pagesNeedingVision: 0, pagesTranscribed: 0, createdAt: ago(5) },
  { id: 'rs3', projectId: 'p1', kind: 'md', role: 'mixed', filename: 'appunti.md', url: null, sha256: 'c'.repeat(64), size: 9_200, included: false, status: 'ready', error: null, pageCount: 3, pagesNeedingVision: 0, pagesTranscribed: 0, createdAt: ago(800) },
];

const topics = [
  ['t1', 'Limiti di successioni', 14, 'high'], ['t2', 'Limiti di funzioni', 22, 'high'], ['t3', 'Continuità', 9, 'normal'], ['t4', 'Derivate', 27, 'high'],
  ['t5', 'Studio di funzione', 25, 'high'], ['t6', 'Integrali impropri', 7, 'normal'], ['t7', 'Serie numeriche', 3, 'low'], ['t8', 'Equazioni differenziali', 0, 'low'],
].map(([id, name, examSessions, priority]) => ({ id, projectId: 'p1', name, aliases: [], description: '', prerequisites: [], sources: [], examSessions, priority }));

const outline = {
  chapters: [
    { id: 'c1', slug: 'limiti', title: 'Limiti e continuità', objectives: ['Calcolare limiti di successioni e funzioni', 'Riconoscere le forme indeterminate'], prerequisites: [], sections: [
      { id: 's1', title: 'Definizione di limite', objectives: ['Enunciare la definizione epsilon-delta'], topicIds: ['t1', 't2'], depth: 'deep', subsections: [{ id: 'ss1', title: 'Intorni', objectives: [] }, { id: 'ss2', title: 'Limite destro e sinistro', objectives: [] }] },
      { id: 's2', title: 'Limiti notevoli', objectives: [], topicIds: ['t2'], depth: 'standard', subsections: [] },
      { id: 's3', title: 'Continuità', objectives: [], topicIds: ['t3'], depth: 'standard', subsections: [] },
    ] },
    { id: 'c2', slug: 'derivate', title: 'Calcolo differenziale', objectives: [], prerequisites: ['c1'], sections: [
      { id: 's4', title: 'Derivata e retta tangente', objectives: [], topicIds: ['t4'], depth: 'standard', subsections: [] },
      { id: 's5', title: 'Studio di funzione', objectives: [], topicIds: ['t5'], depth: 'deep', subsections: [] },
    ] },
  ],
  exclusions: [{ topicId: 't8', reason: 'Fuori programma quest’anno' }],
  notation: '',
};

const notes = [
  { id: 'n1', quote: 'Si dice che f ha limite L per x che tende a x0 se, per ogni ε > 0, esiste δ > 0 tale che |f(x) − L| < ε per ogni x con 0 < |x − x0| < δ.', resourceId: 'rs1', page: 11, verified: true, claim: 'Definizione epsilon-delta di limite' },
  { id: 'n2', quote: 'Il limite notevole lim sin(x)/x per x → 0 vale 1.', resourceId: 'rs1', page: 14, verified: true, claim: 'Limite notevole del seno' },
  { id: 'n3', quote: 'Tale risultato si estende ai limiti infiniti con le opportune modifiche.', resourceId: null, page: null, verified: false, claim: 'Estensione ai limiti infiniti' },
];

const source1 = `### Intorni

Sia $x_0 \\in \\mathbb{R}$. Un **intorno** di $x_0$ è un intervallo aperto che contiene $x_0$.

Una funzione $f$ ha limite $L$ per $x \\to x_0$ se, per ogni $\\varepsilon > 0$, esiste $\\delta > 0$ tale che $|f(x) - L| < \\varepsilon$ per ogni $x$ con $0 < |x - x_0| < \\delta$.

:::formula{key="lim-def" label="Definizione di limite"}
$$\\forall \\varepsilon>0\\ \\exists \\delta>0:\\ 0<|x-x_0|<\\delta \\Rightarrow |f(x)-L|<\\varepsilon$$
:::

Il limite, se esiste, è unico. Questo segue dalla {{formula:@lim-def}} e dalla disuguaglianza triangolare.

- Il limite destro considera solo $x > x_0$.
- Il limite sinistro considera solo $x < x_0$.

### Limite destro e sinistro

Il limite esiste se e solo se i due limiti laterali esistono e coincidono; tale risultato si estende ai limiti infiniti con le opportune modifiche.`;

const compiled1 = `## p1 | Definizione di limite

### Intorni

Sia $x_0 \\in \\mathbb{R}$. Un **intorno** di $x_0$ è un intervallo aperto che contiene $x_0$.

Una funzione $f$ ha limite $L$ per $x \\to x_0$ se, per ogni $\\varepsilon > 0$, esiste $\\delta > 0$ tale che $|f(x) - L| < \\varepsilon$ per ogni $x$ con $0 < |x - x_0| < \\delta$.

:::formula{id="1.1" label="Definizione di limite"}
$$\\forall \\varepsilon>0\\ \\exists \\delta>0:\\ 0<|x-x_0|<\\delta \\Rightarrow |f(x)-L|<\\varepsilon$$
:::

Il limite, se esiste, è unico. Questo segue dalla {{formula:1.1}} e dalla disuguaglianza triangolare.

- Il limite destro considera solo $x > x_0$.
- Il limite sinistro considera solo $x < x_0$.

### Limite destro e sinistro

Il limite esiste se e solo se i due limiti laterali esistono e coincidono; tale risultato si estende ai limiti infiniti con le opportune modifiche.`;

function rev(id: string, md: string, origin = 'ai', status = 'current') {
  return { id, projectId: 'p1', nodeId: 's1', kind: 'section', markdown: md, origin, model: origin === 'ai' ? 'claude-sonnet-5' : null, parentRevId: null, status, citations: { '1': ['n1'], '2': ['n1'], '3': ['n1'], '5': ['n2'], '7': ['n3'] }, createdAt: ago(40) };
}

const issue = { id: 'i1', projectId: 'p1', nodeId: 's1', questionId: null, revId: 'rv1', source: 'review', severity: 'major', category: 'unsupported-claim', quote: 'Il limite, se esiste, è unico.', message: 'The uniqueness of the limit is stated without a proof or a citation.', suggestion: 'Cite the page of the notes that proves uniqueness, or add the short argument with the triangle inequality.', status: 'open', resolution: '', createdAt: ago(20) };
const issue2 = { ...issue, id: 'i2', nodeId: null, questionId: 'q1', source: 'verification', severity: 'blocker', category: 'solution-mismatch', quote: '', message: 'The independent solution gives x in (-inf, -3] U [0, +inf), the book says (-3, 0).', suggestion: '', createdAt: ago(60) };

const section = (id: string, title: string, withContent: boolean, proposal = false) => ({
  chapterId: 'c1', sectionId: id, title, current: withContent ? rev('rv1', source1) : null,
  proposal: proposal ? rev('rv2', source1.replace('è unico', 'è unico (teorema di unicità del limite)').replace('Il limite destro considera', 'Il limite destro prende in considerazione'), 'ai', 'proposal') : null,
  evidence: withContent ? { id: 'e1', projectId: 'p1', nodeId: id, provider: 'notebooklm', query: '', answer: '', notes, createdAt: ago(50) } : null,
  issues: id === 's1' ? [issue] : [], compiled: withContent ? compiled1 : '',
});

const chapters = [
  { chapterId: 'c1', number: 1, title: 'Limiti e continuità', intro: null, sections: [section('s1', 'Definizione di limite', true), section('s2', 'Limiti notevoli', true, true), section('s3', 'Continuità', false)] },
  { chapterId: 'c2', number: 2, title: 'Calcolo differenziale', intro: null, sections: [section('s4', 'Derivata e retta tangente', false), section('s5', 'Studio di funzione', false)] },
];

const pageSvg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#fff"/><text x="70" y="110" font-family="Georgia" font-size="34" font-weight="700" fill="#222">2.3 Definizione di limite</text>${Array.from({ length: 18 }, (_, i) => `<rect x="70" y="${180 + i * 46}" width="${620 + ((i * 53) % 150)}" height="12" rx="4" fill="#c9ccd6"/>`).join('')}<rect x="60" y="364" width="760" height="40" fill="rgba(232,93,38,0.28)"/><rect x="60" y="410" width="520" height="40" fill="rgba(232,93,38,0.28)"/><text x="70" y="1130" font-family="monospace" font-size="22" fill="#555">${label}</text></svg>`;

export function mockData() { return { projects, resources, topics, outline, chapters }; }

export async function mockApi(page: Page, opts: { empty?: boolean } = {}) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/events') return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: ': connected\nretry: 600000\n\n' });
    if (/\/pages\/\d+\/image$/.test(path)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: pageSvg(`page ${path.split('/').at(-2)}`) });
    if (path === '/api/projects') return json(opts.empty ? [] : projects);
    const proj = /^\/api\/projects\/(\w+)$/.exec(path);
    if (proj) return json(projects.find((p) => p.id === proj[1]) ?? projects[0]);
    if (/\/resources$/.test(path)) return json(resources);
    if (/\/resources\/[^/]+$/.test(path) || /\/index$/.test(path)) return json(path.endsWith('/index') ? { resourceId: 'rs1', origin: 'extracted', entries: [{ title: 'Capitolo 1. Limiti', level: 1, page: 8 }, { title: '1.1 Intorni', level: 2, page: 9 }, { title: '1.2 Definizione di limite', level: 2, page: 11 }, { title: 'Capitolo 2. Derivate', level: 1, page: 30 }] } : null);
    if (/\/api\/resources\/[^/]+\/pages$/.test(path)) return json(Array.from({ length: 142 }, (_, i) => ({ id: `pg${i}`, idx: i, label: String(i + 1), quality: i % 23 === 5 ? 'garbled' : 'good' })));
    if (/\/api\/resources\/[^/]+\/pages\/\d+$/.test(path)) return json({ id: 'pg', resourceId: 'rs1', idx: 11, label: '12', text: 'Definizione 2.3. Sia f : A → R e x0 punto di accumulazione di A. Si dice che f ha limite L per x che tende a x0 se per ogni ε > 0 esiste δ > 0 tale che |f(x) − L| < ε per ogni x ∈ A con 0 < |x − x0| < δ.\n\nEsempio. La funzione f(x) = 2x + 1 ha limite 5 per x → 2.', quality: 'good', transcript: 'Definizione. Sia $f: A \\to \\mathbb{R}$. Si scrive $\\lim_{x\\to x_0} f(x)=L$ se $\\forall \\varepsilon>0\\ \\exists\\delta>0$.', transcriptModel: 'gpt-6-luna' });
    if (/\/topics$/.test(path)) return json(topics);
    if (/\/outline$/.test(path)) return json({ current: { id: 'o1', projectId: 'p1', outline, origin: 'ai', createdAt: ago(300), approvedAt: null, note: '' }, history: [] });
    if (/\/questions$/.test(path)) return json([
      { id: 'q1', projectId: 'p1', kind: 'exam', origin: 'authentic', resourceId: 'rs2', pageFrom: 1, pageTo: 1, examGroup: 'Esame del 25 gennaio 2023 - turno 1', examDate: '2023-01-25', number: '1', statement: 'Si consideri $f(x)=\\sqrt{x^2+3x}-|x|$. Determinare il dominio.', hint: '', solution: '', difficulty: 'medio', topicIds: ['t2'], chapterId: 'c1', status: 'issue', checks: [{ method: 'independent-solve', ok: false, detail: 'Different domain', model: 'gpt-6-sol' }], rev: 1, createdAt: ago(900), updatedAt: ago(900) },
      { id: 'q2', projectId: 'p1', kind: 'exam', origin: 'authentic', resourceId: 'rs2', pageFrom: 2, pageTo: 2, examGroup: 'Esame del 9 giugno 2023', examDate: null, number: '2', statement: 'Calcolare $\\lim_{x\\to0}\\frac{\\sin x}{x}$.', hint: '', solution: '', difficulty: 'facile', topicIds: ['t2'], chapterId: null, status: 'verified', checks: [], rev: 1, createdAt: ago(900), updatedAt: ago(900) },
    ]);
    if (/\/issues$/.test(path)) return json([issue, issue2]);
    if (/\/manuscript$/.test(path)) return json(chapters);
    const sec = /\/sections\/(\w+)$/.exec(path);
    if (sec && method === 'GET') return json(chapters.flatMap((c) => c.sections).find((s) => s.sectionId === sec[1]) ?? chapters[0].sections[0]);
    if (/\/chapters\/\w+\/preview$/.test(path)) return json({ markdown: compiled1, number: 1, assets: {} });
    if (/\/runs$/.test(path)) return json([projects[0].activeRun]);
    if (/\/api\/runs\/\w+$/.test(path)) return json({ ...projects[0].activeRun, tasks: [{ id: 'tk1', runId: 'r1', kind: 'draft', label: 'Draft: Definizione di limite', state: 'running', attempts: 1, provider: 'claude', error: null, waitReason: null, startedAt: ago(2), finishedAt: null }, { id: 'tk2', runId: 'r1', kind: 'draft', label: 'Draft: Limiti notevoli', state: 'failed', attempts: 2, provider: 'codex', error: { message: 'Codex is not signed in.', action: 'Run codex login in a terminal, then press Retry.' }, waitReason: null, startedAt: ago(5), finishedAt: ago(4) }], usage: [{ provider: 'claude', model: 'claude-sonnet-5', role: 'writer', calls: 8, inputTokens: 31200, outputTokens: 9800 }, { provider: 'codex', model: 'gpt-6-sol', role: 'reviewer', calls: 2, inputTokens: null, outputTokens: null }] });
    if (/\/exports$/.test(path)) return json([]);
    if (/\/assets$/.test(path) || /\/enrichments$/.test(path)) return json([]);
    if (path === '/api/connections') return json({ providers: [{ provider: 'claude', label: 'Claude', installed: true, version: '2.4.1', signedIn: true, models: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['medium', 'high'] }], capabilities: { images: true, schema: 'native', system: true }, error: null }, { provider: 'codex', label: 'Codex', installed: true, version: '0.9.0', signedIn: false, models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'medium', 'high'] }], capabilities: { images: true, schema: 'prompt', system: false }, error: null }, { provider: 'antigravity', label: 'Antigravity', installed: false, version: null, signedIn: null, models: [], capabilities: { images: false, schema: 'none', system: false }, error: null }], notebooklm: { installed: true, signedIn: false, account: null, usage: [], error: null, loginCommand: '' }, libreoffice: { installed: true, path: '/usr/bin/soffice' }, node: 'v24.21.0', dataDir: '/home/tost/.local/share/politost-smart-builder' });
    if (path === '/api/settings') return json({ routes: { bulk: { primary: { provider: 'claude', model: 'claude-sonnet-5' } }, vision: { primary: { provider: 'codex', model: 'gpt-6-sol', effort: 'low' } }, evidence: { primary: { provider: 'claude', model: 'claude-sonnet-5' } }, planner: { primary: { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, fallback: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } }, writer: { primary: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' } }, reviewer: { primary: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' }, fallback: { provider: 'claude', model: 'claude-sonnet-5' } } }, evidenceMode: 'notebooklm', concurrency: { claude: 2, codex: 2, antigravity: 2, agent: 1, notebooklm: 2 } });
    return json({ error: { code: 'not_mocked', message: `No mock for ${method} ${path}` } }, 404);
  });
}
