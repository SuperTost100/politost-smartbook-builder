// Model routing through cli-funnel. Callers name a role; settings map roles to provider/model with a fallback.
import type { ConnectionsResponse, ProbeResult, Role, Route } from '@smartbuilder/domain';
import type { z } from 'zod';
import type { AppContext } from '../context.ts';

export interface RunRoleOptions<T> {
  role: Role;
  system: string;
  prompt: string;
  /** PNG images; only sent to routes whose provider supports images. */
  images?: Buffer[];
  /** When set, the answer must parse and validate; one repair request is made on failure. */
  schema?: z.ZodType<T>;
  /** JSON schema sent to the provider (derived from schema when omitted). */
  jsonSchema?: Record<string, unknown>;
  projectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  signal?: AbortSignal;
  /** Override the configured route (e.g. escalation). */
  route?: Route;
}

export interface RunRoleResult<T> { text: string; data: T; route: Route; usage: { inputTokens: number | null; outputTokens: number | null } }

/** Runs a prompt for a role. Throws TaskError with kind auth/quota/temporary/input so the queue can react. Falls back to the role's fallback route on quota/unavailable. */
export async function runRole<T = string>(_ctx: AppContext, _opts: RunRoleOptions<T>): Promise<RunRoleResult<T>> { throw new Error('not implemented'); }

export async function getConnections(_ctx: AppContext): Promise<ConnectionsResponse> { throw new Error('not implemented'); }
export async function probeRole(_ctx: AppContext, _role: Role): Promise<ProbeResult> { throw new Error('not implemented'); }
