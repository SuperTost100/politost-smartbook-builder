// HTTP contract between apps/web and apps/service. All routes live under /api.
// Bodies are JSON unless noted. Errors use ApiError from index.ts with an HTTP status.
// Mutations require the header `x-smartbuilder: 1` (CSRF guard).
import type {
  Asset, BookOptions, ContentRevision, Enrichment, EvidencePacket, Outline, OutlineRevision, Page, Project,
  ProjectInput, ProjectSummary, Question, Resource, ResourceRole, ReviewIssue, RunSummary, Settings,
  SourceIndex, TaskRow, Topic, UsageRow, Role,
} from './index.ts';

export interface ProviderStatus {
  provider: string;
  label: string;
  installed: boolean;
  version: string | null;
  signedIn: boolean | null;
  models: { id: string; label: string; efforts: string[] }[];
  capabilities: { images: boolean; schema: 'native' | 'prompt' | 'none'; system: boolean };
  error: string | null;
}

export interface ConnectionsResponse {
  providers: ProviderStatus[];
  notebooklm: { installed: boolean; signedIn: boolean; account: string | null; usage: { window: string; remaining: string }[]; error: string | null; loginCommand: string };
  libreoffice: { installed: boolean; path: string | null };
  node: string;
  dataDir: string;
}

export interface ProbeResult { ok: boolean; ms: number; detail: string }

/** One manuscript section as the editor needs it. */
export interface SectionView {
  chapterId: string;
  sectionId: string;
  title: string;
  current: ContentRevision | null;
  proposal: ContentRevision | null;
  evidence: EvidencePacket | null;
  issues: ReviewIssue[];
  /** Compiled reader Markdown for this section, with final numbers. */
  compiled: string;
}

export interface ChapterView {
  chapterId: string;
  number: number;
  title: string;
  intro: ContentRevision | null;
  sections: SectionView[];
}

export interface ValidationReport {
  ok: boolean;
  errors: { file: string; message: string }[];
  warnings: { file: string; message: string }[];
  lint: { file: string; rule: string; message: string; line?: number }[];
}

export interface ExportRow { id: string; createdAt: string; approved: boolean; sha256: string; size: number; report: ValidationReport; filename: string }

/** Route table. `params` are path params, `body` is the JSON body, `res` is the response. */
export interface Api {
  'GET /api/health': { res: { ok: true; version: string; dataDir: string } };
  'POST /api/shutdown': { res: { ok: true } };

  'GET /api/settings': { res: Settings };
  'PUT /api/settings': { body: Partial<Settings>; res: Settings };
  'GET /api/connections': { res: ConnectionsResponse };
  'POST /api/connections/probe': { body: { role: Role }; res: ProbeResult };

  'GET /api/projects': { res: ProjectSummary[] };
  'POST /api/projects': { body: ProjectInput; res: Project };
  'GET /api/projects/:id': { res: ProjectSummary };
  'PATCH /api/projects/:id': { body: Partial<ProjectInput> & { options?: Partial<BookOptions> }; res: Project };
  'POST /api/projects/:id/archive': { res: Project };
  'DELETE /api/projects/:id': { res: { ok: true } };

  /** multipart/form-data: file (repeatable), role. */
  'POST /api/projects/:id/resources': { res: Resource[] };
  'POST /api/projects/:id/resources/url': { body: { url: string; role: ResourceRole }; res: Resource };
  'GET /api/projects/:id/resources': { res: Resource[] };
  'PATCH /api/resources/:rid': { body: { role?: ResourceRole; included?: boolean }; res: Resource };
  'DELETE /api/resources/:rid': { res: { ok: true } };
  'GET /api/resources/:rid/pages': { res: Pick<Page, 'id' | 'idx' | 'label' | 'quality'>[] };
  'GET /api/resources/:rid/pages/:idx': { res: Page };
  /** PNG of the page. Query: scale (default 1.5), highlight (text to mark). */
  'GET /api/resources/:rid/pages/:idx/image': { res: Blob };
  'POST /api/resources/:rid/pages/:idx/transcribe': { res: Page };
  'GET /api/resources/:rid/index': { res: SourceIndex | null };

  'GET /api/projects/:id/topics': { res: Topic[] };
  'PATCH /api/topics/:tid': { body: Partial<Pick<Topic, 'name' | 'priority' | 'description'>>; res: Topic };

