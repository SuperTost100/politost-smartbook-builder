import katex from 'katex';

export interface MathError { tex: string; message: string }

/** Finds LaTeX the reader would fail to render, so the editor can say so in plain words. */
export function findMathErrors(text: string): MathError[] {
  const found: MathError[] = [];
  const check = (tex: string, display: boolean) => {
    const t = tex.trim();
    if (!t) return;
    try {
      katex.renderToString(t, { displayMode: display, throwOnError: true });
    } catch (e) {
      const msg = (e as Error).message.replace(/^KaTeX parse error:\s*/, '');
      found.push({ tex: t.length > 60 ? `${t.slice(0, 57)}…` : t, message: msg });
    }
  };
  const rest = text
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, t: string) => { check(t, true); return ' '; })
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, t: string) => { check(t, true); return ' '; })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, t: string) => { check(t, false); return ' '; });
  rest.replace(/\$([^$\n]+)\$/g, (_, t: string) => { check(t, false); return ' '; });
  // An odd number of $ left over means a formula was never closed.
  const dollars = (rest.replace(/\$([^$\n]+)\$/g, '').match(/\$/g) ?? []).length;
  if (dollars % 2 === 1) found.push({ tex: '$', message: 'A $ is not closed.' });
  return found.slice(0, 5);
}
