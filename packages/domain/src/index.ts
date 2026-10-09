// Shared types for the service and the web app.
// Rows mirror apps/service/src/db/migrations; API responses use these shapes as is.
import { z } from 'zod';

export * from './api.ts';

// ---------- Model routing ----------

export const ROLES = ['bulk', 'vision', 'evidence', 'planner', 'writer', 'editor', 'exercises', 'checker', 'reviewer', 'research'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, { label: string; help: string }> = {
  bulk: { label: 'Classify and rewrite', help: 'Topic mapping, triage, short repairs. Cheap and fast.' },
  vision: { label: 'Read pages', help: 'Transcribes pages whose math or handwriting the PDF text layer garbles.' },
  evidence: { label: 'Evidence reader', help: 'Reads source pages and returns verbatim quotes when NotebookLM is unavailable.' },
  planner: { label: 'Plan the book', help: 'Builds the common index. Runs once per outline.' },
  writer: { label: 'Write sections', help: 'The explanations of each section, and fixes of blocker issues in them. The text students read most; use your best writer here.' },
  editor: { label: 'Edit and fix', help: 'Chapter introductions, formatting repairs, fixes of non-blocker issues, exercise corrections, topic map, graphs and Python examples.' },
  exercises: { label: 'Write exercises', help: 'Generated exercises and missing official solutions. Every one is checked afterwards.' },
  checker: { label: 'Check solutions', help: 'First, cheap check of every exercise solution. Disagreements go to the reviewer for a second opinion.' },
  reviewer: { label: 'Review', help: 'Independent check of drafts and solutions. Prefer a different vendor from the writer.' },
  research: { label: 'Outside research', help: 'Searches the web for material your sources lack. The only role allowed to use web search; Claude or Codex.' },
};

export const routeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string().optional(),
});
export type Route = z.infer<typeof routeSchema>;

export const roleRouteSchema = z.object({ primary: routeSchema, fallback: routeSchema.optional() });
export type RoleRoute = z.infer<typeof roleRouteSchema>;

export const DEFAULT_ROUTES: Record<Role, RoleRoute> = {
  // Antigravity runs a full agent per call (~4-5 min and ~90k tokens measured), so it is only a fallback for batch work.
  bulk: { primary: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, fallback: { provider: 'antigravity', model: 'gemini-3.8-flash' } },
  vision: { primary: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, fallback: { provider: 'codex', model: 'gpt-6-sol', effort: 'low' } },
  evidence: { primary: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, fallback: { provider: 'antigravity', model: 'gemini-3.8-flash' } },
  planner: { primary: { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, fallback: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } },
  writer: { primary: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' }, fallback: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' } },
  editor: { primary: { provider: 'codex', model: 'gpt-6-luna', effort: 'medium' }, fallback: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' } },
  exercises: { primary: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, fallback: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' } },
  checker: { primary: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, fallback: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' } },
  reviewer: { primary: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' }, fallback: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' } },
  research: { primary: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' }, fallback: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' } },
};

// ---------- Settings ----------

export const settingsSchema = z.object({
  routes: z.record(z.enum(ROLES), roleRouteSchema).default(DEFAULT_ROUTES),
  evidenceMode: z.enum(['notebooklm', 'local']).default('notebooklm'),
  /** Max tasks running at once per provider. */
  concurrency: z.record(z.string(), z.number().int().min(1).max(8)).default({ claude: 2, codex: 2, antigravity: 2, agent: 1, notebooklm: 2 }),
});
export type Settings = z.infer<typeof settingsSchema>;

// ---------- Projects ----------

export const bookOptionsSchema = z.object({
  outsideMaterial: z.boolean().default(false),
  ide: z.boolean().default(true),
  graphs: z.boolean().default(true),
  figures: z.boolean().default(true),
  /** Hold every chapter after the first until the author approves chapter 1. */
  firstChapterGate: z.boolean().default(true),
  /** Wait for outline approval before drafting. */
  outlineGate: z.boolean().default(true),
  exercisesPerTopic: z.number().int().min(0).max(20).default(3),
  exercisesPerHotTopic: z.number().int().min(0).max(30).default(6),
  /** Restrict drafting to these chapter ids; empty means all. */
  chapterScope: z.array(z.string()).default([]),
});
export type BookOptions = z.infer<typeof bookOptionsSchema>;

