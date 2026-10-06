import type { Enrichment, Question } from '@smartbuilder/domain';
import type { BookInput } from './types.ts';

/** Builders shared by the tests. Not part of the public API. */

export function question(p: Partial<Question> & Pick<Question, 'id' | 'kind'>): Question {
  return {
    projectId: 'p1',
    origin: 'authentic',
    resourceId: null,
    pageFrom: null,
    pageTo: null,
    examGroup: null,
    examDate: null,
    number: null,
    statement: 'Calcola la velocità media.',
    hint: 'Usa la formula.',
    solution: 'Risultato: $v = 5\\,\\text{m/s}$.',
    difficulty: 'medio',
    topicIds: [],
    chapterId: null,
    status: 'verified',
    checks: [],
    rev: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...p,
  };
}

export function enrichment(p: Partial<Enrichment> & Pick<Enrichment, 'id' | 'kind' | 'nodeId' | 'payload'>): Enrichment {
  return { projectId: 'p1', status: 'verified', checks: [], createdAt: '2026-01-01T00:00:00Z', ...p };
}

export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#eee"/></svg>',
);

export const SEC_VEL = `La **velocità media** è il rapporto tra spazio e tempo, come anticipato dalla {{formula:@intro-eq}}.

:::formula{key="vel-media" label="Velocità media"}
$$v = \\frac{s}{t}$$
:::

Con la {{formula:@vel-media}} si ottiene subito il risultato. Torna all'[introduzione](ref:section/ch-cin) se serve.

:::image{src="assets/fig-vel.svg" alt="Spazio in funzione del tempo" caption="Fig. 1.1 — Moto uniforme"}
:::

### Un caso particolare

Se il moto è uniforme la velocità è costante.`;

export const SEC_ACC = `L'**accelerazione media** vale

:::formula{key="acc-media" label="Accelerazione media"}
$$a = \\frac{\\Delta v}{\\Delta t}$$
:::

Si veda il [paragrafo sulla velocità](ref:section/sec-vel) e il [paragrafo sul lavoro](ref:section/sec-lavoro). La {{formula:@lavoro}} ne è una conseguenza, e anche la [formula della velocità](ref:formula/@vel-media).`;

export const SEC_LAVORO = `Il **lavoro** di una forza costante è

:::formula{key="lavoro" label="Lavoro"}
$$W = F \\, s \\cos\\theta$$
:::

Dalla {{formula:@lavoro}} segue che con $\\theta = 90^\\circ$ il lavoro è nullo. Per la velocità vedi [la formula](ref:formula/@vel-media) e il [capitolo precedente](ref:section/sec-acc).`;

export function fixtureBook(overrides: Partial<BookInput> = {}): BookInput {
  return {
    meta: { slug: 'fisica-demo', title: 'Fisica demo', subject: 'Fisica', authors: ['Ada Rossi'], language: 'it', version: '0.1.0' },
    chapters: [
      {
        id: 'ch-cin',
        slug: 'cinematica',
        number: 1,
        title: 'Cinematica',
        intro: `In questo capitolo studiamo il moto.\n\n:::formula{key="intro-eq" label="Spostamento"}\n$$s = v t$$\n:::\n\nLa relazione {{formula:@intro-eq}} vale per il moto uniforme.`,
        sections: [
          { id: 'sec-vel', title: 'Velocità', markdown: SEC_VEL },
          { id: 'sec-acc', title: 'Accelerazione', markdown: SEC_ACC },
        ],
      },
      {
        id: 'ch-din',
        slug: 'dinamica',
        number: 2,
        title: 'Dinamica',
        intro: '',
        sections: [{ id: 'sec-lavoro', title: 'Lavoro', markdown: SEC_LAVORO }],
      },
    ],
    questions: [
      question({ id: 'q-b', kind: 'exercise', chapterId: 'ch-cin', origin: 'generated', statement: 'Un corpo percorre $s = 10\\,\\text{m}$ in $t = 2\\,\\text{s}$. Calcola $v$.', hint: 'Usa la {{formula:@vel-media}}.', solution: '$v = 5\\,\\text{m/s}$', difficulty: 'facile' }),
      question({ id: 'q-a', kind: 'exercise', chapterId: 'ch-cin', statement: 'Calcola l\'accelerazione media.' }),
      question({ id: 'q-c', kind: 'exercise', chapterId: 'ch-din', difficulty: 'difficile', statement: 'Calcola il lavoro per $F = 3\\,\\text{N}$ e $s = 2\\,\\text{m}$.' }),
      question({ id: 'x-1', kind: 'exam', chapterId: 'ch-din', examGroup: 'Esame del 25 gennaio 2023 - turno 1', examDate: '2023-01-25', number: '1', statement: 'Esercizio 1. Calcola il lavoro.', solution: 'Vedi la {{formula:@lavoro}}.' }),
      question({ id: 'x-2', kind: 'exam', chapterId: 'ch-cin', origin: 'generated', statement: 'Un treno percorre 120 km in 2 ore. Calcola la velocità media.' }),
    ],
    enrichments: [
      enrichment({ id: 'e1', kind: 'ide', nodeId: 'sec-vel', payload: { id: 'vel', title: 'Velocità media', language: 'python', code: 's = 10\nt = 2\nprint(s / t)', description: 'Calcolo' } }),
      enrichment({ id: 'e2', kind: 'graph', nodeId: 'sec-acc', payload: { id: 'parabola', title: 'Moto accelerato', type: 'function', config: { functions: [{ fn: '0.5*2*x^2', label: 's(t)' }], xDomain: [0, 4], yDomain: [0, 10], xLabel: 't', yLabel: 's' } } }),
    ],
    assets: [{ filename: 'fig-vel.svg', bytes: SVG }],
    sections: { esercizi: true, esami: true, ide: true, grafici: true },
    ...overrides,
  };
}
