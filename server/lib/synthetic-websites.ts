import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { SYNTHETIC_WEBSITES_DIR } from '@/lib/paths';

interface TrialTaskConfig {
  slug: string;
  group: string;
  task_prompt: string;
  site_url?: string;
}

interface ArtifactJobResponse {
  operation: {
    operationId: string;
    status: string;
    result?: {
      websiteArtifactId: string;
      websiteAcquisitionId?: string;
    };
    error?: {
      code?: string;
      message?: string;
    } | null;
  };
}

interface DeploymentResponse {
  deployment: {
    baseUrl: string;
  };
}

type WebsiteSourceRequest =
  | {
    kind: 'local';
    path: string;
    taskFile?: string;
  }
  | {
    kind: 'huggingface';
    repoId: string;
    revision?: string;
    website?: string;
    selector?: string;
    site?: string;
    model?: string;
    seed?: string;
  };

interface PreparedWebsiteSource {
  source: WebsiteSourceRequest;
  startPath?: string;
  cleanup?: () => Promise<void>;
}

interface SyntheticWebsiteProvider {
  prepareWebsiteSource(task: TrialTaskConfig): Promise<PreparedWebsiteSource>;
}

const WEBSITE_SERVICE_URL = (process.env.WEBSITE_SERVICE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const SYNTHETIC_WEBSITE_PROVIDER = (process.env.SYNTHETIC_WEBSITE_PROVIDER || 'local').trim().toLowerCase();
const LOCAL_SYNTHETIC_REPO_ROOT = path.resolve(process.env.LOCAL_SYNTHETIC_WEBSITE_REPO_ROOT || SYNTHETIC_WEBSITES_DIR);
const POLL_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 200;

function appendStartPath(baseUrl: string, startPath = '/'): string {
  const url = new URL(baseUrl);
  url.pathname = startPath.startsWith('/') ? startPath : `/${startPath}`;
  return url.toString();
}

async function assertFileExists(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function postJson<T>(url: string, body: unknown, idempotencyKey: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || `Website service returned ${response.status}`);
  }
  return data as T;
}

async function pollOperation(operationId: string): Promise<ArtifactJobResponse['operation']> {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const response = await fetch(`${WEBSITE_SERVICE_URL}/api/v1/artifact-jobs/${encodeURIComponent(operationId)}`, {
      cache: 'no-store',
    });
    const data = await response.json() as ArtifactJobResponse;
    const op = data.operation;
    if (op.status === 'succeeded') return op;
    if (op.status === 'failed_retryable' || op.status === 'failed_terminal') {
      throw new Error(op.error?.message || 'Synthetic website artifact job failed');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for website service artifact job ${operationId}`);
}

class LocalSyntheticWebsiteProvider implements SyntheticWebsiteProvider {
  async prepareWebsiteSource(task: TrialTaskConfig): Promise<PreparedWebsiteSource> {
    const bundleDir = path.join(LOCAL_SYNTHETIC_REPO_ROOT, task.slug);
    const taskFile = path.join(bundleDir, 'trials-config.json');
    await assertFileExists(path.join(bundleDir, 'dist', 'index.html'), 'Local synthetic website entrypoint');
    await assertFileExists(taskFile, 'Local synthetic website task file');

    return {
      source: {
        kind: 'local',
        path: bundleDir,
        taskFile,
      },
      startPath: '/',
    };
  }
}

class HuggingFaceSyntheticWebsiteProvider implements SyntheticWebsiteProvider {
  async prepareWebsiteSource(task: TrialTaskConfig): Promise<PreparedWebsiteSource> {
    const repoId = process.env.SYNTHETIC_HF_REPO_ID?.trim();
    if (!repoId) {
      throw new Error('SYNTHETIC_HF_REPO_ID is required when SYNTHETIC_WEBSITE_PROVIDER=huggingface');
    }

    return {
      source: {
        kind: 'huggingface',
        repoId,
        revision: process.env.SYNTHETIC_HF_REVISION?.trim() || undefined,
        website: process.env.SYNTHETIC_HF_WEBSITE?.trim() || task.group || task.slug,
        selector: process.env.SYNTHETIC_HF_SELECTOR?.trim() || undefined,
        site: process.env.SYNTHETIC_HF_SITE?.trim() || task.slug,
        model: process.env.SYNTHETIC_HF_MODEL?.trim() || undefined,
        seed: process.env.SYNTHETIC_HF_SEED?.trim() || undefined,
      },
      startPath: '/',
    };
  }
}

function createSyntheticWebsiteProvider(): SyntheticWebsiteProvider {
  switch (SYNTHETIC_WEBSITE_PROVIDER) {
    case 'local':
      return new LocalSyntheticWebsiteProvider();
    case 'huggingface':
      return new HuggingFaceSyntheticWebsiteProvider();
    default:
      throw new Error(`Unsupported SYNTHETIC_WEBSITE_PROVIDER: ${SYNTHETIC_WEBSITE_PROVIDER}`);
  }
}

export async function getSyntheticTaskUrl(task: TrialTaskConfig): Promise<string> {
  const provider = createSyntheticWebsiteProvider();
  const prepared = await provider.prepareWebsiteSource(task);
  const suffix = crypto.createHash('sha256')
    .update(`${SYNTHETIC_WEBSITE_PROVIDER}\n${task.slug}\n${task.group}\n${task.task_prompt}\n${task.site_url || ''}`)
    .digest('hex')
    .slice(0, 16);

  try {
    const artifact = await postJson<ArtifactJobResponse>(
      `${WEBSITE_SERVICE_URL}/api/v1/artifact-jobs`,
      prepared.source,
      `synthetic-artifact-${task.slug}-${suffix}`
    );
    const completed = artifact.operation.result?.websiteArtifactId
      ? artifact.operation
      : await pollOperation(artifact.operation.operationId);
    const websiteArtifactId = completed.result?.websiteArtifactId;
    if (!websiteArtifactId) throw new Error('Website service did not return an artifact id');

    const deployment = await postJson<DeploymentResponse>(
      `${WEBSITE_SERVICE_URL}/api/v1/deployments`,
      { websiteArtifactId },
      `synthetic-deployment-${task.slug}-${suffix}`
    );
    return appendStartPath(deployment.deployment.baseUrl, prepared.startPath);
  } finally {
    await prepared.cleanup?.();
  }
}
