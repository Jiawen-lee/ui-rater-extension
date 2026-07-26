import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError, requestDigest, type WebsiteSourceRequest } from '../../../../packages/contracts/src/index.ts';
import type { WebsiteConfig } from '../config.ts';
import { ensureDir, listJson, readJson, withJsonStoreLock, writeJsonAtomic } from './json-store.ts';

export type ArtifactJobStatus = 'queued' | 'running' | 'failed_retryable' | 'failed_terminal' | 'succeeded';

export interface ArtifactJobRecord {
  operationId: string;
  status: ArtifactJobStatus;
  source: WebsiteSourceRequest;
  requestDigest: string;
  idempotencyKey: string;
  websiteArtifactId?: string;
  websiteAcquisitionId?: string;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
}

export class OperationStore {
  readonly dir: string;
  constructor(private readonly config: WebsiteConfig) { this.dir = path.join(config.dataDir, 'artifact-jobs'); }
  async init(): Promise<void> { await ensureDir(this.dir); }
  async get(id: string): Promise<ArtifactJobRecord | undefined> { return readJson<ArtifactJobRecord>(path.join(this.dir, `${id}.json`)); }
  async list(): Promise<ArtifactJobRecord[]> { return listJson<ArtifactJobRecord>(this.dir); }
  async findByKey(key: string): Promise<ArtifactJobRecord | undefined> { return (await this.list()).find((row) => row.idempotencyKey === key); }
  async create(source: WebsiteSourceRequest, idempotencyKey: string): Promise<{ record: ArtifactJobRecord; created: boolean }> {
    return withJsonStoreLock(`artifact-job:${idempotencyKey}`, async () => {
      const digest = requestDigest(source);
      const existing = await this.findByKey(idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== digest) throw new Error('Idempotency key is already bound to a different artifact request');
        return { record: existing, created: false };
      }
      const now = new Date().toISOString();
      const record: ArtifactJobRecord = {
        operationId: `op_${randomUUID().replaceAll('-', '')}`,
        status: 'queued', source, requestDigest: digest, idempotencyKey,
        createdAt: now, updatedAt: now,
      };
      await writeJsonAtomic(path.join(this.dir, `${record.operationId}.json`), record);
      return { record, created: true };
    });
  }
  async update(record: ArtifactJobRecord, patch: Partial<ArtifactJobRecord>): Promise<ArtifactJobRecord> {
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(this.dir, `${record.operationId}.json`), next);
    return next;
  }

  async claimQueued(id: string): Promise<ArtifactJobRecord | undefined> {
    return withJsonStoreLock(`artifact-job-run:${id}`, async () => {
      const current = await this.get(id);
      if (!current || current.status !== 'queued') return undefined;
      return this.update(current, { status: 'running', error: undefined });
    });
  }

  async queueRetry(id: string): Promise<ArtifactJobRecord> {
    return withJsonStoreLock(`artifact-job-run:${id}`, async () => {
      const current = await this.get(id);
      if (!current) throw new ContractError('artifact_job_not_found', 'Artifact job not found');
      if (current.status !== 'failed_retryable') throw new ContractError('artifact_job_not_retryable', 'Artifact job is not retryable');
      return this.update(current, { status: 'queued', error: undefined });
    });
  }
}