  'GET /api/projects/:id/outline': { res: { current: OutlineRevision | null; history: Pick<OutlineRevision, 'id' | 'createdAt' | 'origin' | 'approvedAt'>[] } };
  'PUT /api/projects/:id/outline': { body: { outline: Outline; baseRevId: string | null }; res: OutlineRevision };
  'POST /api/projects/:id/outline/approve': { body: { revId: string }; res: OutlineRevision };

  /** Starts a run. kind=prepare: extract+map; plan: outline; generate: draft everything in scope. */
  'POST /api/projects/:id/runs': { body: { kind: RunSummary['kind']; scope?: { chapterIds?: string[]; nodeIds?: string[]; questionIds?: string[] } }; res: RunSummary };
  'GET /api/projects/:id/runs': { res: RunSummary[] };
  'GET /api/runs/:runId': { res: RunSummary & { tasks: TaskRow[]; usage: UsageRow[] } };
  'POST /api/runs/:runId/pause': { res: RunSummary };
  'POST /api/runs/:runId/resume': { res: RunSummary };
  'POST /api/runs/:runId/cancel': { res: RunSummary };
  'POST /api/runs/:runId/retry': { body: { taskIds?: string[] }; res: RunSummary };
  /** Resolve a waiting_for_user task (gates, logins). */
  'POST /api/tasks/:taskId/resolve': { body: { decision: 'continue' | 'skip' }; res: TaskRow };

  'GET /api/projects/:id/manuscript': { res: ChapterView[] };
  'GET /api/projects/:id/sections/:nodeId': { res: SectionView };
  /** Saves a human edit. 409 when baseRevId is not the current revision. */
  'PUT /api/projects/:id/sections/:nodeId': { body: { markdown: string; baseRevId: string | null }; res: SectionView };
  'GET /api/projects/:id/sections/:nodeId/history': { res: ContentRevision[] };
  'POST /api/projects/:id/sections/:nodeId/restore': { body: { revId: string }; res: SectionView };
  'POST /api/projects/:id/sections/:nodeId/regenerate': { body: { instruction?: string; selection?: string }; res: RunSummary };
  'POST /api/projects/:id/sections/:nodeId/research': { res: RunSummary };
  /** headRevId: the current revision the author saw the proposal against; accept is refused with 409 if it changed. */
  'POST /api/projects/:id/sections/:nodeId/proposal': { body: { action: 'accept' | 'reject'; revId: string; headRevId: string | null }; res: SectionView };
  /** Compiled reader Markdown for the chapter (preview). */
  'GET /api/projects/:id/chapters/:chapterId/preview': { res: { markdown: string; number: number; assets: Record<string, string> } };

  'GET /api/projects/:id/questions': { res: Question[] };
  'POST /api/projects/:id/questions': { body: Partial<Question>; res: Question };
  'PATCH /api/questions/:qid': { body: Partial<Question> & { rev: number }; res: Question };
  'DELETE /api/questions/:qid': { res: { ok: true } };
  'POST /api/questions/:qid/verify': { res: RunSummary };

  'GET /api/projects/:id/assets': { res: Asset[] };
  /** Raw asset bytes. */
  'GET /api/assets/:assetId/file': { res: Blob };
  'POST /api/projects/:id/assets': { res: Asset };
  'PATCH /api/assets/:assetId': { body: Partial<Pick<Asset, 'caption' | 'alt' | 'nodeId'>>; res: Asset };
  'GET /api/projects/:id/enrichments': { res: Enrichment[] };
  'PATCH /api/enrichments/:eid': { body: { payload: Record<string, unknown> }; res: Enrichment };
  'DELETE /api/enrichments/:eid': { res: { ok: true } };

  'GET /api/projects/:id/issues': { res: ReviewIssue[] };
  'PATCH /api/issues/:iid': { body: { status: ReviewIssue['status']; resolution?: string }; res: ReviewIssue };
  /** Ask the writer for proposals fixing the selected issues. */
  'POST /api/projects/:id/issues/fix': { body: { issueIds: string[] }; res: RunSummary };

  'POST /api/projects/:id/validate': { res: ValidationReport };
  'POST /api/projects/:id/exports': { body: { approved: boolean }; res: ExportRow };
  'GET /api/projects/:id/exports': { res: ExportRow[] };
  'GET /api/exports/:exportId/download': { res: Blob };

  /** Server-sent events. Query: projectId (optional). Header Last-Event-ID resumes. */
  'GET /api/events': { res: never };
}
