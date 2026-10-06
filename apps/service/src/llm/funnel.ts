// One cli-funnel instance per process, created on first use. Tests inject a fake.
import { createFunnel, type Capabilities, type ModelInfo, type ProviderOverview, type RunInput, type RunResult } from 'cli-funnel';

/** The slice of cli-funnel this app uses. The real Funnel satisfies it. */
export interface FunnelLike {
  run(input: RunInput): Promise<RunResult>;
  providers: Record<string, { displayName: string; capabilities: Capabilities }>;
  overview(): Promise<ProviderOverview[]>;
  models(id: never): Promise<ModelInfo[]>;
}

let instance: FunnelLike | null = null;

export function getFunnel(): FunnelLike {
  // The model catalog is bundled and can lag behind the CLIs; routes may name newer models.
  instance ??= createFunnel({ allowUnlistedModels: true }) as unknown as FunnelLike;
  return instance;
}

/** Replace the process-wide funnel (tests). Pass null to go back to the real one. */
export function setFunnel(fake: FunnelLike | null) {
  instance = fake;
}
