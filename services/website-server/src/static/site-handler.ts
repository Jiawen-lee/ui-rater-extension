import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { ArtifactStore } from '../storage/artifact-store.ts';
import type { DeploymentStore } from '../storage/deployment-store.ts';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

function hostWithoutPort(value: string): string {
  const host = value.toLowerCase().replace(/^\[/, '').replace(/\](:\d+)?$/, '');
  return host.replace(/:\d+$/, '');
}

export function routingLabelFromHost(host: string, suffix: string): string | undefined {
  const normalized = hostWithoutPort(host);
  const suffixValue = suffix.toLowerCase();
  if (!normalized.endsWith(suffixValue)) return undefined;
  const label = normalized.slice(0, -suffixValue.length).replace(/\.$/, '');
  return /^[a-z0-9-]{3,80}$/.test(label) ? label : undefined;
}

export async function serveDeployment(
  request: IncomingMessage,
  response: ServerResponse,
  stores: { artifacts: ArtifactStore; deployments: DeploymentStore },
  runtimeSuffix: string,
): Promise<boolean> {
  const label = routingLabelFromHost(String(request.headers.host || ''), runtimeSuffix);
  if (!label) return false;
  const deployment = await stores.deployments.findByRoutingLabel(label);
  if (!deployment) { response.writeHead(404).end('Unknown website deployment'); return true; }
  if (deployment.status === 'released') { response.writeHead(410).end('Website deployment released'); return true; }
  const root = path.resolve(stores.artifacts.artifactDistDir(deployment.websiteArtifactId));
  const pathname = decodeURIComponent(new URL(request.url || '/', 'http://runtime.local').pathname);
  const relative = pathname.replace(/^\/+/, '');
  let target = path.resolve(root, relative || 'index.html');
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    response.writeHead(400).end('Invalid website path');
    return true;
  }
  const stat = await fsp.stat(target).catch(() => undefined);
  if (!stat?.isFile()) target = path.join(root, 'index.html');
  const indexStat = await fsp.stat(target).catch(() => undefined);
  if (!indexStat?.isFile()) { response.writeHead(404).end('Website artifact is incomplete'); return true; }
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'ETag': `"${deployment.artifactDigest}"`,
    'X-Website-Deployment': deployment.websiteDeploymentId,
  });
  fs.createReadStream(target).pipe(response);
  return true;
}
