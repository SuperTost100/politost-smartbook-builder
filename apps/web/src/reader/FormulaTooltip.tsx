// Adapted from politost-smartbook (AGPL-3.0)
import { useState } from 'react';
import { renderFormulaLatex, sanitizeHtml, type FormulaRef } from '@politost/content-core';

interface FormulaTooltipProps {
  formulaId: string;
  formulas: Map<string, FormulaRef>;
  children?: React.ReactNode;
}

export function FormulaTooltip({ formulaId, formulas, children }: FormulaTooltipProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const visible = hover || focus;
  const formula = formulas.get(formulaId);

  if (!formula) return <span className="formula-missing">({formulaId})</span>;

  return (
    <span className="formula-hover-wrapper" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        className="formula-hover-trigger"
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {children ?? `(${formulaId})`}
      </button>
      {visible && (
        <div className="formula-tooltip" role="tooltip">
          <div className="formula-tooltip-header">
            <strong>({formula.id})</strong> — {formula.label}
          </div>
          <div className="formula-tooltip-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderFormulaLatex(formula.latex)) }} />
        </div>
      )}
    </span>
  );
}
