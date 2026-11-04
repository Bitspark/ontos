const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { subjectFor, contextFor, statementFor } = require('./npm-provenance.cjs');

const bytes = Buffer.from('qualified archive');
const candidate = { name: '@bitspark/ontos-wire', version: '0.16.0', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'Bitspark/ontos', RELEASE_SHA: sha, GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_REF: 'Bitspark/ontos/.github/workflows/release.yml@refs/heads/main', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY_ID: '456', GITHUB_REPOSITORY_OWNER_ID: '789' };

test('the npm purl and SHA512 commit to the exact qualified bytes', () => {
  const subject = subjectFor(candidate, bytes);
  assert.equal(subject.name, 'pkg:npm/%40bitspark/ontos-wire@0.16.0');
  assert.equal(subject.digest.sha512, createHash('sha512').update(bytes).digest('hex'));
  assert.throws(() => subjectFor(candidate, Buffer.from('different archive')));
  assert.throws(() => subjectFor({ ...candidate, name: '@someone/another-package' }, bytes));
});

test('source material is the qualified checkout, distinct from the dispatch revision', () => {
  const context = contextFor(env, sha);
  const statement = statementFor(subjectFor(candidate, bytes), context);
  assert.equal(statement.subject.length, 1);
  assert.equal(statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, sha);
  assert.equal(statement.predicate.buildDefinition.externalParameters.workflow.ref, 'refs/heads/main');
  assert.equal(statement.predicate.runDetails.metadata.invocationId, 'https://github.com/Bitspark/ontos/actions/runs/123/attempts/2');
  assert.equal(context.identity, 'https://github.com/Bitspark/ontos/.github/workflows/release.yml@refs/heads/main');
  assert.throws(() => contextFor(env, env.GITHUB_SHA));
  assert.throws(() => contextFor({ ...env, GITHUB_ACTIONS: undefined }, sha));
  assert.throws(() => contextFor({ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, sha));
});
