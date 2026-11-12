import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dropUnpairedBold, katexError, lintCompiled, lintQuestionText, lintSection, stripDifficultyDecoration } from './lint.ts';
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

// ---- placeholders --------------------------------------------------------------------------

test('placeholder: a [?] or ??? a model left in prose or math is a blocker', () => {
  for (const c of [
    'È per questo che $[?]$ si misura tramite $q_p$.',
    'Si ottiene $\\lbrack ?\\rbrack$ come risultato.',
    '$$\nq = [?]\n$$',
    'Il valore è ??? kJ.',
  ]) {
    const f = find(`Testo.\n\n${c}`, 'placeholder');
    assert.ok(f, c);
    assert.equal(f!.severity, 'blocker', c);
  }
  assert.equal(find('Un intervallo $[0,1]$ e una domanda: vale davvero?', 'placeholder'), undefined);
  assert.equal(find('MATLAB rispondeva con `??? Undefined function` a un nome sbagliato.', 'placeholder'), undefined, 'inline code is not content');
  assert.equal(lint('Valori: $[?]$ e $[?]$, poi ???.').filter((f) => f.rule === 'placeholder').length, 3, 'one finding per placeholder, so adding one on the same line counts');
});

// ---- literal \n and \t -------------------------------------------------------------------

test('literal-escape: a backslash-n or backslash-t in prose is a blocker, in math and code it is not', () => {
  // The two rows the exam reader stored for the July session of the acceptance run.
  for (const c of [
    "Un amplificatore ha $R_1 = 3{,}3\\,\\mathrm{k\\Omega}$.\\n\\na) Calcolare il guadagno $G$.\\n\\nb) Calcolare $v_{out}$.",
    "**Problema 1.\\n\\na) $G = -R_2/R_1 = -10$.\\n\\nb) $v_{out} = -2{,}5\\,\\mathrm{V}$.**",
    '### Problema 2.\\n\\na) $\\tau = RC = 22\\,\\mathrm{ms}$.',
    'Colonna uno\\tcolonna due.',
    '- primo punto\\n- secondo punto',
    'Il valore \\ntrovato \\text{vero}.',
  ]) {
    const f = find(c, 'literal-escape');
    assert.ok(f, c);
    assert.equal(f!.severity, 'blocker', c);
  }
  for (const c of [
    'Con $\\nu = 2$ e $\\neq$, poi $\\theta \\times \\tau$.',
    '$$\n\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0}\n$$',
    'In MATLAB `fprintf("%d\\n", x)` stampa e va a capo.',
    'Righe a capo vere.\n\na) Calcolare.',
    'Il valore $x$ è \\text{vero} e \\tau è la costante.',
  ]) assert.equal(find(c, 'literal-escape'), undefined, c);
});

test('literal-escape: question text is linted too, which is what the export validates', () => {
  const f = lintQuestionText('Un resistore $R = 1\\,\\mathrm{k\\Omega}$.\\n\\na) Calcolare $I$.', { file: 'statement', language: 'it' }).find((x) => x.rule === 'literal-escape');
  assert.equal(f?.severity, 'blocker');
});

// ---- meta-leak (F-04) --------------------------------------------------------------------

test('meta-leak: a sentence that tells the reader what the author\'s notes contain is a blocker', () => {
  for (const c of [
    // Both sentences are from the first section of the acceptance run.
    "Questo segue da $v_C = -R\\,i$, ed è un risultato standard non riportato nelle note.",
    "Questi valori sono conseguenze elementari dell'esponenziale e non sono riportati come tali nelle note.",
    'La formula vale in generale, ma non è presente negli appunti del corso.',
    'Il risultato non è contenuto nel materiale fornito.',
    'Qui si usa il materiale fornito per ricavare la costante.',
    "Secondo l'evidenza fornita la costante vale 3.",
    'This result is standard and not covered in the notes.',
    'The provided material does not state the value of the constant.',
    'As the supplied notes say, the time constant is RC.',
    "The result isn't covered in the notes.",
    "This value wasn't mentioned in the provided material.",
    'The formula does not appear in the course notes, so it is only stated.',
  ]) {
    const f = find(`Testo.\n\n${c}`, 'meta-leak');
    assert.ok(f, c);
    assert.equal(f!.severity, 'blocker', c);
    assert.match(f!.message, /sources/);
  }
  for (const c of [
    'Le note musicali di un diapason hanno una frequenza precisa.',
    'Come indicato nelle note a piè di pagina del manuale, il valore cambia.',
    'Il materiale del condensatore è ceramico, e il materiale isolante tra le armature è il dielettrico.',
    'Le fonti di tensione ideali non hanno resistenza interna.',
    'La corrente è riportata nella figura e presente nel ramo centrale.',
    'The notes of a scale follow a geometric progression in frequency.',
    'An ideal source supplies a fixed voltage.',
    // Electrical engineering: the sources are circuit elements, not the author's material.
    'La potenza fornita dalle fonti di tensione è $P$.',
    'La corrente fornita dalle sorgenti indipendenti è $I$.',
    'La tensione presente ai capi dei generatori è $V$.',
    'La potenza contenuta nelle fonti di alimentazione a disposizione è $P$.',
    'La corrente riportata dai generatori ideali dalle fonti di corrente è costante.',
    'Il campo elettrico non è presente nel materiale conduttore.',
    'The power delivered by the voltage sources is $P$.',
    "The ripple isn't included in the sources of the supply.",
  ]) assert.equal(find(`Testo.\n\n${c}`, 'meta-leak'), undefined, c);
});

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

