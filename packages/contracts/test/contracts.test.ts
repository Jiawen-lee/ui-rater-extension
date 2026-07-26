import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalJson, requestDigest, validateStudyRevision, validateStudySpecification,
  validateWebsiteArtifact, validateWebsiteSourceRequest,
} from '../src/index.ts';

test('canonical JSON and request digest are independent of object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(requestDigest({ b: 2, a: 1 }), requestDigest({ a: 1, b: 2 }));
});

test('canonical JSON matches the cross-language golden vectors', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(
    process.cwd(), '..', '..', 'tests', 'fixtures', 'canonical-json-vectors.json'
  ), 'utf8')) as Array<{ input: unknown; canonical: string; digest: string }>;
  for (const vector of vectors) {
    assert.equal(canonicalJson(vector.input), vector.canonical);
    assert.equal(requestDigest(vector.input), vector.digest);
  }
});

test('loader source contracts reject generator and preserve Hugging Face model selectors', () => {
  assert.throws(() => validateWebsiteSourceRequest({ kind: 'generator', input: 'build a site' }), /Unsupported website source kind/);
  assert.throws(() => validateWebsiteSourceRequest({ kind: 'huggingface' }), /source.repoId/);
  assert.deepEqual(validateWebsiteSourceRequest({
    kind: 'huggingface', repoId: 'org/websites', model: 'model-a', selector: 'site-a',
  }), {
    kind: 'huggingface', repoId: 'org/websites', model: 'model-a', selector: 'site-a',
    revision: undefined, website: undefined, site: undefined, seed: undefined,
  });
  const study = validateStudySpecification({
    schemaVersion: 1,
    studyId: 'study_hf',
    websiteSource: { kind: 'huggingface', repoId: 'org/websites', model: 'model-a' },
    taskSelector: { kind: 'all' },
  });
  assert.equal(study.websiteSource.model, 'model-a');
});

test('website artifact and study revision preserve compatibility task fields', () => {
  const artifact = validateWebsiteArtifact({
    schemaVersion: 1,
    websiteArtifactId: 'wsa_fixture',
    artifactDigest: 'sha256:fixture',
    website: 'fixture',
    createdAt: new Date().toISOString(),
    tasks: [{
      websiteTaskId: 'wst_fixture_1', sourcePosition: 1, prompt: 'Do it', slug: 'one',
      group: 'fixture', startPath: '/', isMind2Web: true, taskSource: 'mind2web',
      legacyAppId: 'fixture-app', suggestedFlows: ['click'],
    }],
  });
  assert.equal(artifact.tasks[0].legacyAppId, 'fixture-app');
  const revision = validateStudyRevision({
    schemaVersion: 1, studyId: 'study_fixture', studyRevisionId: 'str_fixture',
    website: {
      websiteDeploymentId: 'wsd_fixture', websiteArtifactId: 'wsa_fixture',
      websiteAcquisitionId: 'wac_fixture', artifactDigest: 'sha256:fixture',
      baseUrl: 'http://d-fixture.localhost:4173/', provenance: {},
    },
    tasks: [{
      websiteTaskId: 'wst_fixture_1', sourcePosition: 1, position: 1, prompt: 'Do it',
      slug: 'one', group: 'fixture', targetUrl: 'http://d-fixture.localhost:4173/',
      isMind2Web: true, taskSource: 'mind2web', legacyAppId: 'fixture-app', suggestedFlows: ['click'],
    }],
    publishedAt: new Date().toISOString(),
  });
  assert.equal(revision.tasks[0].legacyAppId, 'fixture-app');
});

test('invalid study revisions reject duplicate positions and unsafe URLs', () => {
  assert.throws(() => validateStudyRevision({
    schemaVersion: 1, studyId: 'study_fixture', studyRevisionId: 'str_fixture',
    website: {
      websiteDeploymentId: 'wsd_fixture', websiteArtifactId: 'wsa_fixture',
      websiteAcquisitionId: 'wac_fixture', artifactDigest: 'sha256:fixture',
      baseUrl: 'file:///tmp/site', provenance: {},
    },
    tasks: [], publishedAt: new Date().toISOString(),
  }));
});
