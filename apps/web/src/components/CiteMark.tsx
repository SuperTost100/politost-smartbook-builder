/** Raised "(3)" in mono: the proofreader's citation mark. Readable at 12px, unlike Unicode superscripts. */
export function CiteMark({ n }: { n: number }) {
  return (
    <span className="cite-mark" aria-hidden="true">
      <span>(</span><span>{n}</span><span>)</span>
    </span>
  );
}
