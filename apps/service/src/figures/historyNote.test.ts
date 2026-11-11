import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Asset } from '@smartbuilder/domain';
import { figureNote } from './historyNote.ts';

const drawing = (filename: string, source: string) => ({
  filename, origin: 'generated-svg', caption: 'Un cerchio', alt: 'Cerchio',
  spec: { kind: 'drawing', engine: 'typst', source, shows: 'A circle.', family: 'circuit', symbols: 'american' },
}) as unknown as Asset;
const block = (filename: string) => `:::image{src="assets/${filename}" caption="Un cerchio"}\n:::\n`;

describe('figureNote', () => {
  it('names a redraw that gave back the same source, because the task still says it was one', () => {
    const assets = new Map([['a.svg', drawing('a.svg', '#circle()')], ['b.svg', drawing('b.svg', '#circle()')]]);
    assert.equal(figureNote(block('a.svg'), block('b.svg'), assets, { origin: 'ai', instruction: 'Make it bigger' }), 'Figure "Un cerchio": redrawn: "Make it bigger"');
    assert.equal(figureNote(block('a.svg'), block('b.svg'), assets, { origin: 'human', instruction: null }), null);
  });
});
