import path from 'node:path';
import fs from 'node:fs/promises';
import type { WebsiteDeploymentDescriptor } from '../../../../packages/contracts/src/index.ts';
import { assertId, sha256 } from '../../../../packages/contracts/src/index.ts';
import type { WebsiteConfig } from '../config.ts';
import { ensureDir, readJson, withJsonStoreLock, writeJsonAtomic } from './json-store.ts';

export class DeploymentStore {
  readonly dir: string;

  constructor(private readonly config: WebsiteConfig) { this.dir = path.join(config.dataDir, 'deployments'); }

  async init(): Promise<void> { await ensureDir(this.dir); }

  async list(): Promise<WebsiteDeploymentDescriptor[]> {
    const names = await fs.readdir(this.dir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const rows: WebsiteDeploymentDescriptor[] = [];
    for (const name of names.filter((candidate) => /^wsd_[A-Za-z0-9-]+\.json$/.test(candidate))) {
      const row = await readJson<WebsiteDeploymentDescriptor>(path.join(this.dir, name));
      if (row) rows.push(row);
    }
    return rows;
  }

  async get(id: string): Promise<WebsiteDeploymentDescriptor | undefined> {
    return readJson<WebsiteDeploymentDescriptor>(path.join(this.dir, `${id}.json`));
  }

  async findByKey(key: string): Promise<WebsiteDeploymentDescriptor | undefined> {
    const names = await fs.readdir(this.dir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names.filter((candidate) => candidate.endsWith('.request.json'))) {
      const request = await readJson<{ idempotencyKey?: string; artifact?: { websiteArtifactId?: string; artifactDigest?: string } }>(path.join(this.dir, name));
      if (request?.idempotencyKey !== key) continue;
      const deploymentId = name.slice(0, -'.request.json'.length);
      return this.get(deploymentId);
    }
    return undefined;
  }

  async findByRoutingLabel(label: string): Promise<WebsiteDeploymentDescriptor | undefined> {
    return (await this.list()).find((deployment) => deployment.routingLabel === label);
  }

  async create(artifact: { websiteArtifactId: string; artifactDigest: string }, idempotencyKey: string): Promise<{ deployment: WebsiteDeploymentDescriptor; created: boolean }> {
    return withJsonStoreLock(`deployment:${idempotencyKey}`, async () => {
      const existing = await this.findByKey(idempotencyKey);
      if (existing) {
        if (existing.websiteArtifactId !== artifact.websiteArtifactId || existing.artifactDigest !== artifact.artifactDigest) {
          throw new Error('Idempotency key is already bound to another deployment');
        }
        return { deployment: existing, created: false };
      }
      const deploymentId = `wsd_${sha256(idempotencyKey).slice('sha256:'.length, 'sha256:'.length + 32)}`;
      const existingByIdentity = await this.get(deploymentId);
      if (existingByIdentity) {
        if (existingByIdentity.websiteArtifactId !== artifact.websiteArtifactId
          || existingByIdentity.artifactDigest !== artifact.artifactDigest) {
          throw new Error('Deterministic deployment identity is already bound to another artifact');
        }
        await writeJsonAtomic(path.join(this.dir, `${deploymentId}.request.json`), { idempotencyKey, artifact });
        return { deployment: existingByIdentity, created: false };
      }
      const routingLabel = `d-${deploymentId.slice(4, 22).toLowerCase()}`;
      const descriptor: WebsiteDeploymentDescriptor = {
        schemaVersion: 1,
        websiteDeploymentId: deploymentId,
        websiteArtifactId: assertId(artifact.websiteArtifactId, 'websiteArtifactId'),
        artifactDigest: artifact.artifactDigest,
        routingLabel,
        baseUrl: `http://${routingLabel}${this.config.runtimeSuffix}:${this.config.port}/`,
        status: 'ready',
        createdAt: new Date().toISOString(),
      };
      await writeJsonAtomic(path.join(this.dir, `${deploymentId}.json`), descriptor);
      await writeJsonAtomic(path.join(this.dir, `${deploymentId}.request.json`), { idempotencyKey, artifact });
      return { deployment: descriptor, created: true };
    });
  }

  async release(id: string): Promise<WebsiteDeploymentDescriptor> {
    const current = await this.get(id);
    if (!current) throw new Error('Deployment not found');
    if (current.status === 'released') return current;
    const next = { ...current, status: 'released' as const };
    await writeJsonAtomic(path.join(this.dir, `${id}.json`), next);
    return next;
  }
}
