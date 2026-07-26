import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

export interface WebsiteConfig {
  dataDir: string;
  port: number;
  host: string;
  runtimeSuffix: string;
  repoDir: string;
  serviceInstanceId: string;
}

async function readOrCreateInstanceId(file: string): Promise<string> {
  try { return (await fs.readFile(file, 'utf8')).trim(); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const id = `wsi_${randomUUID().replaceAll('-', '')}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${id}\n`, { encoding: 'utf8', flag: 'wx' }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return (await fs.readFile(file, 'utf8')).trim();
}

export async function loadConfig(): Promise<WebsiteConfig> {
  const dataDir = path.resolve(process.env.WEBSITE_SERVICE_DATA_DIR || path.join(process.cwd(), 'data', 'website-service'));
  const serviceInstanceId = await readOrCreateInstanceId(path.join(dataDir, 'service-instance-id'));
  const port = Number(process.env.WEBSITE_SERVICE_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('WEBSITE_SERVICE_PORT must be a valid port');
  return {
    dataDir,
    port,
    host: process.env.WEBSITE_SERVICE_HOST || '127.0.0.1',
    runtimeSuffix: process.env.WEBSITE_RUNTIME_SUFFIX || '.localhost',
    repoDir: path.resolve(process.env.UI_RATER_REPO_DIR || path.join(process.cwd(), '..', '..')),
    serviceInstanceId,
  };
}
