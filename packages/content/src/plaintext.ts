// The reader shows figure captions and alt text as plain text, so LaTeX there would appear raw.

const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ' };
const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ', k: 'ₖ', x: 'ₓ' };
const SYMBOLS: Record<string, string> = {
  to: '→', infty: '∞', cdot: '·', times: '×', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼',
  in: '∈', pm: '±', mp: '∓', Rightarrow: '⇒', iff: '⇔', forall: '∀', exists: '∃', ldots: '…', dots: '…', circ: '∘', partial: '∂',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', varepsilon: 'ε', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', varphi: 'φ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω',
};
const SETS: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' };

function script(body: string, map: Record<string, string>, mark: string) {
  const chars = [...body];
  return chars.every((c) => map[c]) ? chars.map((c) => map[c]).join('') : `${mark}${body.length > 1 ? `(${body})` : body}`;
}

function convertMath(tex: string): string {
  let s = tex;
  for (let i = 0; i < 4; i++) s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => `${/^\w+$/.test(a) ? a : `(${a})`}/${/^\w+$/.test(b) ? b : `(${b})`}`);
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)').replace(/\\mathbb\{(\w)\}/g, (_, c) => SETS[c] ?? c);
  s = s.replace(/\\(?:left|right|big|Big|bigl|bigr)\s*/g, '').replace(/\\[,;!: ]/g, ' ').replace(/\\(?:operatorname|mathrm|text)\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\([A-Za-z]+)/g, (_, cmd) => SYMBOLS[cmd] ?? cmd);
  s = s.replace(/\^\{([^{}]*)\}|\^(\S)/g, (_, a, b) => script(a ?? b, SUP, '^'));
  s = s.replace(/_\{([^{}]*)\}|_(\S)/g, (_, a, b) => script(a ?? b, SUB, '_'));
  return s.replace(/[{}]/g, '').replace(/\s*([→⇒⇔])\s*/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Turns "La funzione $\\frac{\\sin x}{x}$" into "La funzione sin x/x". Quotes become typographic so they cannot end an attribute. */
export function latexToPlain(text: string): string {
  return text
    .replace(/\$\$([\s\S]*?)\$\$|\$([^$]*)\$/g, (_, a, b) => convertMath(a ?? b))
    .replace(/"/g, '”')
    .replace(/\s+/g, ' ')
    .trim();
}
