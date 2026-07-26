import { asRecord, assertHttpUrl, assertId, assertPositiveInteger, assertString, optionalString } from './common.ts';

export interface StudyRevisionTask {
  websiteTaskId: string;
  sourcePosition: number;
  position: number;
  prompt: string;
  slug: string;
  group: string;
  targetUrl: string;
  isMind2Web?: boolean;
  taskSource?: string;
  legacyAppId?: string;
  suggestedFlows: string[];
}

export interface StudyRevisionDescriptor {
  schemaVersion: 1;
  studyId: string;
  studyRevisionId: string;
  website: {
    websiteDeploymentId: string;
    websiteArtifactId: string;
    websiteAcquisitionId: string;
    artifactDigest: string;
    baseUrl: string;
    provenance: Record<string, unknown>;
  };
  tasks: StudyRevisionTask[];
  publishedAt: string;
}

export type StudyAdmission = 'accepting' | 'closed' | 'retired';

export interface CollectionStudyRegistration {
  studyRevisionId: string;
  revisionDigest: string;
  admission: StudyAdmission;
}

function parseTask(value: unknown, index: number): StudyRevisionTask {
  const row = asRecord(value, `study.tasks[${index}]`);
  const flows = row.suggestedFlows === undefined ? [] : row.suggestedFlows;
  if (!Array.isArray(flows) || flows.some((flow) => typeof flow !== 'string')) {
    throw new Error(`study.tasks[${index}].suggestedFlows must be an array`);
  }
  return {
    websiteTaskId: assertId(row.websiteTaskId, `study.tasks[${index}].websiteTaskId`),
    sourcePosition: assertPositiveInteger(row.sourcePosition, `study.tasks[${index}].sourcePosition`),
    position: assertPositiveInteger(row.position, `study.tasks[${index}].position`),
    prompt: assertString(row.prompt, `study.tasks[${index}].prompt`, 10_000),
    slug: assertString(row.slug, `study.tasks[${index}].slug`, 1_000),
    group: assertString(row.group, `study.tasks[${index}].group`, 500),
    targetUrl: assertHttpUrl(row.targetUrl, `study.tasks[${index}].targetUrl`),
    isMind2Web: row.isMind2Web === undefined ? undefined : Boolean(row.isMind2Web),
    taskSource: optionalString(row.taskSource, `study.tasks[${index}].taskSource`, 200),
    legacyAppId: optionalString(row.legacyAppId, `study.tasks[${index}].legacyAppId`, 500),
    suggestedFlows: flows as string[],
  };
}

export function validateStudyRevision(value: unknown): StudyRevisionDescriptor {
  const row = asRecord(value, 'study revision');
  if (row.schemaVersion !== 1) throw new Error('Unsupported study revision schemaVersion');
  if (!Array.isArray(row.tasks) || row.tasks.length === 0) throw new Error('Study revision must contain tasks');
  const tasks = row.tasks.map(parseTask);
  const positions = new Set<number>();
  for (const task of tasks) {
    if (positions.has(task.position)) throw new Error('Study revision has duplicate positions');
    positions.add(task.position);
  }
  const website = asRecord(row.website, 'study.website');
  return {
    schemaVersion: 1,
    studyId: assertId(row.studyId, 'studyId'),
    studyRevisionId: assertId(row.studyRevisionId, 'studyRevisionId'),
    website: {
      websiteDeploymentId: assertId(website.websiteDeploymentId, 'website.websiteDeploymentId'),
      websiteArtifactId: assertId(website.websiteArtifactId, 'website.websiteArtifactId'),
      websiteAcquisitionId: assertId(website.websiteAcquisitionId, 'website.websiteAcquisitionId'),
      artifactDigest: assertString(website.artifactDigest, 'website.artifactDigest', 200),
      baseUrl: assertHttpUrl(website.baseUrl, 'website.baseUrl'),
      provenance: asRecord(website.provenance ?? {}, 'website.provenance'),
    },
    tasks,
    publishedAt: assertString(row.publishedAt, 'publishedAt', 100),
  };
}

export function validateCollectionRegistration(value: unknown): CollectionStudyRegistration {
  const row = asRecord(value, 'collection registration');
  const admission = row.admission;
  if (!['accepting', 'closed', 'retired'].includes(String(admission))) throw new Error('Invalid study admission');
  return {
    studyRevisionId: assertId(row.studyRevisionId, 'studyRevisionId'),
    revisionDigest: assertString(row.revisionDigest, 'revisionDigest', 200),
    admission: admission as StudyAdmission,
  };
}
