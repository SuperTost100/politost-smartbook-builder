import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { lintCompiled, lintSection } from './lint.ts';
import type { LintFinding } from './types.ts';

const lint = (md: string, opts: { language?: string; keys?: string[] } = {}): LintFinding[] =>
  lintSection(md, { sectionId: 'sec', language: opts.language ?? 'it', knownFormulaKeys: opts.keys ? new Set(opts.keys) : undefined });
const has = (md: string, rule: string, opts?: { language?: string; keys?: string[] }) => lint(md, opts).some((f) => f.rule === rule);
const find = (md: string, rule: string, opts?: { language?: string; keys?: string[] }) => lint(md, opts).find((f) => f.rule === rule);

const GOOD_FORMULA = ':::formula{key="vel" label="Velocità"}\n$$v = \\frac{s}{t}$$\n:::';

test('a clean section has no findings', () => {
  const md = `La velocità media è definita come:\n\n${GOOD_FORMULA}\n\nDove $s$ è lo spazio e $t$ il tempo, vedi {{formula:@vel}}.\n\n- primo punto con $x^2$\n- secondo punto\n\n### Sottotitolo\n\nUn **concetto** importante.`;
  assert.deepEqual(lint(md, { keys: ['vel'] }), []);
});

// ---- formula-malformed (F-03) ------------------------------------------------------------

test('formula-malformed: shorthand from the real defect', () => {
  const f = find(':::formula{R = F1 + F2 + … + Fn = Σᵢ Fᵢ}\n\n:::formula{a = R/m}\n', 'formula-malformed')!;
  assert.ok(f);
  assert.equal(f.severity, 'blocker');
  assert.equal(f.line, 1);
  assert.match(f.quote ?? '', /R = F1/);
  assert.equal(lint(':::formula{R = F1}\n\n:::formula{a = R/m}\n').filter((x) => x.rule === 'formula-malformed').length, 2);
});

test('formula-malformed: id= in source dialect, missing key, missing label, missing body, unclosed, glued close', () => {
  assert.ok(has(':::formula{id="3.1" label="X"}\n$$x$$\n:::', 'formula-malformed'));
  assert.ok(has(':::formula{label="X"}\n$$x$$\n:::', 'formula-malformed'));
  assert.ok(has(':::formula{key="a"}\n$$x$$\n:::', 'formula-malformed'));
  assert.ok(has(':::formula{key="a" label="A"}\nx = 1\n:::', 'formula-malformed'));
  assert.ok(has(':::formula{key="a" label="A"}\n$$\n$$\n:::', 'formula-malformed'));
  assert.ok(has('Testo.\n\n:::formula{key="a" label="A"}\n$$x$$\n\nAltro testo.', 'formula-malformed'));
  const glued = find(':::formula{key="a" label="A"}\n$$x$$\n:::$$ y $$\n', 'formula-malformed')!;
  assert.match(glued.message, /text after the closing/);
  assert.ok(has(':::formula{key="bad key!" label="A"}\n$$x$$\n:::', 'formula-malformed'));
  assert.ok(has(':::formula bare\n$$x$$\n:::', 'formula-malformed'));
});

test('formula-malformed: four colons (seen in ptt-fisica1)', () => {
  const f = find('::::formula{id="5.2" label="Forza esterna"}\n$$F$$\n:::', 'formula-malformed')!;
  assert.match(f.message, /three colons/);
  assert.equal(f.line, 1);
});

test('formula-malformed: duplicate keys; valid blocks pass', () => {
  assert.ok(has(`${GOOD_FORMULA}\n\n${GOOD_FORMULA}`, 'formula-malformed'));
  assert.ok(!has(GOOD_FORMULA, 'formula-malformed'));
  assert.ok(!has(':::formula{label="Vel" key="vel"}\n$$\nv = s/t\n$$\n:::', 'formula-malformed'));
});

// ---- meta-leak (F-04) --------------------------------------------------------------------

