// Adapted from politost-smartbook (AGPL-3.0)
import { useId, useState } from 'react';
import { renderFormulaLatex, sanitizeHtml, type FormulaRef } from '@politost/content-core';

interface FormulaTooltipProps {
  formulaId: string;
  formulas: Map<string, FormulaRef>;
}

/** Inline reference "(2.1)" that previews the formula on hover or focus. */
export function FormulaTooltip({ formulaId, formulas }: FormulaTooltipProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const popId = useId();
  const visible = hover || focus;
  const formula = formulas.get(formulaId);

  if (!formula) return <span className="formula-missing">({formulaId})</span>;

  return (
    <span className="sb-fref" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        className="sb-fref-chip formula-hover-trigger"
        aria-describedby={visible ? popId : undefined}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
      >
        ({formula.id})
      </button>
      {visible && (
        <span className="sb-fref-pop" id={popId} role="tooltip">
          <span className="sb-fref-pop-head"><b>({formula.id})</b><span>{formula.label}</span></span>
          <span className="sb-fref-pop-math" dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderFormulaLatex(formula.latex)) }} />
        </span>
      )}
    </span>
  );
}
