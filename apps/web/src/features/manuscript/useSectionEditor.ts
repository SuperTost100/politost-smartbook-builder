import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { joinBlocks, splitBlocks } from '@smartbuilder/content/blocks';
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
 * Block-level editing on top of "PUT the whole section".
 * The revision an edit starts from is pinned for the whole edit, so a change made elsewhere meanwhile
 * produces a 409 instead of being overwritten.
 */
export function useSectionEditor(pid: string, nodeId: string, section: SectionView | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<number | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [conflict, setConflict] = useState<string | null>(null);

  const currentId = section?.current?.id ?? null;

  // Reset when moving to another section.
  useEffect(() => { setEditing(null); setState({ kind: 'idle' }); setConflict(null); }, [nodeId]);
  // Follow the server while nobody is editing.
  useEffect(() => { if (editing === null) setBase(currentId); }, [currentId, editing]);

  const changedElsewhere = editing !== null && base !== currentId;

  const write = useMutation({
    mutationFn: (markdown: string) => api('PUT /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId }, body: { markdown, baseRevId: base } }),
    onMutate: () => setState({ kind: 'saving' }),
    onSuccess: (sv) => {
      qc.setQueryData(qk.section(pid, nodeId), sv);
      void qc.invalidateQueries({ queryKey: qk.manuscript(pid) });
      void qc.invalidateQueries({ queryKey: qk.history(pid, nodeId) });
      setBase(sv.current?.id ?? null);
      setEditing(null);
      setConflict(null);
      setState({ kind: 'saved' });
    },
    onError: (e) => {
      if (isConflict(e)) { setConflict(errorText(e)); setState({ kind: 'error', reason: 'the section changed since you opened it' }); }
      else { const t = errorText(e); setState({ kind: 'error', reason: t }); toast(`Couldn't save. ${t}`, { tone: 'danger' }); }
    },
  });

  const startEdit = useCallback((index: number) => {
    setBase(currentId);
    setConflict(null);
    setEditing(index);
  }, [currentId]);

  const cancelEdit = useCallback(() => { setEditing(null); setConflict(null); setBase(currentId); if (state.kind === 'error') setState({ kind: 'idle' }); }, [currentId, state.kind]);

  const saveBlock = useCallback((index: number, text: string) => {
    const blocks = splitBlocks(section?.current?.markdown ?? '');
    if (index >= blocks.length) return;
    blocks[index] = { ...blocks[index], text };
    write.mutate(joinBlocks(blocks));
  }, [section?.current?.markdown, write]);

  const removeBlock = useCallback((index: number) => {
    const blocks = splitBlocks(section?.current?.markdown ?? '');
    blocks.splice(index, 1);
    write.mutate(joinBlocks(blocks));
  }, [section?.current?.markdown, write]);

  /** Keep what is typed, adopt the latest revision as the base, and let the author save again on purpose. */
  const loadLatest = useCallback(async () => {
    const fresh = await qc.fetchQuery({ queryKey: qk.section(pid, nodeId), queryFn: () => api('GET /api/projects/:id/sections/:nodeId', { params: { id: pid, nodeId } }), staleTime: 0 });
    setBase(fresh.current?.id ?? null);
    setConflict(null);
    setState({ kind: 'idle' });
  }, [qc, pid, nodeId]);

  return { editing, startEdit, cancelEdit, saveBlock, removeBlock, state, saving: write.isPending, conflict, loadLatest, changedElsewhere };
}
