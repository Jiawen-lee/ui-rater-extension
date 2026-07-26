import { asRecord, assertId, assertPositiveInteger, assertString, optionalString } from './common.ts';

export type StudyStatus = 'draft' | 'publishing' | 'ready' | 'retiring' | 'retired';
export type PublicationStep =
  | 'specification_frozen'
  | 'artifact_requested'
  | 'artifact_ready'
  | 'deployment_ready'
  | 'revision_prepared'
  | 'collection_registered'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal';

export interface StudyWebsiteSource {
  kind: 'artifact' | 'huggingface';
  websiteArtifactId?: string;
  websiteAcquisitionId?: string;
  repoId?: string;
  revision?: string;
  website?: string;
  selector?: string;
  model?: string;
}

export interface StudyTaskSelector {
  kind: 'all' | 'positions' | 'random' | 'mind2web';
  positions?: number[];
  count?: number;
  seed?: string;
}

export interface StudySpecification {
  schemaVersion: 1;
  studyId: string;
  websiteSource: StudyWebsiteSource;
  taskSelector: StudyTaskSelector;
}

function parseSource(value: unknown): StudyWebsiteSource {
  const row = asRecord(value, 'websiteSource');
  const kind = row.kind;
  if (!['artifact', 'huggingface'].includes(String(kind))) throw new Error('Unsupported website source kind');
  const source: StudyWebsiteSource = { kind: kind as StudyWebsiteSource['kind'] };
  if (kind === 'artifact') {
    source.websiteArtifactId = assertId(row.websiteArtifactId, 'websiteSource.websiteArtifactId');
    source.websiteAcquisitionId = assertId(row.websiteAcquisitionId, 'websiteSource.websiteAcquisitionId');
  } else if (kind === 'huggingface') {
    source.repoId = assertString(row.repoId, 'websiteSource.repoId', 500);
    source.revision = optionalString(row.revision, 'websiteSource.revision', 500);
    source.website = optionalString(row.website, 'websiteSource.website', 500);
    source.selector = optionalString(row.selector, 'websiteSource.selector', 1_000);
    source.model = optionalString(row.model, 'websiteSource.model', 500);
  }
  return source;
}

function parseSelector(value: unknown): StudyTaskSelector {
  const row = asRecord(value, 'taskSelector');
  const kind = row.kind;
  if (!['all', 'positions', 'random', 'mind2web'].includes(String(kind))) throw new Error('Unsupported task selector kind');
  const selector: StudyTaskSelector = { kind: kind as StudyTaskSelector['kind'] };
  if (kind === 'positions') {
    if (!Array.isArray(row.positions) || row.positions.length === 0) throw new Error('taskSelector.positions is required');
    selector.positions = row.positions.map((value, index) => assertPositiveInteger(value, `taskSelector.positions[${index}]`));
    if (new Set(selector.positions).size !== selector.positions.length) throw new Error('taskSelector.positions contains duplicates');
  }
  if (kind === 'random') {
    selector.count = assertPositiveInteger(row.count, 'taskSelector.count');
    selector.seed = assertString(row.seed, 'taskSelector.seed', 500);
  }
  if (row.seed !== undefined && selector.seed === undefined) selector.seed = assertString(row.seed, 'taskSelector.seed', 500);
  return selector;
}

export function validateStudySpecification(value: unknown): StudySpecification {
  const row = asRecord(value, 'study specification');
  if (row.schemaVersion !== 1) throw new Error('Unsupported study specification schemaVersion');
  return {
    schemaVersion: 1,
    studyId: assertId(row.studyId, 'studyId'),
    websiteSource: parseSource(row.websiteSource),
    taskSelector: parseSelector(row.taskSelector),
  };
}
