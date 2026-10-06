/**
 * Copied from politost-smartbook src/lib/safeMathExpr.ts (AGPL-3.0).
 * This is the evaluator the reader uses for the "function" graphs in grafici.json, so graph
 * checks run against exactly what readers will see. Keep it in sync with the reader.
 */
/** Evaluate simple math expressions without `new Function` or `eval`. */

const EXPR_CHARS = /^[0-9x+\-*/().^ \t]+$/;

type Value = number | number[];

const MATH_FNS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  max: Math.max,
  min: Math.min,
  sign: Math.sign,
  pow: Math.pow,
};

type Tok =
  | { k: 'num'; v: number }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'eof' };

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i += 1;
      continue;
    }
    if (c === '*' && input[i + 1] === '*') {
      out.push({ k: 'op', v: '**' });
      i += 2;
      continue;
    }
    if ('+-*/()[],.'.includes(c)) {
      out.push({ k: 'op', v: c });
      i += 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && input[i + 1] >= '0' && input[i + 1] <= '9')) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(input.slice(i));
      if (!m) throw new Error('Numero non valido');
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      const m = /^[A-Za-z_]\w*/.exec(input.slice(i));
      if (!m) throw new Error('Identificatore non valido');
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error('Caratteri non consentiti');
  }
  out.push({ k: 'eof' });
  return out;
}

function parseArithmetic(input: string, scope: Record<string, Value>): Value {
  const tokens = tokenize(input);
  let i = 0;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];

  function parseExpr(): Value {
    let left = parseTerm();
    for (;;) {
      const tok = peek();
      if (tok.k !== 'op' || (tok.v !== '+' && tok.v !== '-')) break;
      eat();
      const right = asNumber(parseTerm());
      left = tok.v === '+' ? asNumber(left) + right : asNumber(left) - right;
    }
    return left;
  }

  function parseTerm(): Value {
    let left = parsePower();
    for (;;) {
      const tok = peek();
      if (tok.k !== 'op' || (tok.v !== '*' && tok.v !== '/')) break;
      eat();
      const right = asNumber(parsePower());
      left = tok.v === '*' ? asNumber(left) * right : asNumber(left) / right;
    }
    return left;
  }

  function parsePower(): Value {
    const base = parseUnary();
    const tok = peek();
    if (tok.k === 'op' && tok.v === '**') {
      eat();
      return asNumber(base) ** asNumber(parsePower());
    }
    return base;
  }

  function parseUnary(): Value {
    const tok = peek();
    if (tok.k === 'op' && (tok.v === '-' || tok.v === '+')) {
      eat();
      const value = asNumber(parseUnary());
      return tok.v === '-' ? -value : value;
    }
    return parsePrimary();
  }

  function parsePrimary(): Value {
    const tok = eat();
    if (tok.k === 'num') return tok.v;
    if (tok.k === 'op' && tok.v === '(') {
      const value = parseExpr();
      const close = peek();
      if (close.k !== 'op' || close.v !== ')') throw new Error('Parentesi mancante');
      eat();
      return value;
    }
    if (tok.k === 'op' && tok.v === '[') return parseArray();
    if (tok.k === 'id') return parseIdent(tok.v);
    throw new Error('Espressione non valida');
  }

  function parseArray(): number[] {
    const values: number[] = [];
    const close = peek();
    if (close.k === 'op' && close.v === ']') {
      eat();
      return values;
    }
    values.push(asNumber(parseExpr()));
    for (;;) {
      const comma = peek();
      if (comma.k !== 'op' || comma.v !== ',') break;
      eat();
      values.push(asNumber(parseExpr()));
    }
    const end = peek();
    if (end.k !== 'op' || end.v !== ']') throw new Error('Array non valido');
    eat();
    return values;
  }

  function parseIdent(name: string): Value {
    if (name === 'Math') return parseMath();
    if (!Object.prototype.hasOwnProperty.call(scope, name)) {
      throw new Error(`Identificatore non consentito: ${name}`);
    }
    return scope[name];
  }

  function parseMath(): number {
    const dot = peek();
    if (dot.k !== 'op' || dot.v !== '.') throw new Error('Identificatore non consentito: Math');
    eat();
    const member = eat();
    if (member.k !== 'id') throw new Error('Identificatore non consentito: Math');
    if (member.v === 'PI') return Math.PI;
    if (member.v === 'E') return Math.E;
    const fn = MATH_FNS[member.v];
    if (!fn) throw new Error(`Identificatore non consentito: Math.${member.v}`);
    const open = peek();
    if (open.k !== 'op' || open.v !== '(') throw new Error('Chiamata non valida');
    eat();
    const args: number[] = [];
    const maybeClose = peek();
    if (!(maybeClose.k === 'op' && maybeClose.v === ')')) {
      args.push(asNumber(parseExpr()));
      for (;;) {
        const comma = peek();
        if (comma.k !== 'op' || comma.v !== ',') break;
        eat();
        args.push(asNumber(parseExpr()));
      }
    }
    const close = peek();
    if (close.k !== 'op' || close.v !== ')') throw new Error('Parentesi mancante');
    eat();
    return fn(...args);
  }

  const value = parseExpr();
  if (peek().k !== 'eof') throw new Error('Espressione non valida');
  return value;
}

function asNumber(value: Value): number {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error('Valore non numerico');
  return value;
}

export function evalExprAtX(expr: string, x: number): number {
  const trimmed = expr.trim();
  if (!trimmed || !EXPR_CHARS.test(trimmed)) return NaN;

  const js = trimmed.replace(/\^/g, '**').replace(/\bx\b/g, `(${x})`);
  try {
    const result = parseArithmetic(js, {});
    return typeof result === 'number' && Number.isFinite(result) ? result : NaN;
  } catch {
    return NaN;
  }
}

const FORBIDDEN_JS = /[;{}\[\]`$\\@#&|=<>!?:'"]/;
const FORBIDDEN_WORDS =
  /\b(function|return|new|this|window|global|import|eval|constructor|prototype|process)\b/i;

/** Guard transpiled MATLAB-like JS before scoped evaluation. */
export function assertSafeArithmeticJs(js: string): void {
  if (js.length > 500) throw new Error('Espressione troppo lunga');
  if (FORBIDDEN_JS.test(js)) throw new Error('Caratteri non consentiti');
  if (FORBIDDEN_WORDS.test(js)) throw new Error('Espressione non consentita');
}

export function evalScopedArithmeticJs(
  js: string,
  scope: Record<string, number | number[]>,
): number | number[] {
  assertSafeArithmeticJs(js);
  const names: Record<string, Value> = { ...scope };
  if (!Object.prototype.hasOwnProperty.call(names, 'Infinity')) names.Infinity = Infinity;
  return parseArithmetic(js, names);
}