test('meta-leak: model commentary is flagged as blocker', () => {
  const cases = [
    '### Sintesi del lavoro svolto',
    '***### Sintesi del lavoro svolto',
    'Il testo sorgente è stato riscritto in italiano accademico.',
    'Ho riscritto il paragrafo mantenendo le formule.',
    'Ecco la versione riscritta del paragrafo:',
    'Ecco il testo rielaborato.',
    'Come richiesto, ho mantenuto tutte le formule numerate.',
    'In questa versione ho corretto gli errori del testo originale.',
    'Il paragrafo è stato riformulato per renderlo più chiaro.',
    'Here is the rewritten text:',
    'As requested, here is the revised paragraph.',
    "I have rewritten the section to keep the formulas.",
    'Note: I kept the original formulas.',
    'Questo avviene perché <!-- TODO rivedere --> la forza è costante.',
    '- Il paragrafo inizia con l\'intestazione corretta `## p3 | Idrocarburi`.',
    'Sono stati inseriti 3 blocchi formula.',
    'Il testo originale è stato rielaborato in italiano didattico per gli studenti.',
    'La formula non compare nel testo sorgente originale.',
    'Certo! Ecco la spiegazione richiesta.',
  ];
  for (const c of cases) {
    const f = find(`Una riga normale.\n\n${c}`, 'meta-leak');
    assert.ok(f, `should flag: ${c}`);
    assert.equal(f.severity, 'blocker');
    assert.equal(f.line, 3);
    assert.ok(f.quote);
  }
});

test('meta-leak: legitimate prose from physics books is not flagged', () => {
  const ok = [
    'Il lavoro svolto dal gas è definito come:',
    'Il lavoro svolto dalla **forza peso** dipende dalla differenza di quota tra i due punti considerati:',
    "Se le forze agenti sul sistema sono conservative, il lavoro svolto è pari alla diminuzione dell'energia potenziale.",
    'Ecco perché la velocità media da sola non basta a descrivere il moto.',
    'Ecco i tre casi principali, da considerare separatamente.',
    'Come richiesto dal primo principio, il calore scambiato compensa il lavoro.',
    'Il risultato, come richiesto, è 5 m/s.',
    'Il problema è stato riformulato da Lagrange in termini di energia.',
    'Riformulando il problema in forma differenziale si ottiene una equazione più semplice.',
    'Nota: la formula vale solo per piccoli angoli.',
    'Note: the formula holds for small angles only.',
    "Nel testo sorgente di un'equazione differenziale compaiono derivate; in questa versione del modello si trascurano gli attriti.",
    'Here is the formula for work in a constant field.',
    'Si può non includere il termine di attrito.',
  ];
  for (const c of ok) {
    const f = lint(c).filter((x) => x.rule === 'meta-leak');
    // "testo sorgente" is deliberately flagged: skip the one contrived sentence above.
    if (/testo sorgente/.test(c)) continue;
    assert.deepEqual(f, [], `should not flag: ${c}`);
  }
});

// ---- bold-unpaired (F-05) ----------------------------------------------------------------

test('bold-unpaired', () => {
  const f = find('Riga ok con **grassetto**.\nUn **concetto non chiuso\n', 'bold-unpaired')!;
  assert.equal(f.severity, 'major');
  assert.equal(f.line, 2);
  assert.ok(has('***', 'bold-unpaired'));
  assert.ok(has('4.**Formule inline **: Le formule intermedie...**', 'bold-unpaired'));
  assert.ok(!has('Due **negativi** e **ancora** uno ***enfasi***.', 'bold-unpaired'));
  assert.ok(!has('Con math $a**b$ non conta.', 'bold-unpaired'));
});

// ---- formula-ref-unknown (F-06) ----------------------------------------------------------

test('formula-ref-unknown: unknown key, numeric refs, link refs', () => {
  const opts = { keys: ['vel'] };
  const f = find('Come nella {{formula:@nope}} si vede.', 'formula-ref-unknown', opts)!;
  assert.equal(f.severity, 'blocker');
  assert.match(f.quote ?? '', /@nope/);
  assert.ok(has('Vedi il [formulario](ref:formula/@nope).', 'formula-ref-unknown', opts));
  assert.ok(has('Vedi la {{formula:3.60}}.', 'formula-ref-unknown', opts), 'numeric references are not source dialect');
  assert.ok(has('Vedi la {{formula:3.60}}.', 'formula-ref-unknown'), 'numeric refs are flagged even without a key set');
  assert.ok(!has('Come nella {{formula:@vel}} si vede e [qui](ref:formula/@vel).', 'formula-ref-unknown', opts));
  assert.ok(!has('Come nella {{formula:@qualsiasi}} si vede.', 'formula-ref-unknown'), 'no key set: @keys are not checked');
  assert.ok(!has(`${GOOD_FORMULA}\n\nVedi {{formula:@vel}}.`, 'formula-ref-unknown', { keys: [] }), 'keys defined in the same section count');
});

