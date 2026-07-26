import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createWebsiteServer } from '../src/server.ts';
import type { WebsiteConfig } from '../src/config.ts';
import { OperationStore } from '../src/storage/operation-store.ts';

interface ArtifactOperationEnvelope {
  operation: {
    status: string;
    result?: { websiteArtifactId: string; websiteAcquisitionId?: string };
    error?: { code?: string; message?: string } | null;
  };
}

async function waitForOperation(api: string, operationId: string, timeout = 5_000): Promise<ArtifactOperationEnvelope> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const response = await fetch(`${api}/api/v1/artifact-jobs/${operationId}`);
    const value = await response.json() as ArtifactOperationEnvelope;
    if (value.operation.status === 'succeeded') return value;
    if (value.operation.status === 'failed_retryable' || value.operation.status === 'failed_terminal') {
      throw new Error(
        `Website Service operation ${value.operation.status}: `
        + `${value.operation.error?.code || 'unknown_error'}: ${value.operation.error?.message || 'no error message'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Website Service operation ${operationId}`);
}

async function requestWithHost(port: number, pathname: string, host: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, text }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('Website Service resolves, deploys, serves root-relative SPA, and releases', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-website-'));
  const config: WebsiteConfig = {
    dataDir, port: 0, host: '127.0.0.1', runtimeSuffix: '.localhost',
    repoDir: path.resolve(process.cwd()), serviceInstanceId: 'wsi_test',
  };
  const started = await createWebsiteServer(config);
  const address = started.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  t.after(async () => { await new Promise<void>((resolve) => started.server.close(() => resolve())); });
  const api = `http://127.0.0.1:${port}`;
  const fixture = fileURLToPath(new URL('../../../tests/fixtures/website-artifact', import.meta.url));
  const rejectedGenerator = await fetch(`${api}/api/v1/artifact-jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'generator-must-fail' },
    body: JSON.stringify({ kind: 'generator', input: 'build a website' }),
  });
  assert.equal(rejectedGenerator.status, 400);
  const jobResponse = await fetch(`${api}/api/v1/artifact-jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-job-1' },
    body: JSON.stringify({ kind: 'local', path: fixture }),
  });
  assert.equal(jobResponse.status, 202);
  const job = await jobResponse.json() as { operation: { operationId: string } };
  const operation = await waitForOperation(api, job.operation.operationId);
  const artifactId = operation.operation.result!.websiteArtifactId;
  const acquisitionId = operation.operation.result!.websiteAcquisitionId!;
  const replayJob = await fetch(`${api}/api/v1/artifact-jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-job-1' },
    body: JSON.stringify({ kind: 'local', path: fixture }),
  });
  assert.equal(replayJob.status, 202);
  const replayJobBody = await replayJob.json() as { operation: { result?: { websiteArtifactId: string; websiteAcquisitionId: string } } };
  assert.equal(replayJobBody.operation.result?.websiteArtifactId, artifactId);
  assert.equal(replayJobBody.operation.result?.websiteAcquisitionId, acquisitionId);
  const deploymentResponse = await fetch(`${api}/api/v1/deployments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-deployment-1' },
    body: JSON.stringify({ websiteArtifactId: artifactId }),
  });
  assert.equal(deploymentResponse.status, 201);
  const deployment = (await deploymentResponse.json() as { deployment: { routingLabel: string; websiteDeploymentId: string } }).deployment;
  const replayResponse = await fetch(`${api}/api/v1/deployments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-deployment-1' },
    body: JSON.stringify({ websiteArtifactId: artifactId }),
  });
  assert.equal(replayResponse.status, 200);
  await fs.rm(path.join(dataDir, 'deployments', `${deployment.websiteDeploymentId}.request.json`));
  const recoveredReceiptResponse = await fetch(`${api}/api/v1/deployments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-deployment-1' },
    body: JSON.stringify({ websiteArtifactId: artifactId }),
  });
  assert.equal(recoveredReceiptResponse.status, 200);
  const recoveredDeployment = (await recoveredReceiptResponse.json() as { deployment: { websiteDeploymentId: string } }).deployment;
  assert.equal(recoveredDeployment.websiteDeploymentId, deployment.websiteDeploymentId);
  const staticResponse = await requestWithHost(port, '/deep-route', `${deployment.routingLabel}.localhost:${port}`);
  assert.equal(staticResponse.status, 200);
  assert.match(staticResponse.text, /Fixture/);
  const releaseResponse = await fetch(`${api}/api/v1/deployments/${deployment.websiteDeploymentId}`, { method: 'DELETE' });
  assert.equal(releaseResponse.status, 204);
  const afterRelease = await requestWithHost(port, '/', `${deployment.routingLabel}.localhost:${port}`);
  assert.equal(afterRelease.status, 410);
});

