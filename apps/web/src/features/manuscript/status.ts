import type { SectionView } from '@smartbuilder/domain';
import { OPEN_ISSUE } from '../../lib/blocks';

export type SectionStatus = 'not-started' | 'drafting' | 'drafted' | 'issues' | 'proposal';

export const STATUS_LABEL: Record<SectionStatus, string> = {
  'not-started': 'Not started',
  drafting: 'Drafting',
  drafted: 'Drafted',
  issues: 'Has open issues',
  proposal: 'AI proposal waiting',
};

export function sectionStatus(s: SectionView, drafting: boolean): SectionStatus {
  if (s.proposal) return 'proposal';
  if (s.issues.some((i) => OPEN_ISSUE.has(i.status))) return 'issues';
  if (drafting) return 'drafting';
  return s.current ? 'drafted' : 'not-started';
}