// ---- colon-dangling (F-07) ---------------------------------------------------------------

test('colon-dangling: intro ends with colon and nothing follows', () => {
  const f = find('Per un ciclo reversibile vale la disuguaglianza di Clausius:\n\nQuesta relazione si estende al caso generale.', 'colon-dangling')!;
  assert.equal(f.severity, 'major');
  assert.equal(f.line, 1);
  assert.ok(has('Il risultato è il seguente:', 'colon-dangling'), 'colon at end of section');
});

test('colon-dangling: not flagged when a formula, math, list, image or inline math line follows', () => {
  for (const next of [GOOD_FORMULA, '$$E = mc^2$$', '$$\nE = mc^2\n$$', '- punto uno\n- punto due', '1. primo\n2. secondo', ':::image{src="assets/a.png" alt="A"}\n:::', '$x = 1$', '### Sottosezione']) {
    assert.ok(!has(`Si ottiene:\n\n${next}`, 'colon-dangling'), `next: ${next}`);
  }
  assert.ok(!has('Si ottiene:\n- punto', 'colon-dangling'), 'list directly after the colon line');
  assert.ok(!has('**Esempio:**\n\nUn testo qualunque.', 'colon-dangling'), 'bold label');
  assert.ok(!has('Un rapporto come 3:\n$$x$$', 'colon-dangling'));
  assert.ok(!has('Il rapporto è 1:2 e non 2:1.', 'colon-dangling'));
});

// ---- unicode-math (F-08) -----------------------------------------------------------------

test('unicode-math: symbols and Greek letters outside $...$', () => {
  for (const c of ['La variazione Δ è piccola.', 'L\'angolo θ cresce.', 'La circuitazione ∮ è nulla.', 'Il vettore λ⃗ è fisso.', 'Il flusso ⇔ campo.', 'Vale 3×3.', 'Il punto A→B.']) {
    const f = find(c, 'unicode-math');
    assert.ok(f, c);
    assert.equal(f.severity, 'major');
    assert.equal(f.line, 1);
  }
  assert.ok(has('Se (𝑥𝑚𝑎𝑥−𝑥𝑚𝑖𝑛) > 𝜀𝑚 allora si misura ancora.', 'unicode-math'), 'math alphanumerics');
  assert.ok(has('- **ω**: pulsazione angolare', 'unicode-math'));
});

test('unicode-math: not flagged inside math, code, units or names', () => {
  assert.ok(!has('La variazione $\\Delta x$ e $Δ x$ e $$θ = 1$$ sono ok.', 'unicode-math'));
  assert.ok(!has('Una resistenza di 10 Ω e un ritardo di 5 μs.', 'unicode-math'));
  assert.ok(!has("L'α-elica e il β-carotene sono ben noti.", 'unicode-math'));
  assert.ok(!has('Perché è così: più città, né tè, 30° di inclinazione, m² e H₂O.', 'unicode-math'));
  assert.ok(!has('Nel codice `x = π` non conta.', 'unicode-math'));
});

// ---- code-fence (F-12) -------------------------------------------------------------------

test('code-fence', () => {
  const f = find('Prima.\n\n```matlab\nx = 1;\n```\n\nDopo.', 'code-fence')!;
  assert.equal(f.severity, 'blocker');
  assert.equal(f.line, 3);
  assert.ok(has('~~~\ncodice\n~~~', 'code-fence'));
  assert.ok(!has('Il comando `ls` e il carattere ` non sono fence.', 'code-fence'));
});

// ---- math-mixed (F-13) -------------------------------------------------------------------

test('math-mixed: display and inline math in one block', () => {
  const f = find('- **Coordinata $x$**: $$x(t) = R\\cos(\\theta(t))$$', 'math-mixed')!;
  assert.equal(f.severity, 'minor');
  assert.ok(has('Il lavoro vale\n$$W = \\int F dx$$\ndove $F$ è la forza.', 'math-mixed'));
  assert.ok(!has('Il lavoro vale\n\n$$W = \\int F dx$$\n\ndove $F$ è la forza.', 'math-mixed'));
  assert.ok(!has('Solo $a$ e $b$ inline.', 'math-mixed'));
  assert.ok(!has('Solo $$a = b$$ display.', 'math-mixed'));
});

// ---- katex -------------------------------------------------------------------------------