test('meta-leak: generator markup is a blocker on any line', () => {
  const f = find('Le successioni monotone limitate.</markdown>\n</invoke>', 'meta-leak');
  assert.equal(f?.severity, 'blocker');
  assert.equal(f?.line, 1);
  assert.match(f!.message, /"<\/markdown>"/);
  assert.equal(lint('Riga.\n\n</invoke>').filter((x) => x.rule === 'meta-leak')[0]?.line, 3);
  assert.equal(has('Per $a<b$ vale <i>sempre</i>.', 'meta-leak'), false);
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
  // Exam statements list their parts as "a) ...", "(b) ..." or "1) ...".
  for (const next of ['a) Calcolare la forza.\n\nb) Calcolare la velocità.', '(a) Calcolare la forza.', '1) Calcolare la forza.']) {
    assert.ok(!has(`Supponendo che $\\theta = 30^\\circ$:\n\n${next}`, 'colon-dangling'), `next: ${next}`);
  }
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

test('difficulty decoration at the start of a line is flagged and stripped, bold and bullets are not touched', () => {
  const lint = (s: string) => lintQuestionText(s, { file: 'statement', language: 'it' }).filter((f) => f.rule === 'difficulty-decoration');
  for (const bad of ['(**) Calcolare il limite.', '★★ Calcolare il limite.', '(facile) Calcolare.', '[Difficile] Calcolare.', 'Difficoltà: ★★★ Calcolare.', '** Calcolare.', '- (*) Calcolare.']) {
    assert.equal(lint(bad).length, 1, bad);
  }
  for (const ok of ['**Esercizio 2.** Calcolare.', '* Calcolare il limite.', '- Una funzione facile da derivare.', 'Il metodo è (facile) da usare.', '1. Calcolare $2*3$.']) {
    assert.equal(lint(ok).length, 0, ok);
  }
  assert.equal(stripDifficultyDecoration('(**) Calcolare il limite.\n\n- ★★ a) primo\n* b) secondo\n**Nota.** resta'), 'Calcolare il limite.\n\n- a) primo\n* b) secondo\n**Nota.** resta');
  assert.equal(stripDifficultyDecoration('(facile): Sia $f(x)=1$.'), 'Sia $f(x)=1$.');
});

test('stripDifficultyDecoration leaves the lines of a display formula alone', () => {
  const tag = '$$\n(*)\\quad x = 1\n$$';
  assert.equal(stripDifficultyDecoration(tag), tag);
  assert.equal(stripDifficultyDecoration(`(*) Calcolare.\n\n${tag}`), `Calcolare.\n\n${tag}`);
});

test('dropUnpairedBold reads a bare carriage return as a line break and does not throw', () => {
  assert.equal(dropUnpairedBold('Prima\rTesto **aperto'), 'Prima\nTesto aperto');
});

test('dropUnpairedBold removes the last ** of a line with an odd count, outside math and code, and leaves paired bold alone', () => {
  assert.equal(dropUnpairedBold('Un **termine** e un altro** qui.'), 'Un **termine** e un altro qui.');
  const untouched = 'Riga **ok**.\n\n$a**b$ e `x**y` e **ok**';
  assert.equal(dropUnpairedBold(untouched), untouched);
  const fixed = dropUnpairedBold('Testo **aperto');
  assert.deepEqual(lintSection(fixed, { sectionId: 's', language: 'it' }).filter((f) => f.rule === 'bold-unpaired'), []);
});

test('katex: an unclosed $$ is a blocker that names the line it opens on', () => {
  const f = find('Prima riga.\n\nSegue $$ x^2 + y\n\nAltro testo.\n\nUltimo.', 'katex')!;
  assert.ok(f);
  assert.equal(f.severity, 'blocker');
  assert.equal(f.line, 3);
  assert.match(f.message, /\$\$/);
  assert.ok(!has('Prima.\n\n$$\nx^2\n$$\n\nDopo.', 'katex'), 'a paired multi-line $$ is fine');
});

test('katex: a stray $$ before a formula block is the one reported, whatever the formula looks like', () => {
  const block = (body: string) => `Testo $$ x^2 + y\n\n:::formula{key="zz" label="Z"}\n${body}\n:::\n\nDopo.`;
  for (const body of ['$$z = 1$$', '$$\nz = 1\n$$']) {
    const f = find(block(body), 'katex')!;
    assert.ok(f, body);
    assert.equal(f.line, 1, `the stray $$ is on line 1 (${JSON.stringify(body)})`);
    assert.match(f.message, /opens in block 1 never ends/);
  }
  const last = find(':::formula{key="zz" label="Z"}\n$$\nz = 1\n$$\n:::\n\nUltima riga $$ x', 'katex')!;
  assert.equal(last.line, 7);
  assert.ok(!has('Prima.\n\n:::formula{key="zz" label="Z"}\n$$\nz = 1\n$$\n:::\n\nDopo.', 'katex'), 'no stray $$, no finding');
});

// ---- tables as KaTeX arrays, matrices and units -------------------------------------------------

const TRUTH_TABLE = '$$\n\\begin{array}{cc|c}\nA & B & A \\cdot B \\\\\n\\hline\n0 & 0 & 0 \\\\\n0 & 1 & 0 \\\\\n1 & 0 & 0 \\\\\n1 & 1 & 1\n\\end{array}\n$$';

test('a truth table written as a KaTeX array passes lint and compiles in KaTeX; a Markdown table is still reported', () => {
  assert.deepEqual(lint(`La porta AND ha questa tabella di verità:\n\n${TRUTH_TABLE}\n\nL'uscita vale 1 solo se entrambi gli ingressi valgono 1.`), []);
  assert.equal(katexError(TRUTH_TABLE.replace(/^\$\$\n|\n\$\$$/g, ''), true), null);
  assert.ok(has('| A | B |\n|---|---|\n| 0 | 1 |', 'table'));
});

test('pmatrix, bmatrix and a small table of values pass lint', () => {
  const md = [
    '$$\n\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\n$$',
    '$$\n\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}\n$$',
    '$$\n\\begin{array}{c|ccc}\nx & 0 & 1 & 2 \\\\\n\\hline\nf(x) & 1 & 2 & 5\n\\end{array}\n$$',
  ].join('\n\n');
  assert.deepEqual(lint(md), []);
});

test('units: a symbol after a number, with or without an SI prefix, is fine in prose; a bare symbol is not', () => {
  for (const ok of ['Una resistenza di 10 Ω.', 'Una resistenza di 4,7 kΩ e 2 mΩ.', 'Una di 10kΩ e 3 MΩ.', 'Un ritardo di 5 μs e 3 µF.']) assert.ok(!has(ok, 'unicode-math'), ok);
  for (const bad of ['La resistenza si misura in kΩ.', 'La pulsazione ω vale 2.', 'Vale 5 nF con ω = 2.']) assert.ok(has(bad, 'unicode-math'), bad);
  for (const ok of ['Vale $10\\,\\mathrm{k\\Omega}$.', 'Vale $5\\,\\mathrm{m/s}$ e $2\\,\\mu\\mathrm{F}$.']) assert.deepEqual(lint(ok), [], ok);
});

// ---- unclosed $$ names the block, not a line of the whole section ---------------------------

test('unclosed $$ in a section names its block, and the line inside it only when the block has several', () => {
  const one = find('Primo paragrafo.\n\nSegue $$ x^2 + y\n\nTerzo paragrafo.', 'katex')!;
  assert.match(one.message, /^Unclosed "\$\$": the display math that opens in block 2 never ends/);
  assert.doesNotMatch(one.message, /line/);
  assert.equal(one.line, 3, 'the finding still points at the line, for the editor to locate the block');

  const several = find('Primo paragrafo.\n\nSecondo paragrafo\ncon $$ x^2 + y\nancora testo.', 'katex')!;
  assert.match(several.message, /opens in block 2, on line 2 of that block,/);
});

test('unclosed $$ in a question keeps naming the line of its text', () => {
  const f = lintQuestionText('Calcolare\n$$ x^2 + y', { file: 'q1', language: 'it' }).find((x) => x.rule === 'katex' && /Unclosed/.test(x.message))!;
  assert.match(f.message, /opened on line 2/);
});
