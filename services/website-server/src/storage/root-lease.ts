import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../../../../packages/contracts/src/index.ts';
import { ensureDir } from './json-store.ts';

interface LeaseRecord {
  pid: number;
  nonce: string;
  serviceInstanceId: string;
  acquiredAt: string;
}

const heldRoots = new Set<string>();

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function acquireWebsiteRootLease(dataDir: string, serviceInstanceId: string): Promise<{ release: () => Promise<void> }> {
  await ensureDir(dataDir);
  const leasePath = path.join(dataDir, '.website-service.lock');
  const rootKey = path.resolve(dataDir);
  const record: LeaseRecord = {
    pid: process.pid,
    nonce: randomUUID(),
    serviceInstanceId,
    acquiredAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(leasePath, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      heldRoots.add(rootKey);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          heldRoots.delete(rootKey);
          const current = await fs.readFile(leasePath, 'utf8').then((raw) => JSON.parse(raw) as LeaseRecord).catch(() => undefined);
          if (current?.nonce === record.nonce) await fs.unlink(leasePath).catch(() => {});
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await fs.readFile(leasePath, 'utf8').then((raw) => JSON.parse(raw) as Partial<LeaseRecord>).catch(() => undefined);
      if (typeof current?.pid === 'number'
        && (current.pid !== process.pid || heldRoots.has(rootKey))
        && processIsAlive(current.pid)) {
        throw new ContractError(
          'website_data_root_in_use',
          `Website data root is already owned by process ${current.pid}`,
        );
      }
      await fs.unlink(leasePath).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      });
    }
  }
  throw new ContractError('website_data_root_in_use', 'Website data root lease could not be acquired');
}