test('katex: invalid inline and display math', () => {
  const f = find('Qui $\\frac{1}{$ è rotto.', 'katex')!;
  assert.equal(f.severity, 'blocker');
  assert.equal(f.line, 1);
  assert.ok(has('Comando ignoto $\\notacommand{x}$.', 'katex'));
  const d = find('Testo\n\n$$\n\\begin{matrix} a & b\n$$', 'katex')!;
  assert.equal(d.line, 3);
  assert.ok(has(':::formula{key="a" label="A"}\n$$\\sqrt{$$\n:::', 'katex'), 'formula body');
  assert.ok(!has('Va bene $\\frac{a}{b} + \\sqrt{2}$ e $$\\int_0^1 x\\,dx$$.', 'katex'));
  assert.ok(!has('Con unità $3\\,\\text{m/s}$ e $\\mathrm{Hz}$.', 'katex'));
});

test('katex: unbalanced dollar is reported', () => {
  const f = find('Costa 5$ al chilo.', 'katex')!;
  assert.equal(f.severity, 'major');
});

// ---- heading-level -----------------------------------------------------------------------

test('heading-level: only ### inside a section', () => {
  assert.ok(has('## Titolo\n\ntesto', 'heading-level'));
  assert.ok(has('#### Profondo\n\ntesto', 'heading-level'));
  assert.ok(has('# Uno\n\ntesto', 'heading-level'));
  const p = find('## p3 | Idrocarburi\n\ntesto', 'heading-level')!;
  assert.equal(p.severity, 'blocker');
  assert.equal(find('## Titolo', 'heading-level')!.severity, 'minor');
  assert.ok(!has('### Va bene\n\ntesto', 'heading-level'));
  assert.ok(!has('Il simbolo # e #hashtag non sono titoli.', 'heading-level'));
});

// ---- image -------------------------------------------------------------------------------

test('image: alt, src prefix, extension, closing fence, markdown images', () => {
  const ok = ':::image{src="assets/fig-1.png" alt="Una figura" caption="Fig. 1"}\n:::';
  assert.ok(!has(ok, 'image'));
  assert.ok(has(':::image{src="assets/fig-1.png"}\n:::', 'image'), 'no alt');
  assert.ok(has(':::image{src="assets/fig-1.png" alt=""}\n:::', 'image'), 'empty alt');
  assert.ok(has(':::image{src="https://example.com/a.png" alt="A"}\n:::', 'image'), 'external url');
  assert.ok(has(':::image{src="fig-1.png" alt="A"}\n:::', 'image'), 'no assets/ prefix');
  assert.ok(has(':::image{src="assets/fig-1.gif" alt="A"}\n:::', 'image'), 'extension');
  assert.ok(has(':::image{src="assets/../x.png" alt="A"}\n:::', 'image'), 'path traversal');
  assert.ok(has(':::image{src="assets/a.png" alt="A"}\n\nTesto', 'image'), 'missing closing fence');
  assert.ok(has('![alt](assets/a.png)', 'image'), 'markdown image');
  assert.equal(find('![alt](http://x/a.png)', 'image')!.severity, 'blocker');
});

// ---- table -------------------------------------------------------------------------------

test('table', () => {
  const f = find('| a | b |\n|---|---|\n| 1 | 2 |', 'table')!;
  assert.equal(f.severity, 'minor');
  assert.equal(f.line, 1);
  assert.ok(has('Prima.\n\n| x | y |\n| :---: | ---: |\n| 1 | 2 |', 'table'));
  assert.ok(!has('Il segno | non è una tabella, né lo è una riga | sola |.', 'table'));
});

// ---- language-drift ----------------------------------------------------------------------

const EN_PARA = 'The average velocity of a body is defined as the ratio between the displacement and the time that is needed to cover it, and this is the first result that we will use in the rest of the chapter when we discuss motion.';
const IT_PARA = 'La velocità media di un corpo è definita come il rapporto tra lo spostamento e il tempo che è necessario per percorrerlo, e questo è il primo risultato che useremo nel resto del capitolo quando parleremo di moto.';

test('language-drift: English paragraph in an Italian book and vice versa', () => {
  const f = find(`Un paragrafo italiano normale.\n\n${EN_PARA}`, 'language-drift')!;
  assert.equal(f.severity, 'major');
  assert.equal(f.line, 3);
  assert.ok(has(IT_PARA, 'language-drift', { language: 'en' }));
  assert.ok(!has(IT_PARA, 'language-drift', { language: 'it' }));
  assert.ok(!has(EN_PARA, 'language-drift', { language: 'en' }));
  assert.ok(!has(EN_PARA, 'language-drift', { language: 'fr' }), 'unknown languages are not checked');
});