export const projectInputSchema = z.object({
  title: z.string().min(1).max(200),
  subject: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(80),
  authors: z.array(z.string().min(1)).default([]),
  language: z.string().min(2).max(40).default('it'),
  audience: z.string().max(2000).default(''),
  goals: z.string().max(4000).default(''),
  options: bookOptionsSchema.default(bookOptionsSchema.parse({})),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export type ProjectStage = 'sources' | 'mapping' | 'outline' | 'drafting' | 'review' | 'export';

export interface Project extends ProjectInput {
  id: string;
  stage: ProjectStage;
  outlineRevId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectSummary extends Project {
  counts: { resources: number; sections: number; drafted: number; questions: number; openIssues: number };
  activeRun: RunSummary | null;
}

// ---------- Resources and pages ----------

export type ResourceKind = 'pdf' | 'docx' | 'pptx' | 'md' | 'url';
export type ResourceRole = 'theory' | 'exercises' | 'exams' | 'mixed';
export type ResourceStatus = 'queued' | 'extracting' | 'ready' | 'failed';

export interface Resource {
  id: string;
  projectId: string;
  kind: ResourceKind;
  role: ResourceRole;
  filename: string;
  url: string | null;
  sha256: string;
  size: number;
  included: boolean;
  status: ResourceStatus;
  error: string | null;
  pageCount: number;
  /** Pages whose text layer is garbled or missing and need vision. */
  pagesNeedingVision: number;
  pagesTranscribed: number;
  createdAt: string;
}

export type PageQuality = 'good' | 'garbled' | 'empty';

export interface Page {
  id: string;
  resourceId: string;
  /** 0-based physical page index. */
  idx: number;
  /** Printed page label if the PDF defines one, else idx+1 as string. */
  label: string;
  text: string;
  quality: PageQuality;
  /** Vision transcription (Markdown + LaTeX) when available. */
  transcript: string | null;
  transcriptModel: string | null;
}

export interface SourceIndexEntry { title: string; level: number; page: number }
export interface SourceIndex { resourceId: string; origin: 'extracted' | 'inferred'; entries: SourceIndexEntry[] }

// ---------- Topics and questions ----------

export interface TopicSourceRef { resourceId: string; pageFrom: number; pageTo: number }

export interface Topic {
  id: string;
  projectId: string;
  name: string;
  aliases: string[];
  description: string;
  prerequisites: string[];
  sources: TopicSourceRef[];
  /** Distinct exam sessions containing at least one question on this topic. */
  examSessions: number;
  priority: 'low' | 'normal' | 'high';
}

export type QuestionKind = 'exercise' | 'exam';
export type QuestionOrigin = 'authentic' | 'adapted' | 'generated';
export type QuestionStatus = 'draft' | 'verified' | 'issue';
export type Difficulty = 'facile' | 'medio' | 'difficile';

export interface QuestionCheck {
  method: 'independent-solve' | 'numeric' | 'symbolic' | 'lint';
  ok: boolean;
  detail: string;
  model?: string;
}

export interface Question {
  id: string;
  projectId: string;
  kind: QuestionKind;
  origin: QuestionOrigin;
  resourceId: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  /** Authentic exam session, e.g. "Esame del 25 gennaio 2023 - turno 1". */
  examGroup: string | null;
  examDate: string | null;
  number: string | null;
  statement: string;
  hint: string;
  solution: string;
  difficulty: Difficulty;
  topicIds: string[];
  chapterId: string | null;
  status: QuestionStatus;
  checks: QuestionCheck[];
  rev: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Outline ----------

export const outlineSubsectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  objectives: z.array(z.string()).default([]),
});
export const outlineSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  objectives: z.array(z.string()).default([]),
  topicIds: z.array(z.string()).default([]),
  depth: z.enum(['brief', 'standard', 'deep']).default('standard'),
  subsections: z.array(outlineSubsectionSchema).default([]),
});
export const outlineChapterSchema = z.object({
  id: z.string(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  objectives: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  sections: z.array(outlineSectionSchema),
});
export const outlineSchema = z.object({
  chapters: z.array(outlineChapterSchema),
  /** Topics deliberately left out, with the reason. */
  exclusions: z.array(z.object({ topicId: z.string(), reason: z.string() })).default([]),
  notation: z.string().default(''),
});
export type OutlineSubsection = z.infer<typeof outlineSubsectionSchema>;
export type OutlineSection = z.infer<typeof outlineSectionSchema>;
export type OutlineChapter = z.infer<typeof outlineChapterSchema>;
export type Outline = z.infer<typeof outlineSchema>;

export interface OutlineRevision {
  id: string;
  projectId: string;
  outline: Outline;
  origin: 'ai' | 'human';
  createdAt: string;
  approvedAt: string | null;
  note: string;
}

// ---------- Content ----------

/**
 * Node ids are outline ids. A section's content is Politost Markdown in "source dialect":
 *  - numbered formulas use :::formula{key="slug" label="..."} instead of id="N.M"
 *  - formula refs use {{formula:@slug}}, section links use ref:section/<sectionId>
 *  - no "## pN |" heading; the compiler adds it from the outline title
 *  - subsection headings are "### Title"
 * The compiler in @smartbuilder/content turns this into reader Markdown.
 */
export type ContentNodeKind = 'section' | 'chapter-intro';
export type ContentOrigin = 'ai' | 'human' | 'repair';
export type ContentRevStatus = 'current' | 'proposal' | 'superseded' | 'rejected';

export interface EvidenceRef {
  /** Evidence note id from the section's packet. */
  noteId: string;
}

export interface ContentRevision {
  id: string;
  projectId: string;
  nodeId: string;
  kind: ContentNodeKind;
  markdown: string;
  origin: ContentOrigin;
  model: string | null;
  parentRevId: string | null;
  status: ContentRevStatus;
  /** Evidence note ids the writer cited, keyed by block index within the markdown. */
  citations: Record<string, string[]>;
  createdAt: string;
}

export interface EvidenceNote {
  id: string;
  /** Verbatim passage from the source. */
  quote: string;
  resourceId: string | null;
  /** 0-based page index, null when the passage could not be located. */
  page: number | null;
  verified: boolean;
  /** Short claim this note supports, written by the evidence reader. */
  claim: string;
  /** Web page the quote was found on (outside research); resourceId and page are null then. */
  url?: string;
  title?: string;
}

export interface EvidencePacket {
  id: string;
  projectId: string;
  nodeId: string;
  provider: 'notebooklm' | 'local' | 'manual' | 'web';
  query: string;
  answer: string;
  notes: EvidenceNote[];
  createdAt: string;
}

// ---------- Assets and enrichments ----------

export interface Asset {
  id: string;
  projectId: string;
  nodeId: string | null;
  /** File name inside the exported assets/ folder. */
  filename: string;
  mime: string;
  origin: 'plot' | 'generated-svg' | 'imported';
  /** Plot spec for origin "plot"; see @smartbuilder/content plot.ts. */
  spec: unknown;
  caption: string;
  alt: string;
  checks: QuestionCheck[];
  createdAt: string;
}

export type EnrichmentKind = 'ide' | 'graph';
export interface Enrichment {
  id: string;
  projectId: string;
  nodeId: string;
  kind: EnrichmentKind;
  /** IdeSnippet or GraficoConfig from content-core. */
  payload: Record<string, unknown>;
  status: 'draft' | 'verified' | 'issue';
  checks: QuestionCheck[];
  createdAt: string;
}

// ---------- Runs and tasks ----------

export type RunStatus = 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'waiting';
export type TaskState = 'queued' | 'running' | 'succeeded' | 'retry_wait' | 'waiting_for_user' | 'failed' | 'interrupted' | 'cancelled' | 'skipped';

export interface RunSummary {
  id: string;
  projectId: string;
  kind: 'prepare' | 'plan' | 'generate' | 'review' | 'export' | 'regenerate' | 'research';
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  counts: Partial<Record<TaskState, number>>;
  /**
   * author: a gate or login needs the author (Continue/Skip apply).
   * quota: a provider limit; the task resumes by itself at retryAt.
   */
  waiting: { taskId: string; reason: string; action: string; kind: 'author' | 'quota'; retryAt: string | null } | null;
}

export interface TaskRow {
  id: string;
  runId: string;
  kind: string;
  label: string;
  state: TaskState;
  attempts: number;
  provider: string | null;
  error: { message: string; action?: string } | null;
  waitReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UsageRow {
  provider: string;
  model: string;
  role: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

// ---------- Review ----------

export type IssueSeverity = 'blocker' | 'major' | 'minor';
export type IssueStatus = 'open' | 'proposed' | 'fixed' | 'accepted' | 'dismissed';
export type IssueSource = 'lint' | 'review' | 'verification';

export interface ReviewIssue {
  id: string;
  projectId: string;
  nodeId: string | null;
  questionId: string | null;
  revId: string | null;
  source: IssueSource;
  severity: IssueSeverity;
  category: string;
  /** Verbatim text the issue points at, when it has one. */
  quote: string;
  message: string;
  suggestion: string;
  status: IssueStatus;
  resolution: string;
  createdAt: string;
}

// ---------- Events (SSE) ----------

export interface ServiceEvent {
  seq: number;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  type:
    | 'task.state' | 'task.progress' | 'run.state' | 'resource.state'
    | 'content.saved' | 'proposal.created' | 'proposal.decided' | 'issue.created' | 'issue.updated' | 'question.updated' | 'asset.updated' | 'enrichment.updated' | 'outline.created' | 'export.ready' | 'log';
  data: Record<string, unknown>;
  createdAt: string;
}

// ---------- Errors ----------

/** Every API error body has this shape. */
export interface ApiError {
  error: { code: string; message: string; action?: string; item?: string };
}
