// Adapted from politost-smartbook (AGPL-3.0)
import { renderFormulaLatex, sanitizeHtml, type FormulaRef } from '@politost/content-core';

/** A numbered display formula: math centred, number chip right, label below. */
export function Formula({ formula }: { formula: FormulaRef }) {
  return (
    <div className="sb-formula" data-formula-id={formula.id}>
      <div
        className="sb-formula-math"
        tabIndex={0}
        role="group"
        aria-label={`Formula ${formula.id}: ${formula.label}`}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderFormulaLatex(formula.latex)) }}
      />
      <span className="sb-formula-num">({formula.id})</span>
      {formula.label && <div className="sb-formula-label">{formula.label}</div>}
    </div>
  );
}