test('language-drift: conservative on short or mixed text', () => {
  assert.ok(!has('Il termine inglese "the speed of light" si traduce con velocità della luce.', 'language-drift'));
  assert.ok(!has('This is short.', 'language-drift'));
  const mixed = `${IT_PARA} Come dicono gli anglosassoni: the ratio of the displacement to the time.`;
  assert.ok(!has(mixed, 'language-drift'));
  assert.ok(!has('Il lavoro della forza $F$ lungo lo spostamento $s$ è dato da $W = F s$ e ' + 'vale per ogni percorso '.repeat(3), 'language-drift'));
});

// ---- empty-section -----------------------------------------------------------------------

test('empty-section', () => {
  assert.equal(find('', 'empty-section')!.severity, 'minor');
  assert.ok(has('   \n\n', 'empty-section'));
  assert.ok(has('### Solo un titolo', 'empty-section'));
  assert.ok(!has('Un po\' di testo.', 'empty-section'));
  assert.ok(!has(GOOD_FORMULA, 'empty-section'));
});

// ---- lintCompiled ------------------------------------------------------------------------

const CH = (extra = '') => `---\nchapter: 1\ntitle: Uno\n---\n\n## p1 | Primo\n\nTesto.\n${extra}`;

test('lintCompiled: duplicate-ide and duplicate-graph (F-09, F-10)', () => {
  const snippet = (id: string, code: string) => ({ id, title: id, language: 'python', code });
  const dup = lintCompiled({
    'chapters/01-uno.md': CH(),
    'ide.json': JSON.stringify([snippet('mrua-1', 'v = 1\nprint(v)'), snippet('mrua-2', 'v = 1\n  print(v)'), snippet('altro', 'print(3)')]),
    'grafici.json': JSON.stringify([
      { id: 'g1', title: 'G1', type: 'function', config: { functions: [{ fn: 'x', label: 'x' }], xDomain: [0, 1] } },
      { id: 'g2', title: 'G2', type: 'function', config: { xDomain: [0, 1], functions: [{ label: 'x', fn: 'x' }] } },
    ]),
  });
  const ide = dup.find((f) => f.rule === 'duplicate-ide')!;
  assert.equal(ide.severity, 'major');
  assert.match(ide.message, /mrua-1, mrua-2/);
  assert.equal(dup.find((f) => f.rule === 'duplicate-graph')!.severity, 'major');

  const clean = lintCompiled({
    'chapters/01-uno.md': CH(),
    'ide.json': JSON.stringify([snippet('a', 'print(1)'), snippet('b', 'print(2)')]),
    'grafici.json': JSON.stringify([{ id: 'g1', title: 'G1', type: 'function', config: { functions: [{ fn: 'x' }], xDomain: [0, 1] } }, { id: 'g2', title: 'G2', type: 'function', config: { functions: [{ fn: 'x^2' }], xDomain: [0, 1] } }]),
  });
  assert.deepEqual(clean.filter((f) => /duplicate/.test(f.rule)), []);
});

test('lintCompiled: runs the content rules on compiled chapters and exercises', () => {
  const bad = lintCompiled({
    'chapters/01-uno.md': CH('\nCon la {{formula:1.9}} e la [formula](ref:formula/7.7) e il [link](ref:chapter/9#p1).\n\n```\ncodice\n```\n\n### Sintesi del lavoro svolto\n\n:::image{src="assets/mancante.png" alt="X"}\n:::\n'),
    'esercizi.md': '---\ntype: esercizi\n---\n\n:::exercise{id="E1.1" chapter="1" difficulty="facile"}\n## Domanda\nCalcola $\\frac{1}{$.\n\n:::solution\nSolo **grassetto aperto\n:::\n:::\n',
  });
  const rules = new Set(bad.map((f) => f.rule));
  for (const r of ['formula-ref-unknown', 'section-ref-unknown', 'code-fence', 'meta-leak', 'image', 'katex', 'bold-unpaired']) assert.ok(rules.has(r), `expected ${r}`);
  assert.ok(bad.every((f) => f.file === 'esercizi.md' || f.file === 'chapters/01-uno.md'));

  const good = lintCompiled({
    'chapters/01-uno.md': `---\nchapter: 1\ntitle: Uno\n---\n\n## p1 | Primo\n\nVedi {{formula:1.1}}.\n\n:::formula{id="1.1" label="Eq"}\n$$a=b$$\n:::\n\n## p2 | Secondo\n\nTorna al [primo](ref:chapter/1#p1) e vedi [la formula](ref:formula/1.1).\n`,
    'esercizi.md': '---\ntype: esercizi\n---\n\n:::exercise{id="E1.1" chapter="1" difficulty="facile"}\n## Domanda\nCalcola $x$ con la {{formula:1.1}}.\n\n:::hint\nSuggerimento.\n:::\n\n:::solution\n$x=1$\n:::\n:::\n',
  });
  assert.deepEqual(good, []);
});

