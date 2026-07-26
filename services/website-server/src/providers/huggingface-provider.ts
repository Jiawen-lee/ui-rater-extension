import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ArtifactProvider } from './provider.ts';
import { ProviderError } from './provider.ts';
import { loadCandidateFromDirectory } from './local-provider.ts';
import type { CandidateArtifact } from '../storage/artifact-store.ts';
import type { WebsiteConfig } from '../config.ts';

function runPython(command: string, args: string[], cwd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new ProviderError('python_unavailable', error.message, false)));
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new ProviderError('huggingface_resolution_failed', stderr.trim() || stdout.trim() || 'Hugging Face resolution failed', true));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith('{'));
      if (!line) { reject(new ProviderError('invalid_resolver_output', 'Hugging Face resolver returned no metadata', false)); return; }
      try { resolve(JSON.parse(line) as Record<string, unknown>); }
      catch { reject(new ProviderError('invalid_resolver_output', 'Hugging Face resolver returned invalid metadata', false)); }
    });
  });
}

export class HuggingFaceProvider implements ArtifactProvider {
  constructor(private readonly config: WebsiteConfig) {}

  async resolve(source: Record<string, unknown>, stagingDir: string): Promise<CandidateArtifact> {
    const cacheDir = path.join(this.config.dataDir, 'cache');
    const deployDir = path.join(stagingDir, 'unused-deploy');
    const script = path.join(this.config.repoDir, 'scripts', 'resolve_hf_website.py');
    const args = [script];
    if (source.repoId) args.push('--repo-id', String(source.repoId));
    args.push('--revision', String(source.revision ?? 'prompt-userflow-regen-20260624'),
      '--seed', String(source.seed ?? 'website-service'), '--cache-dir', cacheDir,
      '--deploy-dir', deployDir, '--no-deploy');
    if (source.website) args.push('--website', String(source.website));
    if (source.model) args.push('--model', String(source.model));
    const selectedSite = source.site ?? source.selector;
    if (selectedSite) args.push('--site', String(selectedSite));
    const command = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
    const metadata = await runPython(command, process.platform === 'win32' && !process.env.PYTHON ? ['-3', ...args] : args, this.config.repoDir);
    if (typeof metadata.source_dir !== 'string' || typeof metadata.task_file !== 'string') {
      throw new ProviderError('invalid_resolver_output', 'Resolver metadata omitted source paths', false);
    }
    return loadCandidateFromDirectory(metadata.source_dir, metadata.task_file, {
      kind: 'huggingface',
      repoId: metadata.repo_id,
      revision: metadata.revision,
      commitSha: metadata.commit_sha,
      sourceUrl: metadata.source_url,
    });
  }
}
