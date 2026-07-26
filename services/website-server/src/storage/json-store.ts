import fs from 'node:fs/promises';
import path from 'node:path';

const locks = new Map<string, Promise<void>>();

export function withJsonStoreLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.then(() => {}, () => {});
  locks.set(key, settled);
  return next.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const handle = await fs.open(temp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await syncDir(path.dirname(file));
}

export async function syncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function listJson<T>(dir: string): Promise<T[]> {
  const names = await fs.readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const values: T[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
    const value = await readJson<T>(path.join(dir, name));
    if (value !== undefined) values.push(value);
  }
  return values;
}
