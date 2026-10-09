import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { joinBlocks, splitBlocks, type Block } from '@smartbuilder/content/blocks';
import type { SectionView } from '@smartbuilder/domain';
import { api, errorText, isConflict } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useToast } from '../../components/Toast';

/** How long the author must stop typing before the draft is saved on its own. */
export const AUTOSAVE_MS = 3000;

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; reason: string };

export function useSection(pid: string, nodeId: string | undefined) {
  return useQuery({
    queryKey: qk.section(pid, nodeId ?? ''),
    queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId: nodeId! } }),
    enabled: !!nodeId,
  });
}

/**
 * The author's unsaved text for one block. It lives in the page (keyed by section), not in the block
 * component and not under the revision id, so a refetch never replaces it.
 * baseRevId / baseMarkdown / baseText record what the author started from (after an autosave: what was saved last).
 * span is how many blocks of the latest text baseText covers; it is above 1 once a saved draft contains blank lines.
 */
export interface Draft {
  id: number;
  index: number;
  text: string;
  baseText: string;
  baseRevId: string | null;
  baseMarkdown: string;
  span: number;
  /** Saved at least once while the editor stayed open: Save block then just closes it. */
  saved?: boolean;
}

/** Where the draft's block sits in the latest text. found=false: the block itself was changed or removed meanwhile. */
export function locateDraft(draft: Draft, latest: Block[]): { index: number; found: boolean } {
  let best = -1;
  const want = joinBlocks(splitBlocks(draft.baseText));
  latest.forEach((_, i) => {
    if (joinBlocks(latest.slice(i, i + draft.span)) === want && (best < 0 || Math.abs(i - draft.index) < Math.abs(best - draft.index))) best = i;
  });
  if (best >= 0) return { index: best, found: true };
  return { index: Math.min(draft.index, latest.length - 1), found: false };
}

/** The latest text with the draft applied: replaces the located block(s), or appends when there is none. */
export function applyDraft(latest: Block[], at: number, text: string, remove = false, span = 1): Block[] {
  const out = latest.map((b) => ({ ...b }));
  if (at >= 0 && at < out.length) {
    if (remove) out.splice(at, span); else out.splice(at, span, { ...out[at], text });
  } else if (!remove) {
    out.push({ kind: 'paragraph', text });
  }
  return out;
}

interface SaveVars { nodeId: string; markdown: string; baseRevId: string | null; draftId?: number; text?: string; auto?: boolean }

/**
 * Block-level editing on top of "PUT the whole section".
 * An edit starts from one revision. If another revision becomes the head meanwhile, the draft is kept
 * (and followed to its block in the new text); saving stays off until the author picks what to do.
 */