test('lintCompiled: empty paragraph and duplicate formula ids', () => {
  const f = lintCompiled({
    'chapters/01-uno.md': `---\nchapter: 1\ntitle: Uno\n---\n\n## p1 | Vuoto\n\n## p2 | Pieno\n\n:::formula{id="1.1" label="A"}\n$$a$$\n:::\n\n:::formula{id="1.1" label="B"}\n$$b$$\n:::\n`,
  });
  assert.ok(f.some((x) => x.rule === 'empty-section'));
  assert.ok(f.some((x) => x.rule === 'formula-malformed' && /Duplicate formula id/.test(x.message)));
});

// ---- real books ----------------------------------------------------------------------------

const CONTENT = '/tmp/politost-mono/politost-smartbook/src/content';
const haveCorpus = existsSync(`${CONTENT}/ptt-fisica1/chapters`);
const chaptersOf = (book: string) => {
  const dir = `${CONTENT}/${book}/chapters`;
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) files[`chapters/${f}`] = readFileSync(`${dir}/${f}`, 'utf8');
  return files;
};

test('real book ptt-fisica1: known defects are flagged, good prose is not', { skip: !haveCorpus }, () => {
  const findings = lintCompiled(chaptersOf('ptt-fisica1'), { integrity: false, duplicates: false });
  const by = (rule: string) => findings.filter((f) => f.rule === rule);
  // F-03: formula blocks without braces, and ":::" glued to the next block
  assert.ok(by('formula-malformed').length >= 5, 'bare :::formula lines');
  assert.ok(by('formula-malformed').some((f) => /text after the closing/.test(f.message)));
  // F-07: paragraphs ending with ":" followed by prose
  assert.ok(by('colon-dangling').some((f) => /Joule/.test(f.quote ?? '')));
  // F-08: unicode math in prose
  assert.ok(by('unicode-math').length >= 20);
  assert.ok(by('unicode-math').some((f) => /⇔/.test(f.quote ?? '')));
  // F-13: display + inline in the same block
  assert.ok(by('math-mixed').length >= 5);
  // "il lavoro svolto" is plain physics here, not model commentary
  assert.deepEqual(by('meta-leak'), []);
  // no false blockers: katex and bold are clean in this book
  assert.deepEqual(by('katex'), []);
  assert.deepEqual(by('bold-unpaired'), []);
});

test('real book chimica-organica: "Sintesi del lavoro svolto" block is flagged', { skip: !haveCorpus }, () => {
  const findings = lintCompiled(chaptersOf('chimica-organica'), { integrity: false, duplicates: false });
  const meta = findings.filter((f) => f.rule === 'meta-leak');
  assert.ok(meta.some((f) => /Sintesi del lavoro svolto/.test(f.quote ?? '')));
  assert.ok(meta.some((f) => /testo originale è stato rielaborato/.test(f.quote ?? '')));
  assert.ok(meta.every((f) => f.severity === 'blocker'));
  assert.ok(findings.some((f) => f.rule === 'bold-unpaired'), 'the "***" separator');
});

test('real book esempio has no findings', () => {
  const files: Record<string, string> = {};
  const base = new URL('./testdata/esempio/', import.meta.url).pathname;
  for (const f of readdirSync(`${base}chapters`)) files[`chapters/${f}`] = readFileSync(`${base}chapters/${f}`, 'utf8');
  files['esercizi.md'] = readFileSync(`${base}esercizi.md`, 'utf8');
  files['esami.md'] = readFileSync(`${base}esami.md`, 'utf8');
  files['ide.json'] = readFileSync(`${base}ide.json`, 'utf8');
  files['grafici.json'] = readFileSync(`${base}grafici.json`, 'utf8');
  files['assets/cosa-trovi.svg'] = 'x';
  assert.deepEqual(lintCompiled(files), []);
});
