import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseChapterMarkdown, type FormulaRef } from '@politost/content-core';
import type { SectionView } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { resolveAssetFrom } from '../../lib/assets';
import { qk, useIssues, useManuscript, useProject, useResources, useRun } from '../../lib/queries';
import { OPEN_ISSUE, blockOfIssue, mapSection } from '../../lib/blocks';
import { timeAgo } from '../../lib/format';
import { useBookId, useDocumentTitle, useMediaQuery } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { splitBlocks } from '@smartbuilder/content/blocks';
import { BlockView, type BlockEdit, type Cite } from './BlockView';
import { DiffList } from './DiffList';
import { EvidenceDrawer, IssueGroup } from './EvidenceDrawer';
import { HistoryDialog } from './HistoryDialog';
import { ProposalBanner } from './ProposalBanner';
import { RegenerateDialog } from './RegenerateDialog';
import { Rail, RailLegend } from './Rail';
import { useSection, useSectionEditor } from './useSectionEditor';
import './manuscript.css';
import './rail.css';

const RAIL_KEY = 'smartbuilder.rail';

export default function ManuscriptPage() {
  const pid = useBookId();
  const { nodeId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const ms = useManuscript(pid);
  const project = useProject(pid);
  const resources = useResources(pid);
  const issuesQ = useIssues(pid);
  const chapters = ms.data ?? [];

  const narrow = useMediaQuery('(max-width: 1099px)');
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== 'closed');
  const [railDrawer, setRailDrawer] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [regen, setRegen] = useState<{ selection?: string } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [focusNote, setFocusNote] = useState<string | undefined>();
  const [focusIdx, setFocusIdx] = useState(0);
  const blocksRef = useRef<HTMLDivElement>(null);

  // Land on a section when none is in the address.
  const flat = useMemo(() => chapters.flatMap((c) => c.sections.map((s) => ({ c, s }))), [chapters]);
  useEffect(() => {
    if (nodeId || flat.length === 0) return;
    const first = flat.find((x) => x.s.current)?.s ?? flat[0].s;
    navigate(`/books/${pid}/manuscript/${first.sectionId}${search.toString() ? `?${search}` : ''}`, { replace: true });
  }, [nodeId, flat, navigate, pid, search]);

  const loc = useMemo(() => {
    const hit = flat.find((x) => x.s.sectionId === nodeId);
    if (hit) return { chapter: hit.c, index: flat.filter((x) => x.c.chapterId === hit.c.chapterId).findIndex((x) => x.s.sectionId === nodeId) };
    const intro = chapters.find((c) => c.chapterId === nodeId);
    return intro ? { chapter: intro, index: -1 } : null;
  }, [flat, chapters, nodeId]);

  const sectionQ = useSection(pid, nodeId);
  const section: SectionView | undefined = sectionQ.data;
  const editor = useSectionEditor(pid, nodeId ?? '', section);
  useDocumentTitle(section?.title ?? 'Manuscript');

  useEffect(() => { setSel(null); setFocusIdx(0); setFocusNote(undefined); }, [nodeId]);

  const mapped = useMemo(() => (section ? mapSection(section) : null), [section]);
  const blocks = mapped?.blocks ?? [];

  // Chapter-wide formula index and figure URLs, from the compiled chapter.
  const previewQ = useQuery({
    queryKey: qk.preview(pid, loc?.chapter.chapterId ?? ''),
    queryFn: () => api('GET /api/projects/:id/chapters/:chapterId/preview', { params: { id: pid, chapterId: loc!.chapter.chapterId } }),
    enabled: !!loc && !!section?.current,
    staleTime: 30_000,
  });
  const formulaIndex = useMemo(() => {
    const m = new Map<string, FormulaRef>();
    if (previewQ.data) for (const f of parseChapterMarkdown(previewQ.data.markdown, previewQ.data.number).formulas) m.set(f.id, f);
    return m;
  }, [previewQ.data]);
  const assets = previewQ.data?.assets;
  const resolveAsset = useCallback((src: string) => resolveAssetFrom(assets, src), [assets]);

  // Evidence notes and open issues per block.
  const notesById = useMemo(() => new Map((section?.evidence?.notes ?? []).map((n, i) => [n.id, { n: i + 1, note: n }])), [section?.evidence]);
  const citesFor = (i: number): Cite[] => (section?.current?.citations?.[String(i)] ?? []).map((id) => notesById.get(id)).filter((x): x is Cite => !!x);
  const openIssues = useMemo(() => (section?.issues ?? []).filter((i) => OPEN_ISSUE.has(i.status)), [section?.issues]);
  const { byBlock, unlocated } = useMemo(() => {
    const byBlock = new Map<number, typeof openIssues>();
    const unlocated: typeof openIssues = [];
    for (const issue of openIssues) {
      const b = blockOfIssue(issue, blocks);
      if (b === null) unlocated.push(issue); else byBlock.set(b, [...(byBlock.get(b) ?? []), issue]);
    }
    return { byBlock, unlocated };
  }, [openIssues, blocks]);

  // Deep link from Review: ?issue=<id> selects the block that issue points at.
  const issueParam = search.get('issue');
  useEffect(() => {
    if (!issueParam || !section) return;
    const issue = section.issues.find((i) => i.id === issueParam);
    const b = issue ? blockOfIssue(issue, blocks) : null;
    if (b !== null) {
      setSel(b); setFocusIdx(b);
      requestAnimationFrame(() => blocksRef.current?.querySelector<HTMLElement>(`[data-block="${b}"]`)?.scrollIntoView({ block: 'center' }));
    }
  }, [issueParam, section?.sectionId, blocks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusBlock = useCallback((i: number) => {
    const n = Math.max(0, Math.min(blocks.length - 1, i));
    setFocusIdx(n);
    requestAnimationFrame(() => blocksRef.current?.querySelector<HTMLElement>(`[data-block="${n}"]`)?.focus());
  }, [blocks.length]);

  const select = useCallback((i: number, note?: string) => { setSel(i); setFocusIdx(i); setFocusNote(note); }, []);
  const closeEvidence = useCallback(() => {
    const was = sel;
    setSel(null); setFocusNote(undefined);
    if (was !== null) requestAnimationFrame(() => blocksRef.current?.querySelector<HTMLElement>(`[data-block="${was}"]`)?.focus());
  }, [sel]);

  const { startEdit: beginEdit, cancelEdit, editing: editingIdx, draft, changeText, saveDraft, removeDraftBlock, saving } = editor;
  const startEdit = useCallback((i: number) => { setFocusIdx(i); beginEdit(i); }, [beginEdit]);
  const endEdit = useCallback(() => {
    const was = editingIdx;
    cancelEdit();
    if (was !== null) requestAnimationFrame(() => blocksRef.current?.querySelector<HTMLElement>(`[data-block="${was}"]`)?.focus());
  }, [cancelEdit, editingIdx]);
  const onRegenerate = useCallback((i: number) => setRegen({ selection: blocks[i]?.source }), [blocks]);
  const [compareOpen, setCompareOpen] = useState(false);
  const blockedEdit = editor.changedElsewhere;
  const editProps = useMemo<BlockEdit | undefined>(() => (draft ? {
    text: draft.text, baseText: draft.baseText, saving, blocked: blockedEdit,
    onChange: changeText, onSave: saveDraft, onDelete: removeDraftBlock, onCancel: endEdit,
  } : undefined), [draft, saving, blockedEdit, changeText, saveDraft, removeDraftBlock, endEdit]);

  // Return focus to the block after a save closes the editor.
  const wasEditing = useRef<number | null>(null);
  useEffect(() => {
    if (wasEditing.current !== null && editor.editing === null) {
      const i = wasEditing.current;
      requestAnimationFrame(() => blocksRef.current?.querySelector<HTMLElement>(`[data-block="${i}"]`)?.focus());
    }
    wasEditing.current = editor.editing;
  }, [editor.editing]);

  const setSectionData = (sv: SectionView) => {
    qc.setQueryData(qk.section(pid, nodeId!), sv);
    void qc.invalidateQueries({ queryKey: qk.manuscript(pid) });
    void qc.invalidateQueries({ queryKey: qk.preview(pid, sv.chapterId) });
    void qc.invalidateQueries({ queryKey: qk.issues(pid) });
  };

  const draftSection = useMutation({
    mutationFn: () => api('POST /api/projects/:id/runs', { params: { id: pid }, body: { kind: 'generate', scope: { nodeIds: [nodeId!] } } }),
    onSuccess: () => { toast('Drafting started', { action: { label: 'Open run', to: `/books/${pid}/run` } }); void qc.invalidateQueries({ queryKey: qk.project(pid) }); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  // Which sections are being drafted right now: running task labels that name the section.
  const activeRun = project.data?.activeRun;
  const runDetail = useRun(activeRun && (activeRun.kind === 'generate' || activeRun.kind === 'regenerate') ? activeRun.id : undefined);
  const draftingTitles = useMemo(() => {
    const running = (runDetail.data?.tasks ?? []).filter((t) => t.state === 'running').map((t) => t.label.toLowerCase());
    return flat.map((x) => x.s.title.toLowerCase()).filter((t) => running.some((l) => l.includes(t)));
  }, [runDetail.data, flat]);

  const toggleRail = () => { const next = !railOpen; setRailOpen(next); localStorage.setItem(RAIL_KEY, next ? 'open' : 'closed'); };
  const selBlock = sel !== null ? blocks[sel] : undefined;

  if (ms.isLoading) return <div className="ms-empty"><div className="ui-skeleton" style={{ height: 200, width: 'min(640px, 90%)' }} /></div>;
  if (ms.error) return <div className="ms-empty"><div className="ui-banner ui-banner--danger" role="alert">{errorText(ms.error)}</div></div>;
  if (chapters.length === 0) {
    return (
      <div className="ms-empty">
        <div className="ui-empty">
          <p className="ui-empty__text">The manuscript fills in once an outline exists. Approve the outline, then drafting writes each section here.</p>
          <Link className="ui-btn ui-btn--primary" to={`/books/${pid}/outline`}>Open outline</Link>
        </div>
      </div>
    );
  }

  const rail = <Rail pid={pid} chapters={chapters} currentId={nodeId} draftingTitles={draftingTitles} onNavigate={() => setRailDrawer(false)} />;
  const saveText = editor.state.kind === 'saving' ? 'Saving…' : editor.state.kind === 'saved' ? 'Saved' : editor.state.kind === 'error' ? `Couldn't save — ${editor.state.reason}` : '';
  const rev = section?.current;
  const title = mapped?.heading?.title ?? section?.title ?? '';

  return (
    <div className={`ms-root${railOpen ? '' : ' rail-closed'}${sel !== null ? ' has-evidence' : ''}`}>
      {!narrow && (
        <aside className="ms-rail" aria-label="Outline">
          <div className="ms-rail__head">
            {railOpen && <span className="ui-meta">Outline</span>}
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label={railOpen ? 'Collapse outline' : 'Expand outline'} aria-expanded={railOpen} onClick={toggleRail}><Icon name="panel-left" /></button>
          </div>
          {railOpen && <><div className="ms-rail__scroll">{rail}</div><RailLegend /></>}
        </aside>
      )}

      <div className="ms-center">
        <div className="ms-toolbar">
          {narrow && <button type="button" className="ui-btn ui-btn--sm" onClick={() => setRailDrawer(true)}><Icon name="list" />Outline</button>}
          <span className="ms-crumb ui-muted">{loc ? `Chapter ${loc.chapter.number}${loc.index >= 0 ? ` · Section ${loc.chapter.number}.${loc.index + 1}` : ' · Introduction'}` : ''}</span>
          <span className="ui-grow" />
          <Link className="ui-btn ui-btn--sm" aria-label="Reader preview" title="Reader preview" to={`/books/${pid}/preview/${loc?.chapter.chapterId ?? ''}`}><Icon name="eye" /><span className="ms-tb-label">Reader preview</span></Link>
          <button type="button" className="ui-btn ui-btn--sm" aria-label="History" title="History" onClick={() => setHistoryOpen(true)} disabled={!nodeId}><Icon name="history" /><span className="ms-tb-label">History</span></button>
          <button type="button" className="ui-btn ui-btn--sm" aria-label="Regenerate section" title="Regenerate section" onClick={() => setRegen({})} disabled={!section?.current}><Icon name="sparkle" /><span className="ms-tb-label">Regenerate section</span></button>
        </div>

        {sectionQ.isLoading && <div className="ms-sheet"><div className="ui-skeleton" style={{ height: 36, width: '60%' }} /><div className="ui-skeleton" style={{ height: 220, marginTop: 24 }} /></div>}
        {sectionQ.error && <div className="ms-sheet"><div className="ui-banner ui-banner--danger" role="alert">{errorText(sectionQ.error)}</div></div>}

        {section && (
          <article className="ms-sheet" aria-labelledby="ms-title">
            <header className="ms-sheet__head">
              <div className="ms-sheet__titles">
                <h1 id="ms-title" className="ms-title">{mapped?.heading && <span className="ms-title__id ui-mono">{mapped.heading.id}</span>}{title}</h1>
                <p className="ms-meta ui-muted">
                  {rev ? <>{rev.origin === 'human' ? 'Edited by you' : rev.origin === 'repair' ? 'Repaired' : 'Written by AI'}{rev.model ? ` (${rev.model})` : ''} · {timeAgo(rev.createdAt)}</> : 'Not drafted yet'}
                </p>
              </div>
              <div className={`ms-save${editor.state.kind === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">{saveText}</div>
            </header>

            {section.proposal && <ProposalBanner key={section.proposal.id} pid={pid} nodeId={nodeId!} section={section} onResolved={setSectionData} />}

            {draft && editor.changedElsewhere && (
              <div className="ui-banner ui-banner--warning ms-banner" role="alert">
                <div className="ui-banner__body">
                  <span className="ui-banner__title">The section changed while you were editing</span>
                  <span>
                    Your unsaved text is still in the editor and nothing was overwritten.{' '}
                    {editor.located?.found === false
                      ? 'The block you were editing was changed as well, so keeping your version replaces the block now at that position.'
                      : 'Keeping your version saves your block into the latest text and keeps the other changes.'}
                    {editor.conflict ? ` ${editor.conflict}` : ''}
                  </span>
                  <div className="ui-banner__actions">
                    <button type="button" className="ui-btn ui-btn--sm" onClick={() => setCompareOpen(true)}>Compare</button>
                    <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => void editor.keepMine()} disabled={editor.saving}>Keep my version (save over latest)</button>
                    <button type="button" className="ui-btn ui-btn--sm" onClick={editor.discard} disabled={editor.saving}>Discard my draft</button>
                  </div>
                </div>
              </div>
            )}
            {mapped && !mapped.aligned && blocks.length > 0 && (
              <div className="ui-banner ui-banner--warning ms-banner"><span>The compiled text has a different number of blocks than the source, so some blocks show the source dialect. Numbers and references update after the next compile.</span></div>
            )}
            {unlocated.length > 0 && (
              <details className="ms-unloc ms-banner" open>
                <summary>{unlocated.length} open {unlocated.length === 1 ? 'issue' : 'issues'} on this section as a whole</summary>
                <IssueGroup title="Issues" pid={pid} issues={unlocated} />
              </details>
            )}

            {!section.current && (
              <div className="ui-empty ms-nodraft">
                <p className="ui-empty__text">This section has no text yet. Drafting writes it from your sources and cites the pages it used.</p>
                <button type="button" className="ui-btn ui-btn--primary" onClick={() => draftSection.mutate()} disabled={draftSection.isPending}>Draft this section</button>
              </div>
            )}

            {blocks.length > 0 && (
              <>
                <p className="ms-keys ui-muted"><span className="ui-kbd">↑</span> <span className="ui-kbd">↓</span> move between blocks · <span className="ui-kbd">Space</span> evidence · <span className="ui-kbd">Enter</span> edit</p>
                <div className="ms-blocks" role="list" aria-label="Section blocks" ref={blocksRef}>
                  {blocks.map((b) => (
                    <BlockView
                      // The edited block keeps its identity (the draft id) when blocks shift around it, and no key
                      // contains the revision id, so a newer revision never remounts the editor.
                      key={editingIdx === b.index && draft ? `edit-${draft.id}` : `block-${b.index}`}
                      block={b}
                      total={blocks.length}
                      chapterNumber={loc?.chapter.number ?? 0}
                      formulaIndex={formulaIndex}
                      resolveAsset={resolveAsset}
                      cites={citesFor(b.index)}
                      issues={byBlock.get(b.index)?.length ?? 0}
                      selected={sel === b.index}
                      tabbable={focusIdx === b.index}
                      edit={editingIdx === b.index ? editProps : undefined}
                      onSelect={select}
                      onEdit={startEdit}
                      onRegenerate={onRegenerate}
                      onFocusBlock={focusBlock}
                    />
                  ))}
                </div>
              </>
            )}
          </article>
        )}
      </div>

      {section && selBlock && (
        <div className="ms-ev">
          <EvidenceDrawer
            pid={pid}
            section={section}
            block={selBlock}
            notes={citesFor(selBlock.index)}
            issues={byBlock.get(selBlock.index) ?? []}
            resources={resources.data ?? []}
            focusNote={focusNote}
            onClose={closeEvidence}
            onEdit={startEdit}
          />
        </div>
      )}

      {narrow && (
        <Dialog open={railDrawer} onClose={() => setRailDrawer(false)} title="Outline" variant="drawer-left" className="ms-rail-dialog">
          {rail}
          <RailLegend />
        </Dialog>
      )}
      {draft && section && (
        <Dialog open={compareOpen} onClose={() => setCompareOpen(false)} title="Compare your draft with the latest text" variant="wide" footer={<button type="button" className="ui-btn" onClick={() => setCompareOpen(false)}>Close</button>}>
          <h3 className="ui-meta">Changed since you started editing</h3>
          <DiffList before={splitBlocks(draft.baseMarkdown).map((b) => b.text)} after={blocks.map((b) => b.source)} mode="inline" />
          <h3 className="ui-meta">What keeping your version would change in the latest text</h3>
          <DiffList before={blocks.map((b) => b.source)} after={splitBlocks(editor.merged ?? '').map((b) => b.text)} mode="inline" />
        </Dialog>
      )}
      {nodeId && <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} pid={pid} nodeId={nodeId} currentId={section?.current?.id ?? null} onRestored={setSectionData} />}
      {nodeId && <RegenerateDialog open={!!regen} onClose={() => setRegen(null)} pid={pid} nodeId={nodeId} selection={regen?.selection} label={regen?.selection ? 'Regenerate selection' : 'Regenerate section'} />}
    </div>
  );
}
