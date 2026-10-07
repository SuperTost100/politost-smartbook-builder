import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { joinBlocks, splitBlocks, type Block } from '@smartbuilder/content/blocks';
import type { SectionView } from '@smartbuilder/domain';
import { api, errorText, isConflict } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useToast } from '../../components/Toast';

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
 * baseRevId / baseMarkdown / baseText record what the author started from.
 */
export interface Draft {
  id: number;
  index: number;
  text: string;
  baseText: string;
  baseRevId: string | null;
  baseMarkdown: string;
}

/** Where the draft's block sits in the latest text. found=false: the block itself was changed or removed meanwhile. */
export function locateDraft(draft: Draft, latest: Block[]): { index: number; found: boolean } {
  let best = -1;
  latest.forEach((b, i) => {
    if (b.text === draft.baseText && (best < 0 || Math.abs(i - draft.index) < Math.abs(best - draft.index))) best = i;
  });
  if (best >= 0) return { index: best, found: true };
  return { index: Math.min(draft.index, latest.length - 1), found: false };
}

/** The latest text with the draft applied: replaces the located block, or appends when there is none. */
export function applyDraft(latest: Block[], at: number, text: string, remove = false): Block[] {
  const out = latest.map((b) => ({ ...b }));
  if (at >= 0 && at < out.length) {
    if (remove) out.splice(at, 1); else out[at] = { ...out[at], text };
  } else if (!remove) {
    out.push({ kind: 'paragraph', text });
  }
  return out;
}

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
      return { ...all, [nodeId]: { ...d, index: at, text: t, baseText: t, baseRevId: currentId, baseMarkdown: latestMarkdown } };
    });
  }, [draft, section, newerHead, located, nodeId, currentId, latestBlocks, latestMarkdown]);

  const setDraft = useCallback((next: Draft | null) => {
    setDrafts((all) => {
      const copy = { ...all };
      if (next) copy[nodeId] = next; else delete copy[nodeId];
      return copy;
    });
  }, [nodeId]);

  const write = useMutation({
    mutationFn: (v: { markdown: string; baseRevId: string | null }) => api('PUT /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId }, body: v }),
    onMutate: () => setState({ kind: 'saving' }),
    onSuccess: (sv) => {
      qc.setQueryData(qk.section(pid, nodeId), sv);
      void qc.invalidateQueries({ queryKey: qk.manuscript(pid) });
      void qc.invalidateQueries({ queryKey: qk.history(pid, nodeId) });
      void qc.invalidateQueries({ queryKey: qk.preview(pid, sv.chapterId) });
      void qc.invalidateQueries({ queryKey: qk.issues(pid) });
      setDraft(null);
      setConflict(null);
      setState({ kind: 'saved' });
    },
    onError: (e) => {
      if (isConflict(e)) {
        // Somebody saved first. Fetch what is current: the draft stays and the banner offers the choices.
        setConflict(errorText(e));
        setState({ kind: 'error', reason: 'the section changed since you opened it' });
        void qc.fetchQuery({ queryKey: qk.section(pid, nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId } }), staleTime: 0 });
      } else { const t = errorText(e); setState({ kind: 'error', reason: t }); toast(`Couldn't save. ${t}`, { tone: 'danger' }); }
    },
  });

  const startEdit = useCallback((index: number) => {
    const blocks = splitBlocks(section?.current?.markdown ?? '');
    if (index >= blocks.length) return;
    setConflict(null);
    // Re-opening the block that already has a draft keeps that draft; another block's typed text is never dropped.
    const open = drafts[nodeId];
    if (open && located && located.index === index) return;
    if (open && open.text !== open.baseText) { toast('Save or discard the block you are editing first.'); return; }
    setDraft({ id: nextId.current++, index, text: blocks[index].text, baseText: blocks[index].text, baseRevId: section?.current?.id ?? null, baseMarkdown: section?.current?.markdown ?? '' });
  }, [section?.current?.id, section?.current?.markdown, drafts, nodeId, located, setDraft, toast]);

  const changeText = useCallback((text: string) => {
    setDrafts((all) => (all[nodeId] ? { ...all, [nodeId]: { ...all[nodeId], text } } : all));
  }, [nodeId]);

  const cancelEdit = useCallback(() => { setDraft(null); setConflict(null); if (state.kind === 'error') setState({ kind: 'idle' }); }, [setDraft, state.kind]);

  const blocked = useCallback(() => {
    setState({ kind: 'error', reason: 'the section changed while you were editing. Choose how to continue above' });
  }, []);

  /** Save the draft block. Only while the head is the revision the edit started from. */
  const saveDraft = useCallback(() => {
    if (!draft || draft.text === draft.baseText) return;
    if (changedElsewhere) { blocked(); return; }
    if (draft.index >= latestBlocks.length) return;
    write.mutate({ markdown: joinBlocks(applyDraft(latestBlocks, draft.index, draft.text)), baseRevId: draft.baseRevId });
  }, [draft, changedElsewhere, latestBlocks, write, blocked]);

  const removeDraftBlock = useCallback(() => {
    if (!draft) return;
    if (changedElsewhere) { blocked(); return; }
    write.mutate({ markdown: joinBlocks(applyDraft(latestBlocks, draft.index, '', true)), baseRevId: draft.baseRevId });
  }, [draft, changedElsewhere, latestBlocks, write, blocked]);

  /** What "Keep my version" would save: the latest text with the draft in place of its block. */
  const merged = useMemo(() => (draft && located ? joinBlocks(applyDraft(latestBlocks, located.index, draft.text)) : null), [draft, located, latestBlocks]);

  /** The author chose to keep their text: save it over the latest head, read fresh at this moment. */
  const keepMine = useCallback(async () => {
    if (!draft) return;
    try {
      const fresh = await qc.fetchQuery({ queryKey: qk.section(pid, nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId } }), staleTime: 0 });
      const blocks = splitBlocks(fresh.current?.markdown ?? '');
      const at = locateDraft(draft, blocks);
      write.mutate({ markdown: joinBlocks(applyDraft(blocks, at.index, draft.text)), baseRevId: fresh.current?.id ?? null });
    } catch (e) { toast(errorText(e), { tone: 'danger' }); }
  }, [draft, qc, pid, nodeId, write, toast]);

  const discard = useCallback(() => { setDraft(null); setConflict(null); setState({ kind: 'idle' }); }, [setDraft]);

  return {
    editing, draft, located, startEdit, cancelEdit, changeText, saveDraft, removeDraftBlock, state, saving: write.isPending, conflict,
    changedElsewhere, keepMine, discard, merged,
  };
}
