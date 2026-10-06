import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChapterView } from '@smartbuilder/domain';
import { Icon } from '../../components/Icon';
import { STATUS_LABEL, sectionStatus, type SectionStatus } from './status';

export function StatusGlyph({ status }: { status: SectionStatus }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true as const, focusable: false as const };
  switch (status) {
    case 'not-started':
      return <svg {...common} className="rl-glyph rl-glyph--none"><circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" /></svg>;
    case 'drafting':
      return <svg {...common} className="rl-glyph rl-glyph--drafting"><circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="1.8" /><path d="M7 1.8a5.2 5.2 0 0 1 5.2 5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
    case 'drafted':
      return <svg {...common} className="rl-glyph rl-glyph--done"><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M4.3 7.2l1.9 1.9 3.5-3.7" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case 'issues':
      return <svg {...common} className="rl-glyph rl-glyph--issue"><path d="M7 1.2l6 11H1z" fill="currentColor" /><path d="M7 5.3v3.2M7 10.2v.1" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" /></svg>;
    case 'proposal':
      return <svg {...common} className="rl-glyph rl-glyph--proposal"><path d="M7 .9l1.7 4.4L13.1 7 8.7 8.7 7 13.1 5.3 8.7.9 7l4.4-1.7z" fill="currentColor" /></svg>;
  }
}

interface Props {
  pid: string;
  chapters: ChapterView[];
  currentId: string | undefined;
  draftingTitles: string[];
  onNavigate?: () => void;
}

/** Chapters and sections. Arrow keys move between rows; Left/Right collapse and expand chapters. */
export function Rail({ pid, chapters, currentId, draftingTitles, onNavigate }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const root = useRef<HTMLElement>(null);

  const currentChapter = useMemo(() => chapters.find((c) => c.sections.some((s) => s.sectionId === currentId) || c.chapterId === currentId)?.chapterId, [chapters, currentId]);
  useEffect(() => { if (currentChapter) setCollapsed((s) => { if (!s.has(currentChapter)) return s; const n = new Set(s); n.delete(currentChapter); return n; }); }, [currentChapter]);

  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-rail-item]') ?? [])];
  const onKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const go = (n: number) => { e.preventDefault(); list[Math.max(0, Math.min(list.length - 1, n))]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const el = list[i];
      const chap = el.dataset.chapter;
      if (!chap) return;
      const isHead = el.dataset.railItem === 'chapter';
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (isHead) setCollapsed((s) => new Set(s).add(chap));
        else list.find((x) => x.dataset.railItem === 'chapter' && x.dataset.chapter === chap)?.focus();
      } else if (isHead) {
        e.preventDefault();
        if (collapsed.has(chap)) setCollapsed((s) => { const n = new Set(s); n.delete(chap); return n; });
        else go(i + 1);
      }
    }
  };

  const dr = new Set(draftingTitles);
  return (
    <nav ref={root} className="rl-nav" aria-label="Manuscript outline" onKeyDown={onKey}>
      <ul className="rl-chapters">
        {chapters.map((c) => {
          const open = !collapsed.has(c.chapterId);
          return (
            <li key={c.chapterId} className="rl-chapter">
              <button
                type="button"
                className="rl-chapter__head"
                data-rail-item="chapter"
                data-chapter={c.chapterId}
                aria-expanded={open}
                onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(c.chapterId)) n.delete(c.chapterId); else n.add(c.chapterId); return n; })}
              >
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                <span className="rl-chapter__num ui-mono">{c.number}</span>
                <span className="rl-chapter__title ui-wrap">{c.title}</span>
              </button>
              {open && (
                <ul className="rl-sections">
                  {c.intro && (
                    <li>
                      <Link className="rl-section" data-rail-item="section" data-chapter={c.chapterId} to={`/books/${pid}/manuscript/${c.chapterId}`} aria-current={currentId === c.chapterId ? 'page' : undefined} onClick={onNavigate}>
                        <StatusGlyph status="drafted" /><span className="ui-wrap">Introduction</span>
                      </Link>
                    </li>
                  )}
                  {c.sections.map((s, i) => {
                    const st = sectionStatus(s, dr.has(s.title.toLowerCase()));
                    return (
                      <li key={s.sectionId}>
                        <Link className="rl-section" data-rail-item="section" data-chapter={c.chapterId} to={`/books/${pid}/manuscript/${s.sectionId}`} aria-current={currentId === s.sectionId ? 'page' : undefined} onClick={onNavigate}>
                          <StatusGlyph status={st} />
                          <span className="ui-wrap"><span className="ui-mono rl-section__num">{c.number}.{i + 1}</span> {s.title}</span>
                          <span className="ui-sr">, {STATUS_LABEL[st]}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function RailLegend() {
  const all: SectionStatus[] = ['not-started', 'drafting', 'drafted', 'issues', 'proposal'];
  return (
    <ul className="rl-legend" aria-label="Status legend">
      {all.map((s) => <li key={s}><StatusGlyph status={s} />{STATUS_LABEL[s]}</li>)}
    </ul>
  );
}