test('Website Service resumes a job that was durably queued before restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-website-queued-'));
  const config: WebsiteConfig = {
    dataDir, port: 0, host: '127.0.0.1', runtimeSuffix: '.localhost',
    repoDir: path.resolve(process.cwd()), serviceInstanceId: 'wsi_queued_test',
  };
  let started: Awaited<ReturnType<typeof createWebsiteServer>> | undefined;
  try {
    const operations = new OperationStore(config);
    await operations.init();
    const fixture = fileURLToPath(new URL('../../../tests/fixtures/website-artifact', import.meta.url));
    const queued = await operations.create({ kind: 'local', path: fixture }, 'queued-before-restart');
    assert.equal(queued.record.status, 'queued');
    started = await createWebsiteServer(config);
    const address = started.server.address();
    assert.ok(address && typeof address !== 'string');
    const api = `http://127.0.0.1:${address.port}`;
    const result = await waitForOperation(api, queued.record.operationId);
    assert.match(result.operation.result!.websiteArtifactId, /^wsa_/);
  } finally {
    if (started) {
      const runningServer = started.server;
      await new Promise<void>((resolve) => runningServer.close(() => resolve()));
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Website artifact jobs are claimed and retried single-flight', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-website-claim-'));
  try {
    const config: WebsiteConfig = {
      dataDir, port: 0, host: '127.0.0.1', runtimeSuffix: '.localhost',
      repoDir: path.resolve(process.cwd()), serviceInstanceId: 'wsi_claim_test',
    };
    const operations = new OperationStore(config);
    await operations.init();
    const fixture = fileURLToPath(new URL('../../../tests/fixtures/website-artifact', import.meta.url));
    const created = await operations.create({ kind: 'local', path: fixture }, 'single-flight-job');
    const firstClaims = await Promise.all([
      operations.claimQueued(created.record.operationId),
      operations.claimQueued(created.record.operationId),
    ]);
    assert.equal(firstClaims.filter(Boolean).length, 1);
    const running = firstClaims.find(Boolean)!;
    await operations.update(running, { status: 'failed_retryable' });
    const retries = await Promise.allSettled([
      operations.queueRetry(created.record.operationId),
      operations.queueRetry(created.record.operationId),
    ]);
    assert.equal(retries.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(retries.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Website Service enforces one process owner per data root', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-website-owner-'));
  const config: WebsiteConfig = {
    dataDir, port: 0, host: '127.0.0.1', runtimeSuffix: '.localhost',
    repoDir: path.resolve(process.cwd()), serviceInstanceId: 'wsi_owner_test',
  };
  const first = await createWebsiteServer(config);
  try {
    const fixture = fileURLToPath(new URL('../../../tests/fixtures/website-artifact', import.meta.url));
    const queued = await first.runtime.operations.create({ kind: 'local', path: fixture }, 'owner-running-job');
    await first.runtime.operations.update(queued.record, { status: 'running' });
    await assert.rejects(
      createWebsiteServer({ ...config, port: 0, serviceInstanceId: 'wsi_second_owner' }),
      (error: unknown) => (error as { code?: string }).code === 'website_data_root_in_use',
    );
    assert.equal((await first.runtime.operations.get(queued.record.operationId))?.status, 'running');
  } finally {
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
