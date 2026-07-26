import type { CandidateArtifact } from '../storage/artifact-store.ts';

export interface ArtifactProvider {
  resolve(source: Record<string, unknown>, stagingDir: string): Promise<CandidateArtifact>;
}

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}
