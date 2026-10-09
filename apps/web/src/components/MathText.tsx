import { useMemo } from 'react';
import { renderInlineFragment } from '@politost/content-core';

/** One line of model text (a review note, a quote) with its $..$ and $$..$$ math rendered, as the reader would. */
export function MathText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderInlineFragment(text), [text]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
