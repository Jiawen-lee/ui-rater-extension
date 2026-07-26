import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalJson, sha256, type WebsiteArtifactDescriptor, type WebsiteTaskDescriptor,
  validateWebsiteArtifact,
} from '../../../../packages/contracts/src/index.ts';
import type { WebsiteConfig } from '../config.ts';
import { ensureDir, listJson, readJson, syncDir, writeJsonAtomic } from './json-store.ts';

export interface CandidateArtifact {
  sourceDir: string;
  taskFile: string;
  website: string;
  tasks: WebsiteTaskDescriptor[];
  source: Record<string, unknown>;
}

export class ArtifactStore {
  readonly root: string;
  readonly artifactsDir: string;
  readonly acquisitionsDir: string;
  readonly stagingDir: string;

  constructor(private readonly config: WebsiteConfig) {
    this.root = config.dataDir;
    this.artifactsDir = path.join(this.root, 'artifacts');
    this.acquisitionsDir = path.join(this.root, 'acquisitions');
    this.stagingDir = path.join(this.root, 'staging');
  }

  async init(): Promise<void> {
    await Promise.all([ensureDir(this.artifactsDir), ensureDir(this.acquisitionsDir), ensureDir(this.stagingDir)]);
  }

  async get(artifactId: string): Promise<WebsiteArtifactDescriptor | undefined> {
    return readJson<WebsiteArtifactDescriptor>(path.join(this.artifactsDir, artifactId, 'artifact.json'));
  }

  async findByDigest(digest: string): Promise<WebsiteArtifactDescriptor | undefined> {
    const names = await fs.readdir(this.artifactsDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names) {
      if (!/^wsa_[A-Za-z0-9-]+$/.test(name)) continue;
      const row = await this.get(name);
      if (row?.artifactDigest === digest) return row;
    }
    return undefined;
  }

  async getAcquisition(acquisitionId: string) {
    return readJson<import('../../../../packages/contracts/src/index.ts').WebsiteAcquisitionDescriptor>(
      path.join(this.acquisitionsDir, `${acquisitionId}.json`)
    );
  }

  async listAcquisitions() {
    return listJson<import('../../../../packages/contracts/src/index.ts').WebsiteAcquisitionDescriptor>(this.acquisitionsDir);
  }

  async importCandidate(candidate: CandidateArtifact, acquisitionKey?: string): Promise<{
    artifact: WebsiteArtifactDescriptor;
    acquisition: import('../../../../packages/contracts/src/index.ts').WebsiteAcquisitionDescriptor;
  }> {
    const digest = await digestCandidate(candidate);
    const normalizedTasks = candidate.tasks.map((task) => ({
      ...task,
      websiteTaskId: `wst_${digest.slice('sha256:'.length, 'sha256:'.length + 20)}_${task.sourcePosition}`,
    }));
    let artifact = await this.findByDigest(digest);
    if (!artifact) {
      const artifactId = `wsa_${digest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
      const stage = path.join(this.stagingDir, `artifact-${randomUUID()}`);
      await ensureDir(stage);
      artifact = validateWebsiteArtifact({
        schemaVersion: 1,
        websiteArtifactId: artifactId,
        artifactDigest: digest,
        website: candidate.website,
        createdAt: new Date().toISOString(),
        tasks: normalizedTasks,
      });
      const finalDir = path.join(this.artifactsDir, artifactId);
      try {
        await fs.cp(path.join(candidate.sourceDir, 'dist'), path.join(stage, 'dist'), { recursive: true, force: true });
        await writeJsonAtomic(path.join(stage, 'artifact.json'), artifact);
        await fs.rename(stage, finalDir);
        await syncDir(this.artifactsDir);
      } catch (error: unknown) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        artifact = await this.get(artifactId);
        if (!artifact) throw new Error(`Website artifact ${artifactId} exists but is incomplete`);
      } finally {
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
    const acquisitionId = acquisitionKey
      ? `wac_${sha256(acquisitionKey).slice('sha256:'.length, 'sha256:'.length + 32)}`
      : `wac_${randomUUID().replaceAll('-', '')}`;
    const existingAcquisition = await this.getAcquisition(acquisitionId);
    if (existingAcquisition) {
      if (existingAcquisition.websiteArtifactId !== artifact.websiteArtifactId
        || existingAcquisition.artifactDigest !== artifact.artifactDigest) {
        throw new Error(`Website acquisition ${acquisitionId} is bound to another artifact`);
      }
      return { artifact, acquisition: existingAcquisition };
    }
    const acquisition = {
      schemaVersion: 1 as const,
      websiteAcquisitionId: acquisitionId,
      websiteArtifactId: artifact.websiteArtifactId,
      artifactDigest: artifact.artifactDigest,
      source: candidate.source as import('../../../../packages/contracts/src/index.ts').WebsiteAcquisitionDescriptor['source'],
      resolvedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(this.acquisitionsDir, `${acquisitionId}.json`), acquisition);
    return { artifact, acquisition };
  }

  artifactDistDir(artifactId: string): string {
    return path.join(this.artifactsDir, artifactId, 'dist');
  }
}

async function digestCandidate(candidate: CandidateArtifact): Promise<string> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  async function walk(root: string, relative = ''): Promise<void> {
    const names = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      const rel = path.posix.join(relative, entry.name);
      const full = path.join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in website artifact: ${rel}`);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files.push({ path: rel, bytes: await fs.readFile(full) });
      else throw new Error(`Unsupported artifact entry: ${rel}`);
    }
  }
  await walk(path.join(candidate.sourceDir, 'dist'));
  const manifest = files.map(({ path: filePath, bytes }) => ({ path: filePath, digest: sha256(bytes), bytes: bytes.length }));
  const tasksWithoutIds = candidate.tasks.map(({ websiteTaskId: _ignored, ...task }) => task);
  return sha256(canonicalJson({ files: manifest, tasks: tasksWithoutIds }));
}
