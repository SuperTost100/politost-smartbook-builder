import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useMatch, useNavigate } from 'react-router-dom';
import { Icon, Logo } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { Dialog } from '../../components/Dialog';
import { useServiceEvents } from '../../lib/events';
import { useIssues, useProject, useProjects } from '../../lib/queries';
import { runPill } from '../../lib/format';
import { useTheme } from '../../lib/theme';
import { RunView } from '../run/RunView';
import './shell.css';

const TABS = [
  { to: 'sources', label: 'Sources' },
  { to: 'outline', label: 'Outline' },
  { to: 'manuscript', label: 'Manuscript' },
  { to: 'practice', label: 'Practice' },
  { to: 'extras', label: 'Extras' },
  { to: 'review', label: 'Review' },
  { to: 'export', label: 'Export' },
] as const;

export function Shell() {
  const match = useMatch('/books/:id/*');
  const bookId = match?.params.id;
  const stream = useServiceEvents(bookId);

  return (
    <>
      <a className="sh-skip" href="#main">Skip to content</a>
      <TopBar bookId={bookId} stream={stream} />
      <main id="main" className="sh-main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

function TopBar({ bookId, stream }: { bookId?: string; stream: string }) {
  const [theme, toggleTheme] = useTheme();
  const project = useProject(bookId);
  const projects = useProjects();
  const issues = useIssues(bookId);
  const [runOpen, setRunOpen] = useState(false);
  const navigate = useNavigate();
  const pill = runPill(project.data?.activeRun ?? null);
  const bar = useRef<HTMLElement>(null);
  // Sticky panes elsewhere position themselves under the bar, whose height changes when the tabs wrap.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--bar-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const openIssues = (issues.data ?? []).filter((i) => i.status === 'open').length;

  return (
    <header className="sh-bar" ref={bar}>
      <Link to="/" className="sh-brand" aria-label="PoliTost Smart Builder, all books">
        <Logo size={28} />
        <span className="sh-brand__word">Smart Builder</span>
      </Link>

      {bookId && (
        <Menu
          label="Switch book"
          buttonClass="sh-switch" rootClass="sh-menu"
          button={<><span className="sh-switch__title">{project.data?.title ?? 'Loading…'}</span><Icon name="chevron-down" size={14} /></>}
        >
          {(close) => (
            <>
              {(projects.data ?? []).filter((p) => !p.archivedAt).map((p) => (
                <button key={p.id} type="button" role="menuitem" className="ui-menu__item" aria-current={p.id === bookId} onClick={() => { close(); navigate(`/books/${p.id}/sources`); }}>
                  <span className="ui-wrap">{p.title}</span>
                </button>
              ))}
              <div className="ui-menu__sep" />
              <button type="button" role="menuitem" className="ui-menu__item" onClick={() => { close(); navigate('/'); }}>All books</button>
              <button type="button" role="menuitem" className="ui-menu__item" onClick={() => { close(); navigate('/new'); }}>New book</button>
              <button type="button" role="menuitem" className="ui-menu__item" onClick={() => { close(); navigate(`/books/${bookId}/settings`); }}>Book setup</button>
            </>
          )}
        </Menu>
      )}

      {bookId && (
        <div className="sh-tabs-row">
          <nav className="sh-tabs" aria-label="Book sections">
            {TABS.map((t) => (
              <NavLink key={t.to} to={`/books/${bookId}/${t.to}`} className="sh-tab">
                {t.label}
                {t.to === 'review' && openIssues > 0 && <span className="sh-tab__count" aria-label={`${openIssues} open issues`}>{openIssues}</span>}
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      <div className="sh-right">
        {stream === 'reconnecting' && <span className="sh-offline" role="status">Reconnecting…</span>}
        {bookId && (
          <button type="button" className={`sh-pill sh-pill--${pill.tone}`} onClick={() => setRunOpen(true)} aria-haspopup="dialog">
            <span className="sh-pill__dot" aria-hidden="true" />
            <span aria-live="polite" aria-atomic="true" className="sh-pill__text">{pill.text}</span>
            <span className="ui-sr">. Open run panel</span>
          </button>
        )}
        <NavLink to="/connections" className="ui-btn ui-btn--sm sh-conn" aria-label="Connections">
          <Icon name="plug" /><span className="sh-conn__label">Connections</span>
        </NavLink>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>

      {bookId && (
        <Dialog open={runOpen} onClose={() => setRunOpen(false)} title="Run" variant="drawer" className="sh-run-dialog">
          <RunView projectId={bookId} />
          <Link to={`/books/${bookId}/run`} className="ui-btn ui-btn--link" onClick={() => setRunOpen(false)}>Open as a page</Link>
        </Dialog>
      )}
    </header>
  );
}
