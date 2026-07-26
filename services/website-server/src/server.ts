import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  ContractError, errorEnvelope, validateWebsiteDeployment, validateWebsiteSourceRequest,
} from '../../../packages/contracts/src/index.ts';
import { loadConfig, type WebsiteConfig } from './config.ts';
import { ArtifactStore } from './storage/artifact-store.ts';
import { DeploymentStore } from './storage/deployment-store.ts';
import { OperationStore, type ArtifactJobRecord } from './storage/operation-store.ts';
import { HuggingFaceProvider } from './providers/huggingface-provider.ts';
import { LocalProvider } from './providers/local-provider.ts';
import { ProviderError } from './providers/provider.ts';
import { serveDeployment } from './static/site-handler.ts';
import { ensureDir, writeJsonAtomic } from './storage/json-store.ts';
import { acquireWebsiteRootLease } from './storage/root-lease.ts';

interface WebsiteRuntime {
  config: WebsiteConfig;
  artifacts: ArtifactStore;
  deployments: DeploymentStore;
  operations: OperationStore;
  jobQueue: ArtifactJobRecord[];
  scheduledJobIds: Set<string>;
  activeJobs: number;
  maxConcurrentJobs: number;
}

function statusForError(error: unknown): number {
  if (error instanceof ContractError) {
    if (error.code.endsWith('_not_found')) return 404;
    if (error.code.includes('idempotency') || error.code.includes('conflict') || error.code.includes('not_retryable')) return 409;
    if (error.retryable) return 503;
    return 400;
  }
  if (error instanceof ProviderError) return error.retryable ? 503 : 400;
  if (error instanceof Error && /not found/i.test(error.message)) return 404;
  if (error instanceof Error && /idempotency|already bound|released/i.test(error.message)) return 409;
  return 500;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  if (status === 204) { response.writeHead(status); response.end(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 2 * 1024 * 1024) throw new ContractError('request_too_large', 'Request body exceeds 2 MB');
  }
  if (!raw.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new ContractError('invalid_json', 'Request body is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid_json', 'JSON body must be an object');
  return value as Record<string, unknown>;
}

function operationBody(record: ArtifactJobRecord) {
  return {
    operation: {
      operationId: record.operationId,
      status: record.status,
      step: record.status === 'succeeded' ? 'artifact_ready' : 'resolve_artifact',
      result: record.status === 'succeeded' ? {
        websiteArtifactId: record.websiteArtifactId,
        websiteAcquisitionId: record.websiteAcquisitionId,
      } : undefined,
      error: record.error || null,
    },
  };
}

async function runArtifactJob(runtime: WebsiteRuntime, record: ArtifactJobRecord): Promise<void> {
  const running = await runtime.operations.claimQueued(record.operationId);
  if (!running) return;
  const staging = path.join(runtime.config.dataDir, 'staging', running.operationId);
  await ensureDir(staging);
  try {
    const kind = String(running.source.kind || '');
    const provider = kind === 'local'
      ? new LocalProvider()
      : kind === 'huggingface'
      ? new HuggingFaceProvider(runtime.config)
      : undefined;
    if (!provider) throw new ContractError('invalid_source_kind', `Unsupported website source kind: ${kind}`);
    const candidate = await provider.resolve({ ...running.source }, staging);
    const result = await runtime.artifacts.importCandidate(candidate, running.operationId);
    await runtime.operations.update(running, {
      status: 'succeeded',
      websiteArtifactId: result.artifact.websiteArtifactId,
      websiteAcquisitionId: result.acquisition.websiteAcquisitionId,
    });
  } catch (error: unknown) {
    const retryable = error instanceof ProviderError ? error.retryable : false;
    await runtime.operations.update(running, {
      status: retryable ? 'failed_retryable' : 'failed_terminal',
      error: {
        code: error instanceof ProviderError ? error.code : error instanceof ContractError ? error.code : 'artifact_job_failed',
        message: error instanceof Error ? error.message : 'Artifact job failed',
        retryable,
      },
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function drainArtifactJobs(runtime: WebsiteRuntime): void {
  while (runtime.activeJobs < runtime.maxConcurrentJobs && runtime.jobQueue.length > 0) {
    const record = runtime.jobQueue.shift()!;
    runtime.activeJobs += 1;
    void runArtifactJob(runtime, record).finally(() => {
      runtime.activeJobs -= 1;
      runtime.scheduledJobIds.delete(record.operationId);
      drainArtifactJobs(runtime);
    });
  }
}

function scheduleArtifactJob(runtime: WebsiteRuntime, record: ArtifactJobRecord): void {
  if (runtime.scheduledJobIds.has(record.operationId)) return;
  runtime.scheduledJobIds.add(record.operationId);
  runtime.jobQueue.push(record);
  drainArtifactJobs(runtime);
}

async function routeApi(runtime: WebsiteRuntime, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method || 'GET';
  if (method === 'GET' && url.pathname === '/api/v1/health/live') {
    sendJson(response, 200, { ok: true, service: 'website', serviceInstanceId: runtime.config.serviceInstanceId });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/v1/health/ready') {
    await Promise.all([
      fs.access(runtime.artifacts.artifactsDir, 2),
      fs.access(runtime.artifacts.acquisitionsDir, 2),
      fs.access(runtime.deployments.dir, 2),
      fs.access(runtime.operations.dir, 2),
      runtime.deployments.list(),
      runtime.operations.list(),
    ]);
    sendJson(response, 200, { ok: true, service: 'website', serviceInstanceId: runtime.config.serviceInstanceId });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/v1/artifact-jobs') {
    let source;
    try { source = validateWebsiteSourceRequest(await readBody(request)); }
    catch (error: unknown) {
      throw new ContractError('invalid_website_source', error instanceof Error ? error.message : 'Invalid website source');
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) throw new ContractError('missing_idempotency_key', 'Idempotency-Key is required');
    const created = await runtime.operations.create(source, key);
    if (created.created) scheduleArtifactJob(runtime, created.record);
    sendJson(response, created.created ? 202 : 202, operationBody(created.record));
    return;
  }
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'artifact-jobs' && parts[3]) {
    const operation = await runtime.operations.get(parts[3]);
    if (!operation) throw new ContractError('artifact_job_not_found', 'Artifact job not found');
    if (method === 'GET' && parts.length === 4) { sendJson(response, 200, operationBody(operation)); return; }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'retry') {
      if (operation.status !== 'failed_retryable') throw new ContractError('artifact_job_not_retryable', 'Artifact job is not retryable');
      const queued = await runtime.operations.queueRetry(operation.operationId);
      scheduleArtifactJob(runtime, queued);
      sendJson(response, 202, operationBody(queued));
      return;
    }
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'artifacts' && parts[3]) {
    const artifact = await runtime.artifacts.get(parts[3]);
    if (!artifact) throw new ContractError('website_artifact_not_found', 'Website artifact not found');
    sendJson(response, 200, { artifact });
    return;
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'acquisitions' && parts[3]) {
    const acquisition = await runtime.artifacts.getAcquisition(parts[3]);
    if (!acquisition) throw new ContractError('website_acquisition_not_found', 'Website acquisition not found');
    sendJson(response, 200, { acquisition });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/v1/deployments') {
    const body = await readBody(request);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) throw new ContractError('missing_idempotency_key', 'Idempotency-Key is required');
    const artifactId = String(body.websiteArtifactId || '');
    const artifact = await runtime.artifacts.get(artifactId);
    if (!artifact) throw new ContractError('website_artifact_not_found', 'Website artifact not found');
    const result = await runtime.deployments.create(artifact, key);
    sendJson(response, result.created ? 201 : 200, { deployment: validateWebsiteDeployment(result.deployment) });
    return;
  }
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'deployments' && parts[3]) {
    if (method === 'GET') {
      const deployment = await runtime.deployments.get(parts[3]);
      if (!deployment) throw new ContractError('website_deployment_not_found', 'Website deployment not found');
      sendJson(response, 200, { deployment });
      return;
    }
    if (method === 'DELETE') {
      const deployment = await runtime.deployments.release(parts[3]);
      sendJson(response, 204, undefined);
      return;
    }
  }
  throw new ContractError('route_not_found', 'Website API route not found');
}

export async function createWebsiteServer(inputConfig?: WebsiteConfig) {
  const config = inputConfig || await loadConfig();
  const rootLease = await acquireWebsiteRootLease(config.dataDir, config.serviceInstanceId);
  const artifacts = new ArtifactStore(config);
  const deployments = new DeploymentStore(config);
  const operations = new OperationStore(config);
  try {
    await Promise.all([artifacts.init(), deployments.init(), operations.init()]);
    // A process restart cannot safely resume a provider call that may have been
    // interrupted halfway through. Mark stale in-flight jobs retryable so the
    // Manager can recover them with the same idempotency key.
    for (const operation of await operations.list()) {
      if (operation.status === 'running') {
        await operations.update(operation, {
          status: 'failed_retryable',
          error: {
            code: 'artifact_job_interrupted',
            message: 'Artifact job was interrupted by a Website Service restart',
            retryable: true,
          },
        });
      }
    }
  } catch (error) {
    await rootLease.release();
    throw error;
  }
  const runtime: WebsiteRuntime = {
    config, artifacts, deployments, operations,
    jobQueue: [], scheduledJobIds: new Set(), activeJobs: 0, maxConcurrentJobs: 2,
  };
  for (const operation of await operations.list()) {
    if (operation.status === 'queued') scheduleArtifactJob(runtime, operation);
  }
  const server = http.createServer(async (request, response) => {
    try {
      const host = String(request.headers.host || '').toLowerCase();
      const runtimeHandled = await serveDeployment(request, response, { artifacts, deployments }, config.runtimeSuffix);
      if (runtimeHandled) return;
      if (!(host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost')) {
        sendJson(response, 404, { error: { code: 'unknown_origin', message: 'Unknown Website Service origin', retryable: false } });
        return;
      }
      await routeApi(runtime, request, response, new URL(request.url || '/', `http://${host || '127.0.0.1'}`));
    } catch (error: unknown) {
      const envelope = errorEnvelope(error);
      sendJson(response, statusForError(error), envelope);
    }
  });
  server.once('close', () => { void rootLease.release(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => resolve());
    });
  } catch (error) {
    await rootLease.release();
    throw error;
  }
  const address = server.address();
  if (address && typeof address !== 'string' && address.port > 0) config.port = address.port;
  return { server, runtime };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runtime } = await createWebsiteServer();
  console.log(`Website Service listening on http://${runtime.config.host}:${runtime.config.port}`);
}
