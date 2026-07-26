import {
  asRecord, assertHttpUrl, assertId, assertPositiveInteger, assertString,
  optionalString,
} from './common.ts';

export type WebsiteSourceKind = 'local' | 'huggingface';

export interface LocalWebsiteSourceRequest {
  kind: 'local';
  path: string;
  taskFile?: string;
}

export interface HuggingFaceWebsiteSourceRequest {
  kind: 'huggingface';
  repoId: string;
  revision?: string;
  website?: string;
  selector?: string;
  site?: string;
  model?: string;
  seed?: string;
}

export type WebsiteSourceRequest = LocalWebsiteSourceRequest | HuggingFaceWebsiteSourceRequest;

export interface WebsiteTaskDescriptor {
  websiteTaskId: string;
  sourcePosition: number;
  prompt: string;
  slug: string;
  group: string;
  startPath: string;
  isMind2Web?: boolean;
  taskSource?: string;
  legacyAppId?: string;
  suggestedFlows: string[];
}

export interface WebsiteArtifactDescriptor {
  schemaVersion: 1;
  websiteArtifactId: string;
  artifactDigest: string;
  website: string;
  createdAt: string;
  tasks: WebsiteTaskDescriptor[];
}

export interface WebsiteAcquisitionDescriptor {
  schemaVersion: 1;
  websiteAcquisitionId: string;
  websiteArtifactId: string;
  artifactDigest: string;
  source: {
    kind: WebsiteSourceKind;
    repoId?: string;
    revision?: string;
    commitSha?: string;
    sourceUrl?: string;
  };
  resolvedAt: string;
}

export type DeploymentStatus = 'ready' | 'released';

export interface WebsiteDeploymentDescriptor {
  schemaVersion: 1;
  websiteDeploymentId: string;
  websiteArtifactId: string;
  artifactDigest: string;
  routingLabel: string;
  baseUrl: string;
  status: DeploymentStatus;
  createdAt: string;
}

export function validateWebsiteSourceRequest(value: unknown): WebsiteSourceRequest {
  const row = asRecord(value, 'website source');
  if (row.kind === 'local') {
    return {
      kind: 'local',
      path: assertString(row.path, 'source.path', 4_000),
      taskFile: optionalString(row.taskFile, 'source.taskFile', 4_000),
    };
  }
  if (row.kind === 'huggingface') {
    return {
      kind: 'huggingface',
      repoId: assertString(row.repoId, 'source.repoId', 500),
      revision: optionalString(row.revision, 'source.revision', 500),
      website: optionalString(row.website, 'source.website', 500),
      selector: optionalString(row.selector, 'source.selector', 1_000),
      site: optionalString(row.site, 'source.site', 500),
      model: optionalString(row.model, 'source.model', 500),
      seed: optionalString(row.seed, 'source.seed', 500),
    };
  }
  throw new Error('Unsupported website source kind');
}

function parseTask(value: unknown, index: number): WebsiteTaskDescriptor {
  const row = asRecord(value, `tasks[${index}]`);
  const startPath = assertString(row.startPath ?? '/', `tasks[${index}].startPath`, 2_000);
  if (!startPath.startsWith('/')) throw new Error(`tasks[${index}].startPath must start with /`);
  const flows = row.suggestedFlows === undefined ? [] : row.suggestedFlows;
  if (!Array.isArray(flows) || flows.some((flow) => typeof flow !== 'string' || flow.length > 2_000)) {
    throw new Error(`tasks[${index}].suggestedFlows must be an array of strings`);
  }
  return {
    websiteTaskId: assertId(row.websiteTaskId, `tasks[${index}].websiteTaskId`),
    sourcePosition: assertPositiveInteger(row.sourcePosition, `tasks[${index}].sourcePosition`),
    prompt: assertString(row.prompt, `tasks[${index}].prompt`, 10_000),
    slug: assertString(row.slug, `tasks[${index}].slug`, 1_000),
    group: assertString(row.group, `tasks[${index}].group`, 500),
    startPath,
    isMind2Web: row.isMind2Web === undefined ? undefined : Boolean(row.isMind2Web),
    taskSource: optionalString(row.taskSource, `tasks[${index}].taskSource`, 200),
    legacyAppId: optionalString(row.legacyAppId, `tasks[${index}].legacyAppId`, 500),
    suggestedFlows: flows as string[],
  };
}

export function validateWebsiteArtifact(value: unknown): WebsiteArtifactDescriptor {
  const row = asRecord(value, 'website artifact');
  if (row.schemaVersion !== 1) throw new Error('Unsupported website artifact schemaVersion');
  if (!Array.isArray(row.tasks) || row.tasks.length === 0) throw new Error('Website artifact must contain tasks');
  const tasks = row.tasks.map(parseTask);
  const positions = new Set<number>();
  const ids = new Set<string>();
  for (const task of tasks) {
    if (positions.has(task.sourcePosition)) throw new Error('Website artifact has duplicate source positions');
    if (ids.has(task.websiteTaskId)) throw new Error('Website artifact has duplicate task IDs');
    positions.add(task.sourcePosition);
    ids.add(task.websiteTaskId);
  }
  return {
    schemaVersion: 1,
    websiteArtifactId: assertId(row.websiteArtifactId, 'websiteArtifactId'),
    artifactDigest: assertString(row.artifactDigest, 'artifactDigest', 200),
    website: assertString(row.website, 'website', 500),
    createdAt: assertString(row.createdAt, 'createdAt', 100),
    tasks,
  };
}

export function validateWebsiteAcquisition(value: unknown): WebsiteAcquisitionDescriptor {
  const row = asRecord(value, 'website acquisition');
  if (row.schemaVersion !== 1) throw new Error('Unsupported website acquisition schemaVersion');
  const source = asRecord(row.source, 'source');
  const kind = source.kind;
  if (!['local', 'huggingface'].includes(String(kind))) throw new Error('Invalid acquisition source kind');
  return {
    schemaVersion: 1,
    websiteAcquisitionId: assertId(row.websiteAcquisitionId, 'websiteAcquisitionId'),
    websiteArtifactId: assertId(row.websiteArtifactId, 'websiteArtifactId'),
    artifactDigest: assertString(row.artifactDigest, 'artifactDigest', 200),
    source: {
      kind: kind as WebsiteSourceKind,
      repoId: optionalString(source.repoId, 'source.repoId'),
      revision: optionalString(source.revision, 'source.revision'),
      commitSha: optionalString(source.commitSha, 'source.commitSha'),
      sourceUrl: source.sourceUrl === undefined ? undefined : assertHttpUrl(source.sourceUrl, 'source.sourceUrl'),
    },
    resolvedAt: assertString(row.resolvedAt, 'resolvedAt', 100),
  };
}

export function validateWebsiteDeployment(value: unknown): WebsiteDeploymentDescriptor {
  const row = asRecord(value, 'website deployment');
  if (row.schemaVersion !== 1) throw new Error('Unsupported website deployment schemaVersion');
  const status = row.status;
  if (status !== 'ready' && status !== 'released') throw new Error('Invalid deployment status');
  return {
    schemaVersion: 1,
    websiteDeploymentId: assertId(row.websiteDeploymentId, 'websiteDeploymentId'),
    websiteArtifactId: assertId(row.websiteArtifactId, 'websiteArtifactId'),
    artifactDigest: assertString(row.artifactDigest, 'artifactDigest', 200),
    routingLabel: assertString(row.routingLabel, 'routingLabel', 100),
    baseUrl: assertHttpUrl(row.baseUrl, 'baseUrl'),
    status,
    createdAt: assertString(row.createdAt, 'createdAt', 100),
  };
}
