import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR, SERVER_DATA_DIR, SYNTHETIC_WEBSITES_DIR } from '@/lib/paths';
import type { TrialConfigEntry } from '@/types';

interface TrialTaskConfig {
  slug: string;
  group: string;
  plain_app?: string;
  task_prompt: string;
  site_url?: string;
  start_path?: string;
  startPath?: string;
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
const LOCAL_SYNTHETIC_REPO_ROOTS = [
  process.env.LOCAL_SYNTHETIC_WEBSITE_REPO_ROOT,
  path.join(SERVER_DATA_DIR, 'website-generation', 'runs', 'current'),
  path.join(DATA_DIR, 'website-generation', 'runs', 'current'),
  SYNTHETIC_WEBSITES_DIR,
  path.join(SERVER_DATA_DIR, 'synthetic-websites'),
].filter((value): value is string => Boolean(value?.trim())).map((value) => path.resolve(value));
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

async function fileExists(filePath: string): Promise<boolean> {
  return Boolean((await fs.stat(filePath).catch(() => undefined))?.isFile());
}

async function directoryExists(dirPath: string): Promise<boolean> {
  return Boolean((await fs.stat(dirPath).catch(() => undefined))?.isDirectory());
}

async function isRunnableWebsiteDirectory(dirPath: string): Promise<boolean> {
  return fileExists(path.join(dirPath, 'dist', 'index.html'));
}

async function candidateRunDirectories(root: string, task?: Partial<TrialTaskConfig>): Promise<string[]> {
  const names = [task?.plain_app, task?.slug, task?.group]
    .filter((value): value is string => Boolean(value?.trim()));
  const candidates = new Set<string>();

  candidates.add(root);
  for (const name of names) {
    candidates.add(path.join(root, name));
  }

  for (const name of names) {
    const groupDir = path.join(root, name);
    const children = await fs.readdir(groupDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isDirectory()) candidates.add(path.join(groupDir, child.name));
    }
  }

  return [...candidates].sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

async function findLocalRunDirectory(task: Partial<TrialTaskConfig>): Promise<string> {
  for (const root of LOCAL_SYNTHETIC_REPO_ROOTS) {
    if (!(await directoryExists(root))) continue;
    for (const candidate of await candidateRunDirectories(root, task)) {
      if (await isRunnableWebsiteDirectory(candidate)) return candidate;
    }
  }

  throw new Error(
    `Local synthetic website not found for ${task.plain_app || task.slug || task.group || 'unknown task'} `
    + `under ${LOCAL_SYNTHETIC_REPO_ROOTS.join(', ')}`
  );
}

function normalizeStartPath(value?: string): string {
  const startPath = value?.trim() || '/';
  return startPath.startsWith('/') ? startPath : `/${startPath}`;
}

async function readTrialConfig(taskFile: string): Promise<TrialConfigEntry[]> {
  const parsed = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const rawTasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks.map((value: unknown, index: number) => {
    const row = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return {
      slug: String(row.slug || `task-${index + 1}`),
      group: String(row.group || row.website || path.basename(path.dirname(taskFile))),
      plain_app: String(row.plain_app || path.basename(path.dirname(taskFile))),
      task_prompt: String(row.task_prompt || row.prompt || ''),
      site_url: typeof row.site_url === 'string' ? row.site_url : '',
      defects: Array.isArray(row.defects) ? row.defects as TrialConfigEntry['defects'] : [],
      suggested_flows: Array.isArray(row.suggested_flows)
        ? row.suggested_flows.filter((flow): flow is string => typeof flow === 'string')
        : [],
      start_path: normalizeStartPath(
        typeof row.start_path === 'string' ? row.start_path : typeof row.startPath === 'string' ? row.startPath : '/'
      ),
    };
  });
}

export async function getSyntheticTrialConfigs(): Promise<TrialConfigEntry[]> {
  const configs: TrialConfigEntry[] = [];
  const seenTaskFiles = new Set<string>();

  for (const root of LOCAL_SYNTHETIC_REPO_ROOTS) {
    if (!(await directoryExists(root))) continue;
    const groups = await fs.readdir(root, { withFileTypes: true });
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(root, group.name);
      const runs = await fs.readdir(groupDir, { withFileTypes: true }).catch(() => []);
      const runDirs = await isRunnableWebsiteDirectory(groupDir)
        ? [groupDir]
        : runs.filter((entry) => entry.isDirectory()).map((entry) => path.join(groupDir, entry.name));
      for (const runDir of runDirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a)))) {
        const taskFile = path.join(runDir, 'trials-config.json');
        if (seenTaskFiles.has(taskFile) || !(await isRunnableWebsiteDirectory(runDir)) || !(await fileExists(taskFile))) continue;
        seenTaskFiles.add(taskFile);
        configs.push(...await readTrialConfig(taskFile));
        break;
      }
    }
    if (configs.length > 0) break;
  }

  if (configs.length === 0) {
    throw new Error(`No local synthetic website-generation runs found under ${LOCAL_SYNTHETIC_REPO_ROOTS.join(', ')}`);
  }

  return configs;
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
    const bundleDir = await findLocalRunDirectory(task);
    const taskFile = path.join(bundleDir, 'trials-config.json');
    await assertFileExists(path.join(bundleDir, 'dist', 'index.html'), 'Local synthetic website entrypoint');
    await assertFileExists(taskFile, 'Local synthetic website task file');

    return {
      source: {
        kind: 'local',
        path: bundleDir,
        taskFile,
      },
      startPath: normalizeStartPath(task.start_path || task.startPath),
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
    .update(JSON.stringify({
      provider: SYNTHETIC_WEBSITE_PROVIDER,
      source: prepared.source,
      startPath: prepared.startPath || '/',
    }))
    .digest('hex')
    .slice(0, 16);
  const idLabel = (task.plain_app || task.group || task.slug).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80);

  try {
    const artifact = await postJson<ArtifactJobResponse>(
      `${WEBSITE_SERVICE_URL}/api/v1/artifact-jobs`,
      prepared.source,
      `synthetic-artifact-${idLabel}-${suffix}`
    );
    const completed = artifact.operation.result?.websiteArtifactId
      ? artifact.operation
      : await pollOperation(artifact.operation.operationId);
    const websiteArtifactId = completed.result?.websiteArtifactId;
    if (!websiteArtifactId) throw new Error('Website service did not return an artifact id');

    const deployment = await postJson<DeploymentResponse>(
      `${WEBSITE_SERVICE_URL}/api/v1/deployments`,
      { websiteArtifactId },
      `synthetic-deployment-${idLabel}-${suffix}`
    );
    return appendStartPath(deployment.deployment.baseUrl, prepared.startPath);
  } finally {
    await prepared.cleanup?.();
  }
}
