// Minimal HTML -> Markdown for course pages: title, h1-h3 as headings, paragraphs, list items, tables as rows.
// No DOM library: pages are only read, never rendered, so a forgiving tag scanner is enough.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Eacute: 'É', deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', le: '≤', ge: '≥', ne: '≠',
  infin: '∞', rarr: '→', larr: '←', rArr: '⇒', hArr: '⇔', forall: '∀', exist: '∃', isin: '∈', sum: '∑', radic: '√', copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; } catch { return m; }
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'head'];
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'ul', 'ol', 'table', 'thead', 'tbody', 'figure', 'figcaption', 'blockquote', 'pre', 'dl', 'dt', 'dd', 'address', 'details', 'summary', 'hr']);

function dropElements(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP) {
    // Non-greedy; nested same-name elements (rare for these tags) are removed pass by pass.
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');
    for (let i = 0; i < 4; i++) {
      const next = out.replace(re, ' ');
      if (next === out) break;
      out = next;
    }
  }
  return out;
}

export function htmlTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function htmlToMarkdown(html: string): { title: string; markdown: string } {
  const title = htmlTitle(html);
  let body = html;
  // Prefer the main content area when the page marks one.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(html);
  if (main) body = main[2];
  else {
    const b = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
    if (b) body = b[1];
  }
  body = dropElements(body);

  const out: string[] = [];
  let line = '';
  let heading = 0;
  let pre = 0;
  let listDepth = 0;
  const listKinds: ('ul' | 'ol')[] = [];
  const counters: number[] = [];
  let liPending = '';

  const flush = () => {
    let t = pre ? line.replace(/\s+$/g, '') : line.replace(/\s+/g, ' ').trim();
    line = '';
    if (!t) return;
    if (heading) t = '#'.repeat(heading) + ' ' + t;
    else if (liPending) t = liPending + t;
    liPending = '';
    out.push(t);
  };
  const para = () => { flush(); if (out.length && out[out.length - 1] !== '') out.push(''); };

  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[4] !== undefined) { line += pre ? decodeEntities(m[4]) : decodeEntities(m[4]).replace(/\s+/g, ' '); continue; }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      para();
      heading = closing ? 0 : Math.min(3, Number(tag[1]));
      if (closing) heading = 0;
      continue;
    }
    if (tag === 'br') { flush(); continue; }
    if (tag === 'li') {
      flush();
      if (!closing) {
        const kind = listKinds[listKinds.length - 1] ?? 'ul';
        if (kind === 'ol') counters[counters.length - 1] = (counters[counters.length - 1] ?? 0) + 1;
        liPending = '  '.repeat(Math.max(0, listDepth - 1)) + (kind === 'ol' ? `${counters[counters.length - 1]}. ` : '- ');
      }
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      if (closing) { listDepth = Math.max(0, listDepth - 1); listKinds.pop(); counters.pop(); if (!listDepth) para(); }
      else { listDepth++; listKinds.push(tag); counters.push(0); }
      continue;
    }
    if (tag === 'pre') { flush(); pre += closing ? -1 : 1; if (pre < 0) pre = 0; if (closing) { flush(); } continue; }
    if (tag === 'tr') { flush(); continue; }
    if (tag === 'td' || tag === 'th') { if (!closing) line += line.trim() ? ' | ' : ''; continue; }
    if (BLOCK.has(tag)) { if (listDepth) flush(); else para(); }
  }
  flush();
  let markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const hasH1 = /^# /m.test(markdown);
  if (title && !hasH1) markdown = `# ${title}\n\n${markdown}`;
  return { title: title || (/^# (.+)$/m.exec(markdown)?.[1] ?? ''), markdown };
}
