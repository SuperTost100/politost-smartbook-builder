import type { Asset, ReviewIssue } from '@smartbuilder/domain';

/**
 * The figure a review issue is about. An issue does not name its figure: it carries the section and a quote, and for a
 * figure the quote or the message usually holds the file name from the image block, or the caption or alt text the
 * reviewer read. So the figure is the one of the section whose file name, caption or alt text the issue mentions.
 * Without such a mention it is the section's only figure, and with several candidates it is none, because a wrong
 * thumbnail would send the author to the wrong drawing.
 */
export function figureOfIssue(issue: Pick<ReviewIssue, 'category' | 'nodeId' | 'quote' | 'message'>, assets: Asset[]): Asset | null {
  if (issue.category !== 'figure' || !issue.nodeId) return null;
  const own = assets.filter((a) => a.nodeId === issue.nodeId && a.mime.startsWith('image/'));
  if (own.length === 0) return null;
  const text = `${issue.quote}\n${issue.message}`.toLowerCase();
  // An image block writes the file as .svg whatever the stored type is, so the stem is compared.
  const mentioned = (a: Asset) => {
    const stem = a.filename.replace(/\.[^.]+$/, '').toLowerCase();
    return text.includes(a.filename.toLowerCase()) || (stem.length >= 3 && text.includes(`assets/${stem}.`))
      || [a.caption, a.alt].some((s) => s.trim().length >= 8 && text.includes(s.trim().toLowerCase()));
  };
  const hits = own.filter(mentioned);
  if (hits.length === 1) return hits[0];
  return hits.length === 0 && own.length === 1 ? own[0] : null;
}