export function useSectionEditor(pid: string, nodeId: string, section: SectionView | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [conflict, setConflict] = useState<string | null>(null);
  const nextId = useRef(1);
  // What the author is leaving the block for; it happens once the block is saved (or found to need no saving).
  const [leave, setLeave] = useState<{ kind: 'close' } | { kind: 'open'; index: number; text: string } | null>(null);
  const failedText = useRef<string | null>(null);
  const live = useRef({ nodeId, draft: null as Draft | null, savable: false, latestBlocks: [] as Block[], saving: false });

  // Drafts are kept per section; only the transient save feedback resets when moving to another one.
  useEffect(() => { setState({ kind: 'idle' }); setConflict(null); }, [nodeId]);

  const draft: Draft | null = drafts[nodeId] ?? null;
  const currentId = section?.current?.id ?? null;
  const latestMarkdown = section?.current?.markdown ?? '';
  const latestBlocks = useMemo(() => splitBlocks(latestMarkdown), [latestMarkdown]);
  const newerHead = !!draft && !!section && draft.baseRevId !== currentId;
  // Only text the author typed needs protecting; an untouched editor just follows the new head (effect below).
  const changedElsewhere = newerHead && draft!.text !== draft!.baseText;
  const located = useMemo(() => (draft && newerHead ? locateDraft(draft, latestBlocks) : draft ? { index: draft.index, found: true } : null), [draft, newerHead, latestBlocks]);
  const editing = located && located.index >= 0 ? located.index : null;

  // Nothing typed yet: there is nothing to lose, so follow the new head silently.
  useEffect(() => {
    if (!draft || !section || !newerHead || !located || located.index < 0 || draft.text !== draft.baseText) return;
    const at = located.index;
    setDrafts((all) => {
      const d = all[nodeId];
      if (!d || d.text !== d.baseText || d.baseRevId === currentId) return all;
      const t = latestBlocks[at].text;
      return { ...all, [nodeId]: { ...d, index: at, text: t, baseText: t, baseRevId: currentId, baseMarkdown: latestMarkdown, span: 1 } };
    });
  }, [draft, section, newerHead, located, nodeId, currentId, latestBlocks, latestMarkdown]);

  const setDraft = useCallback((next: Draft | null) => {
    setDrafts((all) => {
      const copy = { ...all };
      if (next) copy[nodeId] = next; else delete copy[nodeId];
      return copy;
    });
  }, [nodeId]);

  // `draftId`, `text` and `auto` describe the draft text being saved; they are not sent. An autosave keeps the editor open.
  // The section is named in the variables because a flush can run while the page moves to another one.
  const write = useMutation({
    mutationFn: ({ nodeId: nid, markdown, baseRevId }: SaveVars) => api('PUT /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId: nid }, body: { markdown, baseRevId } }),
    onMutate: (v) => { if (v.nodeId === live.current.nodeId) setState({ kind: 'saving' }); },
    onSuccess: (sv, saved) => {
      qc.setQueryData(qk.section(pid, saved.nodeId), sv);
      void qc.invalidateQueries({ queryKey: qk.manuscript(pid) });
      void qc.invalidateQueries({ queryKey: qk.history(pid, saved.nodeId) });
      void qc.invalidateQueries({ queryKey: qk.preview(pid, sv.chapterId) });
      void qc.invalidateQueries({ queryKey: qk.issues(pid) });
      failedText.current = null;
      const here = saved.nodeId === live.current.nodeId;
      // An autosave, or text typed while the save was on its way, stays as a draft on top of the saved revision.
      // Nobody is looking at a draft of another section that is fully saved, so that one is dropped.
      setDrafts((all) => {
        const d = all[saved.nodeId];
        const copy = { ...all };
        if (d && saved.text !== undefined && d.id === saved.draftId && (saved.auto || d.text !== saved.text) && (here || d.text !== saved.text)) {
          copy[saved.nodeId] = { ...d, baseText: saved.text, baseRevId: sv.current?.id ?? null, baseMarkdown: sv.current?.markdown ?? '', span: splitBlocks(saved.text).length, saved: true };
        } else delete copy[saved.nodeId];
        return copy;
      });
      if (here) { setConflict(null); setState({ kind: 'saved' }); }
    },
    onError: (e, failed) => {
      failedText.current = failed.text ?? null;
      setLeave(null);
      if (isConflict(e)) {
        // Somebody saved first. Fetch what is current: the draft stays and the banner offers the choices.
        setConflict(errorText(e));
        setState({ kind: 'error', reason: 'the section changed since you opened it' });
        void qc.fetchQuery({ queryKey: qk.section(pid, failed.nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId: failed.nodeId } }), staleTime: 0 });
      } else {
        const t = errorText(e);
        setState({ kind: 'error', reason: t });
        if (!failed.auto) toast(`Couldn't save. ${t}`, { tone: 'danger' });
      }
    },
  });
  const { mutate } = write;

  const submit = useCallback((nid: string, d: Draft, blocks: Block[], auto: boolean) => {
    mutate({ nodeId: nid, markdown: joinBlocks(applyDraft(blocks, d.index, d.text, false, d.span)), baseRevId: d.baseRevId, draftId: d.id, text: d.text, auto });
  }, [mutate]);

  const dirty = !!draft && draft.text !== draft.baseText;
  // An empty block is a removal, which stays an explicit choice; a changed section waits for the banner.
  const savable = dirty && !!draft!.text.trim() && !changedElsewhere && !!section && draft!.index < latestBlocks.length;
  useEffect(() => { live.current = { nodeId, draft, savable, latestBlocks, saving: write.isPending }; });

  // Save about AUTOSAVE_MS after the last keystroke, never while a save is on its way, and not again for text that just failed.
  useEffect(() => {
    if (!draft || !savable || write.isPending || leave || failedText.current === draft.text) return;
    const t = setTimeout(() => submit(nodeId, draft, latestBlocks, true), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, savable, write.isPending, leave, submit, nodeId, latestBlocks]);

  // Leaving the section (or the page) saves what is typed, if it may be saved. This cleanup runs before the effect above refreshes `live`.
  useEffect(() => () => {
    const s = live.current;
    if (s.draft && s.savable && !s.saving) submit(s.nodeId, s.draft, s.latestBlocks, false);
  }, [nodeId, submit]);

  // Closing the tab cannot wait for a save: warn instead.
  const unsaved = write.isPending || Object.values(drafts).some((d) => d.text !== d.baseText);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const openAt = useCallback((index: number, blocks: Block[]) => {
    const t = blocks[index]?.text;
    if (t === undefined) return;
    setDraft({ id: nextId.current++, index, text: t, baseText: t, baseRevId: currentId, baseMarkdown: latestMarkdown, span: 1 });
  }, [currentId, latestMarkdown, setDraft]);

  // Carry out what the author asked for once their text is safe: save first when needed, then close or move on.
  useEffect(() => {
    if (!leave || write.isPending) return;
    if (draft && dirty) {
      if (savable) submit(nodeId, draft, latestBlocks, false); else setLeave(null);
      return;
    }
    setLeave(null);
    if (leave.kind === 'close') { setDraft(null); return; }
    // The saved block may have grown or shrunk, so look for the target by its text, nearest to where it was.
    let at = -1;
    latestBlocks.forEach((b, i) => { if (b.text === leave.text && (at < 0 || Math.abs(i - leave.index) < Math.abs(at - leave.index))) at = i; });
    openAt(at >= 0 ? at : Math.min(leave.index, latestBlocks.length - 1), latestBlocks);
  }, [leave, write.isPending, draft, dirty, savable, submit, nodeId, latestBlocks, openAt, setDraft]);

  const startEdit = useCallback((index: number) => {
    const blocks = splitBlocks(section?.current?.markdown ?? '');
    if (index >= blocks.length) return;
    setConflict(null);
    // Re-opening the block that already has a draft keeps that draft; another block's typed text is saved first, never dropped.
    const open = drafts[nodeId];
    if (open && located && located.index === index) return;
    if (open && open.text !== open.baseText) {
      if (savable) setLeave({ kind: 'open', index, text: blocks[index].text });
      else toast('Save or discard the block you are editing first.');
      return;
    }
    openAt(index, blocks);
  }, [section?.current?.markdown, drafts, nodeId, located, savable, openAt, toast]);

  const changeText = useCallback((text: string) => {
    setDrafts((all) => (all[nodeId] ? { ...all, [nodeId]: { ...all[nodeId], text } } : all));
  }, [nodeId]);

  /** Close the editor. Typed text is saved first when it can be; text that cannot be saved (emptied, or the section changed) is dropped as before. */
  const cancelEdit = useCallback(() => {
    if (savable) { setLeave({ kind: 'close' }); return; }
    setDraft(null); setConflict(null); if (state.kind === 'error') setState({ kind: 'idle' });
  }, [savable, setDraft, state.kind]);

  const blocked = useCallback(() => {
    setState({ kind: 'error', reason: 'the section changed while you were editing. Choose how to continue above' });
  }, []);

  /** Save the draft block and close the editor. Only while the head is the revision the edit started from. */
  const saveDraft = useCallback(() => {
    if (!draft) return;
    if (draft.text === draft.baseText) { if (draft.saved) setLeave({ kind: 'close' }); return; }
    if (changedElsewhere) { blocked(); return; }
    if (draft.index >= latestBlocks.length) return;
    submit(nodeId, draft, latestBlocks, false);
  }, [draft, changedElsewhere, latestBlocks, submit, nodeId, blocked]);

  const removeDraftBlock = useCallback(() => {
    if (!draft) return;
    if (changedElsewhere) { blocked(); return; }
    mutate({ nodeId, markdown: joinBlocks(applyDraft(latestBlocks, draft.index, '', true, draft.span)), baseRevId: draft.baseRevId });
  }, [draft, changedElsewhere, latestBlocks, mutate, blocked, nodeId]);

  /** What "Keep my version" would save: the latest text with the draft in place of its block. */
  const merged = useMemo(() => (draft && located ? joinBlocks(applyDraft(latestBlocks, located.index, draft.text, false, draft.span)) : null), [draft, located, latestBlocks]);

  /** The author chose to keep their text: save it over the latest head, read fresh at this moment. */
  const keepMine = useCallback(async () => {
    if (!draft) return;
    try {
      const fresh = await qc.fetchQuery({ queryKey: qk.section(pid, nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId } }), staleTime: 0 });
      const blocks = splitBlocks(fresh.current?.markdown ?? '');
      const at = locateDraft(draft, blocks);
      mutate({ nodeId, markdown: joinBlocks(applyDraft(blocks, at.index, draft.text, false, draft.span)), baseRevId: fresh.current?.id ?? null, draftId: draft.id, text: draft.text });
    } catch (e) { toast(errorText(e), { tone: 'danger' }); }
  }, [draft, qc, pid, nodeId, mutate, toast]);

  const discard = useCallback(() => { setDraft(null); setConflict(null); setLeave(null); setState({ kind: 'idle' }); }, [setDraft]);

  return {
    editing, draft, located, startEdit, cancelEdit, changeText, saveDraft, removeDraftBlock, state, saving: write.isPending, conflict,
    changedElsewhere, keepMine, discard, merged,
  };
}
