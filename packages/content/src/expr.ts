import { parse } from 'mathjs';
import type { MathNode } from 'mathjs';

/**
 * Whitelisted evaluation of math expressions with mathjs. The expression is parsed to an AST and
 * every node is checked before anything is compiled: no assignments, no function definitions,
 * no symbols other than the allowed variables plus e and pi.
 */

export const ALLOWED_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'exp', 'log', 'log10', 'log2', 'sqrt', 'abs', 'sign', 'floor', 'ceil', 'round', 'cbrt',
]);
const ALLOWED_OPS = new Set(['+', '-', '*', '/', '^']);
const CONSTANT_SYMBOLS = new Set(['e', 'pi']);
const MAX_LENGTH = 400;
const MAX_NODES = 300;

export type CompiledExpr = { ok: true; evaluate: (scope: Record<string, number>) => number } | { ok: false; error: string };

function check(node: MathNode, vars: ReadonlySet<string>, state: { nodes: number }): string | null {
  if (++state.nodes > MAX_NODES) return 'expression is too large';
  switch (node.type) {
    case 'ConstantNode': {
      const v = (node as unknown as { value: unknown }).value;
      return typeof v === 'number' && Number.isFinite(v) ? null : 'only numeric constants are allowed';
    }
    case 'SymbolNode': {
      const name = (node as unknown as { name: string }).name;
      return vars.has(name) || CONSTANT_SYMBOLS.has(name) ? null : `symbol "${name}" is not allowed (allowed: ${[...vars, ...CONSTANT_SYMBOLS].join(', ')})`;
    }
    case 'ParenthesisNode':
      return check((node as unknown as { content: MathNode }).content, vars, state);
    case 'OperatorNode': {
      const n = node as unknown as { op: string; args: MathNode[]; implicit?: boolean };
      if (!ALLOWED_OPS.has(n.op)) return `operator "${n.op}" is not allowed`;
      if (n.args.length < 1 || n.args.length > 2) return `operator "${n.op}" has a bad number of operands`;
      for (const a of n.args) {
        const e = check(a, vars, state);
        if (e) return e;
      }
      return null;
    }
    case 'FunctionNode': {
      const n = node as unknown as { fn: MathNode; args: MathNode[] };
      const fnName = n.fn.type === 'SymbolNode' ? (n.fn as unknown as { name: string }).name : null;
      if (!fnName || !ALLOWED_FUNCTIONS.has(fnName)) return `function "${fnName ?? '?'}" is not allowed`;
      if (n.args.length < 1 || n.args.length > (fnName === 'log' ? 2 : 1)) return `function ${fnName} has a bad number of arguments`;
      for (const a of n.args) {
        const e = check(a, vars, state);
        if (e) return e;
      }
      return null;
    }
    default:
      return `${node.type} is not allowed`;
  }
}

export function compileExpr(expr: string, variables: readonly string[] = ['x']): CompiledExpr {
  if (typeof expr !== 'string' || !expr.trim()) return { ok: false, error: 'expression is empty' };
  if (expr.length > MAX_LENGTH) return { ok: false, error: `expression is longer than ${MAX_LENGTH} characters` };
  let node: MathNode;
  try {
    node = parse(expr);
  } catch (e) {
    return { ok: false, error: `cannot parse: ${(e as Error).message}` };
  }
  const err = check(node, new Set(variables), { nodes: 0 });
  if (err) return { ok: false, error: err };
  let code;
  try {
    code = node.compile();
  } catch (e) {
    return { ok: false, error: `cannot compile: ${(e as Error).message}` };
  }
  return {
    ok: true,
    evaluate: (scope) => {
      try {
        const r: unknown = code.evaluate({ ...scope });
        return typeof r === 'number' ? r : Number.NaN;
      } catch {
        return Number.NaN;
      }
    },
  };
}
