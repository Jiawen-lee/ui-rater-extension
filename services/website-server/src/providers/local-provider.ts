import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebsiteTaskDescriptor } from '../../../../packages/contracts/src/index.ts';
import { assertString } from '../../../../packages/contracts/src/index.ts';
import type { ArtifactProvider } from './provider.ts';

function normalizePrompt(value: string): string {
  return value.toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function parseMind2WebPrompts(raw: string): Set<string> {
  return new Set(raw.split(/\r?\n/).map((line) => line.match(/^\s*\d+[.)]\s*(.+?)\s*$/)?.[1])
    .filter((value): value is string => Boolean(value)).map(normalizePrompt));
}

function isMind2Web(task: Record<string, unknown>, sidecar: Set<string>): boolean {
  if (task.is_mind2web === true) return true;
  const metadata = [task.source, task.origin, task.task_source]
    .some((value) => typeof value === 'string' && value.toLowerCase() === 'mind2web');
  return metadata || sidecar.has(normalizePrompt(String(task.task_prompt ?? '')));
}

export async function loadCandidateFromDirectory(sourceDirInput: string, taskFileInput?: string, source: Record<string, unknown> = { kind: 'local' }) {
  const sourceDir = path.resolve(assertString(sourceDirInput, 'source.path', 4_000));
  const stat = await fs.stat(sourceDir).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Website source directory does not exist: ${sourceDir}`);
  const dist = path.join(sourceDir, 'dist');
  if (!(await fs.stat(path.join(dist, 'index.html')).catch(() => undefined))?.isFile()) {
    throw new Error(`Website source has no dist/index.html: ${sourceDir}`);
  }
  const taskFile = path.resolve(taskFileInput ? taskFileInput : path.join(sourceDir, 'trials-config.json'));
  const parsed = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const rawTasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error('Task JSON must contain a non-empty array');
  let sidecar = new Set<string>();
  try { sidecar = parseMind2WebPrompts(await fs.readFile(path.join(path.dirname(taskFile), 'mind2web_tasks.txt'), 'utf8')); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const tasks: WebsiteTaskDescriptor[] = rawTasks.map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Task ${index + 1} must be an object`);
    const row = value as Record<string, unknown>;
    const prompt = String(row.task_prompt ?? row.prompt ?? '').trim();
    if (!prompt) throw new Error(`Task ${index + 1} has no prompt`);
    const startPathRaw = typeof row.start_path === 'string' ? row.start_path : typeof row.startPath === 'string' ? row.startPath : '/';
    const startPath = startPathRaw.startsWith('/') ? startPathRaw : `/${startPathRaw}`;
    return {
      websiteTaskId: `source-${index + 1}`,
      sourcePosition: index + 1,
      prompt,
      slug: String(row.slug ?? `task-${index + 1}`),
      group: String(row.group ?? row.website ?? path.basename(sourceDir)),
      startPath,
      isMind2Web: isMind2Web(row, sidecar),
      taskSource: typeof row.task_source === 'string' ? row.task_source : typeof row.source === 'string' ? row.source : undefined,
      legacyAppId: typeof row.plain_app === 'string' ? row.plain_app : undefined,
      suggestedFlows: Array.isArray(row.suggested_flows) ? row.suggested_flows.filter((flow): flow is string => typeof flow === 'string') : [],
    };
  });
  return {
    sourceDir,
    taskFile,
    website: String((rawTasks[0] as Record<string, unknown>)?.group ?? path.basename(sourceDir)),
    tasks,
    source,
  };
}

export class LocalProvider implements ArtifactProvider {
  async resolve(source: Record<string, unknown>): Promise<ReturnType<typeof loadCandidateFromDirectory> extends Promise<infer T> ? T : never> {
    return loadCandidateFromDirectory(
      assertString(source.path, 'source.path', 4_000),
      typeof source.taskFile === 'string' ? source.taskFile : undefined,
      { kind: 'local' },
    );
  }
}
