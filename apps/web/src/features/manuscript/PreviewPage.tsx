import { useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { preprocessContent } from '@politost/content-core';
import { api, errorText } from '../../lib/api';
import { qk, useManuscript } from '../../lib/queries';
import { resolveAssetFrom } from '../../lib/assets';
import { useBookId, useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { ContentFlow } from '../../reader/ContentFlow';
import { parseCompiledChapter } from '../../reader/render';
import './manuscript.css';

/** Whole chapter as the reader shows it: serif prose, numbered formulas, figures from the compiled assets. */
export default function PreviewPage() {
  const pid = useBookId();
  const { chapterId } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const ms = useManuscript(pid);
  const chapters = ms.data ?? [];
  const idx = chapters.findIndex((c) => c.chapterId === chapterId);
  const chapter = chapters[idx];
  useDocumentTitle(chapter ? `Preview: ${chapter.title}` : 'Reader preview');

  const q = useQuery({ queryKey: qk.preview(pid, chapterId ?? ''), queryFn: () => api('GET /api/projects/:id/chapters/:chapterId/preview', { params: { id: pid, chapterId: chapterId! } }), enabled: !!chapterId });
  const parsed = useMemo(() => (q.data ? parseCompiledChapter(q.data.markdown, q.data.number) : null), [q.data]);
  const assets = q.data?.assets;

  // A section link in the text is a button carrying "chapter/<number>#p<n>". Same chapter: scroll to it. Another chapter: open it at that section.
  const onRefClick = (e: React.MouseEvent) => {
    const ref = (e.target as HTMLElement).closest<HTMLElement>('[data-ref]')?.dataset.ref;
    const m = ref ? /^chapter\/(\d+)#(p\d+)$/.exec(ref) : null;
    const target = m ? chapters.find((c) => c.number === Number(m[1])) : undefined;
    if (!m || !target) return;
    if (target.chapterId === chapterId) document.getElementById(m[2])?.scrollIntoView();
    else navigate(`/books/${pid}/preview/${target.chapterId}#${m[2]}`);
  };
  // Opening a chapter at a section: the text is there only once it has loaded.
  useEffect(() => { if (parsed && hash) document.getElementById(hash.slice(1))?.scrollIntoView(); }, [parsed, hash]);

  const first = chapter?.sections[0]?.sectionId;
  const prev = chapters[idx - 1];
  const next = chapters[idx + 1];

  return (
    <div className="ui-page ui-page--wide">
      <div className="ui-page__head">
        <div>
          <div className="ui-meta">Reader preview</div>
        </div>
        <div className="ui-page__actions">
          <Link className="ui-btn" to={`/books/${pid}/manuscript/${first ?? ''}`}><Icon name="edit" />Back to editing</Link>
        </div>
      </div>

      {q.isLoading && <div className="ui-skeleton" style={{ height: 300, width: '100%', maxWidth: 'calc(var(--reading-width) + 2 * var(--space-12))', margin: '0 auto' }} />}
      {q.error && <div className="ui-banner ui-banner--danger" role="alert">{errorText(q.error)}</div>}

      {parsed && (
        <article className="reader-preview" aria-label="Chapter as in the reader">
          <header className="sb-chhead">
            <span className="sb-eyebrow">Capitolo {q.data!.number}</span>
            <h1>{chapter?.title}</h1>
          </header>
          {parsed.chapter.paragraphs.length === 0 && <p className="ui-muted">This chapter has no compiled text yet.</p>}
          {parsed.chapter.paragraphs.map((para) => (
            <section key={para.id} id={para.id} className="paragraph-section">
              <h2 className="sb-phead"><span className="sb-phead-num">{para.id}</span><span>{para.title}</span></h2>
              <div className="paragraph-body">
                <ContentFlow content={preprocessContent(para.content)} formulaIndex={parsed.index} resolveAsset={(src) => resolveAssetFrom(assets, src)} onRefClick={onRefClick} />
              </div>
            </section>
          ))}
        </article>
      )}

      <nav className="ui-row" style={{ justifyContent: 'space-between', maxWidth: 'calc(var(--reading-width) + 2 * var(--space-12))', width: '100%', margin: '0 auto' }} aria-label="Chapters">
        {prev ? <button type="button" className="ui-btn" onClick={() => navigate(`/books/${pid}/preview/${prev.chapterId}`)}>← Cap. {prev.number}</button> : <span />}
        {next ? <button type="button" className="ui-btn" onClick={() => navigate(`/books/${pid}/preview/${next.chapterId}`)}>Cap. {next.number} →</button> : <span />}
      </nav>
    </div>
  );
}
